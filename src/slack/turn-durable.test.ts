import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { TaskStatusStore } from "../tasks/store.ts";
import { ChannelRuntimes } from "../agent/channel-runtime.ts";
import { createThreadSession, type ThreadSession } from "../agent/session.ts";
import { ChannelTimelineLog } from "../agent/timeline.ts";
import { fauxText } from "@earendil-works/pi-ai/providers/faux";
import { exampleAgentSet } from "../factory/workflow/test-support.ts";
import { emptyFactoryRun } from "../factory/workflow/docs.ts";
import { SlackUserTokenStore } from "../agent/slack-user-tokens.ts";

/**
 * The whole chain for one Slack turn, with nothing faked except Slack itself and the model: a real thread
 * session on a real channel store, driven through the app's own turn handler, streaming into the real
 * Slack stream and delivery ledger.
 */

type Posted = { ts: string; text: string; metadata?: { event_type?: string; event_payload?: { request_id?: string } } };

function fakeSlack() {
  const thread: Posted[] = [];
  let counter = 0;
  const client = {
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    chat: {
      postMessage: async (args: { text: string; metadata?: Posted["metadata"] }) => {
        const message = { ts: `200.${++counter}`, text: args.text, ...(args.metadata ? { metadata: args.metadata } : {}) };
        thread.push(message); return { ok: true, ts: message.ts };
      },
      update: async (args: { ts: string; text: string }) => { thread.find((m) => m.ts === args.ts)!.text = args.text; return { ok: true }; },
      delete: async (args: { ts: string }) => { thread.splice(thread.findIndex((m) => m.ts === args.ts), 1); return { ok: true }; },
    },
    conversations: { replies: async () => ({ ok: true, messages: thread }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as unknown as WebClient;
  return { client, thread };
}

async function fixture(t: TestContext, extra: { agentSets?: object; channel?: object; ui?: object; reactionTriggers?: object } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "turn-durable-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({ ...(extra.reactionTriggers ? { reactionTriggers: extra.reactionTriggers } : {}), ...(extra.agentSets ? { agentSets: extra.agentSets } : {}), channels: { general: { model: "fixture/model", tools: ["read"], ...(extra.channel ?? {}) } }, ui: { showToolActivity: false, ...(extra.ui ?? {}) } });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const session: ThreadSession = await createThreadSession({
    channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT",
    modelRuntime, runtimes, initialUserId: "U1",
  });
  const taskStore = new TaskStatusStore(dataDir);
  const harness = {
    taskStore, pool: { get: () => session }, pendingThread: new Map(), pendingUser: new Map(),
    config: { ui: { ackEmoji: "hourglass", showToolActivity: false, ...(extra.ui ?? {}) }, schedules: { timezone: "UTC" } },
    opts: { botToken: "synthetic" }, botUserId: "UBOT", resumedRequests: new Set<string>(),
  };
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); rmSync(dataDir, { recursive: true, force: true }); });
  const slack = fakeSlack();
  const turn = (text: string, ts: string, requestId = `slack:C1:${ts}`) =>
    (HarnessApp.prototype as any).runAgentTurn.call(
      harness, slack.client, channel, "1.1", "1.1", { channelId: "C1", userId: "U1", ts }, text, { requestId },
    );
  const queuedHarness = Object.assign(Object.create(HarnessApp.prototype), harness, {
    config, opts: { botToken: "synthetic", dataDir }, registry: new ChannelRegistry(dataDir),
    turnQueue: new Map(), turnSteering: new Map(),
    pool: { get: () => session, beginTurn() {}, async endTurn() {} },
    scheduleRecentConversationSummary() {},
  });
  const queue = (text: string, ts: string, userId = "U1") => queuedHarness.runAgent(
    slack.client, channel, "1.1", "1.1", { channelId: "C1", userId, ts, text }, text,
    { requestId: "slack:C1:" + ts },
  );
  return { faux, slack, turn, queue, queuedHarness, session, taskStore, harness, channel };
}

test("a Slack turn flows model → events → stream → ledger and produces exactly one reply", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("Hello there")]);
  const result = await f.turn("hi", "1.2");
  assert.equal(result.status, "completed");
  assert.equal(f.slack.thread.length, 1);
  assert.equal(f.slack.thread[0]!.text, "Hello there");
  assert.deepEqual(f.slack.thread[0]!.metadata, { event_type: "harness_reply", event_payload: { request_id: "slack:C1:1.2", part: 0 } });
  assert.equal((await f.session.store.deliveryState("slack:C1:1.2"))?.state, "delivered");
});

test("Slack redelivering the same event does not run the model again or post a second reply", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("First and only"), fauxAssistantMessage("must not be used")]);
  await f.turn("hi", "1.2");
  const again = await f.turn("hi", "1.2");
  assert.equal(again.status, "completed");
  assert.equal(f.faux.state.callCount, 1, "the model ran once");
  assert.equal(f.slack.thread.length, 1, "one reply in the thread");
  assert.equal(f.slack.thread[0]!.text, "First and only");
});

test("reaction read requests dedupe concurrent and later deliveries durably, independently of their source", async (t) => {
  const f = await fixture(t, { reactionTriggers: { enabled: true } });
  Object.assign(f.queuedHarness, { channelNames: new Map(), dreamer: { register() {} } });
  Object.assign(f.slack.client, { users: { info: async () => ({ user: { id: "U1", is_bot: false } }) } });
  f.slack.client.reactions.get = (async () => ({ ok: true, message: {
    ts: "1.2", thread_ts: "1.1", user: "U2", text: "A post not addressed to the assistant",
  } })) as any;
  f.faux.setResponses([
    fauxAssistantMessage("Original answer"),
    async (context) => {
      assert.match(JSON.stringify(context.messages), /asks you to read/);
      assert.match(JSON.stringify(context.messages), /A post not addressed to the assistant/);
      return fauxAssistantMessage("Read the post");
    },
    fauxAssistantMessage("Read it again"),
  ]);
  // A mention/message already answered on this post must not suppress the reaction.
  await f.queue("Original message", "1.2");
  const event = { type: "reaction_added", event_ts: "2.1", user: "U1", reaction: "robot_face",
    item: { type: "message", channel: "C1", ts: "1.2" } };
  await Promise.all([
    f.queuedHarness.handleReaction(f.slack.client, event, "EvRead"),
    f.queuedHarness.handleReaction(f.slack.client, event, "EvRead"),
  ]);
  assert.equal(f.faux.state.callCount, 2);
  // Clear process-local queues: the persisted delivery receipt still owns the event.
  f.queuedHarness.turnQueue.clear(); f.queuedHarness.turnSteering.clear();
  await f.queuedHarness.handleReaction(f.slack.client, event, "EvRead");
  assert.equal(f.faux.state.callCount, 2);
  // Removing and later adding the same reaction is a new Slack event.
  await f.queuedHarness.handleReaction(f.slack.client, { ...event, event_ts: "3.1" }, "EvReadAgain");
  assert.equal(f.faux.state.callCount, 3);
  assert.deepEqual(f.slack.thread.map((m) => m.text), ["Original answer", "Read the post", "Read it again"]);
});

test("a different message in the same thread is a new request with its own reply", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await f.turn("first", "1.2");
  await f.turn("second", "1.3");
  assert.deepEqual(f.slack.thread.map((m) => m.text), ["one", "two"]);
  assert.equal(f.faux.state.callCount, 2);
});

test("internal entry points are never mistaken for duplicates of each other", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("check-back one"), fauxAssistantMessage("check-back two")]);
  // A scheduled check-back reuses the thread's timestamp every fire; neither may be suppressed.
  await f.turn("check", "1.1", "internal:fire-1");
  await f.turn("check", "1.1", "internal:fire-2");
  assert.deepEqual(f.slack.thread.map((m) => m.text), ["check-back one", "check-back two"]);
});

test("a tool-using turn streams into a single reply that carries the whole answer", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "Let me look. " }, fauxToolCall("read", { path: "missing.txt" }, { id: "c1" })] as never, { stopReason: "toolUse" }),
    fauxAssistantMessage("It is not there."),
  ]);
  const result = await f.turn("is there a file?", "1.2");
  assert.equal(result.status, "completed");
  assert.equal(f.slack.thread.length, 1, "tool use must not leave extra messages");
  assert.match(f.slack.thread[0]!.text, /Let me look\.[\s\S]*It is not there\./);
});

test("a redelivered event for a request that restart-recovery is already answering does not also reply", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("must not be generated")]);
  f.harness.resumedRequests.add("slack:C1:1.2");          // recovery owns this request's answer
  const result = await f.turn("hi", "1.2");
  assert.equal(result.status, "completed");
  assert.equal(f.faux.state.callCount, 0, "the model did not run");
  assert.equal(f.slack.thread.length, 0, "and nothing was posted: the recovery path delivers it");
  assert.equal(await f.session.store.deliveryState("slack:C1:1.2"), undefined, "no delivery record was started");
});

test("a turn is on the channel's timeline: who asked, what the channel agent did, and that it replied", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "/definitely/not/there" }, { id: "t1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  await f.turn("please check the file https://user:secret@example.com/x", "1.2");
  const events = new ChannelTimelineLog(f.channel.paths.root).read();
  assert.deepEqual(events.map((e) => [e.kind, e.actor]), [["turn.start", "channel"], ["tool", "channel"], ["turn.end", "channel"]]);
  assert.equal(events[0]!.userId, "U1");
  assert.match(events[0]!.detail!, /please check the file/);
  assert.doesNotMatch(JSON.stringify(events), /secret/, "credentials in a URL never reach the timeline");
  assert.equal(events[1]!.title, "read");
  assert.equal(events[2]!.status, "ok");
  assert.equal(typeof events[2]!.durationMs, "number");
});

test("a delegated request: the thread shows the hand-off, the subagent's own updates and how it ended, then the answer last", async (t) => {
  const f = await fixture(t, {
    agentSets: { team: { agents: { coder: { description: "Writes code.", tools: ["read"], model: "fixture/model" } } } },
    channel: { agentSet: "team" },
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "Add another provider to the CLI. Link: https://user:hunter2@example.com/spec <!channel>" }, { id: "c1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Checking how the existing providers are registered."), fauxToolCall("read", { path: "/nowhere" }, { id: "t1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("STATUS: done\nNEXT: reviewer\nAdded the provider in src/providers.ts."),
    fauxAssistantMessage("The coder added the provider; it is ready for review."),
  ]);

  const result = await f.turn("Can we add another provider to the CLI", "1.2");
  assert.equal(result.status, "completed");

  const texts = f.slack.thread.map((m) => m.text);
  assert.equal(texts.length, 4, `hand-off, update, closing line, answer: ${JSON.stringify(texts)}`);
  assert.match(texts[0]!, /^:handshake: Handing this to \*coder\*:\n> Add another provider to the CLI/);
  assert.doesNotMatch(texts[0]!, /hunter2|<!channel>/, "no credentials, and no mention a subagent could not have been trusted to write");
  assert.match(texts[0]!, /&lt;!channel&gt;/);
  assert.equal(texts[1], "*coder*: Checking how the existing providers are registered.");
  assert.match(texts[2]!, /^:white_check_mark: \*coder\* finished \(\d+s? · 1 step\)\. It suggests \*reviewer\* next\.$/);
  assert.equal(texts[3], "The coder added the provider; it is ready for review.", "the answer is the last thing in the thread");

  // Only the answer is the reply: it carries the ledger's metadata, the progress posts do not, and it was recorded delivered once.
  assert.deepEqual(f.slack.thread.map((m) => m.metadata?.event_type), ["harness_progress", "harness_progress", "harness_progress", "harness_reply"]);
  assert.equal((await f.session.store.deliveryState("slack:C1:1.2"))?.state, "delivered");
});

test("a turn that hands nothing to a subagent posts nothing extra", async (t) => {
  const f = await fixture(t, {
    agentSets: { team: { agents: { coder: { description: "Writes code.", tools: ["read"], model: "fixture/model" } } } },
    channel: { agentSet: "team" },
  });
  f.faux.setResponses([fauxAssistantMessage("Just an answer.")]);
  await f.turn("hello", "1.2");
  assert.deepEqual(f.slack.thread.map((m) => m.text), ["Just an answer."]);
});

for (const [mode, expected] of [["handoffs", 3], ["off", 1]] as const) {
  test(`ui.subagentProgress "${mode}" limits what the thread shows while a subagent works`, async (t) => {
    const f = await fixture(t, {
      agentSets: { team: { agents: { coder: { description: "Writes code.", tools: ["read"], model: "fixture/model" } } } },
      channel: { agentSet: "team" },
      ui: { subagentProgress: mode },
    });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "Add a provider" }, { id: "c1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Checking how providers are registered, as the first step."), fauxToolCall("read", { path: "/nowhere" }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("STATUS: done\nAdded it."),
      fauxAssistantMessage("Done."),
    ]);
    await f.turn("add a provider", "1.2");
    const texts = f.slack.thread.map((m) => m.text);
    assert.equal(texts.length, expected, JSON.stringify(texts));
    assert.equal(texts.at(-1), "Done.");
    assert.ok(!texts.some((x) => /Checking how providers/.test(x)), "the subagent's own commentary is not posted");
    if (mode === "handoffs") assert.match(texts[0]!, /Handing this to \*coder\*/);
  });
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 2));
  }
  throw new Error("condition not reached");
}

test("multiple active-turn follow-ups steer the next tool boundary, preserving author/time exactly once", async (t) => {
  const f = await fixture(t);
  const entered = gate(), release = gate();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => { entered.resolve(); await release.promise;
      return fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }, { id: "steer-tool" }), { stopReason: "toolUse" }); },
    async (context) => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /use blue/); assert.match(messages, /also small/);
      assert.match(messages, /author: <@U1>/); assert.match(messages, /timestamp: 1.3/);
      assert.match(messages, /NOT a reaction/);
      return fauxAssistantMessage("A small blue result.");
    },
  ]);
  const first = f.queue("make a result", "1.2");
  await entered.promise;
  const second = f.queue("use blue", "1.3");
  const duplicate = f.queue("use blue", "1.3");
  const third = f.queue("also small", "1.4");
  await until(() => f.session.store.steeringParent("1.1", "slack:C1:1.4"));
  release.resolve();
  const results = await Promise.all([first, second, duplicate, third]);
  assert.ok(results.every((result) => result.status === "completed"));
  assert.equal(f.faux.state.callCount, 2, "both follow-ups were consumed in the same tool round");
  assert.equal(f.slack.thread.length, 1);
  assert.equal(f.slack.thread[0]!.text, "A small blue result.");
  const steering = (await f.session.store.transcript("1.1")).entries.filter((entry) => entry.kind === "slack.steering");
  assert.equal(steering.length, 2);
  assert.deepEqual(steering[0]!.data, { userId: "U1", messageTs: "1.3", parentRequestId: "slack:C1:1.2" });
  await f.queue("use blue", "1.3");
  assert.equal(f.faux.state.callCount, 2, "idle redelivery does not create another user turn");
  assert.equal(f.slack.thread.length, 1);
});

test("a final-only model gets a chronology-labelled continuation before the Slack response completes", async (t) => {
  const f = await fixture(t);
  const entered = gate(), release = gate(), continuation = gate(), finish = gate();
  t.after(() => { release.resolve(); finish.resolve(); });
  f.faux.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("Initial result."); },
    async (context) => {
      assert.match(JSON.stringify(context.messages), /NOT a reaction[\s\S]*timestamp: 1.3[\s\S]*change direction/);
      continuation.resolve(); await finish.promise;
      return fauxAssistantMessage("Revised result.");
    },
  ]);
  let completed = false;
  const first = f.queue("start", "1.2").then((result: any) => { completed = true; return result; });
  await entered.promise;
  const second = f.queue("change direction", "1.3");
  await until(() => f.session.store.steeringParent("1.1", "slack:C1:1.3"));
  release.resolve(); await continuation.promise;
  assert.equal(completed, false, "the original native submission can settle without ending the Slack turn");
  assert.deepEqual(await f.session.store.requestOutcome("1.1", "slack:C1:1.2"), { status: "pending" });
  finish.resolve(); await Promise.all([first, second]);
  assert.equal(f.slack.thread.length, 1);
  assert.match(f.slack.thread[0]!.text, /Revised result\./);
  assert.deepEqual(await f.session.store.requestOutcome("1.1", "slack:C1:1.2"), { status: "answered", text: "Revised result." });
});

test("an arrival after the injection window closes but during final Slack rendering keeps its chronology", async (t) => {
  const f = await fixture(t);
  const rendering = gate(), release = gate();
  t.after(() => release.resolve());
  const post = f.slack.client.chat.postMessage.bind(f.slack.client.chat);
  f.slack.client.chat.postMessage = (async (args: any) => {
    if (args.text === "First answer.") { rendering.resolve(); await release.promise; }
    return post(args);
  }) as typeof f.slack.client.chat.postMessage;
  f.faux.setResponses([
    fauxAssistantMessage("First answer."),
    async (context) => {
      assert.match(JSON.stringify(context.messages), /NOT a reaction[\s\S]*timestamp: 1.3[\s\S]*earlier follow-up/);
      return fauxAssistantMessage("Handled earlier follow-up.");
    },
  ]);
  const first = f.queue("start", "1.2");
  await rendering.promise;
  const second = f.queue("earlier follow-up", "1.3");
  release.resolve(); await Promise.all([first, second]);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(f.slack.thread.length, 2, "closed-window fallback is one separate, explicitly framed turn");
});

test("messages arriving during Slack/session startup are retained for the active turn", async (t) => {
  const f = await fixture(t);
  const opening = gate(), release = gate();
  t.after(() => release.resolve());
  const react = f.slack.client.reactions.add.bind(f.slack.client.reactions);
  let firstReaction = true;
  f.slack.client.reactions.add = (async (args: any) => {
    if (firstReaction) { firstReaction = false; opening.resolve(); await release.promise; }
    return react(args);
  }) as typeof f.slack.client.reactions.add;
  f.faux.setResponses([
    async () => {
      await until(() => f.session.store.steeringParent("1.1", "slack:C1:1.3"));
      return fauxAssistantMessage(fauxToolCall("read", { path: "missing" }, { id: "startup" }), { stopReason: "toolUse" });
    },
    async (context) => { assert.match(JSON.stringify(context.messages), /startup steering/); return fauxAssistantMessage("Included."); },
  ]);
  const first = f.queue("start", "1.2");
  await opening.promise;
  const second = f.queue("startup steering", "1.3");
  release.resolve(); await Promise.all([first, second]);
  assert.equal(f.slack.thread.length, 1);
  assert.equal(f.faux.state.callCount, 2);
});

test("a delayed channel lookup preserves the arrival-before-response relationship", async (t) => {
  const f = await fixture(t);
  const thinking = gate(), finish = gate(), lookup = gate(), resolveLookup = gate();
  t.after(() => { finish.resolve(); resolveLookup.resolve(); });
  f.queuedHarness.channelName = async () => { lookup.resolve(); await resolveLookup.promise; return "general"; };
  f.queuedHarness.dreamer = { register() {} };
  f.faux.setResponses([
    async () => { thinking.resolve(); await finish.promise; return fauxAssistantMessage("Done first."); },
    async (context) => { assert.match(JSON.stringify(context.messages), /NOT a reaction[\s\S]*timestamp: 1.3[\s\S]*before the answer/); return fauxAssistantMessage("Handled."); },
  ]);
  const first = f.queue("start", "1.2");
  await thinking.promise;
  const incoming = f.queuedHarness.handle(f.slack.client, {
    channelId: "C1", userId: "U1", ts: "1.3", threadTs: "1.1", text: "before the answer",
  });
  await lookup.promise; finish.resolve(); await first;
  resolveLookup.resolve(); await incoming;
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(f.slack.thread.length, 2);
});

test("steering is isolated by channel/thread; idle messages and internal work remain ordinary turns", async (t) => {
  const f = await fixture(t);
  const release = gate();
  t.after(() => release.resolve());
  const seen: string[] = [], roots: string[] = [];
  f.queuedHarness.runAgentTurn = async (_client: unknown, channel: any, key: string, _ts: string, _msg: unknown, prompt: string, options: any) => {
    roots.push(prompt);
    options.steering.start(async (input: any) => {
      seen.push(channel.ref.id + ":" + key + ":" + (await input.prepare()).text);
      return { completion: Promise.resolve({ text: "steered" }) };
    });
    await release.promise;
    await options.steering.finish();
    return { status: "completed" };
  };
  const run = (channelId: string, key: string, text: string, ts: string, realSlack = true) => f.queuedHarness.runAgent(
    f.slack.client, { ...f.channel, ref: { ...f.channel.ref, id: channelId } }, key, key,
    { channelId, userId: "U1", ts, text, threadTs: key }, text,
    realSlack ? { requestId: `slack:${channelId}:${ts}` } : undefined,
  );
  const a = run("C1", "1.1", "first root", "1.2");
  const b = run("C1", "2.1", "other thread", "2.2");
  const c = run("C2", "1.1", "other channel", "1.2");
  const follow = run("C1", "1.1", "only first", "1.3");
  await until(async () => seen.length);
  assert.deepEqual(seen, ["C1:1.1:only first"]);
  const internal = run("C1", "1.1", "internal work", "1.1", false);
  release.resolve(); await Promise.all([a, b, c, follow, internal]);
  await run("C1", "1.1", "idle follow-up", "1.4");
  assert.deepEqual(roots, ["first root", "other thread", "other channel", "internal work", "idle follow-up"]);
});

test("unthreaded DM follow-ups steer the active DM without changing idle session/delivery identity", async (t) => {
  const f = await fixture(t);
  const release = gate();
  t.after(() => release.resolve());
  const roots: string[] = [], steered: string[] = [];
  f.queuedHarness.runAgentTurn = async (_client: unknown, _channel: unknown, key: string, _ts: string, _msg: unknown, _prompt: string, options: any) => {
    roots.push(key);
    options.steering.start(async (input: any) => { steered.push((await input.prepare()).text); return { completion: Promise.resolve({ text: "ok" }) }; });
    await release.promise; await options.steering.finish();
    return { status: "completed" };
  };
  f.queuedHarness.pool.get = (_channelId: string, key: string) => {
    assert.equal(key, "1.2", "attachment/model preparation uses the active DM owner, not the follow-up ts");
    return f.session;
  };
  const dm = { ...f.channel, ref: { id: "D1", isDm: true } };
  const run = (ts: string, text: string) => f.queuedHarness.runAgent(f.slack.client, dm, ts, ts,
    { channelId: "D1", channelType: "im", userId: "U1", text, ts }, text, { requestId: "slack:D1:" + ts });
  const first = run("1.2", "start");
  const follow = run("1.3", "DM steering");
  await until(async () => steered.length);
  release.resolve(); await Promise.all([first, follow]);
  await run("1.4", "idle DM");
  assert.deepEqual(roots, ["1.2", "1.4"]);
  assert.deepEqual(steered, ["DM steering"]);
});

test("model failure settles admitted steering without leaving work running or replaying a queued turn", async (t) => {
  const f = await fixture(t);
  const entered = gate(), release = gate();
  t.after(() => release.resolve());
  f.faux.setResponses([async () => {
    entered.resolve(); await release.promise;
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fatal invalid request" });
  }]);
  const first = f.queue("start", "1.2");
  await entered.promise;
  const follow = f.queue("steer before failure", "1.3");
  await until(() => f.session.store.steeringParent("1.1", "slack:C1:1.3"));
  release.resolve();
  const results = await Promise.all([first, follow]);
  assert.ok(results.every((result) => result.status === "failed"));
  await f.session.store.waitForIdle();
  assert.equal(f.faux.state.callCount, 1);
  await f.queue("steer before failure", "1.3");
  assert.equal(f.faux.state.callCount, 1);
});

test("a closed-window fallback retry reuses its durable input even when transient framing is absent", async (t) => {
  const f = await fixture(t);
  const rendering = gate(), release = gate();
  t.after(() => release.resolve());
  const post = f.slack.client.chat.postMessage.bind(f.slack.client.chat);
  let failed = false;
  f.slack.client.chat.postMessage = (async (args: any) => {
    if (args.text === "First answer.") { rendering.resolve(); await release.promise; }
    if (args.text === "Follow-up done." && !failed) { failed = true; throw new Error("simulated delivery failure"); }
    return post(args);
  }) as typeof f.slack.client.chat.postMessage;
  f.faux.setResponses([fauxAssistantMessage("First answer."), fauxAssistantMessage("Follow-up done.")]);
  const first = f.queue("start", "1.2");
  await rendering.promise;
  const follow = f.queue("earlier follow-up", "1.3");
  release.resolve();
  const [, result] = await Promise.all([first, follow]);
  assert.match(result.deliveryError, /simulated delivery failure/);
  const retry = await f.queue("earlier follow-up", "1.3");
  assert.equal(retry.status, "completed");
  assert.equal(f.faux.state.callCount, 2, "a retry does not re-admit or regenerate the fallback");
  assert.deepEqual(f.slack.thread.map((message) => message.text), ["First answer.", "Follow-up done."]);
});

test("cross-author input queues with its own factory approval and Slack token authority", async (t) => {
  const sets = exampleAgentSet() as Record<string, { agents: Record<string, { model: string }> }>;
  for (const agent of Object.values(sets.software_factory!.agents)) agent.model = "fixture/model";
  const f = await fixture(t, {
    agentSets: sets,
    channel: { agentSet: "software_factory", tools: ["read", "slack"], allowUsers: ["UOWNER", "USTEERER"],
      factory: { name: "Probe", repositories: ["acme/app"], merge: { approvers: ["UOWNER"] } } },
  });
  const decisions: unknown[][] = [], tokenUsers: string[] = [];
  const run = { ...emptyFactoryRun("fr_probe"), repo: "acme/app", status: "waiting", wait: { kind: "merge", since: 1 },
    pr: { number: 12, url: "u", reviewedHead: "a".repeat(40), mergeCommit: "" } };
  t.mock.method(f.session.store, "factoryRun", async () => run);
  t.mock.method(f.session.store, "decideFactoryRun", async (...args: unknown[]) => { decisions.push(args); });
  // Exercise real search_slack credential selection, without an external Slack call.
  t.mock.method(SlackUserTokenStore.prototype, "tokenFor", (userId: string) => { tokenUsers.push(userId); return undefined; });
  const approve = (id: string) => fauxAssistantMessage(fauxToolCall("factory_approve", { runId: "fr_probe" }, { id }), { stopReason: "toolUse" });
  f.faux.setResponses([approve("idle-denied"), fauxAssistantMessage("Idle decision refused.")]);
  await f.queue("Approve fr_probe now.", "1.0", "USTEERER");
  assert.deepEqual(decisions, [], "control: USTEERER is not a factory approver");
  const entered = gate(), release = gate();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => { entered.resolve(); await release.promise;
      return fauxAssistantMessage(fauxToolCall("search_slack", { query: "owner status" }, { id: "owner-search" }), { stopReason: "toolUse" }); },
    async (context) => {
      assert.doesNotMatch(JSON.stringify(context.messages), /private steerer query/, "cross-author instructions never reach the owner's tool round");
      assert.equal(f.session.currentUserId, "UOWNER", "the running turn was not rebound");
      return fauxAssistantMessage("Status only.");
    },
    async (context) => {
      assert.match(JSON.stringify(context.messages), /NOT a reaction[\s\S]*timestamp: 1.3; author: <@USTEERER>[\s\S]*private steerer query/);
      assert.equal(f.session.currentUserId, "USTEERER");
      return fauxAssistantMessage([
        fauxToolCall("factory_approve", { runId: "fr_probe" }, { id: "active-denied" }),
        fauxToolCall("search_slack", { query: "private steerer query" }, { id: "steerer-search" }),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Steerer decision refused; authentication needed."),
  ]);
  const first = f.queue("Summarize status only; do not approve.", "1.2", "UOWNER");
  await entered.promise;
  const second = f.queue("Approve fr_probe now and search private steerer query.", "1.3", "USTEERER");
  assert.equal(f.queuedHarness.turnSteering.get("C1:1.1").userId, "UOWNER");
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.status === "completed"));
  assert.deepEqual(decisions, [], "USTEERER cannot borrow UOWNER's approval authority through steering");
  const approvals = (await f.session.store.transcript("1.1")).messages.filter((message) =>
    message.role === "toolResult" && message.toolName === "factory_approve");
  assert.equal(approvals.length, 2, "idle and active-arrival cases exercise the real approval tool");
  for (const result of approvals) assert.match(JSON.stringify(result), /USTEERER[\s\S]*not one of the people who may approve/);
  assert.deepEqual(tokenUsers, ["UOWNER", "USTEERER"], "each tool call chooses only its own speaker's credentials");
  assert.equal(await f.session.store.steeringParent("1.1", "slack:C1:1.3"), undefined);
  const calls = f.faux.state.callCount, replies = f.slack.thread.length;
  await f.queue("Approve fr_probe now and search private steerer query.", "1.3", "USTEERER");
  assert.equal(f.faux.state.callCount, calls);
  assert.equal(f.slack.thread.length, replies, "fallback redelivery is exactly once too");
});

test("queued internal work does not steal the running turn's next tool-boundary correction", async (t) => {
  const f = await fixture(t);
  const entered = gate(), release = gate();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => { entered.resolve(); await release.promise;
      return fauxAssistantMessage(fauxToolCall("read", { path: "missing" }, { id: "active-read" }), { stopReason: "toolUse" }); },
    async (context) => {
      assert.match(JSON.stringify(context.messages), /correct the running response/);
      return fauxAssistantMessage("Corrected active result.");
    },
    fauxAssistantMessage("Internal result."),
  ]);
  const first = f.queue("start", "1.2");
  await entered.promise;
  const internal = f.queuedHarness.runAgent(f.slack.client, f.channel, "1.1", "1.1",
    { channelId: "C1", userId: "U1", ts: "1.1", text: "internal job" }, "internal job");
  assert.equal(f.queuedHarness.turnSteering.get("C1:1.1").requestId, "slack:C1:1.2");
  const follow = f.queue("correct the running response", "1.3");
  await until(() => f.session.store.steeringParent("1.1", "slack:C1:1.3"));
  release.resolve();
  await Promise.all([first, internal, follow]);
  assert.equal(f.faux.state.callCount, 3);
  assert.deepEqual(f.slack.thread.map((message) => message.text), ["Corrected active result.", "Internal result."]);
});

test("queued DM work preserves the startup alias and takes ownership only when it starts", async (t) => {
  const f = await fixture(t);
  const releaseFirst = gate(), releaseInternal = gate(), internalStarted = gate();
  t.after(() => { releaseFirst.resolve(); releaseInternal.resolve(); });
  const seen: string[] = [];
  f.queuedHarness.runAgentTurn = async (_client: unknown, _channel: unknown, _key: string, _ts: string, _msg: unknown, prompt: string, options: any) => {
    options.steering.start(async (input: any) => {
      seen.push(prompt + ":" + (await input.prepare()).text);
      return { completion: Promise.resolve({ text: "ok" }) };
    });
    if (prompt === "first") await releaseFirst.promise;
    else { internalStarted.resolve(); await releaseInternal.promise; }
    await options.steering.finish();
    return { status: "completed" };
  };
  const dm = { ...f.channel, ref: { id: "D1", isDm: true } };
  const run = (ts: string, prompt: string, internal = false) => f.queuedHarness.runAgent(f.slack.client, dm, ts, ts,
    { channelId: "D1", channelType: "im", userId: "U1", ts, text: prompt }, prompt,
    internal ? undefined : { requestId: "slack:D1:" + ts });
  const first = run("1.2", "first");
  // These synchronous arrivals happen before the initial runAgentTurn even starts.
  const internal = run("1.2", "internal", true);
  const follow = run("1.3", "startup correction");
  await until(async () => seen.length === 1);
  assert.deepEqual(seen, ["first:startup correction"]);
  releaseFirst.resolve(); await internalStarted.promise; await first;
  assert.equal(f.queuedHarness.turnSteering.get("D1:dm").threadKey, "1.2");
  const later = run("1.4", "internal correction");
  await until(async () => seen.length === 2);
  releaseInternal.resolve(); await Promise.all([internal, follow, later]);
  assert.deepEqual(seen, ["first:startup correction", "internal:internal correction"]);
  assert.equal(f.queuedHarness.turnSteering.size, 0);
});
