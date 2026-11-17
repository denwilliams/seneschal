import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore, type ChannelStoreOptions } from "./channel-store.ts";

async function fixture(t: TestContext, channelId = "C1") {
  const root = await mkdtemp(join(tmpdir(), "durable-forks-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const opts: ChannelStoreOptions = {
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId, models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model", "fixture/other"],
  };
  const open = new Set<DurableChannelStore>();
  t.after(async () => { for (const store of open) await store.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, opts, faux,
    open: async (overrides: Partial<ChannelStoreOptions> = {}) => {
      const store = await DurableChannelStore.open({ ...opts, ...overrides }); open.add(store); return store;
    },
    close: async (store: DurableChannelStore) => { await store.close(); open.delete(store); },
  };
}
const ask = (store: DurableChannelStore, thread: string, text: string, id = `${thread}-${text}`) =>
  store.submit(thread, { requestId: id, content: text, userId: "U1" }).then((submission) => store.wait(submission));
const texts = async (view: Promise<{ messages: readonly { role: string; content: unknown }[] }>) =>
  (await view).messages.flatMap((message) => typeof message.content === "string"
    ? [message.content]
    : (message.content as { type: string; text?: string }[]).flatMap((block) => block.text ? [block.text] : []));

test("a thread is a fork of the channel trunk: it sees trunk context up to its start and nothing later", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.appendMainContext("slack.channel.context", "CONTEXT-BEFORE: deploys happen on Fridays");
  assert.equal(await store.hasThread("100.1"), false);
  f.faux.setResponses([fauxAssistantMessage("first reply")]);
  await ask(store, "100.1", "hello");
  assert.equal(await store.hasThread("100.1"), true);
  await store.appendMainContext("slack.channel.context", "CONTEXT-AFTER: appended once the thread existed");
  f.faux.setResponses([fauxAssistantMessage("second reply")]);
  await ask(store, "100.1", "again");
  const thread = await texts(store.transcript("100.1"));
  assert.ok(thread.some((text) => text.includes("CONTEXT-BEFORE")), "inherits the trunk context it forked from");
  assert.ok(!thread.some((text) => text.includes("CONTEXT-AFTER")), "later trunk entries must not leak into an existing thread");
  assert.ok(thread.includes("hello") && thread.includes("again"));
});

test("thread transcripts never write into the trunk or into sibling threads", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("alpha reply"), fauxAssistantMessage("beta reply")]);
  await ask(store, "A", "SECRET-ALPHA-QUESTION");
  await ask(store, "B", "beta question");
  const main = await texts(store.mainTranscript());
  const beta = await texts(store.transcript("B"));
  assert.ok(!main.some((text) => text.includes("ALPHA")), "trunk stays free of thread chatter");
  assert.ok(!beta.some((text) => text.includes("ALPHA")), "sibling threads are independent");
  assert.ok(beta.includes("beta question"));
});

test("digests appended to the trunk reach threads created afterwards, not threads that already exist", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
  await ask(store, "T1", "start the migration");
  await store.appendMainContext("slack.thread.digest", "[thread T1] user started the migration; agent drafted a plan");
  await ask(store, "T2", "what did we do lately?");
  await ask(store, "T1", "continue");
  assert.ok((await texts(store.transcript("T2"))).some((text) => text.includes("[thread T1]")));
  assert.ok(!(await texts(store.transcript("T1"))).some((text) => text.includes("[thread T1]")));
});

test("concurrent first messages in one new thread create exactly one fork", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  const [one, two] = await Promise.all([
    store.submit("RACE", { requestId: "r-1", content: "first", userId: "U1" }),
    store.submit("RACE", { requestId: "r-2", content: "second", userId: "U2" }),
  ]);
  await Promise.all([store.wait(one), store.wait(two)]);
  const transcript = await texts(store.transcript("RACE"));
  assert.ok(transcript.includes("first") && transcript.includes("second"), "both messages landed in the same conversation");
  // A single thread mapping means one set of forks: main plus one thread conversation.
  const sizes = (await store.transcript("RACE")).entries.filter((entry) => entry.kind === "slack.channel.root").length;
  assert.equal(sizes, 1, "the trunk marker appears once in the fork's inherited history");
});

test("reset re-forks the thread from the trunk tail and keeps the old fork for inspection", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("old reply"), fauxAssistantMessage("new reply")]);
  await ask(store, "R", "OLD-CONVERSATION-MARKER");
  assert.equal(await store.resetThread("R"), true);
  assert.equal(await store.resetThread("never-existed"), false);
  await ask(store, "R", "fresh start");
  const after = await texts(store.transcript("R"));
  assert.ok(!after.some((text) => text.includes("OLD-CONVERSATION-MARKER")), "reset must start a clean context");
  assert.ok(after.includes("fresh start"));
});

test("a fork inherits stored tools but the CURRENT loadout is re-applied on activation", async (t) => {
  const f = await fixture(t);
  const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }) });
  let store = await f.open({ tools: [tool("alpha"), tool("beta")] });
  f.faux.setResponses([fauxAssistantMessage("hi")]);
  await ask(store, "L", "hello");
  await f.close(store);
  store = await f.open({ tools: [tool("alpha")] });
  f.faux.setResponses([fauxAssistantMessage("again")]);
  await ask(store, "L", "second");
  const system = (await store.transcript("L")).entries.flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "system") as unknown as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[];
  assert.deepEqual(system[0]?.toolsAdded?.map((entry) => entry.name), ["alpha", "beta"]);
  assert.deepEqual(system[1]?.toolsRemoved?.map((entry) => entry.name), ["beta"],
    "a tool dropped from the loadout must be withdrawn from a pre-existing fork, not inherited");
});

test("separate channels have separate trunks and cannot see each other's threads", async (t) => {
  const one = await fixture(t, "C1"); const two = await fixture(t, "C2");
  const first = await one.open(); const second = await two.open();
  one.faux.setResponses([fauxAssistantMessage("a")]);
  await ask(first, "T", "CHANNEL-ONE-ONLY");
  assert.equal(await second.hasThread("T"), false);
  assert.ok(!(await texts(second.mainTranscript())).some((text) => text.includes("CHANNEL-ONE-ONLY")));
});

test("after a SIGKILL the live conversation is reported with its Slack thread so the recovery gate can rebind it", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const child = fork(fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url)), [f.root, "tool"], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child, "message");
  child.kill("SIGKILL"); await once(child, "exit");
  const store = await f.open();
  const live = await store.liveRoutes();
  assert.deepEqual(live.map((entry) => entry.route), [{ kind: "thread", threadKey: "thread" }]);
  assert.equal((await store.inspect()).scheduling, "paused", "opening a crashed store must not start work");
});

const ref = (modelId: string) => ({ provider: "fixture", modelId });
const modelOf = async (store: DurableChannelStore, thread: string) => (await store.model(thread))?.modelId;

test("an unpinned thread follows the channel default; a thread that switched itself keeps its choice", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await ask(store, "follows", "hi"); await ask(store, "pinned", "hi");
  await store.setModel("pinned", ref("other"));
  assert.equal(await modelOf(store, "pinned"), "other");
  await store.setChannelModel(ref("other"));
  assert.equal(await modelOf(store, "follows"), "other", "unpinned thread adopts the new channel default on activation");
  await store.setChannelModel(ref("model"));
  assert.equal(await modelOf(store, "follows"), "model");
  assert.equal(await modelOf(store, "pinned"), "other", "a pinned thread is unaffected by the channel default");
  await store.unpinThread("pinned");
  assert.equal(await modelOf(store, "pinned"), "model", "unpinning returns the thread to the channel default");
});

test("the channel default tracks configuration until an operator overrides it, and an override survives reopen", async (t) => {
  const f = await fixture(t);
  let store = await f.open({ model: ref("model") });
  assert.deepEqual(await store.channelModel(), { model: ref("model"), overridden: false });
  await f.close(store);
  store = await f.open({ model: ref("other") });
  assert.deepEqual(await store.channelModel(), { model: ref("other"), overridden: false }, "editing the config changes the default");
  await store.setChannelModel(ref("model"));
  await f.close(store);
  store = await f.open({ model: ref("other") });
  assert.deepEqual(await store.channelModel(), { model: ref("model"), overridden: true }, "an override outlives a restart and beats config");
  assert.deepEqual(await store.setChannelModel(null), ref("other"), "clearing the override returns to the configured default");
  assert.equal((await store.channelModel()).overridden, false);
});

test("channel model changes are held to the allowlist, and effectiveModel never creates a thread", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await assert.rejects(store.setChannelModel({ provider: "fixture", modelId: "forbidden" }), /not allowed/);
  assert.deepEqual(await store.effectiveModel("not-yet"), ref("model"), "a thread with no conversation reports the channel default");
  assert.equal(await store.hasThread("not-yet"), false, "asking must not fork a conversation");
});

test("a carried-over channel override seeds a new store once", async (t) => {
  const f = await fixture(t);
  let store = await f.open({ initialModelOverride: ref("other") });
  assert.deepEqual(await store.channelModel(), { model: ref("other"), overridden: true });
  await f.close(store);
  store = await f.open({ initialModelOverride: ref("model") });
  assert.deepEqual((await store.channelModel()).model, ref("other"), "the seed applies only when the store is first created");
});

test("each conversation is offered only its own profile of tools and instructions; a narrow one never narrows its siblings", async (t) => {
  const f = await fixture(t);
  const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }) });
  const store = await f.open({ tools: [tool("read"), tool("post_message"), tool("transfer")], instructions: "FULL INSTRUCTIONS" });
  store.setThreadProfile("quiet-run", { tools: ["read"], instructions: "QUIET INSTRUCTIONS" });
  f.faux.setResponses([fauxAssistantMessage("quiet"), fauxAssistantMessage("live")]);
  await ask(store, "quiet-run", "scheduled work");
  await ask(store, "live-thread", "hello");
  const added = async (thread: string) => (await store.transcript(thread)).entries.flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "system")
    .flatMap((message) => ((message as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((entry) => entry.name));
  assert.deepEqual(await added("quiet-run"), ["read"], "the restricted run must not be offered post_message or transfer");
  assert.deepEqual((await added("live-thread")).sort(), ["post_message", "read", "transfer"], "an unrestricted thread keeps the full set");
  const instructions = async (thread: string) => JSON.stringify((await store.transcript(thread)).entries.flatMap((entry) => entry.model ?? []));
  assert.match(await instructions("quiet-run"), /QUIET INSTRUCTIONS/);
  assert.doesNotMatch(await instructions("live-thread"), /QUIET INSTRUCTIONS/);
  assert.throws(() => store.setThreadProfile("x", { tools: ["not-registered"] }), /Unregistered tool/);
});

test("listThreads reports every thread with its last activity, filtered by time, and never the trunk", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await ask(store, "old", "first");
  await new Promise((resolve) => setTimeout(resolve, 15));
  const cutoff = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await ask(store, "new", "second");
  const all = await store.listThreads();
  assert.deepEqual(all.map((thread) => thread.threadKey).sort(), ["new", "old"]);
  assert.deepEqual((await store.listThreads(cutoff)).map((thread) => thread.threadKey), ["new"]);
});

test("threadTurns returns only what was said in the thread, never context inherited from the trunk", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.appendMainContext("slack.thread.digest", "[thread X] INHERITED-DIGEST");
  f.faux.setResponses([fauxAssistantMessage("assistant answer")]);
  await ask(store, "T", "user question");
  assert.deepEqual(await store.threadTurns("T"), [
    { role: "user", text: "user question" },
    { role: "assistant", text: "assistant answer" },
  ]);
  assert.deepEqual(await store.threadTurns("no-such-thread"), []);
  assert.deepEqual((await store.listThreads()).map((thread) => thread.threadKey), ["T"]);
});

test("after a reset the listing and turns describe the new conversation, not the abandoned one", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("old"), fauxAssistantMessage("new")]);
  await ask(store, "R", "ABANDONED-TOPIC");
  await store.resetThread("R");
  await ask(store, "R", "fresh topic");
  const turns = (await store.threadTurns("R")).map((turn) => turn.text);
  assert.ok(!turns.some((text) => text.includes("ABANDONED")), "an explicitly abandoned conversation must not be re-read");
  assert.equal((await store.listThreads()).filter((thread) => thread.threadKey === "R").length, 1);
});

// ── Regressions from the independent review ──────────────────────────────────────────────────────────────────

test("a redelivery whose content differs only by the one-time history preamble is the same request, not a conflict", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("answered once")]);
  const first = await store.submit("T", { requestId: "slack:C1:1.2", content: "HISTORY PREAMBLE\n\n<@U1> says: hi", userId: "U1", fingerprint: "<@U1> says: hi" });
  await store.wait(first);
  // After a crash the retry no longer has the preamble: still the same request.
  await store.submit("T", { requestId: "slack:C1:1.2", content: "<@U1> says: hi", userId: "U1", fingerprint: "<@U1> says: hi" });
  assert.equal(f.faux.state.callCount, 1, "the model did not run again");
  await assert.rejects(
    store.submit("T", { requestId: "slack:C1:1.2", content: "something else", userId: "U1", fingerprint: "<@U1> says: something else" }),
    /requestId was reused/,
    "a genuinely different message under the same id is still refused",
  );
});

test("a thread counts as new until a request was actually admitted, even if its fork already exists", async (t) => {
  const f = await fixture(t); const store = await f.open();
  assert.equal(await store.admittedRequests("T"), 0);
  await store.conversationIdFor("T");                       // the fork is created, then the process 'dies' before submitting
  assert.equal(await store.hasThread("T"), true);
  assert.equal(await store.admittedRequests("T"), 0, "so the retry still reads the Slack history once");
  f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await ask(store, "T", "first", "r1");
  await store.submit("T", { requestId: "r1", content: "first", userId: "U1" });   // a retry of the same request
  assert.equal(await store.admittedRequests("T"), 1, "a retried request is counted once");
  await ask(store, "T", "second", "r2");
  assert.equal(await store.admittedRequests("T"), 2);
});

test("unpinning a thread applies the channel default immediately, so the command and the next turn agree", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("a")]);
  await ask(store, "P", "hi");
  await store.setModel("P", { provider: "fixture", modelId: "other" });
  assert.equal((await store.model("P"))?.modelId, "other");
  await store.unpinThread("P");
  assert.equal((await store.effectiveModel("P"))?.modelId, "model", "no stale pinned model is reported after unpinning");
});

test("a thread pinned to a model the allowlist later drops falls back to the channel default instead of being refused forever", async (t) => {
  const f = await fixture(t);
  let store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await ask(store, "P", "hi");
  await store.setModel("P", { provider: "fixture", modelId: "other" });
  await f.close(store);
  store = await f.open({ allowedModels: ["fixture/model"] });
  await ask(store, "P", "still usable?");
  assert.equal((await store.model("P"))?.modelId, "model");
});

test("a reset that arrives while the thread's first fork is still being created really resets", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("a")]);
  // forkThread registers the pending create synchronously, so the reset below arrives while it is genuinely in flight.
  const internals = store as unknown as { forkThread(key: string, replace: boolean): Promise<{ id: unknown }>; forking: Map<string, unknown> };
  const first = internals.forkThread("R", false);
  assert.ok(internals.forking.has("R"), "the create is pending");
  const reset = store.resetThread("R");
  const originalId = (await first).id;
  assert.equal(await reset, true, "the reset reports success only if it happened");
  const afterId = await store.conversationIdFor("R", false);
  assert.notEqual(afterId, originalId, "the thread now points at a fresh fork, not the one the pending create produced");
  await ask(store, "R", "after");
  assert.ok((await store.threadTurns("R")).some((turn) => turn.text === "after"));
});

test("discarding keeps the channel blocked until every abort has landed", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.setBlocked([{ conversationId: 1 as never, threadKey: "x", reason: "test", since: 0 }]);
  let blockedDuringAbort = -1;
  const original = store.abortConversations.bind(store);
  store.abortConversations = async (ids) => { blockedDuringAbort = (await store.blocked()).length; await original(ids); };
  await store.discardInterrupted();
  assert.equal(blockedDuringAbort, 1, "nothing could be admitted while the aborts were in progress");
  assert.equal((await store.blocked()).length, 0);
});
