import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, buildSessionContext, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT, awaitWithContext, withCancel } from "@earendil-works/chord/context";
import { DurableChannelStore, type ChannelStoreOptions } from "./channel-store.ts";
import { slackRequestId } from "./identity.ts";
import { TurnEventAdapter, type TurnEvent } from "../turn-events.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "durable-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const opts: ChannelStoreOptions = {
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model", "fixture/other"],
  };
  const open = new Set<DurableChannelStore>();
  t.after(async () => { for (const runtime of open) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { root, opts, faux, open: async (overrides: Partial<ChannelStoreOptions> = {}) => {
    const runtime = await DurableChannelStore.open({ ...opts, ...overrides }); open.add(runtime); return runtime;
  }, close: async (runtime: DurableChannelStore) => { await runtime.close(); open.delete(runtime); } };
}
async function crash(root: string, mode: "tool" | "model", t: TestContext) {
  const child = fork(fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url)), [root, mode], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = ""; child.stderr?.on("data", (data) => { errors += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code]) => { throw new Error(`Crash fixture exited ${code}: ${errors}`); }),
    new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Crash fixture timed out: ${errors}`)), 10000); timer.unref(); }),
  ]);
  child.kill("SIGKILL"); await once(child, "exit");
}

const input = { requestId: "event-1", content: "hello", userId: "U1" };
const stamp = "2026-10-01T00:00:00.000Z";

test("stable Slack request IDs ignore transport retries and separate workspaces", () => {
  assert.equal(slackRequestId("T1", "Ev1"), slackRequestId("T1", "Ev1"));
  assert.notEqual(slackRequestId("T1", "Ev1"), slackRequestId("T2", "Ev1"));
  assert.throws(() => slackRequestId("T1", ""));
});

test("concurrent duplicate submissions execute the model once, including after reopen", async (t) => {
  const f = await fixture(t); f.faux.setResponses([fauxAssistantMessage("done")]);
  let runtime = await f.open();
  const copies = await Promise.all(Array.from({ length: 8 }, () => runtime.submit("thread", input)));
  assert.equal(new Set(copies.map((copy) => copy.id)).size, 1);
  assert.equal((await runtime.wait(copies[0]!)).text, "done");
  await f.close(runtime); runtime = await f.open();
  const retried = await runtime.submit("thread", input);
  assert.equal(retried.id, copies[0]!.id);
  assert.equal((await runtime.wait(retried)).text, "done");
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(runtime.submit("thread", { ...input, content: "changed" }), /different content/);
  await assert.rejects(runtime.submit("thread", { ...input, userId: "U2" }), /different content/);
});

test("ModelRuntime is a supported Models implementation; selected models persist with allowlist checks", async (t) => {
  const f = await fixture(t);
  const models = await ModelRuntime.create({ authPath: join(f.root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  models.registerNativeProvider(f.faux.provider);
  let runtime = await f.open({ models });
  await runtime.setModel("thread", { provider: "fixture", modelId: "other" });
  await f.close(runtime); runtime = await f.open({ models });
  assert.deepEqual(await runtime.model("thread"), { provider: "fixture", modelId: "other" });
  await assert.rejects(runtime.setModel("thread", { provider: "other-provider", modelId: "private" }), /not allowed/);
  await f.close(runtime);
  runtime = await f.open({ allowedModels: ["fixture/model"] });
  // Only conversations with live work are scanned on resume. A thread whose pinned model was revoked never runs on it:
  // when anything is next submitted it falls back to the channel's (allowed) default instead of being refused forever.
  f.faux.setResponses([fauxAssistantMessage("answered on the allowed model")]);
  await runtime.wait(await runtime.submit("thread", input));
  assert.deepEqual(await runtime.model("thread"), { provider: "fixture", modelId: "model" });
  assert.equal(f.faux.state.callCount, 1, "exactly one request, and not on the revoked model");
});


test("Models bridge uses stored credentials and custom provider transport without migrating auth", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    assert.equal(request.headers["x-rehearsal"], "custom-header");
    let body = ""; for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).model, "custom-model");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: ' + JSON.stringify({ id: "response-1", object: "chat.completion.chunk", created: 1, model: "custom-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "custom answer" }, finish_reason: "stop" }],
    }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const authPath = join(f.root, "auth.json");
  const modelsPath = join(f.root, "models.json");
  const auth = JSON.stringify({
    custom: { type: "api_key", key: "fixture-key" },
    "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 9_999_999_999_999 },
  });
  const config = JSON.stringify({ providers: { custom: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
    headers: { "X-Rehearsal": "custom-header" }, models: [{ id: "custom-model" }],
  } } });
  await writeFile(authPath, auth); await writeFile(modelsPath, config);
  const models = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
  assert.equal((await models.getAuth("openai-codex"))?.auth.apiKey, "fixture-access");
  assert.ok(models.getModel("openai-codex", "gpt-6.1-sol"));
  // No second credential registry in Durable; the same object resolves stored auth.
  const runtime = await f.open({ models, model: { provider: "custom", modelId: "custom-model" }, allowedModels: ["custom/custom-model"] });
  assert.equal((await runtime.wait(await runtime.submit("thread", input))).text, "custom answer");
  assert.equal(calls, 1);
  assert.equal(await readFile(authPath, "utf8"), auth);
  assert.equal(await readFile(modelsPath, "utf8"), config);
});

test("a slow conversation does not block another; cancelling a wait does not cancel work", async (t) => {
  const f = await fixture(t);
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  f.faux.setResponses([async () => { started(); await gate; return fauxAssistantMessage("slow"); }, fauxAssistantMessage("fast")]);
  const runtime = await f.open();
  const slow = await runtime.submit("slow", input); await began;
  const fast = await runtime.submit("fast", input);
  assert.equal((await runtime.wait(fast)).text, "fast");
  const cancelled = withCancel(BACKGROUND_CONTEXT); cancelled.cancel();
  await assert.rejects(runtime.wait(slow, cancelled.context));
  assert.equal((await slow.status(BACKGROUND_CONTEXT)).status, "placed");
  release(); assert.equal((await runtime.wait(slow)).text, "slow");
});

test("explicit abort stops only its conversation and leaves other conversations usable", async (t) => {
  const f = await fixture(t);
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }), fauxAssistantMessage("other")]);
  const runtime = await f.open({ tools: [{ name: "hold", description: "hold", parameters: Type.Object({}), execute: async (_args, _api, context) => {
    started(); return awaitWithContext(new Promise<never>(() => {}), context);
  } }] });
  const submission = await runtime.submit("slow", input); await began;
  await runtime.abort("slow");
  assert.equal((await submission.status(BACKGROUND_CONTEXT)).status, "unanswered");
  await assert.rejects(runtime.wait(submission), /unanswered/);
  assert.equal((await runtime.wait(await runtime.submit("other", input))).text, "other");
});

test("separate channel stores/registries isolate history, tool permissions and ownership", async (t) => {
  const f = await fixture(t); const workspace2 = join(f.root, "workspace2"); await mkdir(workspace2);
  let ran = 0;
  const tool = { name: "secret", description: "C1 only", parameters: Type.Object({}), execute: async () => {
    ran++; return { output: [{ type: "text" as const, text: "private" }] };
  } };
  const a = await f.open({ tools: [tool] });
  await assert.rejects(f.open(), /locked/);
  const b = await f.open({ channelId: "C2", storageDir: join(f.root, "store2"), workspace: workspace2 });
  f.faux.setResponses([fauxAssistantMessage("C1 secret"), fauxAssistantMessage(fauxToolCall("secret", {}), { stopReason: "toolUse" }), fauxAssistantMessage("C2 answer")]);
  await a.wait(await a.submit("same-thread", input));
  await b.wait(await b.submit("same-thread", input));
  assert.equal(ran, 0);
  assert.equal(JSON.stringify((await b.transcript("same-thread")).messages).includes("C1 secret"), false);
  await f.close(a);
  await assert.rejects(f.open({ channelId: "C2" }), /different channel/);
  await assert.rejects(f.open({ workspace: workspace2 }), /different channel/);
});

test("SIGKILL during unsafe tool: no automatic replay, partial side effect is reported to the model", { timeout: 20000 }, async (t) => {
  const f = await fixture(t); await crash(f.root, "tool", t);
  let replayed = 0;
  f.faux.setResponses([async (context) => {
    const result = context.messages.find((message) => message.role === "toolResult");
    assert.match(JSON.stringify(result), /interrupted|partially run/);
    return fauxAssistantMessage("reconcile the partial effect");
  }]);
  const runtime = await f.open({ tools: [{ name: "mutation", description: "test", parameters: Type.Object({}), replay: "safe", execute: async () => {
    replayed++; return { output: [{ type: "text", text: "duplicate effect" }] };
  } }] });
  assert.equal((await runtime.inspect()).scheduling, "paused");
  await delay(50); // Passive reopen/inspection must not run any recovered task.
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(replayed, 0);
  const submission = await runtime.submit("thread", input);
  assert.equal((await runtime.wait(submission)).text, "reconcile the partial effect");
  assert.equal(replayed, 0);
  assert.equal(await readFile(join(f.root, "effects"), "utf8"), "executed\n");
});

test("SIGKILL during streamed generation: stable submission resumes with aborted partial history", { timeout: 20000 }, async (t) => {
  const f = await fixture(t); await crash(f.root, "model", t);
  const runtime = await f.open();
  const before = await runtime.inspect(); assert.equal(before.submissions.length, 1);
  f.faux.setResponses([fauxAssistantMessage("recovered answer")]);
  const submission = await runtime.submit("thread", input);
  assert.equal(submission.id, before.submissions[0]!.id);
  assert.equal((await runtime.wait(submission)).text, "recovered answer");
  const history = (await runtime.transcript("thread")).entries;
  assert.ok(history.some((entry) => entry.model?.some((message) => message.role === "assistant" && message.stopReason === "aborted")));
  assert.equal(f.faux.state.callCount, 1);
});

test("graceful close suspends instead of cancelling unfinished unsafe tool work", async (t) => {
  const f = await fixture(t);
  let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  let ran = 0;
  const tools = [{ name: "write", description: "mutation fixture", parameters: Type.Object({}), execute: async (_args: unknown, _api: unknown, context: Parameters<typeof awaitWithContext>[1]) => {
    ran++; started(); return awaitWithContext(new Promise<never>(() => {}), context);
  } }];
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("write", {}), { stopReason: "toolUse" })]);
  let runtime = await f.open({ tools });
  const submission = await runtime.submit("thread", input); await began;
  await f.close(runtime); runtime = await f.open({ tools });
  assert.equal((await runtime.inspect()).submissions[0]?.id, submission.id);
  f.faux.setResponses([fauxAssistantMessage("interrupted write needs review")]);
  assert.equal((await runtime.wait(await runtime.submit("thread", input))).text, "interrupted write needs review");
  assert.equal(ran, 1);
});

test("model failures settle as unanswered, not successful empty text; committed events stream", async (t) => {
  const f = await fixture(t); const runtime = await f.open();
  const watch = await runtime.watch("thread");
  const events: string[] = [];
  watch.start(async (batch) => { events.push(...batch.map((event) => event.type)); });
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "fatal invalid request" })]);
  const submission = await runtime.submit("thread", input);
  await assert.rejects(runtime.wait(submission), /unanswered/);
  assert.equal((await submission.status(BACKGROUND_CONTEXT)).status, "unanswered");
  await watch.stop();
  assert.ok(events.includes("message_end"));
  assert.ok(events.includes("run_end"));
});

test("permission revocation before restart cannot retain a persisted tool loadout", async (t) => {
  const f = await fixture(t); await crash(f.root, "tool", t);
  const runtime = await f.open({ tools: [] });
  f.faux.setResponses([async (context) => {
    const offered = new Set<string>();
    for (const message of context.messages) if (message.role === "system") {
      for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) offered.delete(tool.name);
    }
    assert.equal(offered.has("mutation"), false);
    return fauxAssistantMessage("permission revoked");
  }]);
  assert.equal((await runtime.wait(await runtime.submit("thread", input))).text, "permission revoked");
  assert.equal(await readFile(join(f.root, "effects"), "utf8"), "executed\n");
});

test("revoked crash checkpoint cannot be unblocked by switching the conversation model", { timeout: 20000 }, async (t) => {
  const f = await fixture(t); await crash(f.root, "model", t);
  const runtime = await f.open({ model: { provider: "fixture", modelId: "other" }, allowedModels: ["fixture/other"] });
  await assert.rejects(runtime.resume(), /not allowed/);
  await runtime.setModel("thread", { provider: "fixture", modelId: "other" });
  f.faux.setResponses([fauxAssistantMessage("must not dispatch the revoked checkpoint")]);
  for (const progress of [
    () => runtime.resume(),
    () => runtime.submit("thread", input),
    () => runtime.abort("thread"),
    () => runtime.waitForIdle(),
    () => runtime.wait({ id: "fake" as never, status: async () => { throw new Error("unexpected status"); }, wait: async () => { throw new Error("ungated wait"); }, abort: async () => { throw new Error("unexpected abort"); } }),
  ]) {
    await assert.rejects(progress(), /not allowed/);
    assert.equal((await runtime.inspect()).scheduling, "paused");
    assert.equal(f.faux.state.callCount, 0);
  }
});

test("returned submission handles cannot bypass the all-store model gate", async (t) => {
  const f = await fixture(t); f.faux.setResponses([fauxAssistantMessage("done")]);
  const runtime = await f.open(); const submission = await runtime.submit("thread", input);
  await runtime.wait(submission);
  // The original credential/catalog owner can lose a provider while the store is open.
  (f.opts.models as ReturnType<typeof createModels>).deleteProvider("fixture");
  await assert.rejects(submission.wait(BACKGROUND_CONTEXT), /Unknown model/);
  await assert.rejects(submission.abort(BACKGROUND_CONTEXT), /Unknown model/);
  assert.equal(f.faux.state.callCount, 1);
});

test("sequential tool calls each emit one start and successful authoritative end", async (t) => {
  const f = await fixture(t);
  const executed: string[] = [];
  const runtime = await f.open({ tools: [{
    name: "step", description: "A sequential step", parameters: Type.Object({ label: Type.String() }),
    execute: async (args) => {
      const { label } = args as { label: string };
      executed.push(label);
      return { output: [{ type: "text" as const, text: `completed ${label}` }] };
    },
  }] });
  const stream = await runtime.watch("thread");
  t.after(() => stream.stop());
  const adapter = new TurnEventAdapter(), seen: TurnEvent[] = [];
  let delivered!: () => void;
  const complete = new Promise<void>((resolve) => { delivered = resolve; });
  stream.start(async (batch) => {
    seen.push(...adapter.feed(batch));
    if (batch.some((event) => event.type === "run_end")) delivered();
  });
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("step", { label: "first" }, { id: "first" }),
      fauxToolCall("step", { label: "second" }, { id: "second" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("both done"),
  ]);
  assert.equal((await runtime.wait(await runtime.submit("thread", input))).text, "both done");
  await complete;
  assert.deepEqual(executed, ["first", "second"]);
  assert.deepEqual(seen.filter((event) => event.type === "tool_start" || event.type === "tool_end"), [
    { type: "tool_start", toolName: "step", callId: "first" },
    { type: "tool_end", toolName: "step", callId: "first", isError: false },
    { type: "tool_start", toolName: "step", callId: "second" },
    { type: "tool_end", toolName: "step", callId: "second", isError: false },
  ]);
});

test("a tool running mid-turn sees the current user message in threadTurns, on a thread's first message too", async (t) => {
  const f = await fixture(t);
  const seen: { role: string; text: string }[][] = [];
  let runtime!: DurableChannelStore;
  const peek = { name: "peek", description: "reads the thread", parameters: Type.Object({}), execute: async () => {
    seen.push(await runtime.threadTurns("new-thread"));
    return { output: [{ type: "text" as const, text: "peeked" }] };
  } };
  runtime = await f.open({ tools: [peek] });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("peek", {}), { stopReason: "toolUse" }), fauxAssistantMessage("first done"),
    fauxAssistantMessage(fauxToolCall("peek", {}), { stopReason: "toolUse" }), fauxAssistantMessage("second done"),
  ]);
  await runtime.wait(await runtime.submit("new-thread", { requestId: "event-a", content: "please tell general the deploy is done", userId: "U1" }));
  await runtime.wait(await runtime.submit("new-thread", { requestId: "event-b", content: "and say thanks to the team", userId: "U1" }));
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.some((turn) => turn.role === "user" && turn.text.includes("please tell general the deploy is done")), JSON.stringify(seen[0]));
  assert.ok(seen[1]!.some((turn) => turn.role === "user" && turn.text.includes("and say thanks to the team")), JSON.stringify(seen[1]));
});

test("a steering receipt completes admission after a crash gap and retains the grouped latest answer on reopen", async (t) => {
  const f = await fixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => { enter = done; });
  const gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  f.faux.setResponses([
    async () => { enter(); await gate; return fauxAssistantMessage("Initial answer."); },
    fauxAssistantMessage("Steered answer."),
  ]);
  let store = await f.open();
  const original = await store.submit("thread", input);
  await entered;
  const internal = store as any;
  const conversation = internal.conversation.bind(internal);
  internal.conversation = async (...args: unknown[]) => {
    const real = await conversation(...args);
    return new Proxy(real, { get(target, name) {
      if (name === "submit") return async () => { throw new Error("simulated crash before native admission"); };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  await assert.rejects(store.submit("thread", { requestId: "steering-1", content: "Original timestamp 1.3; author U1: change direction", userId: "U1", steeringFor: input.requestId }), /simulated crash/);
  internal.conversation = conversation;
  assert.equal(await store.steeringParent("thread", "steering-1"), input.requestId);
  release();
  await store.wait(original);
  assert.deepEqual(await store.awaitRequest(await store.conversationIdFor("thread"), input.requestId), { text: "Steered answer." });
  await store.waitForIdle();
  await f.close(store); store = await f.open();
  assert.deepEqual(await store.requestOutcome("thread", input.requestId), { status: "answered", text: "Steered answer." });
  assert.equal(await store.steeringParent("thread", "steering-1"), input.requestId);
  assert.equal(await store.steeringParent("different-dm-message-ts", "steering-1"), input.requestId, "a DM redelivery finds its original owner after reopening");
  assert.equal(await store.hasThread("different-dm-message-ts"), false, "route lookup does not create a new conversation");
  await store.waitForIdle();
  assert.equal(f.faux.state.callCount, 2);
});

test("durable admission rejects cross-author steering without leaving a grouped receipt", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => { enter = done; });
  const gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  f.faux.setResponses([
    async () => { enter(); await gate; return fauxAssistantMessage("Owner answer."); },
    fauxAssistantMessage("Other author answer."),
  ]);
  const original = await store.submit("thread", input);
  await entered;
  const follow = { requestId: "other-author", content: "please approve", userId: "U2" };
  await assert.rejects(store.submit("thread", { ...follow, steeringFor: input.requestId }), /Cross-author/);
  assert.equal(await store.steeringParent("thread", follow.requestId), undefined);
  release(); await store.wait(original);
  await store.wait(await store.submit("thread", follow));
  assert.deepEqual(await store.requestOutcome("thread", input.requestId), { status: "answered", text: "Owner answer." });
  assert.deepEqual(await store.requestOutcome("thread", follow.requestId), { status: "answered", text: "Other author answer." });
});
