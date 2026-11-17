import type { SubagentReport, SubagentRunRequest } from "../../agent/subagent-tools.ts";
import type { ChecksFacts, PrFacts, ResolvedMergeRules } from "./merge.ts";
import type { FactoryLabels } from "./labels.ts";
import type { IssueSource } from "./source.ts";

export interface IssueFacts { number: number; title: string; url: string; state: "open" | "closed"; workItem?: import("./source.ts").WorkItem; selection?: import("./source.ts").SourceIssue["selection"] }
import type { FactoryRunData } from "./docs.ts";

/** What the engine asks of GitHub. Behind an interface so tests use a faux one and the engine never shells out itself. */
export interface FactoryGitHub {
  /** Selected work tracker. Absent on legacy/test GitHub backends. */
  tracker?: import("./tracker.ts").WorkTracker;
  /** The issues side of intake: what changed, comments, who the harness is. Absent in a test double that does not poll. */
  source?: IssueSource;
  /** The factory's labels on GitHub: which exist, and creating the missing. Absent in a test double that does not keep labels. */
  labels?: FactoryLabels;
  /** The issue a run is about, or undefined when the repository has no such issue. */
  readIssue(repo: string, number: number): Promise<IssueFacts | undefined>;
  /** File a new issue. The title and body are already bounded and sanitised by the service; `labels` come from configuration only. */
  createIssue(input: { repo: string; title: string; body: string; labels: readonly string[] }): Promise<IssueFacts>;
  /** Comment on an issue. The body is already bounded, sanitised and carries the agent footer; it is sent on stdin, never as an argument. */
  commentIssue(input: { repo: string; number: number; body: string }): Promise<void>;
  readPr(repo: string, number: number): Promise<PrFacts>;
  readChecks(repo: string, number: number): Promise<ChecksFacts>;
  /**
   * Merge the pull request, only if its head is still `expectedHead` (GitHub itself refuses otherwise). Idempotent: a pull
   * request that is already merged is not an error, it is the answer.
   */
  mergePr(input: { repo: string; number: number; method: "squash" | "merge" | "rebase"; expectedHead: string }): Promise<{ mergeCommit: string }>;
  /** Resolves on merge, closure, confirmed conflicts or a changed expected head. Stops when aborted. */
  untilSettled(input: { repo: string; number: number; signal: AbortSignal; expectedHead?: string }): Promise<PrFacts>;
}

/** What a workflow run needs from its channel. Resolved when a step runs, so a store reopened on new config uses the new rules. */
export interface FactoryDeps {
  /** Run a stage's role as a sub-agent with no live turn above it. Reports may carry the run's cost and duration. */
  runStage(runId: string, request: SubagentRunRequest): Promise<SubagentReport>;
  /** Is a sub-agent for this role assigned to the channel? An optional stage whose role is not is skipped. */
  hasRole(role: string): boolean;
  /** Does the role run only with a person's approval (a deployer)? The run then waits for one. */
  roleNeedsApproval(role: string): boolean;
  rules(repo: string): ResolvedMergeRules;
  /** The channel's allowed users, which approve when the factory names no approvers. Undefined: no list is configured. */
  allowUsers(): readonly string[] | undefined;
  /** How long a run waits for an answer to a question (`factory.intake.needsInfoDays`). Absent: 14 days. */
  needsInfoMs?(): number;
  /** After how long with no answer triage is told to stop asking and go on with stated assumptions (`factory.intake.assumeAfterHours`, or the repository's autonomy level). 0 or absent: never. */
  assumeAfterMs?(repo: string): number;
  /** How many times the engine tries a failed stage again on its own before a person is asked (`factory.autoRetries`, or the repository's autonomy level). 0 or absent: none. */
  autoRetries?(repo: string): number;
  github: FactoryGitHub;
  /** A role was cut off by a restart: say so on the timeline, where the runner recorded it as cancelled. */
  interrupted(input: { runId: string; runKey: string; role: string }): void;
  /** The record of what the engine did on its own (a merge, automatic or on a person's approval). Best effort. */
  audit?(event: string, fields: Record<string, unknown>): void;
  /** Told after a run's state changes. Best effort: a failure here never affects the run. */
  onChange?(run: FactoryRunData): void;
}
