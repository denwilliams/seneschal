import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { AccessIdentity } from "../console/cloudflare-access.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { REPO_ROOT } from "../config/load.ts";
import { logger } from "../util/log.ts";
import { mergeBrowser } from "./merge-verification.ts";
import { handleConfigAdmin } from "./admin.ts";
import { handleSecretAdmin } from "./secrets.ts";
import { ActionLimiter, handleConsoleAction, isChannelAction, isRunAction, isTaskAction, type ActionTarget } from "./actions.ts";
import { channelOverview, findChannel } from "./data.ts";
import { ConsoleLinks } from "./links.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { ChannelResponse, TranscriptResponse } from "./api-types.ts";
import type { EventHub } from "./events.ts";
import { buildMemory } from "./memory.ts";
import { buildSession } from "./session.ts";
import { handleLists } from "./lists.ts";
import { buildState } from "./state.ts";
import { busyThreads, isDirect, nodeKind, type Console2Source } from "./source.ts";
import { buildTasks } from "./tasks.ts";
import { buildArtifacts } from "./artifacts.ts";
import { browseWorkspace, WorkspaceError } from "./workspace.ts";
import { buildFactory } from "./factory.ts";
import { buildTimeline } from "./timeline.ts";
import { buildWorkflowRun, buildWorkflows } from "./workflows.ts";
import { buildExtend, buildTools } from "./tools.ts";
import { DEFAULT_PAGE, pageEntries, transcriptEntries, unavailable, type ViewLike } from "./transcript.ts";
import { buildTree } from "./tree.ts";
import { ActivityQueryError, buildActivity } from "./activity.ts";

export const CONSOLE2_PREFIX = "/console2";
export const CONSOLE2_DIST = join(REPO_ROOT, "web", "console2", "dist");
/** The build directory. `HARNESS_CONSOLE2_DIST` is a test seam, like `HARNESS_ARTIFACT_PYTHON`. */
const consoleDist = (): string => process.env.HARNESS_CONSOLE2_DIST || CONSOLE2_DIST;

export type Console2Route =
  | { page: "app"; file: string }
  | { page: "tree" }
  | { page: "activity" }
  | { page: "identity" }
  | { page: "admin" }
  | { page: "secrets" }
  | { page: "events"; channelId?: string; threadKey?: string }
  | { page: "channel" | "session" | "tasks" | "tools" | "extend" | "memory" | "state" | "lists" | "artifacts" | "workspace" | "database" | "timeline" | "factory" | "workflows"; channelId: string }
  | { page: "workflow"; channelId: string; runId: string }
  /** A POST that acts on a run or a channel. Only when the operator turned `webConsole.actions` on. */
  | { page: "action"; target: ActionTarget }
  | { page: "thread"; channelId: string; threadKey: string };

const RUN_ID = /^[A-Za-z0-9._-]{1,100}$/;
const THREAD_KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const FILE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * `pathname` is relative to the web server's base URL. Undefined means "not a console2 path". Static files are matched
 * segment by segment against a conservative pattern, so a request path can never select a file outside the build directory.
 */
export function console2Route(pathname: string, query = new URLSearchParams()): Console2Route | undefined {
  if (pathname !== CONSOLE2_PREFIX && !pathname.startsWith(`${CONSOLE2_PREFIX}/`)) return undefined;
  const rest = pathname.slice(CONSOLE2_PREFIX.length).replace(/\/+$/, "");
  if (rest === "") return { page: "app", file: "index.html" };
  let parts: string[];
  try { parts = rest.split("/").slice(1).map(decodeURIComponent); } catch { return undefined; }
  if (parts[0] !== "api") {
    return parts.length > 0 && parts.every((part) => FILE_SEGMENT.test(part) && !part.startsWith(".")) ? { page: "app", file: parts.join("/") } : undefined;
  }
  if (parts[1] !== "v1") return undefined;
  const api = parts.slice(2);
  if (api.length === 1 && api[0] === "config") return { page: "admin" };
  if (api.length === 1 && api[0] === "secrets") return { page: "secrets" };
  if (api.length === 1 && api[0] === "identity") return { page: "identity" };
  if (api.length === 1 && api[0] === "tree") return { page: "tree" };
  if (api.length === 1 && api[0] === "activity") return { page: "activity" };
  if (api.length === 1 && api[0] === "events") {
    const channelId = query.get("channel") ?? undefined;
    const threadKey = query.get("thread") ?? undefined;
    if (threadKey && !THREAD_KEY.test(threadKey)) return undefined;
    return { page: "events", ...(channelId ? { channelId } : {}), ...(threadKey ? { threadKey } : {}) };
  }
  if (api[0] !== "channels" || !api[1]) return undefined;
  const channelId = api[1];
  if (api.length === 2) return { page: "channel", channelId };
  if (api.length === 3 && (api[2] === "session" || api[2] === "tasks" || api[2] === "tools" || api[2] === "extend" || api[2] === "memory" || api[2] === "state" || api[2] === "lists" || api[2] === "artifacts" || api[2] === "workspace" || api[2] === "database" || api[2] === "timeline" || api[2] === "factory" || api[2] === "workflows")) return { page: api[2], channelId };
  if (api.length === 4 && api[2] === "workflows" && RUN_ID.test(api[3]!)) return { page: "workflow", channelId, runId: api[3]! };
  if (api.length === 4 && api[2] === "threads" && THREAD_KEY.test(api[3]!)) return { page: "thread", channelId, threadKey: api[3]! };
  // Actions: a closed list of names. Approving and merging are not on it, so asking for them is a route that does not exist.
  if (api.length === 6 && api[2] === "workflows" && api[4] === "actions" && RUN_ID.test(api[3]!) && (api[3]!.startsWith("workflow_") ? isTaskAction(api[5]!) : isRunAction(api[5]!))) return { page: "action", target: { channelId, runId: api[3]!, action: api[5] as Extract<ActionTarget, { runId: string }>["action"] } };
  if (api.length === 4 && api[2] === "factory" && isChannelAction(api[3]!)) return { page: "action", target: { channelId, action: api[3] } };
  return undefined;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Inline `<style>` elements the UI's libraries inject, allowed by hash rather than with `'unsafe-inline'`. Radix's scroll
 * area adds one with fixed text (it hides the native scrollbar). Opening any Radix dialog (the command palette, the narrow-screen
 * panels, the workflow run sheet) adds react-remove-scroll's scroll lock; its text holds the width of the page's own scrollbar,
 * which is 0 because the app fills the window and never scrolls the document, so it is the same everywhere. A library upgrade that
 * changes the text changes the hash, and `web/console2/e2e-real/` fails on the resulting CSP violation, which is how to find the new one.
 * CodeMirror's fixed set of editor extensions also mounts a static stylesheet (no configuration text or values). Its hash
 * permits just that stylesheet, without adding a nonce or allowing arbitrary inline styles. The real-server YAML editor
 * test covers its initial mount, folding, editing and remount, so extension/library changes must update the hash deliberately.
 */
export const CONSOLE2_STYLE_HASHES = [
  "sha256-vGQdhYJbTuF+M8iCn1IZCHpdkiICocWHDq4qnQF4Rjw=",
  "sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo=",
  "sha256-JC7jOIcPPRwiNHxnj2FtKkKx+FBcJAJ1ZZOBBgCi78E=",
];

/**
 * The app is a static bundle that talks only to this server. Scripts, styles, fonts and connections are same-origin;
 * Radix and Tailwind set inline `style` attributes, which is all `style-src-attr` allows. Nothing may frame it. As an
 * installable app it also runs a service worker and has a manifest; with `default-src 'none'` each needs its own directive,
 * and both are same-origin only.
 */
export const CONSOLE2_CSP = [
  "default-src 'none'", "script-src 'self'", `style-src 'self' ${CONSOLE2_STYLE_HASHES.map((hash) => `'${hash}'`).join(" ")}`, "style-src-attr 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

/**
 * How a file of the build may be cached. The page, the service worker and the manifest are always revalidated: a worker that
 * the browser keeps without asking could never be replaced, and the page names the hashed files. Hashed files never change.
 */
export function appCacheControl(file: string): string {
  if (file.endsWith(".html")) return "no-store";
  if (file.startsWith("assets/")) return "public, max-age=31536000, immutable";
  return "no-cache";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

/** Serve one file of the build, refusing anything that resolves outside it (a symlink included). */
export async function serveAppFile(res: ServerResponse, file: string, method: string, dist = consoleDist(), accessProtected = false): Promise<void> {
  let root: string;
  try { root = await realpath(dist); } catch { return sendText(res, 503, "webConsole2 is not built. Run `npm run console2:build`."); }
  const target = await realpath(join(root, file)).catch(() => undefined);
  const info = target && (target === root || target.startsWith(`${root}${sep}`)) ? await stat(target).catch(() => undefined) : undefined;
  if (!target || !info?.isFile()) return sendText(res, 404, "Not found");
  const html = extname(target).toLowerCase() === ".html";
  res.writeHead(200, {
    "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", "content-length": info.size,
    // Hashed bundle files never change; the page that names them must always be re-fetched.
    "cache-control": accessProtected ? "no-store" : appCacheControl(file),
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    ...(html ? { "content-security-policy": CONSOLE2_CSP, "x-frame-options": "DENY" } : {}),
  });
  if (method === "HEAD") return void res.end();
  createReadStream(target).on("error", () => res.destroy()).pipe(res);
}

function channelResponse(source: Console2Source, channel: ChannelRecord): ChannelResponse {
  const overview = channelOverview(source, channel);
  const state = overview.state === "active" ? "running" : overview.state;
  const links = new ConsoleLinks(source.baseUrl);
  return {
    id: channel.id, ...(channel.name ? { name: channel.name } : {}), isDm: channel.isDm,
    ...(overview.description ? { description: overview.description } : {}), ...(overview.rejected ? { rejected: overview.rejected } : {}),
    live: source.runtime(channel.id) !== undefined, state, counts: overview.counts,
    ...(overview.factory ? { factory: overview.factory } : {}),
  };
}

async function transcriptResponse(source: Console2Source, channel: ChannelRecord, threadKey: string, query: URLSearchParams): Promise<TranscriptResponse> {
  const redacted = isDirect(channel);
  const runtime = source.runtime(channel.id);
  if (!runtime) return unavailable(channel.id, threadKey, redacted, "This channel's conversation store is not open in the running harness, so its transcript cannot be read. Stores open at startup for configured channels, so this is a channel the harness has not been shown yet, one it does not allow, or a store that is reopening after a config reload.");
  let transcript;
  try { transcript = await runtime.store.consoleTranscript(threadKey); } catch { return unavailable(channel.id, threadKey, redacted, "The transcript could not be read."); }
  if (!transcript) return unavailable(channel.id, threadKey, redacted, "No such conversation.");
  const entries = transcriptEntries(transcript.view as unknown as ViewLike, { redacted, forkedFromEntry: transcript.forkedFromEntry });
  const before = Number(query.get("before"));
  const page = pageEntries(entries, Number.isFinite(before) && query.has("before") ? before : undefined, Number(query.get("limit")) || DEFAULT_PAGE);
  let running = false;
  try { running = (await busyThreads(runtime.store)).has(threadKey); } catch { /* unknown counts as idle */ }
  return {
    channelId: channel.id, threadKey, kind: nodeKind(threadKey), available: true, redacted, running,
    ...(transcript.forkedFromEntry > 0 ? { forkedFromEntry: transcript.forkedFromEntry } : {}), ...page,
  };
}

export interface Console2Context {
  source: Console2Source;
  /** From the listener's verified JWT only; never from proxy identity headers. */
  identity?: AccessIdentity;
  accessProtected?: boolean;
  hub: EventHub;
  /** Whether a browser `Origin` header names a host this server answers to. */
  originAllowed: (origin: string) => boolean;
  /** Registers a callback for the request closing, for the event stream's cleanup. */
  onClose: (callback: () => void) => void;
  /** Held by the server for its life, so limits and double clicks count across requests. Absent in a test that does not act. */
  actions?: { limiter: ActionLimiter; inflight: Set<string> };
}

/**
 * Handle one console2 request. The caller has already checked the Host header and the method (GET or HEAD). A failure in
 * building a response is a 500 that says so (and is logged), not the web server's catch-all "Not found".
 */
export async function handleConsole2(route: Console2Route, req: IncomingMessage, res: ServerResponse, ctx: Console2Context, query: URLSearchParams): Promise<void> {
  try {
    await respond(route, req, res, ctx, query);
  } catch (error) {
    logger.warn(`console2 ${route.page}: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) sendJson(res, 500, { error: "The console could not read that. See the harness log." });
    else res.destroy();
  }
}

async function respond(route: Console2Route, req: IncomingMessage, res: ServerResponse, ctx: Console2Context, query: URLSearchParams): Promise<void> {
  if (route.page === "lists") return handleLists(route.channelId, req, res, { source: ctx.source, originAllowed: ctx.originAllowed, limiter: ctx.actions?.limiter ?? new ActionLimiter() }, query);
  if (route.page === "admin") return handleConfigAdmin(req, res, ctx);
  if (route.page === "secrets") return handleSecretAdmin(req, res, ctx);
  if (route.page === "action") {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return void res.end("Method not allowed"); }
    return handleConsoleAction(route.target, req, res, { source: ctx.source, originAllowed: ctx.originAllowed, limiter: ctx.actions?.limiter ?? new ActionLimiter(), inflight: ctx.actions?.inflight ?? new Set() });
  }
  if (req.method === "POST") { res.writeHead(405, { allow: "GET, HEAD" }); return void res.end("Method not allowed"); }
  if (route.page === "app") return serveAppFile(res, route.file, req.method ?? "GET", undefined, ctx.accessProtected);
  // A browser sends Origin on cross-origin requests; the API is for this app's own origin only. Not CORS: nothing is allowed.
  const origin = req.headers.origin;
  if (typeof origin === "string" && !ctx.originAllowed(origin)) return sendJson(res, 403, { error: "Origin not allowed" });
  const { source } = ctx;
  if (route.page === "identity") return sendJson(res, 200, { identity: ctx.identity ?? null });
  if (route.page === "tree") return sendJson(res, 200, await buildTree(source));
  if (route.page === "activity") {
    try { return sendJson(res, 200, buildActivity(source, query)); }
    catch (error) { if (error instanceof ActivityQueryError) return sendJson(res, 400, { error: error.message }); throw error; }
  }
  if (route.page === "events") {
    if (req.method === "HEAD") { res.writeHead(200, { "content-type": "text/event-stream" }); return void res.end(); }
    // Refuse before taking a slot: an unknown channel can never produce a live feed, and slots are scarce.
    if (route.channelId && !findChannel(source, route.channelId)) return sendJson(res, 404, { error: "That channel is not known to this harness." });
    await ctx.hub.connect(res, { ...(route.channelId ? { channelId: route.channelId } : {}), ...(route.threadKey ? { threadKey: route.threadKey } : {}) }, ctx.onClose);
    return;
  }
  const channel = findChannel(source, route.channelId);
  if (!channel) return sendJson(res, 404, { error: "That channel is not known to this harness." });
  switch (route.page) {
    case "channel": return sendJson(res, 200, channelResponse(source, channel));
    case "session": return sendJson(res, 200, await buildSession(source, channel, query.get("thread") || undefined));
    case "tasks": return sendJson(res, 200, await buildTasks(source, channel));
    case "tools": return sendJson(res, 200, buildTools(source, channel, query.get("thread") || undefined));
    case "extend": return sendJson(res, 200, buildExtend(source, channel));
    case "memory": return sendJson(res, 200, buildMemory(source, channel));
    case "state": return sendJson(res, 200, await buildState(source, channel));
    case "artifacts": return sendJson(res, 200, await buildArtifacts(source, channel));
    case "workspace":
    case "database": {
      try { return sendJson(res, 200, await browseWorkspace(source, channel, route.page === "database", query)); }
      catch (error) {
        if (error instanceof WorkspaceError) return sendJson(res, error.status, { error: error.message });
        throw error;
      }
    }
    case "timeline": return sendJson(res, 200, buildTimeline(source, channel, query));
    case "workflows": return sendJson(res, 200, await buildWorkflows(source, channel));
    case "workflow": {
      const found = await buildWorkflowRun(source, channel, route.runId, mergeBrowser(req));
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: "That channel has no such workflow run." });
    }
    case "factory": {
      const factory = await buildFactory(source, channel, query.get("refresh") === "1");
      return factory ? sendJson(res, 200, factory) : sendJson(res, 404, { error: "This channel is not a software factory." });
    }
    case "thread": return sendJson(res, 200, await transcriptResponse(source, channel, route.threadKey, query));
  }
}
