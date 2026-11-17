import assert from "node:assert/strict";
import { test } from "node:test";
import { createFactoryRunService } from "./service.ts";
import { softwareFactoryWorkflow } from "./definition.ts";
import { buildBrief } from "./transitions.ts";
import { resolveMergeRules } from "./merge.ts";
import { briefOf, fixture, held, HEAD, openProcess, reach, reply, respond, stageOf, startRun, until } from "./test-support.ts";

const USER = "U1ADMIN";
const MOVED = "d".repeat(40);
const FEEDBACK = "Handle empty input and add a regression test.\nDo not remove the existing validation.";
const toGate = () => [respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED"))];

function service(f: ReturnType<typeof fixture>, p: Awaited<ReturnType<typeof openProcess>>, user = USER) {
  return createFactoryRunService({ channel: f.channel, store: () => p.store, github: () => f.github, currentUserId: () => user, threadKey: "" });
}

test("human feedback revises the same PR once, clears consent, and requires independent review and fresh merge approval", async (t) => {
  const f = fixture(t, { merge: { approvers: [USER] } });
  const p = await openProcess(f);
  const coder = held(reply.implement());
  let brief = "";
  f.faux.setResponses([...toGate(), (...args) => { brief = briefOf(args[0]); return coder.factory(...args); }, respond(reply.review("APPROVED"))]);
  const { runId } = await startRun(p);
  const waiting = await reach(p, runId, ["waiting"], "merge");
  const s = service(f, p);
  await assert.rejects(service(f, p, "USTRANGER").requestChanges(runId, FEEDBACK, waiting.wait.since), /not one of the people/);
  await assert.rejects(s.requestChanges(runId, "  ", waiting.wait.since), /actionable feedback/);
  await assert.rejects(s.requestChanges(runId, FEEDBACK, waiting.wait.since - 1), /no longer waiting/);
  const submissions = await Promise.allSettled([s.requestChanges(runId, FEEDBACK, waiting.wait.since), s.requestChanges(runId, FEEDBACK, waiting.wait.since)]);
  assert.equal(submissions.filter((r) => r.status === "fulfilled").length, 1);
  await coder.reached;
  const revising = (await p.store.factoryRun(runId))!;
  assert.equal(revising.current, "implement");
  assert.equal(revising.pr.number, 12);
  assert.deepEqual([revising.gate.decided, revising.pr.reviewedHead, revising.risk.model, revising.deployApprovedBy], [false, "", -1, ""]);
  assert.match(brief, /Continue the existing PR branch/);
  assert.ok(brief.includes(FEEDBACK));
  assert.match(brief, /Fresh independent review/);
  assert.match(brief, /do not open another PR or start another run/);
  // An interrupted revision is not a completed fix: the resumed coder must still receive the human's feedback.
  const interrupted = structuredClone(revising);
  const attempt = stageOf(interrupted, "implement").attempts.at(-1)!;
  attempt.status = "interrupted";
  attempt.endedAt = Date.now();
  const definition = softwareFactoryWorkflow();
  const resumed = buildBrief(interrupted, definition, definition.stages.find((s) => s.name === "implement")!, { reask: false, resumed: true, rules: resolveMergeRules(f.channel.factory, interrupted.repo) });
  assert.ok(resumed.includes(FEEDBACK));
  assert.equal(f.github.merges.length, 0);
  f.github.pr.headSha = MOVED;
  coder.release();
  const again = await until(async () => {
    const r = await p.store.factoryRun(runId);
    return r?.wait.kind === "merge" && stageOf(r, "review").entries === 2 ? r : undefined;
  }, "revised PR waiting for approval");
  assert.equal(again.pr.reviewedHead, MOVED);
  assert.equal(f.github.merges.length, 0);
  assert.equal((await p.store.listFactoryRuns()).length, 1);
  assert.deepEqual(stageOf(again, "merge").attempts.map((a) => a.verdict), ["changes_requested"]);
  await assert.rejects(s.requestChanges(runId, FEEDBACK, waiting.wait.since), /no longer waiting/);
  await p.store.decideFactoryRun(runId, "approve", USER, HEAD);
  await until(async () => (await p.store.factoryRun(runId))?.reason.includes("different commit") ? true : undefined, "old approval ignored");
  assert.equal(f.github.merges.length, 0);
  await s.approve(runId);
  const done = await reach(p, runId, ["completed"]);
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
  assert.equal(stageOf(done, "implement").entries, 2);
  assert.equal(stageOf(done, "review").entries, 2);
});

test("human changes consume the existing review-round budget; feedback survives restart while waiting for another round", async (t) => {
  const f = fixture(t, { merge: { approvers: [USER] } });
  const first = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(first, { definition: softwareFactoryWorkflow({ reviewRounds: 1 }) });
  const waiting = await reach(first, runId, ["waiting"], "merge");
  await service(f, first).requestChanges(runId, FEEDBACK, waiting.wait.since);
  const exhausted = await reach(first, runId, ["waiting"], "rounds");
  assert.deepEqual([exhausted.guard.from, exhausted.guard.target], ["review", "implement"]);
  assert.equal(stageOf(exhausted, "implement").entries, 1);
  assert.equal(f.github.merges.length, 0);
  await first.close();
  const second = await openProcess(f);
  let brief = "";
  f.faux.setResponses([respond(reply.implement(), (call) => { brief = briefOf(call); f.github.pr.headSha = MOVED; }), respond(reply.review("APPROVED"))]);
  await reach(second, runId, ["waiting"], "rounds");
  await second.store.decideFactoryRun(runId, "more_rounds", USER);
  const again = await until(async () => {
    const r = await second.store.factoryRun(runId);
    return r?.wait.kind === "merge" && stageOf(r, "review").entries === 2 ? r : undefined;
  }, "fresh review after extra round");
  assert.ok(brief.includes(FEEDBACK));
  assert.equal(stageOf(again, "review").extraEntries, 1);
  assert.equal(f.github.merges.length, 0);
  await service(f, second).approve(runId);
  await reach(second, runId, ["completed"]);
});

test("the task rejects feedback for the wrong wait, without actionable text, or from an unauthorized decider", async (t) => {
  const f = fixture(t, { merge: { approvers: [USER] } });
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["waiting"], "merge");
  await assert.rejects(p.store.decideFactoryRun(runId, "request_changes", USER, HEAD, "", { feedback: FEEDBACK, since: run.wait.since - 1 }), /no longer waiting/);
  await assert.rejects(p.store.decideFactoryRun(runId, "request_changes", USER, HEAD, "", { feedback: " ", since: run.wait.since }), /actionable feedback/);
  await p.store.decideFactoryRun(runId, "request_changes", "USTRANGER", HEAD, "", { feedback: FEEDBACK, since: run.wait.since });
  const ignored = await until(async () => {
    const r = await p.store.factoryRun(runId);
    return r?.reason.includes("not one of the people") ? r : undefined;
  }, "unauthorized decision ignored");
  assert.equal(ignored.wait.kind, "merge");
  assert.equal(stageOf(ignored, "implement").entries, 1);
  assert.equal(f.github.merges.length, 0);
});

test("an explicit request works for an older pinned run without rewriting its definition or bypassing review", async (t) => {
  const f = fixture(t, { merge: { approvers: [USER] } });
  const p = await openProcess(f);
  const definition = structuredClone(softwareFactoryWorkflow());
  definition.version = 3;
  delete definition.stages.find((s) => s.name === "merge")!.on.changes_requested;
  delete definition.stages.find((s) => s.name === "merge")!.on.conflicts;
  const coder = held(reply.implement());
  f.faux.setResponses([...toGate(), coder.factory, respond(reply.review("APPROVED"))]);
  const { runId } = await startRun(p, { definition });
  const waiting = await reach(p, runId, ["waiting"], "merge");
  await service(f, p).requestChanges(runId, FEEDBACK, waiting.wait.since);
  await coder.reached;
  const revising = (await p.store.factoryRun(runId))!;
  assert.equal(revising.definition, waiting.definition);
  assert.equal(revising.hash, waiting.hash);
  assert.equal(revising.current, "implement");
  f.github.pr.headSha = MOVED;
  coder.release();
  await until(async () => {
    const r = await p.store.factoryRun(runId);
    return r?.wait.kind === "merge" && stageOf(r, "review").entries === 2 ? r : undefined;
  }, "legacy PR independently reviewed again");
  assert.equal(f.github.merges.length, 0);
  await service(f, p).approve(runId);
  await reach(p, runId, ["completed"]);
});

for (const recovery of ["manual approval", "automatic after readPr", "automatic after readChecks"] as const) {
  test(`accepted feedback preempts ${recovery} on a recovered merge wait`, async (t) => {
    const automatic = recovery !== "manual approval";
    const f = fixture(t, { merge: { approvers: [USER], autoMergeMaxRisk: automatic ? 4 : 0 } });
    f.github.checks.pending = 1;
    const first = await openProcess(f);
    f.faux.setResponses(toGate());
    const { runId } = await startRun(first);
    const waiting = await reach(first, runId, ["waiting"], "merge");
    await first.close();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let firstRead = true;
    const block = <T>(read: () => Promise<T>) => async () => {
      if (firstRead) { firstRead = false; entered(); await gate; }
      return read();
    };
    if (recovery === "automatic after readChecks") f.github.readChecks = block(f.github.readChecks.bind(f.github));
    else f.github.readPr = block(f.github.readPr.bind(f.github));
    const coder = held(reply.implement());
    const reviewer = held(reply.review("APPROVED"));
    let brief = "";
    f.faux.setResponses([(...args) => { brief = briefOf(args[0]); return coder.factory(...args); }, reviewer.factory]);
    const second = await openProcess(f);
    await reached;
    try {
      await service(f, second).requestChanges(runId, FEEDBACK, waiting.wait.since);
      // Recovery now sees an auto-mergeable PR, but the accepted feedback must win.
      f.github.checks.pending = 0;
    } finally { release(); }
    const revising = await until(async () => {
      const run = await second.store.factoryRun(runId);
      return run && (stageOf(run, "implement").entries === 2 || run.status === "completed") ? run : undefined;
    }, "revision instead of automatic merge");
    assert.equal(f.github.merges.length, 0, "accepted feedback must preempt automatic merge");
    assert.equal(revising.current, "implement");
    await coder.reached;
    assert.ok(brief.includes(FEEDBACK));
    assert.equal(revising.pr.number, waiting.pr.number);
    assert.deepEqual([revising.gate.decided, revising.pr.reviewedHead, revising.risk.model, revising.deployApprovedBy], [false, "", -1, ""]);
    f.github.pr.headSha = MOVED;
    coder.release();
    await reviewer.reached;
    assert.equal(f.github.merges.length, 0, "revision still needs fresh independent review");
    reviewer.release();
    if (!automatic) {
      await until(async () => {
        const run = await second.store.factoryRun(runId);
        return run?.wait.kind === "merge" && stageOf(run, "review").entries === 2 ? run : undefined;
      }, "review after recovered request");
      await service(f, second).approve(runId);
    }
    const done = await reach(second, runId, ["completed"]);
    assert.equal(stageOf(done, "implement").entries, 2);
    assert.equal(stageOf(done, "review").entries, 2);
    assert.deepEqual(stageOf(done, "merge").attempts.map((attempt) => attempt.verdict), ["changes_requested", "merged"]);
    assert.deepEqual(f.github.merges.map((merge) => merge.expectedHead), [MOVED]);
    assert.equal((await second.store.listFactoryRuns()).length, 1);
  });
}
