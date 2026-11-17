import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecoveryOutcome } from "../../agent/recovery.ts";
import { workflowProblem } from "./service.ts";
import { fixture, HEAD, openProcess, reach, reply, respond, startRun } from "./test-support.ts";

/** What a restart does to workflow runs, through the recovery gate every channel's store opens with. */

const APPROVER = "U1ADMIN";
const toGate = () => [respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 3))];

test("a run waiting for an approver is carried on by recovery, and the approval still merges it", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const first = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(first);
  await reach(first, runId, ["waiting"], "merge");
  await first.close();

  let outcome: RecoveryOutcome | undefined;
  const second = await openProcess(f, (o) => { outcome = o; }, { factoryProblem: (run) => workflowProblem(f.channel) ?? (run.repo === "acme/app" ? undefined : "no longer a repository") });
  assert.deepEqual(outcome!.factoryRuns, { resumed: [runId], aborted: [] });
  assert.equal(outcome!.resumed, true);
  await reach(second, runId, ["waiting"], "merge");
  await second.store.decideFactoryRun(runId, "approve", APPROVER, HEAD);
  assert.equal((await reach(second, runId, ["completed"])).gate.by, APPROVER);
  assert.equal(f.github.merges.length, 1);
});

test("a run whose factory is no longer configured is aborted by recovery with the reason, instead of failing closed forever", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const first = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(first);
  await reach(first, runId, ["waiting"], "merge");
  await first.close();

  let outcome: RecoveryOutcome | undefined;
  const second = await openProcess(f, (o) => { outcome = o; }, { factoryProblem: () => "this channel is not a software factory" });
  assert.equal(outcome!.factoryRuns.resumed.length, 0);
  assert.deepEqual(outcome!.factoryRuns.aborted, [{ runId, reason: "no longer permitted after the restart: this channel is not a software factory" }]);
  const run = await reach(second, runId, ["aborted"]);
  assert.match(run.reason, /no longer permitted after the restart: this channel is not a software factory/);
  assert.equal(f.github.merges.length, 0);
});

test("recovery with no factory runs says so, and a finished run is not touched", async (t) => {
  const f = fixture(t);
  const first = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("REJECT"))]);
  const { runId } = await startRun(first);
  await reach(first, runId, ["rejected"]);
  await first.close();
  let outcome: RecoveryOutcome | undefined;
  const second = await openProcess(f, (o) => { outcome = o; }, { factoryProblem: () => "never asked about a finished run" });
  assert.deepEqual(outcome!.factoryRuns, { resumed: [], aborted: [] });
  assert.equal((await second.store.factoryRun(runId))!.status, "rejected");
});

test("the workflow's role check: a channel is told which role is missing, and an unassigned deployer is not one", () => {
  const roles = (names: string[]) => ({ factory: { name: "x", repositories: ["a/b"], lifecycleSkills: [], announce: true } as never, agents: names.map((name) => ({ name })) as never });
  assert.equal(workflowProblem(roles(["github_triage", "coder", "reviewer"])), undefined);
  assert.match(workflowProblem(roles(["github_triage", "reviewer"]))!, /no `coder` subagent/);
  assert.match(workflowProblem(roles([]))!, /`github_triage`, `coder`, `reviewer`/);
});
