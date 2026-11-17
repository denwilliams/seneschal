import { NativeWatch, type Context, type WatchCall, type WatchEnd } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ConversationId, ConversationView, EntryRecord, Harness, LiveState, NestedToolSlot, ToolSlot,
} from "@earendil-works/pi-durable";
import { logger } from "../../util/log.ts";

/** Harness-owned event vocabulary. Durable 1.5 exposes views, not agent events. */
export type AgentEvent =
  | { type: "snapshot"; entries: readonly EntryRecord[] }
  | { type: "run_start" | "run_end" }
  | { type: "message_start"; message: { role: string } }
  | { type: "message_update"; changes: readonly { type: "text_delta"; contentIndex: number; delta: string }[] }
  | { type: "message_end"; entry: EntryRecord }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: object }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
  | { type: "auto_retry_start"; attempt: number; errorMessage: string }
  | { type: "compaction_start" };

export interface AgentEventStream {
  readonly snapshot: Extract<AgentEvent, { type: "snapshot" }>;
  start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
  stop(): Promise<WatchEnd>;
  readonly closed: Promise<WatchEnd>;
}

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;
const snapshotOf = (view: ConversationView): Extract<AgentEvent, { type: "snapshot" }> => ({ type: "snapshot", entries: view.entries });
// Sequential model-issued slots acquire a taskId only when scheduled; that must not look like removal.
// Nested calls have a taskId from creation, so retain their task-scoped identity (and a separate namespace).
const callKey = (slot: ToolSlot | NestedToolSlot): string =>
  "parentTaskId" in slot ? `nested:${slot.taskId}:${slot.callId}` : `call:${slot.callId}`;

/**
 * Observe every adopted view, including deferred streaming progress. A coalescing JSON watch can erase a whole fast
 * tool turn while an async listener is busy, so translate synchronously and serialize the resulting event batches with
 * a bounded native watch. A slow consumer gets a resync snapshot after 100 queued batches, as before the upgrade.
 * This is presentation only: submissions and their authoritative final answers still come from Durable.
 */
export async function watchEvents(harness: Harness, id: ConversationId, context: Context): Promise<AgentEventStream> {
  let current: ConversationView;
  let stream: NativeWatch<readonly AgentEvent[]> | undefined;
  const early: { call: WatchCall<ConversationView>; context: Context }[] = [];
  let ended: WatchEnd | undefined;
  const advance = (call: WatchCall<ConversationView>, ctx: Context) => {
    if (!stream) { early.push({ call, context: ctx }); return; }
    if (call.kind === "failed") { stream.fail(call.error, ctx); return; }
    const events = viewEvents(current, call.value);
    current = call.value;
    if (events.length) stream.advance(events, ctx);
  };
  const observation = await harness.observeConversation(id, {
    advance,
    end: (end) => { ended = end; stream?.end(end); },
  }, context);
  current = observation.value;
  const snapshot = snapshotOf(current);
  stream = new NativeWatch<readonly AgentEvent[]>([], () => observation.detach(),
    (error) => logger.warn(`Durable event listener failed: ${error}`), () => [snapshotOf(current)]);
  for (const item of early) advance(item.call, item.context);
  early.length = 0;
  if (ended) stream.end(ended);
  if (context.abortSignal) stream.observeAbort(context.abortSignal);
  const watch = stream;
  return {
    snapshot,
    start: (listener) => watch.start(async (call, ctx) => {
      if (call.kind === "failed") throw call.error;
      await listener(call.value, ctx);
    }),
    stop: () => watch.stop(),
    closed: watch.closed,
  };
}

/** Translate adjacent immutable views; each synchronous observation includes every newly appended entry. */
export function viewEvents(before: ConversationView, after: ConversationView): AgentEvent[] {
  const was = liveOf(before), now = liveOf(after);
  const last = before.entries.at(-1)?.id ?? 0;
  const entries = after.entries.filter((entry) => entry.id > last);
  const events: AgentEvent[] = [];
  const previousSlots = new Map([...was.tools ?? [], ...was.nestedTools ?? []].map((slot) => [callKey(slot), slot]));
  const slots = [...now.tools ?? [], ...now.nestedTools ?? []];
  const currentSlots = new Map(slots.map((slot) => [callKey(slot), slot]));
  const callOf = (slot: ToolSlot | NestedToolSlot) => ({ toolCallId: slot.callId, toolName: slot.name });
  for (const slot of slots) {
    const old = previousSlots.get(callKey(slot));
    if (slot.status !== "pending" && old?.status !== "running" && old?.status !== "done") {
      events.push({ type: "tool_execution_start", ...callOf(slot), args: "arguments" in slot ? slot.arguments : {} });
    }
  }
  const partial = now.generation?.message as AssistantMessage | undefined;
  const prior = was.generation?.message as AssistantMessage | undefined;
  if (partial) {
    if (!prior) events.push({ type: "message_start", message: partial });
    const changes: Extract<AgentEvent, { type: "message_update" }>["changes"][number][] = [];
    partial.content.forEach((block, index) => {
      if (block.type !== "text") return;
      const oldBlock = prior?.content[index];
      const old = oldBlock?.type === "text" ? oldBlock.text : "";
      if (block.text.startsWith(old) && block.text.length > old.length) {
        changes.push({ type: "text_delta", contentIndex: index, delta: block.text.slice(old.length) });
      }
    });
    if (changes.length) events.push({ type: "message_update", changes });
  }
  if (now.generation?.retry && !was.generation?.retry) {
    events.push({ type: "auto_retry_start", attempt: now.generation.attempt, errorMessage: now.generation.retry.error });
  }
  const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
  for (const slot of new Map([...previousSlots, ...currentSlots]).values()) {
    const old = previousSlots.get(callKey(slot));
    const next = currentSlots.get(callKey(slot));
    if (old?.status === "done" || (next && next.status !== "done")) continue;
    const entry = entries.find((entry) => {
      const message = entry.model?.[0];
      return message?.role === "toolResult" && message.toolCallId === slot.callId;
    });
    toolEnds.push({ type: "tool_execution_end", ...callOf(slot), ...(entry ? { entry } : {}) });
  }
  for (const entry of entries) {
    events.push(...toolEnds.filter((end) => end.entry === entry));
    const message = entry.model?.[0];
    if (!message) continue;
    // TurnEventAdapter also handles a message committed without any partials.
    events.push({ type: "message_end", entry });
  }
  events.push(...toolEnds.filter((end) => !end.entry));
  for (const compaction of now.compactions ?? []) {
    if (!was.compactions?.some((old) => old.taskId === compaction.taskId)) events.push({ type: "compaction_start" });
  }
  if (was.run && !now.run) events.push({ type: "run_end" });
  if (!was.run && now.run) events.push({ type: "run_start" });
  return events;
}
