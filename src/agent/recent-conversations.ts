import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { contentText, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { resolveModel } from "./model.ts";
import { conversationForThread, type ConversationDigest, type TranscriptSource } from "./transcripts.ts";

/**
 * Lightweight, always-visible conversation orientation.
 *
 * Memory is curated facts. This file is deliberately not memory: it is a small
 * rolling index of the Slack threads this channel most recently updated, so a
 * fresh turn can see "what have we been talking about lately?" without a
 * nightly dream pass and without stuffing durable facts into memory.
 */

export interface RecentConversationEntry {
  /** Slack thread timestamp / session key. */
  threadKey: string;
  /** One sentence about the thread. */
  summary: string;
  /** Last time the thread was observed as updated by the harness. */
  updatedAt: string;
  /** Last time this entry was produced by the summariser. */
  summarizedAt: string;
}

// Older versions persisted this fallback as though the model had summarised the thread.
const EMPTY_SUMMARY = "This thread has no usable summary yet.";

interface RecentConversationFile {
  entries?: RecentConversationEntry[];
}

export class RecentConversationList {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): RecentConversationEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as RecentConversationFile;
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(isEntry).sort(byUpdatedDesc);
    } catch {
      return [];
    }
  }

  write(entries: readonly RecentConversationEntry[], maxThreads: number): void {
    const clean = entries
      .filter(isEntry)
      .sort(byUpdatedDesc)
      .slice(0, Math.max(1, maxThreads));
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries: clean }, null, 2));
    renameSync(tmp, this.file);
  }

  upsert(entry: RecentConversationEntry, maxThreads: number): void {
    // Invalid updates must not remove a useful entry for the same thread.
    if (!isEntry(entry)) return;
    const existing = this.read().filter((e) => e.threadKey !== entry.threadKey);
    this.write([normaliseEntry(entry), ...existing], maxThreads);
  }

  render(maxThreads: number): string {
    const entries = this.read().slice(0, Math.max(1, maxThreads));
    if (entries.length === 0) return "No recent conversations have been summarised yet.";
    return entries.map((e) => `- \`${e.threadKey}\` — ${e.summary}`).join("\n");
  }
}

export function renderRecentConversations(path: string, maxThreads: number): string {
  return new RecentConversationList(path).render(maxThreads);
}

function isEntry(value: unknown): value is RecentConversationEntry {
  const e = value as RecentConversationEntry;
  return Boolean(
    e &&
      typeof e.threadKey === "string" &&
      typeof e.summary === "string" &&
      isUsableSummary(oneSentence(e.summary)) &&
      typeof e.updatedAt === "string" &&
      typeof e.summarizedAt === "string",
  );
}

function byUpdatedDesc(a: RecentConversationEntry, b: RecentConversationEntry): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function oneSentence(text: string, maxChars = 220): string {
  const compact = text
    .replace(/^[-*•\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";

  const match = compact.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = (match?.[1] ?? compact).trim();
  return sentence.length <= maxChars ? sentence : `${sentence.slice(0, maxChars - 1).trimEnd()}…`;
}

function isUsableSummary(text: string): boolean {
  return text.length > 0 && text !== EMPTY_SUMMARY;
}

function normaliseEntry(entry: RecentConversationEntry): RecentConversationEntry {
  return { ...entry, summary: oneSentence(entry.summary) };
}

function summariserPrompt(conversation: ConversationDigest, maxChars: number): string {
  const first = conversation.turns.slice(0, 4);
  const recent = conversation.turns.slice(-16);
  const combined = [...first];
  for (const turn of recent) {
    if (!combined.includes(turn)) combined.push(turn);
  }

  const lines: string[] = [];
  let used = 0;
  for (const turn of combined) {
    const line = `${turn.role === "user" ? "them" : "assistant"}: ${turn.text.replace(/\s+/g, " ").trim()}`;
    if (used + line.length > maxChars) {
      lines.push("… earlier/recent turns omitted for length …");
      break;
    }
    lines.push(line);
    used += line.length;
  }

  return [
    `Thread ID: ${conversation.threadKey}`,
    conversation.truncated ? "Transcript note: middle content may be omitted." : undefined,
    "",
    "Write exactly one plain sentence about what this Slack thread is about.",
    "Name the concrete task, decision, topic, or outcome. Do not mention that you are summarising.",
    "",
    "Thread excerpt:",
    lines.join("\n"),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export async function summarizeRecentConversation(input: {
  channel: ResolvedChannel;
  source: TranscriptSource;
  threadKey: string;
  modelRuntime: ModelRuntime;
  model: string;
  maxTranscriptChars: number;
  now?: Date;
  onUsage?: (message: AssistantMessage) => void;
}): Promise<RecentConversationEntry | undefined> {
  const conversation = await conversationForThread(input.source, input.threadKey, {
    maxCharsPerConversation: Math.max(1000, input.maxTranscriptChars),
    firstTurns: 4,
  });
  if (!conversation || conversation.turns.length === 0) return undefined;

  const model = resolveModel(input.model, input.modelRuntime);
  const ctx: Context = {
    systemPrompt: "You write tiny Slack thread summaries for an assistant's recent-conversations list.",
    messages: [
      {
        role: "user",
        content: summariserPrompt(conversation, Math.max(1000, input.maxTranscriptChars)),
        timestamp: Date.now(),
      },
    ],
  };
  const result = await input.modelRuntime.completeSimple(model, ctx);
  input.onUsage?.(result);
  // completeSimple resolves even for provider/HTTP errors. Do not turn an error
  // message (or a partial response) into a persisted digest and hide its cause.
  if (result.stopReason !== "stop") {
    throw new Error(
      `Recent conversation summarizer (${input.model}) failed (${result.stopReason}): ` +
        `${result.errorMessage || "Model response did not complete."}`,
    );
  }
  const text = oneSentence(contentText(result.content));
  if (!isUsableSummary(text)) {
    throw new Error(`Recent conversation summarizer (${input.model}) returned no usable summary text.`);
  }
  const now = input.now ?? new Date();

  return {
    threadKey: input.threadKey,
    summary: text,
    updatedAt: conversation.lastActivity.toISOString(),
    summarizedAt: now.toISOString(),
  };
}
