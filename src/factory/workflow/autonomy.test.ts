import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessConfigSchema } from "../../config/schema.ts";
import { DEFAULT_REVIEW_ROUNDS, MAX_AUTO_RESUMES, SOFTWARE_FACTORY_WORKFLOW, softwareFactoryWorkflow, validateWorkflow } from "./definition.ts";
import { readStageReport } from "./report.ts";
import { briefOf, fixture, held, openProcess, reach, REPO, reply, respond, stageOf, startRun, statuses } from "./test-support.ts";
import { emptyFactoryRun } from "./docs.ts";
import { stuckGuide, stuckText } from "./unstick.ts";
import { channelWorkflow, liveLimit } from "./service.ts";
import { effectiveAutonomy } from "./autonomy.ts";

/**
 * Fewer reasons for a run to wait for a person, and a plain account of the ones that remain: what the settings and the engine do
 * (docs/FACTORY_WORKFLOW_DESIGN.md "Why a run stops, and how to get it going").
 */

const AUTO = { autoMergeMaxRisk: 2 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────

test("reviewRounds, maxLiveRuns and assumeAfterHours: bounded, and the defaults are today's behaviour", () => {
  const parse = (factory: object) => HarnessConfigSchema.safeParse({ channels: { eng: { factory: { name: "F", repositories: ["acme/web"], ...factory } } } });
  const plain = parse({});
  assert.ok(plain.success);
  assert.deepEqual([plain.data.channels.eng!.factory!.reviewRounds, plain.data.channels.eng!.factory!.maxLiveRuns], [undefined, 3], "rounds are the level's unless set: 3 for a factory with no level");
  assert.equal(effectiveAutonomy(plain.data.channels.eng!.factory, "acme/web").knobs.reviewRounds.value, 3);
  assert.equal(parse({ reviewRounds: 0 }).success, false);
  assert.equal(parse({ reviewRounds: 11 }).success, false);
  assert.equal(parse({ reviewRounds: 2.5 }).success, false);
  assert.equal(parse({ maxLiveRuns: 0 }).success, false);
  assert.equal(parse({ maxLiveRuns: 11 }).success, false);
  const on = parse({ intake: { enabled: true, assumeAfterHours: 24 } });
  assert.ok(on.success);
  assert.equal(on.data.channels.eng!.factory!.intake!.assumeAfterHours, 24);
  assert.equal(parse({ intake: { enabled: true, assumeAfterHours: -1 } }).success, false);
  assert.equal(parse({ intake: { enabled: true, assumeAfterHours: 1000 } }).success, false);
});

test("the channel's review rounds shape the workflow it is started with, and it still validates", () => {
  assert.equal(softwareFactoryWorkflow(), SOFTWARE_FACTORY_WORKFLOW);
  assert.equal(softwareFactoryWorkflow({ reviewRounds: DEFAULT_REVIEW_ROUNDS }), SOFTWARE_FACTORY_WORKFLOW);
  const five = softwareFactoryWorkflow({ reviewRounds: 5 });
  assert.equal(five.stages.find((s) => s.name === "review")!.maxEntries, 5);
  assert.deepEqual(validateWorkflow(five), []);
  assert.equal(SOFTWARE_FACTORY_WORKFLOW.stages.find((s) => s.name === "review")!.maxEntries, 3, "the shipped definition is not changed");
  const config = HarnessConfigSchema.parse({ channels: { eng: { factory: { name: "F", repositories: ["acme/web"], reviewRounds: 6, maxLiveRuns: 7 } } } });
  const channel = { factory: config.channels.eng!.factory };
  assert.equal(channelWorkflow(channel, "acme/web").stages.find((s) => s.name === "review")!.maxEntries, 6);
  assert.equal(liveLimit(channel), 7);
  assert.equal(liveLimit({ factory: undefined }), 3);
});

test("the coder is the stage a restart does not stop for a person; the deploy is not", () => {
  const byName = Object.fromEntries(SOFTWARE_FACTORY_WORKFLOW.stages.map((s) => [s.name, s]));
  assert.equal(byName.implement!.resumable, true);
  assert.equal(byName.deploy!.resumable, undefined);
  assert.ok(MAX_AUTO_RESUMES >= 1);
});

// ── reports ──────────────────────────────────────────────────────────────────────────────────────────────

test("triage that reports needs_input or blocked is asking for information, not failing", () => {
  const triage = SOFTWARE_FACTORY_WORKFLOW.stages[0]!;
  const report = (status: "needs_input" | "blocked") => ({ status, summary: "Which persona types?", next: "", durationMs: 1, costUsd: 0, steps: 1, runKey: "k" }) as never;
  assert.deepEqual(readStageReport(triage, report("needs_input"), { repo: REPO, issue: 7 }), { kind: "verdict", verdict: "needs_info" });
  assert.deepEqual(readStageReport(triage, report("blocked"), { repo: REPO, issue: 7 }), { kind: "verdict", verdict: "needs_info" });
  const coder = SOFTWARE_FACTORY_WORKFLOW.stages[1]!;
  assert.deepEqual(readStageReport(coder, report("blocked"), { repo: REPO, issue: 7 }), { kind: "verdict", verdict: "blocked" }, "the coder's blocked is still its own arrow");
});

// ── the engine ───────────────────────────────────────────────────────────────────────────────────────────────

test("a reviewer that forgets its risk score is asked for it once, and a change it then scores low merges by itself", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const p = await openProcess(f);
  const briefs: string[] = [];
  f.faux.setResponses([
    respond(reply.triage("READY")), respond(reply.implement()),
    respond("STATUS: done\nNEXT: none\nVERDICT: APPROVED\nLooks right."),
    respond(reply.review("APPROVED", 2), (c) => briefs.push(briefOf(c))),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);
  assert.deepEqual(stageOf(run, "review").attempts.map((a) => [a.reask, a.status]), [[false, "done"], [true, "done"]]);
  assert.match(briefs[0]!, /Missing: a `RISK: <1-5>` line/);
  assert.deepEqual([run.risk.model, run.risk.scored, run.gate.by], [2, true, "auto"]);
  assert.equal(f.github.merges.length, 1);
});

test("a coder cut off by a restart is run again by the engine, told to look for what is left, and the run completes", async (t) => {
  const f = fixture(t, { merge: AUTO });
  const first = await openProcess(f);
  const cut = held("STATUS: done\nNEXT: none\nnever seen");
  const briefs: string[] = [];
  f.faux.setResponses([respond(reply.triage("READY")), cut.factory, respond(reply.implement(), (c) => briefs.push(briefOf(c))), respond(reply.review("APPROVED", 2))]);
  const { runId } = await startRun(first);
  await cut.reached;
  await first.close();
  cut.release();
  const second = await openProcess(f);
  const run = await reach(second, runId, ["completed"]);
  assert.deepEqual(stageOf(run, "implement").attempts.map((a) => a.status), ["interrupted", "done"]);
  assert.equal(stageOf(run, "implement").entries, 1, "a resume is not a new round");
  assert.match(briefs[0]!, /cut off when the harness restarted/);
  assert.match(briefs[0]!, /do not open another pull request/);
  assert.match(briefs[0]!, /Do not stop to ask/);
});

test("triage is told to prefer going ahead and to ask everything at once; nobody answering makes it go on with assumptions, once", async (t) => {
  const f = fixture(t, { assumeAfterMs: 300, needsInfoMs: 60_000, merge: AUTO });
  const p = await openProcess(f);
  const briefs: string[] = [];
  f.faux.setResponses([
    respond(reply.triage("NEEDS_INFO"), (c) => briefs.push(briefOf(c))),
    respond(reply.triage("READY"), (c) => briefs.push(briefOf(c))),
    respond(reply.implement()), respond(reply.review("APPROVED", 2)),
  ]);
  const { runId } = await startRun(p);
  const done = await reach(p, runId, ["completed"]);
  assert.equal(done.assumed, true);
  assert.match(briefs[0]!, /Prefer going ahead/);
  assert.match(briefs[0]!, /ONE comment/);
  assert.ok(!/You may not ask again/.test(briefs[0]!), "the first round may ask");
  assert.match(briefs[1]!, /You may not ask again/);
  assert.equal(stageOf(done, "triage").entries, 2);
});

test("a run that already went on with assumptions and asks again waits for a person: assuming happens once", async (t) => {
  const f = fixture(t, { assumeAfterMs: 200, needsInfoMs: 60_000 });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("NEEDS_INFO")), respond(reply.triage("READY"))]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "info");
  await pause(1200);
  const run = (await p.store.factoryRun(runId))!;
  assert.deepEqual([run.status, run.wait.kind, run.assumed, f.faux.state.callCount], ["waiting", "info", true, 2], "two triage runs and no third");
  await p.store.abortFactoryRun(runId, "test over");
});

test("without assumeAfterHours a run waits for its answer however long it takes", async (t) => {
  const f = fixture(t, { needsInfoMs: 60_000 });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("READY"))]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "info");
  await pause(500);
  const run = (await p.store.factoryRun(runId))!;
  assert.deepEqual([run.status, run.wait.kind, run.assumed ?? false, f.faux.state.callCount], ["waiting", "info", false, 1]);
  await p.store.abortFactoryRun(runId, "test over");
});

test("maxLiveRuns lets a channel hold more runs than the default, or fewer", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  const one = held(reply.triage("READY"));
  f.faux.setResponses([one.factory, one.factory]);
  const first = await p.store.startFactoryRun({ definition: SOFTWARE_FACTORY_WORKFLOW, repo: REPO, issue: 7, issueTitle: "a", issueUrl: "", by: { source: "operator", threadKey: "", userId: "U1" }, maxLive: 1 });
  await assert.rejects(
    p.store.startFactoryRun({ definition: SOFTWARE_FACTORY_WORKFLOW, repo: REPO, issue: 8, issueTitle: "b", issueUrl: "", by: { source: "operator", threadKey: "", userId: "U1" }, maxLive: 1 }),
    /1 workflow runs are already live/,
  );
  await p.store.startFactoryRun({ definition: SOFTWARE_FACTORY_WORKFLOW, repo: REPO, issue: 8, issueTitle: "b", issueUrl: "", by: { source: "operator", threadKey: "", userId: "U1" }, maxLive: 2 });
  one.release();
  await p.store.abortFactoryRun(first.runId, "test over");
});

// ── how to get a stuck run going ─────────────────────────────────────────────────────────────────────────────

const runWith = (fields: Partial<ReturnType<typeof emptyFactoryRun>>) => ({ ...emptyFactoryRun("fr_x"), ...fields });

test("every state that waits for a person says what it waits for and how to move it", () => {
  const cases: [Partial<ReturnType<typeof emptyFactoryRun>>, RegExp, RegExp][] = [
    [{ status: "waiting", wait: { kind: "info", since: 1 } }, /answer to triage's question/, /Reply in the run's Slack thread[\s\S]*comment on the issue[\s\S]*factory_recheck_issue/],
    [{ status: "waiting", wait: { kind: "merge", since: 1 } }, /approve the merge/, /merge the pull request yourself on GitHub[\s\S]*autoMergeMaxRisk[\s\S]*required check/],
    [{ status: "waiting", wait: { kind: "deploy", since: 1 } }, /approve the deploy/, /cloudflare_deployer: \{ enabled: false \}/],
    [{ status: "waiting", wait: { kind: "rounds", since: 1 } }, /another round/, /One more round[\s\S]*factory\.reviewRounds/],
    [{ status: "needs_decision", wait: { kind: "decide", since: 1 }, current: "deploy" }, /interrupted/, /Retry or Abort/],
    [{ status: "failed" }, /ended failed/, /retry/],
    [{ status: "rejected" }, /ended rejected/, /factory:go/],
  ];
  for (const [fields, waitingFor, ways] of cases) {
    const guide = stuckGuide(runWith(fields));
    assert.ok(guide, JSON.stringify(fields));
    assert.match(guide.waitingFor, waitingFor);
    assert.match(guide.ways.join(" "), ways);
    assert.ok(stuckText(guide).length > 40);
  }
  assert.equal(stuckGuide(runWith({ status: "running" })), undefined);
  assert.equal(stuckGuide(runWith({ status: "completed" })), undefined);
});

test("a failed stage's guide offers skip only for an optional stage and names the stages before it", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("READY")), respond("STATUS: failed\nNEXT: none\nnpm test: 3 failures")]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  const guide = stuckGuide(run)!;
  assert.match(guide.waitingFor, /"implement" stage, which failed/);
  const text = guide.ways.join(" ");
  assert.match(text, /restart from an earlier stage \(triage\)/);
  assert.ok(!/Skip it/.test(text), "implement is not optional");
  assert.match(text, /Retry keeps the pull request/);
  assert.deepEqual(statuses(run).slice(0, 2), ["success", "failed"]);
});
