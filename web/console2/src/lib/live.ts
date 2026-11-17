import type { ThreadLiveEvent, ToolCallCard, ToolCallStatus, TranscriptEntry } from "@api/api-types";

/** A turn being streamed right now, before the server's transcript has caught up. */
export interface Draft {
  text: string;
  toolCalls: ToolCallCard[];
  /** The current assistant message has ended; the draft waits for the authoritative transcript. */
  done: boolean;
}

/** Fold one live event into the draft. Pure: the same events always give the same draft. */
export function reduceDraft(draft: Draft | undefined, event: ThreadLiveEvent): Draft | undefined {
  switch (event.kind) {
    case "message_start":
      // Tool cards belong to the whole turn, so they survive the next message starting.
      return { text: "", toolCalls: draft?.toolCalls ?? [], done: false };
    case "text_delta":
      return { text: (draft?.done === false ? draft.text : "") + event.delta, toolCalls: draft?.toolCalls ?? [], done: false };
    case "message_end":
      return draft ? { ...draft, done: true } : undefined;
    case "tool_start": {
      const calls = (draft?.toolCalls ?? []).filter((call) => call.callId !== event.callId);
      return { text: draft?.text ?? "", done: draft?.done ?? false, toolCalls: [...calls, { callId: event.callId, name: event.name, status: "pending" }] };
    }
    case "tool_end": {
      const existing = draft?.toolCalls ?? [];
      const status: ToolCallStatus = event.isError ? "error" : "ok";
      const found = existing.some((call) => call.callId === event.callId);
      const toolCalls = found
        ? existing.map((call) => (call.callId === event.callId ? { ...call, status } : call))
        : [...existing, { callId: event.callId, name: event.name, status }];
      return { text: draft?.text ?? "", done: draft?.done ?? false, toolCalls };
    }
    case "compaction":
    case "retry":
      return draft;
  }
}

/** Position within one durable entry: `7` is 0, `7.1` is 1. */
const seq = (entry: TranscriptEntry): number => Number(entry.key.split(".")[1] ?? 0);
const order = (a: TranscriptEntry, b: TranscriptEntry): number => a.id - b.id || seq(a) - seq(b);

/**
 * Entries are unique by `key` and ascending. Several messages of one durable entry share an id, so the key, not the id,
 * identifies a row. A later copy of a key wins (the server is authoritative). Used to add an older page above what is shown.
 */
export function mergeEntries(current: readonly TranscriptEntry[], incoming: readonly TranscriptEntry[]): TranscriptEntry[] {
  const byKey = new Map<string, TranscriptEntry>();
  for (const entry of current) byKey.set(entry.key, entry);
  for (const entry of incoming) byKey.set(entry.key, entry);
  return [...byKey.values()].sort(order);
}

/**
 * A refresh of the newest page. Everything at or after the page's first entry is replaced by what the server says now, so
 * entries that no longer exist (after a compaction, a reset or an edit) disappear; older pages already loaded are kept.
 * An empty page means the conversation is empty.
 */
export function replaceNewest(current: readonly TranscriptEntry[], newest: readonly TranscriptEntry[]): TranscriptEntry[] {
  const first = newest[0];
  if (!first) return [];
  return [...current.filter((entry) => entry.id < first.id), ...newest];
}

/** Index of the first entry that was said in the thread itself rather than inherited from `main`. */
export function firstOwnEntry(entries: readonly TranscriptEntry[]): number {
  return entries.findIndex((entry) => !entry.inherited);
}

export function hasDraftContent(draft: Draft | undefined): draft is Draft {
  return draft !== undefined && (draft.text.length > 0 || draft.toolCalls.length > 0);
}
