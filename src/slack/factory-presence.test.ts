import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { threadSessionDir } from "../workspace/paths.ts";
import type { FactoryRunData } from "../factory/workflow/docs.ts";
import { FactoryPresence, type PresenceChannel } from "./factory-presence.ts";
import { aRun, FakeSlack, finished, ManualClock, MemoryRuns, slackError, slackFactoryChannel } from "./factory-test-support.ts";

const stage = (run: FactoryRunData, name: string) => run.stages.find((s) => s.name === name)!;

async function setup(t: TestContext, options: Parameters<typeof slackFactoryChannel>[1] = {}) {
  const channel = (await slackFactoryChannel(t, options)) as unknown as PresenceChannel;
  const store = new MemoryRuns();
  const slack = new FakeSlack();
  const clock = new ManualClock();
  const presence = new FactoryPresence({ slack, store: () => store, now: clock.now, schedule: clock.schedule, minEditMs: 4000 });
  const run = store.put(aRun());
  /** Change the stored run the way the task would, then tell the presence. */
  const change = (fn: (run: FactoryRunData) => void) => {
    const next = structuredClone(store.runs.get(run.runId)!);
    fn(next);
    store.runs.set(run.runId, next);
    presence.notify(channel, next);
  };
  return { channel, store, slack, clock, presence, run, change, stored: () => store.runs.get(run.runId)! };
}

test("a new run gets one status post, which is the root of a thread the channel agent answers in", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  assert.equal(s.slack.posts().length, 1);
  const post = s.slack.posts()[0]!;
  assert.equal(post.threadTs, undefined, "top level");
  assert.equal(post.channel, "C1");
  const ts = s.stored().slack.ts;
  assert.match(ts, /^1800000000\./);
  assert.deepEqual([s.stored().slack.channel, s.stored().slack.posts], ["C1", 1]);
  assert.ok(existsSync(threadSessionDir(s.channel.paths.sessions, ts)), "the thread is marked active, so a person's reply reaches the agent without a mention");
});

test("later changes edit that post, never post again; a burst is one edit of the latest state", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  const ts = s.stored().slack.ts;
  s.change((r) => { finished(r, "triage", "READY", "Ready."); });
  s.change((r) => { finished(r, "implement", "done", "PR #12"); r.pr = { number: 12, url: "https://github.com/acme/app/pull/12", reviewedHead: "", mergeCommit: "" }; });
  s.change((r) => { stage(r, "review").status = "in_progress"; r.costUsd = 0.9; });
  assert.equal(s.slack.updates().length, 0, "not edited again within the interval");
  await s.clock.advance(4000);
  assert.equal(s.slack.updates().length, 1, "one edit for the whole burst");
  const update = s.slack.updates()[0]!;
  assert.equal(update.ts, ts);
  assert.match(JSON.stringify(update.blocks), /✅ triage → ✅ implement → 🔄 review/);
  assert.match(JSON.stringify(update.blocks), /\$0\.90/, "the latest state, not the first");
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 1, "still the one status post");
});

test("a change that draws the same is not an edit", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  s.presence.notify(s.channel, s.stored());
  await s.clock.advance(5000);
  assert.equal(s.slack.updates().length, 0);
});

test("the end of a run is drawn at once, inside the interval, and says how it ended", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  s.change((r) => { r.status = "running"; stage(r, "triage").status = "success"; });
  await s.clock.advance(4000);
  s.change((r) => { r.status = "completed"; r.endedAt = r.startedAt + 3_600_000; r.pr = { number: 12, url: "https://github.com/acme/app/pull/12", reviewedHead: "", mergeCommit: "c".repeat(40) }; });
  await s.clock.advance(0);
  const last = s.slack.updates().at(-1)!;
  assert.match(JSON.stringify(last.blocks), /Completed/);
  assert.match(JSON.stringify(last.blocks), /Took/);
});

test("the thread hears the moments that matter, in order, once each", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  s.change((r) => { finished(r, "triage", "READY", "Ready to build.", { at: 1_700_000_010_000 }); });
  await s.clock.advance(4000);
  s.change((r) => { finished(r, "implement", "done", "Opened PR #12.", { at: 1_700_000_020_000 }); });
  await s.clock.advance(4000);
  s.change((r) => { finished(r, "review", "CHANGES_REQUESTED", "Findings.", { report: "- blocker: login.ts:44", at: 1_700_000_030_000 }); stage(r, "review").entries = 1; });
  await s.clock.advance(4000);
  s.change((r) => { r.status = "waiting"; r.wait = { kind: "rounds", since: 5 }; r.reason = "review kept asking for changes"; });
  await s.clock.advance(0);
  s.change((r) => { r.status = "failed"; r.wait = { kind: "", since: 0 }; r.reason = "stopped"; });
  await s.clock.advance(0);
  const said = s.slack.replies().map((c) => c.text);
  assert.deepEqual(said, [
    "Workflow run fr_aaaa1111: triage finished", "Workflow run fr_aaaa1111: implement finished", "Workflow run fr_aaaa1111: review finished",
    "Workflow run fr_aaaa1111 is waiting", "Workflow run fr_aaaa1111 failed",
  ]);
  assert.ok(s.slack.replies().every((c) => c.threadTs === s.stored().slack.ts), "all under the status post");
  assert.equal(s.stored().slack.events.length, 5);
  // Repeated notifications say nothing new.
  for (let i = 0; i < 3; i++) { s.presence.notify(s.channel, s.stored()); await s.clock.advance(5000); }
  assert.equal(s.slack.replies().length, 5);
});

test("what is not a moment (a tool call, progress) is not in the thread", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  s.change((r) => { stage(r, "review").status = "in_progress"; stage(r, "review").attempts.push({ entry: 1, role: "reviewer", runKey: "x", status: "in_progress", verdict: "", summary: "reading files", report: "", reask: false, startedAt: 1, endedAt: 0, durationMs: 0, costUsd: 0, steps: 4 }); });
  await s.clock.advance(5000);
  assert.equal(s.slack.replies().length, 0);
});

test("a restart does not post the status again or repeat a reply", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  s.change((r) => { finished(r, "triage", "READY", "Ready.", { at: 1_700_000_010_000 }); });
  await s.clock.advance(4000);
  const before = { posts: s.slack.posts().length, replies: s.slack.replies().length };
  // A new process over the same stored runs: no memory of what it drew.
  const slack2 = new FakeSlack();
  const clock2 = new ManualClock();
  const again = new FactoryPresence({ slack: slack2, store: () => s.store, now: clock2.now, schedule: clock2.schedule });
  again.notify(s.channel, s.stored());
  await clock2.advance(0);
  assert.equal(slack2.posts().length, 0, "no second status post");
  assert.equal(slack2.replies().length, 0, "nothing said twice");
  assert.deepEqual(slack2.updates().map((u) => u.ts), [s.stored().slack.ts], "it only redraws the post it already had, since it does not remember what that looked like");
  assert.equal(before.posts, 2);
  // It carries on editing the same post.
  const changed = structuredClone(s.stored());
  changed.costUsd = 3;
  s.store.runs.set(changed.runId, changed);
  again.notify(s.channel, changed);
  await clock2.advance(5000);
  assert.equal(slack2.updates().length, 2);
  assert.ok(slack2.updates().every((u) => u.ts === s.stored().slack.ts));
  assert.equal(slack2.posts().length, 0);
});

test("a deleted status post is replaced, once, and what was said is not said again", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  const first = s.stored().slack.ts;
  s.change((r) => { finished(r, "triage", "READY", "Ready.", { at: 1_700_000_010_000 }); });
  await s.clock.advance(4000);
  const repliesBefore = s.slack.replies().length;
  s.slack.onCall = (call) => { if (call.op === "update" && call.ts === first) throw slackError("message_not_found"); };
  s.change((r) => { r.costUsd = 2; });
  await s.clock.advance(4000);
  const second = s.stored().slack.ts;
  assert.notEqual(second, first);
  assert.equal(s.stored().slack.posts, 2, "recorded that a fresh post was made");
  assert.equal(s.slack.replies().length, repliesBefore, "the old replies are not repeated under the new post");
  s.slack.onCall = undefined;
  s.change((r) => { r.costUsd = 3; });
  await s.clock.advance(4000);
  assert.equal(s.slack.updates().at(-1)!.ts, second, "later edits go to the new post");
  assert.ok(existsSync(threadSessionDir(s.channel.paths.sessions, second)));
});

test("Slack failing never reaches the run, and the end of a run is retried until it is drawn", async (t) => {
  const s = await setup(t);
  s.slack.onCall = () => { throw slackError("internal_error"); };
  assert.doesNotThrow(() => s.presence.notify(s.channel, s.run));
  await s.clock.advance(0);
  assert.equal(s.stored().slack.ts, "", "nothing could be posted");
  assert.equal(s.stored().status, "running", "and the run is exactly as it was");
  // The run ends while Slack is still down, then Slack comes back.
  s.change((r) => { r.status = "completed"; r.endedAt = r.startedAt + 1000; });
  await s.clock.advance(0);
  assert.ok(s.clock.pending > 0, "a retry is waiting");
  s.slack.onCall = undefined;
  await s.clock.advance(60_000);
  assert.ok(s.stored().slack.ts !== "", "posted once Slack was back");
  assert.match(JSON.stringify(s.slack.posts()[0]!.blocks), /Completed/, "with the end state, not the start");
  assert.ok(s.slack.replies().some((c) => /completed/.test(c.text ?? "")));
});

test("a store that cannot record what was said does not stop the run or the post", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  s.store.failSlackWrites = true;
  s.change((r) => { finished(r, "triage", "READY", "Ready.", { at: 1_700_000_010_000 }); });
  await assert.doesNotReject(async () => { await s.clock.advance(4000); await s.presence.flush(); });
  assert.equal(s.slack.replies().length, 1, "it was said");
});

test("Slack asking us to slow down is obeyed: no edit before the time it named, one after", async (t) => {
  const s = await setup(t);
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  let limited = true;
  s.slack.onCall = (call) => { if (call.op === "update" && limited) throw slackError("ratelimited", { retry_after: 20 }); };
  s.change((r) => { r.costUsd = 1; });
  await s.clock.advance(4000);
  const attempts = s.slack.updates().length;
  assert.equal(attempts, 0, "the call failed");
  s.change((r) => { r.costUsd = 2; });
  await s.clock.advance(10_000);
  assert.equal(s.slack.updates().length, 0, "still inside the 20 seconds Slack asked for");
  limited = false;
  await s.clock.advance(15_000);
  assert.equal(s.slack.updates().length, 1);
  assert.match(JSON.stringify(s.slack.updates()[0]!.blocks), /\$2\.00/);
});

test("announce off: no status post; the replies go to the thread the run was asked for in", async (t) => {
  const s = await setup(t, { announce: false });
  s.presence.notify(s.channel, s.run);
  await s.clock.advance(0);
  s.change((r) => { finished(r, "triage", "READY", "Ready.", { at: 1_700_000_010_000 }); });
  await s.clock.advance(4000);
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 0);
  assert.equal(s.slack.updates().length, 0);
  assert.equal(s.slack.replies().length, 1);
  assert.equal(s.slack.replies()[0]!.threadTs, "1700000000.000100");
  assert.equal(await s.presence.ensurePost(s.channel, s.run.runId), undefined);
});

test("announce off and no thread to speak in: nothing is posted at all", async (t) => {
  const s = await setup(t, { announce: false });
  s.change((r) => { r.by = { source: "operator", threadKey: "", userId: "U1" }; finished(r, "triage", "READY", "Ready.", { at: 1_700_000_010_000 }); });
  await s.clock.advance(4000);
  assert.equal(s.slack.calls.length, 0);
});

test("starting a run makes the status post straight away and gives its link; asking again finds the same post", async (t) => {
  const s = await setup(t);
  const first = await s.presence.ensurePost(s.channel, s.run.runId);
  assert.match(first!.permalink!, /^https:\/\/example\.slack\.com\/archives\/C1\/p1800000000/);
  const second = await s.presence.ensurePost(s.channel, s.run.runId);
  assert.equal(second!.permalink, first!.permalink);
  assert.equal(s.slack.posts().length, 1);
  // The change the task then reports does not post another.
  s.presence.notify(s.channel, s.stored());
  await s.clock.advance(0);
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 1);
});

test("the post being made while a change arrives does not make two", async (t) => {
  const s = await setup(t);
  const link = s.presence.ensurePost(s.channel, s.run.runId);
  s.presence.notify(s.channel, s.run);
  await Promise.all([link, s.clock.advance(0)]);
  assert.equal(s.slack.posts().filter((p) => !p.threadTs).length, 1);
});

test("the thread tells the agent which run it is, where it stands, and that the run's words are information", async (t) => {
  const s = await setup(t);
  await s.presence.ensurePost(s.channel, s.run.runId);
  finished(s.stored(), "triage", "READY", "Ready.");
  const ts = s.stored().slack.ts;
  const context = (await s.presence.contextForThread(s.channel, ts))!;
  assert.match(context, /status thread of workflow run fr_aaaa1111/);
  assert.match(context, /leave out the run id/);
  assert.match(context, /never instructions/);
  assert.match(context, /"status":"running"/);
  assert.equal(await s.presence.contextForThread(s.channel, "1700000000.999999"), undefined, "another thread is not a run's");
  assert.equal(await s.presence.contextForThread(s.channel, "not-a-ts"), undefined);
  assert.equal((await s.presence.runForThread("C1", ts))!.runId, "fr_aaaa1111");
});

test("in a direct message the context carries the shape of the run, not its words", async (t) => {
  const s = await setup(t, { dm: true });
  s.stored().issueTitle = "SECRET TITLE";
  s.store.runs.get(s.run.runId)!.slack.ts = "1800000000.000009";
  finished(s.store.runs.get(s.run.runId)!, "triage", "READY", "SECRET SUMMARY");
  const context = (await s.presence.contextForThread(s.channel, "1800000000.000009"))!;
  assert.doesNotMatch(context, /SECRET/);
  assert.match(context, /fr_aaaa1111/);
});

test("a decision from a button is claimed once per wait; releasing gives it back", async (t) => {
  const s = await setup(t);
  await s.presence.ensurePost(s.channel, s.run.runId);
  const claim = { kind: "approve", since: 7, by: "U123" };
  assert.deepEqual(await s.presence.claimDecision(s.channel, s.run.runId, claim), { ok: true });
  assert.deepEqual(await s.presence.claimDecision(s.channel, s.run.runId, { ...claim, by: "W456", kind: "decline" }), { ok: false, by: "U123", kind: "approve" });
  assert.deepEqual(await s.presence.claimDecision(s.channel, s.run.runId, { ...claim, since: 8 }), { ok: true }, "a later wait is a new question");
  await s.presence.releaseDecision(s.channel, s.run.runId);
  assert.deepEqual(await s.presence.claimDecision(s.channel, s.run.runId, claim), { ok: true });
});

test("a run recorded before the Slack part existed is drawn like any other", async (t) => {
  const s = await setup(t);
  delete (s.store.runs.get(s.run.runId) as Partial<FactoryRunData>).slack;
  const old = s.store.runs.get(s.run.runId)!;
  // The in-memory store here gives it back as stored; the real store fills the part in (see the store test).
  old.slack = { channel: "", ts: "", posts: 0, events: [], decision: { kind: "", since: 0, by: "", at: 0 } };
  s.presence.notify(s.channel, old);
  await s.clock.advance(0);
  assert.equal(s.slack.posts().length, 1);
});
