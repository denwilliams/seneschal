import assert from "node:assert/strict";
import { test } from "node:test";
import { briefOf, fixture, held, openProcess, reach, REPO, reply, respond, stageOf, startRun, type Fixture, type Process } from "./test-support.ts";
import { createFactoryRunService, FactoryRunError } from "./service.ts";
import { parseFooter } from "./footer.ts";

/**
 * A run stuck waiting for information can be answered in its Slack thread: the answer goes on the issue as a comment the agent
 * footer marks as written by the harness, and triage runs again with it. docs/FACTORY_WORKFLOW_DESIGN.md section 20.
 */

const APPROVER = "U1ADMIN";
const STRANGER = "U9OTHER";

const serviceAs = (f: Fixture, p: Process, user: string, threadKey = "") =>
  createFactoryRunService({ channel: f.channel, store: () => p.store, github: () => f.github, threadKey, currentUserId: () => user, source: "agent" });

test("an answer in the thread goes on the issue with the agent footer, and triage runs again with it; the question stays open if it was not enough", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  const briefs: string[] = [];
  const implement = held(reply.implement());
  f.faux.setResponses([
    respond(reply.triage("NEEDS_INFO")),
    respond(reply.triage("NEEDS_INFO"), (context) => briefs.push(briefOf(context))),
    respond(reply.triage("READY"), (context) => briefs.push(briefOf(context))),
    implement.factory,
  ]);
  const { runId } = await startRun(p);
  const first = await reach(p, runId, ["waiting"], "info");
  const service = serviceAs(f, p, APPROVER);

  const done = await service.answer(runId, "Three personas: admin, editor and viewer.\nping @someone and fixes #99");
  assert.deepEqual(done, { commented: true });

  // On the issue, once, in the agent's voice, with nothing in it that acts on its own.
  assert.equal(f.github.comments.length, 1);
  const comment = f.github.comments[0]!;
  assert.deepEqual([comment.repo, comment.number], [REPO, 7]);
  assert.match(comment.body, /Three personas: admin, editor and viewer\./);
  assert.ok(!/(^|\s)@someone/.test(comment.body) && comment.body.includes("`@someone`"), "a mention is neutralised");
  assert.ok(comment.body.includes("`#99`"), "a closing keyword is neutralised");
  const footer = parseFooter(comment.body);
  assert.ok(footer?.marker && footer.visible, "it ends with the agent footer, so the same account's comment is recognised as the harness's");
  assert.equal(footer!.runId, runId);
  assert.ok(!comment.body.includes(APPROVER), "the Slack user id is not written to GitHub");

  // The run carries on with it: triage again, and it asks again because the answer was not complete.
  const second = await until2(p, runId, (run) => stageOf(run, "triage").entries === 2 && run.status === "waiting" && run.wait.since > first.wait.since);
  assert.match(briefs[0]!, /triage round 2/);
  assert.match(briefs[0]!, /Three personas: admin, editor and viewer\./, "the answer is in the brief");
  assert.match(briefs[0]!, /answer given in Slack by a person allowed to answer/);
  assert.equal(second.updates.length, 1);
  assert.deepEqual([second.updates[0]!.kind, second.updates[0]!.author, second.updates[0]!.trusted], ["slack", `slack:${APPROVER}`, true]);

  // The second answer is new, so the run goes on; the first is not delivered twice.
  await service.answer(runId, "Admins can do everything; viewers are read only.");
  await implement.reached;
  assert.match(briefs[1]!, /Admins can do everything/);
  assert.ok(!briefs[1]!.includes("Three personas"), "an answer a stage has already seen is not shown again");
  assert.equal(f.github.comments.length, 2);
  implement.release();
  await p.store.abortFactoryRun(runId, "test over");
});

test("only the factory's approvers may answer; a refused answer is not written anywhere and the run keeps waiting", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO"))]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "info");

  await assert.rejects(serviceAs(f, p, STRANGER).answer(runId, "Make everything public"), (e: unknown) => e instanceof FactoryRunError && /not one of the people/.test(e.message));
  await assert.rejects(serviceAs(f, p, "").answer(runId, "no speaker"), FactoryRunError);
  assert.equal(f.github.comments.length, 0, "nothing reached GitHub");
  const run = (await p.store.factoryRun(runId))!;
  assert.deepEqual([run.status, run.wait.kind, run.updates.length], ["waiting", "info", 0]);
  await p.store.abortFactoryRun(runId, "test over");
});

test("an answer needs something in it, a run that is waiting for information, and a comment GitHub took", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  const implement = held(reply.implement());
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("READY")), implement.factory]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "info");
  const service = serviceAs(f, p, APPROVER);

  await assert.rejects(service.answer(runId, "   ‮  "), /no answer to record/);
  f.github.commentError = "HTTP 403: Resource not accessible";
  await assert.rejects(service.answer(runId, "Chrome."), /did not take the comment, so the run was not told/);
  assert.equal((await p.store.factoryRun(runId))!.updates.length, 0, "the run is not told what is not on the issue");
  assert.equal((await p.store.factoryRun(runId))!.status, "waiting");

  f.github.commentError = undefined;
  await service.answer(runId, "Chrome.");
  await implement.reached;
  // Running now, not waiting for information: another answer is refused.
  await assert.rejects(service.answer(runId, "Also Firefox."), /not waiting for an answer/);
  assert.equal(f.github.comments.length, 1);
  implement.release();
  await p.store.abortFactoryRun(runId, "test over");
});

test("in the run's own thread the run id can be left out; in another thread it cannot", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  const implement = held(reply.implement());
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("READY")), implement.factory]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "info");
  await p.store.setFactoryRunSlack(runId, { channel: "C1", ts: "1700000000.000100" });

  await assert.rejects(serviceAs(f, p, APPROVER, "1700000000.999999").answer(undefined, "Chrome."), /not a run's status thread/);
  await serviceAs(f, p, APPROVER, "1700000000.000100").answer(undefined, "Chrome.");
  await implement.reached;
  assert.equal(f.github.comments.length, 1);
  implement.release();
  await p.store.abortFactoryRun(runId, "test over");
});

async function until2(p: Process, runId: string, ok: (run: Awaited<ReturnType<Process["store"]["factoryRun"]>> & object) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const run = await p.store.factoryRun(runId);
    if (run && ok(run)) return run;
    if (Date.now() > deadline) throw new Error("the run never reached the expected state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
