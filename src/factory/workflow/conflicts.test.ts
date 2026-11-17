import assert from "node:assert/strict";
import { test } from "node:test";
import { softwareFactoryWorkflow } from "./definition.ts";
import { conflictEvidence, mergeDecision, prMergeability, resolveMergeRules, type PrFacts } from "./merge.ts";
import { briefOf, fixture, held, HEAD, openProcess, reach, reply, respond, stageOf, startRun, until, type Fixture } from "./test-support.ts";

const MOVED = "d".repeat(40);
const BASE = "e".repeat(40);
const AUTO = { autoMergeMaxRisk: 2 } as const;
const APPROVER = "U1ADMIN";
const conflict = (f: Fixture) => {
  f.github.pr = { ...f.github.pr, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", headRefName: "fix/7", baseRefName: "release", baseSha: BASE };
};
const repair = (f: Fixture) => {
  f.github.pr = { ...f.github.pr, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: MOVED };
};
const toReview = () => [respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED"))];

function assertRepairBrief(brief: string) {
  for (const text of ["acme/app", "Issue: #7", "https://github.com/acme/app/pull/12", "fix/7", "target base release", HEAD, BASE, "CONFLICTING", "DIRTY", "do not open a replacement PR", "Do not force-push", "rather than guessing", "Fresh independent review"]) assert.ok(brief.includes(text), text);
  assert.doesNotMatch(brief, /Conflicting paths: src\/login.ts/, "changed files must not be invented as conflict paths");
}

test("only explicit conflict facts trigger conflict routing; unknown and other blockers are distinct", () => {
  const base: PrFacts = { state: "open", headSha: HEAD, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", changedFiles: [], additions: 0, deletions: 0 };
  const decide = (pr: PrFacts) => mergeDecision({ pr, modelRisk: 2, checks: { required: 1, failing: 0, pending: 0 }, rules: resolveMergeRules(undefined, "acme/app"), reviewedHead: HEAD });
  for (const mergeStateStatus of ["CLEAN", "BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS", "UNKNOWN"]) {
    const pr = { ...base, mergeStateStatus };
    assert.equal(prMergeability(pr), "mergeable");
    assert.equal(decide(pr).action, "wait", mergeStateStatus);
  }
  for (const pr of [{ ...base, mergeable: "CONFLICTING" }, { ...base, mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }]) {
    assert.equal(prMergeability(pr), "conflicting");
    assert.equal(decide(pr).action, "conflicts");
    assert.match(conflictEvidence(pr), /Confirmed PR merge conflicts/);
  }
  const unknown = { ...base, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
  assert.equal(prMergeability(unknown), "unknown");
  assert.equal(decide(unknown).action, "unresolved");
});

test("conflict found before review returns the same PR to one coder, then reviews the repaired head", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  let brief = "";
  f.faux.setResponses([
    respond(reply.triage()), respond(reply.implement(), () => conflict(f)),
    respond(reply.implement(), (c) => { brief = briefOf(c); repair(f); }),
    respond(reply.review("APPROVED")),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);
  assertRepairBrief(brief);
  assert.equal(f.faux.state.callCount, 4, "no reviewer model is spent on a confirmed preflight conflict");
  assert.deepEqual(stageOf(run, "implement").attempts.map((a) => a.verdict), ["done", "done"]);
  assert.deepEqual(stageOf(run, "review").attempts.map((a) => a.verdict), ["changes_requested", "approved"]);
  assert.equal(stageOf(run, "review").attempts[0]!.runKey, "", "preflight evidence, not a fictitious model run");
  assert.equal(run.pr.number, 12);
  assert.equal(run.pr.reviewedHead, MOVED);
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
});

test("target base changes DURING review: its approval is invalidated before any merge-approval handoff", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  let brief = "";
  f.faux.setResponses([
    respond(reply.triage()), respond(reply.implement()),
    respond(reply.review("APPROVED", 1, "original findings"), () => conflict(f)),
    respond(reply.implement(), (c) => { brief = briefOf(c); repair(f); }),
    respond(reply.review("APPROVED", 2)),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["waiting"], "merge");
  assertRepairBrief(brief);
  assert.match(brief, /original findings/);
  assert.deepEqual(stageOf(run, "review").attempts.map((a) => a.verdict), ["changes_requested", "approved"]);
  assert.equal(stageOf(run, "merge").entries, 1, "the conflicted approval never entered the merge gate");
  assert.equal(run.pr.reviewedHead, MOVED);
  assert.equal(run.risk.model, 2);
  assert.equal(run.gate.decided, false);
  assert.equal(f.github.merges.length, 0);
});

for (const when of ["before review", "after review", "merge entry", "immediately before merge"] as const) {
  test("unknown mergeability " + when + " is blocked, not a conflict or approval", async (t) => {
    const f = fixture(t, { merge: AUTO });
    const p = await openProcess(f);
    let reads = 0;
    const read = f.github.readPr.bind(f.github);
    const at = { "before review": 1, "after review": 2, "merge entry": 3, "immediately before merge": 4 }[when];
    f.github.readPr = async () => {
      if (++reads === at) f.github.pr = { ...f.github.pr, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
      return read();
    };
    f.faux.setResponses(toReview());
    const { runId } = await startRun(p);
    const run = await reach(p, runId, ["needs_decision"], "failed");
    assert.match(run.reason, /unknown/);
    assert.equal(stageOf(run, "implement").entries, 1);
    assert.equal(f.github.merges.length, 0);
    assert.ok(!stageOf(run, "review").attempts.some((a) => a.verdict === "changes_requested"));
  });
}

for (const at of [3, 4]) {
  test("base moves after review at read " + at + ": merge gate returns conflicts to implementation", async (t) => {
    const f = fixture(t, { merge: AUTO });
    const p = await openProcess(f);
    let reads = 0;
    let brief = "";
    const read = f.github.readPr.bind(f.github);
    f.github.readPr = async () => { if (++reads === at) conflict(f); return read(); };
    f.faux.setResponses([
      ...toReview(),
      respond(reply.implement(), (c) => { brief = briefOf(c); repair(f); }),
      respond(reply.review("APPROVED")),
    ]);
    const { runId } = await startRun(p);
    const run = await reach(p, runId, ["completed"]);
    assertRepairBrief(brief);
    assert.deepEqual(stageOf(run, "merge").attempts.map((a) => a.verdict), ["conflicts", "merged"]);
    assert.deepEqual(stageOf(run, "review").attempts.map((a) => a.verdict), ["approved", "approved"]);
    assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
  });
}

test("merge rejection routes to implementation only after GitHub independently confirms conflicts", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  const merge = f.github.mergePr.bind(f.github);
  let calls = 0;
  f.github.mergePr = async (input) => {
    if (++calls === 1) { conflict(f); throw new Error("GitHub refused the merge"); }
    return merge(input);
  };
  f.faux.setResponses([...toReview(), respond(reply.implement(), () => repair(f)), respond(reply.review("APPROVED"))]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);
  assert.deepEqual(stageOf(run, "merge").attempts.map((a) => a.verdict), ["conflicts", "merged"]);
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
});

for (const message of ["HTTP 403: forbidden", "branch protection requires checks", "Pull request is not mergeable: branch is behind"]) {
  test("non-conflict merge failure remains a failed-stage decision: " + message, async (t) => {
    const f = fixture(t, { merge: AUTO });
    const p = await openProcess(f);
    f.github.mergeError = message;
    f.faux.setResponses(toReview());
    const { runId } = await startRun(p);
    const run = await reach(p, runId, ["needs_decision"], "failed");
    assert.ok(run.reason.includes(message));
    assert.equal(run.current, "merge");
    assert.equal(stageOf(run, "implement").entries, 1);
  });
}

test("approval cannot survive a conflict repair; the updated head needs fresh review and approval, also after restart", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const first = await openProcess(f);
  const coder = held(reply.implement());
  let brief = "";
  f.faux.setResponses([...toReview(), (...args) => { brief = briefOf(args[0]); return coder.factory(...args); }, respond(reply.review("APPROVED"))]);
  const { runId } = await startRun(first);
  await reach(first, runId, ["waiting"], "merge");
  conflict(f);
  await first.store.decideFactoryRun(runId, "approve", APPROVER, HEAD);
  await coder.reached;
  const repairing = (await first.store.factoryRun(runId))!;
  assert.equal(repairing.current, "implement");
  assert.deepEqual([repairing.gate.decided, repairing.gate.head, repairing.pr.reviewedHead, repairing.risk.model, repairing.deployApprovedBy], [false, "", "", -1, ""]);
  assertRepairBrief(brief);
  repair(f); coder.release();
  await reach(first, runId, ["waiting"], "merge");
  await first.close();
  const second = await openProcess(f);
  const waiting = await reach(second, runId, ["waiting"], "merge");
  assert.equal(waiting.pr.reviewedHead, MOVED);
  assert.equal(f.github.merges.length, 0);
  await second.store.decideFactoryRun(runId, "approve", APPROVER, HEAD);
  await until(async () => { const r = await second.store.factoryRun(runId); return r?.reason.includes("different commit") ? r : undefined; }, "stale approval ignored");
  assert.equal(f.github.merges.length, 0);
  await second.store.decideFactoryRun(runId, "approve", APPROVER, MOVED);
  const done = await reach(second, runId, ["completed"]);
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
  assert.deepEqual(stageOf(done, "merge").attempts.map((a) => a.verdict), ["conflicts", "merged"]);
});

test("approval-wait polling finds a conflict without requiring someone to approve a broken branch", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  let reportConflict!: (facts: PrFacts) => void;
  f.github.untilSettled = async () => new Promise<PrFacts>((resolve) => { reportConflict = resolve; });
  f.faux.setResponses([...toReview(), respond(reply.implement(), () => repair(f)), respond(reply.review("APPROVED"))]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");
  await until(() => reportConflict, "poll installed");
  conflict(f); reportConflict({ ...f.github.pr });
  const run = await until(async () => { const r = await p.store.factoryRun(runId); return r?.wait.kind === "merge" && stageOf(r, "review").entries === 2 ? r : undefined; }, "repaired PR back at merge approval");
  assert.equal(run.pr.reviewedHead, MOVED);
  assert.deepEqual(stageOf(run, "merge").attempts.map((a) => a.verdict), ["conflicts"]);
  assert.equal(f.github.merges.length, 0);
});

test("persistent pre-review conflicts exhaust the existing review rounds instead of looping coders", async (t) => {
  const f = fixture(t, { merge: AUTO });
  conflict(f);
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), ...Array.from({ length: 3 }, () => respond(reply.implement()))]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["waiting"], "rounds");
  assert.deepEqual([run.guard.from, run.guard.target], ["review", "implement"]);
  assert.equal(stageOf(run, "implement").entries, 3);
  assert.equal(stageOf(run, "review").attempts.length, 3);
  assert.equal(f.faux.state.callCount, 4);
});

test("a merge-gate conflict also respects exhausted REVIEW rounds before starting another implementation", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  let reads = 0;
  const read = f.github.readPr.bind(f.github);
  f.github.readPr = async () => { if (++reads === 3) conflict(f); return read(); };
  f.faux.setResponses(toReview());
  const { runId } = await startRun(p, { definition: softwareFactoryWorkflow({ reviewRounds: 1 }) });
  const run = await reach(p, runId, ["waiting"], "rounds");
  assert.deepEqual([run.guard.from, run.guard.target], ["review", "implement"]);
  assert.equal(stageOf(run, "implement").entries, 1);
  assert.equal(stageOf(run, "merge").attempts[0]!.verdict, "conflicts");
  f.faux.setResponses([respond(reply.implement(), () => repair(f)), respond(reply.review("APPROVED"))]);
  await p.store.decideFactoryRun(runId, "more_rounds", APPROVER);
  const done = await reach(p, runId, ["completed"]);
  assert.equal(stageOf(done, "review").extraEntries, 1);
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
});

test("an older pinned merge gate keeps evidence and parks for an explicit restart, without rewriting its definition", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  const definition = structuredClone(softwareFactoryWorkflow());
  definition.version = 3;
  delete definition.stages.find((s) => s.name === "merge")!.on.conflicts;
  let reads = 0;
  const read = f.github.readPr.bind(f.github);
  f.github.readPr = async () => { if (++reads === 3) conflict(f); return read(); };
  f.faux.setResponses(toReview());
  const { runId } = await startRun(p, { definition });
  const parked = await reach(p, runId, ["needs_decision"], "failed");
  assert.match(parked.reason, /restart_from implement/);
  assert.deepEqual(JSON.parse(parked.definition), definition);
  assert.equal(parked.gate.decided, false);
  assert.equal(parked.pr.reviewedHead, "");
  assert.match(stageOf(parked, "merge").attempts[0]!.report, /target base release/);
  let brief = "";
  f.faux.setResponses([respond(reply.implement(), (c) => { brief = briefOf(c); repair(f); }), respond(reply.review("APPROVED"))]);
  await p.store.decideFactoryRun(runId, "restart_from", APPROVER, "", "implement");
  const done = await reach(p, runId, ["completed"]);
  assertRepairBrief(brief);
  assert.equal(done.pr.reviewedHead, MOVED);
});

test("restating an incomplete approval does not authorize a head pushed since the actual review", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  f.faux.setResponses([
    respond(reply.triage()), respond(reply.implement()),
    respond("STATUS: done\nNEXT: none\nVERDICT: APPROVED", () => { f.github.pr = { ...f.github.pr, headSha: MOVED }; }),
    respond(reply.review("APPROVED")),
    respond(reply.review("APPROVED")),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);
  assert.equal(stageOf(run, "review").entries, 2, "a genuine second review, not only the score restatement");
  assert.equal(stageOf(run, "review").attempts.length, 3);
  assert.deepEqual(stageOf(run, "merge").attempts.map((a) => a.verdict), ["head_changed", "merged"]);
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
});

test("unsafe conflict resolution can report blocked without losing the existing PR", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement(), () => conflict(f)), respond("STATUS: blocked\nNEXT: none\nsrc/login.ts has incompatible auth semantics; need a product decision")]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.equal(run.current, "implement");
  assert.equal(run.pr.number, 12);
  assert.match(run.reason, /incompatible auth semantics/);
  assert.equal(f.github.merges.length, 0);
});

test("conflict repair cannot replace the existing PR", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement(), () => conflict(f)), respond(reply.implement("https://github.com/acme/app/pull/99"))]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.equal(run.pr.number, 12);
  assert.match(run.reason, /replacement PR/);
  assert.equal(f.github.merges.length, 0);
});
