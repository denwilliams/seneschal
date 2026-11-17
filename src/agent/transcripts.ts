import type { DurableChannelStore } from "./durable/channel-store.ts";

/**
 * Reading back what was actually said.
 *
 * Every thread the bot has taken part in is a conversation in its channel's Durable store, which is how it
 * survives an eviction or a restart. This is the way to look back at them: the nightly consolidation pass
 * and the recent-conversations list need to say what recent conversations were about.
 *
 * A `TranscriptSource` is always one channel's own store. There is no parameter for another channel's,
 * deliberately, and a thread's turns never include what it merely inherited from the channel's main
 * conversation when it forked.
 */

/** Where conversations are read from; the store in production, a list in tests. */
export interface TranscriptSource {
  /** Threads with a conversation, optionally only those active after `since`. */
  threads(since?: Date): Promise<{ threadKey: string; lastActivity: Date }[]>;
  turns(threadKey: string): Promise<TranscriptTurn[]>;
}

export function storeTranscriptSource(store: Pick<DurableChannelStore, "listThreads" | "threadTurns">): TranscriptSource {
  return {
    threads: async (since) => (await store.listThreads(since?.getTime())).map((thread) => ({
      threadKey: thread.threadKey, lastActivity: new Date(thread.lastActivityAt),
    })),
    turns: (threadKey) => store.threadTurns(threadKey),
  };
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ConversationDigest {
  /** The Slack thread timestamp the conversation happened in. */
  threadKey: string;
  startedAt?: Date;
  lastActivity: Date;
  turns: TranscriptTurn[];
  /** True when turns were dropped to stay inside the size budget. */
  truncated: boolean;
}

export interface RecentOptions {
  /** Only conversations touched after this. Omit for everything on disk. */
  since?: Date;
  /** Thread keys to skip — pseudo-threads the harness runs for itself. */
  exclude?: string[];
  /** Most recently active conversations to include. */
  maxConversations?: number;
  /** Characters of transcript kept per conversation, newest turns first. */
  maxCharsPerConversation?: number;
  now?: Date;
}

/** Slack thread keys are epoch seconds with a suffix; the prefix is the time. */
function threadStart(threadKey: string): Date | undefined {
  const seconds = Number.parseFloat(threadKey);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000);
}

/** Read one conversation by Slack thread key. */
export async function conversationForThread(
  source: TranscriptSource,
  threadKey: string,
  opts: Pick<RecentOptions, "maxCharsPerConversation"> & { firstTurns?: number } = {},
): Promise<ConversationDigest | undefined> {
  const thread = (await source.threads()).find((candidate) => candidate.threadKey === threadKey);
  if (!thread) return undefined;
  const turns = await source.turns(threadKey);
  if (turns.length === 0) return undefined;

  const budget = opts.maxCharsPerConversation ?? 4000;
  let kept = turns;
  if (opts.firstTurns && turns.length > opts.firstTurns) {
    const selected = turns.slice(0, opts.firstTurns);
    let used = selected.reduce((sum, turn) => sum + turn.text.length, 0);
    for (let i = turns.length - 1; i >= opts.firstTurns; i--) {
      const turn = turns[i]!;
      if (used + turn.text.length > budget) break;
      selected.splice(opts.firstTurns, 0, turn);
      used += turn.text.length;
    }
    kept = selected;
  } else {
    let used = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      used += turns[i]!.text.length;
      if (used > budget) {
        kept = turns.slice(i + 1);
        break;
      }
    }
  }

  const started = threadStart(threadKey);
  return {
    threadKey,
    ...(started ? { startedAt: started } : {}),
    lastActivity: thread.lastActivity,
    turns: kept,
    truncated: kept.length < turns.length,
  };
}

/**
 * Recent conversations in this channel, most recently active first.
 *
 * A thread that was reset points at its new conversation, so an abandoned one is never read back: re-reading
 * it a day later would consolidate exactly the material someone asked the bot to drop.
 */
export async function recentConversations(
  source: TranscriptSource,
  opts: RecentOptions = {},
): Promise<ConversationDigest[]> {
  const maxConversations = opts.maxConversations ?? 8;
  const budget = opts.maxCharsPerConversation ?? 4000;
  const excluded = opts.exclude ?? [];

  const found: ConversationDigest[] = [];
  for (const thread of await source.threads(opts.since)) {
    // Pseudo-threads the harness runs for itself are matched by prefix: each run has its own unique key.
    if (excluded.some((prefix) => thread.threadKey === prefix || thread.threadKey.startsWith(`${prefix}-`))) continue;
    if (opts.since && thread.lastActivity <= opts.since) continue;
    const conversation = await conversationForThread(source, thread.threadKey, { maxCharsPerConversation: budget });
    if (conversation) found.push(conversation);
  }

  return found
    .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
    .slice(0, maxConversations);
}

/** Render conversations for a prompt: readable, bounded, attributed by role. */
export function formatConversations(digests: ConversationDigest[], maxChars = 24_000): string {
  const blocks: string[] = [];
  let used = 0;

  for (const digest of digests) {
    const when = (digest.startedAt ?? digest.lastActivity).toISOString().slice(0, 16).replace("T", " ");
    const lines = digest.turns.map(
      (t) => `${t.role === "user" ? "them" : "you"}: ${t.text.replace(/\s+/g, " ").trim()}`,
    );
    const block = [
      `### Conversation of ${when}${digest.truncated ? " (earlier turns omitted)" : ""}`,
      "",
      ...lines,
    ].join("\n");

    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }

  return blocks.join("\n\n");
}
