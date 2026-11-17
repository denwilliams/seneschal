import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { keywords } from "./memory-store.ts";
import { extractText, fileExtension } from "./extract.ts";

/**
 * The document library: the account's shelf of things somebody wrote down.
 *
 * Until now a file attached in Slack was a dead end. The agent was told its
 * name and type and that it could not open it, which is exactly the wall
 * `report_limitation` has been collecting reports about. The library is the
 * other side of that: a document is read once, described once, and is then
 * findable by every channel from then on.
 *
 * The division of labour is the whole design.
 *
 * - **The harness does the mechanical part.** Downloading, extracting text,
 *   checksums, provenance, where the bytes live. None of that is a judgement
 *   call, so none of it is left to a model.
 * - **The agent does the judgement.** The title, the summary, the category and
 *   the tags are written by something that has read the document, because a
 *   filename and a first paragraph are not a description of what a document is
 *   for. That is the "scan, summarise, categorise" part, and it is a model's
 *   job in the same way writing a skill is.
 * - **The store keeps them apart.** Everything the agent supplies is metadata;
 *   everything that must be true — the bytes, the checksum, the channel that
 *   filed it, when — is derived here and cannot be overstated by a tool call.
 *
 * Documents are account-wide on purpose: a contract is a contract in every
 * channel, and a library that had to be published into channel by channel
 * would mostly be empty. That makes "do not file anything private here" a rule
 * the agent is told plainly, and `share.documents: false` the way a channel
 * opts out of the shelf entirely.
 *
 *   data/shared/documents/
 *     INDEX.md              rendered for humans; regenerated, never edited
 *     <id>/document.json    metadata, including who filed it and from where
 *     <id>/text.md          the extracted text — what search and reading use
 *     <id>/original.<ext>   the file exactly as it was attached
 */

export interface DocumentEntry {
  /** Slug derived from the title. Stable, and how everything refers to it. */
  id: string;
  title: string;
  /** Written by the agent that read it. This is what search matches first. */
  summary: string;
  category: string;
  tags: string[];
  /** The filename as attached. */
  filename: string;
  mimeType?: string;
  /** Size of the original, in bytes. */
  bytes: number;
  /** Length of the extracted text. */
  chars: number;
  /** How the text was got out: "pdftotext", "docx", "text"… */
  extractedVia: string;
  /** Set when the extraction was best-effort, so a reader can discount it. */
  approximate?: boolean;
  /** Set when the document was longer than the extraction cap. */
  truncated?: boolean;
  /** sha256 of the original bytes. What "we already have this" means. */
  checksum: string;
  /** Channel label as it read when the document was filed. For humans. */
  addedBy: string;
  /** The identity that matters: only this channel may replace or remove it. */
  addedByChannelId: string;
  /** Slack user who attached it, when there was one. */
  addedByUser?: string;
  addedAt: string;
  updatedAt: string;
  /** Bumped each time the filing channel re-files it. */
  version: number;
  /** Where it came from — a Slack permalink, a URL, or a note. */
  source?: string;
  /** Why it is worth keeping. Optional; the summary carries the weight. */
  note?: string;
  /** Present when the original was kept alongside the text. */
  originalFile?: string;
}

const META_FILE = "document.json";
const TEXT_FILE = "text.md";
const INDEX_FILE = "INDEX.md";

const MAX_TITLE = 120;
const MAX_SUMMARY = 1500;
const MIN_SUMMARY = 40;
const MAX_TAGS = 8;
const MAX_NOTE = 300;
/** Above this a document is not read for a search; its metadata still is. */
const MAX_SEARCHED_CHARS = 2_000_000;

function documentDir(shared: SharedPaths, id: string): string {
  return join(shared.documents, id);
}

/** Lowercase, hyphenated, and safe as a directory name. */
export function slugify(raw: string, fallback = "document"): string {
  const slug = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || fallback;
}

export function readDocumentEntry(shared: SharedPaths, id: string): DocumentEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(documentDir(shared, id), META_FILE), "utf-8")) as DocumentEntry;
    if (parsed && typeof parsed.id === "string") return parsed;
  } catch {
    // A directory with no readable metadata is not a document. Leaving it out
    // of every listing is the right failure: an entry whose provenance cannot
    // be read is exactly the one not to hand to another channel.
  }
  return undefined;
}

function writeEntry(shared: SharedPaths, entry: DocumentEntry): void {
  const dir = documentDir(shared, entry.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, META_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

/** Everything on the shelf, most recently filed first. */
export function listDocuments(shared: SharedPaths): DocumentEntry[] {
  if (!existsSync(shared.documents)) return [];
  let names: string[];
  try {
    names = readdirSync(shared.documents);
  } catch {
    return [];
  }
  const out: DocumentEntry[] = [];
  for (const name of names) {
    if (!existsSync(join(documentDir(shared, name), TEXT_FILE))) continue;
    const entry = readDocumentEntry(shared, name);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listCategories(shared: SharedPaths): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of listDocuments(shared)) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function readDocumentText(shared: SharedPaths, id: string): string {
  const path = join(documentDir(shared, id), TEXT_FILE);
  if (!existsSync(path)) throw new Error(`The document library has nothing filed as \`${id}\`.`);
  return readFileSync(path, "utf-8");
}

/** One page of a document, for a tool that must not blow up a context window. */
export interface DocumentPage {
  entry: DocumentEntry;
  text: string;
  /** Character offset this page starts at. */
  offset: number;
  /** Total characters in the document. */
  total: number;
  /** Set when there is more after this page. */
  more: boolean;
}

export function readDocumentPage(
  shared: SharedPaths,
  id: string,
  opts: { offset?: number; limit?: number } = {},
): DocumentPage {
  const entry = readDocumentEntry(shared, id);
  if (!entry) throw new Error(`The document library has nothing filed as \`${id}\`.`);
  const full = readDocumentText(shared, id);
  const offset = Math.max(0, Math.min(opts.offset ?? 0, full.length));
  const limit = Math.max(1, opts.limit ?? 20_000);
  const text = full.slice(offset, offset + limit);
  return { entry, text, offset, total: full.length, more: offset + text.length < full.length };
}

function findByChecksum(shared: SharedPaths, checksum: string): DocumentEntry | undefined {
  return listDocuments(shared).find((e) => e.checksum === checksum);
}

// --- Filing ----------------------------------------------------------------

export interface AddDocumentInput {
  /**
   * The file to file, as an absolute path the caller has already checked
   * against the channel's jail. Its bytes are what the library keeps.
   */
  path: string;
  /** The name it arrived under, when that differs from the staged filename. */
  filename?: string;
  mimeType?: string;
  /** Where it came from: a Slack permalink, a URL, or how it was produced. */
  source?: string;
  addedByUser?: string;

  // --- Everything below is the agent's judgement ---------------------------
  title: string;
  summary: string;
  category: string;
  tags?: string[];
  note?: string;
}

export interface AddDocumentResult {
  entry: DocumentEntry;
  /** Set when this replaced a version of the same document. */
  replacedVersion?: number;
  /** Set when the same bytes were already on the shelf, filed by someone else. */
  duplicateOf?: DocumentEntry;
  /**
   * Set when a different document already held this title. Worth mentioning:
   * two entries called "Minutes" are fine, two entries of the *same* minutes
   * are not, and only a person can tell which just happened.
   */
  alongside?: DocumentEntry;
}

/**
 * Put a document on the shelf.
 *
 * Refuses rather than guesses. A summary of eight words, a category that is
 * really a title, a file with no readable text — each of those produces a
 * library entry that is worse than no entry, because it will be found by a
 * search and then waste the reader's turn. The errors say what to do instead.
 */
export async function addDocument(
  shared: SharedPaths,
  channel: ResolvedChannel,
  input: AddDocumentInput,
  now = new Date(),
): Promise<AddDocumentResult> {
  if (!existsSync(input.path)) {
    throw new Error(`There is no file at ${input.path}.`);
  }
  const stat = statSync(input.path);
  if (stat.isDirectory()) throw new Error(`${input.path} is a directory, not a document.`);

  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("A document needs a title — the name someone would look for it under.");
  if (title.length > MAX_TITLE) throw new Error(`Titles are at most ${MAX_TITLE} characters.`);

  const summary = input.summary.trim();
  if (summary.length < MIN_SUMMARY) {
    throw new Error(
      "The summary is what somebody reads instead of the document, and what a search matches against. " +
        "Write a few sentences: what this document is, what is actually in it, and when someone here would need it.",
    );
  }
  if (summary.length > MAX_SUMMARY) {
    throw new Error(`Summaries are at most ${MAX_SUMMARY} characters — this one is ${summary.length}.`);
  }

  const category = slugify(input.category, "");
  if (!category) {
    throw new Error(
      "A document needs a category, as a short slug like `contracts` or `product-specs`. " +
        "Use `list_documents` first and reuse a category that already exists rather than inventing a near-duplicate.",
    );
  }

  const note = input.note?.trim().slice(0, MAX_NOTE);
  const tags = [...new Set((input.tags ?? []).map((t) => slugify(t, "")).filter(Boolean))].slice(0, MAX_TAGS);

  const bytes = readFileSync(input.path);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const filename = input.filename?.trim() || basename(input.path);

  // The checksum, not the title, is what identifies a document. Two sets of
  // minutes are honestly both called "Minutes", and filing the second must not
  // quietly delete the first; the same bytes arriving twice is the only case
  // where "this is that document again" is certain.
  const duplicate = findByChecksum(shared, checksum);
  if (duplicate && duplicate.addedByChannelId !== channel.ref.id) {
    return { entry: duplicate, duplicateOf: duplicate };
  }

  const extraction = await extractText(bytes, {
    filename,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
  });

  // Re-filing our own document is how a summary gets better: same bytes, same
  // channel, so the entry is updated in place.
  const existing = duplicate;
  const base = slugify(title);
  const id = existing?.id ?? uniqueId(shared, base);
  const alongside = id === base ? undefined : readDocumentEntry(shared, base);

  const dir = documentDir(shared, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TEXT_FILE), `${extraction.text}\n`);

  // The original is kept, not just the text. A summary is a claim about a
  // document; the document is what settles an argument about the claim.
  const ext = fileExtension(filename);
  const originalFile = ext ? `original.${ext}` : "original";
  for (const stale of readdirSync(dir).filter((f) => f.startsWith("original.") && f !== originalFile)) {
    rmSync(join(dir, stale), { force: true });
  }
  copyFileSync(input.path, join(dir, originalFile));

  const entry: DocumentEntry = {
    id,
    title,
    summary,
    category,
    tags,
    filename,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    bytes: stat.size,
    chars: extraction.text.length,
    extractedVia: extraction.via,
    ...(extraction.approximate ? { approximate: true } : {}),
    ...(extraction.truncated ? { truncated: true } : {}),
    checksum,
    addedBy: channel.ref.name ? `#${channel.ref.name}` : channel.ref.id,
    addedByChannelId: channel.ref.id,
    ...(input.addedByUser ? { addedByUser: input.addedByUser } : {}),
    addedAt: existing?.addedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    version: (existing?.version ?? 0) + 1,
    ...(input.source ? { source: input.source } : {}),
    ...(note ? { note } : {}),
    originalFile,
  };

  writeEntry(shared, entry);
  renderDocumentIndex(shared);

  return {
    entry,
    ...(existing ? { replacedVersion: existing.version } : {}),
    ...(alongside ? { alongside } : {}),
  };
}

/** `contract`, then `contract-2` — two documents may honestly share a title. */
function uniqueId(shared: SharedPaths, base: string): string {
  if (!existsSync(documentDir(shared, base))) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(documentDir(shared, candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Take a document off the shelf. Only the channel that filed it may. */
export function removeDocument(shared: SharedPaths, channel: ResolvedChannel, id: string): boolean {
  const entry = readDocumentEntry(shared, id);
  if (!entry) return false;
  if (entry.addedByChannelId !== channel.ref.id) {
    throw new Error(
      `\`${id}\` was filed by ${entry.addedBy}, so this channel cannot remove it. ` +
        "Say what is wrong with it in that channel instead.",
    );
  }
  rmSync(documentDir(shared, id), { recursive: true, force: true });
  renderDocumentIndex(shared);
  return true;
}

// --- Finding ----------------------------------------------------------------

export interface DocumentHit {
  entry: DocumentEntry;
  score: number;
  /** A line from the document showing why it matched, when the body matched. */
  snippet?: string;
}

export interface SearchOptions {
  category?: string;
  limit?: number;
}

/**
 * Find a document the way somebody would ask for one.
 *
 * Weighted rather than uniform: a query word in the title or the tags almost
 * certainly means the document is the one, and the same word buried in a
 * forty-page appendix almost certainly does not. Body matches still count,
 * and are capped, so one document that says "invoice" two hundred times cannot
 * bury the invoice.
 */
export function searchDocuments(
  shared: SharedPaths,
  query: string,
  opts: SearchOptions = {},
): DocumentHit[] {
  const terms = keywords(query);
  const literal = query.trim().toLowerCase();
  const category = opts.category ? slugify(opts.category, "") : undefined;

  const hits: DocumentHit[] = [];
  for (const entry of listDocuments(shared)) {
    if (category && entry.category !== category) continue;

    const title = entry.title.toLowerCase();
    const meta = `${entry.category} ${entry.tags.join(" ")}`.toLowerCase();
    const summary = entry.summary.toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 6;
      if (meta.includes(term)) score += 4;
      if (summary.includes(term)) score += 3;
    }
    // A short query is often a whole phrase ("leave policy"), which the word
    // scores above cannot tell from the two words being far apart.
    if (literal.length >= 4 && (title.includes(literal) || summary.includes(literal))) score += 4;

    const body = bodyMatches(shared, entry, terms.length > 0 ? terms : [literal].filter(Boolean));
    score += Math.min(body.count, 5);

    if (score > 0) hits.push({ entry, score, ...(body.snippet ? { snippet: body.snippet } : {}) });
  }

  return hits
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, Math.max(1, opts.limit ?? 8));
}

function bodyMatches(
  shared: SharedPaths,
  entry: DocumentEntry,
  terms: string[],
): { count: number; snippet?: string } {
  if (terms.length === 0 || entry.chars > MAX_SEARCHED_CHARS) return { count: 0 };
  let raw: string;
  try {
    raw = readDocumentText(shared, entry.id);
  } catch {
    return { count: 0 };
  }
  const text = raw.toLowerCase();

  let count = 0;
  let first = -1;
  for (const term of terms) {
    const at = text.indexOf(term);
    if (at === -1) continue;
    count++;
    if (first === -1 || at < first) first = at;
  }
  if (first === -1) return { count: 0 };

  const start = Math.max(0, first - 100);
  const snippet = raw
    .slice(start, first + 180)
    .replace(/\s+/g, " ")
    .trim();
  return { count, snippet: `${start > 0 ? "…" : ""}${snippet}${first + 180 < raw.length ? "…" : ""}` };
}

// --- Rendering --------------------------------------------------------------

/** One line per document, for `!docs` and the listing tool. */
export function describeDocument(entry: DocumentEntry): string {
  const flags = [
    entry.approximate ? "extraction approximate" : "",
    entry.truncated ? "truncated" : "",
  ].filter(Boolean);
  return (
    `• *${entry.title}* — \`${entry.id}\`\n` +
    `   ${entry.summary.split("\n")[0]}\n` +
    `   _${entry.category}${entry.tags.length > 0 ? ` · ${entry.tags.join(", ")}` : ""} · ` +
    `${entry.filename} · from ${entry.addedBy}, ${entry.updatedAt.slice(0, 10)}${
      flags.length > 0 ? ` · ${flags.join(", ")}` : ""
    }_`
  );
}

/**
 * The shelf as a page somebody can read.
 *
 * Regenerated on every change for the same reason `FEEDBACK.md` is: a file
 * that has to be kept up to date by hand is one that is wrong within a week.
 */
export function renderDocumentIndex(shared: SharedPaths): void {
  const entries = listDocuments(shared);
  const byCategory = new Map<string, DocumentEntry[]>();
  for (const entry of entries) {
    byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry]);
  }

  const lines = [
    "# Document library",
    "",
    "Everything the account has filed. Written by the harness — edits here are overwritten.",
    "",
    entries.length === 0 ? "_Nothing filed yet._" : `${entries.length} document(s).`,
  ];

  for (const category of [...byCategory.keys()].sort()) {
    lines.push("", `## ${category}`, "");
    for (const entry of byCategory.get(category) ?? []) {
      lines.push(
        `### ${entry.title}`,
        "",
        `\`${entry.id}\` · ${entry.filename} · filed by ${entry.addedBy} on ${entry.addedAt.slice(0, 10)}` +
          `${entry.tags.length > 0 ? ` · ${entry.tags.map((t) => `#${t}`).join(" ")}` : ""}`,
        "",
        entry.summary,
        "",
      );
    }
  }

  try {
    mkdirSync(shared.documents, { recursive: true });
    const file = join(shared.documents, INDEX_FILE);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${lines.join("\n").trimEnd()}\n`);
    renameSync(tmp, file);
  } catch {
    // The index is a convenience; failing to render it must not lose a filing.
  }
}
