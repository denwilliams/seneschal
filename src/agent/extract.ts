import { spawnSync } from "node:child_process";
import { inflateRawSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { decodeEntities, htmlToText, tidy } from "./web.ts";

/**
 * Getting words out of a file somebody attached.
 *
 * A document library is only as good as this module: everything downstream —
 * the summary, the categories, the search — is written against the text that
 * comes out of here, so a PDF that extracts as mojibake is a document that is
 * indexed as mojibake and found by nobody.
 *
 * Three rules follow from that.
 *
 * - **Keep heavyweight converters out.** `libreoffice --convert-to` is a
 *   JVM-sized answer to reading a memo. Office documents are still unzipped
 *   and stripped in-process.
 * - **Use the best PDF reader available.** `pdftotext` (poppler) is used first
 *   when the host has it; otherwise bundled pdf.js handles normal text PDFs
 *   and font maps. The tiny scanner below is the last fallback, not the plan.
 * - **Fail loudly and usefully.** A scanned page has no text in it, and no
 *   amount of parsing invents any. `UnreadableFile` says which case it is and
 *   what the person could do instead, so the agent can pass that on rather than
 *   summarising a screenful of glyph ids.
 */

export type ExtractionMethod = "text" | "html" | "pdftotext" | "pdfjs" | "pdf" | "docx" | "pptx";

export interface Extraction {
  text: string;
  via: ExtractionMethod;
  /**
   * True when the text is a best-effort reconstruction rather than what the
   * file says. Everything downstream should say so: a summary drawn from an
   * approximate extraction can be wrong in ways the reader cannot see.
   */
  approximate: boolean;
  truncated: boolean;
}

/** Thrown when the file is understood well enough to know it cannot be read. */
export class UnreadableFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableFile";
  }
}

/** Beyond this a "document" is a data dump, and the tail is never read. */
export const DEFAULT_MAX_CHARS = 300_000;

type Kind = "text" | "html" | "pdf" | "docx" | "pptx" | "unknown";

/** Extensions read as plain text. Anything textual a person might attach. */
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "rst", "adoc", "org",
  "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "log", "diff", "patch", "sql", "graphql", "srt", "vtt",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "lua", "r", "pl",
  "css", "scss", "tf", "tfvars", "dockerfile", "makefile", "gradle", "properties",
]);

const KIND_BY_EXTENSION: Record<string, Kind> = {
  pdf: "pdf",
  docx: "docx",
  docm: "docx",
  pptx: "pptx",
  pptm: "pptx",
  html: "html",
  htm: "html",
  xhtml: "html",
  xml: "text",
};

const KIND_BY_MIME: Record<string, Kind> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/html": "html",
  "application/xhtml+xml": "html",
};

export function fileExtension(filename?: string): string {
  const base = (filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
}

function kindOf(filename?: string, mimeType?: string): Kind {
  const ext = fileExtension(filename);
  const byExt = KIND_BY_EXTENSION[ext];
  if (byExt) return byExt;
  if (TEXT_EXTENSIONS.has(ext)) return "text";

  const mime = (mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const byMime = KIND_BY_MIME[mime];
  if (byMime) return byMime;
  if (mime.startsWith("text/")) return "text";
  if (/(json|xml|yaml|csv|javascript|x-sh|x-python|x-httpd)/.test(mime)) return "text";

  return "unknown";
}

/**
 * Whether this is worth downloading at all.
 *
 * Asked before the bytes are fetched, so a 200MB video is refused by name
 * rather than by pulling it over a home uplink first.
 */
export function canExtract(filename?: string, mimeType?: string): boolean {
  return kindOf(filename, mimeType) !== "unknown";
}

/** What to tell someone who attached something nothing here can open. */
export function unsupportedReason(filename?: string, mimeType?: string): string {
  const ext = fileExtension(filename);
  const mime = (mimeType ?? "").toLowerCase();
  const name = filename ?? "that file";

  if (["doc", "ppt", "xls"].includes(ext)) {
    return `${name} is in the old binary Office format, which I cannot open. Save it as .${ext}x, or export it to PDF, and attach that.`;
  }
  if (["xlsx", "xlsm", "ods", "numbers"].includes(ext)) {
    return `${name} is a spreadsheet. Export the sheet as CSV and attach that — a CSV I can read, and it indexes far better than a grid of formulas.`;
  }
  if (mime.startsWith("image/")) {
    return `${name} is an image. I can look at images in the conversation, but the document library stores text, so there is nothing to index here.`;
  }
  if (mime.startsWith("audio/") || mime.startsWith("video/")) {
    return `${name} is ${mime.startsWith("audio/") ? "audio" : "video"}. There is no transcription here, so I cannot read it.`;
  }
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)) {
    return `${name} is an archive. Attach the documents inside it individually.`;
  }
  return `I cannot read ${name} (${mimeType || ext || "unknown type"}). I can read plain text, Markdown, CSV, JSON, HTML, PDF, .docx and .pptx.`;
}

export interface ExtractOptions {
  filename?: string;
  mimeType?: string;
  maxChars?: number;
  /**
   * Use a converter from the host when one is installed (`pdftotext`).
   * Defaults to true.
   */
  external?: boolean;
  /**
   * Use the bundled pdf.js reader for PDFs. Defaults to true; tests set this
   * false when they are measuring the tiny built-in fallback specifically.
   */
  pdfjs?: boolean;
}

export async function extractText(bytes: Uint8Array, opts: ExtractOptions = {}): Promise<Extraction> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const kind = kindOf(opts.filename, opts.mimeType);
  const name = opts.filename ?? "the file";

  if (bytes.length === 0) throw new UnreadableFile(`${name} is empty.`);

  const done = (text: string, via: ExtractionMethod, approximate = false): Extraction => {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new UnreadableFile(
        `${name} has no readable text in it. If it is a scan, there is no OCR here — paste the part that matters instead.`,
      );
    }
    return {
      text: trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed,
      via,
      approximate,
      truncated: trimmed.length > maxChars,
    };
  };

  switch (kind) {
    case "text":
      return done(decodeTextFile(bytes, name), "text");
    case "html":
      return done(htmlToText(decodeTextFile(bytes, name)).text, "html");
    case "pdf": {
      const external = opts.external === false ? undefined : viaPdftotext(bytes);
      if (external) return done(external, "pdftotext");
      const pdfjs = opts.pdfjs === false ? undefined : await viaPdfjs(bytes);
      if (pdfjs) return done(pdfjs, "pdfjs");
      return done(extractPdf(bytes, name), "pdf", true);
    }
    case "docx":
      return done(extractDocx(bytes, name), "docx");
    case "pptx":
      return done(extractPptx(bytes, name), "pptx");
    default:
      throw new UnreadableFile(unsupportedReason(opts.filename, opts.mimeType));
  }
}

// --- Plain text -------------------------------------------------------------

function decodeTextFile(bytes: Uint8Array, name: string): string {
  // A NUL in the first few KB is the cheapest reliable "this is not text"
  // there is, and it stops a mislabelled binary being indexed as prose.
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new UnreadableFile(
      `${name} says it is text but contains binary data, so I cannot read it as a document.`,
    );
  }
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\ufeff/, "");
  return text.replace(/\r\n?/g, "\n");
}

// --- PDF --------------------------------------------------------------------

let pdftotext: boolean | undefined;

/** Whether poppler's `pdftotext` is on PATH. Checked once per process. */
export function hasPdftotext(): boolean {
  if (pdftotext === undefined) {
    try {
      pdftotext = spawnSync("pdftotext", ["-v"], { timeout: 5_000 }).status === 0;
    } catch {
      pdftotext = false;
    }
  }
  return pdftotext;
}

function viaPdftotext(bytes: Uint8Array): string | undefined {
  if (!hasPdftotext()) return undefined;
  try {
    const res = spawnSync("pdftotext", ["-q", "-enc", "UTF-8", "-", "-"], {
      input: Buffer.from(bytes),
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    if (res.status !== 0 || !res.stdout) return undefined;
    const text = tidy(res.stdout.toString("utf-8"));
    return text.length > 0 ? text : undefined;
  } catch {
    // Falling through to pdf.js and then the built-in scanner is strictly
    // better than failing: poppler being absent, old, or unhappy is not the
    // document's fault.
    return undefined;
  }
}

/**
 * Bundled PDF text extraction. pdf.js understands ToUnicode maps and embedded
 * font encodings that the tiny fallback below deliberately does not implement.
 * It is not OCR: scanned pages still have no text to extract.
 */
const PDFJS_BASE = new URL("../../node_modules/pdfjs-dist/", import.meta.url);

async function viaPdfjs(bytes: Uint8Array): Promise<string | undefined> {
  try {
    // pdf.js may transfer/detach the input buffer, so hand it a copy rather
    // than the caller's bytes. That keeps the final built-in fallback possible.
    const task = getDocument({
      data: new Uint8Array(bytes),
      cMapPacked: true,
      cMapUrl: `${fileURLToPath(new URL("cmaps/", PDFJS_BASE))}/`,
      standardFontDataUrl: `${fileURLToPath(new URL("standard_fonts/", PDFJS_BASE))}/`,
    });
    const pdf = await task.promise;
    try {
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const out: string[] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          out.push(item.str);
          if (item.hasEOL) out.push("\n");
          else out.push(" ");
        }
        const pageText = tidy(out.join(""));
        if (pageText) pages.push(pageText);
        page.cleanup();
      }
      const text = tidy(pages.join("\n\n"));
      return text.length > 0 ? text : undefined;
    } finally {
      await task.destroy();
    }
  } catch {
    return undefined;
  }
}

/**
 * Best-effort PDF text, with no font handling at all.
 *
 * A PDF's content streams are PostScript-ish drawing instructions; the text is
 * in the operands of the text-showing operators. Pulling those out gets you the
 * words for any PDF whose fonts use a byte-per-character encoding, which is
 * most PDFs produced by a word processor. It gets you glyph ids for anything
 * using Identity-H (subset-embedded fonts), which is why the result is checked
 * before it is returned: garbage that looks like text is worse than an error.
 */
function extractPdf(bytes: Uint8Array, name: string): string {
  const streams = pdfContentStreams(bytes);
  if (streams.length === 0) {
    throw new UnreadableFile(
      `I could not find any text in ${name}. It is most likely a scan — an image of a page — and there is no OCR here.`,
    );
  }

  const text = tidy(streams.map(textFromContentStream).join("\n"));
  if (!looksLikeProse(text)) {
    throw new UnreadableFile(
      `I could not decode the text in ${name}${hasPdftotext() ? "" : " (no \`pdftotext\` on this host)"}. ` +
        "Its fonts use an encoding I cannot map back to characters, which is common in PDFs exported from design tools. " +
        "Paste the part that matters, or attach a text or Word version.",
    );
  }
  return text;
}

/** Every content stream in the file, inflated, in file order. */
function pdfContentStreams(bytes: Uint8Array): string[] {
  const binary = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];

  let pos = 0;
  while (pos < binary.length) {
    const at = binary.indexOf("stream", pos);
    if (at === -1) break;
    pos = at + 6;
    if (binary.slice(at - 3, at) === "end") continue; // the tail of "endstream"

    // The keyword is followed by CRLF or LF, and the bytes start after it.
    let start = at + 6;
    if (binary[start] === "\r") start++;
    if (binary[start] === "\n") start++;

    const end = binary.indexOf("endstream", start);
    if (end === -1) break;
    pos = end + 9;

    const dict = binary.slice(Math.max(0, at - 900), at);
    // Images are the bulk of a PDF's bytes and none of its words.
    if (/\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict)) continue;

    const raw = Buffer.from(binary.slice(start, end), "latin1");
    let decoded: string | undefined;
    if (/\/FlateDecode/.test(dict)) {
      try {
        decoded = inflateSync(raw).toString("latin1");
      } catch {
        // Truncated or predictor-encoded; nothing to be done about it here.
      }
    } else if (!/\/Filter/.test(dict)) {
      decoded = raw.toString("latin1");
    }

    // Fonts, metadata and object streams inflate happily and contain no words.
    if (decoded && /\bBT\b|\bTj\b|\bTJ\b/.test(decoded)) out.push(decoded);
  }

  return out;
}

type Operand = { kind: "string"; value: string } | { kind: "number"; value: number };

/**
 * The words in one content stream.
 *
 * Only the text-showing and text-positioning operators matter. Positioning
 * becomes a newline, which is wrong in detail — a generator that kerns with
 * `Td` will break a line mid-word — and right in aggregate, which is the deal
 * this whole function makes.
 */
function textFromContentStream(content: string): string {
  let out = "";
  let operands: Operand[] = [];
  let i = 0;

  const show = (from: Operand[]): void => {
    for (const op of from) {
      if (op.kind === "string") out += op.value;
      // A big negative kern is how a PDF writes a space between two runs.
      else if (op.value <= -100) out += " ";
    }
  };

  while (i < content.length) {
    const ch = content[i]!;

    if (ch === "(") {
      const literal = readLiteralString(content, i);
      operands.push({ kind: "string", value: literal.value });
      i = literal.next;
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const close = content.indexOf(">", i);
      if (close === -1) break;
      operands.push({ kind: "string", value: decodePdfBytes(hexToBytes(content.slice(i + 1, close))) });
      i = close + 1;
      continue;
    }
    if (ch === "%") {
      const nl = content.indexOf("\n", i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (ch === "-" || ch === "+" || ch === "." || (ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < content.length && /[-+.0-9]/.test(content[j]!)) j++;
      operands.push({ kind: "number", value: Number.parseFloat(content.slice(i, j)) || 0 });
      i = j;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      let j = i;
      while (j < content.length && /[A-Za-z0-9*'"]/.test(content[j]!)) j++;
      const op = content.slice(i, j);
      i = j;

      switch (op) {
        case "Tj":
          show(operands.slice(-1));
          break;
        case "TJ":
          show(operands);
          break;
        case "'":
        case '"':
          out += "\n";
          show(operands.slice(-1));
          break;
        case "Td":
        case "TD":
        case "Tm":
        case "T*":
        case "ET":
          out += "\n";
          break;
        case "BI": {
          // An inline image's binary data would tokenise as nonsense.
          const ei = content.indexOf("EI", i);
          i = ei === -1 ? content.length : ei + 2;
          break;
        }
        default:
          break;
      }
      operands = [];
      continue;
    }
    i++;
  }

  return out;
}

/** A PDF literal string: escapes, octal, and nested parentheses. */
function readLiteralString(content: string, open: number): { value: string; next: number } {
  const bytes: number[] = [];
  let depth = 1;
  let i = open + 1;

  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "\\") {
      const next = content[i + 1];
      i += 2;
      switch (next) {
        case "n": bytes.push(10); break;
        case "r": bytes.push(13); break;
        case "t": bytes.push(9); break;
        case "b": bytes.push(8); break;
        case "f": bytes.push(12); break;
        case "\n": break;
        case "\r": if (content[i] === "\n") i++; break;
        default: {
          if (next && next >= "0" && next <= "7") {
            let octal = next;
            while (octal.length < 3 && content[i] && content[i]! >= "0" && content[i]! <= "7") {
              octal += content[i]!;
              i++;
            }
            bytes.push(Number.parseInt(octal, 8) & 0xff);
          } else if (next !== undefined) {
            bytes.push(next.charCodeAt(0) & 0xff);
          }
        }
      }
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return { value: decodePdfBytes(bytes), next: i + 1 };
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
    i++;
  }

  return { value: decodePdfBytes(bytes), next: content.length };
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(Number.parseInt(clean.slice(i, i + 2).padEnd(2, "0"), 16));
  }
  return bytes;
}

/** PDF strings are UTF-16BE when they carry the BOM, and single bytes otherwise. */
function decodePdfBytes(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
    }
    return out;
  }
  return String.fromCharCode(...bytes);
}

/**
 * Whether what came out is words rather than glyph ids.
 *
 * Identity-H text decodes to two-byte codes whose high byte is almost always
 * zero, so a failed extraction is mostly NUL and control characters. That is
 * the signal; the letter ratio is the backstop.
 */
export function looksLikeProse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 16) return false;
  const letters = (trimmed.match(/\p{L}/gu) ?? []).length;
  const control = (trimmed.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) ?? []).length;
  return control / trimmed.length < 0.02 && letters / trimmed.length >= 0.25;
}

// --- Office open XML --------------------------------------------------------

function extractDocx(bytes: Uint8Array, name: string): string {
  const parts = readZip(bytes, name, (n) => n === "word/document.xml");
  const doc = parts.get("word/document.xml");
  if (!doc) {
    throw new UnreadableFile(
      `${name} is not a Word document I can read — there is no \`word/document.xml\` inside it.`,
    );
  }
  return officeXmlToText(new TextDecoder().decode(doc));
}

function extractPptx(bytes: Uint8Array, name: string): string {
  const wanted = /^ppt\/slides\/slide(\d+)\.xml$/;
  const parts = readZip(bytes, name, (n) => wanted.test(n));
  if (parts.size === 0) {
    throw new UnreadableFile(`${name} is not a PowerPoint file I can read — it has no slides in it.`);
  }

  const slides = [...parts.entries()]
    .map(([path, data]) => ({ n: Number(wanted.exec(path)?.[1] ?? 0), data }))
    .sort((a, b) => a.n - b.n);

  // Slide numbers are kept: "it's on slide 12" is how people talk about decks,
  // and it is the only structure a deck has once it is text.
  return slides
    .map(({ n, data }) => `## Slide ${n}\n\n${officeXmlToText(new TextDecoder().decode(data))}`)
    .join("\n\n");
}

/**
 * Text out of WordprocessingML/DrawingML.
 *
 * Tag-stripping rather than XML parsing, for the same reason `htmlToText` is:
 * the job is prose, and the tags that matter are the handful that mean "line
 * ends here".
 */
function officeXmlToText(xml: string): string {
  return tidy(
    decodeEntities(
      xml
        .replace(/<(w|a):tab\b[^>]*\/?>/g, "\t")
        .replace(/<(w|a):(br|cr)\b[^>]*\/?>/g, "\n")
        .replace(/<\/(w:p|a:p|w:tr)>/g, "\n")
        .replace(/<\/(w:tc|a:tc)>/g, " | ")
        .replace(/<[^>]*>/g, ""),
    ),
  );
}

// --- A zip reader, for the two formats above --------------------------------

function u16(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, i: number): number {
  // Assembled with arithmetic rather than `<<24`, which would go negative.
  return (b[i] ?? 0) + (b[i + 1] ?? 0) * 0x100 + (b[i + 2] ?? 0) * 0x10000 + (b[i + 3] ?? 0) * 0x1000000;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The entries of a zip whose names the caller wants.
 *
 * Enough of the format to open a .docx and no more: no zip64, no encryption,
 * stored and deflated entries only. A .docx that needs more than this is one
 * whose text was going to be wrong anyway.
 */
function readZip(
  bytes: Uint8Array,
  name: string,
  wanted: (path: string) => boolean,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66_000); i--) {
    if (u32(bytes, i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new UnreadableFile(
      `${name} is not a valid ${fileExtension(name) || "zip"} file — its central directory is missing or it is truncated.`,
    );
  }

  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);

  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== CENTRAL) break;

    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const nameLength = u16(bytes, p + 28);
    const extraLength = u16(bytes, p + 30);
    const commentLength = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const path = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;

    if (!wanted(path)) continue;
    if (compressedSize === 0xffffffff || u32(bytes, localOffset) !== LOCAL) continue;

    const start = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    const raw = bytes.subarray(start, start + compressedSize);
    try {
      if (method === 0) out.set(path, raw);
      else if (method === 8) out.set(path, inflateRawSync(raw));
    } catch {
      // One unreadable part is not the whole document; a .pptx with a corrupt
      // slide should still give up the rest of the deck.
    }
  }

  return out;
}
