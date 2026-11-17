import { defineDocFamily } from "@earendil-works/pi-durable";

/**
 * What a workflow run leaves in the channel's store, as documents, so the console, the Slack status post and the agent's tools
 * can read a run without touching the task machinery. The task's own checkpoint holds only where it is; everything a person
 * wants to see is here. Documents hold plain JSON, so absent values are empty strings or -1, never `undefined`. Nothing here is a
 * tool's arguments or results: a role's report is kept bounded, because the next stage's brief is built from it.
 */

export type StageStatus = "not_started" | "in_progress" | "success" | "failed" | "skipped";
export type FactoryRunStatus = "running" | "waiting" | "needs_decision" | "completed" | "rejected" | "failed" | "aborted";
export type AttemptStatus = "in_progress" | "done" | "failed" | "interrupted";

/** What a run is parked on while its status is `waiting` or `needs_decision`. `decide`: a stage was interrupted by a restart. `failed`: a stage failed. */
export type WaitKind = "" | "merge" | "deploy" | "rounds" | "decide" | "failed" | "info";

export type FactoryStarter = { source: "agent" | "operator" | "intake"; threadKey: string; userId: string };

/** Where the run’s work item lives; GitHub remains the code host. */
export type IssueSourceName = "github" | "jira";
/** How the run began: found by the intake poll, started by a person's tool call, or from an issue the agent filed in a Slack conversation. */
export type RunOrigin = "intake" | "manual" | "slack";

/** What changed on the run's issue after it started, as a bounded entry. Written by the intake poll, read into briefs only when `trusted`. */
export type UpdateKind = "comment" | "labels" | "edited" | "reopened" | "slack" | "console";
export type RunUpdate = {
  kind: UpdateKind;
  /** The GitHub login that did it; for a `slack` answer, `slack:` and the Slack user id. */
  author: string;
  /** GitHub's `author_association` for the author, or "" when it is not known. */
  association: string;
  /** Owner, member or collaborator of the repository, or the harness itself: the only updates a role is shown. */
  trusted: boolean;
  /** Written from the harness's own GitHub account but not by the harness: a person using the token's account. Absent on older updates. */
  viaToken?: boolean;
  /** About 1000 characters of what was said or what changed. Untrusted text: it is never an instruction. */
  excerpt: string;
  at: number;
  /**
   * When the harness recorded it, when that was not about when it happened: a comment found by a re-read of the issue is old, but news
   * to a run that was never told. A run takes it in as new once (docs/FACTORY_WORKFLOW_DESIGN.md section 22). Absent on older updates.
   */
  seen?: number;
};
/** The most updates kept on a run. */
export const MAX_RUN_UPDATES = 20;
export const UPDATE_EXCERPT_CHARS = 1000;

/** One run of a role for a stage. A stage has several when the run loops back to it, or when a report had to be asked for again. */
export type Attempt = {
  /** Which time the run entered this stage (the round, for a stage that loops). */
  entry: number;
  role: string;
  runKey: string;
  status: AttemptStatus;
  /** The verdict the report gave, or "" while there is none. */
  verdict: string;
  /** A short account, for lists. */
  summary: string;
  /** The role's whole report, bounded: the next stage's brief is built from it. */
  report: string;
  /** This attempt was a second ask for a report that was missing something. */
  reask: boolean;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  costUsd: number;
  steps: number;
};

export type StageRun = {
  name: string;
  status: StageStatus;
  /** How many times the run has entered this stage. */
  entries: number;
  /** Rounds a person allowed beyond the stage's `maxEntries`. */
  extraEntries: number;
  attempts: Attempt[];
};

export type RunRisk = {
  /** What the reviewer scored, or -1 before review. 5 when it did not score. */
  model: number;
  scored: boolean;
  reason: string;
  /** The score the merge gate used: the reviewer's, raised by any floor. -1 before the gate. */
  final: number;
  /** Why the final score is above the reviewer's, if it is. */
  floors: string[];
};

/** The merge gate's bookkeeping, so a restart in the middle of a merge finishes it rather than deciding again. */
export type RunGate = {
  /** The decision is made: merge now. */
  decided: boolean;
  /** Who allowed it: a user id, or "auto" when the rules did. */
  by: string;
  /** The commit it was decided for. */
  head: string;
  at: number;
};

/**
 * Where the run shows in Slack: the status post (the root of the run's thread) and what has already been said in that thread, so a
 * restart or a repeated change never posts the same thing twice. Written by the Slack presence, never by the task. A document from
 * before this existed has none: `factoryRun()` fills it in.
 */
export type RunSlack = {
  channel: string;
  /** The status post's timestamp: also the thread's key. Empty until it is posted. */
  ts: string;
  /** How many status posts this run has had (more than one when a post was deleted). */
  posts: number;
  /** Keys of the thread replies already posted, oldest first, bounded. */
  events: string[];
  /** A decision made from a button, until the task has acted on it: which wait it answered, who, what. */
  decision: { kind: string; since: number; by: string; at: number };
};

export const emptyRunSlack = (): RunSlack => ({ channel: "", ts: "", posts: 0, events: [], decision: { kind: "", since: 0, by: "", at: 0 } });

/** The most reply keys kept on a run. A run has a few dozen moments at most; this only stops a runaway. */
export const MAX_RUN_SLACK_EVENTS = 200;

export type FactoryRunData = {
  runId: string;
  workflow: string;
  /** Hash of the workflow definition this run started with. A run is pinned to it. */
  hash: string;
  /** That definition, as JSON. */
  definition: string;
  repo: string;
  issue: number;
  issueTitle: string;
  issueUrl: string;
  /** Absent on existing GitHub runs; Jira's numeric ID is internal, key is for people. */
  workItem?: import("./source.ts").WorkItem;
  /** A durable tracker effect is pending; retry synchronizes it, never repeats the completed stage. */
  trackerPending?: boolean;
  /** Anything the person said that the stages should know, bounded. */
  notes: string;
  by: FactoryStarter;
  /** Where the issue lives, and how the run began. A document from before intake has neither: `factoryRun()` fills them in. */
  source: IssueSourceName;
  origin: RunOrigin;
  /** Why intake (or a person) was allowed to start it: author_association, harness_filed, go_label, released, manual. */
  trust: string;
  /** What changed on the issue since the run started, oldest first. */
  updates: RunUpdate[];
  /**
   * Triage was told to stop asking and go on with stated assumptions, because nobody answered within `factory.intake.assumeAfterHours`.
   * Once, per run. Absent (read as false) on a run from before it existed.
   */
  assumed?: boolean;
  /** Why someone aborted the run, written the moment they ask. The task's own writes never touch it, so a stage starting just after cannot lose it. */
  abortReason: string;
  /** GitHub's observed merge on issue closure. Durable reconciliation, not review/merge/deploy authorization. */
  issueClosureMerge?: { head: string; commit: string; at: number };
  status: FactoryRunStatus;
  /** Why the run is waiting, was rejected, or failed. */
  reason: string;
  /** The stage the run is at (the one it was at when it ended). */
  current: string;
  wait: { kind: WaitKind; since: number };
  /** Set when a loop was held back by a stage's `maxEntries`: the stage that is out of rounds, and where the run was going. */
  guard: { from: string; target: string };
  stages: StageRun[];
  pr: { number: number; url: string; /** The head commit when review began. */ reviewedHead: string; mergeCommit: string };
  risk: RunRisk;
  gate: RunGate;
  /** Who approved the deploy (or the merge, for a role that needs no separate approval). */
  deployApprovedBy: string;
  startedAt: number;
  updatedAt: number;
  endedAt: number;
  costUsd: number;
  slack: RunSlack;
};

export const emptyStage = (name: string): StageRun => ({ name, status: "not_started", entries: 0, extraEntries: 0, attempts: [] });

export const emptyFactoryRun = (runId: string): FactoryRunData => ({
  runId, workflow: "", hash: "", definition: "{}", repo: "", issue: 0, issueTitle: "", issueUrl: "", notes: "",
  by: { source: "agent", threadKey: "", userId: "" }, source: "github", origin: "manual", trust: "", updates: [], abortReason: "",
  status: "running", reason: "", current: "", wait: { kind: "", since: 0 }, guard: { from: "", target: "" },
  stages: [], pr: { number: 0, url: "", reviewedHead: "", mergeCommit: "" },
  risk: { model: -1, scored: false, reason: "", final: -1, floors: [] }, gate: { decided: false, by: "", head: "", at: 0 },
  deployApprovedBy: "", startedAt: 0, updatedAt: 0, endedAt: 0, costUsd: 0, slack: emptyRunSlack(),
});

/** One run per key (its id). Session-scoped, like the state object and job runs: it belongs to the channel's store. */
export const FactoryRunFamily = defineDocFamily<FactoryRunData, FactoryRunData>({
  kind: "slack.factory-run", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});

export type FactoryDecisionKind = "" | "approve" | "decline" | "request_changes" | "more_rounds" | "stop" | "retry" | "skip" | "restart_from" | "abort";

export type FactoryDecisionData = {
  decision: FactoryDecisionKind;
  at: number;
  /** The Slack user who decided. */
  by: string;
  /** For an approval: the commit the person saw. An approval of any other commit is not one. */
  head: string;
  /** For `restart_from`: the earlier stage to go back to. A document written before it existed has none (read it as ""). */
  stage: string;
  /** Human merge-gate feedback, bound to the exact wait. Absent on older decisions. */
  feedback?: string;
  since?: number;
};

/** What someone decided about a run that is waiting or needs a decision. Written from outside the task, consumed when acted on. */
export const FactoryDecisionFamily = defineDocFamily<FactoryDecisionData, FactoryDecisionData>({
  kind: "slack.factory-decision", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});
export const emptyFactoryDecision = (): FactoryDecisionData => ({ decision: "", at: 0, by: "", head: "", stage: "" });

/** The task kind of a factory run. It starts with the store's background-run prefix, so recovery treats it like a job. */
export const FACTORY_TASK_KIND = "slack.run.factory";

/** Which decisions answer which wait. */
export const DECISIONS_FOR: Record<Exclude<WaitKind, "">, readonly FactoryDecisionKind[]> = {
  merge: ["approve", "decline", "request_changes"],
  deploy: ["approve", "decline"],
  rounds: ["more_rounds", "stop"],
  decide: ["retry", "skip", "abort"],
  /** A stage failed (it did not finish, or its report was unusable, or GitHub refused): fix the cause and retry it, go back, skip an optional one, or stop. */
  failed: ["retry", "skip", "restart_from", "abort"],
  /** A run waiting for information is answered by a trusted update on the issue, not by a decision. */
  info: [],
};

/**
 * Who a decision made from the web console is recorded as. It is not a Slack user id (those start with U or W), so nobody can speak
 * as it. The console may only answer a stage that failed or was interrupted; the merge, deploy and rounds decisions stay with the
 * approvers in Slack, and the task ignores a console decision that tries one.
 */
export const CONSOLE_ACTOR = "console";
export const CONSOLE_DECISIONS: readonly FactoryDecisionKind[] = ["retry", "skip", "restart_from", "abort"];

/** The most a run's live count may be, per channel. */
export const MAX_LIVE_FACTORY_RUNS = 3;

export const isTerminalRun = (status: FactoryRunStatus): boolean => status === "completed" || status === "rejected" || status === "failed" || status === "aborted";

/** A run that has left its first stage: it is no longer only being triaged. Intake runs get a status post from here on. */
export const hasLeftFirstStage = (run: Pick<FactoryRunData, "stages">): boolean => run.stages.slice(1).some((stage) => stage.status !== "not_started");
