import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { section } from "@earendil-works/pi-durable";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { DurableChannelStore } from "./durable/channel-store.ts";
import { adaptPiTools, ThreadToolBindings, type BoundThreadTools } from "./durable/pi-tool-adapter.ts";
import { listModels, resolveModel } from "./model.ts";
import { legacyChannelModelOverride } from "./model-state.ts";
import { logger } from "../util/log.ts";
import { createJobDeps } from "../jobs/deps.ts";
import { makeJobTask } from "../jobs/task.ts";
import { makeSubagentStageTask, type StageDeps, type SubagentHost } from "./subagent-task.ts";
import type { FactoryDeps, FactoryGitHub } from "../factory/workflow/deps.ts";
import type { FactoryRunData } from "../factory/workflow/docs.ts";
import { createFactoryBackend } from "../factory/workflow/backend.ts";
import { appendFactoryAudit } from "../factory/workflow/service.ts";
import { effectiveAutonomy } from "../factory/workflow/autonomy.ts";
import { resolveMergeRules } from "../factory/workflow/merge.ts";
import { makeFactoryTask } from "../factory/workflow/task.ts";
import type { TaskWorkflow } from "../tasks/workflow.ts";
import { createSubagentRunner } from "./subagents.ts";

/**
 * One Durable store per Slack channel, plus the table that maps its conversations to the
 * live, per-thread tool sets.
 *
 * A store is opened lazily by the first session that needs it and shared by every thread in
 * the channel. Its tool schemas, prompt sections, workspace and model allowlist are fixed at
 * open, so any change to a channel's configuration must `invalidate` it: the old store is
 * closed once its sessions have finished (it holds an exclusive lock on the directory) and
 * the next session opens a fresh one against the new configuration.
 */

export interface RuntimeTemplate {
  /** Schemas to register. The implementations bound to each conversation do the work. */
  tools: readonly ToolDefinition[];
  instructions: string;
  sections: readonly ReturnType<typeof section>[];
}

export interface ChannelRuntime {
  readonly channel: ResolvedChannel;
  readonly store: DurableChannelStore;
  readonly bindings: ThreadToolBindings;
  /**
   * Cleanup for tool sets rebuilt for recovered conversations (open connectors, ...). They outlive any
   * session, so they are released when the store itself retires.
   */
  readonly disposers: (() => Promise<void>)[];
  /** Bumped whenever any job run in this channel changes, so the web console's poll can tell something happened. */
  readonly jobs: { version: number };
}

export interface RuntimeLease {
  readonly runtime: ChannelRuntime;
  release(): void;
}

interface Entry {
  runtime: ChannelRuntime;
  refs: number;
  retired: boolean;
  drained: Promise<void>;
  markDrained: () => void;
}

export interface ChannelRuntimesOptions {
  modelRuntime: ModelRuntime;
  /**
   * Rebuild the tools for a conversation that has live work but no live session (after a restart).
   * Returning undefined refuses the conversation: its tool calls fail closed.
   */
  rebuild?: (runtime: ChannelRuntime, conversationId: ConversationId) => Promise<BoundThreadTools | undefined>;
  /**
   * What a background task needs to run a subagent with no live turn above it. Absent: such tasks fail closed, as a job
   * does without its deps.
   */
  subagentHost?: SubagentHost;
  /** How a factory channel's workflow runs reach GitHub. Absent: the `gh` CLI with the channel's own credentials. Tests supply a fake. */
  factoryGitHub?: (channel: ResolvedChannel) => FactoryGitHub;
  /** How long a run waits for an answer on its issue. Absent: the channel's `factory.intake.needsInfoDays`. A test cannot wait days. */
  factoryNeedsInfoMs?: (channel: ResolvedChannel) => number;
  /** After how long with no answer triage goes on with assumptions. Absent: the channel's `factory.intake.assumeAfterHours`. A test cannot wait hours. */
  factoryAssumeAfterMs?: (channel: ResolvedChannel) => number;
  /**
   * Told after a workflow run's record changes (a stage started or finished, the run is waiting, it ended). Best effort and
   * synchronous: a failure here never affects the run. The Slack status post and the console's live events hang off this.
   */
  onFactoryRunChange?: (channel: ResolvedChannel, run: FactoryRunData) => void;
  onTaskWorkflowChange?: (channel: ResolvedChannel, workflow: TaskWorkflow) => void;
  /**
   * Runs once on every freshly opened store, before it is handed to anything. Any progress call starts all
   * ready work in a store, so interrupted work must be re-established (or the store held paused) before
   * the first session, command or timer can touch it. If it throws the store is closed and the open fails.
   */
  gate?: (runtime: ChannelRuntime) => Promise<void>;
  /** Called, after the failed store has been retired, so the owner can open a replacement without waiting for the next message. */
  onFailed?: (channelId: string) => void;
}

/** The exact `provider/model` set Durable's dispatch policy enforces for this channel. */
export function allowedModelRefs(channel: ResolvedChannel, modelRuntime: ModelRuntime): string[] {
  const refs = new Set(// Permission, not availability: a provider without credentials today may have them tomorrow.
  listModels({ catalog: modelRuntime, allow: channel.models, onlyAvailable: false }).map((model) => model.ref));
  const fallback = resolveModel(channel.model, modelRuntime);
  refs.add(`${fallback.provider}/${fallback.id}`);
  // A subagent's model is chosen by the operator in the agent set, not by the agent, so it is allowed here
  // even where the channel's own switchable list leaves it out. It is still exact `provider/model`.
  for (const agent of channel.agents) {
    try {
      const model = resolveModel(agent.model, modelRuntime);
      refs.add(`${model.provider}/${model.id}`);
    } catch (error) {
      logger.warn(`subagent ${agent.name} in ${channel.ref.id} names a model that cannot be resolved (${agent.model}): ${error instanceof Error ? error.message : error}`);
    }
  }
  return [...refs];
}

export function channelStoreDir(channel: ResolvedChannel): string {
  return join(channel.paths.root, "durable");
}

export class ChannelRuntimes {
  private readonly entries = new Map<string, Entry>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly pendingRuntimes = new Map<string, ChannelRuntime>();
  private readonly opts: ChannelRuntimesOptions;

  constructor(opts: ChannelRuntimesOptions) {
    this.opts = opts;
  }

  /** Serialize open/retire per channel: two stores must never contend for one directory. */
  private exclusive<T>(channelId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(channelId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.chains.set(channelId, next.catch(() => undefined));
    return next;
  }

  async acquire(channel: ResolvedChannel, template: () => Promise<RuntimeTemplate>): Promise<RuntimeLease> {
    const entry = await this.exclusive(channel.ref.id, async () => {
      const existing = this.entries.get(channel.ref.id);
      if (existing && !existing.retired) return existing;
      if (existing) await this.finishRetire(channel.ref.id, existing);
      const created = await this.open(channel, await template());
      this.entries.set(channel.ref.id, created);
      return created;
    });
    entry.refs++;
    let released = false;
    return {
      runtime: entry.runtime,
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (entry.refs === 0 && entry.retired) entry.markDrained();
      },
    };
  }

  private async open(channel: ResolvedChannel, template: RuntimeTemplate): Promise<Entry> {
    const bindings = new ThreadToolBindings(async (conversationId) => {
      const runtime = this.entries.get(channel.ref.id)?.runtime ?? this.pendingRuntimes.get(channel.ref.id);
      return runtime && this.opts.rebuild ? this.opts.rebuild(runtime, conversationId) : undefined;
    });
    const model = resolveModel(channel.model, this.opts.modelRuntime);
    // A `!model` channel default recorded before the store existed seeds it once; unusable ones are ignored.
    let seeded: { provider: string; modelId: string } | undefined;
    const legacy = legacyChannelModelOverride(channel.paths);
    if (legacy) {
      try {
        const resolved = resolveModel(legacy, this.opts.modelRuntime);
        if (allowedModelRefs(channel, this.opts.modelRuntime).includes(`${resolved.provider}/${resolved.id}`)) {
          seeded = { provider: resolved.provider, modelId: resolved.id };
        }
      } catch {
        logger.warn(`ignoring unusable legacy channel model "${legacy}" in ${channel.ref.id}`);
      }
    }
    // Read when a phase runs, so a store reopened on new config uses the new rules. Built here, from this channel's own
    // command policy, working directory and environment.
    const jobs = { version: 0 };
    const jobDeps = createJobDeps(channel, { onChange: () => { jobs.version++; } });
    // The runner needs the channel's store and bindings, which exist once the store has opened; a phase asks for them then.
    let opened: ChannelRuntime | undefined;
    const host = this.opts.subagentHost;
    const stageDeps: StageDeps | undefined = host && {
      run: (runId, request) => {
        if (!opened) throw new Error("The channel's store is not open.");
        return createSubagentRunner({
          parent: host.parent(channel, runId), runtime: opened, runtimes: this, modelRuntime: this.opts.modelRuntime, buildToolSet: host.buildToolSet,
        }).run(request);
      },
    };
    // The workflow engine's: the same runner, plus what the merge gate and its rules need. Only a factory channel has them.
    const factoryDeps: FactoryDeps | undefined = host && channel.factory && {
      runStage: (runId, request) => stageDeps!.run(runId, request),
      hasRole: (role) => channel.agents.some((agent) => agent.name === role),
      roleNeedsApproval: (role) => channel.agents.find((agent) => agent.name === role)?.requireApproval === true,
      rules: (repo) => resolveMergeRules(channel.factory, repo),
      allowUsers: () => channel.allowUsers,
      assumeAfterMs: (repo) => this.opts.factoryAssumeAfterMs?.(channel) ?? effectiveAutonomy(channel.factory, repo).knobs.assumeAfterHours.value * 3_600_000,
      autoRetries: (repo) => effectiveAutonomy(channel.factory, repo).knobs.autoRetries.value,
      needsInfoMs: () => this.opts.factoryNeedsInfoMs?.(channel) ?? (channel.factory?.intake?.needsInfoDays ?? 14) * 86_400_000,
      github: this.opts.factoryGitHub?.(channel) ?? createFactoryBackend(channel),
      interrupted: ({ runId, runKey, role }) => {
        const parent = host.parent(channel, runId);
        parent.timeline?.record({ kind: "run.end", actor: role, runKey, threadKey: parent.threadKey, title: `${role} interrupted`, status: "interrupted" });
      },
      audit: (event, fields) => appendFactoryAudit(channel, event, fields),
      onChange: (run) => {
        jobs.version++;
        try { this.opts.onFactoryRunChange?.(channel, run); } catch (error) { logger.debug(`factory run observer failed: ${error}`); }
      },
    };
    const store = await DurableChannelStore.open({
      storageDir: channelStoreDir(channel),
      channelId: channel.ref.id,
      onTaskWorkflowChange: (workflow) => {
        jobs.version++;
        this.opts.onTaskWorkflowChange?.(channel, workflow);
      },
      workspace: channel.paths.workspace,
      models: this.opts.modelRuntime,
      model: { provider: model.provider, modelId: model.id },
      ...(seeded ? { initialModelOverride: seeded } : {}),
      allowedModels: allowedModelRefs(channel, this.opts.modelRuntime),
      instructions: template.instructions,
      sections: template.sections,
      tools: adaptPiTools(template.tools, bindings),
      ...(channel.thinkingLevel !== "off" ? { thinkingLevel: channel.thinkingLevel } : {}),
      // Always registered, even for a channel with no jobs today: a run that was in flight when the config changed must
      // still be found, validated against the new rules and ended, which needs the task kind to exist.
      jobTask: makeJobTask(() => jobDeps),
      runTasks: [makeSubagentStageTask(() => stageDeps) as never, makeFactoryTask(() => factoryDeps) as never],
    });
    let markDrained = () => {};
    const drained = new Promise<void>((resolve) => { markDrained = resolve; });
    logger.info(`durable store open: channel=${channel.ref.name ?? channel.ref.id} tools=${template.tools.length}`);
    const runtime: ChannelRuntime = { channel, store, bindings, disposers: [], jobs };
    opened = runtime;
    // Since pi-durable 1.2 any storage error fails the whole store permanently. Retire it, so the next message opens a
    // fresh one (and runs the recovery gate again) instead of leaving the channel dead until the process restarts.
    void store.ended.then((end) => {
      if (end.reason !== "failed") return;
      logger.error(`conversation store for ${channel.ref.name ?? channel.ref.id} failed and will be re-opened on next use: ${end.error instanceof Error ? end.error.message : String(end.error)}`);
      void this.invalidate(channel.ref.id)
        .then(() => this.opts.onFailed?.(channel.ref.id))
        .catch((err) => logger.warn(`could not retire failed store: ${err instanceof Error ? err.message : String(err)}`));
    });
    // Registered before the gate so a rebuild during recovery can find its own runtime.
    this.pendingRuntimes.set(channel.ref.id, runtime);
    try {
      await this.opts.gate?.(runtime);
    } catch (error) {
      await Promise.allSettled(runtime.disposers.splice(0).map((dispose) => dispose()));
      await store.close().catch(() => undefined);
      throw error;
    } finally {
      this.pendingRuntimes.delete(channel.ref.id);
    }
    return { runtime, refs: 0, retired: false, drained, markDrained };
  }

  private async finishRetire(channelId: string, entry: Entry): Promise<void> {
    entry.retired = true;
    if (entry.refs === 0) entry.markDrained();
    await entry.drained;
    this.entries.delete(channelId);
    await Promise.allSettled(entry.runtime.disposers.splice(0).map((dispose) => dispose()));
    await entry.runtime.store.close();
  }

  /** Stop handing out a channel's store; it closes once every session using it has been released. */
  async invalidate(channelId: string): Promise<void> {
    await this.exclusive(channelId, async () => {
      const existing = this.entries.get(channelId);
      if (existing) await this.finishRetire(channelId, existing);
    });
  }

  /** Every open channel, for a configuration reload. Each closes once its own sessions are released. */
  async invalidateAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.invalidate(id)));
  }

  /** Channels that currently have a store entry, open or retiring. */
  channelIds(): string[] {
    return [...this.entries.keys()];
  }

  /** The store only if one is already open (never opens one). */
  peek(channelId: string): ChannelRuntime | undefined {
    const entry = this.entries.get(channelId);
    return entry && !entry.retired ? entry.runtime : undefined;
  }

  async closeAll(): Promise<void> {
    await this.invalidateAll();
  }
}
