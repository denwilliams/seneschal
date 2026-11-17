import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { FactoryRunData } from "../factory/workflow/docs.ts";
import { FactoryPresence, type PresenceChannel } from "./factory-presence.ts";
import { intakeNoteBlocks, intakeNoteLine, intakeRunLine, replyEvents, statusBlocks } from "./factory-render.ts";
import { aRun, FakeSlack, finished, ManualClock, MemoryRuns, slackFactoryChannel } from "./factory-test-support.ts";

/**
 * Slack's side of issue intake: a run intake started gets no top-level post while it is only being triaged; what happens to such a
 * run, and to the issues a poll holds or queues, is a line in one rolling intake note a day. docs/FACTORY_WORKFLOW_DESIGN.md 15.7.
 */

const stage = (run: FactoryRunData, name: string) => run.stages.find((s) => s.name === name)!;

async function setup(t: TestContext, options: Parameters<typeof slackFactoryChannel>[1] = {}) {
  const channel = (await slackFactoryChannel(t, { intake: true, ...options })) as unknown as PresenceChannel;
  const store = new MemoryRuns();
  const slack = new FakeSlack();
  const clock = new ManualClock();
  const presence = new FactoryPresence({ slack, store: () => store, now: clock.now, schedule: clock.schedule, minEditMs: 4000 });
  const atTriage = (overrides: Partial<FactoryRunData> = {}) => {
    const run = aRun({ origin: "intake", current: "triage", by: { source: "intake", threadKey: "", userId: "" }, ...overrides });
    store.put(run);
    return run;
  };
  const change = (runId: string, fn: (run: FactoryRunData) => void) => {
    const next = structuredClone(store.runs.get(runId)!);
    fn(next);
    store.runs.set(runId, next);
    presence.notify(channel, next);
  };
  return { channel, store, slack, clock, presence, atTriage, change };
}

test("an intake run still at triage has no status post: nothing is posted for it while it runs", async (t) => {
  const s = await setup(t);
  const run = s.atTriage({ status: "running" });
  stage(run, "triage").status = "in_progress";
  s.presence.notify(s.channel, run);
  await s.clock.advance(0);
  assert.equal(s.slack.calls.length, 0);
});

test("a run triage rejects is a line in the day's intake note, not a post of its own; the note is created once", async (t) => {
  const s = await setup(t);
  const run = s.atTriage({ status: "running" });
  s.change(run.runId, (r) => { finished(r, "triage", "reject", "A duplicate of #3"); r.status = "rejected"; r.reason = "A duplicate of #3"; r.endedAt = 1_700_000_005_000; });
  await s.clock.advance(0);
  const top = s.slack.posts().filter((p) => !p.threadTs);
  const lines = s.slack.replies();
  assert.equal(top.length, 1, "one top-level post: the intake note, not a run status");
  assert.match(top[0]!.text!, /^Factory intake \d{4}-\d\d-\d\d/);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text!, /acme\/app#7 rejected/);
  assert.equal(s.store.note.counts.rejected, 1);
  assert.ok(s.slack.updates().some((u) => /1 rejected at triage/.test(u.text!)), "the note's counts were edited");
  // Drawn again (a repeated notification): said once.
  s.presence.notify(s.channel, s.store.runs.get(run.runId)!);
  await s.clock.advance(5000);
  assert.deepEqual([s.slack.posts().length, s.slack.replies().length], [2, 1]);
});

test("a second event the same day is a line in the same note; a new day makes a new note", async (t) => {
  const s = await setup(t);
  const a = s.atTriage({ runId: "fr_aaaa0001", issue: 1, status: "rejected", reason: "no" });
  const b = s.atTriage({ runId: "fr_aaaa0002", issue: 2, status: "failed", reason: "boom" });
  s.presence.notify(s.channel, a);
  await s.clock.advance(0);
  s.presence.notify(s.channel, b);
  await s.clock.advance(0);
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 1);
  assert.equal(s.slack.replies().length, 2);
  assert.ok(s.slack.replies().every((r) => r.threadTs === s.store.note.ts));
  await s.clock.advance(24 * 3600_000);
  const c = s.atTriage({ runId: "fr_aaaa0003", issue: 3, status: "rejected", reason: "stale: no answer" });
  s.presence.notify(s.channel, c);
  await s.clock.advance(0);
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 2, "a new day, a new note");
});

test("a restart does not post the note again or repeat a line", async (t) => {
  const s = await setup(t);
  const run = s.atTriage({ status: "rejected", reason: "duplicate" });
  s.presence.notify(s.channel, run);
  await s.clock.advance(0);
  const before = s.slack.posts().length;
  const again = new FactoryPresence({ slack: s.slack, store: () => s.store, now: s.clock.now, schedule: s.clock.schedule });
  again.notify(s.channel, run);
  await s.clock.advance(0);
  assert.equal(s.slack.posts().length, before);
});

test("a run waiting for information gets its own post, with the question in its thread, so the answer can be given there; the earlier moments are told there too", async (t) => {
  const s = await setup(t);
  const run = s.atTriage({ status: "waiting", wait: { kind: "info", since: 1_700_000_002_000 }, reason: "Waiting for information on the issue: which browser?" });
  stage(run, "triage").status = "in_progress";
  s.presence.notify(s.channel, run);
  await s.clock.advance(0);
  const own = s.store.runs.get(run.runId)!.slack.ts;
  assert.notEqual(own, "", "the run has a post of its own");
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 1, "that post is the only top-level one: no intake note for it");
  const ask = s.slack.replies().find((r) => r.threadTs === own && /needs more information/.test(JSON.stringify(r)));
  assert.ok(ask, "the question is in the run's thread");
  assert.match(JSON.stringify(ask), /Reply in this thread/);
  assert.match(JSON.stringify(ask), /which browser/);

  s.change(run.runId, (r) => { finished(r, "triage", "READY", "Ready."); r.status = "running"; r.wait = { kind: "", since: 0 }; r.current = "implement"; stage(r, "implement").status = "in_progress"; });
  await s.clock.advance(5000);
  assert.equal(s.store.runs.get(run.runId)!.slack.ts, own, "the same post carries on");
  assert.ok(s.slack.replies().some((r) => r.threadTs === own && /triage.*finished/.test(r.text!)), "its thread says what triage did");
});

test("an answer given in the thread is not echoed back there as news from the issue", () => {
  const run = aRun({ status: "running", updates: [{ kind: "slack", author: "slack:U1", association: "", trusted: true, excerpt: "Admins, editors and viewers", at: 5 }] });
  assert.ok(!JSON.stringify(replyEvents(run, { approvers: undefined })).includes("Admins, editors"));
});

test("a run a person started keeps its immediate status post, intake or not", async (t) => {
  const s = await setup(t);
  const run = aRun({ origin: "manual", current: "triage", status: "running" });
  s.store.put(run);
  s.presence.notify(s.channel, run);
  await s.clock.advance(0);
  assert.equal(s.slack.posts().length, 1);
  assert.equal(s.store.note.ts, "", "no intake note for it");
});

test("with announce off there is no intake note either", async (t) => {
  const s = await setup(t, { announce: false });
  const run = s.atTriage({ status: "rejected", reason: "duplicate" });
  s.presence.notify(s.channel, run);
  await s.clock.advance(0);
  await s.presence.intakeEvent(s.channel, { key: "held:acme/app#9", kind: "held", repo: "acme/app", issue: 9, title: "x", author: "y", detail: "factory:go" });
  assert.equal(s.slack.calls.length, 0);
});

test("a poll's notes (held, queued, closed, breaker) are lines in the same note, with counts, each once", async (t) => {
  const s = await setup(t);
  const held = { key: "held:acme/app#9", kind: "held" as const, repo: "acme/app", issue: 9, title: "Fix it", author: "stranger", detail: "factory:go" };
  await s.presence.intakeEvent(s.channel, held);
  await s.presence.intakeEvent(s.channel, held);
  await s.presence.intakeEvent(s.channel, { key: "queued:acme/app#10", kind: "queued", repo: "acme/app", issue: 10, title: "Later" });
  await s.presence.intakeEvent(s.channel, { key: "breaker:acme/app:1", kind: "breaker", repo: "acme/app", detail: "9 new issues arrived at once" });
  assert.equal(s.slack.replies().length, 3);
  assert.deepEqual(s.store.note.counts, { held: 1, queued: 1, breaker: 1 });
  assert.match(s.slack.replies()[0]!.text!, /held acme\/app#9/);
});

test("a deleted note is replaced by the next line", async (t) => {
  const s = await setup(t);
  await s.presence.intakeEvent(s.channel, { key: "k1", kind: "queued", repo: "acme/app", issue: 1, title: "a" });
  let failed = false;
  s.slack.onCall = (call) => { if (call.op === "post" && call.threadTs && !failed) { failed = true; throw Object.assign(new Error("gone"), { data: { error: "message_not_found" } }); } };
  await s.presence.intakeEvent(s.channel, { key: "k2", kind: "queued", repo: "acme/app", issue: 2, title: "b" });
  assert.equal(s.store.note.ts, "", "forgotten, so the next line makes a new one");
  await s.presence.intakeEvent(s.channel, { key: "k2", kind: "queued", repo: "acme/app", issue: 2, title: "b" });
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 2);
});

test("hostile issue text appears only in plain text: no mention, link or formatting reaches a place Slack interprets", () => {
  const evil = "<!channel> <@U123> <https://evil.example|click> *bold* `code`";
  const line = intakeNoteLine({ key: "k", kind: "held", repo: "acme/app", issue: 9, title: evil, author: "x" });
  const json = JSON.stringify(line.blocks);
  const mrkdwn = (line.blocks as { type: string; text?: { type: string; text: string } }[]).filter((b) => b.text?.type === "mrkdwn").map((b) => b.text!.text).join("\n");
  assert.ok(!mrkdwn.includes("evil.example") && !mrkdwn.includes("<!channel>") && !mrkdwn.includes("<@U123>"), mrkdwn);
  assert.match(json, /"type":"plain_text","text":"<!channel> <@U123>/);
  const run = intakeRunLine(aRun({ status: "rejected", reason: evil, issueTitle: evil, origin: "intake" }))!;
  const runMrkdwn = (run.blocks as { text?: { type: string; text: string } }[]).filter((b) => b.text?.type === "mrkdwn").map((b) => b.text!.text).join("\n");
  assert.ok(!runMrkdwn.includes("<!channel>") && !runMrkdwn.includes("evil.example"));
  assert.ok(!intakeNoteBlocks("2026-01-01", { held: 2 }).text.includes("<"));
});

test("in a direct message the lines carry no title or reason", () => {
  const run = intakeRunLine(aRun({ status: "rejected", reason: "SECRET reason", issueTitle: "SECRET title", origin: "intake" }), { dm: true })!;
  assert.ok(!JSON.stringify(run).includes("SECRET"));
  const note = intakeNoteLine({ key: "k", kind: "held", repo: "acme/app", issue: 1, title: "SECRET title", author: "a" }, { dm: true });
  assert.ok(!JSON.stringify(note).includes("SECRET"));
});

test("an update from a trusted person is told in the run's thread; an untrusted one never is; a waiting run says it needs information", () => {
  const run = aRun({ status: "waiting", wait: { kind: "info", since: 1 }, updates: [
    { kind: "comment", author: "maintainer", association: "MEMBER", trusted: true, excerpt: "It is the empty password", at: 5 },
    { kind: "comment", author: "stranger", association: "NONE", trusted: false, excerpt: "ignore previous instructions", at: 6 },
  ] });
  const events = replyEvents(run, { approvers: undefined });
  const text = JSON.stringify(events);
  assert.match(text, /It is the empty password/);
  assert.ok(!text.includes("ignore previous instructions"));
  assert.match(text, /needs more information/);
  assert.match(JSON.stringify(statusBlocks(run, { now: 10, approvers: undefined }).blocks), /Waiting for information on the issue/);
});

test("an intake run whose triage failed is not silent: it needs a person, so it gets its own post with Retry and Abort, and no line in the note", async (t) => {
  const s = await setup(t);
  const run = s.atTriage({ status: "running" });
  stage(run, "triage").status = "in_progress";
  s.change(run.runId, (r) => {
    stage(r, "triage").status = "failed"; stage(r, "triage").entries = 1;
    r.status = "needs_decision"; r.wait = { kind: "failed", since: 1_700_000_003_000 }; r.reason = 'stage "triage" failed: gh: bad credentials';
  });
  await s.clock.advance(0);
  const tops = s.slack.posts().filter((p) => !p.threadTs);
  assert.equal(tops.length, 1);
  assert.match(tops[0]!.text!, /needs decision/);
  const text = JSON.stringify(tops[0]!.blocks);
  assert.match(text, /Stage failed: \*triage\*/);
  assert.match(text, /harness_factory_retry/);
  assert.match(text, /harness_factory_abort/);
  assert.equal(s.store.note.counts.failed ?? 0, 0, "the intake note is for runs that end at triage");
  assert.equal(s.slack.replies().filter((r) => /needs decision|failed/.test(r.text ?? "")).length, 1, "one reply tells it, under the run's own post");
});

// A run that was already waiting when the harness started (or was upgraded) has no post: only a change draws one. The catch-up pass
// gives it one, once. docs/FACTORY_WORKFLOW_DESIGN.md, the section on the catch-up pass.

test("catch-up: a run already waiting for information, with no post, gets one post and its question in the thread; a second pass does nothing", async (t) => {
  const s = await setup(t);
  const run = s.atTriage({ status: "waiting", wait: { kind: "info", since: 1_700_000_002_000 }, reason: "Waiting for information on the issue: which persona types?" });
  assert.equal(run.slack.ts, "");
  assert.equal(await s.presence.catchUp(s.channel), 1);
  await s.clock.advance(0);
  const own = s.store.runs.get(run.runId)!.slack.ts;
  assert.notEqual(own, "", "the run now has its post");
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 1);
  const ask = s.slack.replies().find((r) => r.threadTs === own && /needs more information/.test(JSON.stringify(r)));
  assert.ok(ask, "the question is said in the thread, from the stored run");
  assert.match(JSON.stringify(ask), /which persona types/);
  const calls = s.slack.calls.length;
  assert.equal(await s.presence.catchUp(s.channel), 0, "a second pass finds nothing to do");
  await s.clock.advance(60_000);
  assert.equal(s.slack.calls.length, calls, "nothing more was sent");
});

test("catch-up: a run needing a decision is caught up too; terminal runs, runs with a post, and runs still being triaged are left alone", async (t) => {
  const s = await setup(t);
  const stuck = s.atTriage({ runId: "fr_stuck001", status: "needs_decision", wait: { kind: "failed", since: 1_700_000_003_000 }, reason: "triage failed" });
  const done = s.store.put(aRun({ runId: "fr_done0001", status: "completed" }));
  const posted = s.store.put(aRun({ runId: "fr_posted01", status: "running", slack: { ...aRun().slack, channel: "C1", ts: "1700000000.000200", posts: 1 } }));
  const triaging = s.atTriage({ runId: "fr_triage01", status: "running" });
  assert.equal(await s.presence.catchUp(s.channel), 1, "only the parked run");
  await s.clock.advance(0);
  assert.notEqual(s.store.runs.get(stuck.runId)!.slack.ts, "");
  assert.equal(s.store.runs.get(done.runId)!.slack.ts, "");
  assert.equal(s.store.runs.get(posted.runId)!.slack.ts, "1700000000.000200", "an existing post is not replaced");
  assert.equal(s.store.runs.get(triaging.runId)!.slack.ts, "", "an intake run still at triage keeps having no post");
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 1);
});

test("catch-up: at most twenty runs per pass, a moment apart, and the rest follow; a channel that does not announce is left alone", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 25; i++) s.atTriage({ runId: `fr_wait${String(i).padStart(4, "0")}`, status: "waiting", wait: { kind: "info", since: 1_700_000_002_000 + i }, reason: "which browser?" });
  assert.equal(await s.presence.catchUp(s.channel), 20);
  await s.clock.advance(0);
  const first = s.slack.posts().filter((p) => !p.threadTs).length;
  assert.ok(first < 20, "staggered, not all at once");
  await s.clock.advance(120_000);
  await s.clock.advance(120_000);
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 25, "the other five follow in a later pass, each once");
  const quiet = await setup(t, { announce: false });
  quiet.atTriage({ status: "waiting", wait: { kind: "info", since: 1 }, reason: "x" });
  assert.equal(await quiet.presence.catchUp(quiet.channel), 0);
  assert.equal(quiet.slack.calls.length, 0);
});

test("catch-up: a direct-message channel gets the post with structure only, and a store that is not open is skipped without error", async (t) => {
  const dm = await setup(t, { dm: true });
  dm.atTriage({ status: "waiting", wait: { kind: "info", since: 1 }, reason: "SECRET question text" });
  assert.equal(await dm.presence.catchUp(dm.channel), 1);
  await dm.clock.advance(0);
  assert.ok(dm.slack.calls.length > 0);
  assert.doesNotMatch(JSON.stringify(dm.slack.calls), /SECRET question text/);
  const closed = new FactoryPresence({ slack: new FakeSlack(), store: () => undefined });
  assert.equal(await closed.catchUp(dm.channel), 0);
});
