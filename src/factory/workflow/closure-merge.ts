import { isTerminalRun, type FactoryRunData } from "./docs.ts";
import { findStage } from "./transitions.ts";

/** Durable merge evidence, not merely a decision to try merging. Post-merge deployment waits must be left alone. */
export function hasRecordedMerge(run: FactoryRunData): boolean {
  return Boolean(run.pr.mergeCommit || run.issueClosureMerge || run.current === "deploy" || findStage(run, "merge")?.status === "success");
}

/** Only closure cancellations (not an operator's abort), failed or live pre-merge runs can be reconciled. */
export function canReconcileClosureMerge(run: FactoryRunData): boolean {
  // abortFactoryRun persists intent before the task stops: a still-live explicit cancellation is already authoritative.
  return run.pr.number > 0 && !hasRecordedMerge(run)
    && (!run.abortReason || run.abortReason.startsWith("issue_closed:"))
    && (!isTerminalRun(run.status) || run.status === "failed"
      || (run.status === "aborted" && (run.abortReason || run.reason).startsWith("issue_closed:")));
}

/**
 * Record an observed merge, never authorize or perform one. The durable observation wins over a late stage report or abort.
 * This ends pre-merge work without following the deploy arrow; review, risk and approval records are left untouched.
 */
export function completeClosureMerge(run: FactoryRunData, now: number): void {
  const observed = run.issueClosureMerge;
  if (!observed) return;
  const merge = findStage(run, "merge");
  if (run.status === "completed" && merge?.attempts.at(-1)?.verdict === "merged") return;
  for (const stage of run.stages) {
    for (const attempt of stage.attempts) if (attempt.status === "in_progress") {
      attempt.status = "interrupted";
      attempt.endedAt = now;
      attempt.durationMs = Math.max(0, now - attempt.startedAt);
      attempt.summary = "superseded by the PR merge observed during issue closure";
    }
    if (stage.status === "in_progress" || (stage.name === "deploy" && stage.status === "not_started")) stage.status = "skipped";
  }
  if (merge) {
    merge.entries++;
    merge.status = "success";
    merge.attempts.push({
      entry: merge.entries, role: "", runKey: "", status: "done", verdict: "merged",
      summary: `PR #${run.pr.number} merged on GitHub; reconciled on issue closure (no deployment)`,
      report: `Observed head: ${observed.head}\nMerge commit: ${observed.commit || "not supplied by GitHub"}`,
      reask: false, startedAt: observed.at, endedAt: now, durationMs: 0, costUsd: 0, steps: 0,
    });
  }
  run.pr.mergeCommit = observed.commit;
  run.current = "merge";
  run.status = "completed";
  run.reason = `Issue resolved by merged PR #${run.pr.number}; reconciled without deployment.`;
  run.abortReason = "";
  run.wait = { kind: "", since: 0 };
  run.guard = { from: "", target: "" };
  run.updatedAt = now;
  run.endedAt = now;
}
