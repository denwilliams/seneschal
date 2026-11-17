import type { ConversationId } from "@earendil-works/pi-durable";
import type { BlockedRecovery } from "./durable/channel-store.ts";
import type { ChannelRuntime } from "./channel-runtime.ts";
import { logger } from "../util/log.ts";
import { JobDefinitionSchema, type JobDefinition } from "../jobs/definition.ts";
import type { FactoryRunData } from "../factory/workflow/docs.ts";

/**
 * The recovery gate.
 *
 * After a restart the Durable scheduler could resume every conversation that had unfinished work, and
 * a resumed turn runs tools. Nothing may run until each one has been re-established under the
 * CURRENT rules: the thread still exists and is still allowed, its original speaker may still use the
 * channel, and its tools rebuild from today's configuration and grants (a revoked permission or removed
 * connector simply is not there). Any doubt leaves the whole channel paused with the reason recorded
 * for an operator, because upstream progress starts all ready work in a store, not just the safe part.
 *
 * Interrupted effects are never repeated: the store marks them unsafe, so the next model turn is told
 * the call was interrupted rather than replaying it.
 *
 * Job runs are not conversations' work and have their own step, which runs before the scheduler resumes (resuming starts
 * every ready task in the store, jobs included, so a run must be validated first). A run whose job is no longer permitted
 * in this channel, or whose record cannot be read, is aborted with the reason; the rest resume. A run that was in the
 * middle of an effect does not repeat it either way: it waits for a person (see jobs/task.ts).
 */

export interface RecoveryDeps {
  /** True for work that is abandoned, not resumed, when interrupted (scheduled runs, dreams). */
  isEphemeral(threadKey: string): boolean;
  /** Whether this speaker may still use the channel. */
  speakerAllowed(userId: string): boolean;
  /** Why a live job run may not carry on under today's configuration (a permission removed, a command gone), or undefined. */
  jobProblem?(definition: JobDefinition): string | undefined;
  /** Why a live workflow run may not carry on under today's configuration (the factory removed, a role unassigned, a repository dropped), or undefined. */
  factoryProblem?(run: FactoryRunData): string | undefined;
  /** Rebuild and bind the thread's tools from current configuration; throw to refuse. */
  bind(input: { threadKey: string; conversationId: ConversationId; userId: string }): Promise<{ dispose(): Promise<void> }>;
}

export interface RecoveryOutcome {
  /** The scheduler was started. False whenever anything is blocked. */
  resumed: boolean;
  recovered: string[];
  /** The requests that were resumed, so their answers can be delivered to Slack when they finish. */
  requests: { conversationId: ConversationId; threadKey: string; requestId: string }[];
  abandoned: string[];
  blocked: BlockedRecovery[];
  /** Job runs that were live: the ones that carry on, and the ones aborted because they are no longer permitted. */
  jobs: { resumed: string[]; aborted: { runId: string; reason: string }[] };
  /** The same for software factory workflow runs. */
  factoryRuns: { resumed: string[]; aborted: { runId: string; reason: string }[] };
}

export async function recoverChannel(runtime: ChannelRuntime, deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const { store } = runtime;
  const outcome: RecoveryOutcome = { resumed: false, recovered: [], requests: [], abandoned: [], blocked: [], jobs: { resumed: [], aborted: [] }, factoryRuns: { resumed: [], aborted: [] } };
  const now = Date.now();
  const block = (conversationId: ConversationId, threadKey: string, reason: string) => {
    outcome.blocked.push({ conversationId, threadKey, reason, since: now });
    logger.warn(`recovery blocked in ${runtime.channel.ref.id} thread ${threadKey || "?"}: ${reason}`);
  };

  const ephemeral: ConversationId[] = [];
  for (const { conversationId, route } of await store.liveRoutes()) {
    const threadKey = route.threadKey;
    if (!threadKey) { block(conversationId, threadKey, "the conversation has no recorded Slack thread"); continue; }
    if (deps.isEphemeral(threadKey)) {
      // Not aborted yet: aborting asks for progress, which would start every other ready task unvalidated.
      ephemeral.push(conversationId);
      outcome.abandoned.push(threadKey);
      continue;
    }
    const live = await store.liveRequests(conversationId);
    const speakers = [...new Set(live.map((request) => request.userId))];
    if (speakers.length === 0 || speakers.some((id) => !id)) { block(conversationId, threadKey, "no recorded speaker for the interrupted request"); continue; }
    if (speakers.length > 1) { block(conversationId, threadKey, `interrupted requests from several people (${speakers.length}); tools cannot be bound to one speaker`); continue; }
    const speaker = speakers[0]!;
    if (live.some((request) => request.steeringUserId && !deps.speakerAllowed(request.steeringUserId))) { block(conversationId, threadKey, "a steering author is no longer allowed in this channel"); continue; }
    // Legacy cross-author steering cannot safely resume with the original owner's
    // approval/credential principal, even when both people may use this channel.
    if (live.some((request) => request.steeringUserId && request.steeringUserId !== speaker)) { block(conversationId, threadKey, "cross-author steering cannot resume under another speaker's tool authority"); continue; }
    if (!deps.speakerAllowed(speaker)) { block(conversationId, threadKey, `speaker ${speaker} is no longer allowed in this channel`); continue; }
    try {
      const bound = await deps.bind({ threadKey, conversationId, userId: speaker });
      runtime.disposers.push(bound.dispose);
      outcome.recovered.push(threadKey);
      for (const requestId of new Set(live.map((request) => request.requestId))) outcome.requests.push({ conversationId, threadKey, requestId });
    } catch (error) {
      block(conversationId, threadKey, `could not rebuild tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Jobs, before anything is resumed. Aborting only marks a run; its abort handler runs once the scheduler starts.
  for (const job of await store.liveJobs()) {
    const run = await store.jobRun(job.runId);
    let definition: JobDefinition | undefined;
    try {
      const parsed = run ? JobDefinitionSchema.safeParse(JSON.parse(run.definition)) : undefined;
      definition = parsed?.success ? parsed.data : undefined;
    } catch { /* unreadable: handled below */ }
    const problem = !run || !definition ? "its record or pinned definition is missing or unreadable" : deps.jobProblem?.(definition);
    if (problem) {
      const reason = `no longer permitted after the restart: ${problem}`;
      await store.abortJob(job.runId, reason);
      outcome.jobs.aborted.push({ runId: job.runId, reason });
      logger.warn(`recovery in ${runtime.channel.ref.id}: job run ${job.runId} aborted (${reason})`);
    } else {
      outcome.jobs.resumed.push(job.runId);
    }
  }

  // Workflow runs, the same way: before anything is resumed, under the rules as they are now. A run whose factory is gone or
  // whose pinned record cannot be read is aborted with the reason; the rest resume, and a stage that was in the middle of an
  // effect waits for a person (see factory/workflow/task.ts).
  for (const live of await store.liveFactoryRuns()) {
    const run = await store.factoryRun(live.runId);
    const problem = !run ? "its record is missing or unreadable" : deps.factoryProblem?.(run);
    if (problem) {
      const reason = `no longer permitted after the restart: ${problem}`;
      await store.abortFactoryRun(live.runId, reason);
      outcome.factoryRuns.aborted.push({ runId: live.runId, reason });
      logger.warn(`recovery in ${runtime.channel.ref.id}: workflow run ${live.runId} aborted (${reason})`);
    } else {
      outcome.factoryRuns.resumed.push(live.runId);
    }
  }

  await store.setBlocked(outcome.blocked);
  if (outcome.blocked.length > 0) return outcome;
  try {
    // Models of every live conversation and every pinned checkpoint, before anything is allowed to run.
    await store.assertRunnable();
    // Interrupted scheduled runs and dreams are abandoned (they fire again on schedule); the rest resumes.
    await store.abortConversations(ephemeral);
    await store.resume();
    outcome.resumed = true;
  } catch (error) {
    // e.g. a model that is no longer allowed: stay paused and say why.
    const reason = `resume refused: ${error instanceof Error ? error.message : String(error)}`;
    outcome.abandoned.length = 0;
    for (const { conversationId, route } of await store.liveRoutes()) block(conversationId, route.threadKey, reason);
    await store.setBlocked(outcome.blocked);
  }
  return outcome;
}
