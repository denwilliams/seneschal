import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "./durable/events.ts";

/**
 * What the Slack layer needs to know about a turn, independent of any agent SDK.
 *
 * The stream renderer, reactions, usage log and task tracker consume these instead of the
 * SDK's own event shapes, so changing the agent backend cannot silently change what Slack
 * shows. `assistant_message_end` is authoritative for a message's text: `text_delta` is a live
 * preview and may be partial or absent (a fast model commits a whole message in one batch,
 * and an overflowing watcher replaces undelivered batches with a snapshot).
 */
export type TurnEvent =
  | { type: "assistant_message_start" }
  | { type: "text_delta"; delta: string }
  | { type: "assistant_message_end"; message: AssistantMessage }
  | { type: "tool_start"; toolName: string; callId: string }
  | { type: "tool_end"; toolName: string; callId: string; isError: boolean }
  | { type: "compaction_start" }
  | { type: "retry"; attempt: number; error: string }
  /** Undelivered events were replaced by a snapshot; only `assistant_message_end` text is complete. */
  | { type: "resync" };

export function assistantText(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("");
}

type EntryMessage = { role?: string; isError?: boolean };

/** Stateful because deltas and the closing entry arrive in separate events. */
export class TurnEventAdapter {
  private open = false;
  private sawDelta = false;

  feed(events: readonly AgentEvent[]): TurnEvent[] {
    const out: TurnEvent[] = [];
    for (const event of events) {
      switch (event.type) {
        case "snapshot":
          // A snapshot after the first delivery means batches were dropped.
          out.push({ type: "resync" });
          break;
        case "message_start":
          if (event.message.role === "assistant") this.start(out);
          break;
        case "message_update":
          for (const change of event.changes) {
            if (change.type === "text_delta") {
              this.start(out);
              this.sawDelta = true;
              out.push({ type: "text_delta", delta: change.delta });
            }
          }
          break;
        case "message_end": {
          const message = event.entry.model?.[0];
          if (message?.role !== "assistant") break;
          this.start(out);
          const assistant = message as AssistantMessage;
          // No streamed deltas (fast model / coalesced batch): surface the text as one preview chunk.
          if (!this.sawDelta) {
            const text = assistantText(assistant);
            if (text) out.push({ type: "text_delta", delta: text });
          }
          out.push({ type: "assistant_message_end", message: assistant });
          this.open = false;
          this.sawDelta = false;
          break;
        }
        case "tool_execution_start":
          out.push({ type: "tool_start", toolName: event.toolName, callId: event.toolCallId });
          break;
        case "tool_execution_end": {
          const result = event.entry?.model?.[0] as EntryMessage | undefined;
          // No entry means the tool task faulted or was orphaned: that is an error end.
          out.push({
            type: "tool_end", toolName: event.toolName, callId: event.toolCallId,
            isError: result === undefined ? true : result.isError === true,
          });
          break;
        }
        case "compaction_start":
          out.push({ type: "compaction_start" });
          break;
        case "auto_retry_start":
          out.push({ type: "retry", attempt: event.attempt, error: event.errorMessage });
          break;
        default:
          break;
      }
    }
    return out;
  }

  private start(out: TurnEvent[]): void {
    if (this.open) return;
    this.open = true;
    this.sawDelta = false;
    out.push({ type: "assistant_message_start" });
  }
}
