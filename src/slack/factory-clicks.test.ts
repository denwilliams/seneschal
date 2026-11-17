import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createFactoryRunService, type FactoryRunService } from "../factory/workflow/service.ts";
import type { FactoryRunData } from "../factory/workflow/docs.ts";
import { HEAD } from "../factory/workflow/test-support.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { decideFactoryRunClick, submitFactoryRunChanges, FACTORY_CHANGES_VIEW } from "./factory-clicks.ts";
import { FactoryPresence, type PresenceChannel } from "./factory-presence.ts";
import { buttonValue } from "./factory-render.ts";
import { aRun, FakeSlack, ManualClock, MemoryRuns, slackFactoryChannel } from "./factory-test-support.ts";

async function setup(t: TestContext, options: { wait?: "merge" | "rounds" | "failed" | "decide"; approvers?: string[]; announce?: boolean } = {}) {
  const channel = await slackFactoryChannel(t, { merge: { approvers: options.approvers ?? ["U123", "W456"] }, ...(options.announce === undefined ? {} : { announce: options.announce }) });
  const store = new MemoryRuns();
  const slack = new FakeSlack();
  const clock = new ManualClock();
  const presence = new FactoryPresence({ slack, store: () => store, now: clock.now, schedule: clock.schedule });
  const parked = options.wait === "failed" || options.wait === "decide";
  const run = aRun({
    current: "merge", status: parked ? "needs_decision" : "waiting", wait: { kind: options.wait ?? "merge", since: 4242 }, pr: { number: 12, url: "https://github.com/acme/app/pull/12", reviewedHead: HEAD, mergeCommit: "" },
    ...(parked ? { current: "implement", reason: 'stage "implement" failed: npm test: 3 failures' } : {}),
  });
  store.put(run);
  await presence.ensurePost(channel as unknown as PresenceChannel, run.runId);
  const ts = store.runs.get(run.runId)!.slack.ts;
  const ephemerals: { user: string; text: string }[] = [];
  const views: any[] = [];
  const client = { chat: { postEphemeral: async (a: { user: string; text: string }) => { ephemerals.push({ user: a.user, text: a.text }); return {}; } }, views: { open: async (args: any) => { views.push(args.view); return {}; } } } as never;
  const services: { user: string; service: FactoryRunService }[] = [];
  const deps = {
    client, presence,
    channelFor: async () => channel as unknown as ResolvedChannel & PresenceChannel,
    serviceFor: (c: ResolvedChannel, user: string, threadTs: string) => {
      const service = createFactoryRunService({ channel: c, store: () => store, github: () => undefined, threadKey: threadTs, currentUserId: () => user, source: "operator" });
      services.push({ user, service });
      return service;
    },
  };
  const click = (button: string, user: string, overrides: { value?: string; messageTs?: string; channel?: string } = {}) => decideFactoryRunClick(deps, {
    trigger_id: "trigger", actions: [{ action_id: `harness_factory_${button}`, value: overrides.value ?? buttonValue(store.runs.get(run.runId)!) }],
    user: { id: user }, channel: { id: overrides.channel ?? "C1" }, message: { ts: overrides.messageTs ?? ts },
  });
  const submit = (user = "U123", feedback = "Add the missing regression test.", view = views.at(-1)) => submitFactoryRunChanges(deps, {
    user: { id: user }, view: { ...view, state: { values: { feedback: { text: { value: feedback } } } } },
  });
  return { channel, store, slack, clock, presence, run, ts, ephemerals, click, deps, views, submit, stored: () => store.runs.get(run.runId)! };
}

test("an approver's Approve is recorded as their decision, bound to the commit the run says was reviewed, and the post shows who", async (t) => {
  const s = await setup(t);
  await s.click("approve", "U123");
  assert.deepEqual(s.store.decisions, [{ runId: s.run.runId, decision: "approve", by: "U123", head: HEAD }]);
  assert.deepEqual(s.ephemerals, []);
  const last = s.slack.updates().at(-1)!;
  assert.match(JSON.stringify(last.blocks), /Approved by <@U123>/);
  assert.ok(!(last.blocks as { type: string }[]).some((b) => b.type === "actions"), "the buttons are gone");
});

test("nothing in the click can name a different commit: the button's value is only the run, the wait and its time", async (t) => {
  const s = await setup(t);
  const forged = `${buttonValue(s.stored())}|deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
  await s.click("approve", "U123", { value: forged });
  assert.deepEqual(s.store.decisions, [], "a value with anything extra is not one of ours");
  assert.match(s.ephemerals[0]!.text, /not one this harness recognises/);
  await s.click("approve", "U123");
  const decided = s.store.decisions as { head: string }[];
  assert.equal(decided[0]!.head, HEAD, "the commit is the run's, not the payload's");
});

test("someone who is not an approver is told so, privately, and cannot take the decision", async (t) => {
  const s = await setup(t);
  await s.click("approve", "U999");
  assert.deepEqual(s.store.decisions, []);
  assert.deepEqual(s.ephemerals.map((e) => e.user), ["U999"]);
  assert.match(s.ephemerals[0]!.text, /not one of the people who may approve/);
  assert.equal(s.stored().slack.decision.kind, "", "and they did not claim the wait either");
  await s.click("approve", "U123");
  assert.equal(s.store.decisions.length, 1, "so an approver can still decide");
});

test("the speaker is Slack's clicker: a payload that claims someone else changes nothing", async (t) => {
  const s = await setup(t);
  await decideFactoryRunClick(s.deps, {
    actions: [{ action_id: "harness_factory_approve", value: buttonValue(s.stored()), user: "U123" }],
    user: { id: "U999" }, channel: { id: "C1" }, message: { ts: s.ts }, container: { user_id: "U123" },
  });
  assert.deepEqual(s.store.decisions, []);
});

test("pressed twice, or by two people at once, it is decided once, and the second is told who did", async (t) => {
  const s = await setup(t);
  await Promise.all([s.click("approve", "U123"), s.click("decline", "W456")]);
  assert.equal(s.store.decisions.length, 1);
  const decider = s.store.decisions[0]!;
  await s.click(decider.decision === "approve" ? "approve" : "decline", decider.by === "U123" ? "W456" : "U123");
  assert.equal(s.store.decisions.length, 1);
  assert.match(s.ephemerals.at(-1)!.text, /already (approved|declined) by <@(U123|W456)>/);
});

test("a button from an earlier wait does nothing and says so; the post is redrawn without it", async (t) => {
  const s = await setup(t);
  const stale = buttonValue(s.stored());
  s.store.runs.get(s.run.runId)!.wait = { kind: "merge", since: 9999 }; // the run went back to review and is waiting again
  await s.click("approve", "U123", { value: stale });
  assert.deepEqual(s.store.decisions, []);
  assert.match(s.ephemerals[0]!.text, /no longer waiting for that decision/);
});

test("a button on a post that was replaced does nothing", async (t) => {
  const s = await setup(t);
  await s.click("approve", "U123", { messageTs: "1700000000.000777" });
  assert.deepEqual(s.store.decisions, []);
  assert.match(s.ephemerals[0]!.text, /no longer waiting/);
});

test("a run that has finished, or never existed, answers politely", async (t) => {
  const s = await setup(t);
  s.store.runs.get(s.run.runId)!.status = "completed";
  await s.click("approve", "U123");
  assert.match(s.ephemerals[0]!.text, /completed/);
  await s.click("approve", "U123", { value: "fr_00000000|merge|1" });
  assert.match(s.ephemerals[1]!.text, /no workflow run/);
  assert.deepEqual(s.store.decisions, []);
});

test("out of rounds: One more round and Stop are the decisions, and Stop is a stop", async (t) => {
  const more = await setup(t, { wait: "rounds" });
  await more.click("more_rounds", "U123");
  assert.equal(more.store.decisions[0]!.decision, "more_rounds");
  const stop = await setup(t, { wait: "rounds" });
  await stop.click("stop", "W456");
  assert.equal(stop.store.decisions[0]!.decision, "stop");
  const wrong = await setup(t, { wait: "rounds" });
  await wrong.click("approve", "U123");
  assert.deepEqual(wrong.store.decisions, [], "Approve does not answer a wait for rounds");
  assert.ok(wrong.ephemerals.length > 0);
});

test("when the decision cannot be recorded the claim is given back, so the next click can try again", async (t) => {
  const s = await setup(t);
  const original = s.store.decideFactoryRun.bind(s.store);
  let fail = true;
  s.store.decideFactoryRun = async (...args) => { if (fail) { fail = false; throw new Error("database is locked"); } return original(...args); };
  await s.click("approve", "U123");
  assert.deepEqual(s.store.decisions, []);
  assert.match(s.ephemerals[0]!.text, /could not be done/);
  assert.equal(s.stored().slack.decision.kind, "");
  await s.click("approve", "U123");
  assert.equal(s.store.decisions.length, 1);
});

test("a channel that is no longer a factory, or a malformed click, does nothing", async (t) => {
  const s = await setup(t);
  await decideFactoryRunClick({ ...s.deps, channelFor: async () => undefined }, { actions: [{ action_id: "harness_factory_approve", value: buttonValue(s.stored()) }], user: { id: "U123" }, channel: { id: "C1" }, message: { ts: s.ts } });
  assert.match(s.ephemerals[0]!.text, /no longer set up/);
  await decideFactoryRunClick(s.deps, {});
  await decideFactoryRunClick(s.deps, { actions: [{ action_id: "other_action", value: "x" }], user: { id: "U123" }, channel: { id: "C1" } });
  assert.deepEqual(s.store.decisions, []);
});

test("with the factory's own approver list unset, the channel's allowed users decide", async (t) => {
  const channel = await slackFactoryChannel(t, { allowUsers: ["U555"] });
  const store = new MemoryRuns();
  const slack = new FakeSlack();
  const presence = new FactoryPresence({ slack, store: () => store });
  const run = store.put(aRun({ status: "waiting", wait: { kind: "merge", since: 1 }, pr: { number: 12, url: "https://github.com/acme/app/pull/12", reviewedHead: HEAD, mergeCommit: "" } }));
  await presence.ensurePost(channel as unknown as PresenceChannel, run.runId);
  const ts = store.runs.get(run.runId)!.slack.ts;
  const told: string[] = [];
  const deps = {
    client: { chat: { postEphemeral: async (a: { text: string }) => { told.push(a.text); return {}; } } } as never, presence,
    channelFor: async () => channel as unknown as ResolvedChannel & PresenceChannel,
    serviceFor: (c: ResolvedChannel, user: string, threadTs: string) => createFactoryRunService({ channel: c, store: () => store, github: () => undefined, threadKey: threadTs, currentUserId: () => user, source: "operator" }),
  };
  const body = (user: string) => ({ actions: [{ action_id: "harness_factory_approve", value: buttonValue(store.runs.get(run.runId)!) }], user: { id: user }, channel: { id: "C1" }, message: { ts } });
  await decideFactoryRunClick(deps, body("U999"));
  assert.deepEqual(store.decisions, []);
  await decideFactoryRunClick(deps, body("U555"));
  assert.equal(store.decisions.length, 1);
  assert.deepEqual(told.length, 1);
});

test("a stage that failed: Retry and Abort are decisions an approver can press, and the post shows who", async (t) => {
  const retry = await setup(t, { wait: "failed" });
  await retry.click("retry", "U123");
  assert.deepEqual(retry.store.decisions, [{ runId: retry.run.runId, decision: "retry", by: "U123", head: "" }]);
  assert.deepEqual(retry.ephemerals, []);
  const last = retry.slack.updates().at(-1)!;
  assert.match(JSON.stringify(last.blocks), /Retrying by <@U123>/);
  assert.ok(!(last.blocks as { type: string }[]).some((b) => b.type === "actions"), "the buttons give way to who decided");

  const abort = await setup(t, { wait: "failed" });
  await abort.click("abort", "W456");
  assert.equal(abort.store.decisions[0]!.decision, "abort");
  assert.match(JSON.stringify(abort.slack.updates().at(-1)!.blocks), /Aborted by <@W456>/);
});

test("a stage a restart interrupted has the same two buttons", async (t) => {
  const s = await setup(t, { wait: "decide" });
  await s.click("retry", "U123");
  assert.equal(s.store.decisions[0]!.decision, "retry");
});

test("a stranger cannot retry or abort, is told privately, and cannot take the claim", async (t) => {
  const s = await setup(t, { wait: "failed" });
  await s.click("retry", "U999");
  await s.click("abort", "U999");
  assert.deepEqual(s.store.decisions, []);
  assert.deepEqual(s.ephemerals.map((e) => e.user), ["U999", "U999"]);
  assert.match(s.ephemerals[0]!.text, /not one of the people who may approve/);
  await s.click("retry", "U123");
  assert.equal(s.store.decisions.length, 1, "so an approver still can");
});

test("a button that does not answer what the run waits for does nothing: Approve on a failed stage, Retry on a merge wait", async (t) => {
  const failed = await setup(t, { wait: "failed" });
  await failed.click("approve", "U123");
  assert.deepEqual(failed.store.decisions, []);
  assert.match(failed.ephemerals[0]!.text, /does not answer what this run is waiting for/);
  const merge = await setup(t);
  await merge.click("retry", "U123");
  assert.deepEqual(merge.store.decisions, []);
  assert.match(merge.ephemerals[0]!.text, /does not answer what this run is waiting for/);
});

test("Retry pressed twice, or after the stage failed again, decides once and a stale button does nothing", async (t) => {
  const s = await setup(t, { wait: "failed" });
  const first = buttonValue(s.stored());
  await Promise.all([s.click("retry", "U123"), s.click("abort", "W456")]);
  assert.equal(s.store.decisions.length, 1, "decided once");
  // The stage was retried and failed again: a new wait, so the old button is stale.
  const run = s.store.runs.get(s.run.runId)!;
  run.wait = { kind: "failed", since: 9999 };
  run.slack.decision = { kind: "", since: 0, by: "", at: 0 };
  await s.click("retry", "U123", { value: first });
  assert.equal(s.store.decisions.length, 1);
  assert.match(s.ephemerals.at(-1)!.text, /no longer waiting for that decision/);
});

test("Request changes opens a cancellable feedback modal, and only its submission claims the wait", async (t) => {
  const s = await setup(t);
  await s.click("request_changes", "U123");
  assert.equal(s.views[0].callback_id, FACTORY_CHANGES_VIEW);
  assert.equal(s.views[0].blocks[0].element.max_length, 3000);
  assert.equal(s.stored().slack.decision.kind, "");
  assert.deepEqual(s.store.decisions, []);
  await s.submit();
  assert.deepEqual(s.store.decisions, [{ runId: s.run.runId, decision: "request_changes", by: "U123", head: HEAD, changes: { feedback: "Add the missing regression test.", since: 4242 } }]);
  assert.match(JSON.stringify(s.slack.updates().at(-1)!.blocks), /Changes requested by <@U123>/);
  await s.submit();
  assert.equal(s.store.decisions.length, 1);
});

test("feedback submissions recheck permission, the exact wait, and the post; two people submit only one decision", async (t) => {
  const s = await setup(t);
  await s.click("request_changes", "U999");
  assert.equal(s.views.length, 0);
  await s.click("request_changes", "U123");
  const original = s.views[0];
  await s.submit("U999");
  await s.submit("U123", "   ");
  assert.equal(s.store.decisions.length, 0);
  s.store.runs.get(s.run.runId)!.wait.since = 9999;
  await s.submit();
  assert.match(s.ephemerals.at(-1)!.text, /no longer waiting/);
  s.store.runs.get(s.run.runId)!.wait.since = 4242;
  s.store.runs.get(s.run.runId)!.slack.ts = "new-post";
  await s.submit();
  assert.match(s.ephemerals.at(-1)!.text, /no longer waiting/);
  s.store.runs.get(s.run.runId)!.slack.ts = s.ts;
  await Promise.all([s.submit("U123", "Fix validation", original), s.submit("W456", "Add tests", original)]);
  assert.equal(s.store.decisions.length, 1);
});

test("an approval while the feedback form is open wins; the delayed submission cannot start implementation", async (t) => {
  const s = await setup(t);
  await s.click("request_changes", "U123");
  await s.click("approve", "W456");
  await s.submit();
  assert.equal(s.store.decisions.length, 1);
  assert.equal(s.store.decisions[0]!.decision, "approve");
  assert.match(s.ephemerals.at(-1)!.text, /already approved/);
});
