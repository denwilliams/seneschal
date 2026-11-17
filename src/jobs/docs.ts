import { defineDocFamily } from "@earendil-works/pi-durable";

/**
 * What a job run leaves in the channel's store, as documents, so the console and the agent's tools can read a run without
 * touching the task machinery. The task's own checkpoint holds only where it is (`index`, `started`); everything a person
 * wants to see is here. Documents hold plain JSON, so absent values are empty strings or -1, never `undefined`.
 */

export type JobRunStatus = "running" | "needs_decision" | "completed" | "failed" | "aborted";
export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type JobStarter = { source: "agent" | "operator"; threadKey: string; userId: string };

export type PhaseRun = {
  name: string;
  kind: "exec" | "state";
  status: PhaseStatus;
  startedAt: number;
  endedAt: number;
  /** Exit code of an exec phase; -1 when there is none. */
  exit: number;
  /** A short account of what happened, bounded. */
  summary: string;
};

export type JobRunData = {
  runId: string;
  job: string;
  /** SHA-256 of the definition this run started with. A run is pinned to it: editing config mid-run changes nothing. */
  hash: string;
  /** The definition this run started with, as JSON. */
  definition: string;
  input: Record<string, string>;
  by: JobStarter;
  status: JobRunStatus;
  /** The phase the run is at, or `phases.length` once every phase is done. */
  index: number;
  phases: PhaseRun[];
  /** What earlier exec phases produced, for `${phases.name.result}`. */
  results: Record<string, { result: string; exit: number }>;
  startedAt: number;
  updatedAt: number;
  endedAt: number;
  /** Why the run failed, was aborted, or is waiting. */
  reason: string;
};

export const emptyRun = (runId: string): JobRunData => ({
  runId, job: "", hash: "", definition: "{}", input: {}, by: { source: "agent", threadKey: "", userId: "" }, status: "running",
  index: 0, phases: [], results: {}, startedAt: 0, updatedAt: 0, endedAt: 0, reason: "",
});

/** One run per key (its id). Session-scoped, like the state object: it belongs to the channel's store. */
export const JobRunFamily = defineDocFamily<JobRunData, JobRunData>({
  kind: "slack.job-run", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});

export type JobDecisionData = { decision: "" | "retry" | "skip" | "abort"; at: number; by: string };

/** What someone decided about a run that stopped because a phase was interrupted. Written from outside the task. */
export const JobDecisionFamily = defineDocFamily<JobDecisionData, JobDecisionData>({
  kind: "slack.job-decision", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});
export const emptyDecision = (): JobDecisionData => ({ decision: "", at: 0, by: "" });

/** The task kind of a job run. `liveRoutes` and the recovery gate recognise jobs by this prefix. */
export const JOB_TASK_KIND = "slack.job";
export const isJobTaskKind = (kind: string): boolean => kind === JOB_TASK_KIND || kind.startsWith(`${JOB_TASK_KIND}.`);
