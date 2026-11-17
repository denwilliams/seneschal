import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyFactoryRun, emptyStage } from "./docs.ts";
import { canReconcileClosureMerge, completeClosureMerge } from "./closure-merge.ts";

const runWithPr = () => {
  const run = emptyFactoryRun("fr_test");
  run.pr.number = 205;
  run.current = "merge";
  run.stages = [emptyStage("review"), emptyStage("merge"), emptyStage("deploy")];
  return run;
};

test("reconciliation appends successful merge evidence, preserves failed history and never grants approval", () => {
  const run = runWithPr();
  run.status = "aborted";
  run.abortReason = "issue_closed: closed on GitHub";
  run.wait = { kind: "failed", since: 1 };
  const merge = run.stages[1]!;
  merge.status = "failed";
  merge.entries = 2;
  merge.attempts = [{ entry: 1, role: "", runKey: "", status: "failed", verdict: "conflicts", summary: "old conflict", report: "evidence", reask: false, startedAt: 1, endedAt: 2, durationMs: 1, costUsd: 0, steps: 0 }];
  const before = structuredClone(merge.attempts);
  const gate = structuredClone(run.gate);
  const risk = structuredClone(run.risk);
  assert.equal(canReconcileClosureMerge(run), true);
  run.issueClosureMerge = { head: "h".repeat(40), commit: "c".repeat(40), at: 10 };
  completeClosureMerge(run, 12);
  assert.deepEqual(merge.attempts.slice(0, -1), before);
  assert.deepEqual([run.status, run.current, merge.status, merge.attempts.at(-1)?.verdict], ["completed", "merge", "success", "merged"]);
  assert.deepEqual([run.gate, run.risk, run.deployApprovedBy], [gate, risk, ""]);
  assert.deepEqual([run.stages[0]!.status, run.stages[2]!.status], ["not_started", "skipped"]);
  assert.match(run.reason, /without deployment/);
  assert.equal(run.pr.mergeCommit, "c".repeat(40));
  const completed = structuredClone(run);
  completeClosureMerge(run, 20);
  assert.deepEqual(run, completed, "repeated reconciliation does not append attempts or move timestamps");
});

test("only live, failed or issue-closure-aborted pre-merge runs qualify, not operator cancellations or post-merge work", () => {
  for (const status of ["running", "waiting", "needs_decision", "failed", "aborted", "completed", "rejected"] as const) {
    const run = runWithPr();
    run.status = status;
    assert.equal(canReconcileClosureMerge(run), !["aborted", "completed", "rejected"].includes(status), status);
  }
  for (const status of ["running", "waiting", "needs_decision", "failed", "aborted"] as const) {
    const pending = runWithPr();
    pending.status = status;
    pending.reason = "issue_closed: older reason";
    pending.abortReason = "aborted by UADMIN";
    assert.equal(canReconcileClosureMerge(pending), false, `explicit cancellation while ${status}`);
    pending.abortReason = "issue_closed: closed on GitHub";
    assert.equal(canReconcileClosureMerge(pending), true, `closure cancellation while ${status}`);
  }
  const run = runWithPr();
  run.status = "aborted";
  run.abortReason = "aborted by UADMIN";
  run.reason = "issue_closed: older reason";
  assert.equal(canReconcileClosureMerge(run), false);
  run.abortReason = "issue_closed: closed on GitHub";
  assert.equal(canReconcileClosureMerge(run), true);
  run.pr.mergeCommit = "known";
  assert.equal(canReconcileClosureMerge(run), false);
  run.pr.mergeCommit = "";
  run.current = "deploy";
  assert.equal(canReconcileClosureMerge(run), false);
});
