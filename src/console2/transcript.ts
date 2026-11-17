import type { EntryRole, ToolCallCard, TranscriptEntry, TranscriptResponse } from "./api-types.ts";
import { iso, nodeKind } from "./source.ts";

/** The slice of a durable context view this module reads, so tests can pass plain objects. */
export interface ViewLike {
  entries: readonly { id: number; kind: string }[];
  contributions: readonly (readonly unknown[])[];
}

interface MessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  model?: string;
  provider?: string;
  usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  toolCallId?: string;
  isError?: boolean;
}

const MAX_TEXT = 16_000;
export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 300;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [])).join("");
}

function toolCallsOf(content: unknown): { callId: string; name: string }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const b = block as { type?: string; id?: unknown; name?: unknown };
    return b && b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string" ? [{ callId: b.id, name: b.name }] : [];
  });
}

function bound(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * Turn a durable context view into transcript entries. One entry per user message and per assistant message; tool results
 * are not entries of their own, they settle the status of the card on the assistant message that called the tool. Tool
 * arguments and results are never copied out, only the tool's name and whether it errored ("names, not bodies").
 * With `redacted` (a direct message) no message text is copied at all.
 */
export function transcriptEntries(view: ViewLike, options: { redacted: boolean; forkedFromEntry: number }): TranscriptEntry[] {
  // Settle tool calls first: a result can sit in a later entry than the call.
  const results = new Map<string, boolean>();
  view.contributions.forEach((messages) => {
    for (const message of messages as readonly MessageLike[]) {
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") results.set(message.toolCallId, message.isError === true);
    }
  });
  const out: TranscriptEntry[] = [];
  view.entries.forEach((entry, index) => {
    const inherited = options.forkedFromEntry > 0 && entry.id <= options.forkedFromEntry;
    const messages = (view.contributions[index] ?? []) as readonly MessageLike[];
    let emitted = false;
    let seq = 0;
    for (const message of messages) {
      if (message?.role !== "user" && message?.role !== "assistant") continue;
      const role: EntryRole = message.role;
      const text = textOf(message.content).trim();
      const calls: ToolCallCard[] = role === "assistant"
        ? toolCallsOf(message.content).map((call) => ({
            callId: call.callId, name: call.name, status: !results.has(call.callId) ? "pending" : results.get(call.callId) ? "error" : "ok",
          }))
        : [];
      if (!text && calls.length === 0) continue;
      const tokens = message.usage?.totalTokens ?? (message.usage ? (message.usage.input ?? 0) + (message.usage.output ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0) : undefined);
      out.push({
        key: seq === 0 ? String(entry.id) : `${entry.id}.${seq}`, id: entry.id, role,
        ...(iso(message.timestamp) ? { at: iso(message.timestamp)! } : {}),
        ...(options.redacted ? { redacted: true } : text ? { text: bound(text) } : {}),
        ...(inherited ? { inherited: true } : {}),
        ...(role === "assistant" && message.model ? { model: message.provider ? `${message.provider}/${message.model}` : message.model } : {}),
        ...(role === "assistant" && tokens ? { tokens } : {}),
        ...(role === "assistant" && typeof message.usage?.cost?.total === "number" ? { costUsd: message.usage.cost.total } : {}),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
      emitted = true;
      seq++;
    }
    if (!emitted && /compaction|reset/i.test(entry.kind)) {
      out.push({ key: String(entry.id), id: entry.id, role: "system", text: /compaction/i.test(entry.kind) ? "Context compacted" : "Context reset", ...(inherited ? { inherited: true } : {}) });
    }
  });
  return out;
}

/**
 * One page of entries older than `before` (or the newest page), in time order. A page never cuts between messages of the
 * same durable entry: if the cut would, the page grows backwards to take the whole entry, so `nextBefore` (an entry id)
 * always continues exactly where this page stopped.
 */
export function pageEntries(entries: TranscriptEntry[], before: number | undefined, limit: number): { entries: TranscriptEntry[]; nextBefore?: number } {
  const size = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_PAGE), MAX_PAGE);
  const eligible = before === undefined ? entries : entries.filter((entry) => entry.id < before);
  let start = Math.max(0, eligible.length - size);
  while (start > 0 && eligible[start - 1]!.id === eligible[start]!.id) start--;
  const page = eligible.slice(start);
  const first = page[0];
  return { entries: page, ...(first && start > 0 ? { nextBefore: first.id } : {}) };
}

export function unavailable(channelId: string, threadKey: string, redacted: boolean, reason: string): TranscriptResponse {
  return { channelId, threadKey, kind: nodeKind(threadKey), available: false, reason, redacted, running: false, entries: [] };
}
