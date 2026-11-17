import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeSource, fixture, held, openProcess, reach, reply, respond, stageOf, startRun, briefOf, type Fixture, type Process } from "./test-support.ts";
import { COMMENT_RULES_VERSION, pollIntake, rewindPoint, type IntakeContext } from "./intake.ts";
import { createFactoryRunService, FactoryRunError } from "./service.ts";
import { trustedUpdatesSince } from "./transitions.ts";
import { emptyFactoryRun, type RunUpdate } from "./docs.ts";
import { agentFooter } from "./footer.ts";
import { REPO } from "./test-support.ts";

/**
 * A run stuck waiting for an answer that was given on GitHub and never read: comments the harness threw away under the old rules
 * (its own account was skipped whole) are read again once, and a person can ask for the same for one run.
 * docs/FACTORY_WORKFLOW_DESIGN.md section 22.
 */

const MIN = 60_000;
const ME = "den"; // the token's account, and the person's
const INTAKE = { enabled: true } as const;

function harness(f: Fixture, p: Process, user = "UAPPR") {
  const source = f.github.source as FakeSource;
  source.login = ME;
  const clock = { t: Date.now() };
  const audits: [string, Record<string, unknown>][] = [];
  let kicks = 0;
  const service = createFactoryRunService({ channel: f.channel, store: () => p.store, github: () => f.github, threadKey: "", currentUserId: () => user, source: "operator", intake: { kick: () => { kicks++; } } });
  const intakeService = createFactoryRunService({ channel: f.channel, store: () => p.store, github: () => f.github, threadKey: "", currentUserId: () => "", source: "operator" });
  const ctx = (): IntakeContext => ({
    channelId: "C1", repositories: f.channel.factory!.repositories, settings: f.channel.factory!.intake!, store: p.store, source,
    start: async (request) => { await intakeService.startFromIntake(request); },
    now: () => clock.t, audit: (event, fields) => { audits.push([event, fields]); },
  });
  const poll = () => pollIntake(ctx());
  const runs = async () => (await p.store.listFactoryRuns(100)).sort((a, b) => a.issue - b.issue);
  return { source, clock, audits, poll, runs, service, kicks: () => kicks };
}

async function begin(h: ReturnType<typeof harness>, issue: number) {
  await h.poll();
  h.clock.t += 10 * MIN;
  h.source.put(issue, { at: h.clock.t, author: ME, association: "OWNER" });
  await h.poll();
  return (await h.runs())[0]!;
}

/** What an older build left behind: the comment was read and thrown away, and the watermark moved past it. */
async function asIfDropped(p: Process, issue: number, at: number, commentRules?: number) {
  await p.store.mutateFactoryIntake(REPO, (data) => {
    const entry = data.entries[String(issue)]!;
    entry.commentWatermark = at;
    entry.comments = 1;
    entry.lastUpdatedAt = at;
    if (commentRules === undefined) delete data.commentRules; else data.commentRules = commentRules;
  });
}

test("a person's answer that an older build threw away is found by the one-time re-read, and triage carries on with it", async (t) => {
  const f = fixture(t, { intake: INTAKE });
  const p = await openProcess(f);
  const h = harness(f, p);
  const briefs: string[] = [];
  const implement = held(reply.implement());
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO"), (c) => briefs.push(briefOf(c))), respond(reply.triage("READY"), (c) => briefs.push(briefOf(c))), implement.factory]);
  const run = await begin(h, 40);
  const waiting = await reach(p, run.runId, ["waiting"], "info");
  const ended = stageOf(waiting, "triage").attempts[0]!.endedAt;

  h.clock.t = Math.max(h.clock.t, ended) + MIN;
  h.source.comment(40, { author: ME, association: "OWNER", body: `Which personas?\n\n${agentFooter({ role: "github_triage", stage: "triage", runId: run.runId })}`, at: h.clock.t });
  h.clock.t += MIN;
  h.source.comment(40, { author: ME, association: "OWNER", body: "Admin, Editor and Viewer.", at: h.clock.t });
  await asIfDropped(p, 40, h.clock.t); // the old build skipped both comments (they are the token's) and moved on

  await h.poll();
  await implement.reached;
  const after = (await p.store.factoryRun(run.runId))!;
  assert.deepEqual(after.updates.map((u) => [u.author, u.trusted, u.viaToken]), [[ME, true, true]], "the answer, and not the agent's question");
  assert.equal(stageOf(after, "triage").entries, 2, "triage ran again");
  assert.match(briefs[1]!, /Admin, Editor and Viewer\./, "the answer is in the brief");
  assert.ok(!/Which personas\?/.test(briefs[1]!.split("New on the issue")[1] ?? ""), "the question is not handed back as news");
  const data = await p.store.factoryIntake(REPO);
  assert.equal(data.commentRules, COMMENT_RULES_VERSION, "done once");
  assert.ok(h.audits.some(([event, fields]) => event === "intake_recheck" && fields.why === "comment rules changed"));
  const scan = h.audits.find(([event]) => event === "intake_comments")![1];
  assert.deepEqual([scan.fetched, scan.delivered, scan.skippedByFooter, scan.rechecked], [2, 1, 1, true], "counts only, and the question was skipped for its footer");

  // And it is only once: a second poll reads nothing again and tells the run nothing twice.
  const before = h.audits.length;
  await h.poll();
  assert.equal(h.audits.slice(before).filter(([event]) => event === "intake_recheck").length, 0);
  assert.equal((await p.store.factoryRun(run.runId))!.updates.length, 1);
  implement.release();
  await p.store.abortFactoryRun(run.runId, "test over");
});

test("a repository already on the current rules is not re-read; a run that is not waiting for information is left alone", async (t) => {
  const f = fixture(t, { intake: INTAKE });
  const p = await openProcess(f);
  const h = harness(f, p);
  const triage = held(reply.triage());
  f.faux.setResponses([triage.factory]);
  const run = await begin(h, 41);
  await triage.reached; // running, not waiting
  h.source.comment(41, { author: "maintainer", association: "MEMBER", body: "fyi", at: h.clock.t + MIN });
  await asIfDropped(p, 41, h.clock.t + MIN, undefined);
  const calls = h.source.calls.comments;
  await h.poll();
  assert.equal(h.source.calls.comments, calls, "the comment list was not asked for a run that is not waiting for an answer");
  assert.equal((await p.store.factoryIntake(REPO)).commentRules, COMMENT_RULES_VERSION);
  triage.release();
  await p.store.abortFactoryRun(run.runId, "test over");
});

test("what the run already has is not told twice: a re-read finds the same comment and leaves the run's updates alone", async (t) => {
  const f = fixture(t, { intake: INTAKE });
  const p = await openProcess(f);
  const h = harness(f, p);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), held(reply.implement()).factory]);
  const run = await begin(h, 42);
  const waiting = await reach(p, run.runId, ["waiting"], "info");
  h.clock.t = Math.max(h.clock.t, stageOf(waiting, "triage").attempts[0]!.endedAt) + MIN;
  // A stranger's comment: recorded for the console, never shown to a role, and it does not wake the run.
  h.source.comment(42, { author: "stranger", association: "NONE", body: "me too", at: h.clock.t });
  await h.poll();
  assert.equal((await p.store.factoryRun(run.runId))!.updates.length, 1);
  await p.store.mutateFactoryIntake(REPO, (d) => { d.entries["42"]!.recheck = true; });
  await h.poll();
  const after = (await p.store.factoryRun(run.runId))!;
  assert.equal(after.updates.length, 1, "not recorded a second time");
  assert.equal((await p.store.factoryIntake(REPO)).entries["42"]!.lastScan!.duplicates, 1);
  assert.ok(!(await p.store.factoryIntake(REPO)).entries["42"]!.recheck, "the request is cleared once done");
  assert.equal(after.status, "waiting");
  await p.store.abortFactoryRun(run.runId, "test over");
});

test("a person can ask for one run's issue to be read again: only an approver, only a live run, and it picks the answer up without a redeploy", async (t) => {
  const f = fixture(t, { intake: INTAKE, merge: { approvers: ["UAPPR"] } });
  const p = await openProcess(f);
  const h = harness(f, p, "UAPPR");
  const implement = held(reply.implement());
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("READY")), implement.factory]);
  const run = await begin(h, 43);
  const waiting = await reach(p, run.runId, ["waiting"], "info");
  h.clock.t = Math.max(h.clock.t, stageOf(waiting, "triage").attempts[0]!.endedAt) + MIN;
  h.source.comment(43, { author: ME, association: "OWNER", body: "Mobile and desktop.", at: h.clock.t });
  await asIfDropped(p, 43, h.clock.t, COMMENT_RULES_VERSION); // already on the current rules: nothing re-reads it by itself
  await h.poll();
  assert.equal((await p.store.factoryRun(run.runId))!.updates.length, 0, "stuck, as the person saw");

  const stranger = harness(f, p, "UOTHER").service;
  await assert.rejects(stranger.recheckIssue(run.runId), (error: unknown) => error instanceof FactoryRunError && /not one of the people who may approve/.test(error.message));
  const noSpeaker = harness(f, p, "").service;
  await assert.rejects(noSpeaker.recheckIssue(run.runId), FactoryRunError);

  const asked = await h.service.recheckIssue(run.runId);
  assert.deepEqual(asked, { repo: REPO, issue: 43 });
  assert.equal(h.kicks(), 1, "a poll was asked for");
  await h.poll();
  await implement.reached;
  assert.deepEqual((await p.store.factoryRun(run.runId))!.updates.map((u) => [u.author, u.excerpt]), [[ME, "Mobile and desktop."]]);

  implement.release();
  await p.store.abortFactoryRun(run.runId, "test over");
  await reach(p, run.runId, ["aborted"]);
  await assert.rejects(h.service.recheckIssue(run.runId), /already finished/);
});

test("it needs intake on, and an issue intake has mapped to that run", async (t) => {
  const off = fixture(t, {});
  const p = await openProcess(off);
  const run = await startRun(p, { issue: 44 });
  const service0 = createFactoryRunService({ channel: off.channel, store: () => p.store, github: () => off.github, threadKey: "", currentUserId: () => "UAPPR", source: "operator", intake: { kick: () => undefined } });
  await assert.rejects(service0.recheckIssue(run.runId), /intake is not on/i);
  await p.store.abortFactoryRun(run.runId, "test over");
  const on = fixture(t, { intake: INTAKE });
  const q = await openProcess(on);
  const manual = await startRun(q, { issue: 45 });
  await q.store.mutateFactoryIntake(REPO, (d) => { delete d.entries["45"]; }); // intake has nothing mapped for it
  const service = createFactoryRunService({ channel: on.channel, store: () => q.store, github: () => on.github, threadKey: "", currentUserId: () => "UAPPR", source: "operator", intake: { kick: () => undefined } });
  await assert.rejects(service.recheckIssue(manual.runId), /does not have .* mapped/);
  await q.store.abortFactoryRun(manual.runId, "test over");
});

test("the agent's own edits and label changes while a stage works do not wake a run that waits for an answer; a person's afterwards do", async (t) => {
  const f = fixture(t, { intake: INTAKE });
  const p = await openProcess(f);
  const h = harness(f, p);
  const triage = held(reply.triage("NEEDS_INFO"));
  const implement = held(reply.implement());
  f.faux.setResponses([triage.factory, respond(reply.triage("READY")), implement.factory]);
  const run = await begin(h, 46);
  await triage.reached; // the stage is working: the role sets a label and rewrites the description through the same account
  h.clock.t += 1000;
  h.source.put(46, { labels: ["priority:2"], body: "A clearer description, written by triage", at: h.clock.t });
  await h.poll();
  assert.equal((await p.store.factoryRun(run.runId))!.updates.length, 0, "the role's own changes are not news for its run");
  assert.equal(h.audits.filter(([event]) => event === "intake_updates").length, 0);
  triage.release();
  const waiting = await reach(p, run.runId, ["waiting"], "info");
  await h.poll();
  assert.equal((await p.store.factoryRun(run.runId))!.status, "waiting", "and it keeps waiting, rather than asking the same question again");
  assert.equal(stageOf((await p.store.factoryRun(run.runId))!, "triage").entries, 1);

  // A person changes a label after the stage ended: that is news.
  h.clock.t = Math.max(h.clock.t, stageOf(waiting, "triage").attempts[0]!.endedAt) + MIN;
  h.source.put(46, { labels: ["priority:2", "persona-answered"], at: h.clock.t });
  await h.poll();
  await implement.reached;
  const after = (await p.store.factoryRun(run.runId))!;
  assert.deepEqual(after.updates.map((u) => u.kind), ["labels"]);
  implement.release();
  await p.store.abortFactoryRun(run.runId, "test over");
});

test("an update first seen late counts as new to a stage that ran after it happened, once; the rewind point is the run's start", () => {
  const run = { ...emptyFactoryRun("r"), startedAt: 5000 };
  const old: RunUpdate = { kind: "comment", author: "a", association: "OWNER", trusted: true, excerpt: "x", at: 100, seen: 1000 };
  const plain: RunUpdate = { ...old, at: 100, seen: undefined };
  assert.equal(trustedUpdatesSince({ ...run, updates: [old] }, 500).length, 1, "happened before the stage ran, found after it began");
  assert.equal(trustedUpdatesSince({ ...run, updates: [old] }, 1000).length, 0, "a stage that ran after it was found has had it");
  assert.equal(trustedUpdatesSince({ ...run, updates: [plain] }, 500).length, 0, "an update from before this existed behaves as it did");
  assert.equal(rewindPoint(run), 4999);
});

test("the real source reads every page of a long thread, so the newest answer is not left on page two", async () => {
  const { createIssueSource } = await import("./github.ts");
  const row = (n: number) => ({ user: { login: "den" }, author_association: "OWNER", body: `c${n}`, created_at: new Date(1_700_000_000_000 + n * 1000).toISOString(), updated_at: new Date(1_700_000_000_000 + n * 1000).toISOString() });
  const asked: string[] = [];
  const source = createIssueSource((async (argv: string[]) => {
    asked.push(argv[1]!);
    const page = Number(/&page=(\d+)/.exec(argv[1]!)![1]);
    const rows = page === 1 ? Array.from({ length: 100 }, (_, i) => row(i)) : [row(100), row(101)];
    return { stdout: JSON.stringify(rows), stderr: "" };
  }) as never);
  const comments = await source.comments("acme/app", 7, 0);
  assert.equal(comments.length, 102);
  assert.equal(comments.at(-1)!.body, "c101");
  assert.equal(asked.length, 2, "it stops when a page is short");
});
