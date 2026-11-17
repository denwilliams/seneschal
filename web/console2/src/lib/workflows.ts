import type { WorkflowActionName, IntakeLabelsView, IntakeRepoView, IntakeStatus, WorkflowAnswer, WorkflowAttemptStatus, WorkflowRecovery, WorkflowRunStatus, WorkflowRunSummary, WorkflowRunView, WorkflowStageStatus, WorkflowUpdateView, WorkflowWaitKind } from "@api/api-types";
import type { Tone } from "./jobs";

type MergeRule = NonNullable<WorkflowRunView["mergeRule"]>;

export const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  running: "Running",
  waiting: "Waiting for a person",
  needs_decision: "Needs a decision",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
  aborted: "Aborted",
};

export const STAGE_STATUS_LABEL: Record<WorkflowStageStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  success: "Success",
  failed: "Failed",
  skipped: "Skipped",
};

export const ATTEMPT_STATUS_LABEL: Record<WorkflowAttemptStatus, string> = {
  in_progress: "Running",
  done: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
};

/** A run that needs a decision because a stage failed says so; any other run is its status. */
export function runStatusLabel(run: { status: WorkflowRunStatus; waiting?: { kind: WorkflowWaitKind }; kind?: "factory" | "task" }): string {
  if (run.kind === "task" && run.status === "running") return "Active — see activity";
  if (run.kind === "task" && run.status === "waiting") return "Awaiting parent review";
  return run.status === "needs_decision" && run.waiting?.kind === "failed" ? "Stage failed" : RUN_STATUS_LABEL[run.status];
}

/** A rejected run reached a valid outcome (the pipeline decided not to proceed), so it is not drawn as an error. */
export function runTone(status: WorkflowRunStatus): Tone {
  return status === "running" ? "info" : status === "waiting" || status === "needs_decision" ? "warn" : status === "completed" ? "ok" : status === "failed" ? "bad" : "muted";
}

export const STAGE_TONE_CLASS: Record<WorkflowStageStatus, string> = {
  not_started: "text-muted-foreground",
  in_progress: "text-sky-600 dark:text-sky-300",
  success: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  skipped: "text-muted-foreground",
};

/** A stage's pip, for screen readers and tooltips: the stage and its status in words, so colour is never the only signal. */
export const pipLabel = (stage: { name: string; status: WorkflowStageStatus }): string => `${stage.name}: ${STAGE_STATUS_LABEL[stage.status].toLowerCase()}`;

/** Guidance follows the actual action list, not just the global console switch. */
export function waitingLine(kind: WorkflowWaitKind, actions?: readonly WorkflowActionName[]): string {
  const how = actions?.length ? "See the available actions below, answer in the run's Slack thread, or tell the channel agent." : "This console is read-only: answer in the run's Slack thread, or tell the channel agent.";
  switch (kind) {
    case "merge": return `Waiting for an approver to approve or decline the merge. Review approval is not merge authorization. ${actions?.includes("approve") && actions.includes("decline") ? "Use Approve merge or Decline merge below, or use the run's Slack post." : actions?.length ? "Console merge decisions require Slack approver verification; see availability below. You can also use the run's Slack post." : how}`;
    case "deploy": return `Waiting for an approver to allow the deploy. Deploy authorization is available in Slack, not in this console. ${how}`;
    case "rounds": return `Review is out of rounds. A person can allow another round or stop the run in Slack, not in this console. ${how}`;
    case "decide": return `A stage was interrupted by a restart and may already have had effects. A person decides to retry, skip or abort. ${how}`;
    case "failed": return `A stage failed and the run is waiting, not over: it keeps its pull request, risk and history. Fix the cause (a token, a label, the role's setup, more detail on the issue), then a person decides what to do: Retry and Abort are buttons on the run's Slack post. ${how}`;
    case "info": return "Triage asked a question on the issue. A comment there from someone who may add to it (an owner, member or collaborator) carries the run on; with no answer it is rejected as stale.";
  }
}

const ANSWER_LABEL: Record<WorkflowAnswer, string> = { retry: "Retry", skip: "Skip", restart_from: "Restart from", abort: "Abort" };

/** "implement failed · attempt 2", or "review failed · attempt 1 · run ended". */
export const recoveryHeadline = (recovery: Pick<WorkflowRecovery, "stage" | "attempt" | "ended">): string =>
  `${recovery.stage} failed · attempt ${recovery.attempt}${recovery.ended ? " · run ended" : ""}`;

/** What can be done about the failed stage, one line per answer, in words. The console only says; the decision is made elsewhere. */
export function recoveryChoices(recovery: WorkflowRecovery): { answer: WorkflowAnswer; label: string; text: string }[] {
  const text: Record<WorkflowAnswer, string> = {
    retry: recovery.ended
      ? `Carries the run on from ${recovery.stage}, as attempt ${recovery.attempt + 1}, on the same record.`
      : `Runs ${recovery.stage} again as attempt ${recovery.attempt + 1}, after the cause is fixed. Nothing the run knows is cleared.`,
    skip: `Moves on without ${recovery.stage}. Only an optional stage can be skipped.`,
    restart_from: `Goes back to ${recovery.restartFrom.join(", ")} when the earlier work has to change. Later stages start again; every attempt stays on the record.`,
    abort: "Ends the run. What it already did on GitHub stays there.",
  };
  return recovery.answers.map((answer) => ({ answer, label: ANSWER_LABEL[answer], text: text[answer] }));
}

/** The reviewer's verdict is a code-review outcome, never a person authorizing a merge. */
export function verdictLabel(stage: Pick<WorkflowRunView["stages"][number], "name" | "role">, verdict: string): string {
  return verdict === "approved" && (stage.name === "review" || stage.role === "reviewer") ? "Review approved" : verdict.replaceAll("_", " ");
}

/** How the run began. Only intake and Slack-filed runs are worth saying: a run someone started by hand is the ordinary case. */
export const ORIGIN_LABEL: Record<"intake" | "manual" | "slack", string> = { intake: "Found by intake", manual: "Started by a person", slack: "Filed from Slack" };

/** "3 updates (1 not trusted)", or nothing when the run has had none. */
export function updatesLabel(updates: { trusted: number; untrusted: number }): string | undefined {
  const total = updates.trusted + updates.untrusted;
  if (total === 0) return undefined;
  return `${total} ${total === 1 ? "update" : "updates"}${updates.untrusted > 0 ? ` (${updates.untrusted} not trusted)` : ""}`;
}

/** What an update was, in a few words. */
export const UPDATE_KIND_LABEL: Record<WorkflowUpdateView["kind"], string> = { comment: "Comment", labels: "Labels", edited: "Edited", reopened: "Reopened", slack: "Answered in Slack", console: "Answered in the console" };

/** Trusted updates are what a role is shown; the others are recorded and shown here, and only here. */
export const updateTrustLabel = (update: Pick<WorkflowUpdateView, "trusted">): string => (update.trusted ? "Trusted: a role saw this" : "Not trusted: no role saw this");

// ── Issue intake ───────────────────────────────────────────────────────────────────────────────────────

export const INTAKE_STATUS_LABEL: Record<IntakeStatus, string> = { open: "Mapped to a run", queued: "Queued", held: "Held", ignored: "Ignored", closed: "Closed" };

/** Why each state exists, for the people reading the block. */
export const INTAKE_STATUS_HINT: Record<IntakeStatus, string> = {
  open: "has a run",
  queued: "waits for a free slot",
  held: "its author is not trusted: add the go label on GitHub, or ask the channel agent to release it",
  ignored: "not for the factory",
  closed: "closed on GitHub",
};

/** "6 open · 2 held · 1 queued", in the order people act on them, leaving out what is zero. */
export function intakeCountsLine(counts: IntakeRepoView["counts"]): string {
  const order: IntakeStatus[] = ["held", "queued", "open", "ignored", "closed"];
  const words: Record<IntakeStatus, string> = { held: "held", queued: "queued", open: "mapped", ignored: "ignored", closed: "closed" };
  const parts = order.filter((status) => (counts[status] ?? 0) > 0).map((status) => `${counts[status]} ${words[status]}`);
  return parts.length ? parts.join(" · ") : "nothing mapped yet";
}

/** "Risk 3", or "Risk 3 → 4" when the merge gate raised the reviewer's score, or "Not scored". */
export function riskLabel(risk: { scored: boolean; model?: number; final?: number }): string {
  if (!risk.scored || risk.model === undefined) return "Not scored";
  return risk.final !== undefined && risk.final !== risk.model ? `Risk ${risk.model} → ${risk.final}` : `Risk ${risk.model}`;
}

/** The score the merge gate used, else the reviewer's. */
export const effectiveRisk = (risk: { scored: boolean; model?: number; final?: number }): number | undefined => (risk.scored ? (risk.final ?? risk.model) : undefined);

export function riskTone(score: number | undefined): Tone {
  return score === undefined ? "muted" : score <= 2 ? "ok" : score === 3 ? "warn" : "bad";
}

export function describeMergeRule(rule: MergeRule): string {
  const auto = rule.autoMergeMaxRisk > 0 ? `may merge automatically at risk ${rule.autoMergeMaxRisk} or lower only when required checks and all other gates pass` : "never merges by itself";
  const who = rule.approvers.count === undefined ? "anyone in the channel may approve"
    : `${rule.approvers.count} ${rule.approvers.count === 1 ? "approver" : "approvers"} (${rule.approvers.source === "factory" ? "set on the factory" : "the channel's allowed users"})`;
  return `${auto}, ${rule.method}; ${who}`;
}

/** How long the run has taken: to its end, or to now while it is live. */
export function elapsedMs(run: Pick<WorkflowRunSummary, "startedAt" | "endedAt">, now: number): number | undefined {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

/** `repo#7`. */
export const issueRef = (run: Pick<WorkflowRunSummary, "repo" | "issue" | "kind" | "workItem">): string => run.kind === "task" ? "Task workflow" : run.workItem?.key ?? `${run.repo}#${run.issue}`;

/** Ticket links are limited to the pinned Jira Cloud site; PR links still use safeGithubUrl. */
export function safeWorkItemUrl(run: Pick<WorkflowRunSummary, "issueUrl" | "workItem">): string | undefined {
  if (!run.workItem) return undefined;
  try {
    const url = new URL(run.issueUrl ?? "");
    if (url.protocol === "https:" && /^[a-zA-Z0-9-]+\.atlassian\.net$/.test(run.workItem.site) && url.hostname === run.workItem.site && !url.username && !url.password && url.pathname === `/browse/${run.workItem.key}`) return url.href;
  } catch { /* untrusted malformed URL */ }
  return undefined;
}

/** The sub-agent's conversation in the tree. A hash link, so following it closes the sheet by leaving the `run` param behind. */
export const subagentHref = (channelId: string, runKey: string): string => `#/c/${encodeURIComponent(channelId)}/t/${encodeURIComponent(runKey)}`;

/** A stage entered more than once shows which time each attempt was. */
export const attemptTitle = (entry: number, entries: number): string => (entries > 1 ? `Attempt ${entry} of ${entries}` : "Attempt");

/** What the last check of the factory's GitHub labels found, in words. The time is added by the caller. */
export function labelsText(labels: IntakeLabelsView): string {
  if (labels.status === "failed") return `Labels could not be checked${labels.error ? `: ${labels.error}` : ""}.`;
  if (labels.status === "created") return `Labels: created ${labels.created.join(", ")}.`;
  return "Labels: all there.";
}
