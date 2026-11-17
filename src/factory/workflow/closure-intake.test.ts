import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FakeSource, fixture, openProcess, reach, REPO, reply, respond, stageOf, until, type Fixture, type Process } from "./test-support.ts";
import { OVERLAP_MS, pollIntake } from "./intake.ts";
import { createFactoryRunService } from "./service.ts";
import { stageLine } from "../../slack/factory-render.ts";
import type { FactoryRunData } from "./docs.ts";

const MIN = 60_000;
const INTAKE = { enabled: true } as const;
function harness(f: Fixture, p: Process) {
  const source = f.github.source as FakeSource;
  const clock = { t: Date.now() };
  const changes: FactoryRunData[] = [];
  const service = createFactoryRunService({ channel: f.channel, store: () => p.store, github: () => f.github, threadKey: "", currentUserId: () => "", source: "operator" });
  const poll = () => pollIntake({
    channelId: "C1", repositories: f.channel.factory!.repositories, settings: f.channel.factory!.intake!, store: p.store, source, github: f.github,
    start: async (request) => { await service.startFromIntake(request); }, now: () => clock.t, audit: () => {},
    onRunChange: (run) => { changes.push(run); },
  });
  const entry = async (n: number) => (await p.store.factoryIntake(REPO)).entries[String(n)];
  const runs = () => p.store.listFactoryRuns(100);
  return { source, clock, poll, entry, runs, changes };
}
async function baseline(h: ReturnType<typeof harness>) {
  await h.poll();
  h.clock.t += 10 * MIN;
}

const MERGED_COMMIT = "c".repeat(40);
const toMerge = () => [respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 2))];

/** A live run parked on an old gate failure, with a PR and all its review evidence still present. */
async function failedMerge(f: Fixture, p: Process, h: ReturnType<typeof harness>, issue = 7) {
  f.github.mergeError = "branch protection refused the merge";
  f.faux.setResponses(toMerge());
  h.source.put(issue, { at: h.clock.t });
  await h.poll();
  const run = (await h.runs()).find((r) => r.issue === issue)!;
  return reach(p, run.runId, ["needs_decision"], "failed");
}

function closeIssue(h: ReturnType<typeof harness>, issue = 7) {
  h.clock.t += MIN;
  h.source.put(issue, { state: "closed", at: h.clock.t });
}

function observeMerged(f: Fixture) {
  // Do not resolve the merge gate's own waiter: exercise intake winning the race.
  f.github.pr = { ...f.github.pr, state: "merged", mergeCommit: MERGED_COMMIT };
}

test("closure reconciles an already merged PR over a failed gate, stops its task, and does not deploy or merge again", async (t) => {
  const f = fixture(t, { intake: INTAKE, deployer: true, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  assert.equal(before.current, "merge");
  const reviews = structuredClone(stageOf(before, "review"));
  const live = (await p.store.liveFactoryRuns()).find((task) => task.runId === before.runId)!;
  observeMerged(f);
  closeIssue(h);
  assert.equal((await h.poll()).failed, false);
  const run = await reach(p, before.runId, ["completed"]);
  await until(async () => (await p.store.liveFactoryRuns()).length === 0 || undefined, "reconciled task to end");
  const durable = (p.store as unknown as { harness: Harness }).harness;
  assert.equal((await durable.waitForTask(live.taskId, BACKGROUND_CONTEXT)).state.outcome.status, "completed", "task outcome agrees with the reconciled run/card");
  assert.equal(run.pr.mergeCommit, MERGED_COMMIT);
  assert.deepEqual([run.current, stageOf(run, "merge").status, stageOf(run, "deploy").status], ["merge", "success", "skipped"]);
  assert.equal(stageOf(run, "merge").attempts.at(-1)!.verdict, "merged");
  assert.deepEqual(stageOf(run, "review"), reviews, "reconciliation is not a new review");
  assert.deepEqual([run.gate, run.deployApprovedBy, f.github.merges.length], [before.gate, "", 0]);
  assert.equal(f.footers.length, 3, "no deployer or extra review/coder runs");
  assert.equal((await h.entry(7))!.reason, "closed; its associated PR merged");
  assert.match(stageLine(run.stages), /✅ merge/);
  assert.doesNotMatch(stageLine(run.stages), /❌ merge/);
  const attempts = stageOf(run, "merge").attempts.length;
  await h.poll();
  assert.equal(stageOf((await p.store.factoryRun(run.runId))!, "merge").attempts.length, attempts);
  await p.close();
  const restarted = await openProcess(f);
  assert.equal((await restarted.store.factoryRun(run.runId))!.status, "completed");
  assert.equal(f.footers.length, 3, "restart never follows the deploy arrow");
});

test("close first cancels unresolved work, then a later merge repairs the retained closed run even without a new issue event", async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  closeIssue(h);
  await h.poll();
  const cancelled = await reach(p, before.runId, ["aborted"]);
  assert.match(cancelled.reason, /^issue_closed:/);
  assert.equal(cancelled.pr.mergeCommit, "");
  observeMerged(f);
  // Move past the issue-list overlap: only the retained closed-mapping sweep can find this merge.
  h.clock.t += OVERLAP_MS + MIN;
  await h.poll();
  const run = await reach(p, before.runId, ["completed"]);
  assert.equal(run.pr.mergeCommit, MERGED_COMMIT);
  assert.equal(stageOf(run, "merge").status, "success");
  assert.deepEqual(h.changes.map((run) => [run.runId, run.status]), [[before.runId, "completed"]], "the old cancellation's card is refreshed even though its task already ended");
  assert.equal(f.github.merges.length, 0);
});

test("a PR read failure defers closure without cancelling; a subsequent verified merge reconciles it", async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  closeIssue(h);
  f.github.readPrError = "HTTP 503";
  assert.equal((await h.poll()).failed, true);
  assert.equal((await h.entry(7))!.status, "open");
  assert.equal((await p.store.factoryRun(before.runId))!.status, "needs_decision");
  f.github.readPrError = undefined;
  observeMerged(f);
  await h.poll();
  assert.equal((await reach(p, before.runId, ["completed"])).pr.mergeCommit, MERGED_COMMIT);
});

test("independent runs sharing a PR reconcile separately, preserving each review and reading the PR once per poll", async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const first = await failedMerge(f, p, h, 7);
  const second = await failedMerge(f, p, h, 8);
  assert.equal(first.pr.number, second.pr.number);
  let reads = 0;
  const read = f.github.readPr.bind(f.github);
  f.github.readPr = async () => { reads++; return read(); };
  observeMerged(f);
  closeIssue(h, 7);
  closeIssue(h, 8);
  await h.poll();
  assert.equal(reads, 1);
  for (const before of [first, second]) {
    const run = await reach(p, before.runId, ["completed"]);
    assert.equal(run.pr.mergeCommit, MERGED_COMMIT);
    assert.deepEqual(stageOf(run, "review"), stageOf(before, "review"));
  }
  assert.equal(f.github.merges.length, 0);
});

test("intake winning the merge notification race records success without running the configured deployer", async (t) => {
  const f = fixture(t, { intake: INTAKE, deployer: true });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  f.faux.setResponses(toMerge());
  h.source.put(7, { at: h.clock.t });
  await h.poll();
  const before = (await h.runs())[0]!;
  await reach(p, before.runId, ["waiting"], "merge");
  observeMerged(f);
  closeIssue(h);
  await h.poll();
  const run = await reach(p, before.runId, ["completed"]);
  assert.deepEqual([run.gate.decided, run.deployApprovedBy, stageOf(run, "deploy").status], [false, "", "skipped"]);
  assert.equal(f.footers.length, 3);
  assert.equal(f.github.merges.length, 0);
});

test("merge notification winning the closure race leaves the deployment approval wait untouched", async (t) => {
  const f = fixture(t, { intake: INTAKE, deployer: true });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  f.faux.setResponses(toMerge());
  h.source.put(7, { at: h.clock.t });
  await h.poll();
  const before = (await h.runs())[0]!;
  await reach(p, before.runId, ["waiting"], "merge");
  f.github.settle("merged");
  const deploy = await reach(p, before.runId, ["waiting"], "deploy");
  closeIssue(h);
  await h.poll();
  const run = (await p.store.factoryRun(before.runId))!;
  assert.deepEqual([run.status, run.wait, run.current], [deploy.status, deploy.wait, "deploy"]);
  assert.equal(run.issueClosureMerge, undefined);
  assert.equal(await p.store.abortFactoryRun(run.runId, "issue_closed: stale poll snapshot"), "terminal");
  assert.equal((await p.store.factoryRun(run.runId))!.wait.kind, "deploy", "atomic cancellation guard protects post-merge work");
  assert.equal(f.footers.length, 3, "deployer still needs approval");
  await p.store.abortFactoryRun(run.runId, "test over");
});

for (const state of ["open", "closed"] as const) test(`closure with a ${state} unmerged PR is cancellation, not successful resolution`, async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  f.github.pr.state = state;
  closeIssue(h);
  await h.poll();
  const run = await reach(p, before.runId, ["aborted"]);
  assert.match(run.reason, /^issue_closed:/);
  assert.equal(run.issueClosureMerge, undefined);
  assert.equal(stageOf(run, "merge").status, "failed");
});

test("a later merge never rewrites an explicit operator cancellation", async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  await p.store.abortFactoryRun(before.runId, "aborted by UADMIN");
  await reach(p, before.runId, ["aborted"]);
  observeMerged(f);
  closeIssue(h);
  await h.poll();
  const run = (await p.store.factoryRun(before.runId))!;
  assert.deepEqual([run.status, run.reason, run.issueClosureMerge], ["aborted", "aborted by UADMIN", undefined]);
});

/** Hold the first stop after abortFactoryRun has durably recorded its reason, not after the task is already aborted. */
async function pendingOperatorAbort(p: Process, runId: string) {
  const durable = (p.store as unknown as { harness: Harness }).harness;
  const abort = durable.abortTask;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const stopping = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  durable.abortTask = async (...args) => {
    if (first) {
      first = false;
      entered();
      await held;
    }
    return abort.apply(durable, args);
  };
  const requested = p.store.abortFactoryRun(runId, "aborted by UADMIN");
  await stopping;
  return async () => {
    durable.abortTask = abort;
    release();
    await requested;
  };
}

function assertOperatorCancellation(run: FactoryRunData, status: string) {
  assert.deepEqual([run.status, run.abortReason, run.issueClosureMerge, run.pr.mergeCommit], [status, "aborted by UADMIN", undefined, ""]);
  assert.equal(run.reason, "aborted by UADMIN");
  assert.equal(stageOf(run, "merge").status, "failed");
}

for (const state of ["merged", "open", "closed"] as const) test(`closure with a ${state} PR preserves an operator cancellation while its stop is delayed`, async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  const live = (await p.store.liveFactoryRuns()).find((run) => run.runId === before.runId)!;
  const finishStop = await pendingOperatorAbort(p, before.runId);
  try {
    f.github.pr.state = state;
    closeIssue(h);
    await h.poll();
    assertOperatorCancellation((await p.store.factoryRun(before.runId))!, "needs_decision");
  } finally { await finishStop(); }
  assertOperatorCancellation(await reach(p, before.runId, ["aborted"]), "aborted");
  const durable = (p.store as unknown as { harness: Harness }).harness;
  assert.equal((await durable.waitForTask(live.taskId, BACKGROUND_CONTEXT)).state.outcome.status, "aborted");
  observeMerged(f);
  h.clock.t += OVERLAP_MS + MIN;
  await h.poll();
  assertOperatorCancellation((await p.store.factoryRun(before.runId))!, "aborted");
  assert.equal(h.changes.length, 0);
});

for (const state of ["merged", "open"] as const) test(`transaction guard preserves an operator cancellation recorded during a ${state} PR read`, async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  f.github.pr.state = state;
  const read = f.github.readPr.bind(f.github);
  let finishStop: (() => Promise<void>) | undefined;
  f.github.readPr = async (...args) => {
    const facts = await read(...args);
    finishStop = await pendingOperatorAbort(p, before.runId);
    return facts;
  };
  closeIssue(h);
  try {
    await h.poll();
    assert.ok(finishStop, "operator cancellation happens after intake's eligibility snapshot");
    assertOperatorCancellation((await p.store.factoryRun(before.runId))!, "needs_decision");
  } finally {
    f.github.readPr = read;
    await finishStop?.();
  }
  assertOperatorCancellation(await reach(p, before.runId, ["aborted"]), "aborted");
  observeMerged(f);
  h.clock.t += OVERLAP_MS + MIN;
  await h.poll();
  assertOperatorCancellation((await p.store.factoryRun(before.runId))!, "aborted");
});

for (const state of ["merged", "open"] as const) test(`restart before delivering an operator stop preserves its reason against ${state} PR closure`, async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  const durable = (p.store as unknown as { harness: Harness }).harness;
  const abort = durable.abortTask;
  durable.abortTask = async () => "marked"; // Crash after recording intent, before delivering the stop.
  try { await p.store.abortFactoryRun(before.runId, "aborted by UADMIN"); } finally { durable.abortTask = abort; }
  await p.close();
  const restarted = await openProcess(f);
  const recovered = harness(f, restarted);
  recovered.clock.t = h.clock.t;
  f.github.pr.state = state;
  closeIssue(recovered);
  await recovered.poll();
  const pending = (await restarted.store.factoryRun(before.runId))!;
  assert.equal(pending.abortReason, "aborted by UADMIN");
  assert.equal(pending.issueClosureMerge, undefined);
  assert.notEqual(pending.status, "completed");
  // Redeliver the interrupted stop without rewriting its persisted reason.
  const live = (await restarted.store.liveFactoryRuns()).find((run) => run.runId === before.runId)!;
  const recoveredDurable = (restarted.store as unknown as { harness: Harness }).harness;
  await recoveredDurable.abortTask(live.taskId, BACKGROUND_CONTEXT);
  assertOperatorCancellation(await reach(restarted, before.runId, ["aborted"]), "aborted");
  assert.equal((await recoveredDurable.waitForTask(live.taskId, BACKGROUND_CONTEXT)).state.outcome.status, "aborted");
  observeMerged(f);
  recovered.clock.t += OVERLAP_MS + MIN;
  await recovered.poll();
  assertOperatorCancellation((await restarted.store.factoryRun(before.runId))!, "aborted");
  assert.equal(f.footers.length, 3, "no new review, merge, or deployment after recovery");
});

test("all runs in a reopened issue's history sharing the PR are reconciled, not just the latest mapping", async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const first = await failedMerge(f, p, h);
  closeIssue(h);
  await h.poll();
  await reach(p, first.runId, ["aborted"]);
  h.clock.t += MIN;
  h.source.put(7, { state: "open", at: h.clock.t });
  const second = await failedMerge(f, p, h);
  assert.notEqual(first.runId, second.runId);
  observeMerged(f);
  closeIssue(h);
  await h.poll();
  for (const before of [first, second]) assert.equal((await reach(p, before.runId, ["completed"])).pr.mergeCommit, MERGED_COMMIT);
});

test("a restart between recording the merge observation and stopping the task completes reconciliation without deployment", async (t) => {
  const f = fixture(t, { intake: INTAKE, deployer: true, merge: { autoMergeMaxRisk: 2 } });
  const p = await openProcess(f);
  const h = harness(f, p);
  await baseline(h);
  const before = await failedMerge(f, p, h);
  observeMerged(f);
  closeIssue(h);
  const durable = (p.store as unknown as { harness: Harness }).harness;
  const abort = durable.abortTask;
  durable.abortTask = async () => "marked"; // Simulate a crash before the stop is durably requested.
  try { await h.poll(); } finally { durable.abortTask = abort; }
  assert.equal((await p.store.liveFactoryRuns()).length, 1, "old task still waits on its failed-stage decision");
  await p.close();
  const restarted = await openProcess(f);
  await until(async () => (await restarted.store.liveFactoryRuns()).length === 0 || undefined, "recovered task to settle");
  const run = (await restarted.store.factoryRun(before.runId))!;
  assert.deepEqual([run.status, stageOf(run, "merge").attempts.length, stageOf(run, "deploy").status], ["completed", 1, "skipped"]);
  assert.equal(f.footers.length, 3);
  assert.equal(f.github.merges.length, 0);
});
