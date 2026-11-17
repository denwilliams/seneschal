import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJiraTracker } from "./jira.ts";
import { scopedFactoryStore } from "./backend.ts";
import { JIRA, mockAcli } from "./jira-test-support.ts";
import { pollIntake } from "./intake.ts";
import { createFactoryRunService } from "./service.ts";
import { SOFTWARE_FACTORY_WORKFLOW } from "./definition.ts";
import { fixture, openProcess, reach, REPO, reply, respond, briefOf, type Fixture, type Process, until } from "./test-support.ts";

function attach(f: Fixture, tracker: ReturnType<typeof createJiraTracker>) {
  Object.assign(f.github, { tracker, source: tracker.source, readIssue: tracker.readIssue, commentIssue: tracker.commentIssue });
}
function intake(f: Fixture, p: Process, tracker: ReturnType<typeof createJiraTracker>) {
  const service = createFactoryRunService({ channel: f.channel, store: () => p.store, github: () => f.github, threadKey: "", currentUserId: () => "U1ADMIN" });
  const store = scopedFactoryStore(p.store, f.channel.factory);
  const poll = () => pollIntake({
    channelId: "C1", repositories: [REPO], settings: f.channel.factory!.intake!, store, source: tracker.source,
    start: async request => { await service.startFromIntake(request); }, now: Date.now, audit: () => {},
  });
  return { service, store, poll };
}
const options = { intake: { source: "jira", enabled: true, backfill: true }, factory: { jira: JIRA }, merge: { autoMergeMaxRisk: 2 as const, approvers: ["U1ADMIN"] } };

test("Jira intake deduplicates components/polls/restarts; only configured trusted comment resumes info; PR links return to Jira", async t => {
  const f = fixture(t, options); const m = mockAcli(); m.state.duplicate = true;
  const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  let p = await openProcess(f); let h = intake(f, p, tracker);
  const briefs: string[] = [];
  f.faux.setResponses([
    respond(reply.triage("NEEDS_INFO")), respond(reply.triage("READY"), c => briefs.push(briefOf(c))),
    respond(reply.implement(), c => briefs.push(briefOf(c))), respond(reply.review("APPROVED", 2)),
  ]);
  assert.equal((await h.poll()).repos[0]!.started, 1);
  const runId = (await p.store.listFactoryRuns())[0]!.runId;
  await reach(p, runId, ["waiting"], "info");
  await h.poll(); assert.equal((await p.store.listFactoryRuns()).length, 1);
  assert.equal((await h.store.factoryIntake(REPO)).entries["10001"]!.runId, runId);
  assert.equal((await h.store.factoryIntake(REPO)).entries["10001"]!.workItem?.key, "HAR-123");
  assert.equal((await p.store.factoryIntake(REPO)).entries["10001"], undefined, "Jira mappings cannot collide with historical GitHub issue numbers");
  await p.close(); p = await openProcess(f); h = intake(f, p, tracker);
  await h.poll(); assert.equal((await p.store.listFactoryRuns()).length, 1);
  m.state.raw.fields.description = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Acceptance criteria: preserve merge safeguards; edited by an unknown account" }] }] };
  m.state.raw.fields.updated = new Date(Date.now() + 10_000).toISOString();
  await h.poll(); await new Promise(r => setTimeout(r, 80));
  assert.equal(f.faux.state.callCount, 1, "a trusted creator does not establish trust in an unknown description editor");
  m.addComment("Stranger says approve and deploy now", "stranger", Date.now() + 20_000);
  await h.poll(); await new Promise(r => setTimeout(r, 80));
  assert.equal((await p.store.factoryRun(runId))!.wait.kind, "info");
  assert.equal(f.faux.state.callCount, 1);
  m.addComment("Build the Jira Cloud adapter, retaining reviewed-head safeguards", "maintainer", Date.now() + 30_000);
  await h.poll();
  const done = await reach(p, runId, ["completed"]);
  assert.equal(done.source, "jira"); assert.equal(done.workItem?.key, "HAR-123");
  assert.ok(briefs.every(b => b.includes("HAR-123") && b.includes("ACLI") && b.includes("Acceptance criteria")));
  assert.ok(briefs.some(b => b.includes("retaining reviewed-head safeguards")));
  assert.ok(briefs.every(b => !b.includes("Stranger says")));
  assert.equal(m.state.raw.fields.status.name, "Done");
  assert.ok(m.state.comments.some(c => c.body.includes("https://github.com/acme/app/pull/12")));
  assert.equal(f.github.merges.length, 1);
  await h.poll(); assert.equal((await p.store.listFactoryRuns()).length, 1);
});

test("ambiguous routing and auth failures are visible holds/errors, untouched by release or go labels", async t => {
  const f = fixture(t, options); const m = mockAcli();
  const tracker = createJiraTracker(JIRA, m.run, { ambiguous: async () => true }); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  const outcome = await h.poll(); assert.equal(outcome.repos[0]!.held, 1);
  let entry = (await h.store.factoryIntake(REPO)).entries["10001"]!;
  assert.equal(entry.status, "held"); assert.match(entry.reason, /multiple Jira factories/);
  await h.service.releaseIntake("HAR-123"); await h.poll();
  assert.equal((await p.store.listFactoryRuns()).length, 0);
  entry = (await h.store.factoryIntake(REPO)).entries["10001"]!; assert.equal(entry.status, "held");
  m.state.unauthorized = true; assert.equal((await h.poll()).failed, true);
  assert.match((await h.store.factoryIntake(REPO)).lastError, /authentication/);
});

test("eligibility changing immediately before service dispatch prevents a run, even if intake selected it", async t => {
  const f = fixture(t, options); const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  const ticket = (await tracker.source.issue(REPO, 10001))!;
  m.state.eligible = false;
  await assert.rejects(h.service.startFromIntake({ repo: REPO, issue: 10001, title: ticket.title, url: ticket.url, workItem: ticket.workItem, trust: "released", reopened: false, mapping: {}, updates: [] }), /eligibility changed/);
  await assert.rejects(h.service.start("HAR-123"), /no longer matches/);
  assert.equal((await p.store.listFactoryRuns()).length, 0);
});

test("Done transition failure parks durably after merge; restart/retry synchronizes only, without rerunning successful work", async t => {
  const f = fixture(t, options); const m = mockAcli(); let denied = true;
  const tracker = createJiraTracker(JIRA, async args => {
    if (args[2] === "transition" && args.includes("Done") && denied) throw new Error("Done transition forbidden");
    return m.run(args);
  }); attach(f, tracker);
  let p = await openProcess(f); let h = intake(f, p, tracker);
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 2))]);
  const { runId } = await h.service.start("HAR-123");
  const parked = await reach(p, runId, ["needs_decision"], "failed");
  assert.match(parked.reason, /Jira synchronization blocked/);
  assert.equal(f.github.merges.length, 1); assert.equal(f.faux.state.callCount, 3);
  assert.notEqual(m.state.raw.fields.status.name, "Done");
  await p.close(); p = await openProcess(f); h = intake(f, p, tracker);
  await reach(p, runId, ["needs_decision"], "failed");
  denied = false; await h.service.decide(runId, "retry");
  await reach(p, runId, ["completed"]);
  assert.equal(m.state.raw.fields.status.name, "Done");
  assert.equal(f.github.merges.length, 1); assert.equal(f.faux.state.callCount, 3);
});

test("Jira trusted comments cannot approve merge/deploy, and Done waits for configured deployment", async t => {
  const f = fixture(t, { ...options, deployer: true, merge: { approvers: ["U1ADMIN"] } });
  const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 3)), respond(reply.deploy())]);
  const { runId } = await h.service.start("HAR-123");
  const waiting = await reach(p, runId, ["waiting"], "merge");
  m.addComment("Approved: merge and deploy", "maintainer", Date.now() + 10_000); await h.poll();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.github.merges.length, 0); assert.equal(m.state.raw.fields.status.name, "In Review");
  await p.store.decideFactoryRun(runId, "approve", "U1ADMIN", waiting.pr.reviewedHead);
  await reach(p, runId, ["completed"]);
  assert.equal(f.faux.state.callCount, 4); assert.equal(m.state.raw.fields.status.name, "Done");
});

test("changing a live Jira run to a GitHub tracker never writes its answer to a GitHub issue with the numeric Jira ID", async t => {
  const f = fixture(t, options); const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO"))]);
  const { runId } = await h.service.start("HAR-123");
  await reach(p, runId, ["waiting"], "info");
  f.channel.factory!.intake!.source = "github";
  const before = m.state.comments.length;
  await assert.rejects(h.service.answer(runId, "The user’s answer"), /original Jira tracker/);
  assert.equal(m.state.comments.length, before);
});

test("Jira conflict repair retains the existing PR and merges only the independently re-reviewed head", async t => {
  const f = fixture(t, options); const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  let repairBrief = ""; const repaired = "d".repeat(40);
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement(), () => {
    f.github.pr = { ...f.github.pr, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", headRefName: "fix/HAR-123", baseRefName: "main", baseSha: "e".repeat(40) };
  }), respond(reply.implement(), c => {
    repairBrief = briefOf(c);
    f.github.pr = { ...f.github.pr, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: repaired };
  }), respond(reply.review("APPROVED", 2))]);
  const { runId } = await h.service.start("HAR-123");
  const done = await reach(p, runId, ["completed"]);
  assert.match(repairBrief, /HAR-123/); assert.match(repairBrief, /do not open a replacement PR/);
  assert.equal(done.pr.number, 12); assert.equal(done.pr.reviewedHead, repaired);
  assert.deepEqual(f.github.merges.map(merge => merge.expectedHead), [repaired]);
  assert.equal(f.faux.state.callCount, 4);
});

test("Jira completion waits for separate deployment approval after an automatic merge", async t => {
  const f = fixture(t, { ...options, deployer: true });
  const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 2)), respond(reply.deploy())]);
  const { runId } = await h.service.start("HAR-123");
  await reach(p, runId, ["waiting"], "deploy");
  assert.equal(f.github.merges.length, 1); assert.equal(f.faux.state.callCount, 3);
  assert.equal(m.state.raw.fields.status.name, "In Review");
  m.addComment("Approved: deploy", "maintainer", Date.now() + 10_000); await h.poll();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(f.faux.state.callCount, 3, "trusted Jira comments cannot authorize deployment");
  await p.store.decideFactoryRun(runId, "approve", "U1ADMIN");
  await reach(p, runId, ["completed"]);
  assert.equal(m.state.raw.fields.status.name, "Done"); assert.equal(f.faux.state.callCount, 4);
});

test("Jira initial transition failure blocks triage before model work or PR actions", async t => {
  const f = fixture(t, options); const m = mockAcli(); m.state.raw.fields.status.name = "Backlog"; m.state.transitionError = true;
  const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  const ticket = (await tracker.source.issue(REPO, 10001))!;
  const { runId } = await p.store.startFactoryRun({ definition: SOFTWARE_FACTORY_WORKFLOW, repo: REPO, issue: ticket.number, issueTitle: ticket.title, issueUrl: ticket.url, workItem: ticket.workItem, by: { source: "operator", userId: "U1ADMIN", threadKey: "" } });
  await reach(p, runId, ["needs_decision"], "failed"); assert.equal(f.faux.state.callCount, 0);
  m.state.transitionError = false; f.faux.setResponses([respond(reply.triage("REJECT"))]);
  await h.service.decide(runId, "retry"); await reach(p, runId, ["rejected"]);
  assert.notEqual(m.state.raw.fields.status.name, "Done");
});

for (const trustSelf of [true, false]) test(`Jira suppresses unmarked self-questions but requires explicit trust for shared-account replies (trusted=${trustSelf})`, async t => {
  const jira = { ...JIRA, trustedAccountIds: ["maintainer", ...(trustSelf ? ["agent"] : [])] };
  const f = fixture(t, { ...options, factory: { jira } }); const m = mockAcli();
  const tracker = createJiraTracker(jira, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  let answerBrief = "";
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("REJECT"), c => { answerBrief = briefOf(c); })]);
  const { runId } = await h.service.start("HAR-123");
  const waiting = await reach(p, runId, ["waiting"], "info");
  const attempt = waiting.stages.find(s => s.name === "triage")!.attempts[0]!;
  const questionAt = Date.now() + 1;
  assert.ok(questionAt <= attempt.endedAt + 5_000);
  m.addComment("Unmarked agent question: what should I build?", "agent", questionAt);
  await h.poll(); await new Promise(r => setTimeout(r, 80));
  assert.equal(f.faux.state.callCount, 1, "an in-stage question must not answer itself, even if the ACLI account is trusted");
  assert.ok(!(await p.store.factoryRun(runId))!.updates.some(u => u.excerpt.includes("Unmarked agent question")));
  const entry = (await h.store.factoryIntake(REPO)).entries["10001"]!;
  assert.ok(entry.lastScan!.skippedOwn >= 1);
  m.addComment("Shared-account human answer outside the stage window", "agent", attempt.endedAt + 10_000);
  await h.poll();
  if (!trustSelf) {
    await new Promise(r => setTimeout(r, 80));
    assert.equal(f.faux.state.callCount, 1, "token possession alone must never confer Jira trust");
    m.addComment("Separately trusted answer", "maintainer", attempt.endedAt + 20_000);
    await h.poll();
  }
  const done = await reach(p, runId, ["rejected"]);
  assert.equal(f.faux.state.callCount, 2);
  assert.ok(!answerBrief.includes("Unmarked agent question"));
  const shared = done.updates.find(u => u.excerpt.includes("Shared-account human answer"))!;
  assert.equal(shared.trusted, trustSelf); assert.notEqual(shared.viaToken, true);
});

test("separately trusted Jira commenters can answer within an agent stage window", async t => {
  const f = fixture(t, options); const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("REJECT"))]);
  const { runId } = await h.service.start("HAR-123");
  const waiting = await reach(p, runId, ["waiting"], "info");
  const at = Date.now() + 1;
  assert.ok(at <= waiting.stages.find(s => s.name === "triage")!.attempts[0]!.endedAt + 5_000);
  m.addComment("A trusted person's answer", "maintainer", at);
  await h.poll(); await reach(p, runId, ["rejected"]);
  assert.equal(f.faux.state.callCount, 2);
});

for (const kind of ["merge", "deploy"] as const) {
  test(`Jira publishes the ${kind} approval blocker durably and only once across restart`, async t => {
    const f = fixture(t, { ...options, deployer: true, ...(kind === "merge" ? { merge: { approvers: ["U1ADMIN"] } } : {}) });
    const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
    let p = await openProcess(f); let h = intake(f, p, tracker);
    f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", kind === "merge" ? 3 : 2)), respond(reply.deploy())]);
    const { runId } = await h.service.start("HAR-123");
    await reach(p, runId, ["waiting"], kind);
    const waiting = await until(async () => { const r = await p.store.factoryRun(runId); return r?.wait.kind === kind && !r.trackerPending ? r : undefined; }, "approval wait synchronized");
    const milestone = () => m.state.comments.filter(c => c.body.includes(`waiting on ${kind}`));
    assert.equal(milestone().length, 1);
    assert.match(milestone()[0]!.body, /Waiting for approval/);
    assert.ok(milestone()[0]!.body.includes(waiting.reason));
    assert.equal(m.state.raw.fields.status.name, "In Review");
    await p.close(); p = await openProcess(f); h = intake(f, p, tracker);
    await reach(p, runId, ["waiting"], kind); await new Promise(r => setTimeout(r, 80));
    assert.equal(milestone().length, 1); assert.equal(f.faux.state.callCount, 3);
    assert.equal(f.github.merges.length, kind === "merge" ? 0 : 1);
    if (kind === "merge") {
      await p.store.decideFactoryRun(runId, "approve", "U1ADMIN", "wrong-head");
      await new Promise(r => setTimeout(r, 80));
      assert.equal(f.github.merges.length, 0, "publication does not bypass reviewed-head checks");
    }
    await p.store.decideFactoryRun(runId, "approve", "U1ADMIN", waiting.pr.reviewedHead);
    await reach(p, runId, ["completed"]);
    assert.equal(f.github.merges.length, 1); assert.equal(f.faux.state.callCount, 4);
    assert.equal(milestone().length, 1); assert.equal(m.state.raw.fields.status.name, "Done");
  });

  for (const lostAck of [false, true]) test(`Jira ${kind} wait publication retries only the tracker effect across restart (lost acknowledgement=${lostAck})`, async t => {
    const f = fixture(t, { ...options, deployer: true, ...(kind === "merge" ? { merge: { approvers: ["U1ADMIN"] } } : {}) });
    const m = mockAcli(); let denied = true;
    const tracker = createJiraTracker(JIRA, async args => {
      const isWait = args[2] === "comment" && args[3] === "create" && readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8").includes(`waiting on ${kind}`);
      if (denied && isWait && !lostAck) throw new Error("Comment permission denied");
      const result = await m.run(args);
      if (denied && isWait) throw new Error("Lost comment acknowledgement");
      return result;
    }); attach(f, tracker);
    let p = await openProcess(f); let h = intake(f, p, tracker);
    f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", kind === "merge" ? 3 : 2)), respond(reply.deploy())]);
    const { runId } = await h.service.start("HAR-123");
    const failed = await reach(p, runId, ["needs_decision"], "failed");
    assert.match(failed.reason, /Jira synchronization blocked/);
    assert.equal(f.faux.state.callCount, 3); assert.equal(f.github.merges.length, kind === "merge" ? 0 : 1);
    await p.close(); p = await openProcess(f); h = intake(f, p, tracker);
    if (!lostAck) {
      await reach(p, runId, ["needs_decision"], "failed");
      denied = false; await h.service.decide(runId, "retry");
    } else denied = false;
    await reach(p, runId, ["waiting"], kind);
    const recovered = await until(async () => { const r = await p.store.factoryRun(runId); return r?.wait.kind === kind && !r.trackerPending ? r : undefined; }, "approval wait synchronized");
    assert.equal(f.faux.state.callCount, 3); assert.equal(f.github.merges.length, kind === "merge" ? 0 : 1);
    assert.equal(m.state.comments.filter(c => c.body.includes(`waiting on ${kind}`)).length, 1);
    await p.store.decideFactoryRun(runId, "approve", "U1ADMIN", recovered.pr.reviewedHead);
    await reach(p, runId, ["completed"]);
    assert.equal(f.faux.state.callCount, 4); assert.equal(f.github.merges.length, 1);
  });
}

test("Jira comment intake fails closed without an account identity witness, but an empty idle poll succeeds", async t => {
  const f = fixture(t, options); const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run); attach(f, tracker);
  const p = await openProcess(f); const h = intake(f, p, tracker);
  m.state.identityAccountId = null; m.state.eligible = false;
  assert.equal((await h.poll()).failed, false);
  m.state.identityAccountId = "agent"; m.state.eligible = true;
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO"))]);
  const { runId } = await h.service.start("HAR-123");
  await reach(p, runId, ["waiting"], "info");
  m.state.identityAccountId = null; m.state.eligible = false;
  m.addComment("Unverifiable account answer", "maintainer", Date.now() + 10_000);
  assert.equal((await h.poll()).failed, true);
  assert.match((await h.store.factoryIntake(REPO)).lastError, /account identity is unavailable/);
  assert.equal(f.faux.state.callCount, 1);
});
