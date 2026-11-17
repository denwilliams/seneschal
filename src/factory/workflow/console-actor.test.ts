import assert from "node:assert/strict";
import { test } from "node:test";
import { briefOf, fixture, held, openProcess, reach, REPO, reply, respond, stageOf, startRun, until, type Fixture, type Process } from "./test-support.ts";
import { createFactoryRunService, FactoryRunError } from "./service.ts";
import { CONSOLE_ACTOR } from "./docs.ts";
import { parseFooter } from "./footer.ts";

/**
 * The web console is an actor of its own (docs/FACTORY_WORKFLOW_DESIGN.md, console actions). It can answer a stuck run, and it
 * cannot authorize a merge without verified Slack identity: the engine still ignores raw console decisions outside its list.
 */

const APPROVER = "U1ADMIN";
const FAILED = "STATUS: failed\nNEXT: none\nnpm test: 3 failures.";

const consoleService = (f: Fixture, p: Process, extra: { intake?: boolean; identity?: import("./console-approvals.ts").ConsoleMergeIdentity } = {}) =>
  createFactoryRunService({
    channel: f.channel, store: () => p.store, github: () => f.github, threadKey: "", currentUserId: () => "", source: "operator",
    actor: { kind: "console", remote: "10.0.0.7", ...(extra.identity ? { mergeIdentity: extra.identity } : {}) }, ...(extra.intake ? { intake: { kick: () => undefined } } : {}),
  });

test("a console retry carries a failed stage on although the console is nobody's Slack user; the record says it was the console", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), respond(FAILED)]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["needs_decision"], "failed");

  f.faux.setResponses([respond(reply.implement()), respond(reply.review("APPROVED", 5))]);
  await consoleService(f, p).decide(runId, "retry");
  const run = await reach(p, runId, ["waiting"], "merge");
  assert.equal(stageOf(run, "implement").attempts.length, 2, "implement ran again as a new attempt");
  const audit = f.channel.shared.audit;
  const lines = (await import("node:fs")).readFileSync(`${audit}/factory-runs.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const decided = lines.find((l) => l.event === "decide")!;
  assert.deepEqual([decided.actor, decided.remote, decided.decision, decided.userId], ["console", "10.0.0.7", "retry", ""]);
  await p.store.abortFactoryRun(runId, "test over");
});

test("an unverified console cannot approve, decline or allow rounds: the service refuses, and the engine ignores a console decision made straight to the store", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 5))]);
  const { runId } = await startRun(p);
  const waiting = await reach(p, runId, ["waiting"], "merge");
  const service = consoleService(f, p);

  for (const act of [() => service.approve(runId), () => service.decline(runId), () => service.moreRounds(runId), () => service.releaseIntake(`${REPO}#7`)]) {
    await assert.rejects(act(), (e: unknown) => e instanceof FactoryRunError && /web console cannot/.test(e.message));
  }
  await assert.rejects(service.createIssue({ title: "x", body: "y" }), /web console cannot file issues/);

  // Straight to the store, as a forged request would if some route ever reached it: the engine does not take it.
  await p.store.decideFactoryRun(runId, "approve", CONSOLE_ACTOR, waiting.pr.reviewedHead);
  const after = await until(async () => { const run = (await p.store.factoryRun(runId))!; return /web console cannot decide this/.test(run.reason) ? run : undefined; }, "the console's approval to be ignored");
  assert.deepEqual([after.status, after.wait.kind], ["waiting", "merge"], "still waiting for a person");
  assert.equal(after.pr.mergeCommit, "", "nothing was merged");
  assert.equal(f.github.merges?.length ?? 0, 0);

  // A real approver still can.
  await p.store.decideFactoryRun(runId, "approve", APPROVER, waiting.pr.reviewedHead);
  await reach(p, runId, ["completed"]);
});

test("a verified Slack approver can authorize or decline a merge with no required checks from the console", async (t) => {
  for (const decision of ["approve", "decline"] as const) {
    const f = fixture(t, { merge: { autoMergeMaxRisk: 3, approvers: [APPROVER] } });
    f.github.checks.required = 0;
    const p = await openProcess(f);
    f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 3))]);
    const { runId } = await startRun(p);
    const run = await reach(p, runId, ["waiting"], "merge");
    assert.match(run.reason, /no required checks/);
    const identity = { userId: APPROVER, runId, head: run.pr.reviewedHead, since: run.wait.since };
    for (const bad of [{ ...identity, userId: "USTRANGER" }, { ...identity, runId: "other" }, { ...identity, head: "other" }, { ...identity, since: 0 }]) {
      await assert.rejects(consoleService(f, p, { identity: bad })[decision](runId), /cannot decide this merge/);
    }
    await consoleService(f, p, { identity })[decision](runId);
    const settled = await reach(p, runId, decision === "approve" ? ["completed"] : ["rejected"]);
    if (decision === "approve") {
      assert.equal(settled.gate.by, APPROVER, "the engine rechecks the real Slack approver, not the console actor");
      assert.equal(f.github.merges[0]!.expectedHead, run.pr.reviewedHead);
    } else assert.equal(f.github.merges.length, 0);
  }
});

test("a console answer goes on the issue in the console's words with the agent footer and no Slack id, and triage runs again with it", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  const briefs: string[] = [];
  const implement = held(reply.implement());
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("READY"), (context) => briefs.push(briefOf(context))), implement.factory]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "info");

  const done = await consoleService(f, p).answer(runId, "Three personas: admin, editor and viewer.\nping @someone");
  assert.deepEqual(done, { commented: true });
  const comment = f.github.comments[0]!;
  assert.match(comment.body, /Answered in the harness's web console by a person with access to it/);
  assert.ok(!/Slack/.test(comment.body.split("\n\n")[0]!), "it does not claim to be from Slack");
  assert.ok(comment.body.includes("`@someone`"), "a mention is neutralised");
  assert.equal(parseFooter(comment.body)?.runId, runId);
  assert.ok(!comment.body.includes(APPROVER) && !comment.body.includes("10.0.0.7"), "no id or address on GitHub");
  await implement.reached;
  assert.match(briefs[0]!, /answer entered in the harness's web console/);
  assert.match(briefs[0]!, /Three personas: admin, editor and viewer\./);
  const run = (await p.store.factoryRun(runId))!;
  assert.deepEqual([run.updates[0]!.kind, run.updates[0]!.author, run.updates[0]!.trusted], ["console", "console", true]);
  implement.release();
  await p.store.abortFactoryRun(runId, "test over");
});

test("the console can abort a run and start one, and its recheck needs intake like anyone's", async (t) => {
  const f = fixture(t, { intake: { enabled: true } });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO"))]);
  const service = consoleService(f, p, { intake: true });
  const started = await service.start(`${REPO}#7`);
  const run = await reach(p, started.runId, ["waiting"], "info");
  assert.equal(run.by.source, "operator");
  assert.equal(run.by.userId, "", "a console start is nobody's Slack user");
  await service.abort(run.runId);
  await until(async () => { const r = (await p.store.factoryRun(run.runId))!; return r.status === "aborted" ? r : undefined; }, "the run to be aborted");
  const lines = (await import("node:fs")).readFileSync(`${f.channel.shared.audit}/factory-runs.jsonl`, "utf8");
  assert.match(lines, /"event":"abort"[^\n]*"actor":"console"|"actor":"console"[^\n]*"event":"abort"/);
  await assert.rejects(consoleService(f, p).recheckIssue(run.runId), /finished|intake is not on/);
});
