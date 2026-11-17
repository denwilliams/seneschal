import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { createThreadSession, type CreateThreadSessionOptions, type ThreadSession } from "./session.ts";
import type { TurnEvent } from "./turn-events.ts";
import { TurnSteering } from "./steering.ts";

async function fixture(t: TestContext, channelConfig: Record<string, unknown> = {}, runtimeOptions: Partial<ConstructorParameters<typeof ChannelRuntimes>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "session-durable-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({
    channels: { general: { model: "fixture/model", tools: ["read", "write"], ...channelConfig } },
  });
  const resolve = () => resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const runtimes = new ChannelRuntimes({ modelRuntime, ...runtimeOptions });
  const sessions: ThreadSession[] = [];
  t.after(async () => {
    for (const session of sessions) await session.dispose().catch(() => undefined);
    await runtimes.closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const open = async (threadKey: string, extra: Partial<CreateThreadSessionOptions> = {}) => {
    const session = await createThreadSession({
      channel: resolve(), threadKey, harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT",
      modelRuntime, runtimes, initialUserId: "U1", ...extra,
    });
    sessions.push(session);
    return session;
  };
  return { dataDir, faux, runtimes, modelRuntime, resolve, open, forget: (session: ThreadSession) => sessions.splice(sessions.indexOf(session), 1) };
}

const turn = (session: ThreadSession, text: string, requestId: string, userId = "U1") => {
  const events: TurnEvent[] = [];
  const stop = session.session.subscribe((event) => events.push(event));
  return session.session.prompt(text, { requestId, userId }).then(() => { stop(); return events; });
};

test("live and quiet scheduled sessions can read current time without bash or scheduling permissions", async (t) => {
  const f = await fixture(t, { tools: [], schedules: false });
  for (const threadKey of ["live-clock", "scheduled-clock"]) {
    const session = await f.open(threadKey, { defaultTimezone: "Asia/Kathmandu" });
    const before = Date.now();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("get_current_time", {}, { id: `clock-${threadKey}` }) as never, { stopReason: "toolUse" }),
      fauxAssistantMessage("checked the clock"),
    ]);
    const events = await turn(session, "What time is it now?", `r-${threadKey}`);
    const event = events.find((e) => e.type === "tool_end" && e.toolName === "get_current_time");
    assert.ok(event && event.type === "tool_end" && !event.isError, "the model can execute the clock tool");
    const transcript = await session.store.transcript(threadKey);
    const result = transcript.messages.find((m) => m.role === "toolResult" && m.toolName === "get_current_time");
    assert.ok(result && result.role === "toolResult");
    const content = result.content[0]!;
    assert.ok(content.type === "text");
    const clock = JSON.parse(content.text);
    assert.equal(clock.timezone, "Asia/Kathmandu");
    assert.equal(clock.utcOffset, "+05:45");
    assert.ok(Date.parse(clock.timestamp) >= before && Date.parse(clock.timestamp) <= Date.now());
    const names = session.store.registeredToolNames();
    assert.ok(names.includes("get_current_time"));
    assert.ok(!names.includes("bash") && !names.includes("schedule_task"));
  }
});

test("Durable dispatch saves authorized built-ins and preserves nested jail and tool restrictions", async (t) => {
  const f = await fixture(t, { tools: ["read"] });
  const session = await f.open("save-output");
  const workspace = f.resolve().paths.workspace;
  writeFileSync(join(workspace, "source.txt"), "Exact source text\n");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("save_tool_output", { tool: "read", arguments: { path: "source.txt" }, path: "export.json" }, { id: "save-read" }) as never, { stopReason: "toolUse" }),
    fauxAssistantMessage("saved"),
  ]);
  const events = await turn(session, "Save the read result", "save-1");
  assert.ok(events.some((e) => e.type === "tool_end" && e.toolName === "save_tool_output" && !e.isError));
  const saved = JSON.parse(readFileSync(join(workspace, "export.json"), "utf8"));
  assert.equal(saved.result.content[0].text, "Exact source text\n");
  for (const [tool, args] of [["write", { path: "unauthorized.txt", content: "bad" }], ["read", { path: join(f.dataDir, "private.txt") }]] as const) {
    writeFileSync(join(f.dataDir, "private.txt"), "private");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("save_tool_output", { tool, arguments: args, path: "blocked.json" }, { id: "blocked-" + tool }) as never, { stopReason: "toolUse" }),
      fauxAssistantMessage("blocked"),
    ]);
    const denied = await turn(session, "Try unauthorized " + tool, "blocked-" + tool);
    assert.ok(denied.some((e) => e.type === "tool_end" && e.toolName === "save_tool_output" && e.isError));
  }
  assert.ok(!existsSync(join(workspace, "unauthorized.txt")));
  assert.ok(!existsSync(join(workspace, "blocked.json")));
});

test("a thread session runs a turn through its channel store and reports events, text and model", async (t) => {
  const f = await fixture(t);
  const session = await f.open("100.1");
  assert.equal(session.isNewConversation, true);
  f.faux.setResponses([fauxAssistantMessage("Hello from the fork")]);
  const events = await turn(session, "hi", "r1");
  assert.ok(events.some((event) => event.type === "assistant_message_end"));
  assert.equal(session.session.getLastAssistantText(), "Hello from the fork");
  assert.equal((await session.session.model())?.id, "model");
});

test("re-opening a thread finds its conversation, so only the first session is new", async (t) => {
  const f = await fixture(t);
  const first = await f.open("100.1");
  f.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await turn(first, "first", "r1");
  await first.dispose(); f.forget(first);
  const again = await f.open("100.1");
  assert.equal(again.isNewConversation, false, "an evicted-and-resumed thread must not be re-backfilled from Slack");
  await turn(again, "second", "r2");
  const runtime = f.runtimes.peek("C1")!;
  const transcript = (await runtime.store.transcript("100.1")).messages.flatMap((m) => typeof m.content === "string" ? [m.content] : []);
  assert.ok(transcript.includes("first") && transcript.includes("second"), "the thread kept its own history across sessions");
});

test("a retried Slack message (same request id) does not run the model twice", async (t) => {
  const f = await fixture(t);
  const session = await f.open("100.1");
  f.faux.setResponses([fauxAssistantMessage("only once"), fauxAssistantMessage("never used")]);
  await turn(session, "hello", "slack:C1:100.1");
  await turn(session, "hello", "slack:C1:100.1");
  assert.equal(f.faux.state.callCount, 1);
});

test("two threads in one channel share a store but have separate conversations and speakers", async (t) => {
  const f = await fixture(t);
  const a = await f.open("A"); const b = await f.open("B", { initialUserId: "U2" });
  f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await turn(a, "ALPHA-ONLY", "ra"); await turn(b, "beta", "rb", "U2");
  const { store } = f.runtimes.peek("C1")!;
  assert.ok(!(await store.transcript("B")).messages.some((m) => JSON.stringify(m.content).includes("ALPHA-ONLY")));
  assert.equal(a.currentUserId, "U1"); assert.equal(b.currentUserId, "U2");
});

test("the agent can switch its own model; the switch outlives the session", async (t) => {
  const f = await fixture(t);
  const session = await f.open("100.1");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("switch_model", { model: "fixture/other" }, { id: "c1" }) as never, { stopReason: "toolUse" }),
    fauxAssistantMessage("switched"),
  ]);
  await turn(session, "use the other model", "r1");
  assert.equal((await session.session.model())?.id, "other");
  await session.dispose(); f.forget(session);
  assert.equal((await (await f.open("100.1")).session.model())?.id, "other", "a pinned thread resumes on the model it chose");
});

test("a restricted run is offered only its own tools, without narrowing the channel's live threads", async (t) => {
  const f = await fixture(t);
  const full: Omit<CreateThreadSessionOptions, "threadKey"> = {
    channel: f.resolve(), harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT",
    modelRuntime: f.modelRuntime, runtimes: f.runtimes, poster: { post: async () => ({ ts: "1" }) } as never,
  };
  // A restricted session (no poster) opens the store FIRST, yet the channel's full schemas must be registered.
  const quiet = await f.open("sched-1", { template: full });
  f.faux.setResponses([fauxAssistantMessage("quiet done"), fauxAssistantMessage("live done")]);
  await turn(quiet, "scheduled", "rq");
  const live = await f.open("live-thread", { poster: full.poster! });
  await turn(live, "hello", "rl");
  const { store } = f.runtimes.peek("C1")!;
  const added = async (thread: string) => (await store.transcript(thread)).entries.flatMap((e) => e.model ?? [])
    .filter((m) => m.role === "system").flatMap((m) => ((m as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((x) => x.name));
  assert.ok(!(await added("sched-1")).includes("post_message"), "the quiet run must not be offered post_message");
  assert.ok((await added("live-thread")).includes("post_message"), "the live thread keeps the full set");
});

test("invalidating a channel waits for its sessions, then the next session opens a fresh store", async (t) => {
  const f = await fixture(t);
  const session = await f.open("100.1");
  f.faux.setResponses([fauxAssistantMessage("before the restart")]);
  await turn(session, "hello", "r0");        // the thread has real history before the store is retired
  const first = f.runtimes.peek("C1")!;
  let closed = false;
  const invalidation = f.runtimes.invalidate("C1").then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false, "the store must stay open while a session still uses it");
  await session.dispose(); f.forget(session);
  await invalidation;
  assert.equal(f.runtimes.peek("C1"), undefined);
  f.faux.setResponses([fauxAssistantMessage("after reopen")]);
  const next = await f.open("100.1");
  assert.equal(next.isNewConversation, false, "a used thread is not new after the store restarts");
  assert.notEqual(f.runtimes.peek("C1"), first, "a new store instance serves the new configuration");
  await turn(next, "still here?", "r9");
  assert.equal(next.isNewConversation, false, "the conversation persisted across the store restart");
});

test("the recovery gate runs once, before the first session can touch a freshly opened store", async (t) => {
  const order: string[] = [];
  let gates = 0;
  const f = await fixture(t, {}, { gate: async (runtime) => { gates++; order.push(`gate:${runtime.channel.ref.id}`); } });
  const first = await f.open("100.1");
  order.push("first-session");
  const second = await f.open("100.2");
  void second;
  assert.deepEqual(order, ["gate:C1", "first-session"]);
  assert.equal(gates, 1, "a store already open is not re-gated for every thread");
  void first;
});

test("a failing gate closes the store and fails the open; the next attempt gates again", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {}, { gate: async () => { if (++attempts === 1) throw new Error("recovery exploded"); } });
  await assert.rejects(f.open("100.1"), /recovery exploded/);
  assert.equal(f.runtimes.peek("C1"), undefined, "no half-recovered store is left open");
  f.faux.setResponses([fauxAssistantMessage("fine now")]);
  const session = await f.open("100.1");
  await turn(session, "hi", "r1");
  assert.equal(attempts, 2);
});

test("while recovery is blocked no session can run a turn, and the user is told why", async (t) => {
  const f = await fixture(t, {}, {
    gate: async ({ store }) => { await store.setBlocked([{ conversationId: 1 as never, threadKey: "100.9", reason: "speaker U7 is no longer allowed", since: 0 }]); },
  });
  const session = await f.open("100.1");
  f.faux.setResponses([fauxAssistantMessage("must not run")]);
  await assert.rejects(turn(session, "hello", "r1"), /channel is paused.*speaker U7 is no longer allowed.*!recovery/s);
  assert.equal(f.faux.state.callCount, 0, "the model must never be called while a recovered conversation is unresolved");
});

// ── Regressions from the independent review ──────────────────────────────────────────────────────────────────
import { ThreadToolBindings } from "./durable/pi-tool-adapter.ts";
import { buildThreadToolSet } from "./session.ts";

/** A store stand-in whose behaviour a test can break, to drive createThreadSession's error paths. */
async function brokenStoreFixture(t: TestContext, overrides: Record<string, unknown>) {
  const f = await fixture(t);
  const channel = f.resolve();
  const base = { channel, harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT", modelRuntime: f.modelRuntime, initialUserId: "U1" };
  const probe = await buildThreadToolSet({ ...base, threadKey: "x", runtimes: f.runtimes }, { current: () => undefined, set: async () => undefined });
  const names = probe.tools.map((tool) => tool.name); await probe.dispose();
  const bindings = new ThreadToolBindings();
  const calls = { released: 0, cleared: 0 };
  const store = {
    registeredToolNames: () => names, setThreadProfile() {}, clearThreadProfile() { calls.cleared++; },
    admittedRequests: async () => 0, conversationIdFor: async () => 7, liveRequests: async () => [],
    model: async () => ({ provider: "fixture", modelId: "model" }), ...overrides,
  };
  const runtimes = {
    acquire: async () => ({ runtime: { channel, store, bindings, disposers: [] }, release() { calls.released++; } }),
    invalidate: async () => {},
  } as unknown as ChannelRuntimes;
  return { f, bindings, calls, create: () => createThreadSession({ ...base, threadKey: "T", runtimes }) };
}

test("a failure late in session setup gives back the lease, the binding and the profile (a leaked lease would hang the channel)", async (t) => {
  const b = await brokenStoreFixture(t, { model: async () => { throw new Error("provider no longer configured"); } });
  await assert.rejects(b.create(), /provider no longer configured/);
  assert.equal(b.calls.released, 1, "the lease was released");
  assert.equal(b.calls.cleared, 1, "the thread profile was cleared");
  assert.equal(b.bindings.has(7 as never), false, "the tools are no longer bound to the conversation");
});

test("a live session will not bind over a turn that is being resumed after a restart", async (t) => {
  const b = await brokenStoreFixture(t, { liveRequests: async () => [{ requestId: "r", userId: "UA" }] });
  const recovered = { tools: new Map() };
  b.bindings.bind(7 as never, recovered, { recovered: true });
  await assert.rejects(b.create(), /still being resumed/);
  assert.equal(b.calls.released, 1);
  assert.equal(b.bindings.isRecovered(7 as never), true, "the recovered turn keeps ITS tools and speaker");
});

test("once the resumed turn has finished a live session binds normally", async (t) => {
  const b = await brokenStoreFixture(t, { liveRequests: async () => [] });
  b.bindings.bind(7 as never, { tools: new Map() }, { recovered: true });
  const session = await b.create();
  assert.equal(b.bindings.isRecovered(7 as never), false);
  await session.dispose();
  assert.equal(b.calls.released, 1);
});

test("a tool the store never registered (a connector was down when it opened) is withheld and the store is re-opened, not fatal", async (t) => {
  const f = await fixture(t);
  const withPoster: Omit<CreateThreadSessionOptions, "threadKey"> = {
    channel: f.resolve(), harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT",
    modelRuntime: f.modelRuntime, runtimes: f.runtimes, poster: { post: async () => ({ ts: "1" }) } as never,
  };
  // The store is opened by a session that did not have post_message, so it never registers it.
  const first = await f.open("first", { template: { ...withPoster, poster: undefined } as never });
  const first2 = f.runtimes.peek("C1")!;
  assert.ok(!first2.store.registeredToolNames().includes("post_message"));
  // A later session that does have it must still start (previously: 'Unregistered tool in profile').
  const later = await f.open("later", { poster: withPoster.poster! });
  f.faux.setResponses([fauxAssistantMessage("works")]);
  await turn(later, "hi", "r1");
  const offered = (await first2.store.transcript("later")).entries.flatMap((e) => e.model ?? [])
    .filter((m) => m.role === "system").flatMap((m) => ((m as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((x) => x.name));
  assert.ok(!offered.includes("post_message"), "an unregistered tool is not offered");
  // It schedules the store to be re-opened so the next session registers the full set.
  await first.dispose(); f.forget(first); await later.dispose(); f.forget(later);
  for (let spins = 0; spins < 100 && f.runtimes.peek("C1"); spins++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.runtimes.peek("C1"), undefined, "the store was retired once its sessions released it");
});

test("a storage failure kills only that store: the channel recovers on the next message instead of staying dead", async (t) => {
  const f = await fixture(t);
  const session = await f.open("100.1");
  f.faux.setResponses([fauxAssistantMessage("before the failure")]);
  await turn(session, "hello", "r1");
  const failing = f.runtimes.peek("C1")!;
  // Provoke a real storage error: pull the conversations database out from under the running store.
  await (failing.store as unknown as { database: { close(): Promise<void> } }).database.close();
  await assert.rejects(turn(session, "this cannot be stored", "r2"));
  const end = await failing.store.ended;
  assert.equal(end.reason, "failed", "since pi-durable 1.2 a storage error fails the whole store for good");
  await session.dispose(); f.forget(session);
  for (let spins = 0; spins < 100 && f.runtimes.peek("C1") === failing; spins++) await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(f.runtimes.peek("C1"), failing, "the failed store was retired");
  // The next message gets a fresh store over the same directory (so its lock was released) and the thread's history.
  f.faux.setResponses([fauxAssistantMessage("back again")]);
  const next = await f.open("100.1");
  assert.equal(next.isNewConversation, false, "the thread kept its history across the failure");
  await turn(next, "are you there?", "r3");
  assert.equal(next.session.getLastAssistantText(), "back again");
});

test("a failed store is reported to its owner only after it was retired, so a replacement can open at once", async (t) => {
  const failed: { id: string; stillRegistered: boolean }[] = [];
  let runtimes!: ChannelRuntimes;
  const f = await fixture(t, {}, { onFailed: (id) => failed.push({ id, stillRegistered: runtimes.channelIds().includes(id) }) });
  runtimes = f.runtimes;
  const session = await f.open("100.1");
  f.faux.setResponses([fauxAssistantMessage("before the failure")]);
  await turn(session, "hello", "r1");
  assert.deepEqual(f.runtimes.channelIds(), ["C1"]);
  await (f.runtimes.peek("C1")!.store as unknown as { database: { close(): Promise<void> } }).database.close();
  await assert.rejects(turn(session, "this cannot be stored", "r2"));
  await session.dispose(); f.forget(session);
  for (let spins = 0; spins < 100 && failed.length === 0; spins++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(failed, [{ id: "C1", stillRegistered: false }], "reported once, and only once the failed store was gone");
});

test("a model can read and update the channel state through a real session, and it outlives the session", async (t) => {
  const f = await fixture(t, { tools: ["read"] });
  const session = await f.open("100.1");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("state_update", { op: "set", path: "/jobs/last", value: { status: "ok" } }, { id: "c1" }) as never, { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("state_read", { path: "/jobs/last" }, { id: "c2" }) as never, { stopReason: "toolUse" }),
    fauxAssistantMessage("recorded"),
  ]);
  await turn(session, "record the result", "r1");
  assert.equal(session.session.getLastAssistantText(), "recorded");
  await session.dispose(); f.forget(session);
  const store = f.runtimes.peek("C1")!.store;
  assert.deepEqual((await store.readState("/jobs/last")).value, { status: "ok" });
  const snapshot = await store.stateSnapshot();
  assert.deepEqual([snapshot.rev, snapshot.changes[0]!.threadKey, snapshot.updatedBy.source], [1, "100.1", "agent"], "attributed to the thread that wrote it");
  // Another thread sees it, and a channel that did not ask for the tool is not offered it.
  const other = await f.open("200.1");
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("state_read", {}, { id: "c3" }) as never, { stopReason: "toolUse" }), fauxAssistantMessage("saw it")]);
  const events = await turn(other, "what is the state?", "r2");
  assert.ok(events.some((e) => e.type === "tool_end" && e.toolName === "state_read" && !e.isError));
  assert.deepEqual(store.registeredToolNames().filter((name) => name.startsWith("state_")), ["state_read", "state_update"]);
});

test("state is always available: a channel with a minimal tools list has it, and it is not a configurable tool name", async (t) => {
  const f = await fixture(t, { tools: ["read"] });
  await f.open("100.1");
  assert.deepEqual(f.runtimes.peek("C1")!.store.registeredToolNames().filter((name) => name.startsWith("state_")), ["state_read", "state_update"]);
  assert.throws(() => HarnessConfigSchema.parse({ channels: { general: { tools: ["state"] } } }), "it is infrastructure, not a tool a channel opts into");
});

test("a subagent can read the channel state but not write it", async (t) => {
  const f = await fixture(t, { tools: ["read"] });
  const toolSet = await buildThreadToolSet(
    { channel: f.resolve(), threadKey: "sub-x", harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT", modelRuntime: f.modelRuntime, runtimes: f.runtimes, role: "subagent" },
    { current: () => undefined, set: async () => { throw new Error("no"); } },
  );
  t.after(() => toolSet.dispose());
  assert.deepEqual(toolSet.tools.map((tool) => tool.name).filter((name) => name.startsWith("state_")), ["state_read"]);
  const channelSet = await buildThreadToolSet(
    { channel: f.resolve(), threadKey: "100.1", harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT", modelRuntime: f.modelRuntime, runtimes: f.runtimes },
    { current: () => undefined, set: async () => { throw new Error("no"); } },
  );
  t.after(() => channelSet.dispose());
  assert.deepEqual(channelSet.tools.map((tool) => tool.name).filter((name) => name.startsWith("state_")), ["state_read", "state_update"]);
});

const helloJobs = {
  tools: ["read", "exec"],
  exec: { commands: { echo: { command: "/bin/echo", allowArgs: [["**"]] } } },
  jobs: {
    hello: {
      description: "Say hello and remember it",
      input: { who: { default: "world" } },
      phases: [
        { name: "say", kind: "exec", command: "echo", args: ["hello", "${input.who}"] },
        { name: "record", kind: "state", op: "set", path: "/said", value: "${phases.say.result}" },
      ],
    },
  },
};

test("a channel with jobs is offered the job tools, and one without is not", async (t) => {
  const withJobs = await fixture(t, helloJobs);
  await withJobs.open("100.1");
  assert.deepEqual(withJobs.runtimes.peek("C1")!.store.registeredToolNames().filter((name) => /job/.test(name)), ["list_jobs", "run_job", "check_job", "job_decide", "job_abort"]);
  const without = await fixture(t, { tools: ["read"] });
  await without.open("100.1");
  assert.deepEqual(without.runtimes.peek("C1")!.store.registeredToolNames().filter((name) => /job/.test(name)), []);
});

test("a subagent is never given the job tools, even in a channel that has jobs", async (t) => {
  const f = await fixture(t, helloJobs);
  const toolSet = await buildThreadToolSet(
    { channel: f.resolve(), threadKey: "sub-x", harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT", modelRuntime: f.modelRuntime, runtimes: f.runtimes, role: "subagent" },
    { current: () => undefined, set: async () => { throw new Error("no"); } },
  );
  t.after(() => toolSet.dispose());
  assert.deepEqual(toolSet.tools.map((tool) => tool.name).filter((name) => /job/.test(name)), []);
});

test("the prompt lists the channel's jobs with their descriptions, and teaches when to start one and who decides", async (t) => {
  const f = await fixture(t, helloJobs);
  const prompt = buildSystemPrompt(f.resolve(), { harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT" });
  assert.match(prompt, /## Jobs/);
  assert.match(prompt, /`hello`: Say hello and remember it/);
  assert.match(prompt, /never on your own initiative/);
  assert.match(prompt, /only with the answer a person gave you/);
  const plain = await fixture(t, { tools: ["read"] });
  assert.doesNotMatch(buildSystemPrompt(plain.resolve(), { harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT" }), /## Jobs/);
});

test("end to end: a model starts a job, a real command runs through the channel's exec policy, and its output lands in the channel state", async (t) => {
  const f = await fixture(t, helloJobs);
  const session = await f.open("100.1");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_job", { name: "hello", input: { who: "there" } }, { id: "c1" }) as never, { stopReason: "toolUse" }),
    fauxAssistantMessage("started it"),
  ]);
  await turn(session, "say hello to there", "r1");
  assert.equal(session.session.getLastAssistantText(), "started it");
  const store = f.runtimes.peek("C1")!.store;
  await store.resume();
  let run;
  for (let spins = 0; spins < 300; spins++) {
    run = (await store.listJobRuns())[0];
    if (run && (run.status === "completed" || run.status === "failed")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(run?.status, "completed", `the run finished (${run?.status}: ${run?.reason})`);
  assert.deepEqual(run!.input, { who: "there" });
  assert.deepEqual(run!.by, { source: "agent", threadKey: "100.1", userId: "U1" });
  assert.deepEqual(run!.phases.map((p) => [p.name, p.status]), [["say", "done"], ["record", "done"]]);
  assert.equal((await store.readState("/said")).value, "hello there", "/bin/echo ran, and its output is the channel's state now");
  const snapshot = await store.stateSnapshot();
  assert.equal(snapshot.updatedBy.source, "job");
});

test("a session reports where its start-up time went, so a slow first message can be explained", async (t) => {
  const f = await fixture(t);
  const session = await f.open("100.1");
  const { toolsMs, storeMs, threadMs, totalMs } = session.timings;
  for (const value of [toolsMs, storeMs, threadMs, totalMs]) assert.ok(Number.isFinite(value) && value >= 0);
  assert.ok(totalMs >= toolsMs + storeMs, "the phases are parts of the total");
  const second = await f.open("100.2");
  assert.ok(second.timings.storeMs <= session.timings.storeMs + 50, "a store that is already open is not re-opened for the second thread");
});

test("session-level steering refuses another author before preparation or durable admission", async (t) => {
  const f = await fixture(t);
  const session = await f.open("100.1");
  const steering = new TurnSteering();
  let prepared = false;
  const offered = steering.offer({ requestId: "steer-other", userId: "U2", messageTs: "1.3",
    prepare: async () => { prepared = true; return { text: "use someone else's authority" }; } });
  f.faux.setResponses([fauxAssistantMessage("Owner answer.")]);
  await session.session.prompt("status only", { requestId: "owner-turn", userId: "U1", steering });
  assert.equal(await offered, false);
  assert.equal(prepared, false);
  assert.equal(session.currentUserId, "U1");
  assert.equal(await session.store.steeringParent("100.1", "steer-other"), undefined);
  assert.equal(f.faux.state.callCount, 1);
});
