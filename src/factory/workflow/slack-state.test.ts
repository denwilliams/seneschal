import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FactoryRunFamily, emptyFactoryRun } from "./docs.ts";
import { fixture, openProcess, reach, reply, respond, startRun } from "./test-support.ts";

/** Where a run shows in Slack is kept on the run, in the channel's own store, and survives what the run itself goes through. */

const APPROVER = "U1ADMIN";
const toGate = () => [respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 3))];

test("a new run has no Slack part filled in, and recording one survives the run's own writes and a restart", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const first = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(first);
  assert.deepEqual((await first.store.factoryRun(runId))!.slack, { channel: "", ts: "", posts: 0, events: [], decision: { kind: "", since: 0, by: "", at: 0 } });
  await first.store.setFactoryRunSlack(runId, { channel: "C1", ts: "1800000000.000001", posts: 1 });
  await first.store.setFactoryRunSlack(runId, { event: "a:triage:0:1" });
  await first.store.setFactoryRunSlack(runId, { event: "a:triage:0:1" });
  // The task goes on writing the run for several stages; none of it touches where the run shows.
  const waiting = await reach(first, runId, ["waiting"], "merge");
  assert.deepEqual([waiting.slack.channel, waiting.slack.ts, waiting.slack.posts, waiting.slack.events], ["C1", "1800000000.000001", 1, ["a:triage:0:1"]], "an event is recorded once");
  await first.close();
  const second = await openProcess(f);
  const again = (await second.store.factoryRun(runId))!;
  assert.deepEqual([again.slack.ts, again.slack.events], ["1800000000.000001", ["a:triage:0:1"]]);
});

test("a decision claimed from a button is kept on the run until the wait it answered is over", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  const waiting = await reach(p, runId, ["waiting"], "merge");
  await p.store.setFactoryRunSlack(runId, { decision: { kind: "approve", since: waiting.wait.since, by: APPROVER, at: 5 } });
  assert.equal((await p.store.factoryRun(runId))!.slack.decision.by, APPROVER);
  await p.store.setFactoryRunSlack(runId, { decision: { kind: "", since: 0, by: "", at: 0 } });
  assert.equal((await p.store.factoryRun(runId))!.slack.decision.kind, "");
});

test("a run recorded before the Slack part existed still loads, with an empty one", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");
  // Take the part away the way a document written by the earlier version would lack it.
  await (p.store as unknown as { harness: { commit(fn: (tx: { doc(family: unknown, key: string, initial: unknown): Promise<Record<string, unknown>> }) => Promise<void>, context: unknown): Promise<void> } }).harness.commit(async (tx) => {
    const doc = await tx.doc(FactoryRunFamily, runId, emptyFactoryRun(runId));
    delete doc.slack;
  }, BACKGROUND_CONTEXT);
  const old = (await p.store.factoryRun(runId))!;
  assert.deepEqual(old.slack, { channel: "", ts: "", posts: 0, events: [], decision: { kind: "", since: 0, by: "", at: 0 } });
  assert.equal(old.status, "waiting");
  assert.equal((await p.store.listFactoryRuns()).length, 1);
  await p.store.setFactoryRunSlack(runId, { ts: "1800000000.000002" });
  assert.equal((await p.store.factoryRun(runId))!.slack.ts, "1800000000.000002");
});
