import { randomUUID } from "node:crypto";
import { awaitWithContext } from "@earendil-works/chord/context";
import { defineDocFamily, defineTask, type Task } from "@earendil-works/pi-durable";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { SUBAGENT_RUN_PREFIX, type DurableChannelStore } from "./durable/channel-store.ts";
import type { SubagentParent, SubagentRunnerDeps } from "./subagents.ts";
import type { SubagentReport, SubagentRunRequest } from "./subagent-tools.ts";
import type { TimelineSink } from "./timeline.ts";

/**
 * A subagent run started by a durable task, with no live turn above it. This is a spike: it proves the mechanism the software
 * factory workflow (docs/FACTORY_WORKFLOW_DESIGN.md) needs, in the smallest task that exercises it. The real engine replaces the
 * task and keeps the rest.
 *
 * The mechanism:
 *  - A task has no turn, thread or watcher, so its runs get a synthetic parent (`headlessParent`): its own key, the channel's
 *    timeline, no progress sink. Nothing in it can reach a person; the runner never took anything else from a parent.
 *  - The task phase reaches the runner through deps, as a job phase reaches `exec`. The channel's runtime builds them when the
 *    store opens (`ChannelRuntimes` takes a `SubagentHost`), so the store, its bindings and the tool builder are the channel's own.
 *  - A run is two commits. `started` (with the run's key) is committed before the run begins and the report after. Finding
 *    `started` on entry means the run was cut off by a restart, which the recovery gate abandons rather than resumes: a stage that
 *    is safe to repeat (a read-only role) is run again under a new key, any other is reported as interrupted and not repeated.
 */

export type StageStatus = "pending" | "started" | "done" | "failed" | "interrupted";

export type StageRunData = {
  runId: string;
  agent: string;
  brief: string;
  userId: string;
  /** May the task run the role again by itself after a restart cut it off? True for read-only roles. */
  replaySafe: boolean;
  status: StageStatus;
  /** The run in progress, or the last one that was. */
  runKey: string;
  /** Runs started so far, including ones that were cut off. */
  attempts: number;
  /** Runs a restart cut off, oldest first. */
  interruptedRunKeys: string[];
  /** The report's fields; empty until there is one. */
  reportStatus: string;
  reportNext: string;
  reportSummary: string;
  reason: string;
  startedAt: number;
  endedAt: number;
};

export const emptyStageRun = (runId: string): StageRunData => ({
  runId, agent: "", brief: "", userId: "", replaySafe: false, status: "pending", runKey: "", attempts: 0, interruptedRunKeys: [],
  reportStatus: "", reportNext: "", reportSummary: "", reason: "", startedAt: 0, endedAt: 0,
});

export const StageRunFamily = defineDocFamily<StageRunData, StageRunData>({
  kind: "slack.spike-subagent-run", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});

export const SPIKE_SUBAGENT_TASK_KIND = "slack.run.spike-subagent";

/** What a stage needs from its channel. Resolved when the phase runs, so a store reopened on new config uses the new rules. */
export interface StageDeps {
  run(runId: string, request: SubagentRunRequest): Promise<SubagentReport>;
}

/** What the app supplies once, and every channel's runtime builds its `StageDeps` from. */
export interface SubagentHost {
  /** The parent a run in `channel` is started under. A task passes its run id, so every stage of one run shares a thread key and sandbox. */
  parent(channel: ResolvedChannel, runId: string): SubagentParent;
  /** Injected to avoid an import cycle with the session module, as the runner's own is. */
  buildToolSet: SubagentRunnerDeps["buildToolSet"];
}

export function headlessParent(
  channel: ResolvedChannel,
  runId: string,
  opts: { harnessName: string; botUserId: string; defaultTimezone?: string; timeline?: TimelineSink; onViolation?: (msg: string) => void; onSubagentMessage?: SubagentParent["onSubagentMessage"] },
): SubagentParent {
  return {
    channel,
    threadKey: `${SUBAGENT_RUN_PREFIX}parent-${runId}`,
    harnessName: opts.harnessName,
    slackChannelLabel: channel.ref.name ? `#${channel.ref.name}` : channel.ref.id,
    botUserId: opts.botUserId,
    defaultTimezone: opts.defaultTimezone ?? "UTC",
    ...(opts.timeline ? { timeline: opts.timeline } : {}),
    ...(opts.onViolation ? { onViolation: opts.onViolation } : {}),
    ...(opts.onSubagentMessage ? { onSubagentMessage: opts.onSubagentMessage } : {}),
  };
}

export type StageTaskInput = { runId: string };
export type StageTaskState = { phase: "run"; started: boolean };
export type StageTaskResult = { status: "done" | "failed" | "interrupted" };
export type StageTask = Task<StageTaskInput, StageTaskState, StageTaskResult, object>;

const summaryOf = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 500 ? flat : `${flat.slice(0, 499)}…`;
};

export function makeSubagentStageTask(getDeps: () => StageDeps | undefined): StageTask {
  type Runtime = Parameters<Parameters<typeof defineTask<StageTaskInput, StageTaskState, StageTaskResult>>[0]["phases"]["run"]>[1];
  type Context = Parameters<Parameters<typeof defineTask<StageTaskInput, StageTaskState, StageTaskResult>>[0]["phases"]["run"]>[2];

  const finish = (runtime: Runtime, context: Context, runId: string, status: StageTaskResult["status"], change: (doc: StageRunData) => void) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(StageRunFamily, runId, emptyStageRun(runId));
      const now = runtime.now();
      change(doc as unknown as StageRunData);
      doc.endedAt = now;
      return { status: "terminal", outcome: { status: "completed", result: { status } } } as const;
    }, context);

  return defineTask<StageTaskInput, StageTaskState, StageTaskResult>({
    name: SPIKE_SUBAGENT_TASK_KIND,
    version: 1,
    initial: () => ({ phase: "run", started: false }),
    phases: {
      run: async (task, runtime, context) => {
        const { runId } = task.input;
        const record = await runtime.snapshot(StageRunFamily, runId, context);
        if (!record || !record.agent) return finish(runtime, context, runId, "failed", (doc) => { doc.status = "failed"; doc.reason = "the run's record is missing"; });
        const deps = getDeps();
        if (!deps) return finish(runtime, context, runId, "failed", (doc) => { doc.status = "failed"; doc.reason = "subagent runs are not available in this channel's store"; });

        if (task.state.checkpoint.started && !record.replaySafe) {
          // Entered with "started" already committed: the role may have acted and its report was lost. Not run again on its own.
          return finish(runtime, context, runId, "interrupted", (doc) => {
            doc.status = "interrupted";
            doc.interruptedRunKeys.push(doc.runKey);
            doc.reason = `The run ${doc.runKey} was cut off by a restart, so it may or may not have taken effect.`;
          });
        }

        const runKey = `${SUBAGENT_RUN_PREFIX}${randomUUID()}`;
        // Intent first, with the key: everything after this commit can be lost to a crash, this cannot.
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(StageRunFamily, runId, emptyStageRun(runId));
          if (task.state.checkpoint.started) doc.interruptedRunKeys.push(doc.runKey);
          doc.status = "started";
          doc.runKey = runKey;
          doc.attempts += 1;
          doc.startedAt = doc.startedAt || runtime.now();
          return { status: "running", checkpoint: { phase: "run", started: true } } as const;
        }, context);

        let report: SubagentReport | undefined;
        let failure: string | undefined;
        try {
          report = await deps.run(runId, { agent: record.agent, task: record.brief, userId: record.userId, runKey, signal: runtime.signal });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        // The store is closing or the task was aborted while the run was going: leave "started" in place, so the next entry
        // reports the interruption instead of recording a result that never was.
        if (runtime.signal.aborted) await awaitWithContext(new Promise<never>(() => {}), context);

        await finish(runtime, context, runId, !report || report.status === "failed" ? "failed" : "done", (doc) => {
          doc.status = !report || report.status === "failed" ? "failed" : "done";
          if (report) {
            doc.reportStatus = report.status;
            doc.reportNext = report.next ?? "";
            doc.reportSummary = summaryOf(report.summary);
          }
          if (failure) doc.reason = summaryOf(failure);
        });
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(StageRunFamily, task.input.runId, emptyStageRun(task.input.runId));
        if (doc.agent) { doc.status = "failed"; doc.reason = doc.reason || "aborted"; doc.endedAt = runtime.now(); }
        return { status: "terminal", outcome: { status: "aborted", reason: "aborted" } } as const;
      }, context);
    },
  });
}

/** Start a stage run in the channel's store. The record and the task are created in one commit. */
export async function startSubagentStage(
  store: Pick<DurableChannelStore, "startRunTask">,
  input: { agent: string; brief: string; userId: string; replaySafe: boolean },
): Promise<{ runId: string }> {
  const runId = `stage_${randomUUID().slice(0, 10)}`;
  await store.startRunTask(SPIKE_SUBAGENT_TASK_KIND, { runId } satisfies StageTaskInput, async (tx) => {
    const doc = await tx.doc(StageRunFamily, runId, emptyStageRun(runId));
    Object.assign(doc, input, { startedAt: Date.now() });
  });
  return { runId };
}

/** A stage run's record, or undefined. A copy. */
export async function stageRun(store: Pick<DurableChannelStore, "runDoc">, runId: string): Promise<StageRunData | undefined> {
  const doc = (await store.runDoc(StageRunFamily, runId)) as StageRunData | undefined;
  return doc && doc.agent ? (JSON.parse(JSON.stringify(doc)) as StageRunData) : undefined;
}
