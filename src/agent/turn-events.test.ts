import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "./durable/events.ts";
import { DurableChannelStore } from "./durable/channel-store.ts";
import { TurnEventAdapter, assistantText, type TurnEvent } from "./turn-events.ts";

const assistant = (text: string, extra: object = {}) =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });
const endOf = (message: object) => ({ type: "message_end", entry: { model: [message] } }) as unknown as AgentEvent;
const startOf = (role: string) => ({ type: "message_start", message: { role } }) as unknown as AgentEvent;
const delta = (text: string) => ({ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: text }] }) as unknown as AgentEvent;
const types = (events: TurnEvent[]) => events.map((event) => event.type);

test("only assistant messages become turn events; user, system and tool-result messages are ignored", () => {
  const adapter = new TurnEventAdapter();
  const events = adapter.feed([
    startOf("user"), endOf({ role: "user", content: "hi" }), startOf("system"), endOf({ role: "system" }),
    endOf({ role: "toolResult", isError: false }),
  ]);
  assert.deepEqual(events, []);
});

test("streamed deltas pass through and the closing entry carries the authoritative message", () => {
  const adapter = new TurnEventAdapter();
  const events = adapter.feed([startOf("assistant"), delta("Hel"), delta("lo"), endOf(assistant("Hello"))]);
  assert.deepEqual(types(events), ["assistant_message_start", "text_delta", "text_delta", "assistant_message_end"]);
  assert.equal(events.filter((event) => event.type === "text_delta").map((event) => (event as { delta: string }).delta).join(""), "Hello");
});

test("a message committed in one batch with no deltas still produces a preview chunk and one end", () => {
  const events = new TurnEventAdapter().feed([startOf("assistant"), endOf(assistant("All at once"))]);
  assert.deepEqual(types(events), ["assistant_message_start", "text_delta", "assistant_message_end"]);
  assert.equal((events[1] as { delta: string }).delta, "All at once");
});

test("a message end with no start still opens the message, and deltas do not leak into the next message", () => {
  const adapter = new TurnEventAdapter();
  const first = adapter.feed([delta("partial"), endOf(assistant("partial"))]);
  assert.deepEqual(types(first), ["assistant_message_start", "text_delta", "assistant_message_end"]);
  const second = adapter.feed([startOf("assistant"), endOf(assistant("second"))]);
  assert.deepEqual(types(second), ["assistant_message_start", "text_delta", "assistant_message_end"], "second message has no deltas of its own");
});

test("a snapshot mid-stream is reported as a resync so callers rely on message ends for complete text", () => {
  const events = new TurnEventAdapter().feed([{ type: "snapshot" } as unknown as AgentEvent, endOf(assistant("whole"))]);
  assert.equal(events[0]?.type, "resync");
  assert.equal(assistantText((events.at(-1) as unknown as { message: { content: never[] } }).message), "whole");
});

test("a tool with no result entry (faulted or orphaned) ends as an error", () => {
  const adapter = new TurnEventAdapter();
  const events = adapter.feed([
    { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "1", toolName: "bash", entry: { model: [{ role: "toolResult", isError: false }] } },
    { type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "2", toolName: "bash" },
    { type: "tool_execution_end", toolCallId: "3", toolName: "web", entry: { model: [{ role: "toolResult", isError: true }] } },
  ] as unknown as AgentEvent[]);
  assert.deepEqual(events.filter((event) => event.type === "tool_end").map((event) => (event as { isError: boolean }).isError), [false, true, true]);
});

test("compaction and retry events are surfaced", () => {
  const events = new TurnEventAdapter().feed([
    { type: "compaction_start", taskId: "t", reason: "threshold", blocking: false },
    { type: "auto_retry_start", attempt: 2, at: 0, errorMessage: "overloaded" },
  ] as unknown as AgentEvent[]);
  assert.deepEqual(events, [{ type: "compaction_start" }, { type: "retry", attempt: 2, error: "overloaded" }]);
});

test("end to end against a real store: ordered events for a tool turn, with usage on the final message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "turn-events-")); await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const store = await DurableChannelStore.open({
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
    tools: [{ name: "echo", description: "echo", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "ok" }] }) }],
  });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "Checking. " }, fauxToolCall("echo", {}, { id: "c1" })] as never, { stopReason: "toolUse" }),
    fauxAssistantMessage("All done."),
  ]);
  const watch = await store.watch("t"); const adapter = new TurnEventAdapter(); const seen: TurnEvent[] = [];
  watch.start(async (batch) => { seen.push(...adapter.feed(batch)); });
  await store.wait(await store.submit("t", { requestId: "r", content: "go", userId: "U" }));
  await watch.stop();
  const ends = seen.filter((event) => event.type === "assistant_message_end") as { message: { usage: { totalTokens: number } } }[];
  assert.equal(ends.length, 2);
  assert.ok(ends[0]!.message.usage.totalTokens > 0, "usage must be readable from the final message for the usage log");
  const order = types(seen).filter((type) => type !== "text_delta");
  assert.deepEqual(order, ["assistant_message_start", "assistant_message_end", "tool_start", "tool_end", "assistant_message_start", "assistant_message_end"]);
  assert.equal(seen.filter((event) => event.type === "text_delta").map((event) => (event as { delta: string }).delta).join(""), "Checking. All done.");
});
