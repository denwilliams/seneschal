import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { hashDefinition, JobInputError, resolveInputs, type JobDefinition } from "./definition.ts";
import type { JobRunData, JobStarter } from "./docs.ts";
import { jobProblem } from "./policy.ts";

/** The part of the channel's store the service uses. The real one is `DurableChannelStore`. */
export interface JobStore {
  startJob(input: { name: string; definition: JobDefinition; hash: string; input: Record<string, string>; by: JobStarter }): Promise<{ runId: string }>;
  jobRun(runId: string): Promise<JobRunData | undefined>;
  listJobRuns(limit?: number): Promise<JobRunData[]>;
  decideJob(runId: string, decision: "retry" | "skip" | "abort", by: string): Promise<void>;
  abortJob(runId: string, reason: string): Promise<"marked" | "terminal">;
}

export interface JobSummary {
  name: string;
  description?: string;
  inputs: { name: string; required: boolean; default?: string; description?: string; maxLength: number }[];
  phases: { name: string; kind: string }[];
  /** False when the channel's current permissions would refuse it; `problem` says why. */
  available: boolean;
  problem?: string;
}

export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

export interface JobService {
  list(): JobSummary[];
  start(name: string, input: Record<string, unknown> | undefined): Promise<{ runId: string }>;
  check(runId?: string): Promise<JobRunData[]>;
  decide(runId: string, decision: "retry" | "skip" | "abort"): Promise<void>;
  abort(runId: string): Promise<void>;
}

export interface JobServiceContext {
  channel: ResolvedChannel;
  /** Resolved when used: the store does not exist until after the tools are built. Absent fails closed. */
  store: () => JobStore | undefined;
  threadKey: string;
  currentUserId: () => string;
  source?: "agent" | "operator";
  /** Where the record of who started, decided and aborted what goes. Defaults to the shared audit directory. */
  auditFile?: string;
}

export function createJobService(ctx: JobServiceContext): JobService {
  const { channel } = ctx;
  const store = (): JobStore => {
    const found = ctx.store();
    if (!found) throw new JobError("Jobs are not available in this session.");
    return found;
  };
  const audit = (event: string, fields: Record<string, unknown>) => {
    try {
      const file = ctx.auditFile ?? join(channel.shared.audit, "jobs.jsonl");
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), channelId: channel.ref.id, event, threadKey: ctx.threadKey, userId: ctx.currentUserId(), ...fields })}\n`);
    } catch { /* an audit line that cannot be written must not stop a job, but it is not silent in the log */ }
  };
  const lookup = (name: string): JobDefinition => {
    const found = channel.jobs[name];
    if (!found) {
      const names = Object.keys(channel.jobs);
      throw new JobError(`There is no job "${name}" in this channel.${names.length ? ` Its jobs are ${names.map((n) => `"${n}"`).join(", ")}.` : " It has no jobs."}`);
    }
    return found;
  };

  return {
    list() {
      return Object.entries(channel.jobs ?? {}).map(([name, definition]) => {
        const problem = jobProblem(definition, channel);
        return {
          name, ...(definition.description ? { description: definition.description } : {}),
          inputs: Object.entries(definition.input).map(([key, param]) => ({
            name: key, required: param.default === undefined, maxLength: param.maxLength,
            ...(param.default !== undefined ? { default: param.default } : {}), ...(param.description ? { description: param.description } : {}),
          })),
          phases: definition.phases.map((phase) => ({ name: phase.name, kind: phase.kind })),
          available: problem === undefined, ...(problem ? { problem } : {}),
        };
      });
    },

    async start(name, given) {
      const definition = lookup(name);
      const problem = jobProblem(definition, channel);
      if (problem) throw new JobError(`"${name}" cannot run in this channel right now: ${problem}`);
      let input: Record<string, string>;
      try {
        input = resolveInputs(definition, given);
      } catch (error) {
        if (error instanceof JobInputError) throw new JobError(error.message);
        throw error;
      }
      const hash = hashDefinition(definition);
      const by: JobStarter = { source: ctx.source ?? "agent", threadKey: ctx.threadKey, userId: ctx.currentUserId() };
      const { runId } = await store().startJob({ name, definition, hash, input, by });
      audit("start", { runId, job: name, hash });
      return { runId };
    },

    async check(runId) {
      if (runId) {
        const run = await store().jobRun(runId);
        if (!run) throw new JobError(`There is no run ${runId}.`);
        return [run];
      }
      return store().listJobRuns(10);
    },

    async decide(runId, decision) {
      await store().decideJob(runId, decision, ctx.currentUserId());
      audit("decide", { runId, decision });
    },

    async abort(runId) {
      const run = await store().jobRun(runId);
      if (!run) throw new JobError(`There is no run ${runId}.`);
      const outcome = await store().abortJob(runId, `aborted by ${ctx.currentUserId() || "someone"}`);
      if (outcome === "terminal") throw new JobError(`Run ${runId} has already finished (${run.status}).`);
      audit("abort", { runId, job: run.job });
    },
  };
}
