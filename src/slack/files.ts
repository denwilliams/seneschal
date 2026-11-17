import { relative } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { MAX_ATTACHMENT_BYTES } from "../agent/attachment-limits.ts";
import { canExtract, unsupportedReason } from "../agent/extract.ts";
import { stageAttachment, type StagedAttachment } from "../agent/attachments.ts";
import type { ChannelPaths } from "../workspace/paths.ts";
import { logger } from "../util/log.ts";

/**
 * Slack file attachments.
 *
 * Two paths out of here, because there are two kinds of attachment.
 *
 * **Images** are downloaded and handed to the model as image content. They are
 * resized first: a phone screenshot is several thousand tokens at full size,
 * and the harness runs on someone's own budget.
 *
 * **Documents** are downloaded, read for text, and staged — the text into the
 * channel's workspace where the agent can open it, the original outside the
 * jail where the library will take it from. Until this existed the agent was
 * told the filename and that it could not open the file, which is the single
 * most reported limitation the harness has.
 *
 * Slack file URLs are private, so every download carries the bot token — which
 * is why this needs the `files:read` scope.
 */

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
}

export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface CollectedFiles {
  images: ImageAttachment[];
  /** Documents read and staged for this channel, in the order they arrived. */
  documents: StagedAttachment[];
  /** Human-readable notes about the attachments, for the prompt. */
  notes: string[];
}

/** Formats every provider accepts directly. Anything else is converted. */
const DIRECT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGES = 5;
/** Reading five contracts in one turn is not a thing anybody meant to do. */
const MAX_DOCUMENTS = 5;

function isImage(file: SlackFile): boolean {
  return (file.mimetype ?? "").startsWith("image/");
}

export interface StagingOptions {
  /** Where this channel's attachments live, on both sides of the jail. */
  paths: ChannelPaths;
  /** Who attached them. */
  userId?: string;
  /** Whether this channel may put a document into the shared library. */
  canFile: boolean;
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

async function download(url: string, token: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Slack returned ${res.status} ${res.statusText}`);
  }
  const buffer = new Uint8Array(await res.arrayBuffer());

  // Slack serves an HTML login page rather than a 4xx when the token cannot
  // read the file, which would otherwise be handed to the model as an "image".
  const head = new TextDecoder().decode(buffer.slice(0, 64)).toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html")) {
    throw new Error("received an HTML page instead of the file (missing files:read scope?)");
  }
  return buffer;
}

export async function collectFiles(
  files: SlackFile[] | undefined,
  botToken: string,
  staging?: StagingOptions,
): Promise<CollectedFiles> {
  const images: ImageAttachment[] = [];
  const documents: StagedAttachment[] = [];
  const notes: string[] = [];
  if (!files || files.length === 0) return { images, documents, notes };

  const imageFiles = files.filter(isImage);
  const others = files.filter((f) => !isImage(f));

  for (const file of others.slice(0, MAX_DOCUMENTS)) {
    const note = await readDocument(file, botToken, staging, documents);
    if (note) notes.push(note);
  }
  if (others.length > MAX_DOCUMENTS) {
    notes.push(
      `${others.length} documents were attached; only the first ${MAX_DOCUMENTS} were read. Ask for the rest one message at a time.`,
    );
  }

  for (const file of imageFiles.slice(0, MAX_IMAGES)) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;

    if (file.size && file.size > MAX_ATTACHMENT_BYTES) {
      notes.push(`An image was attached but is too large to read (${Math.round(file.size / 1e6)}MB).`);
      continue;
    }

    try {
      const bytes = await download(url, botToken);
      const mimeType = file.mimetype ?? "image/png";
      const resized = await resizeImage(bytes, mimeType);

      if (resized) {
        images.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
      } else if (DIRECT_TYPES.has(mimeType)) {
        images.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType,
        });
      } else {
        notes.push(`An image was attached in an unsupported format (${mimeType}).`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(`could not download Slack file ${file.name ?? file.id}: ${detail}`);
      notes.push(`An image was attached but could not be downloaded: ${detail}`);
    }
  }

  if (imageFiles.length > MAX_IMAGES) {
    notes.push(
      `${imageFiles.length} images were attached; only the first ${MAX_IMAGES} were read.`,
    );
  }

  return { images, documents, notes };
}

/**
 * Read one non-image attachment, and say what the agent should do with it.
 *
 * The note matters as much as the staging. An agent told only that a file
 * exists summarises the filename; an agent told where the text is, how long it
 * is, and that filing it is a thing it can do, reads it and files it. Where a
 * file cannot be read, the note says why in words that can be repeated to the
 * person who attached it — that is a better answer than silence, and it is the
 * one thing the harness can always give.
 */
async function readDocument(
  file: SlackFile,
  botToken: string,
  staging: StagingOptions | undefined,
  into: StagedAttachment[],
): Promise<string | undefined> {
  const name = file.name ?? file.title ?? "an unnamed file";
  const mimeType = file.mimetype ?? undefined;

  if (!staging) {
    return `${name} was attached, but attachments are not read in this channel.`;
  }
  if (!canExtract(file.name, mimeType)) {
    return unsupportedReason(file.name, mimeType);
  }
  if (file.size && file.size > MAX_ATTACHMENT_BYTES) {
    return `${name} was attached but is ${describeSize(file.size)}, over the ${describeSize(MAX_ATTACHMENT_BYTES)} limit, so it was not read.`;
  }

  const url = file.url_private_download ?? file.url_private;
  if (!url) return `${name} was attached but Slack gave no way to download it.`;

  let bytes: Uint8Array;
  try {
    bytes = await download(url, botToken);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`could not download Slack file ${name}: ${detail}`);
    return `${name} was attached but could not be downloaded: ${detail}`;
  }

  try {
    const { staged } = await stageAttachment(staging.paths, {
      bytes,
      filename: file.name ?? name,
      ...(mimeType ? { mimeType } : {}),
      ...(file.permalink ? { source: file.permalink } : {}),
      ...(staging.userId ? { userId: staging.userId } : {}),
    });
    into.push(staged);

    const where = relative(staging.paths.workspace, staged.textPath);
    return [
      `${name} was attached (${describeSize(staged.bytes)}).`,
      `Its text has been extracted to \`${where}\` — ${staged.chars.toLocaleString()} characters.`,
      staged.approximate
        ? "The extraction was approximate, so wording may be imperfect and the layout is lost."
        : "",
      staged.truncated ? "The document was too long to extract in full; the end is missing." : "",
      "Read it before you answer.",
      staging.canFile
        ? "If it has lasting value, file it with `add_document` so every channel can find it later; if it is transient, do not."
        : "This channel cannot file documents into the library, so it will be dropped once newer attachments arrive.",
    ]
      .filter(Boolean)
      .join(" ");
  } catch (err) {
    // An unreadable file is a real answer, not an error to swallow: "that is a
    // scan and there is no OCR here" is what the person needs to be told.
    const detail = err instanceof Error ? err.message : String(err);
    logger.info(`could not read attachment ${name}: ${detail}`);
    return detail;
  }
}

/** Whether a model can actually be shown an image. */
export function modelAcceptsImages(model: { input?: readonly string[] } | undefined): boolean {
  return Boolean(model?.input?.includes("image"));
}
