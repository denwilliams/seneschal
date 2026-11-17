import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { agentFooter } from "./footer.ts";
import type { WorkflowDefinition } from "./definition.ts";
import { briefOf, fixture, held, HEAD, NO_RESUME_WORKFLOW, openProcess, reach, REPO, reply, respond, stageOf, startRun, statuses, until, type Fixture } from "./test-support.ts";

/**
 * The workflow engine against the real durable store, with the shipped factory roles on a scripted model and a fake GitHub
 * (docs/FACTORY_WORKFLOW_DESIGN.md). Each role's turn is one scripted reply, used in the order the stages run.
 */

const APPROVER = "U1ADMIN";
const AUTO = { autoMergeMaxRisk: 2 } as const;
const MOVED = "b".repeat(40);

/** The scripted happy path up to review's report. */
const upToReview = (review: string) => [respond(reply.triage("READY")), respond(reply.implement()), respond(review)];

test("a run walks triage, implement, review and the merge gate, merges by itself under the limit, and skips deploy when no deployer is assigned", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  const seen: Record<string, string> = {};
  f.faux.setResponses([
    respond(reply.triage("READY"), (c) => { seen.triage = briefOf(c); }),
    respond(reply.implement(), (c) => { seen.implement = briefOf(c); }),
    respond(reply.review("APPROVED", 2), (c) => { seen.review = briefOf(c); }),
  ]);
  const { runId } = await startRun(p, { notes: "Mind the auth code." });
  const run = await reach(p, runId, ["completed"]);

  assert.deepEqual(statuses(run), ["success", "success", "success", "success", "skipped"]);
  assert.deepEqual(run.stages.map((s) => s.attempts.length), [1, 1, 1, 1, 1], "deploy's one 'attempt' is the skip, with its reason");
  assert.equal(stageOf(run, "deploy").attempts[0]!.verdict, "skipped");
  assert.match(stageOf(run, "deploy").attempts[0]!.summary, /cloudflare_deployer role is not assigned/);
  assert.equal(f.faux.state.callCount, 3, "one model turn per role, none for the gate or the skipped deploy");

  assert.deepEqual([run.pr.number, run.pr.url, run.pr.reviewedHead], [12, "https://github.com/acme/app/pull/12", HEAD]);
  assert.deepEqual([run.risk.model, run.risk.final, run.risk.floors, run.risk.scored], [2, 2, [], true]);
  assert.deepEqual([run.gate.decided, run.gate.by, run.gate.head], [true, "auto", HEAD]);
  assert.deepEqual(f.github.merges, [{ repo: REPO, number: 12, method: "squash", expectedHead: HEAD }]);
  assert.equal(run.pr.mergeCommit, "bbbbbbb2222222222222222222222222222222bb");
  assert.match(stageOf(run, "merge").attempts[0]!.summary, /merged automatically at risk 2/);
  assert.equal(run.status, "completed");
  assert.equal(run.reason, "");
  assert.equal(run.wait.kind, "");
  assert.ok(run.endedAt >= run.startedAt && run.startedAt > 0);
  assert.equal(run.current, "deploy");

  // Each role was briefed from the run's record alone.
  assert.match(seen.triage!, /Triage issue #7 only/);
  assert.match(seen.triage!, /Notes from the person who asked for this: Mind the auth code\./);
  assert.match(seen.implement!, /Implement issue #7/);
  assert.match(seen.review!, /Review https:\/\/github\.com\/acme\/app\/pull\/12 against issue #7/);
  assert.match(seen.review!, /Branch fix\/7, PR https:\/\/github\.com\/acme\/app\/pull\/12/, "the coder's report is in the reviewer's brief");

  // Each role's shell was switched to the footer guard for its own run and stage, so what it writes to GitHub is marked as the agent's
  // whether or not it remembered to (docs/FACTORY_WORKFLOW_DESIGN.md section 21).
  assert.deepEqual(f.footers, [
    agentFooter({ role: "github_triage", stage: "triage", runId }),
    agentFooter({ role: "coder", stage: "implement", runId }),
    agentFooter({ role: "reviewer", stage: "review", runId }),
  ]);

  // The roles ran as sub-agents under the run's synthetic parent and are on the timeline, with the pinned definition on the run.
  const ends = p.timeline.read().filter((e) => e.kind === "run.end");
  assert.deepEqual(ends.map((e) => [e.actor, e.status]), [["github_triage", "done"], ["coder", "done"], ["reviewer", "done"]]);
  assert.ok(ends.every((e) => e.threadKey === `sub-parent-${runId}`));
  assert.deepEqual(run.stages.slice(0, 3).map((s) => s.attempts[0]!.runKey).every((key) => /^sub-/.test(key)), true);
  assert.equal(run.workflow, "software-factory");
  assert.match(run.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(await p.store.liveFactoryRuns(), []);
  assert.deepEqual((await p.store.listFactoryRuns()).map((r) => r.runId), [runId]);
});

test("review asks for changes: the findings go back to the coder verbatim, the stages after reset, and every attempt is kept", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  const briefs: string[] = [];
  const findings = "- blocker: src/login.ts:44 trims the password.\n- should-fix: add a test for the empty password.";
  f.faux.setResponses([
    respond(reply.triage()), respond(reply.implement()), respond(reply.review("CHANGES_REQUESTED", 3, findings)),
    respond(reply.implement(), (c) => briefs.push(briefOf(c))),
    respond(reply.review("APPROVED", 2), (c) => briefs.push(briefOf(c))),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);

  assert.match(briefs[0]!, /This is round 2\./);
  assert.ok(briefs[0]!.includes(findings), "the reviewer's findings, verbatim");
  assert.match(briefs[0]!, /do not open another pull request/);
  assert.deepEqual(run.stages.map((s) => s.entries), [1, 2, 2, 1, 1]);
  assert.deepEqual(stageOf(run, "implement").attempts.map((a) => [a.entry, a.verdict]), [[1, "done"], [2, "done"]]);
  assert.deepEqual(stageOf(run, "review").attempts.map((a) => [a.entry, a.verdict]), [[1, "changes_requested"], [2, "approved"]]);
  assert.ok(stageOf(run, "review").attempts[0]!.report.includes("trims the password"), "the first review's report is still on the run");
  assert.notEqual(stageOf(run, "review").attempts[0]!.runKey, stageOf(run, "review").attempts[1]!.runKey);
  // The second review judged the new pull request state; its risk replaced the first review's.
  assert.deepEqual([run.risk.model, run.risk.final], [2, 2]);
  assert.equal(run.status, "completed");
});

test("review runs out of rounds: the run waits, a stranger cannot allow another, an approver can, and the last round can still approve", async (t) => {
  const f = fixture(t, { merge: { ...AUTO, approvers: [APPROVER] } });
  const p = await openProcess(f);
  const round = (n: number) => [respond(reply.implement()), respond(reply.review("CHANGES_REQUESTED", 3, `- blocker: round ${n}`))];
  f.faux.setResponses([respond(reply.triage()), ...round(1), ...round(2), ...round(3)]);
  const { runId } = await startRun(p);

  const waiting = await reach(p, runId, ["waiting"], "rounds");
  assert.deepEqual(waiting.stages.map((s) => s.entries), [1, 3, 3, 0, 0]);
  assert.deepEqual([waiting.guard.from, waiting.guard.target], ["review", "implement"]);
  assert.match(waiting.reason, /"review" has run 3 times and wants to send the run back to "implement" again\. Allow another round, or stop the run\./);
  assert.equal(f.faux.state.callCount, 7, "nothing ran while it waited");

  // A decision that does not answer this wait, and one from someone who may not decide, are ignored and noted.
  await assert.rejects(p.store.decideFactoryRun(runId, "approve", APPROVER), /waiting on rounds: more_rounds or stop answers it, not approve/);
  await p.store.decideFactoryRun(runId, "more_rounds", "U9STRANGER");
  const ignored = await until(async () => { const r = await p.store.factoryRun(runId); return r && /Ignored a decision: <@U9STRANGER> is not one of the people who may decide this/.test(r.reason) ? r : undefined; }, "the stranger's decision to be ignored");
  assert.equal(ignored.status, "waiting");
  assert.equal(stageOf(ignored, "implement").entries, 3, "and nothing moved");

  // An approver allows one more round; the fourth review approves, which is allowed on the last round.
  f.faux.setResponses([respond(reply.implement()), respond(reply.review("APPROVED", 2))]);
  await p.store.decideFactoryRun(runId, "more_rounds", APPROVER);
  const done = await reach(p, runId, ["completed"]);
  assert.deepEqual(done.stages.map((s) => s.entries), [1, 4, 4, 1, 1]);
  assert.equal(stageOf(done, "review").extraEntries, 1);
  assert.deepEqual([done.guard.from, done.wait.kind], ["", ""]);
});

test("review out of rounds and a person stops the run", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  const round = (n: number) => [respond(reply.implement()), respond(reply.review("CHANGES_REQUESTED", 3, `- blocker: round ${n}`))];
  f.faux.setResponses([respond(reply.triage()), ...round(1), ...round(2), ...round(3)]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "rounds");
  await p.store.decideFactoryRun(runId, "stop", APPROVER);
  const run = await reach(p, runId, ["aborted"]);
  assert.match(run.reason, /stopped by <@U1ADMIN> when "review" was out of rounds/);
  assert.equal(run.wait.kind, "");
  assert.deepEqual(await p.store.liveFactoryRuns(), []);
});

test("triage rejects the issue: the run is rejected, not failed, and nothing after triage starts", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("REJECT"))]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["rejected"]);
  assert.deepEqual(statuses(run), ["success", "not_started", "not_started", "not_started", "not_started"]);
  assert.match(run.reason, /reject/);
  assert.equal(stageOf(run, "triage").attempts[0]!.verdict, "reject");
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(await p.store.liveFactoryRuns(), []);
});

test("the coder is blocked: the stage fails and the run waits for a person, it does not end", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), respond("STATUS: blocked\nNEXT: none\nNo push access to acme/app.")]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.deepEqual(statuses(run), ["success", "failed", "not_started", "not_started", "not_started"]);
  assert.match(run.reason, /No push access/);
  assert.equal(run.endedAt, 0, "the run has not ended");
  assert.equal(f.faux.state.callCount, 2);
});

test("a role that fails fails the stage and parks the run on it; the reason and the attempt are kept", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), respond("STATUS: failed\nNEXT: none\nnpm test: 3 failures.")]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.equal(stageOf(run, "implement").status, "failed");
  assert.equal(stageOf(run, "implement").attempts[0]!.status, "failed");
  assert.match(run.reason, /stage "implement" failed: npm test: 3 failures\./);
});

test("a report missing its verdict is asked for again, once; the restated report carries on, and both attempts are kept", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  let askedWith = "";
  f.faux.setResponses([
    respond(reply.triage()), respond(reply.implement()),
    respond("STATUS: done\nNEXT: none\nThe change looks fine to me."),
    respond(reply.review("APPROVED", 2), (c) => { askedWith = briefOf(c); }),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);
  const review = stageOf(run, "review");
  assert.deepEqual(review.attempts.map((a) => [a.reask, a.verdict, a.status]), [[false, "", "done"], [true, "approved", "done"]]);
  assert.match(review.attempts[0]!.summary, /Missing: a `VERDICT:` line naming one of: APPROVED, CHANGES_REQUESTED/);
  assert.equal(review.entries, 1, "asking again is not entering the stage again");
  assert.match(askedWith, /missing something the workflow needs/);
  assert.match(askedWith, /Your previous report:\n.*The change looks fine to me\./s);
  assert.equal(f.faux.state.callCount, 4);
});

test("a report that is still missing its verdict when asked again fails the stage; the run waits for a person", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses([...upToReview("STATUS: done\nNEXT: none\nFine."), respond("STATUS: done\nNEXT: none\nStill fine.")]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.equal(stageOf(run, "review").status, "failed");
  assert.match(run.reason, /stage "review" failed: the report is missing a `VERDICT:` line.*even when asked again/);
  assert.equal(f.faux.state.callCount, 4, "asked once more, not again");
});

test("a coder that opens no pull request in this repository is asked, then fails the stage and waits for a person", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage()), respond("STATUS: done\nNEXT: reviewer\nPR https://github.com/evil/app/pull/1"), respond("STATUS: done\nNEXT: reviewer\nStill https://github.com/evil/app/pull/1")]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.match(run.reason, /the report is missing the URL of the pull request you opened in acme\/app/);
  assert.equal(run.pr.number, 0, "another repository's pull request is never the run's");
});

// ── The merge gate ───────────────────────────────────────────────────────────────────────────────────────────

const toGate = (review = reply.review("APPROVED", 2)) => upToReview(review);

test("the merge gate waits when the rules do not allow it by themselves, and says why", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["waiting"], "merge");
  assert.equal(stageOf(run, "merge").status, "in_progress");
  assert.match(run.reason, /^Waiting for approval to merge: automatic merging is off for this repository/);
  assert.deepEqual([run.risk.model, run.risk.final], [2, 2]);
  assert.equal(f.github.merges.length, 0);
});

test("an approver approves the reviewed commit: it merges, and the approver is on record; a stranger and a different commit are ignored", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");

  await p.store.decideFactoryRun(runId, "approve", "U9STRANGER", HEAD);
  await until(async () => /Ignored a decision: <@U9STRANGER> is not one of the people/.test((await p.store.factoryRun(runId))!.reason) || undefined, "stranger ignored");
  await p.store.decideFactoryRun(runId, "approve", APPROVER, "c".repeat(40));
  await until(async () => /Ignored a decision: that approval was for a different commit than the one reviewed/.test((await p.store.factoryRun(runId))!.reason) || undefined, "wrong commit ignored");
  assert.equal(f.github.merges.length, 0, "neither merged anything");

  await p.store.decideFactoryRun(runId, "approve", APPROVER, HEAD);
  const run = await reach(p, runId, ["completed"]);
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [HEAD], "merged only at the head that was reviewed");
  assert.deepEqual([run.gate.by, run.deployApprovedBy], [APPROVER, APPROVER]);
  assert.match(stageOf(run, "merge").attempts[0]!.summary, /approved by <@U1ADMIN> and merged/);
  assert.equal(stageOf(run, "deploy").status, "skipped");
});

test("an approver declines: the run is rejected and nothing merges", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");
  await p.store.decideFactoryRun(runId, "decline", APPROVER);
  const run = await reach(p, runId, ["rejected"]);
  assert.match(run.reason, /declined by <@U1ADMIN>/);
  assert.equal(f.github.merges.length, 0);
  assert.equal(stageOf(run, "merge").attempts[0]!.verdict, "declined");
  assert.deepEqual(statuses(run).slice(0, 4), ["success", "success", "success", "success"]);
});

test("a person merges the pull request on GitHub while the run waits: that is the decision; and closing it is a decline", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");
  f.github.settle("merged");
  const run = await reach(p, runId, ["completed"]);
  assert.equal(f.github.merges.length, 0, "the harness merged nothing: it was merged already");
  assert.deepEqual([run.gate.by, run.pr.mergeCommit], ["github", "ccccccc3333333333333333333333333333333cc"]);
  assert.match(stageOf(run, "merge").attempts[0]!.summary, /merged on GitHub/);
  assert.equal(run.deployApprovedBy, "", "someone merging by hand is not an approval to deploy");

  const g = fixture(t);
  const q = await openProcess(g);
  g.faux.setResponses(toGate());
  const second = await startRun(q);
  await reach(q, second.runId, ["waiting"], "merge");
  g.github.settle("closed");
  const rejected = await reach(q, second.runId, ["rejected"]);
  assert.match(rejected.reason, /the pull request was closed on GitHub/);
});

test("the pull request moves on after review: back to review, once, then through", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  f.faux.setResponses([
    respond(reply.triage()), respond(reply.implement()),
    // Someone pushes while the reviewer works: the head the reviewer saw is no longer the head.
    respond(reply.review("APPROVED", 1), () => { f.github.pr = { ...f.github.pr, headSha: MOVED }; }),
    respond(reply.review("APPROVED", 2)),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);
  assert.deepEqual(stageOf(run, "merge").attempts.map((a) => a.verdict), ["head_changed", "merged"]);
  assert.match(stageOf(run, "merge").attempts[0]!.summary, /head is bbbbbbb, not the aaaaaaa that was reviewed; back to review/);
  assert.deepEqual(stageOf(run, "review").attempts.map((a) => a.verdict), ["approved", "approved"]);
  assert.equal(stageOf(run, "review").entries, 2);
  assert.equal(run.pr.reviewedHead, MOVED, "the second review is of the new head");
  assert.deepEqual(f.github.merges.map((m) => m.expectedHead), [MOVED]);
  assert.equal(f.faux.state.callCount, 4);
});

test("an approval of a commit that has since moved goes back to review instead of merging it", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");
  f.github.pr = { ...f.github.pr, headSha: MOVED };
  f.faux.setResponses([respond(reply.review("APPROVED", 2))]);
  await p.store.decideFactoryRun(runId, "approve", APPROVER, HEAD);
  await until(async () => { const r = await p.store.factoryRun(runId); return r && stageOf(r, "review").entries === 2 ? r : undefined; }, "back to review");
  assert.equal(f.github.merges.length, 0, "the new commit was never approved");
  const run = await reach(p, runId, ["waiting"], "merge");
  assert.match(stageOf(run, "merge").attempts[0]!.summary, /the pull request moved on after <@U1ADMIN> approved it; back to review/);
  assert.equal(run.pr.reviewedHead, MOVED);
});

test("the gate's reasons: failing and running checks, no required checks, an unreadable checks list, a sensitive path, a large diff, a missing score", async (t) => {
  const cases: { what: string; setup: (f: Fixture) => void; review?: string; /** The reviewer is asked once more for its score and gives the same report. */ again?: boolean; merge?: object; reason: RegExp; final?: number }[] = [
    { what: "failing checks", setup: (f) => { f.github.checks = { required: 2, failing: 1, pending: 0 }; }, reason: /1 required check is failing/ },
    { what: "running checks", setup: (f) => { f.github.checks = { required: 2, failing: 0, pending: 2 }; }, reason: /2 required checks are still running/ },
    { what: "no required checks", setup: (f) => { f.github.checks = { required: 0, failing: 0, pending: 0 }; }, reason: /GitHub reports no required checks for this branch/ },
    { what: "unreadable checks", setup: (f) => { f.github.checksError = "HTTP 502"; }, reason: /could not read the pull request's checks: HTTP 502/ },
    { what: "a sensitive path", setup: (f) => { f.github.pr = { ...f.github.pr, changedFiles: ["src/a.ts", "infra/main.tf"] }; }, review: reply.review("APPROVED", 1), merge: { sensitivePaths: ["infra/**"] }, reason: /risk 4 is above this repository's automatic limit of 2/, final: 4 },
    { what: "a large diff", setup: (f) => { f.github.pr = { ...f.github.pr, additions: 900 }; }, review: reply.review("APPROVED", 1), reason: /risk 3 is above/, final: 3 },
    { what: "no score", setup: () => {}, review: "STATUS: done\nNEXT: none\nVERDICT: APPROVED", again: true, reason: /risk 5 is above/, final: 5 },
    { what: "an out of range score", setup: () => {}, review: reply.review("APPROVED", 9), again: true, reason: /risk 5 is above/, final: 5 },
  ];
  for (const c of cases) {
    const f = fixture(t, { merge: { ...AUTO, ...c.merge } });
    c.setup(f);
    const p = await openProcess(f);
    f.faux.setResponses([...toGate(c.review), ...(c.again ? [respond(c.review!)] : [])]);
    const { runId } = await startRun(p);
    const run = await reach(p, runId, ["waiting"], "merge");
    assert.match(run.reason, c.reason, c.what);
    if (c.final !== undefined) assert.equal(run.risk.final, c.final, c.what);
    assert.equal(f.github.merges.length, 0, c.what);
  }
});

test("a floor is recorded on the run: the reviewer's score and the final one, and why", async (t) => {
  const f = fixture(t, { merge: { ...AUTO, sensitivePaths: ["infra/**"] } });
  f.github.pr = { ...f.github.pr, changedFiles: ["infra/main.tf"] };
  const p = await openProcess(f);
  f.faux.setResponses(toGate(reply.review("APPROVED", 1)));
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["waiting"], "merge");
  assert.deepEqual([run.risk.model, run.risk.final], [1, 4]);
  assert.deepEqual(run.risk.floors, ["touches sensitive paths (infra/main.tf)"]);
  assert.match(run.reason, /the change touches sensitive paths \(infra\/main\.tf\)/);
});

test("GitHub refusing the merge fails the stage with its message and waits for a person", async (t) => {
  const f = fixture(t, { merge: AUTO });
  f.github.mergeError = "Pull request is not mergeable: the head branch is behind";
  const p = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.equal(stageOf(run, "merge").status, "failed");
  assert.match(run.reason, /GitHub did not merge pull request #12: Pull request is not mergeable: the head branch is behind/);
});

test("a run waiting at the merge gate survives a restart and can still be approved", async (t) => {
  const f = fixture(t, { merge: { approvers: [APPROVER] } });
  const first = await openProcess(f);
  f.faux.setResponses(toGate());
  const { runId } = await startRun(first);
  await reach(first, runId, ["waiting"], "merge");
  await first.close();

  const second = await openProcess(f);
  const waiting = await reach(second, runId, ["waiting"], "merge");
  assert.equal(waiting.pr.reviewedHead, HEAD);
  assert.equal(f.faux.state.callCount, 3, "no stage ran again");
  await second.store.decideFactoryRun(runId, "approve", APPROVER, HEAD);
  const run = await reach(second, runId, ["completed"]);
  assert.equal(f.github.merges.length, 1);
  assert.equal(run.gate.by, APPROVER);
});

// ── Deploy ───────────────────────────────────────────────────────────────────────────────────────────────────

test("deploy: a person's approval of the merge is the deployer's approval; its brief has the environment, the commit and who approved", async (t) => {
  const f = fixture(t, { deployer: true, merge: { approvers: [APPROVER], deployEnvironment: "production" } });
  const p = await openProcess(f);
  let brief = "";
  f.faux.setResponses([...toGate(), respond(reply.deploy(), (c) => { brief = briefOf(c); })]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");
  await p.store.decideFactoryRun(runId, "approve", APPROVER, HEAD);
  const run = await reach(p, runId, ["completed"]);
  assert.deepEqual(statuses(run), ["success", "success", "success", "success", "success"]);
  assert.match(brief, /Deploy the merged change to production\./);
  assert.ok(brief.includes(`Commit: ${run.pr.mergeCommit}`) && run.pr.mergeCommit.length === 40);
  assert.match(brief, /Approval: given by <@U1ADMIN> through the workflow's merge gate\./);
  assert.equal(stageOf(run, "deploy").attempts[0]!.role, "cloudflare_deployer");
});

test("deploy: after an automatic merge nobody has approved it, so the deployer waits for an approver; approving runs it, declining skips it", async (t) => {
  for (const decision of ["approve", "decline"] as const) {
    const f = fixture(t, { deployer: true, merge: { ...AUTO, approvers: [APPROVER] } });
    const p = await openProcess(f);
    let brief = "";
    f.faux.setResponses([...toGate(), respond(reply.deploy(), (c) => { brief = briefOf(c); })]);
    const { runId } = await startRun(p);
    const waiting = await reach(p, runId, ["waiting"], "deploy");
    assert.equal(f.github.merges.length, 1, "it merged by itself");
    assert.match(waiting.reason, /^Waiting for approval to run deploy \(the cloudflare_deployer role needs a person's approval\)/);
    assert.equal(f.faux.state.callCount, 3, "the deployer has not run");
    await p.store.decideFactoryRun(runId, decision, APPROVER);
    const run = await reach(p, runId, ["completed"]);
    if (decision === "approve") {
      assert.equal(stageOf(run, "deploy").status, "success");
      assert.match(brief, /Approval: given by <@U1ADMIN>/);
      assert.equal(f.faux.state.callCount, 4);
    } else {
      assert.equal(stageOf(run, "deploy").status, "skipped");
      assert.match(stageOf(run, "deploy").attempts[0]!.summary, /declined by <@U1ADMIN>/);
      assert.equal(f.faux.state.callCount, 3, "declined: the deployer never ran");
    }
  }
});

// ── Restarts ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Close the store while `stage`'s model call is in flight, then open it again as a restarted process would. */
async function restartDuring(f: Fixture, t: TestContext, before: ReturnType<typeof respond>[], after: ReturnType<typeof respond>[], definition?: WorkflowDefinition) {
  const first = await openProcess(f);
  const cut = held("STATUS: done\nNEXT: none\nthis answer is never seen");
  f.faux.setResponses([...before, cut.factory, ...after]);
  const { runId } = await startRun(first, definition ? { definition } : {});
  await cut.reached;
  const mid = await first.store.factoryRun(runId);
  await first.close();
  cut.release();
  const second = await openProcess(f);
  return { runId, mid: mid!, second };
}

test("a restart in a stage that only reads (review): it is run again by itself under a new key, and the cut-off one stays on record as interrupted", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const { runId, mid, second } = await restartDuring(f, t, [respond(reply.triage()), respond(reply.implement())], [respond(reply.review("APPROVED", 2))]);
  const cutKey = stageOf(mid, "review").attempts[0]!.runKey;
  const run = await reach(second, runId, ["completed"]);
  const attempts = stageOf(run, "review").attempts;
  assert.deepEqual(attempts.map((a) => a.status), ["interrupted", "done"]);
  assert.equal(attempts[0]!.runKey, cutKey);
  assert.notEqual(attempts[1]!.runKey, cutKey);
  assert.equal(stageOf(run, "review").entries, 1, "a replay is not a new entry");
  assert.equal(f.faux.state.callCount, 4);
  const interrupted = second.timeline.read().filter((e) => e.runKey === cutKey && e.status === "interrupted");
  assert.equal(interrupted.length, 1, "the timeline says interrupted, not cancelled");
});

test("a restart in a stage that writes and cannot be resumed: the run needs a decision and the role is not run again by itself", async (t) => {
  const f = fixture(t, { merge: { ...AUTO, approvers: [APPROVER] } });
  const { runId, mid, second } = await restartDuring(f, t, [respond(reply.triage())], [], NO_RESUME_WORKFLOW);
  const cutKey = stageOf(mid, "implement").attempts[0]!.runKey;
  const run = await reach(second, runId, ["needs_decision"], "decide");
  assert.equal(f.faux.state.callCount, 2, "the coder ran once and was not repeated");
  assert.match(run.reason, /Stage "implement" was interrupted \(the harness stopped while the coder role worked\), so it may or may not have taken effect\./);
  assert.deepEqual(stageOf(run, "implement").attempts.map((a) => [a.runKey, a.status]), [[cutKey, "interrupted"]]);
  assert.equal(stageOf(run, "implement").status, "in_progress");

  // A decision that does not answer this, and one from a stranger, change nothing.
  await assert.rejects(second.store.decideFactoryRun(runId, "approve", APPROVER), /waiting on an interrupted stage: retry or skip or abort answers it/);
  await second.store.decideFactoryRun(runId, "retry", "U9STRANGER");
  await until(async () => /Ignored a decision: <@U9STRANGER>/.test((await second.store.factoryRun(runId))!.reason) || undefined, "stranger ignored");

  // Retry runs the coder again, under a new key, and the run goes on.
  f.faux.setResponses([respond(reply.implement()), respond(reply.review("APPROVED", 2))]);
  await second.store.decideFactoryRun(runId, "retry", APPROVER);
  const done = await reach(second, runId, ["completed"]);
  assert.deepEqual(stageOf(done, "implement").attempts.map((a) => a.status), ["interrupted", "done"]);
  assert.equal(stageOf(done, "implement").entries, 1);
});

test("an interrupted implement stage that is not resumable: skip moves on to review, abort ends the run", async (t) => {
  {
    const f = fixture(t);
    const { runId, second } = await restartDuring(f, t, [respond(reply.triage())], [respond(reply.review("APPROVED", 2))], NO_RESUME_WORKFLOW);
    await reach(second, runId, ["needs_decision"], "decide");
    await second.store.decideFactoryRun(runId, "skip", APPROVER);
    // Review starts (a pull request number of 0 is a fault the fake does not mind); the skipped stage says so.
    const run = await until(async () => { const r = await second.store.factoryRun(runId); return r && stageOf(r, "implement").status === "skipped" && r.current === "review" ? r : undefined; }, "implement skipped");
    assert.match(stageOf(run, "implement").attempts.at(-1)!.summary, /skipped by <@U1ADMIN> after an interruption/);
  }
  {
    const f = fixture(t);
    const { runId, second } = await restartDuring(f, t, [respond(reply.triage())], [], NO_RESUME_WORKFLOW);
    await reach(second, runId, ["needs_decision"], "decide");
    await second.store.decideFactoryRun(runId, "abort", APPROVER);
    const run = await reach(second, runId, ["aborted"]);
    assert.match(run.reason, /aborted by <@U1ADMIN> after an interruption/);
    assert.equal(stageOf(run, "implement").status, "failed");
    assert.deepEqual(await second.store.liveFactoryRuns(), []);
  }
});

// ── Abort and admission ──────────────────────────────────────────────────────────────────────────────────────

test("aborting a run the moment it starts (before its role has begun) ends it, instead of waiting for a role that was never stopped", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses([held(reply.triage()).factory]);
  const { runId } = await startRun(p);
  assert.equal(await p.store.abortFactoryRun(runId, "closed a moment after it started"), "marked");
  const run = await reach(p, runId, ["aborted"]);
  assert.equal(run.reason, "closed a moment after it started");
  assert.deepEqual(await p.store.liveFactoryRuns(), []);
});

test("aborting a run stops the role that is running and says why", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  const slow = held("STATUS: done\nNEXT: coder\nVERDICT: READY");
  f.faux.setResponses([slow.factory]);
  const { runId } = await startRun(p);
  await slow.reached;
  assert.equal(await p.store.abortFactoryRun(runId, "stopped by <@U1ADMIN>"), "marked");
  const run = await reach(p, runId, ["aborted"]);
  assert.equal(run.reason, "stopped by <@U1ADMIN>");
  assert.equal(stageOf(run, "triage").status, "failed");
  assert.equal(stageOf(run, "triage").attempts[0]!.status, "failed");
  assert.deepEqual(await p.store.liveFactoryRuns(), []);
  assert.equal(await p.store.abortFactoryRun(runId, "again"), "terminal", "an ended run has nothing to abort");
});

test("one live run per issue, and no more than three live in a channel", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  const slow = [held("a"), held("b"), held("c")];
  f.faux.setResponses(slow.map((s) => s.factory));
  const one = await startRun(p, { issue: 1 });
  await assert.rejects(startRun(p, { issue: 1 }), new RegExp(`${REPO}#1 already has a live run \\(${one.runId}\\)`));
  await assert.rejects(startRun(p, { issue: 1, repo: "ACME/App" }), /already has a live run/, "the repository compares without case");
  await startRun(p, { issue: 2 });
  await startRun(p, { issue: 3 });
  await assert.rejects(startRun(p, { issue: 4 }), /3 workflow runs are already live in this channel/);
  assert.equal((await p.store.liveFactoryRuns()).length, 3);
  // A run that ends frees its place.
  await p.store.abortFactoryRun(one.runId, "done with it");
  await reach(p, one.runId, ["aborted"]);
  await startRun(p, { issue: 1 });
  for (const s of slow) s.release();
});

test("a workflow that does not validate is refused before anything is created", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  await assert.rejects(p.store.startFactoryRun({
    definition: { name: "bad", version: 1, start: "a", stages: [{ name: "a", kind: "agent", role: "coder", replaySafe: true, on: { done: "nowhere" } }] },
    repo: REPO, issue: 9, issueTitle: "x", issueUrl: "", by: { source: "operator", threadKey: "", userId: "U1" },
  }), /The workflow is not valid: .*leads to "nowhere"/);
  assert.deepEqual(await p.store.listFactoryRuns(), []);
});

test("a channel that is not a factory has no workflow deps: a run fails closed instead of reaching for gh", async (t) => {
  const f = fixture(t);
  delete (f.channel as { factory?: unknown }).factory;
  const p = await openProcess(f);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["failed"]);
  assert.match(run.reason, /workflow runs are not available in this channel's store/);
});
