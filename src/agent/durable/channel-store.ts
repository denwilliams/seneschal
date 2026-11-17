import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  Harness, createRegistry, defineDoc, defineDocFamily, defineExtension, section,
  type InputEntry, type Conversation, type ConversationId, type HarnessInspection,
  type AnyTask, type Cursor, type TaskId, type ModelRef, type Submission, type ToolRegistration, type UserInput,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { watchEvents, type AgentEventStream } from "./events.ts";
import { digest } from "./identity.ts";
import { parsePointer, readPath, stateBytes, type StateJson, type StateObject, type StateOp, type StateRead } from "./state.ts";
import { AppStateDoc, applyStateUpdate, type StateChange, type StateWriter } from "./state-doc.ts";
import { modelPolicy } from "./model-policy.ts";
import { emptyDecision, emptyRun, isJobTaskKind, JobDecisionFamily, JobRunFamily, type JobRunData, type JobStarter } from "../../jobs/docs.ts";
import type { JobDefinition } from "../../jobs/definition.ts";
import type { JobTask } from "../../jobs/task.ts";
import { hashWorkflow, pinnedWorkflow, validateWorkflow, type WorkflowDefinition } from "../../factory/workflow/definition.ts";
import {
  DECISIONS_FOR, emptyFactoryDecision, emptyFactoryRun, emptyRunSlack, MAX_RUN_SLACK_EVENTS, FACTORY_TASK_KIND, FactoryDecisionFamily, FactoryRunFamily, isTerminalRun, MAX_LIVE_FACTORY_RUNS,
  MAX_RUN_UPDATES, type FactoryDecisionKind, type FactoryRunData, type FactoryStarter, type RunOrigin, type RunSlack, type RunUpdate,
} from "../../factory/workflow/docs.ts";
import { canReconcileClosureMerge, completeClosureMerge, hasRecordedMerge } from "../../factory/workflow/closure-merge.ts";
import type { PrFacts } from "../../factory/workflow/merge.ts";
import { enterStage, findStage, initialStages } from "../../factory/workflow/transitions.ts";
import {
  emptyIntakeEntry, emptyIntakeNote, emptyIntakeRepo, FactoryIntakeFamily, FactoryIntakeNoteFamily, intakeKey, INTAKE_NOTE_KEY, MAX_FILED_BY_HARNESS, MAX_NOTE_EVENTS,
  type IntakeEntry, type IntakeNoteData, type IntakeRepoData,
} from "../../factory/workflow/intake-docs.ts";
import { TaskWorkflowFamily, type TaskWorkflow } from "../../tasks/workflow.ts";
import { logger } from "../../util/log.ts";

const context = BACKGROUND_CONTEXT;

/** One per store: which channel/workspace owns it, and its trunk conversation. */
/** A recovered conversation that could not be safely resumed, kept until an operator resolves it. */
export type BlockedRecovery = {
  conversationId: ConversationId;
  threadKey: string;
  reason: string;
  since: number;
};

const HostDoc = defineDoc<{
  channelId: string; workspace: string; mainConversationId: ConversationId | 0; modelOverride: boolean;
  blocked: BlockedRecovery[];
}>({
  kind: "slack.host", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ channelId: "", workspace: "", mainConversationId: 0, modelOverride: false, blocked: [] }),
});
/** Thread key -> conversation. A family, so the cost of a lookup does not grow with the thread count. */
const ThreadFamily = defineDocFamily<
  { conversationId: ConversationId; forkedFromEntry: number; createdAt: number; lastActivityAt: number; resetCount: number; pinnedModel: boolean; admittedRequests: number },
  { conversationId: ConversationId; forkedFromEntry: number; createdAt: number; lastActivityAt: number; resetCount: number; pinnedModel: boolean; admittedRequests: number }
>({ kind: "slack.thread", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }) });
/**
 * What was done to put one request's answer into Slack. A crash between sending and recording the timestamp
 * would otherwise double-post, so intent is recorded BEFORE the first send and reconciled against Slack
 * (by the request id carried in the message metadata) when it is found without a timestamp.
 */
export type DeliveryState = "intended" | "sent" | "delivered";
export type DeliveryRecord = {
  requestId: string; threadKey: string;
  /** Where in Slack the reply goes (differs from the thread key for a visible scheduled run). */
  threadTs: string; state: DeliveryState;
  /** Slack ts of the reply message once it exists. */
  ts: string; partsSent: number; textHash: string; updatedAt: number;
};
const DeliveryFamily = defineDocFamily<DeliveryRecord, DeliveryRecord>({
  kind: "slack.delivery", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});
const emptyDelivery = (requestId: string, threadKey: string): DeliveryRecord =>
  ({ requestId, threadKey, threadTs: threadKey, state: "intended", ts: "", partsSent: 0, textHash: "", updatedAt: 0 });

/** Reverse mapping, so recovery can find the Slack thread of a conversation with live work. */
const RouteDoc = defineDoc<{ kind: "main" | "thread" | "run"; threadKey: string }>({
  kind: "slack.route", version: 1, scope: "conversation", checkpointWhen: () => false, history: "latest", fork: "initial",
  initial: () => ({ kind: "thread", threadKey: "" }),
});
const RequestDoc = defineDocFamily<
  { hash: string; userId: string; threadKey: string; admitted: boolean; steeringFor?: string; steeringDraft?: string; steeringIds?: string[] },
  { hash: string; userId: string; threadKey: string; admitted: boolean; steeringFor?: string; steeringDraft?: string; steeringIds?: string[] }
>({
  kind: "slack.request", version: 1, scope: "conversation", checkpointWhen: () => false, history: "latest", fork: "initial",
  family: true, initial: (seed) => ({ ...seed }),
});

/** A DM follow-up has its own Slack ts but is owned by the active root's conversation.
 * Keep this channel-local route so an idle/restarted redelivery finds the same receipt. */
const SteeringRouteFamily = defineDocFamily<{ threadKey: string }, { threadKey: string }>({
  kind: "slack.steering-route", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});

export interface ChannelStoreOptions {
  /** Dedicated per-channel directory outside the tool workspace. */
  storageDir: string;
  channelId: string;
  workspace: string;
  /** ModelRuntime implements Models; the one shared OAuth/custom-provider owner. */
  models: Models;
  /** The configured default: what the channel main (and so every unpinned thread) runs on unless overridden. */
  model: ModelRef;
  /** An operator's channel-wide override carried over from before this store existed; applied once. */
  initialModelOverride?: ModelRef;
  allowedModels: readonly string[];
  /** Default system prompt (a thread may override it with its own profile). */
  instructions?: string;
  /** Extra prompt sections, rendered before each request (late context, skills...). */
  sections?: readonly ReturnType<typeof section>[];
  /** Dispatching tool registrations; every one is forced to replay "unsafe". */
  tools?: readonly ToolRegistration[];
  thinkingLevel?: ModelThinkingLevel;
  /** The job task kind to register, so the store can run and resume jobs. Absent: this store has no jobs. */
  jobTask?: JobTask;
  /**
   * Background run tasks to register: durable tasks owned by the main conversation that are not jobs (a software factory
   * workflow run, say). Their kinds start with `RUN_TASK_PREFIX`, which is how `liveRoutes` and `checkLive` know they are not a
   * conversation's work.
   */
  runTasks?: readonly AnyTask[];
  /** Best-effort observer of committed task-workflow changes, including worker submissions. */
  onTaskWorkflowChange?: (workflow: TaskWorkflow) => void;
}

/** The task-kind prefix of a background run that is neither a job nor a conversation's turn. */
export const RUN_TASK_PREFIX = "slack.run.";
export const isRunTaskKind = (kind: string): boolean => kind.startsWith(RUN_TASK_PREFIX);
const isBackgroundTaskKind = (kind: string): boolean => isJobTaskKind(kind) || isRunTaskKind(kind);

/** Live runs a channel may have at once, and so how much unattended work it can start. */
export const MAX_LIVE_JOBS = 3;

/** What one conversation is offered, set by whichever session built its tools. */
export interface ThreadProfile {
  /** Registered tool names this conversation may be offered. */
  tools: readonly string[];
  /** This conversation's system prompt. */
  instructions?: string;
}

/** Raised by every operation that could start work while a recovered conversation is unresolved. */
export class RecoveryBlockedError extends Error {
  readonly blocked: readonly BlockedRecovery[];
  constructor(blocked: readonly BlockedRecovery[]) {
    super(
      `This channel is paused: ${blocked.length} interrupted request(s) could not be safely resumed ` +
        `(${blocked.map((item) => item.reason).join("; ")}). An operator can inspect them with !recovery.`,
    );
    this.name = "RecoveryBlockedError";
    this.blocked = blocked;
  }
}

export type ThreadRoute = { kind: "main" | "thread" | "run"; threadKey: string };

/**
 * A subagent run is a conversation of its own, registered under a key with this prefix. It is not a Slack
 * thread, nothing is posted to one, and an interrupted run is abandoned (the parent's `run_subagent` call is
 * reported to the model as interrupted) rather than resumed.
 */
export const SUBAGENT_RUN_PREFIX = "sub-";
export const isSubagentRunKey = (threadKey: string): boolean => threadKey.startsWith(SUBAGENT_RUN_PREFIX);

/** What a subagent's conversation starts with. Its tools and prompt come from the run's profile. */
export interface SubagentRunSpec {
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
}

/**
 * One Durable store per Slack channel. The channel's **main** conversation is the shared
 * trunk (instructions, channel context, digests of what threads did); every Slack thread
 * is a **fork** of main's tail at the moment the bot first joined it. Threads never write
 * into main or each other; main only receives host-appended context entries.
 *
 * Every tool is "unsafe" to replay: a partial external effect is never repeated
 * automatically, it is reported to the next model turn as interrupted.
 */
export class DurableChannelStore {
  private readonly harness: Harness;
  private readonly storage: Awaited<ReturnType<typeof SqliteStorage.open>>;
  /** The conversations database handle (kept so a failure can be provoked in tests). */
  private readonly database: { close(): Promise<void> };
  private readonly owner: DatabaseSync;
  private readonly opts: ChannelStoreOptions;
  private readonly tools: readonly ToolRegistration[];
  private readonly extension: ReturnType<typeof defineExtension>;
  private readonly policy: ReturnType<typeof modelPolicy>;
  private mainId: ConversationId;
  private readonly forking = new Map<string, Promise<Conversation>>();
  /** In-process only: a profile always comes from a freshly built tool set, never from persisted state. */
  private readonly profiles = new Map<string, ThreadProfile>();

  private constructor(
    harness: Harness, storage: Awaited<ReturnType<typeof SqliteStorage.open>>, owner: DatabaseSync, opts: ChannelStoreOptions, tools: readonly ToolRegistration[],
    extension: ReturnType<typeof defineExtension>, policy: ReturnType<typeof modelPolicy>, mainId: ConversationId,
    database: { close(): Promise<void> },
  ) {
    this.database = database;
    this.harness = harness;
    this.storage = storage;
    this.owner = owner;
    this.opts = opts;
    this.tools = tools;
    this.extension = extension;
    this.policy = policy;
    this.mainId = mainId;
  }

  static async open(opts: ChannelStoreOptions): Promise<DurableChannelStore> {
    if (!opts.channelId) throw new Error("channelId is required");
    const storageDir = resolve(opts.storageDir);
    const workspace = await realpath(opts.workspace);
    await mkdir(storageDir, { recursive: true, mode: 0o700 });
    const actualStore = await realpath(storageDir);
    if (actualStore === workspace || actualStore.startsWith(`${workspace}/`)) {
      throw new Error("Durable storage must be outside the tool workspace");
    }
    // Upstream storage has no cross-process ownership lock. Hold a distinct SQLite
    // exclusive transaction: the OS releases it even on SIGKILL, with no stale PID race.
    const owner = new DatabaseSync(join(actualStore, "owner.sqlite"));
    let harness: Harness | undefined;
    let storage: Awaited<ReturnType<typeof SqliteStorage.open>> | undefined;
    let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
    try {
      owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
      const registry = createRegistry();
      const names = new Set<string>();
      const tools = (opts.tools ?? []).map((tool): ToolRegistration => {
        if (names.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
        names.add(tool.name);
        return { ...tool, replay: "unsafe" };
      });
      const extension = defineExtension({
        name: "slack-channel",
        tools,
        sections: [...(opts.sections ?? [])],
        ...(opts.jobTask || opts.runTasks?.length ? { tasks: [...(opts.jobTask ? [opts.jobTask as unknown as AnyTask] : []), ...(opts.runTasks ?? [])] } : {}),
      });
      registry.install(extension);
      database = await openNodeSqliteDatabase(join(actualStore, "conversations.sqlite"));
      // Default upstream NORMAL is process-crash durable, not power-loss durable.
      await database.exec("PRAGMA synchronous=FULL");
      const policy = modelPolicy(opts.models, opts.allowedModels);
      storage = await SqliteStorage.open(database);
      harness = await Harness.open(storage, {
        models: policy.models, registry,
        settings: { extensions: [], toolExecution: "sequential", steeringMode: "all", followUpMode: "one-at-a-time" },
        // No NodeExecutionEnv: file/shell access is supplied only by host-bound tools.
      }, context);
      const boundOpts = {
        ...opts, model: { ...opts.model }, allowedModels: [...opts.allowedModels], storageDir: actualStore, workspace,
      };
      policy.check(opts.model);
      await harness.commit(async (tx) => {
        const host = await tx.doc(HostDoc);
        if (host.channelId && (host.channelId !== opts.channelId || host.workspace !== workspace)) {
          throw new Error("Store is bound to a different channel/workspace");
        }
        host.channelId = opts.channelId;
        host.workspace = workspace;
      }, context);
      if (opts.initialModelOverride) {
        policy.check(opts.initialModelOverride);
        await harness.commit(async (tx) => {
          const host = await tx.doc(HostDoc);
          if (!host.mainConversationId && !host.modelOverride) host.modelOverride = true;
        }, context);
      }
      const main = await harness.root(context, {
        agent: {
          model: { ...(opts.initialModelOverride ?? opts.model) }, extensions: [extension], tools, cwd: workspace,
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
          ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
        },
        init: async (tx, id) => {
          (await tx.doc(HostDoc)).mainConversationId = id;
          const route = await tx.doc(RouteDoc, id);
          route.kind = "main";
          // A fork needs an entry to fork at, so the trunk starts with a marker.
          await tx.appendEntry(id, {
            kind: "slack.channel.root",
            model: [{ role: "user", content: `[channel ${opts.channelId}: shared context begins here]`, timestamp: Date.now() }],
          });
        },
      });
      // Always rebind the CURRENT loadout and cwd to the trunk; never inherit a stored allowlist.
      // Without an operator override the channel default follows configuration, so editing the config applies.
      const overridden = (await harness.snapshot(HostDoc, context))?.modelOverride === true;
      await main.configure({
        extensions: [extension], tools, cwd: workspace, ...(overridden ? {} : { model: { ...opts.model } }),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
        ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
      }, context);
      const store = new DurableChannelStore(harness, storage, owner, boundOpts, tools, extension, policy, main.id, database);
      // No resume here. Opening must never cause tool work: the recovery gate decides.
      return store;
    } catch (error) {
      try {
        if (harness) await harness.close(context);
        else if (database) await database.close();
      } finally { owner.close(); }
      throw error;
    }
  }

  /** The trunk conversation every thread forks from. */
  get mainConversationId(): ConversationId { return this.mainId; }

  private checkModel(model: ModelRef): void {
    this.policy.check(model);
  }

  private async main(): Promise<Conversation> {
    const main = await this.harness.conversation(this.mainId, context);
    if (!main) throw new Error("Channel main conversation is missing");
    return main;
  }

  private async threadId(threadKey: string): Promise<ConversationId | undefined> {
    if (!threadKey || threadKey.length > 200) throw new Error("Invalid thread key");
    const doc = await this.harness.snapshot(ThreadFamily, threadKey, context);
    return doc?.conversationId || undefined;
  }

  /** Fork the trunk at its current tail and register the thread in the same commit. */
  private async forkThread(threadKey: string, replace: boolean): Promise<Conversation> {
    // A subagent never inherits the channel's context: it is created by openSubagentRun, with its own.
    if (isSubagentRunKey(threadKey)) throw new Error(`Unknown subagent run: ${threadKey}`);
    const pending = this.forking.get(threadKey);
    if (pending && !replace) return pending;
    // A reset must really happen: wait out a pending first-time fork instead of being handed it as if it were the reset.
    if (pending) await pending.catch(() => undefined);
    const created = (async () => {
      const main = await this.main();
      const tail = (await main.entries({}, 1, undefined, context)).items[0];
      if (!tail) throw new Error("Channel main has no entries to fork");
      this.checkModel((await main.agent(context)).model ?? this.opts.model);
      return main.fork(tail.id, {
        ownership: { kind: "ownerless" },
        agent: {
          extensions: [this.extension], tools: this.toolsFor(threadKey), cwd: this.opts.workspace,
          ...this.instructionsFor(threadKey),
          ...(this.opts.thinkingLevel ? { thinkingLevel: this.opts.thinkingLevel } : {}),
        },
        init: async (tx, id) => {
          const doc = await tx.doc(ThreadFamily, threadKey, {
            conversationId: id, forkedFromEntry: tail.id, createdAt: Date.now(), lastActivityAt: Date.now(), resetCount: 0, pinnedModel: false, admittedRequests: 0,
          });
          if (doc.conversationId !== id) {
            if (!replace) throw new Error("THREAD_EXISTS");
            doc.conversationId = id;
            doc.forkedFromEntry = tail.id;
            doc.resetCount += 1;
            doc.pinnedModel = false;
            doc.admittedRequests = 0;
            doc.lastActivityAt = Date.now();
          }
          const route = await tx.doc(RouteDoc, id);
          route.kind = "thread";
          route.threadKey = threadKey;
        },
      }, context);
    })().finally(() => this.forking.delete(threadKey));
    this.forking.set(threadKey, created);
    return created;
  }

  /** The conversation behind a thread, forking from the trunk first if `create`. */
  async conversationIdFor(threadKey: string, create = true): Promise<ConversationId> {
    return (await this.conversation(threadKey, create)).id;
  }

  /**
   * Settles when the store has stopped: `closed` after `close()`, or `failed` (with the cause) after the first storage
   * error. A failed Session never recovers (every later call rejects), so whoever holds the store must replace it.
   */
  get ended(): Promise<{ reason: "closed" } | { reason: "failed"; error: unknown }> {
    return this.harness.closed.then((end) => end.kind === "failed"
      ? { reason: "failed" as const, error: end.error } : { reason: "closed" as const });
  }

  /** Names of every tool registered with this store (fixed when it opened). */
  registeredToolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  /** How many distinct requests were ever admitted to this thread. Zero means nothing has been said to it yet. */
  async admittedRequests(threadKey: string): Promise<number> {
    return (await this.harness.snapshot(ThreadFamily, threadKey, context))?.admittedRequests ?? 0;
  }

  /** Whether this thread already has a conversation (a fork exists). */
  async hasThread(threadKey: string): Promise<boolean> {
    return (await this.threadId(threadKey)) !== undefined;
  }

  private async conversation(threadKey: string, create = true): Promise<Conversation> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.threadId(threadKey);
      if (existing) {
        const found = await this.harness.conversation(existing, context);
        if (!found) throw new Error("Stored thread mapping is missing its conversation");
        await this.rebind(found, threadKey);
        return found;
      }
      if (!create) throw new Error(`Unknown thread: ${threadKey}`);
      try {
        return await this.forkThread(threadKey, false);
      } catch (error) {
        // A concurrent creator won the atomic registration: use its conversation.
        if (!(error instanceof Error) || !/THREAD_EXISTS/.test(error.message)) throw error;
      }
    }
    throw new Error(`Could not open thread ${threadKey}`);
  }

  /**
   * A fork keeps its parent's stored agent, and a stored name outlives its code. On every
   * activation the CURRENT loadout and cwd are applied, never the inherited/persisted ones.
   */
  private async rebind(conversation: Conversation, threadKey?: string): Promise<void> {
    const agent = await conversation.agent(context);
    // A thread follows the channel default until it switches itself (pinned).
    let pinned = threadKey ? (await this.harness.snapshot(ThreadFamily, threadKey, context))?.pinnedModel === true : true;
    if (pinned && threadKey && agent.model) {
      // The allowlist can narrow after a thread pinned itself to a model: fall back to the channel default (and say
      // so) rather than leaving the thread refused on every message.
      try { this.checkModel(agent.model); } catch {
        logger.warn(`thread ${threadKey} was pinned to ${agent.model.provider}/${agent.model.modelId}, which is no longer allowed; following the channel default`);
        await this.harness.commit(async (tx) => {
          const thread = await tx.doc(ThreadFamily, threadKey, {
            conversationId: conversation.id, forkedFromEntry: 0, createdAt: 0, lastActivityAt: 0, resetCount: 0, pinnedModel: false, admittedRequests: 0,
          });
          thread.pinnedModel = false;
        }, context);
        pinned = false;
      }
    }
    if (!pinned) {
      const wanted = (await (await this.main()).agent(context)).model;
      if (wanted && (agent.model?.provider !== wanted.provider || agent.model?.modelId !== wanted.modelId)) {
        this.checkModel(wanted);
        await conversation.configure({ model: wanted }, context);
      }
    }
    const desired = this.toolsFor(threadKey);
    const wanted = desired.map((tool) => tool.name);
    const have = agent.tools.map((tool) => tool.name);
    const sameTools = wanted.length === have.length && wanted.every((name, index) => name === have[index]);
    const instructions = this.instructionsFor(threadKey);
    const sameInstructions = instructions.instructions === undefined || agent.instructions === instructions.instructions;
    if (sameTools && sameInstructions && agent.cwd === this.opts.workspace) return;
    await conversation.configure({
      extensions: [this.extension], tools: desired, cwd: this.opts.workspace, ...instructions,
    }, context);
  }

  private toolsFor(threadKey?: string): readonly ToolRegistration[] {
    const profile = threadKey ? this.profiles.get(threadKey) : undefined;
    if (!profile) return this.tools;
    const allowed = new Set(profile.tools);
    return this.tools.filter((tool) => allowed.has(tool.name));
  }

  private instructionsFor(threadKey?: string): { instructions?: string } {
    const instructions = (threadKey ? this.profiles.get(threadKey)?.instructions : undefined) ?? this.opts.instructions;
    return instructions === undefined ? {} : { instructions };
  }

  /**
   * Declare what this thread's conversation is offered. Applied (with the current cwd and model
   * policy) at the next activation, so a revoked tool is withdrawn from a pre-existing fork.
   */
  setThreadProfile(threadKey: string, profile: ThreadProfile): void {
    const known = new Set(this.tools.map((tool) => tool.name));
    for (const name of profile.tools) if (!known.has(name)) throw new Error(`Unregistered tool in profile: ${name}`);
    this.profiles.set(threadKey, { tools: [...profile.tools], ...(profile.instructions !== undefined ? { instructions: profile.instructions } : {}) });
  }

  clearThreadProfile(threadKey: string): void {
    this.profiles.delete(threadKey);
  }

  /**
   * Scheduler activation is explicit. Any progress call starts ALL ready work in the store,
   * so every conversation with live work, and every pinned checkpoint, is validated first.
   */
  async resume(): Promise<void> {
    await this.checkLive();
    this.harness.resume();
  }

  /** Public form of the pre-progress check: models of every live conversation, pinned checkpoints, blocked items. */
  async assertRunnable(): Promise<void> {
    await this.checkLive();
  }

  private async checkLive(extra?: Conversation): Promise<void> {
    // Any progress call starts ALL ready work in the store, so nothing may proceed while a recovered
    // conversation is unresolved, however unrelated the caller's own thread is.
    const blocked = await this.blocked();
    if (blocked.length > 0) throw new RecoveryBlockedError(blocked);
    const inspection = await this.harness.inspect(context);
    const ids = new Set<ConversationId>(inspection.tasks.filter((task) => !isBackgroundTaskKind(task.record.kind)).map((task) => task.record.conversationId));
    if (extra) ids.add(extra.id);
    for (const id of ids) {
      const conversation = id === extra?.id ? extra : await this.harness.conversation(id, context);
      const agent = await conversation?.agent(context);
      if (!agent?.model) throw new Error("Recovered conversation has no model");
      this.checkModel(agent.model);
    }
    // setModel changes the conversation, not generation/poll/compaction checkpoints.
    for (const task of inspection.tasks) this.policy.checkCheckpoint(task);
  }

  async submit(threadKey: string, input: {
    requestId: string; content: UserInput; userId: string;
    /**
     * What identifies this request for the reuse check. Defaults to the content. A caller whose content includes
     * material that legitimately differs between attempts (a one-time history preamble) passes the stable part, or a
     * redelivery after a crash would be rejected as a different request.
     */
    fingerprint?: string;
    steeringFor?: string;
    entry?: InputEntry;
  }): Promise<Submission> {
    if (!input.requestId || !input.userId) throw new Error("Stable requestId and userId are required");
    if (input.steeringFor === input.requestId) throw new Error("A request cannot steer itself");
    const conversation = await this.conversation(threadKey);
    await this.checkLive(conversation);
    const hash = digest(JSON.stringify({ content: input.fingerprint ?? input.content, userId: input.userId }));
    await conversation.commit(async (tx) => {
      const receipt = await tx.doc(RequestDoc, conversation.id, input.requestId, { hash, userId: input.userId, threadKey, admitted: false });
      const steeringFor = input.steeringFor ?? receipt.steeringFor;
      if (steeringFor) {
        const parent = await tx.doc(RequestDoc, conversation.id, steeringFor, { hash: "", userId: input.userId, threadKey, admitted: false });
        if (!parent.hash || !parent.admitted || parent.steeringFor) throw new Error("Steering requires an admitted original request");
        if (parent.userId !== input.userId) throw new Error("Cross-author steering requires a separate turn.");
        if (receipt.steeringFor && receipt.steeringFor !== steeringFor) throw new Error("Steering parent cannot change.");
        if (!receipt.steeringFor) {
          receipt.steeringFor = steeringFor;
          receipt.steeringDraft = JSON.stringify({ content: input.content, ...(input.entry ? { entry: input.entry } : {}) });
          parent.steeringIds ??= [];
          if (!parent.steeringIds.includes(input.requestId)) parent.steeringIds.push(input.requestId);
          await tx.doc(SteeringRouteFamily, input.requestId, { threadKey });
        }
      }
      if (receipt.hash !== hash) throw new Error("requestId was reused with different content/speaker");
      const thread = await tx.doc(ThreadFamily, threadKey, {
        conversationId: conversation.id, forkedFromEntry: 0, createdAt: 0, lastActivityAt: 0, resetCount: 0, pinnedModel: false, admittedRequests: 0,
      });
      thread.lastActivityAt = Date.now();
      // Counted once per distinct request: a retry of the same request must not make the thread look used twice.
      if (!receipt.admitted) { receipt.admitted = true; thread.admittedRequests = (thread.admittedRequests ?? 0) + 1; }
    }, context);
    // A crash between receipt and submit is harmless: retry completes admission.
    const submission = await conversation.submit({ type: "input", content: input.content, requestId: input.requestId, whenBusy: input.steeringFor ? "steer" : "followUp", ...(input.entry ? { entry: input.entry } : {}) }, context);
    // Returned handles also have progress methods; never expose an ungated scheduler start.
    return {
      id: submission.id,
      status: (ctx) => submission.status(ctx),
      wait: async (ctx) => { await this.checkLive(conversation); return submission.wait(ctx); },
      abort: async (ctx) => { await this.checkLive(conversation); return submission.abort(ctx); },
    };
  }

  /** A steering request belongs to its original reply, even on a later Slack redelivery. */
  async steeringParent(threadKey: string, requestId: string): Promise<string | undefined> {
    const route = await this.harness.snapshot(SteeringRouteFamily, requestId, context);
    const ownerKey = route?.threadKey ?? threadKey;
    const id = await this.threadId(ownerKey);
    if (!id) return undefined;
    const receipt = await this.harness.snapshot(RequestDoc, id, requestId, context);
    if (receipt?.steeringFor && receipt.steeringDraft !== undefined) {
      // Complete admission if a crash landed between the receipt and native submit.
      const conversation = await this.conversation(ownerKey);
      await this.checkLive(conversation);
      const parent = await this.harness.snapshot(RequestDoc, id, receipt.steeringFor, context);
      if (!parent?.userId || parent.userId !== receipt.userId) throw new Error("Cross-author steering requires a separate turn.");
      const draft = JSON.parse(receipt.steeringDraft) as { content: UserInput; entry?: InputEntry };
      await conversation.submit({ type: "input", requestId, ...draft, whenBusy: "steer" }, context);
    }
    return receipt?.steeringFor;
  }

  async watch(threadKey: string): Promise<AgentEventStream> {
    const conversation = await this.conversation(threadKey);
    return watchEvents(this.harness, conversation.id, context);
  }

  async model(threadKey: string): Promise<ModelRef | undefined> {
    return (await (await this.conversation(threadKey)).agent(context)).model;
  }

  /**
   * The agent (or an operator) moves this one thread to a model, which stops it following the channel
   * default. Takes effect from the thread's next request; an in-flight generation is undisturbed.
   */
  async setModel(threadKey: string, model: ModelRef): Promise<void> {
    this.checkModel(model);
    const conversation = await this.conversation(threadKey);
    await conversation.commit(async (tx) => {
      const thread = await tx.doc(ThreadFamily, threadKey, {
        conversationId: conversation.id, forkedFromEntry: 0, createdAt: 0, lastActivityAt: 0, resetCount: 0, pinnedModel: false, admittedRequests: 0,
      });
      thread.pinnedModel = true;
    }, context);
    await conversation.configure({ model }, context);
  }

  /** The thread's model if it has a conversation, else the channel default a new thread would start on. */
  async effectiveModel(threadKey: string): Promise<ModelRef | undefined> {
    const existing = await this.threadId(threadKey);
    const conversation = existing ? await this.harness.conversation(existing, context) : await this.main();
    return (await conversation?.agent(context))?.model;
  }

  /** `!model`: set (or with null, clear) the operator's channel-wide default. Unpinned threads follow it. */
  async setChannelModel(model: ModelRef | null): Promise<ModelRef> {
    const target = model ?? this.opts.model;
    this.checkModel(target);
    await this.harness.commit(async (tx) => { (await tx.doc(HostDoc)).modelOverride = model !== null; }, context);
    await (await this.main()).configure({ model: target }, context);
    return target;
  }

  async channelModel(): Promise<{ model: ModelRef; overridden: boolean }> {
    const overridden = (await this.harness.snapshot(HostDoc, context))?.modelOverride === true;
    const model = (await (await this.main()).agent(context)).model ?? this.opts.model;
    return { model, overridden };
  }

  /** Make a thread follow the channel default again (used by `!model` so the command applies where typed). */
  async unpinThread(threadKey: string): Promise<void> {
    const existing = await this.threadId(threadKey);
    if (!existing) return;
    const conversation = await this.harness.conversation(existing, context);
    await conversation?.commit(async (tx) => {
      const thread = await tx.doc(ThreadFamily, threadKey, {
        conversationId: existing, forkedFromEntry: 0, createdAt: 0, lastActivityAt: 0, resetCount: 0, pinnedModel: false, admittedRequests: 0,
      });
      thread.pinnedModel = false;
    }, context);
    // Follow the channel default now, so `!model` and the next turn agree instead of showing the stale pinned model.
    if (conversation) await this.rebind(conversation, threadKey);
  }

  async abort(threadKey: string): Promise<void> {
    const conversation = await this.conversation(threadKey, false);
    await this.checkLive(conversation);
    await conversation.abort(context);
  }

  /** `!reset`: a fresh fork of the trunk's tail replaces the thread; the old fork is kept. */
  async resetThread(threadKey: string): Promise<boolean> {
    // A thread whose first fork is still being created does exist: wait for it rather than reporting "nothing to reset".
    await this.forking.get(threadKey)?.catch(() => undefined);
    if (!(await this.hasThread(threadKey))) return false;
    await this.forkThread(threadKey, true);
    return true;
  }

  /** A short digest of what a thread did, appended to the trunk for future threads. */
  async appendMainContext(kind: string, text: string): Promise<void> {
    const main = await this.main();
    await main.commit(async (tx) => {
      await tx.appendEntry(main.id, { kind, model: [{ role: "user", content: text, timestamp: Date.now() }] });
    }, context);
  }

  /** A one-off fork of the trunk for a scheduled run or dream, registered under its own key. */
  async openRun(runKey: string): Promise<void> {
    await this.conversation(runKey);
  }

  /**
   * A fresh conversation for one subagent run. Unlike a thread it is not a fork of the trunk: its context is its
   * own, so it never carries the channel agent's history, digests or tool results. It is pinned to the model
   * the role asks for (which must be on this channel's allowlist), so it does not follow the channel default.
   */
  async openSubagentRun(runKey: string, spec: SubagentRunSpec): Promise<ConversationId> {
    if (!isSubagentRunKey(runKey) || runKey.length > 200) throw new Error("Invalid subagent run key");
    this.checkModel(spec.model);
    if (await this.threadId(runKey)) throw new Error(`Subagent run already exists: ${runKey}`);
    const conversation = await this.harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: {
        model: { ...spec.model }, extensions: [this.extension], tools: this.toolsFor(runKey), cwd: this.opts.workspace,
        ...this.instructionsFor(runKey),
        ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
      },
      init: async (tx, id) => {
        await tx.doc(ThreadFamily, runKey, {
          conversationId: id, forkedFromEntry: 0, createdAt: Date.now(), lastActivityAt: Date.now(), resetCount: 0, pinnedModel: true, admittedRequests: 0,
        });
        const route = await tx.doc(RouteDoc, id);
        route.kind = "run";
        route.threadKey = runKey;
      },
    }, context);
    return conversation.id;
  }

  async transcript(threadKey: string) {
    return (await this.conversation(threadKey)).context(context);
  }

  /** The thread's model context, or undefined (without forking) when it has no conversation. */
  async transcriptIfExists(threadKey: string) {
    if (!(await this.hasThread(threadKey))) return undefined;
    return this.transcript(threadKey);
  }

  async mainTranscript() {
    return (await this.main()).context(context);
  }

  /** Every thread with a conversation, with when it last took a message. Never includes the trunk. */
  async listThreads(since?: number): Promise<{ threadKey: string; conversationId: ConversationId; createdAt: number; lastActivityAt: number }[]> {
    const out: { threadKey: string; conversationId: ConversationId; createdAt: number; lastActivityAt: number }[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: "slack.thread" }, 200, cursor, context,
      );
      for (const record of page.items) {
        if (!record.key || isSubagentRunKey(record.key)) continue;
        const thread = await this.harness.snapshot(ThreadFamily, record.key, context);
        if (!thread || (since !== undefined && thread.lastActivityAt <= since)) continue;
        out.push({ threadKey: record.key, conversationId: thread.conversationId, createdAt: thread.createdAt, lastActivityAt: thread.lastActivityAt });
      }
      cursor = page.next;
    } while (cursor);
    return out;
  }

  /**
   * What was actually said in this thread: user and assistant text only, and none of what the thread
   * merely inherited from the channel trunk when it forked.
   */
  async threadTurns(threadKey: string): Promise<{ role: "user" | "assistant"; text: string }[]> {
    const thread = await this.harness.snapshot(ThreadFamily, threadKey, context);
    if (!thread) return [];
    const conversation = await this.harness.conversation(thread.conversationId, context);
    const view = await conversation?.context(context);
    if (!view) return [];
    const turns: { role: "user" | "assistant"; text: string }[] = [];
    view.entries.forEach((entry, index) => {
      if (entry.id <= thread.forkedFromEntry) return;
      for (const message of view.contributions[index] ?? []) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = typeof message.content === "string"
          ? message.content
          : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
        if (text.trim()) turns.push({ role: message.role, text: text.trim() });
      }
    });
    return turns;
  }

  /**
   * Every conversation with a thread document (threads, scheduled and dream forks, subagent runs), for the read-only web
   * console. Unlike `listThreads` it includes subagent runs, and like it, it creates nothing.
   */
  async consoleRoutes(): Promise<{ threadKey: string; createdAt: number; lastActivityAt: number; forkedFromEntry: number; pinnedModel: boolean }[]> {
    const out: { threadKey: string; createdAt: number; lastActivityAt: number; forkedFromEntry: number; pinnedModel: boolean }[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: "slack.thread" }, 200, cursor, context,
      );
      for (const record of page.items) {
        if (!record.key) continue;
        const thread = await this.harness.snapshot(ThreadFamily, record.key, context);
        if (!thread) continue;
        out.push({
          threadKey: record.key, createdAt: thread.createdAt, lastActivityAt: thread.lastActivityAt,
          forkedFromEntry: thread.forkedFromEntry, pinnedModel: thread.pinnedModel,
        });
      }
      cursor = page.next;
    } while (cursor);
    return out;
  }

  /**
   * A conversation's raw transcript for the read-only console: the trunk for the key `main`, otherwise an existing
   * thread. Never forks, never creates, never changes the thread.
   */
  async consoleTranscript(threadKey: string): Promise<
    { view: Awaited<ReturnType<Conversation["context"]>>; forkedFromEntry: number; pinnedModel: boolean; model?: ModelRef } | undefined
  > {
    let conversation: Conversation | undefined;
    let forkedFromEntry = 0;
    let pinnedModel = false;
    if (threadKey === "main") {
      conversation = await this.main();
    } else {
      if (!threadKey || threadKey.length > 200) return undefined;
      const thread = await this.harness.snapshot(ThreadFamily, threadKey, context);
      if (!thread || !thread.conversationId) return undefined;
      conversation = await this.harness.conversation(thread.conversationId, context);
      forkedFromEntry = thread.forkedFromEntry;
      pinnedModel = thread.pinnedModel;
    }
    if (!conversation) return undefined;
    const view = await conversation.context(context);
    const model = (await conversation.agent(context)).model;
    return { view, forkedFromEntry, pinnedModel, ...(model ? { model } : {}) };
  }

  /** Live events for an existing thread (or the trunk) without creating it; undefined when there is none. */
  async consoleWatch(threadKey: string): Promise<AgentEventStream | undefined> {
    const id = threadKey === "main" ? this.mainId : await this.threadId(threadKey);
    if (!id) return undefined;
    return watchEvents(this.harness, id, context);
  }

  /** Thread keys that have unfinished work right now (`main` for the trunk). Reads only. */
  async consoleBusyThreads(): Promise<Set<string>> {
    const busy = new Set<string>();
    for (const { conversationId, route } of await this.liveRoutes()) {
      busy.add(conversationId === this.mainId ? "main" : route.threadKey);
    }
    return busy;
  }

  /**
   * The whole state object with its revision, who wrote it last and the recent change log. Reads only: it never creates the
   * document, so an unused channel reports revision 0 and an empty object.
   */
  async stateSnapshot(): Promise<{ rev: number; value: StateObject; updatedAt: number; updatedBy: StateWriter; changes: StateChange[]; bytes: number }> {
    const doc = await this.harness.snapshot(AppStateDoc, context);
    const value = (doc?.value ?? {}) as StateObject;
    return {
      rev: doc?.rev ?? 0, value, updatedAt: doc?.updatedAt ?? 0,
      updatedBy: doc?.updatedBy ?? { source: "agent", threadKey: "", userId: "" },
      changes: [...(doc?.changes ?? [])], bytes: stateBytes(value),
    };
  }

  /** Just the revision, for callers that only need to know whether the state changed (the web console's poll). */
  async stateRev(): Promise<number> {
    return (await this.harness.snapshot(AppStateDoc, context))?.rev ?? 0;
  }

  /** The state at a JSON Pointer path (the empty string is the whole object), with the revision it was read at. */
  async readState(path = ""): Promise<StateRead & { rev: number; updatedAt: number }> {
    const segments = parsePointer(path);
    const snapshot = await this.stateSnapshot();
    return { ...readPath(snapshot.value, segments), rev: snapshot.rev, updatedAt: snapshot.updatedAt };
  }

  /**
   * One atomic update of the state object. The read, the check, the change and the write are a single commit, so two threads
   * updating at once cannot lose each other's work; `expectedRev` turns a stale read into a refusal that names the current
   * revision. An update that changes nothing does not advance the revision. Refusals are `StateError`s.
   */
  async updateState(input: { op: StateOp; path: string; value?: StateJson; expectedRev?: number; by: { source: StateWriter["source"]; threadKey?: string; userId?: string } }): Promise<{ rev: number; changed: boolean }> {
    // Validated before the commit so a bad request never takes the commit line.
    parsePointer(input.path);
    // A thrown error inside a commit callback is not an application result, so failures come back as values.
    const outcome = await this.harness.commit(async (tx) => applyStateUpdate(await tx.doc(AppStateDoc), input), context);
    if ("error" in outcome) throw outcome.error;
    return outcome;
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Runs that have not finished, with the task each is. Not a conversation's work: see `liveRoutes`. */
  async liveJobs(): Promise<{ taskId: TaskId; runId: string; status: string }[]> {
    const inspection = await this.harness.inspect(context);
    return inspection.tasks
      .filter((task) => isJobTaskKind(task.record.kind) && task.record.state.status !== "terminal" && task.record.state.status !== "completing")
      .map((task) => ({ taskId: task.record.id, runId: String((task.record.input as { runId?: unknown }).runId ?? ""), status: task.record.state.status }));
  }

  /**
   * Start a run. The definition is pinned into the run (with its hash), so editing config while it runs changes nothing. The
   * run record and the task are created in one commit. Refuses while recovery is blocked, when this job is already running,
   * and past `MAX_LIVE_JOBS`.
   */
  async startJob(input: { name: string; definition: JobDefinition; hash: string; input: Record<string, string>; by: JobStarter }): Promise<{ runId: string }> {
    await this.checkLive();
    const jobTask = this.opts.jobTask;
    if (!jobTask) throw new Error("Jobs are not available in this channel's store.");
    const live = await this.liveJobs();
    if (live.length >= MAX_LIVE_JOBS) throw new Error(`${live.length} jobs are already running in this channel; wait for one to finish.`);
    for (const { runId } of live) {
      if ((await this.jobRun(runId))?.job === input.name) throw new Error(`"${input.name}" is already running (run ${runId}); check it, or abort it first.`);
    }
    const runId = `run_${randomBytes(5).toString("hex")}`;
    const now = Date.now();
    await this.harness.commit(async (tx) => {
      const run = await tx.doc(JobRunFamily, runId, emptyRun(runId));
      run.job = input.name;
      run.hash = input.hash;
      run.definition = JSON.stringify(input.definition);
      run.input = { ...input.input };
      run.by = { ...input.by };
      run.status = "running";
      run.index = 0;
      run.startedAt = now;
      run.updatedAt = now;
      run.phases = input.definition.phases.map((phase) => ({ name: phase.name, kind: phase.kind, status: "pending" as const, startedAt: 0, endedAt: 0, exit: -1, summary: "" }));
      await tx.createTask(jobTask, { runId }, { ownership: { kind: "conversation" }, conversationId: this.mainId, background: true });
    }, context);
    // Scheduling is already running after the recovery gate; this makes sure the new task is picked up.
    this.harness.resume();
    return { runId };
  }

  /**
   * Start a background run task: `seed` writes the run's record in the same commit that creates the task, so a task never
   * exists without its record. Owned by the main conversation like a job, so stopping that conversation does not end it.
   */
  async startRunTask<Input extends object>(
    kind: string,
    input: Input,
    seed: (tx: Parameters<Parameters<Harness["commit"]>[0]>[0]) => Promise<void>,
  ): Promise<void> {
    await this.checkLive();
    const task = this.opts.runTasks?.find((candidate) => (candidate as unknown as { definition: { name: string } }).definition.name === kind);
    if (!task || !isRunTaskKind(kind)) throw new Error(`"${kind}" is not registered in this channel's store.`);
    await this.harness.commit(async (tx) => {
      await seed(tx);
      await tx.createTask(task as never, input as never, { ownership: { kind: "conversation" }, conversationId: this.mainId, background: true });
    }, context);
    this.harness.resume();
  }

  /** Gated task workflows use the same channel lock and atomic storage as conversations. */
  async taskWorkflow(id: string): Promise<TaskWorkflow | undefined> {
    const doc = await this.harness.snapshot(TaskWorkflowFamily, id, context);
    return doc?.json ? JSON.parse(doc.json) as TaskWorkflow : undefined;
  }

  async changeTaskWorkflow(id: string, change: (current: TaskWorkflow | undefined) => TaskWorkflow): Promise<TaskWorkflow> {
    await this.checkLive();
    let result!: TaskWorkflow;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(TaskWorkflowFamily, id, { json: "" });
      result = change(doc.json ? JSON.parse(doc.json) as TaskWorkflow : undefined);
      if (result.channelId !== this.opts.channelId || result.id !== id) throw new Error("Workflow identity does not match this channel's store.");
      doc.json = JSON.stringify(result);
    }, context);
    try { this.opts.onTaskWorkflowChange?.(structuredClone(result)); } catch (error) { logger.debug(`task workflow observer failed: ${error}`); }
    return structuredClone(result);
  }

  /** Slack metadata never changes the workflow revision or emits an execution-change event. */
  async setTaskWorkflowSlack(id: string, ts: string, location?: "channel" | "thread"): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(TaskWorkflowFamily, id, { json: "" });
      if (!doc.json) return;
      const workflow = JSON.parse(doc.json) as TaskWorkflow;
      workflow.slack = { ts, ...(location ? { location } : {}) };
      doc.json = JSON.stringify(workflow);
    }, context);
  }

  async listTaskWorkflows(threadKey?: string): Promise<TaskWorkflow[]> {
    const runs: TaskWorkflow[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: "slack.task-workflow" }, 200, cursor, context);
      for (const entry of page.items) {
        if (!entry.key) continue;
        const workflow = await this.taskWorkflow(entry.key);
        if (workflow && (threadKey === undefined || workflow.parentThreadKey === threadKey)) runs.push(workflow);
      }
      cursor = page.next;
    } while (cursor);
    return runs;
  }

  /** A background run's record document, as the store holds it. Callers copy what they keep. */
  async runDoc(family: unknown, key: string): Promise<unknown> {
    return this.harness.snapshot(family as never, key, context);
  }

  /** A run's record, or undefined. A copy: nothing here can be used to change it. */
  async jobRun(runId: string): Promise<JobRunData | undefined> {
    const run = await this.harness.snapshot(JobRunFamily, runId, context);
    return run && run.job ? (JSON.parse(JSON.stringify(run)) as JobRunData) : undefined;
  }

  /** Recent runs, newest first. */
  async listJobRuns(limit = 20): Promise<JobRunData[]> {
    const runs: JobRunData[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: "slack.job-run" }, 200, cursor, context);
      for (const record of page.items) {
        if (!record.key) continue;
        const run = await this.jobRun(record.key);
        if (run) runs.push(run);
      }
      cursor = page.next;
    } while (cursor);
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(0, limit));
  }

  /** Answer a run that stopped because a phase was interrupted: retry it, skip it, or abort the run. */
  async decideJob(runId: string, decision: "retry" | "skip" | "abort", by: string): Promise<void> {
    const run = await this.jobRun(runId);
    if (!run) throw new Error(`There is no run ${runId}.`);
    if (run.status !== "needs_decision") throw new Error(`Run ${runId} is ${run.status.replace("_", " ")}: there is nothing to decide.`);
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(JobDecisionFamily, runId, emptyDecision());
      doc.decision = decision;
      doc.at = Date.now();
      doc.by = by;
    }, context);
  }

  /** Abort a run that has not finished. Records why first, so the run says so. Does not wait for the task to end. */
  async abortJob(runId: string, reason: string): Promise<"marked" | "terminal"> {
    const live = (await this.liveJobs()).find((job) => job.runId === runId);
    if (!live) return "terminal";
    await this.harness.commit(async (tx) => { (await tx.doc(JobRunFamily, runId, emptyRun(runId))).reason = reason; }, context);
    return this.harness.abortTask(live.taskId, context);
  }

  // ── Software factory workflow runs ─────────────────────────────────────────────────────────────────────────

  /** Runs that have not finished, with the task each is. Like jobs, not a conversation's work: see `liveRoutes`. */
  async liveFactoryRuns(): Promise<{ taskId: TaskId; runId: string; status: string }[]> {
    const inspection = await this.harness.inspect(context);
    return inspection.tasks
      .filter((task) => task.record.kind === FACTORY_TASK_KIND && task.record.state.status !== "terminal" && task.record.state.status !== "completing")
      .map((task) => ({ taskId: task.record.id, runId: String((task.record.input as { runId?: unknown }).runId ?? ""), status: task.record.state.status }));
  }

  /**
   * Start a workflow run for one issue. The workflow is pinned into the run (with its hash); the record and the task are created
   * in one commit. Refuses while recovery is blocked, for a workflow that does not validate, for an issue that already has a
   * live run, and past `MAX_LIVE_FACTORY_RUNS`.
   */
  async startFactoryRun(input: {
    definition: WorkflowDefinition; repo: string; issue: number; issueTitle: string; issueUrl: string; workItem?: import("../../factory/workflow/source.ts").WorkItem; notes?: string; by: FactoryStarter;
    /** How it began; `manual` when absent. */
    origin?: RunOrigin;
    /** Why it was allowed to start (author_association, harness_filed, go_label, released, manual). */
    trust?: string;
    /** What intake knows of the issue, kept in the mapping so the next poll sees only what changed after it. */
    mapping?: Partial<Pick<IntakeEntry, "author" | "association" | "createdAt" | "lastUpdatedAt" | "commentWatermark" | "comments" | "bodyHash" | "labelsKey">>;
    /** Updates already known when the run starts (a reopen), oldest first. */
    updates?: RunUpdate[];
    /** The most runs live at once (`factory.maxLiveRuns`). Absent: `MAX_LIVE_FACTORY_RUNS`. */
    maxLive?: number;
  }): Promise<{ runId: string }> {
    // One start at a time per channel, so a person's start and the poller's cannot both pass the checks below for the same issue.
    const turn = this.startChain.catch(() => undefined).then(() => this.startFactoryRunNow(input));
    this.startChain = turn;
    return turn;
  }

  private startChain: Promise<unknown> = Promise.resolve();

  private async startFactoryRunNow(input: Parameters<DurableChannelStore["startFactoryRun"]>[0]): Promise<{ runId: string }> {
    await this.checkLive();
    const task = this.opts.runTasks?.find((candidate) => (candidate as unknown as { definition: { name: string } }).definition.name === FACTORY_TASK_KIND);
    if (!task) throw new Error("Workflow runs are not available in this channel's store.");
    const problems = validateWorkflow(input.definition);
    if (problems.length > 0) throw new Error(`The workflow is not valid: ${problems.join("; ")}`);
    const live = await this.liveFactoryRuns();
    if (live.length >= (input.maxLive ?? MAX_LIVE_FACTORY_RUNS)) throw new Error(`${live.length} workflow runs are already live in this channel; wait for one to finish.`);
    for (const { runId } of live) {
      const other = await this.factoryRun(runId);
      if (other && other.repo.toLowerCase() === input.repo.toLowerCase() && other.issue === input.issue && other.workItem?.site === input.workItem?.site) {
        throw new Error(`${input.repo}#${input.issue} already has a live run (${runId}); check it, or abort it first.`);
      }
    }
    const runId = `fr_${randomBytes(5).toString("hex")}`;
    const now = Date.now();
    await this.harness.commit(async (tx) => {
      const run = (await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId))) as unknown as FactoryRunData;
      run.workflow = input.definition.name;
      run.hash = hashWorkflow(input.definition);
      run.definition = JSON.stringify(input.definition);
      run.repo = input.repo;
      run.issue = input.issue;
      run.issueTitle = input.issueTitle.slice(0, 300);
      run.issueUrl = input.issueUrl;
      run.notes = (input.notes ?? "").slice(0, 1000);
      run.by = { ...input.by };
      run.source = input.workItem ? "jira" : "github";
      if (input.workItem) run.workItem = { ...input.workItem };
      run.origin = input.origin ?? "manual";
      run.trust = input.trust ?? "manual";
      run.updates = (input.updates ?? []).slice(-MAX_RUN_UPDATES);
      run.stages = initialStages(input.definition);
      run.startedAt = now;
      enterStage(run, input.definition, input.definition.start, now);
      // The mapping of the issue to this run, in the same commit: an issue started by a person or by the poller is mapped either way,
      // so the poller sends its changes to this run instead of starting another.
      const mappingRepo = input.workItem ? `jira:${input.workItem.site}:${input.repo}` : input.repo;
      const intake = (await tx.doc(FactoryIntakeFamily, intakeKey(mappingRepo), emptyIntakeRepo(mappingRepo))) as unknown as IntakeRepoData;
      if (!intake.repo) intake.repo = mappingRepo;
      const key = String(input.issue);
      const before = intake.entries[key] ?? emptyIntakeEntry(input.issue);
      intake.entries[key] = {
        ...before, ...(input.mapping ?? {}), ...(input.workItem ? { workItem: { ...input.workItem } } : {}), number: input.issue, title: input.issueTitle.slice(0, 200), url: input.issueUrl, status: "open",
        runId, runs: [...before.runs.filter((id) => id !== runId), runId].slice(-10), reason: "", trust: run.trust, closedAt: 0,
        firstSeen: before.firstSeen || now, released: before.released,
      };
      if (run.origin === "intake") intake.starts = [...intake.starts.filter((at) => now - at < 3_600_000), now];
      await tx.createTask(task as never, { runId }, { ownership: { kind: "conversation" }, conversationId: this.mainId, background: true });
    }, context);
    this.harness.resume();
    return { runId };
  }

  /** A workflow run's record, or undefined. A copy: nothing here can be used to change it. */
  async factoryRun(runId: string): Promise<FactoryRunData | undefined> {
    const run = await this.harness.snapshot(FactoryRunFamily, runId, context);
    if (!run || !run.workflow) return undefined;
    const copy = JSON.parse(JSON.stringify(run)) as FactoryRunData;
    // A run recorded before the Slack presence existed has no `slack` part, and one from before intake has no source, origin or updates.
    copy.slack = { ...emptyRunSlack(), ...(copy.slack ?? {}) };
    copy.source = copy.source ?? "github";
    copy.origin = copy.origin ?? "manual";
    copy.trust = copy.trust ?? "";
    copy.updates = copy.updates ?? [];
    copy.abortReason = copy.abortReason ?? "";
    return copy;
  }

  /**
   * Record where a run shows in Slack. Written from outside the task, in its own commit, and only these fields: the task's own
   * writes never touch `slack`, so the two cannot overwrite each other. `event` is appended to the keys already said.
   */
  async setFactoryRunSlack(runId: string, change: { channel?: string; ts?: string; posts?: number; event?: string; decision?: RunSlack["decision"] }): Promise<void> {
    await this.harness.commit(async (tx) => {
      const run = (await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId))) as unknown as FactoryRunData;
      const slack = { ...emptyRunSlack(), ...(run.slack ?? {}) };
      if (change.channel !== undefined) slack.channel = change.channel;
      if (change.ts !== undefined) slack.ts = change.ts;
      if (change.posts !== undefined) slack.posts = change.posts;
      if (change.decision !== undefined) slack.decision = { ...change.decision };
      if (change.event !== undefined && !slack.events.includes(change.event)) slack.events = [...slack.events, change.event].slice(-MAX_RUN_SLACK_EVENTS);
      run.slack = slack;
    }, context);
  }

  // ── Issue intake: the mapping of issues to runs ────────────────────────────────────────────────────────────

  /** A repository's intake record, or an empty one. A copy. */
  async factoryIntake(repo: string): Promise<IntakeRepoData> {
    const doc = await this.harness.snapshot(FactoryIntakeFamily, intakeKey(repo), context);
    return doc && doc.repo ? (JSON.parse(JSON.stringify(doc)) as IntakeRepoData) : emptyIntakeRepo(repo);
  }

  /** Change a repository's intake record in one commit. `change` runs on the live record, synchronously. */
  async mutateFactoryIntake(repo: string, change: (data: IntakeRepoData) => void): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = (await tx.doc(FactoryIntakeFamily, intakeKey(repo), emptyIntakeRepo(repo))) as unknown as IntakeRepoData;
      if (!doc.repo) doc.repo = repo;
      change(doc);
    }, context);
  }

  /** Every repository's intake record in this channel. */
  async listFactoryIntake(): Promise<IntakeRepoData[]> {
    const found: IntakeRepoData[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: "slack.factory-intake" }, 100, cursor, context);
      for (const record of page.items) {
        const doc = record.key ? await this.harness.snapshot(FactoryIntakeFamily, record.key, context) : undefined;
        if (doc && doc.repo) found.push(JSON.parse(JSON.stringify(doc)) as IntakeRepoData);
      }
      cursor = page.next;
    } while (cursor);
    return found;
  }

  /**
   * What changed on a mapped issue: append `updates` to its run and move the mapping's markers, in ONE commit, so a crash neither
   * loses an update nor delivers it twice. Only the run's `updates` are touched here; the task's own writes never touch them.
   */
  async recordIntakeUpdates(input: { repo: string; issue: number; runId: string; updates: RunUpdate[]; patch: Partial<IntakeEntry> }): Promise<void> {
    await this.harness.commit(async (tx) => {
      const intake = (await tx.doc(FactoryIntakeFamily, intakeKey(input.repo), emptyIntakeRepo(input.repo))) as unknown as IntakeRepoData;
      const entry = intake.entries[String(input.issue)];
      if (entry) intake.entries[String(input.issue)] = { ...entry, ...input.patch };
      if (input.updates.length > 0) {
        const run = (await tx.doc(FactoryRunFamily, input.runId, emptyFactoryRun(input.runId))) as unknown as FactoryRunData;
        if (run.workflow) run.updates = [...(run.updates ?? []), ...input.updates].slice(-MAX_RUN_UPDATES);
      }
    }, context);
  }

  /** An answer given in Slack to a run waiting for information: appended to the run's updates in one commit. */
  async addFactoryRunUpdate(runId: string, update: RunUpdate): Promise<void> {
    await this.harness.commit(async (tx) => {
      const run = (await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId))) as unknown as FactoryRunData;
      if (run.workflow) run.updates = [...(run.updates ?? []), update].slice(-MAX_RUN_UPDATES);
    }, context);
  }

  /** The harness filed this issue itself: the proof of it a forged footer cannot give. */
  async noteFiledByHarness(repo: string, issue: number): Promise<void> {
    await this.mutateFactoryIntake(repo, (data) => {
      if (!data.filedByHarness.includes(issue)) data.filedByHarness = [...data.filedByHarness, issue].slice(-MAX_FILED_BY_HARNESS);
    });
  }

  /** The channel's rolling intake note, as the Slack presence last recorded it. */
  async intakeNote(): Promise<IntakeNoteData> {
    const doc = await this.harness.snapshot(FactoryIntakeNoteFamily, INTAKE_NOTE_KEY, context);
    return doc && doc.day ? (JSON.parse(JSON.stringify(doc)) as IntakeNoteData) : emptyIntakeNote();
  }

  /** Record what the Slack presence did to the intake note. Only these fields; `event` is appended to the lines already said. */
  async setIntakeNote(change: { day?: string; channel?: string; ts?: string; counts?: Record<string, number>; event?: string }): Promise<void> {
    await this.harness.commit(async (tx) => {
      const note = (await tx.doc(FactoryIntakeNoteFamily, INTAKE_NOTE_KEY, emptyIntakeNote())) as unknown as IntakeNoteData;
      if (change.day !== undefined && change.day !== note.day) { note.day = change.day; note.ts = ""; note.counts = {}; note.events = []; }
      if (change.channel !== undefined) note.channel = change.channel;
      if (change.ts !== undefined) note.ts = change.ts;
      if (change.counts !== undefined) note.counts = { ...change.counts };
      if (change.event !== undefined && !note.events.includes(change.event)) note.events = [...note.events, change.event].slice(-MAX_NOTE_EVENTS);
    }, context);
  }

  /** Recent workflow runs, newest first. */
  async listFactoryRuns(limit = 20): Promise<FactoryRunData[]> {
    const runs: FactoryRunData[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: "slack.factory-run" }, 200, cursor, context);
      for (const record of page.items) {
        if (!record.key) continue;
        const run = await this.factoryRun(record.key);
        if (run) runs.push(run);
      }
      cursor = page.next;
    } while (cursor);
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(0, limit));
  }

  /**
   * Answer a run that is waiting (the merge gate, a deploy approval, a loop out of rounds) or needs a decision (an interrupted
   * stage). Refused unless the run is waiting for something this decision answers. The task checks that `by` may decide, so a
   * decision from anyone else is ignored and noted on the run; whoever calls this should have checked first, to say so.
   */
  async decideFactoryRun(runId: string, decision: Exclude<FactoryDecisionKind, "">, by: string, head = "", stage = "", changes?: { feedback: string; since: number }): Promise<void> {
    const run = await this.factoryRun(runId);
    if (!run) throw new Error(`There is no workflow run ${runId}.`);
    const kind = run.wait.kind;
    if (isTerminalRun(run.status) || kind === "") throw new Error(`Run ${runId} is ${run.status.replace("_", " ")}: there is nothing to decide.`);
    if (kind === "info") throw new Error(`Run ${runId} is waiting for an answer on the issue itself: a trusted person has to comment there (or the run can be aborted). A decision does not answer it.`);
    if (!DECISIONS_FOR[kind].includes(decision)) throw new Error(`Run ${runId} is waiting on ${kind === "decide" ? "an interrupted stage" : kind === "failed" ? "a failed stage" : kind}: ${DECISIONS_FOR[kind].join(" or ")} answers it, not ${decision}.`);
    if (decision === "restart_from" && !stage) throw new Error(`restart_from needs the earlier stage to go back to.`);
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(FactoryDecisionFamily, runId, emptyFactoryDecision());
      if (doc.decision === "request_changes") throw new Error("That wait already has a request for changes.");
      if (decision === "request_changes") {
        const live = await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId));
        if (!changes?.feedback.trim() || changes.feedback.length > 3000) throw new Error("Supply actionable feedback (1–3000 characters).");
        if (live.status !== "waiting" || live.wait.kind !== "merge" || live.wait.since !== changes.since || live.pr.reviewedHead !== head) throw new Error("That merge approval is no longer waiting for feedback.");
        if (doc.decision !== "") throw new Error("That wait already has a decision.");
      }
      doc.feedback = changes?.feedback ?? "";
      doc.since = changes?.since ?? 0;
      doc.decision = decision;
      doc.at = Date.now();
      doc.by = by;
      doc.head = head;
      doc.stage = stage;
    }, context);
  }

  /**
   * Carry on a run that ended `failed`, from the stage it failed at, as a new attempt on the SAME record: its pull request, risk,
   * rounds and history are what they were. A new task is attached to the record (the old one is over) in one commit with the
   * record's reset, so a restart never finds the one without the other. This is for the runs that ended failed before a failed
   * stage waited for a person, and for the few things that still end a run failed. Refused unless the run is `failed` and its
   * stage is one its pinned workflow has, its issue's mapping still points at it, and no other run is live for the issue.
   */
  async reopenFactoryRun(runId: string, maxLive?: number): Promise<void> {
    const turn = this.startChain.catch(() => undefined).then(() => this.reopenFactoryRunNow(runId, maxLive));
    this.startChain = turn;
    return turn;
  }

  private async reopenFactoryRunNow(runId: string, maxLive?: number): Promise<void> {
    await this.checkLive();
    const task = this.opts.runTasks?.find((candidate) => (candidate as unknown as { definition: { name: string } }).definition.name === FACTORY_TASK_KIND);
    if (!task) throw new Error("Workflow runs are not available in this channel's store.");
    const run = await this.factoryRun(runId);
    if (!run) throw new Error(`There is no workflow run ${runId}.`);
    if (run.status !== "failed") throw new Error(`Run ${runId} is ${run.status.replace("_", " ")}: only a run that failed can be reopened.`);
    const definition = pinnedWorkflow(run);
    if (!definition || !definition.stages.some((stage) => stage.name === run.current) || !findStage(run, run.current)) {
      throw new Error(`Run ${runId} cannot be carried on: its record or its workflow is unreadable, so it has no stage to go back to.`);
    }
    const live = await this.liveFactoryRuns();
    if (live.length >= (maxLive ?? MAX_LIVE_FACTORY_RUNS)) throw new Error(`${live.length} workflow runs are already live in this channel; wait for one to finish.`);
    for (const { runId: otherId } of live) {
      const other = await this.factoryRun(otherId);
      if (other && other.repo.toLowerCase() === run.repo.toLowerCase() && other.issue === run.issue) {
        throw new Error(`${run.repo}#${run.issue} already has a live run (${otherId}); check it, or abort it first.`);
      }
    }
    const mapping = (await this.factoryIntake(run.repo)).entries[String(run.issue)];
    if (mapping && mapping.runId !== runId) throw new Error(`${run.repo}#${run.issue} now belongs to run ${mapping.runId}; reopen that one, or start the issue again.`);
    if (mapping && mapping.status === "closed") throw new Error(`${run.repo}#${run.issue} is closed.`);
    await this.harness.commit(async (tx) => {
      const doc = (await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId))) as unknown as FactoryRunData;
      const now = Date.now();
      const stage = findStage(doc, doc.current)!;
      stage.status = "in_progress";
      doc.status = "running";
      doc.reason = "";
      doc.abortReason = "";
      doc.wait = { kind: "", since: 0 };
      doc.guard = { from: "", target: "" };
      doc.endedAt = 0;
      doc.updatedAt = now;
      // The decision document may still hold an answer to a wait that no longer exists: the new task starts clean.
      const decision = await tx.doc(FactoryDecisionFamily, runId, emptyFactoryDecision());
      decision.decision = "";
      const intake = (await tx.doc(FactoryIntakeFamily, intakeKey(run.repo), emptyIntakeRepo(run.repo))) as unknown as IntakeRepoData;
      const entry = intake.entries[String(run.issue)];
      if (entry) intake.entries[String(run.issue)] = { ...entry, status: "open", runId, closedAt: 0, reason: "" };
      await tx.createTask(task as never, { runId }, { ownership: { kind: "conversation" }, conversationId: this.mainId, background: true });
    }, context);
    this.harness.resume();
  }

  /** Record external resolution before stopping pre-merge work. The task's abort hook completes, rather than cancels, it. */
  async reconcileMergedFactoryRun(runId: string, pr: number, facts: PrFacts): Promise<boolean> {
    if (facts.state !== "merged") throw new Error("Only an observed GitHub merge can resolve an issue closure.");
    const live = (await this.liveFactoryRuns()).find((run) => run.runId === runId);
    const changed = await this.harness.commit(async (tx) => {
      const doc = (await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId))) as unknown as FactoryRunData;
      if (!doc.workflow || doc.pr.number !== pr || !canReconcileClosureMerge(doc)) return false;
      doc.issueClosureMerge = { head: facts.headSha, commit: facts.mergeCommit ?? "", at: Date.now() };
      // Commit the resolution first: a crash before the stop is safe, and late task writes honor this observation.
      completeClosureMerge(doc, Date.now());
      return true;
    }, context);
    if (changed && live) await this.harness.abortTask(live.taskId, context);
    return changed;
  }

  /** Abort a workflow run that has not finished. Records why first, so the run says so. Does not wait for the task to end. */
  async abortFactoryRun(runId: string, reason: string): Promise<"marked" | "terminal"> {
    const live = (await this.liveFactoryRuns()).find((run) => run.runId === runId);
    if (!live) return "terminal";
    const marked = await this.harness.commit(async (tx) => {
      const doc = (await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId))) as unknown as FactoryRunData;
      // Intake's snapshot can predate a merge or an operator's pending stop. Neither may be overwritten by closure.
      if (reason.startsWith("issue_closed:") && (isTerminalRun(doc.status) || hasRecordedMerge(doc)
        || (doc.abortReason && !doc.abortReason.startsWith("issue_closed:")))) return false;
      doc.reason = reason;
      doc.abortReason = reason;
      return true;
    }, context);
    return marked ? this.harness.abortTask(live.taskId, context) : "terminal";
  }

  async deliveryState(requestId: string): Promise<DeliveryRecord | undefined> {
    const record = await this.harness.snapshot(DeliveryFamily, requestId, context);
    return record && record.updatedAt > 0 ? { ...record } : undefined;
  }

  /** Update one delivery record. The record is created (as `intended`) on first use. */
  async recordDelivery(requestId: string, threadKey: string, change: Partial<Omit<DeliveryRecord, "requestId" | "threadKey">>): Promise<DeliveryRecord> {
    return this.harness.commit(async (tx) => {
      const record = await tx.doc(DeliveryFamily, requestId, emptyDelivery(requestId, threadKey));
      // Delivered is terminal: a late or repeated write must never move it backwards.
      if (record.state !== "delivered") Object.assign(record, change);
      else if (change.state === "delivered") Object.assign(record, change);
      record.updatedAt = Date.now();
      return { ...record } as DeliveryRecord;
    }, context);
  }

  /** Deliveries that were started but never completed, oldest first (for post-restart reconciliation). */
  async pendingDeliveries(): Promise<DeliveryRecord[]> {
    const out: DeliveryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: "slack.delivery" }, 200, cursor, context,
      );
      for (const record of page.items) {
        if (!record.key) continue;
        const value = await this.harness.snapshot(DeliveryFamily, record.key, context);
        if (value && value.state !== "delivered" && value.updatedAt > 0) out.push({ ...value });
      }
      cursor = page.next;
    } while (cursor);
    return out.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  /**
   * What became of a request, without waiting: answered (with the text), failed, still pending, or unknown.
   * Used to deliver an answer that was committed but never reached Slack before a crash.
   */
  async requestOutcome(threadKey: string, requestId: string): Promise<
    { status: "answered"; text: string } | { status: "failed"; reason: string } | { status: "pending" } | undefined
  > {
    const conversationId = await this.threadId(threadKey);
    if (!conversationId) return undefined;
    const record = await this.storage.submissionByRequest(conversationId, requestId, context);
    if (!record || record.type !== "input") return undefined;
    const receipt = await this.harness.snapshot(RequestDoc, conversationId, requestId, context);
    if (receipt?.steeringIds?.length) {
      let latest: Awaited<ReturnType<DurableChannelStore["requestOutcome"]>>;
      for (const child of receipt.steeringIds) {
        latest = await this.requestOutcome(threadKey, child);
        if (!latest || latest.status !== "answered") return latest ?? { status: "pending" };
      }
      return latest;
    }
    if (record.status === "done") {
      const answer = await this.harness.commit((tx) => tx.entry(record.answer), context);
      return {
        status: "answered",
        text: (answer?.model ?? []).flatMap((message) => message.role === "assistant"
          ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []) : []).join(""),
      };
    }
    if (record.status === "queued" || record.status === "placed") return { status: "pending" };
    return { status: "failed", reason: "reason" in record && record.reason ? String(record.reason) : record.status };
  }

  /** Wait for an admitted request to settle (e.g. one resumed after a restart) and return its answer text. */
  async awaitRequest(conversationId: ConversationId, requestId: string): Promise<{ text: string } | { failed: string }> {
    await this.checkLive();
    const receipt = await this.harness.snapshot(RequestDoc, conversationId, requestId, context);
    if (receipt?.steeringIds?.length) {
      let latest: { text: string } | { failed: string } = { failed: "no steering answer" };
      for (const child of receipt.steeringIds) {
        latest = await this.awaitRequest(conversationId, child);
        if ("failed" in latest) return latest;
      }
      return latest;
    }
    const record = await this.storage.submissionByRequest(conversationId, requestId, context);
    const submission = record ? await this.harness.submission(record.id, context) : undefined;
    if (!submission) return { failed: "the request is no longer pending" };
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.type !== "input") {
      return { failed: settled.status === "unanswered" ? settled.reason : settled.status };
    }
    const answer = await this.harness.commit((tx) => tx.entry(settled.answer), context);
    return {
      text: (answer?.model ?? []).flatMap((message) => message.role === "assistant"
        ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []) : []).join(""),
    };
  }

  /** The unsettled requests of a conversation and who sent each (the speaker a recovered turn runs as). */
  async liveRequests(conversationId: ConversationId): Promise<{ requestId: string; userId: string; steeringUserId?: string }[]> {
    const inspection = await this.harness.inspect(context);
    const out: { requestId: string; userId: string; steeringUserId?: string }[] = [];
    for (const submission of inspection.submissions) {
      if (submission.conversationId !== conversationId || submission.type !== "input" || !submission.requestId) continue;
      const receipt = await this.harness.snapshot(RequestDoc, conversationId, submission.requestId, context);
      const parent = receipt?.steeringFor ? await this.harness.snapshot(RequestDoc, conversationId, receipt.steeringFor, context) : undefined;
      out.push({ requestId: receipt?.steeringFor ?? submission.requestId, userId: parent?.userId ?? receipt?.userId ?? "",
        ...(receipt?.steeringFor ? { steeringUserId: receipt.userId } : {}) });
    }
    return out;
  }

  /** Record what the recovery gate refused to resume. Replaces the list; empty clears it. */
  async setBlocked(items: readonly BlockedRecovery[]): Promise<void> {
    await this.harness.commit(async (tx) => { (await tx.doc(HostDoc)).blocked = items.map((item) => ({ ...item })); }, context);
  }

  async blocked(): Promise<BlockedRecovery[]> {
    return [...((await this.harness.snapshot(HostDoc, context))?.blocked ?? [])];
  }

  /**
   * Abort the in-flight work of these conversations. Aborting asks for progress, so this is only for use
   * once every other live conversation has been validated (the recovery gate guarantees that).
   */
  async abortConversations(ids: readonly ConversationId[]): Promise<void> {
    for (const id of ids) await (await this.harness.conversation(id, context))?.abort(context);
  }

  /**
   * Operator decision: give up on everything interrupted in this channel and clear the block. All or
   * nothing, because aborting one conversation would start the scheduler for the others.
   */
  async discardInterrupted(): Promise<number> {
    const ids = (await this.liveRoutes()).map((entry) => entry.conversationId);
    // The block stays until every abort has landed, so nothing new can be admitted in the meantime.
    await this.abortConversations(ids);
    await this.setBlocked([]);
    return ids.length;
  }

  /** Conversations with live work, with the Slack thread each belongs to (for the recovery gate). */
  async liveRoutes(): Promise<{ conversationId: ConversationId; route: ThreadRoute }[]> {
    const inspection = await this.harness.inspect(context);
    // A job run is owned by the main conversation but is not that conversation's work: it has no Slack thread or speaker, so
    // reporting `main` as busy would make the recovery gate pause the channel. Jobs have their own step (`liveJobs`).
    const ids = [...new Set(inspection.tasks.filter((task) => !isBackgroundTaskKind(task.record.kind)).map((task) => task.record.conversationId))];
    const out: { conversationId: ConversationId; route: ThreadRoute }[] = [];
    for (const id of ids) {
      const route = await this.harness.snapshot(RouteDoc, id, context);
      out.push({ conversationId: id, route: route ? { kind: route.kind, threadKey: route.threadKey } : { kind: "thread", threadKey: "" } });
    }
    return out;
  }

  async waitForIdle(): Promise<void> {
    await this.checkLive();
    await this.harness.waitForIdle(context);
  }

  inspect(): Promise<HarnessInspection> { return this.harness.inspect(context); }

  /** A cancelled wait is not an abort. Caller must use abort() to cancel the run. */
  async wait(submission: Submission, waitContext: Context = context) {
    await this.checkLive();
    const settled = await submission.wait(waitContext);
    if (settled.status !== "done" || settled.type !== "input") {
      throw new Error(`Durable input unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
    }
    const answer = await this.harness.commit((tx) => tx.entry(settled.answer), context);
    const text = (answer?.model ?? []).flatMap((message) => message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []) : []).join("");
    return { settled, text };
  }

  /** Close preserves pending work, unlike abort. Release owner lock only after tasks stop. */
  async close(): Promise<void> {
    try {
      await this.harness.close(context);
    } finally {
      // A store that failed cannot close cleanly, but its directory lock must still be released or no replacement
      // could ever open it.
      try { this.owner.close(); } catch { /* already closed */ }
    }
  }
}
