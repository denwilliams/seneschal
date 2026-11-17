import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChannelPaths } from "../workspace/paths.ts";
import { MAX_ATTACHMENT_BYTES } from "./attachment-limits.ts";
import { extractText, type Extraction } from "./extract.ts";

/**
 * Files people attach, on their way to being readable.
 *
 * A Slack attachment arrives as bytes with a private URL, which is no use to
 * anything: the agent cannot open a PDF, and a model cannot be handed one. So
 * an attachment is split in two the moment it lands.
 *
 * - The **original** goes to `channels/<id>/attachments/`, outside the jail.
 *   It is the record — what the library keeps, and what settles an argument
 *   about a summary — so the agent must not be able to edit it between it
 *   arriving and it being filed.
 * - The **text** goes to `workspace/attachments/`, inside the jail, where the
 *   agent reads it with the same `read` it uses for everything else. No new
 *   tool, no bytes through the model, and paging for free.
 *
 * The manifest ties the two together, so `add_document` can be handed the path
 * the agent read and still file the file that arrived, with the extraction
 * metadata the harness already worked out rather than the model's account of
 * it.
 *
 * This directory is a staging area, not storage: it keeps the last
 * `KEEP_STAGED` attachments per channel and drops the rest. Anything worth
 * more than that is in the document library, which is the point of the
 * library.
 */

export interface StagedAttachment {
  /** Absolute path of the extracted text, inside the channel's workspace. */
  textPath: string;
  /** Absolute path of the file as uploaded, outside the jail. */
  originalPath: string;
  filename: string;
  mimeType?: string;
  bytes: number;
  chars: number;
  /** How the text was got out — see `extract.ts`. */
  via: string;
  approximate: boolean;
  truncated: boolean;
  /** Slack permalink, when there is one. */
  source?: string;
  /** Who attached it. */
  userId?: string;
  stagedAt: string;
}

const MANIFEST = "index.json";
const KEEP_STAGED = 40;

function manifestPath(paths: ChannelPaths): string {
  return join(paths.attachments, MANIFEST);
}

function stagedAttachments(paths: ChannelPaths): StagedAttachment[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(paths), "utf-8")) as StagedAttachment[];
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // No manifest means nothing has been attached here yet.
  }
  return [];
}

function writeManifest(paths: ChannelPaths, entries: StagedAttachment[]): void {
  mkdirSync(paths.attachments, { recursive: true });
  const file = manifestPath(paths);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, file);
}

/**
 * The attachment a path refers to, whether the caller names the text or the
 * original. The agent will name the text, because that is what it read.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function findStaged(paths: ChannelPaths, path: string): StagedAttachment | undefined {
  const wanted = canonicalPath(path);
  return stagedAttachments(paths).find(
    (a) => canonicalPath(a.textPath) === wanted || canonicalPath(a.originalPath) === wanted,
  );
}

/** Keep names boring: this becomes a filename in the agent's own workspace. */
function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "attachment";
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 80);
  return clean || "attachment";
}

function unusedPath(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const dot = name.indexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const rest = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${rest}`;
    if (!existsSync(join(dir, candidate))) return join(dir, candidate);
  }
  return join(dir, `${stem}-${Date.now().toString(36)}${rest}`);
}

export interface StageInput {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
  source?: string;
  userId?: string;
}

/**
 * Read a file and put both halves where they belong.
 *
 * Throws `UnreadableFile` when there is no text to be had, which is not a
 * failure of the harness — a scanned page really has no words in it — and is
 * reported to the conversation rather than logged and swallowed.
 */
export async function stageAttachment(
  paths: ChannelPaths,
  input: StageInput,
  now = new Date(),
): Promise<{ staged: StagedAttachment; extraction: Extraction }> {
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${input.filename} is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB attachment limit, so it was not staged.`);
  }

  const extraction = await extractText(input.bytes, {
    filename: input.filename,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
  });

  mkdirSync(paths.attachments, { recursive: true });
  mkdirSync(paths.attachmentText, { recursive: true });

  const name = safeName(input.filename);
  const originalPath = unusedPath(paths.attachments, name);
  writeFileSync(originalPath, input.bytes);

  // `report.pdf.txt` keeps the original format visible, which is worth the
  // double extension — but `notes.txt.txt` is just silly.
  const textPath = unusedPath(
    paths.attachmentText,
    name.toLowerCase().endsWith(".txt") ? name : `${name}.txt`,
  );
  writeFileSync(textPath, `${extraction.text}\n`);

  const staged: StagedAttachment = {
    textPath,
    originalPath,
    filename: input.filename,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    bytes: input.bytes.length,
    chars: extraction.text.length,
    via: extraction.via,
    approximate: extraction.approximate,
    truncated: extraction.truncated,
    ...(input.source ? { source: input.source } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    stagedAt: now.toISOString(),
  };

  writeManifest(paths, prune(paths, [...stagedAttachments(paths), staged]));
  return { staged, extraction };
}

/**
 * Drop the oldest staged files once there are too many.
 *
 * `data/` growing forever is the harness's standing problem, and a directory
 * that fills up with everything anybody ever attached is the fastest way to
 * make it worse. Filing a document copies it into the library, so what is
 * dropped here is what nobody thought was worth keeping.
 */
function prune(paths: ChannelPaths, entries: StagedAttachment[]): StagedAttachment[] {
  if (entries.length <= KEEP_STAGED) return entries;
  const drop = entries.slice(0, entries.length - KEEP_STAGED);
  for (const old of drop) {
    rmSync(old.originalPath, { force: true });
    rmSync(old.textPath, { force: true });
  }
  return entries.slice(-KEEP_STAGED);
}
