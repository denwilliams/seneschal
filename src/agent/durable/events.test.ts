import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { Harness, createRegistry, type ConversationView } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { watchEvents, viewEvents, type AgentEvent } from "./events.ts";
import { TurnEventAdapter, type TurnEvent } from "../turn-events.ts";

const ctx = BACKGROUND_CONTEXT;
async function fixture(t: TestContext) {
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  t.after(() => harness.close(ctx));
  const conversation = await harness.root(ctx, { agent: { model: { provider: "fixture", modelId: "model" } } });
  return { harness, conversation, faux };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

test("a slow event listener does not erase fast complete messages or duplicate usage across turns", async (t) => {
  const { harness, conversation, faux } = await fixture(t);
  const stream = await watchEvents(harness, conversation.id, ctx);
  const entered = deferred(), release = deferred(), completed = deferred();
  const adapter = new TurnEventAdapter(), seen: TurnEvent[] = [];
  stream.start(async (batch) => {
    if (!seen.length) { entered.resolve(); await release.promise; }
    seen.push(...adapter.feed(batch));
    if (seen.filter((e) => e.type === "assistant_message_end").length === 2) completed.resolve();
  });
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
  await (await conversation.submit({ type: "input", content: "one" }, ctx)).wait(ctx);
  await entered.promise;
  await (await conversation.submit({ type: "input", content: "two" }, ctx)).wait(ctx);
  release.resolve(); await completed.promise;
  assert.deepEqual(seen.filter((e) => e.type === "assistant_message_end").map((e) => e.message.content),
    [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]]);
  await stream.stop();
});

test("a view window rollover delivers only new entries, never inherited history", () => {
  const entry = (id: number) => ({ id, model: [{ role: "assistant", content: [{ type: "text", text: String(id) }] }] });
  const before = { docs: {}, entries: Array.from({ length: 100 }, (_, i) => entry(i + 1)) } as unknown as ConversationView;
  const after = { docs: {}, entries: Array.from({ length: 50 }, (_, i) => entry(i + 52)) } as unknown as ConversationView;
  assert.deepEqual(viewEvents(before, after).filter((e) => e.type === "message_end").map((e) => e.entry.id), [101]);
});

test("tool slots that complete between callbacks still produce one start and an authoritative error end", () => {
  const before = { docs: { "pi.live": { tools: [{ callId: "c", name: "bash", status: "pending", taskId: 1 }] } }, entries: [] } as unknown as ConversationView;
  const after = { docs: { "pi.live": { tools: [{ callId: "c", name: "bash", status: "done", taskId: 1, entry: 2 }] } },
    entries: [{ id: 2, model: [{ role: "toolResult", toolCallId: "c", isError: true }] }] } as unknown as ConversationView;
  const adapter = new TurnEventAdapter();
  assert.deepEqual(adapter.feed(viewEvents(before, after)), [
    { type: "tool_start", toolName: "bash", callId: "c" }, { type: "tool_end", toolName: "bash", callId: "c", isError: true },
  ]);
  assert.deepEqual(viewEvents(after, { docs: {}, entries: after.entries } as unknown as ConversationView), []);
});

test("assigning a sequential slot its task does not emit a completion before execution", () => {
  const view = (status: string, taskId?: number, entries: unknown[] = []) => ({
    docs: { "pi.live": { tools: [{ callId: "second", name: "step", status, ...(taskId ? { taskId } : {}) }] } },
    entries,
  }) as unknown as ConversationView;
  const pending = view("pending"), scheduled = view("pending", 2), running = view("running", 2);
  assert.deepEqual(viewEvents(pending, scheduled), []);
  assert.deepEqual(viewEvents(scheduled, running), [
    { type: "tool_execution_start", toolCallId: "second", toolName: "step", args: {} },
  ]);
  const entry = { id: 3, model: [{ role: "toolResult", toolCallId: "second", isError: false }] };
  const done = view("done", 2, [entry]);
  assert.deepEqual(viewEvents(running, done), [
    { type: "tool_execution_end", toolCallId: "second", toolName: "step", entry },
    { type: "message_end", entry },
  ]);
  assert.deepEqual(viewEvents(done, { docs: {}, entries: done.entries } as unknown as ConversationView), []);
  // A task that really faults without a receipt still emits an error end.
  assert.deepEqual(new TurnEventAdapter().feed(viewEvents(running, view("done", 2))), [
    { type: "tool_end", toolName: "step", callId: "second", isError: true },
  ]);
});

test("overflow is bounded and signals resync; stopped and cancelled streams detach", async (t) => {
  const { harness, conversation, faux } = await fixture(t);
  const stream = await watchEvents(harness, conversation.id, ctx);
  const entered = deferred(), release = deferred(), resynced = deferred();
  let blocked = true;
  stream.start(async (batch) => {
    if (blocked) { blocked = false; entered.resolve(); await release.promise; }
    if (batch.some((e) => e.type === "snapshot")) resynced.resolve();
  });
  faux.setResponses(Array.from({ length: 60 }, () => fauxAssistantMessage("ok")));
  for (let i = 0; i < 60; i++) await (await conversation.submit({ type: "input", content: String(i) }, ctx)).wait(ctx);
  await entered.promise; release.resolve(); await resynced.promise;
  assert.equal((await stream.stop()).kind, "stopped");
  const cancelled = withCancel(ctx);
  const second = await watchEvents(harness, conversation.id, cancelled.context);
  cancelled.cancel();
  assert.equal((await second.closed).kind, "aborted");
});

test("listener failures close the adapter instead of breaking the session", async (t) => {
  const { harness, conversation, faux } = await fixture(t);
  const stream = await watchEvents(harness, conversation.id, ctx);
  stream.start(async (_batch: readonly AgentEvent[]) => { throw new Error("fixture listener failed"); });
  faux.setResponses([fauxAssistantMessage("still works")]);
  await (await conversation.submit({ type: "input", content: "one" }, ctx)).wait(ctx);
  assert.equal((await stream.closed).kind, "listener_error");
  assert.equal((await harness.inspect(ctx)).scheduling, "running");
});
