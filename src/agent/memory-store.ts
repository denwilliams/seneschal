import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/**
 * Memory, with enough structure to be able to forget.
 *
 * The file itself stays exactly what it was: markdown someone can open and
 * read, one bullet per fact. What is new is a sidecar index holding the things
 * markdown cannot carry without becoming unreadable — when a fact first
 * arrived, how often it has been reached for, how often it has been re-learned.
 *
 * That is the minimum needed for the two halves of consolidation:
 *
 * - **Strengthening.** Being told the same thing twice should not produce two
 *   bullets. It should make one bullet count for more, so that when something
 *   eventually has to go, the fact everybody keeps repeating is not the one
 *   that goes.
 * - **Forgetting.** A fact nobody has used since the day it was written, months
 *   ago, is clutter. It can be dropped — but into an archive file rather than
 *   into nothing, because "the bot forgot something it shouldn't have" is much
 *   worse than a slightly larger data directory.
 *
 * The index is a cache, not the truth: delete it and every entry simply looks
 * new. Nothing here fails if it is missing or corrupt.
 */

/** `- (2026-08-09) The upstairs valve lies.` — the date is optional. */
const ENTRY_RE = /^\s*[-*]\s+(?:\((\d{4}-\d{2}-\d{2})\)\s+)?(.+?)\s*$/;

const INDEX_VERSION = 1;

export interface MemoryStats {
  /** ISO date the harness first saw this fact. */
  first: string;
  /** How many times a targeted recall has surfaced it. */
  uses: number;
  lastUsed?: string;
  /** How many times it has been learned. 1 = heard once. */
  strength: number;
  /** When it was last re-learned, if ever. */
  lastReinforced?: string;
}

export interface MemoryEntry {
  /** Stable id derived from the text, so stats survive a rewrite of the file. */
  id: string;
  text: string;
  /** Date written on the bullet, when it has one. */
  date?: string;
  stats: MemoryStats;
}

interface IndexFile {
  version: number;
  entries: Record<string, MemoryStats>;
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Compare facts the way a reader would: case, spacing and a trailing full stop
 * are not what makes two sentences the same fact.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
}

export function entryId(text: string): string {
  return createHash("sha1").update(normalise(text)).digest("hex").slice(0, 12);
}

/** Sidecar paths, derived from the memory file so both scopes get their own. */
export function indexPathFor(memoryFile: string): string {
  return memoryFile.replace(/\.md$/i, "") + ".index.json";
}

export function archivePathFor(memoryFile: string): string {
  return memoryFile.replace(/\.md$/i, "") + ".archive.md";
}

/**
 * Words worth matching on. Short words and the connective tissue of English
 * match everything, so they would make every query score against every entry.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "are", "has", "have",
  "what", "when", "who", "how", "why", "does", "did", "our", "her", "his", "its",
  "you", "your", "they", "them", "there", "here", "about", "into", "than", "then",
  "not", "but", "all", "any", "can", "will", "would", "should", "been", "were",
]);

/**
 * Exported because the document library scores queries the same way, and two
 * tokenisers that drift apart would mean "boiler" finding a memory and not the
 * manual it came from.
 */
export function keywords(text: string): string[] {
  return [...new Set(
    normalise(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  )];
}

/**
 * Whether `candidate` says the same thing as `existing`.
 *
 * Exact after normalising is the safe case. The interesting one is a fact
 * restated with more detail ("the boiler is serviced in October" → "the boiler
 * is serviced in October by Kelly") — that should refine the entry we have
 * rather than sit beside it. Containment is the test, with a length floor so a
 * short fragment cannot swallow an unrelated longer sentence.
 */
export function isSameFact(existing: string, candidate: string): boolean {
  const a = normalise(existing);
  const b = normalise(candidate);
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 12) return false;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.6;
}

export interface AppendResult {
  /** True when an existing entry was strengthened instead of a new one added. */
  reinforced: boolean;
  entry: MemoryEntry;
  /** Set when reinforcement also rewrote the entry with more detail. */
  replaced?: string;
}

export interface RewriteResult {
  kept: number;
  added: number;
  dropped: MemoryEntry[];
}

export interface StaleOptions {
  /** Entries untouched for longer than this are candidates. */
  days: number;
  now?: Date;
}

/**
 * One memory file plus its sidecar index.
 *
 * Reads are cheap and unconditional; writes only happen through the methods
 * that are meant to write, so a read-only scope (another channel's memory) can
 * be parsed and scored without leaving anything behind.
 */
export class MemoryFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): string {
    try {
      return readFileSync(this.path, "utf-8");
    } catch {
      return "";
    }
  }

  private readIndex(): IndexFile {
    try {
      const parsed = JSON.parse(readFileSync(indexPathFor(this.path), "utf-8")) as IndexFile;
      if (parsed && typeof parsed === "object" && parsed.entries) {
        return { version: INDEX_VERSION, entries: parsed.entries };
      }
    } catch {
      // A missing or corrupt index just means everything looks newly learned.
    }
    return { version: INDEX_VERSION, entries: {} };
  }

  private writeIndex(index: IndexFile): void {
    const file = indexPathFor(this.path);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(index, null, 2));
      renameSync(tmp, file);
    } catch {
      // Losing the index costs decay tracking, not memory. Never fail a write
      // of the actual fact because the bookkeeping could not be saved.
    }
  }

  /** Every bullet in the file, with whatever the index knows about it. */
  entries(): MemoryEntry[] {
    const index = this.readIndex();
    const out: MemoryEntry[] = [];
    for (const line of this.read().split("\n")) {
      const match = ENTRY_RE.exec(line);
      if (!match) continue;
      const text = match[2]!.trim();
      if (!text) continue;
      const id = entryId(text);
      const date = match[1];
      out.push({
        id,
        text,
        ...(date ? { date } : {}),
        stats: index.entries[id] ?? { first: date ?? today(), uses: 0, strength: 1 },
      });
    }
    return out;
  }

  /**
   * Add a fact, or strengthen the one already saying it.
   *
   * The reinforcement path is the whole point: hearing something a second time
   * is evidence it matters, and the alternative — a second identical bullet —
   * makes the file worse rather than the memory stronger.
   */
  append(text: string, now = new Date()): AppendResult {
    const clean = text.trim();
    const existing = this.entries();
    const match = existing.find((e) => isSameFact(e.text, clean));

    if (match) {
      const index = this.readIndex();
      const stats: MemoryStats = {
        ...(index.entries[match.id] ?? match.stats),
        strength: (index.entries[match.id]?.strength ?? match.stats.strength) + 1,
        lastReinforced: now.toISOString(),
      };

      // A restatement with more detail replaces the line; the id moves with the
      // text, so the strength earned by the original carries over.
      const refine = normalise(clean).length > normalise(match.text).length;
      if (refine) {
        const body = this.read();
        const replaced = body.replace(
          new RegExp(`^([ \\t]*[-*][ \\t]+(?:\\(\\d{4}-\\d{2}-\\d{2}\\)[ \\t]+)?)${escapeRegExp(match.text)}[ \\t]*$`, "m"),
          (_all, prefix: string) => `${prefix}${clean}`,
        );
        writeFileSync(this.path, replaced);
        delete index.entries[match.id];
        const id = entryId(clean);
        index.entries[id] = stats;
        this.writeIndex(index);
        return {
          reinforced: true,
          entry: { id, text: clean, stats },
          replaced: match.text,
        };
      }

      index.entries[match.id] = stats;
      this.writeIndex(index);
      return { reinforced: true, entry: { ...match, stats } };
    }

    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, "# Memory\n");
    appendFileSync(this.path, `\n- (${today(now)}) ${clean}\n`);

    const index = this.readIndex();
    const id = entryId(clean);
    const stats: MemoryStats = { first: today(now), uses: 0, strength: 1 };
    index.entries[id] = stats;
    this.writeIndex(index);
    return { reinforced: false, entry: { id, text: clean, stats } };
  }

  /**
   * Entries matching a topic, best first.
   *
   * Scoring is deliberately crude — shared keywords — because the alternative
   * is an embedding model on a Raspberry Pi. It is good enough for its real
   * job, which is not search but knowing *which* facts were worth surfacing, so
   * that the ones nobody ever reaches for can eventually be let go.
   */
  search(about: string, limit = 20): MemoryEntry[] {
    const wanted = keywords(about);
    if (wanted.length === 0) return [];
    return this.entries()
      .map((entry) => {
        const words = new Set(keywords(entry.text));
        return { entry, score: wanted.filter((w) => words.has(w)).length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.stats.strength - a.entry.stats.strength)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /** Record that these entries were actually reached for. */
  markUsed(ids: string[], now = new Date()): void {
    if (ids.length === 0) return;
    const index = this.readIndex();
    for (const id of ids) {
      const stats = index.entries[id] ?? { first: today(now), uses: 0, strength: 1 };
      index.entries[id] = { ...stats, uses: stats.uses + 1, lastUsed: now.toISOString() };
    }
    this.writeIndex(index);
  }

  /**
   * Replace the whole file, keeping what the index knew and archiving what fell
   * out.
   *
   * Consolidation is a rewrite: merged entries, dropped entries, reworded
   * entries. Doing it through here rather than a bare `writeFileSync` is what
   * makes it safe to let the agent do it unattended — anything that disappears
   * is written to the archive first, so a bad dream is recoverable by hand.
   */
  rewrite(content: string, now = new Date()): RewriteResult {
    const before = this.entries();
    const body = content.endsWith("\n") ? content : `${content}\n`;

    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, body);

    const after = this.entries();
    const kept = new Set(after.map((e) => e.id));
    const dropped = before.filter((e) => !kept.has(e.id));

    const index = this.readIndex();
    const next: Record<string, MemoryStats> = {};
    for (const entry of after) {
      next[entry.id] = index.entries[entry.id] ?? {
        first: entry.date ?? today(now),
        uses: 0,
        strength: 1,
      };
    }
    this.writeIndex({ version: INDEX_VERSION, entries: next });

    if (dropped.length > 0) this.archive(dropped, now);
    return {
      kept: after.filter((e) => index.entries[e.id]).length,
      added: after.length - after.filter((e) => index.entries[e.id]).length,
      dropped,
    };
  }

  /** Write entries out to the archive file, so nothing is lost outright. */
  archive(entries: MemoryEntry[], now = new Date()): void {
    if (entries.length === 0) return;
    const file = archivePathFor(this.path);
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (!existsSync(file)) {
        writeFileSync(
          file,
          "# Archived memory\n\nEntries dropped during consolidation. Kept so nothing is lost outright — move a line back into MEMORY.md to restore it.\n",
        );
      }
      const lines = entries.map(
        (e) =>
          `- (${e.date ?? e.stats.first}) ${e.text}  _[learned ${e.stats.strength}×, used ${e.stats.uses}×]_`,
      );
      appendFileSync(file, `\n## Dropped ${today(now)}\n\n${lines.join("\n")}\n`);
    } catch {
      // Same reasoning as the index: bookkeeping must not break the rewrite.
    }
  }

  /**
   * Entries that look like clutter: old, never reached for, never repeated.
   *
   * All three conditions matter. Old alone would drop the address of the house.
   * Unused alone would drop something learned yesterday. Together they describe
   * a fact that arrived once, months ago, and has been irrelevant ever since.
   */
  stale(opts: StaleOptions): MemoryEntry[] {
    const now = opts.now ?? new Date();
    const cutoff = now.getTime() - opts.days * 86_400_000;
    return this.entries().filter((e) => {
      if (e.stats.uses > 0 || e.stats.strength > 1) return false;
      const touched = e.stats.lastUsed ?? e.stats.lastReinforced ?? e.date ?? e.stats.first;
      const at = Date.parse(touched);
      return Number.isFinite(at) && at < cutoff;
    });
  }

  /**
   * The file as the agent should see it when deciding what to keep: every entry
   * with its age and how much use it has had.
   */
  annotated(now = new Date()): string {
    const entries = this.entries();
    if (entries.length === 0) return "";
    return entries
      .map((e) => {
        const from = Date.parse(e.date ?? e.stats.first);
        const days = Number.isFinite(from)
          ? Math.max(0, Math.round((now.getTime() - from) / 86_400_000))
          : 0;
        const bits = [`${days}d old`, `used ${e.stats.uses}×`];
        if (e.stats.strength > 1) bits.push(`learned ${e.stats.strength}×`);
        return `- ${e.text}  [${bits.join(", ")}]`;
      })
      .join("\n");
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
