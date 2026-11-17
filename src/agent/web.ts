import { lookup } from "node:dns/promises";
import { open, stat, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, parse, relative, resolve } from "node:path";
import { Agent } from "undici";

/**
 * Reading the internet, without a shell.
 *
 * Until now the only way out of the box was `bash` in a sandbox with
 * `network: bridge` — which meant that the ordinary case, "someone pasted a
 * link" or "has that firmware shipped yet", was answerable only in the one
 * channel trusted with a shell. Every other channel had to guess or say no.
 *
 * So fetching is a harness tool rather than a shell command. That makes it
 * something the harness can actually bound:
 *
 * - **GET only, text only.** No method argument, no body, no credentials. It
 *   reads pages; it cannot post a form or drive an API.
 * - **Private addresses are refused.** This box sits on a home LAN. Without
 *   this, "summarise http://192.168.1.1/" is a router admin page read out into
 *   Slack, and the redirect chain is the interesting attack, not the first URL.
 *   Every hop is re-resolved and re-checked.
 * - **Bounded.** Byte cap while reading, character cap on what reaches the
 *   model, and a timeout — a page is someone's token budget.
 *
 * What it is not: a browser. No JavaScript runs, so a site that renders itself
 * client-side arrives close to empty, and the tool says so rather than
 * pretending the page was blank.
 */

export interface WebPolicy {
  /** Stop reading the response body past this many bytes. */
  maxBytes: number;
  /** Trim the extracted text to this many characters before the model sees it. */
  maxChars: number;
  /** Refuse a URL download whose body exceeds this many bytes. */
  downloadMaxBytes: number;
  timeoutSeconds: number;
  maxRedirects: number;
  /** Empty means "any public host". Entries match a host and its subdomains. */
  allowHosts: string[];
  blockHosts: string[];
  /** Let the agent reach RFC1918/loopback addresses. Off by default. */
  allowPrivateHosts: boolean;
  userAgent: string;
}

export interface FetchedPage {
  /** The URL that actually answered, after redirects. */
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  /** True if the byte cap or the character cap cut the content short. */
  truncated: boolean;
  bytes: number;
}

/** Injection points so the whole path is testable without a network. */
export interface WebDeps {
  fetchImpl?: typeof fetch;
  /** Resolve a hostname to every address it has. */
  resolveHost?: (host: string) => Promise<string[]>;
}

/** Raised for anything the policy refuses, as opposed to a network failure. */
export class WebPolicyError extends Error {}

// --- Address checks --------------------------------------------------------

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: refuse rather than guess
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 and TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved, incl. broadcast
  return false;
}

/** Expand an IPv6 address to its eight 16-bit groups. Undefined if malformed. */
function ipv6Groups(address: string): number[] | undefined {
  const [head, tail, ...rest] = address.toLowerCase().split("::");
  if (rest.length > 0 || head === undefined) return undefined;

  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((h) => Number.parseInt(h, 16));

  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];

  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return undefined;
  }
  return groups;
}

/**
 * Whether an address is one the agent has no business reaching: loopback, the
 * LAN this harness is sitting on, link-local (which is how cloud metadata
 * services are reached), and the various reserved ranges.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return ipv4Private(address);
  if (version !== 6) return true; // not an address at all

  // IPv4-mapped ("::ffff:10.0.0.1") is a v4 destination wearing a v6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return ipv4Private(mapped[1]!);

  const groups = ipv6Groups(address);
  if (!groups) return true;

  const [first] = groups as [number, ...number[]];
  if (groups.every((g, i) => (i === 7 ? g === 0 || g === 1 : g === 0))) return true; // :: and ::1
  if ((first & 0xfe00) === 0xfc00) return true; // unique local
  if ((first & 0xffc0) === 0xfe80) return true; // link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
      groups[4] === 0 && groups[5] === 0xffff) {
    // ::ffff:a.b.c.d written in hex
    const a = (groups[6]! >> 8) & 0xff;
    const b = groups[6]! & 0xff;
    const c = (groups[7]! >> 8) & 0xff;
    const d = groups[7]! & 0xff;
    return ipv4Private(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

/** A host matches a pattern exactly, or as one of its subdomains. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().replace(/^\*?\./, "").replace(/\.$/, "");
  if (!p) return false;
  return h === p || h.endsWith(`.${p}`);
}

// --- Text extraction -------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  eacute: "é",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML to something worth spending tokens on.
 *
 * Deliberately regex-based rather than a parser dependency: this runs on a Pi,
 * and the job is "readable prose out of a page", not a faithful DOM. Chrome
 * and readability.js are the alternatives and both cost more than the feature.
 */
export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).replace(/\s+/g, " ").trim() : undefined;

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Prefer the part of the page that is the page. Falling back to the whole
  // document matters more than getting this right: a wrong guess that drops
  // the article is worse than some navigation chrome surviving.
  const main =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body) ??
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body) ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body);
  if (main?.[1]) body = main[1];

  const text = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|tr|h[1-6]|blockquote|pre)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ");

  return {
    ...(title ? { title } : {}),
    text: tidy(decodeEntities(text)),
  };
}

/** Collapse the whitespace an HTML strip leaves behind. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Fetching --------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Content types worth handing to a language model. Anything else is refused by
 * name, so the agent says "that is a PDF, I can't read it here" rather than
 * relaying a screenful of binary.
 */
function textKind(contentType: string): "html" | "text" | undefined {
  const ct = contentType.toLowerCase();
  if (ct.includes("html") || ct.includes("xhtml")) return "html";
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("csv")) {
    return "text";
  }
  return undefined;
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebPolicyError(
      `"${raw}" is not a URL. Give a full address including https://.`,
    );
  }
  if (url.username || url.password) {
    throw new WebPolicyError("URLs containing a username or password are not allowed.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebPolicyError(
      `${url.protocol} is not something I can fetch — only http and https.`,
    );
  }
  return url;
}

/**
 * Apply the URL policy and return the addresses the connection is allowed to
 * use.  Resolving is deliberately part of this step even when private hosts
 * are allowed: the transport must be pinned to this answer rather than doing a
 * second, potentially different DNS lookup.
 */
async function reachableAddresses(
  url: URL,
  policy: WebPolicy,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (policy.blockHosts.some((p) => hostMatches(host, p))) {
    throw new WebPolicyError(`${host} is on this channel's blocked list.`);
  }
  if (policy.allowHosts.length > 0 && !policy.allowHosts.some((p) => hostMatches(host, p))) {
    throw new WebPolicyError(
      `${host} is not on this channel's allowed list (${policy.allowHosts.join(", ")}).`,
    );
  }

  // A literal address needs no lookup; a name does. The returned addresses are
  // also handed to the connector below, so this is the only DNS answer used.
  const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => {
    throw new WebPolicyError(`${host} does not resolve.`);
  });

  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    throw new WebPolicyError(`${host} does not resolve.`);
  }
  if (!policy.allowPrivateHosts) {
    const priv = addresses.find((address) => isPrivateAddress(address));
    if (priv) {
      throw new WebPolicyError(
        `${host} resolves to ${priv}, a private or loopback address. ` +
          "I only fetch public internet addresses; set `web.allowPrivateHosts: true` " +
          "in this channel's config to reach things on your own network.",
      );
    }
  }
  return addresses;
}

/**
 * Create an Undici dispatcher whose connector can use only policy-validated
 * addresses. The request URL remains hostname-based, so HTTP Host and TLS SNI
 * retain the original hostname while the socket itself is DNS-rebinding safe.
 */
function pinnedDispatcher(addresses: string[]): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined;
        const matchingFamily = addresses.filter((candidate) =>
          requestedFamily === undefined || isIP(candidate) === requestedFamily,
        );
        const selected = matchingFamily.length > 0 ? matchingFamily : addresses;
        // Node 26's family autoselection asks lookup() for all candidates. It
        // requires `{ address, family }[]` in that case, not the ordinary
        // `(address, family)` callback form.
        if (options.all) {
          callback(null, selected.map((address) => ({ address, family: isIP(address) })));
          return;
        }
        const address = selected[0]!;
        callback(null, address, isIP(address));
      },
    },
  });
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    // Test doubles and some runtimes hand back a plain body.
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    return bytes > maxBytes
      ? { text: text.slice(0, maxBytes), bytes: maxBytes, truncated: true }
      : { text, bytes, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), bytes, truncated };
}

/** A successful response after every redirect hop has passed the URL policy. */
interface OpenedUrl {
  url: string;
  response: Response;
  contentType: string;
  /** Cancels an unread body and releases the one-hop pinned dispatcher. */
  close(): Promise<void>;
}

/**
 * Open a public URL, following redirects manually. Both text reading and file
 * downloads go through this one path so a binary download cannot quietly gain
 * a less strict redirect or SSRF policy than `fetch_url`.
 */
async function openUrl(
  rawUrl: string,
  policy: WebPolicy,
  deps: WebDeps,
  accept: string,
): Promise<OpenedUrl> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost =
    deps.resolveHost ??
    (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));

  let url = parseUrl(rawUrl);
  // One deadline for the whole call, not one per hop: a chain of redirects
  // should not be able to spend the timeout several times over.
  const signal = AbortSignal.timeout(policy.timeoutSeconds * 1000);

  for (let hop = 0; ; hop++) {
    const dispatcher = pinnedDispatcher(await reachableAddresses(url, policy, resolveHost));
    let response: Response;
    const close = async (): Promise<void> => {
      // A redirect and a refused content type may leave a body unread. Cancel
      // it, then destroy this one-hop-only agent so a peer cannot keep a socket
      // open beyond the request's deadline.
      await response?.body?.cancel().catch(() => {});
      await dispatcher.destroy().catch(() => {});
    };

    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: {
          "user-agent": policy.userAgent,
          accept,
          "accept-language": "en",
        },
        // `dispatcher` is Undici's extension to the Fetch API. Keeping the URL
        // hostname here preserves Host/SNI; the dispatcher's lookup pins only
        // the TCP destination to the address validated above.
        dispatcher,
      } as unknown as RequestInit);
    } catch (err) {
      await dispatcher.destroy().catch(() => {});
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        detail.toLowerCase().includes("abort") || detail.toLowerCase().includes("timeout")
          ? `${url.hostname} did not answer within ${policy.timeoutSeconds}s.`
          : `Could not reach ${url.hostname}: ${detail}`,
      );
    }

    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        await close();
        throw new Error(`${url.href} returned ${response.status} with no destination.`);
      }
      if (hop >= policy.maxRedirects) {
        await close();
        throw new WebPolicyError(`${rawUrl} redirected more than ${policy.maxRedirects} times.`);
      }
      await close();
      url = parseUrl(new URL(location, url).href);
      continue;
    }

    if (!response.ok) {
      await close();
      throw new Error(
        `${url.href} returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
      );
    }

    return {
      url: url.href,
      response,
      contentType: response.headers.get("content-type") ?? "",
      close,
    };
  }
}

/**
 * Fetch one text page. Binary content intentionally remains refused here;
 * callers that need a PDF or other document should use `downloadUrl` instead.
 */
export async function fetchPage(
  rawUrl: string,
  policy: WebPolicy,
  deps: WebDeps = {},
): Promise<FetchedPage> {
  const opened = await openUrl(
    rawUrl,
    policy,
    deps,
    "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
  );
  try {
    const kind = textKind(opened.contentType);
    if (!kind) {
      throw new WebPolicyError(
        `${opened.url} is ${opened.contentType.split(";")[0] || "not text"}, which I cannot read as text. ` +
          "I fetch web pages, not binaries — PDFs, images and archives need something else.",
      );
    }

    const { text: raw, bytes, truncated: cutByBytes } = await readCapped(opened.response, policy.maxBytes);
    const extracted = kind === "html" ? htmlToText(raw) : { text: tidy(raw) };
    const overLength = extracted.text.length > policy.maxChars;
    return {
      url: opened.url,
      status: opened.response.status,
      contentType: opened.contentType,
      ...(extracted.title ? { title: extracted.title } : {}),
      text: overLength ? extracted.text.slice(0, policy.maxChars) : extracted.text,
      truncated: cutByBytes || overLength,
      bytes,
    };
  } finally {
    await opened.close();
  }
}

export interface DownloadedFile {
  /** Final URL after policy-checked redirects. */
  url: string;
  /** Absolute staged path, always directly in the supplied workspace. */
  path: string;
  filename: string;
  contentType: string;
  bytes: number;
}

/** Turn URL/header/user input into one harmless filename component. */
export function sanitizeDownloadFilename(candidate: string | undefined): string {
  const cleaned = (candidate ?? "")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  // RFC 5987 takes precedence when present: filename*=UTF-8''manual%20v2.pdf.
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ""));
    } catch {
      // A malformed header is untrusted metadata, not a failed download.
    }
  }
  return /(?:^|;)\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/i.exec(header)?.[1]
    ?.trim()
    .replace(/^"|"$/g, "");
}

function filenameFromUrl(url: string): string | undefined {
  const leaf = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (!leaf) return undefined;
  try {
    return decodeURIComponent(leaf);
  } catch {
    return leaf;
  }
}

function suffixedFilename(filename: string, index: number): string {
  if (index === 0) return filename;
  const parsed = parse(filename);
  return `${parsed.name || "download"}-${index + 1}${parsed.ext}`;
}

async function reserveDownloadPath(workspace: string, filename: string): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  const root = resolve(workspace);
  const workspaceStat = await stat(root).catch(() => undefined);
  if (!workspaceStat?.isDirectory()) throw new Error("The channel workspace is unavailable for downloads.");

  // The name has no path separators, and resolving it must still land directly
  // below the workspace. `wx` makes a race with an existing file safe: neither
  // a prior download nor an agent-created file is ever overwritten.
  for (let index = 0; index < 1_000; index++) {
    const path = resolve(root, suffixedFilename(filename, index));
    const relation = relative(root, path);
    if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
      throw new Error("Refusing to write a download outside the workspace.");
    }
    try {
      return { path, handle: await open(path, "wx", 0o600) };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find an unused filename for ${filename} in the channel workspace.`);
}

/** The part of a file handle a streamed download needs. */
export interface DownloadWriter {
  write(data: Uint8Array): Promise<{ bytesWritten: number }>;
}

/** Write every byte of a chunk: file-system writes are allowed to be short. */
export async function writeAll(
  writer: DownloadWriter,
  chunk: Uint8Array,
): Promise<number> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const remaining = chunk.byteLength - offset;
    const { bytesWritten } = await writer.write(chunk.subarray(offset));
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error("Could not write the complete download to the workspace.");
    }
    offset += bytesWritten;
  }
  return offset;
}

async function writeDownloadBody(
  response: Response,
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<number> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebPolicyError(`The download is ${declared} bytes, over this channel's ${maxBytes}-byte download limit.`);
  }

  const body = response.body;
  let bytes = 0;
  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    if (chunk.byteLength > maxBytes - bytes) {
      throw new WebPolicyError(`The download exceeds this channel's ${maxBytes}-byte download limit.`);
    }
    bytes += await writeAll(handle, chunk);
  };

  if (!body || typeof body.getReader !== "function") {
    await writeChunk(new Uint8Array(await response.arrayBuffer()));
    return bytes;
  }

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes;
      if (value) await writeChunk(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Download an arbitrary public HTTP(S) body into the calling channel's
 * workspace. This deliberately stages bytes only — it does not parse or hand
 * untrusted binary content to the model.
 */
export async function downloadUrl(
  rawUrl: string,
  workspace: string,
  policy: WebPolicy,
  options: { filename?: string; deps?: WebDeps } = {},
): Promise<DownloadedFile> {
  const opened = await openUrl(rawUrl, policy, options.deps ?? {}, "*/*");
  try {
    const filename = sanitizeDownloadFilename(
      options.filename || filenameFromContentDisposition(opened.response.headers.get("content-disposition")) || filenameFromUrl(opened.url),
    );
    const reserved = await reserveDownloadPath(workspace, filename);
    try {
      const bytes = await writeDownloadBody(opened.response, reserved.handle, policy.downloadMaxBytes);
      await reserved.handle.close();
      return {
        url: opened.url,
        path: reserved.path,
        filename: basename(reserved.path),
        contentType: opened.contentType || "application/octet-stream",
        bytes,
      };
    } catch (err) {
      await reserved.handle.close().catch(() => {});
      // The file descriptor above was created with `wx`; this only removes a
      // partial file we created inside the workspace, never an existing target.
      await unlink(reserved.path).catch(() => {});
      throw err;
    }
  } finally {
    await opened.close();
  }
}

// --- Search ----------------------------------------------------------------

export type SearchProvider = "none" | "brave" | "tavily" | "searxng";

export interface SearchConfig {
  provider: SearchProvider;
  apiKey: string;
  /** Base URL for a self-hosted provider (SearXNG). */
  url: string;
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

function requireKey(cfg: SearchConfig, name: string): string {
  if (!cfg.apiKey) {
    throw new WebPolicyError(
      `Search is configured to use ${name} but no API key is set. ` +
        "An operator needs to set `web.search.apiKey` in the harness config.",
    );
  }
  return cfg.apiKey;
}

/**
 * Search, through whichever backend the operator configured.
 *
 * There is no default provider on purpose. Every real search API needs a key,
 * and the keyless alternative is scraping someone's results page — fragile, and
 * not something to do on a user's behalf without them choosing it. SearXNG is
 * here because a self-hosted instance fits a harness that already runs on your
 * own hardware.
 */
export async function searchWeb(
  query: string,
  cfg: SearchConfig,
  deps: WebDeps = {},
): Promise<SearchResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const count = Math.max(1, Math.min(cfg.maxResults, 20));
  const signal = AbortSignal.timeout(20_000);

  const request = async (url: string, init?: RequestInit): Promise<any> => {
    const res = await fetchImpl(url, { signal, ...init });
    if (!res.ok) {
      throw new Error(
        `${cfg.provider} search failed: ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`,
      );
    }
    return await res.json();
  };

  switch (cfg.provider) {
    case "brave": {
      const body = await request(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        {
          headers: {
            accept: "application/json",
            "x-subscription-token": requireKey(cfg, "Brave"),
          },
        },
      );
      return (body?.web?.results ?? [])
        .slice(0, count)
        .map((r: any) => ({
          title: String(r.title ?? r.url ?? ""),
          url: String(r.url ?? ""),
          ...(r.description ? { snippet: tidy(htmlToText(String(r.description)).text) } : {}),
        }))
        .filter((r: SearchResult) => r.url);
    }

    case "tavily": {
      const body = await request("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${requireKey(cfg, "Tavily")}`,
        },
        body: JSON.stringify({ query, max_results: count }),
      });
      return (body?.results ?? [])
        .slice(0, count)
        .map((r: any) => ({
          title: String(r.title ?? r.url ?? ""),
          url: String(r.url ?? ""),
          ...(r.content ? { snippet: tidy(String(r.content)) } : {}),
        }))
        .filter((r: SearchResult) => r.url);
    }

    case "searxng": {
      if (!cfg.url) {
        throw new WebPolicyError(
          "Search is configured to use SearXNG but no instance URL is set. " +
            "An operator needs to set `web.search.url` in the harness config.",
        );
      }
      const base = cfg.url.replace(/\/+$/, "");
      const body = await request(
        `${base}/search?q=${encodeURIComponent(query)}&format=json`,
        { headers: { accept: "application/json" } },
      );
      return (body?.results ?? [])
        .slice(0, count)
        .map((r: any) => ({
          title: String(r.title ?? r.url ?? ""),
          url: String(r.url ?? ""),
          ...(r.content ? { snippet: tidy(String(r.content)) } : {}),
        }))
        .filter((r: SearchResult) => r.url);
    }

    default:
      throw new WebPolicyError(
        "No search provider is configured for this harness, so I can only open URLs I am given. " +
          "An operator can set `web.search.provider` in the config.",
      );
  }
}
