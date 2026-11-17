import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { MemoryFile, type MemoryEntry } from "./memory-store.ts";
import { formatConversations, recentConversations, type ConversationDigest, type TranscriptSource } from "./transcripts.ts";

/**
 * Dreaming: what the harness does with a channel overnight.
 *
 * A conversation ends and everything it produced is scattered — a transcript
 * nothing will ever read again, and however many one-line facts happened to get
 * written down while people were talking. Memory grows, never shrinks, and gets
 * worse as it grows: the useful line about the boiler ends up underneath forty
 * lines about a deploy that happened in March.
 *
 * So once a day, when nobody is talking, the channel goes back over the day:
 * reads the conversations it has had, folds what mattered into memory, merges
 * the entries that say the same thing, and lets go of the ones that arrived
 * once months ago and have been dead weight ever since.
 *
 * Three things keep this from being frightening:
 *
 * - **Nothing is destroyed.** Consolidation goes through `forget`, which
 *   archives every entry it drops. A bad dream costs an edit, not a fact.
 * - **It only ever sees its own channel.** Same boundary as everything else:
 *   this channel's transcripts, this channel's memory.
 * - **It is skippable.** A channel with nothing new to think about does not
 *   dream, so an idle channel costs nothing.
 *
 * This module is the logic — what a dream is made of and what it leaves behind.
 * The timers that fire it live in `slack/dreamer.ts`.
 */

export interface DreamSettings {
  enabled: boolean;
  /** 5-field cron for the nightly pass. */
  cron: string;
  timezone: string;
  /** Entries untouched for this long become candidates for forgetting. */
  forgetAfterDays: number;
  /** Conversations read per dream, most recently active first. */
  maxConversations: number;
  /** Full transcripts kept for debugging. The run log is kept regardless. */
  keepTranscripts: number;
  /** Post a short note to the channel afterwards. */
  announce: boolean;
}

export interface DreamRecord {
  lastDreamAt?: string;
  runs: number;
  lastSummary?: string;
  lastError?: string;
}

/**
 * Per-channel dream bookkeeping.
 *
 * Kept beside the channel's other state rather than in memory itself: when the
 * last dream happened is operational detail, not something the agent should be
 * reading back as a fact about the world.
 */
export class DreamState {
  private readonly file: string;

  constructor(channelRoot: string) {
    this.file = join(channelRoot, "dream.json");
  }

  read(): DreamRecord {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as DreamRecord;
      if (parsed && typeof parsed === "object") {
        return { ...parsed, runs: typeof parsed.runs === "number" ? parsed.runs : 0 };
      }
    } catch {
      // Never dreamt, or the file is unreadable. Both mean "start fresh".
    }
    return { runs: 0 };
  }

  write(record: DreamRecord): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 2));
      renameSync(tmp, this.file);
    } catch {
      // Losing the marker means the next dream looks further back. Survivable.
    }
  }

  lastDreamAt(): Date | undefined {
    const raw = this.read().lastDreamAt;
    if (!raw) return undefined;
    const at = Date.parse(raw);
    return Number.isFinite(at) ? new Date(at) : undefined;
  }
}

export interface DreamContext {
  /** Conversations since the last dream. */
  conversations: ConversationDigest[];
  /** Memory as it stands, each entry annotated with age and use. */
  annotatedMemory: string;
  entryCount: number;
  /** Old, unused, never-repeated entries — the forgetting candidates. */
  stale: MemoryEntry[];
  /** Where the lookback started, for the prompt. */
  since?: Date;
}

/** How far back a first dream looks, when there is no previous one to go from. */
const FIRST_DREAM_LOOKBACK_DAYS = 7;

/**
 * The pseudo-thread a dream runs in.
 *
 * Not a Slack timestamp, so it cannot collide with a real thread. Each run
 * is its own fork of the channel's main conversation under `dream-<time>`, and
 * every such key is excluded from the lookback regardless — a channel
 * rereading last night's dream as if it were a conversation it had would
 * compound its own summaries night after night.
 */
export const DREAM_THREAD_KEY = "dream";

export async function collectDreamContext(
  channel: ResolvedChannel,
  settings: DreamSettings,
  source: TranscriptSource,
  now = new Date(),
): Promise<DreamContext> {
  const state = new DreamState(channel.paths.root);
  const since =
    state.lastDreamAt() ?? new Date(now.getTime() - FIRST_DREAM_LOOKBACK_DAYS * 86_400_000);

  const memory = new MemoryFile(channel.memory.channelFile);
  const conversations = await recentConversations(source, {
    since,
    maxConversations: settings.maxConversations,
    exclude: [DREAM_THREAD_KEY],
  });

  return {
    conversations,
    annotatedMemory: memory.annotated(now),
    entryCount: memory.entries().length,
    stale: memory.stale({ days: settings.forgetAfterDays, now }),
    since,
  };
}

/**
 * Whether there is anything to think about.
 *
 * An idle channel should cost nothing overnight. Without this check every
 * configured channel would spend a model call every night rereading a memory
 * file that has not changed since the last time it read it.
 */
export function worthDreaming(ctx: DreamContext): boolean {
  return ctx.conversations.length > 0 || ctx.stale.length > 0;
}

/**
 * The framing for a dream.
 *
 * The hard part is not the instructions, it is the framing: an agent that
 * thinks a person is waiting writes a report about consolidating memory
 * instead of consolidating memory. So it is told plainly that no one is there,
 * that its reply goes into a journal file, and that the work happens through
 * the tools.
 */
export function dreamPrompt(ctx: DreamContext, now = new Date()): string {
  const sections: string[] = [];

  sections.push(
    [
      "You are dreaming.",
      "",
      "This is the nightly pass over your own memory.",
      "Nobody sent this and nobody is waiting on it. Nothing you say here is posted to",
      "the channel — your reply is written to a journal file a human may read later.",
      "",
      "Two jobs: deliberately capture durable facts from the conversations since your",
      "last dream, and leave your memory in a better state than you found it.",
    ].join("\n"),
  );

  if (ctx.conversations.length > 0) {
    sections.push(
      [
        `## Conversations since ${ctx.since ? ctx.since.toISOString().slice(0, 16).replace("T", " ") : "your last dream"}`,
        "",
        "These are your own transcripts, replayed. `them` is whoever was talking to you.",
        "",
        formatConversations(ctx.conversations),
      ].join("\n"),
    );
  } else {
    sections.push(
      "## Conversations\n\nNothing was said in this channel since your last dream. There is nothing new to fold in — this pass is about tidying what is already there.",
    );
  }

  sections.push(
    [
      "## Your memory as it stands",
      "",
      ctx.annotatedMemory
        ? `Each entry is annotated with its age and how often you have actually reached for it.\n\n${ctx.annotatedMemory}`
        : "It is empty.",
    ].join("\n"),
  );

  if (ctx.stale.length > 0) {
    sections.push(
      [
        "## Candidates for forgetting",
        "",
        `These arrived more than a while ago, have never been recalled, and have never been repeated. That is what clutter looks like — but you are the judge, and some facts are simply permanent and rarely needed (an address, a password policy, whose birthday it is).`,
        "",
        ...ctx.stale.map((e) => `- ${e.text}`),
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## What to do",
      "",
      "1. Read every conversation since the last dream before tidying. Make a deliberate",
      "   pass for new memories: pull out what will still matter next week, including user",
      "   corrections or teaching, mistakes and the remedy that fixed them, reusable preferences",
      "   or processes revealed by lengthy or iterative work, and important decisions or outcomes.",
      "   If there are durable facts missing from memory, add them to the finished file even if",
      "   nobody explicitly called `remember` during the conversation. Keep concise facts, not",
      "   chat transcripts, turn-by-turn status, one-off questions, or things you can look up again",
      "   in a second.",
      "2. If the learning is a procedure you would otherwise have to work out again — the steps",
      "   for something recurring, the shape of a report someone wants — write it down with",
      "   `save_skill` rather than as a memory entry. Memory is for facts, skills are for how.",
      "3. Rewrite your whole memory in one `forget` call. Not an edit — the finished file:",
      "   - merge entries that say the same thing, keeping the clearest wording",
      "   - group related facts under `##` headings if that makes it readable",
      "   - keep the `- (YYYY-MM-DD) fact` bullet shape, one fact per line",
      "   - drop the clutter, including the candidates above unless you think they still matter",
      "   - keep it honest: do not invent facts, and do not keep something you now know is wrong",
      "   Anything you leave out is archived, not destroyed, so prune with some nerve.",
      "4. Reply with the journal entry: a few lines on what happened in this channel today and",
      "   what you changed about your memory. Plain prose, no headings, no preamble. If nothing",
      "   was worth changing, say that in one line.",
      "",
      `Today is ${now.toISOString().slice(0, 10)}.`,
    ].join("\n"),
  );

  return sections.join("\n\n");
}

export interface DreamOutcome {
  entriesBefore: number;
  entriesAfter: number;
  summary: string;
  conversations: number;
  staleBefore: number;
}

/** One line of what the dream did, for logs and for `!dream`. */
export function describeOutcome(outcome: DreamOutcome): string {
  const delta = outcome.entriesAfter - outcome.entriesBefore;
  const change =
    delta === 0
      ? `${outcome.entriesAfter} memories, unchanged in number`
      : `${outcome.entriesBefore} → ${outcome.entriesAfter} memories`;
  return `${outcome.conversations} conversation(s) reviewed, ${change}`;
}

/**
 * Record the dream where a human can read it.
 *
 * The journal is the point of the feature being trustworthy: consolidation is
 * the agent editing its own memory unattended, and the only thing that makes
 * that reasonable is being able to open a file afterwards and see what it did.
 */
export function recordDream(
  channel: ResolvedChannel,
  outcome: DreamOutcome,
  now = new Date(),
): string {
  const path = join(channel.paths.memory, "DREAMS.md");
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(
        path,
        "# Dream journal\n\nWhat this channel made of each day, written during the nightly consolidation pass.\n",
      );
    }
    // A memory that halves in a night is either a very good clear-out or a
    // mistake, and the difference is worth seeing without reading the diff.
    const shrank =
      outcome.entriesBefore >= 6 && outcome.entriesAfter * 2 < outcome.entriesBefore;
    const lines = ["", `## ${now.toISOString().slice(0, 10)}`, "", `_${describeOutcome(outcome)}._`];
    if (shrank) {
      lines.push(
        "",
        "> Memory shrank by more than half. Dropped entries are in MEMORY.archive.md.",
      );
    }
    lines.push("", outcome.summary.trim() || "_No summary was produced._", "");
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    // The journal is a courtesy to a human, not part of the mechanism.
  }

  const state = new DreamState(channel.paths.root);
  const previous = state.read();
  state.write({
    runs: previous.runs + 1,
    lastDreamAt: now.toISOString(),
    lastSummary: outcome.summary.trim().slice(0, 2000),
  });

  return path;
}

/** Note a dream that failed, so the next one still looks back over the gap. */
export function recordDreamFailure(channel: ResolvedChannel, error: string): void {
  const state = new DreamState(channel.paths.root);
  const previous = state.read();
  state.write({ ...previous, lastError: error });
}

// --- The run log ----------------------------------------------------------

/**
 * A dream is the one thing here that happens with nobody watching, which makes
 * it the one thing hardest to work out afterwards. `DREAMS.md` is the agent's
 * own account of what it did — useful, and exactly as reliable as the agent.
 * This is the harness's account: what it fed in, what came back, what actually
 * changed on disk, and why a night produced nothing at all.
 *
 * Two files, because the two questions are different:
 *
 * - `dreams/log.jsonl` — one line per run, forever. Cheap enough at a line a
 *   night to never need pruning, and it answers "has this been working?"
 * - `dreams/<timestamp>.jsonl` — the full transcript of a run, including the
 *   tool calls, so the exact text a `forget` was given is recoverable. Bulky,
 *   so only the last few are kept.
 *
 * Both live under the channel root rather than in `memory/`, which puts them
 * outside the jail: this is for a human with a shell, not context for the
 * agent, and a dream reading its own logs back is the loop worth avoiding.
 */

export type DreamStatus = "completed" | "skipped" | "failed";

export interface DreamLogEntry {
  at: string;
  status: DreamStatus;
  /** Why a run was skipped, or how one failed. */
  reason?: string;
  /** Start of the lookback window this run used. */
  since?: string;
  conversations: number;
  staleBefore?: number;
  entriesBefore?: number;
  entriesAfter?: number;
  durationMs?: number;
  /** Model that served the run, as "provider/id". */
  model?: string;
  /** Filename of the kept transcript under dreams/, when one was kept. */
  transcript?: string;
  summary?: string;
}

export function dreamLogDir(channel: ResolvedChannel): string {
  return join(channel.paths.root, "dreams");
}

/** A filesystem-safe stamp that still sorts chronologically. */
export function dreamStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function appendDreamLog(channel: ResolvedChannel, entry: DreamLogEntry): void {
  try {
    const dir = dreamLogDir(channel);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging a dream must never be the thing that breaks one.
  }
}

/** The most recent runs, newest last. Tolerates a truncated final line. */
export function readDreamLog(channel: ResolvedChannel, limit = 10): DreamLogEntry[] {
  const file = join(dreamLogDir(channel), "log.jsonl");
  if (!existsSync(file)) return [];

  let lines: string[];
  try {
    lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }

  const out: DreamLogEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as DreamLogEntry);
    } catch {
      // A line half-written when the process was killed. Skip it.
    }
  }
  return out;
}

/**
 * Keep this run's transcript, and prune the ones that have aged out.
 *
 * `transcript` is the run's messages as JSON lines, read from its conversation: a dream is its
 * own fork of the channel's main conversation, so there is nothing in the sessions directory to
 * move. Returns the filename kept, if any.
 */
export function keepDreamTranscript(
  channel: ResolvedChannel,
  transcript: string | undefined,
  keep: number,
  now = new Date(),
): string | undefined {
  if (keep <= 0 || !transcript?.trim()) return undefined;
  const dir = dreamLogDir(channel);
  const name = `${dreamStamp(now)}.jsonl`;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), transcript.endsWith("\n") ? transcript : `${transcript}\n`);
  } catch {
    return undefined;
  }

  // Oldest first by name, which is chronological because the stamp is.
  try {
    const kept = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && f !== "log.jsonl")
      .sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - keep))) {
      rmSync(join(dir, old), { force: true });
    }
  } catch {
    // A failed prune costs disk, not correctness.
  }

  return name;
}

/** The last few journal entries, for `!dream`. */
export function readJournal(channel: ResolvedChannel, entries = 2): string {
  const path = join(channel.paths.memory, "DREAMS.md");
  if (!existsSync(path)) return "";
  try {
    const raw = readFileSync(path, "utf-8");
    const parts = raw.split(/\n(?=## )/).slice(1);
    return parts.slice(-entries).join("\n").trim();
  } catch {
    return "";
  }
}
