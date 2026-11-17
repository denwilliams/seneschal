import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readSync, opendirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_ATTACHMENT_BYTES } from "./attachment-limits.ts";
import { extractText, type Extraction } from "./extract.ts";

/**
 * PDF text for files that a trusted connector has already downloaded into the
 * channel's attachment staging directory.
 *
 * This deliberately is not a general local-file converter: the source must be
 * a regular PDF directly below this channel's sanctioned attachment directory,
 * and the only possible destination is a sibling with `.txt` or `.md` added.
 * That keeps a connector download useful without turning document extraction
 * into a read/write primitive for the host filesystem.
 */

export type LocalPdfFormat = "txt" | "md";

export interface LocalPdfContext {
  /** The channel workspace, used only to resolve an agent's relative path. */
  workspace: string;
  /** The connector/attachment staging directory inside that workspace. */
  attachmentDir: string;
}

export interface LocalPdfExtraction {
  sourcePath: string;
  textPath: string;
  bytes: number;
  extraction: Extraction;
  /** A fingerprinted sibling output already matched this exact source and text. */
  reused: boolean;
}

export interface PdfAttachmentSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
}

function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep);
}

function attachmentRoot(dir: string): string {
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    return realpathSync(dir);
  } catch {
    throw new Error("The channel attachment directory is unavailable; connector PDFs can only be extracted after they are staged there.");
  }
}

function sourcePdfPath(ctx: LocalPdfContext, rawPath: string): string {
  const requested = rawPath.trim();
  if (!requested) throw new Error("extract_local_pdf needs the PDF path returned by the connector.");

  const configuredRoot = resolve(ctx.attachmentDir);
  const root = attachmentRoot(ctx.attachmentDir);
  const lexical = isAbsolute(requested) ? resolve(requested) : resolve(ctx.workspace, requested);
  if (!isWithin(lexical, configuredRoot)) {
    throw new Error("PDF extraction only accepts files in this channel's attachments directory, not arbitrary workspace or host paths.");
  }
  if (!basename(lexical).toLowerCase().endsWith(".pdf")) {
    throw new Error("extract_local_pdf only accepts a .pdf source file.");
  }

  let info;
  try {
    info = lstatSync(lexical);
  } catch {
    throw new Error(`There is no PDF at ${rawPath}.`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("The PDF source must be a regular file, not a directory or symlink.");
  }

  const resolved = realpathSync(lexical);
  if (!isWithin(resolved, root)) {
    throw new Error("The PDF resolves outside this channel's attachments directory, so it was refused.");
  }
  return resolved;
}

function assertPdfBytes(bytes: Uint8Array, path: string): void {
  // A PDF header is allowed to be preceded by a short binary comment; PDF 2.0
  // requires it within the first 1,024 bytes. This prevents a misleading .pdf
  // extension from sending arbitrary local bytes through a parser.
  const header = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!header.includes("%PDF-")) throw new Error(`${basename(path)} is not a PDF file.`);
}

const OUTPUT_STAMP_SUFFIX = ".meta.json";
const MAX_OUTPUT_STAMP_BYTES = 4 * 1024;

interface OutputStamp {
  sourceSha256: string;
  textSha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBoundedRegularFile(path: string, maxBytes: number, label: string): Buffer {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error(`${label} is over the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB attachment limit, so it was not read.`);
    }
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`${label} changed while being read.`);
      offset += read;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Reuse an output only when both it and its harness-written fingerprint prove
 * they came from the current source. A stale `.pdf.txt`, or one planted in a
 * race without that fingerprint, is never presented as extracted text.
 */
function isCurrentOutput(output: string, sourceSha256: string, textSha256: string): boolean {
  const stampPath = `${output}${OUTPUT_STAMP_SUFFIX}`;
  const outputExists = existsSync(output);
  const stampExists = existsSync(stampPath);
  if (!outputExists && !stampExists) return false;
  if (!outputExists || !stampExists) {
    throw new Error(`${basename(output)} already exists without a complete harness extraction stamp; it was left unchanged.`);
  }

  const outputInfo = lstatSync(output);
  const stampInfo = lstatSync(stampPath);
  if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || !stampInfo.isFile() || stampInfo.isSymbolicLink()) {
    throw new Error(`Refusing to use ${basename(output)} because its output or extraction stamp is not a regular file.`);
  }
  if (stampInfo.size > MAX_OUTPUT_STAMP_BYTES) {
    throw new Error(`Refusing to use ${basename(output)} because its extraction stamp is too large.`);
  }

  let stamp: OutputStamp;
  try {
    stamp = JSON.parse(readBoundedRegularFile(stampPath, MAX_OUTPUT_STAMP_BYTES, basename(stampPath)).toString("utf8")) as OutputStamp;
  } catch {
    throw new Error(`Refusing to use ${basename(output)} because its extraction stamp is invalid.`);
  }
  if (
    stamp.sourceSha256 === sourceSha256 &&
    stamp.textSha256 === textSha256 &&
    sha256(readBoundedRegularFile(output, MAX_ATTACHMENT_BYTES, basename(output))) === textSha256
  ) {
    return true;
  }
  throw new Error(`${basename(output)} does not match the current PDF extraction and was left unchanged.`);
}

/**
 * Extract one staged PDF. The source is never changed and any existing output
 * is left untouched, making repeated connector calls idempotent and avoiding
 * an overwrite primitive.
 */
export async function extractLocalPdf(
  ctx: LocalPdfContext,
  rawPath: string,
  format: LocalPdfFormat = "txt",
): Promise<LocalPdfExtraction> {
  const sourcePath = sourcePdfPath(ctx, rawPath);
  const sourceInfo = lstatSync(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("The PDF source changed into a non-regular file, so it was refused.");
  }
  if (sourceInfo.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${basename(sourcePath)} is over the ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)} MiB attachment limit, so it was not read.`);
  }
  if (sourceInfo.size === 0) throw new Error(`${basename(sourcePath)} is empty.`);

  // Open and size-check the exact inode before allocating. `readFile` after a
  // separate stat would let a concurrently growing connector file allocate
  // beyond the attachment cap.
  const bytes = readBoundedRegularFile(sourcePath, MAX_ATTACHMENT_BYTES, basename(sourcePath));
  assertPdfBytes(bytes, sourcePath);

  const extraction = await extractText(bytes, { filename: basename(sourcePath), mimeType: "application/pdf" });
  const output = `${sourcePath}.${format}`;
  const text = Buffer.from(`${extraction.text}\n`, "utf8");
  const sourceSha256 = sha256(bytes);
  const textSha256 = sha256(text);
  if (isCurrentOutput(output, sourceSha256, textSha256)) {
    return { sourcePath, textPath: output, bytes: bytes.length, extraction, reused: true };
  }

  const stampPath = `${output}${OUTPUT_STAMP_SUFFIX}`;
  const stamp = JSON.stringify({ sourceSha256, textSha256 } satisfies OutputStamp);
  try {
    // Write the provenance first, then use exclusive creation for the text.
    // Either race leaves an incomplete pair that is refused rather than trusted.
    writeFileSync(stampPath, stamp, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    writeFileSync(output, text, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && isCurrentOutput(output, sourceSha256, textSha256)) {
      return { sourcePath, textPath: output, bytes: bytes.length, extraction, reused: true };
    }
    throw error;
  }
  return { sourcePath, textPath: output, bytes: bytes.length, extraction, reused: false };
}

/** Snapshot every direct regular PDF; connector attachment directories are flat. */
export function snapshotAttachmentPdfs(ctx: LocalPdfContext): PdfAttachmentSnapshot[] {
  let root: string;
  try {
    root = attachmentRoot(ctx.attachmentDir);
  } catch {
    return [];
  }

  try {
    const entries: PdfAttachmentSnapshot[] = [];
    const dir = opendirSync(root);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (!entry.name.toLowerCase().endsWith(".pdf")) continue;
        const path = resolve(root, entry.name);
        try {
          const info = lstatSync(path);
          if (info.isFile() && !info.isSymbolicLink()) entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // A connector may remove a file during its own cleanup; it is simply
          // not a staged PDF for this result.
        }
      }
    } finally {
      dir.closeSync();
    }
    return entries;
  } catch {
    return [];
  }
}

export function changedAttachmentPdfs(
  ctx: LocalPdfContext,
  before: PdfAttachmentSnapshot[],
): PdfAttachmentSnapshot[] {
  const known = new Map(before.map((entry) => [entry.path, `${entry.size}:${entry.mtimeMs}`]));
  return snapshotAttachmentPdfs(ctx).filter((entry) => known.get(entry.path) !== `${entry.size}:${entry.mtimeMs}`);
}

function relativePath(ctx: LocalPdfContext, path: string): string {
  const out = relative(ctx.workspace, path);
  return out || basename(path);
}

export function createLocalPdfTools(ctx: LocalPdfContext): ToolDefinition[] {
  const extract = defineTool({
    name: "extract_local_pdf",
    label: "Extract a staged PDF",
    description:
      "Convert a PDF that a connector saved in this channel's attachments directory into plain text or Markdown beside it. " +
      "The source must be a regular .pdf inside attachments; arbitrary local paths, symlinks, and files over the 12 MiB attachment limit are refused. " +
      "The original PDF is preserved and the output is the same filename plus .txt or .md.",
    parameters: Type.Object({
      path: Type.String({ description: "The connector-returned PDF path, normally attachments/receipt.pdf." }),
      format: Type.Optional(Type.Union([Type.Literal("txt"), Type.Literal("md")], { description: "Output extension. Defaults to txt." })),
    }),
    execute: async (_id, params: { path: string; format?: LocalPdfFormat }): Promise<AgentToolResult<Record<string, never>>> => {
      const result = await extractLocalPdf(ctx, params.path, params.format ?? "txt");
      const textPath = relativePath(ctx, result.textPath);
      if (result.reused) {
        return {
          content: [{ type: "text", text: `Text was already staged at ${textPath}; it was left unchanged.` }],
          details: {},
        };
      }
      return {
        content: [{
          type: "text",
          text:
            `Extracted ${relativePath(ctx, result.sourcePath)} to ${textPath} ` +
            `(${result.extraction.text.length.toLocaleString()} characters via ${result.extraction.via}).` +
            (result.extraction.approximate ? " The extraction is approximate; layout may be lost." : "") +
            (result.extraction.truncated ? " The extraction reached the document text limit; the end is missing." : ""),
        }],
        details: {},
      };
    },
  });
  return [extract] as ToolDefinition[];
}
