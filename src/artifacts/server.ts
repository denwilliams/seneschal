import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { HarnessConfig } from "../config/schema.ts";
import type { ConsoleSource } from "../console2/data.ts";
import type { ConsoleConnectorOAuth } from "../agent/consoleConnectorOAuth.ts";
import { CloudflareAccess, type AccessSession } from "../console/cloudflare-access.ts";
import { CloudflareAccessSchema, type CloudflareAccessConfig } from "../config/cloudflare-access-schema.ts";
import { handleConsoleOAuth } from "../console/oauth.ts";
import { legacyConsoleTarget, redirectLegacyConsole } from "../console2/legacy.ts";
import { ConsoleLinks } from "../console2/links.ts";
import { ActionLimiter } from "../console2/actions.ts";
import { handleFactoryMcp } from "../factory/mcp.ts";
import { console2Route, handleConsole2 } from "../console2/handler.ts";
import { EventHub } from "../console2/events.ts";
import type { Console2Source } from "../console2/source.ts";
import { statusSnapshot, type StatusSource } from "../console/status.ts";

export interface ArtifactServerConfig {
  /** Whether the one web server listens at all. */
  enabled: boolean;
  host: string;
  port: number;
  /** Public absolute URL, which may include a reverse-proxy path prefix. */
  baseUrl?: string;
  /** Serves the read-only web console (channel list, channel and factory pages). */
  console?: boolean;
  /**
   * Serves `/channels/<id>/artifacts/<file>` downloads. `webServerPlan` always
   * sets it from `webConsole.artifacts` (off by default); only a hand-built
   * config that omits it gets downloads.
   */
  artifacts?: boolean;
  /** Completed tasks retained in each `/api/status` response. Defaults to 100. */
  historyLimit?: number;
  /** Let the console act on software factory runs (`webConsole.actions`). Off unless set. */
  actions?: boolean;
  /** Factory MCP on `/mcp`, served by this listener only. Off unless configured. */
  mcp?: { enabled: boolean; bearerToken?: string };
  /** Require a cryptographically validated Cloudflare Access session on browser/data routes. */
  cloudflareAccess?: CloudflareAccessConfig;
}

/**
 * The one web server, read from `webConsole` alone: when it is on, the console,
 * `/health` and `/api/status` are served, plus artifact downloads when
 * `webConsole.artifacts` is true. Artifacts never run without it.
 */
export function webServerPlan(config: Pick<HarnessConfig, "webConsole">): Required<Omit<ArtifactServerConfig, "baseUrl" | "mcp" | "cloudflareAccess">> & Pick<ArtifactServerConfig, "baseUrl" | "mcp" | "cloudflareAccess"> {
  const { webConsole } = config;
  return {
    enabled: webConsole.enabled,
    host: webConsole.host, port: webConsole.port, baseUrl: webConsole.baseUrl,
    console: webConsole.enabled, artifacts: webConsole.enabled && webConsole.artifacts,
    historyLimit: webConsole.historyLimit,
    actions: webConsole.enabled && webConsole.actions,
    ...(webConsole.mcp ? { mcp: webConsole.mcp } : {}),
    ...(webConsole.cloudflareAccess ? { cloudflareAccess: webConsole.cloudflareAccess } : {}),
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * DNS-rebinding defence. Binding to loopback is not an origin boundary: a
 * browser can resolve an attacker's hostname to 127.0.0.1 and read responses
 * as that origin. Only the names this server is really reached by are served:
 * loopback, the configured bind host (unless it is a wildcard address) and the
 * public `baseUrl` hostname a reverse proxy forwards. The port is ignored.
 */
export function isAllowedHost(hostHeader: string | undefined, config: { host: string; baseUrl?: string }): boolean {
  const name = hostName(hostHeader);
  if (!name) return false;
  if (LOOPBACK.has(name)) return true;
  const bind = hostName(config.host);
  if (bind && bind !== "0.0.0.0" && bind !== "::" && name === bind) return true;
  if (config.baseUrl) {
    try { if (name === hostName(new URL(config.baseUrl).host)) return true; } catch { /* Schema validation reports a bad URL. */ }
  }
  return false;
}

/** Lowercased host without port or IPv6 brackets; a bare IPv6 address is kept whole. */
function hostName(value: string | undefined): string | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 1 ? raw.slice(1, end) : undefined;
  }
  return raw.includes(":") && raw.indexOf(":") === raw.lastIndexOf(":") ? raw.slice(0, raw.indexOf(":")) : raw;
}

/** Artifact documents get an opaque origin: their scripts cannot read the console or `/api/status`. */
const ARTIFACT_CSP = "sandbox allow-scripts allow-downloads; worker-src 'none'";

/** The channel in webConsole2. Its factory view is `?view=factory` on this. */
export function consoleChannelUrl(baseUrl: string, channelId: string): string {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/$/, "")}/console2/`;
  base.search = "";
  base.hash = `/c/${encodeURIComponent(channelId)}`;
  return base.toString();
}

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif", ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif", ".htm": "text/html; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf", ".png": "image/png",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

/**
 * Artifact files live under `/channels/<id>/artifacts/`; the pages beside them
 * (`/channels/<id>`, `.../artifacts` itself and `.../factory`) belong to the web
 * console. The URL namespace intentionally identifies the channel by its durable Slack
 * ID, not its mutable display name. A reverse proxy can mount this server below
 * a path by putting that prefix in `baseUrl`.
 */
export function artifactChannelUrl(baseUrl: string, channelId: string): string {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  base.pathname = `${prefix}/channels/${encodeURIComponent(channelId)}/artifacts/`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

/** Returns a browser URL for a relative artifact path, or undefined if it is unsafe. */
export function artifactUrl(baseUrl: string, channelId: string, artifactPath: string): string | undefined {
  const parts = artifactPath.split("/");
  if (!parts.length || parts.some((part) => !isSafePathSegment(part))) return undefined;
  return `${artifactChannelUrl(baseUrl, channelId)}${parts.map(encodeURIComponent).join("/")}`;
}

function isSafePathSegment(segment: string): boolean {
  return Boolean(segment) && segment !== "." && segment !== ".." && !/[\\/\0]/.test(segment);
}

/** Decode and validate a URL path without letting encoded separators bypass the checks. */
export function artifactRequestPath(pathname: string): { channelId: string; path: string[] } | undefined {
  const raw = pathname.split("/");
  if (raw.shift() !== "" || raw.length < 4 || raw[0] !== "channels" || raw[2] !== "artifacts" || raw.some((part) => part === "")) return undefined;
  let parts: string[];
  try { parts = raw.map((part) => decodeURIComponent(part)); } catch { return undefined; }
  const [, channelId, , ...path] = parts;
  if (!channelId || !/^[A-Za-z0-9_-]+$/.test(channelId) || path.length === 0 || path.some((part) => !isSafePathSegment(part))) return undefined;
  return { channelId, path };
}

function pathBelowBaseUrl(pathname: string, baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return pathname;
  const prefix = new URL(baseUrl).pathname.replace(/\/$/, "");
  if (!prefix) return pathname;
  if (!pathname.startsWith(`${prefix}/`)) return undefined;
  return pathname.slice(prefix.length);
}

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("Not found");
}

/**
 * Open every component relative to a descriptor for its already-open parent.
 * `O_NOFOLLOW` applies at every step, so a channel cannot swap any path
 * component to a symlink between validation and the final file open. The
 * helper streams only from the resulting descriptor; it never reopens a path.
 * Python's `dir_fd` API maps to openat on Linux and macOS, avoiding a native
 * addon while retaining descriptor-anchored traversal.
 */
const OPEN_ARTIFACT = String.raw`
import json, os, stat, sys, time

def fail():
    sys.stderr.write('{"error":"not found"}\n')
    sys.stderr.flush()
    raise SystemExit(0)

try:
    root, *parts = sys.argv[1:]
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory = os.O_RDONLY | os.O_DIRECTORY | nofollow
    current = os.open(root, directory)
    marker = os.environ.get("HARNESS_ARTIFACT_TEST_ROOT_MARKER")
    if marker:
        with open(marker, "w") as signal: signal.write("opened")
        while open(marker).read() != "continue": time.sleep(0.001)
    try:
        for part in parts[:-1]:
            child = os.open(part, directory, dir_fd=current)
            os.close(current)
            current = child
        fd = os.open(parts[-1], os.O_RDONLY | nofollow, dir_fd=current)
    finally:
        os.close(current)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode): fail()
        sys.stderr.write(json.dumps({"size": info.st_size}) + "\n")
        sys.stderr.flush()
        with os.fdopen(fd, "rb", closefd=True) as source:
            while True:
                chunk = source.read(65536)
                if not chunk: break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
    except BaseException:
        try: os.close(fd)
        except OSError: pass
        raise
except SystemExit:
    raise
except BaseException:
    fail()
`;

function python(): string { return process.env.HARNESS_ARTIFACT_PYTHON || "python3"; }

async function verifyPython(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python(), ["--version"], { stdio: "ignore" });
    child.once("error", () => reject(new Error(`Artifact hosting requires ${python()} with Python 3.`)));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Artifact hosting requires ${python()} with Python 3.`)));
  });
}

interface ArtifactServerHooks {
  /** Test seam for trusted Access JWKS responses; never configurable over HTTP/YAML. */
  accessFetch?: typeof fetch;
  /** Test seam: runs while the Python helper holds its root directory descriptor. */
  afterRootOpen?: () => void | Promise<void>;
  /** Test seam for asserting a disconnected browser terminates its helper. */
  onHelperSpawn?: (child: ReturnType<typeof spawn>) => void;
}

async function waitForMarker(path: string, wanted: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    if (await fs.readFile(path, "utf8").catch(() => "") === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("artifact helper did not open its root directory");
}

async function openArtifact(root: string, path: string[], hooks?: ArtifactServerHooks): Promise<{ child: ReturnType<typeof spawn>; size: number }> {
  const markerDir = hooks?.afterRootOpen ? await fs.mkdtemp(join(tmpdir(), "harness-artifact-open-")) : undefined;
  const marker = markerDir ? join(markerDir, "root-open") : undefined;
  if (marker) await fs.writeFile(marker, "waiting");
  const child = spawn(python(), ["-c", OPEN_ARTIFACT, root, ...path], {
    stdio: ["ignore", "pipe", "pipe"],
    ...(marker ? { env: { ...process.env, HARNESS_ARTIFACT_TEST_ROOT_MARKER: marker } } : {}),
  });
  hooks?.onHelperSpawn?.(child);
  try {
    if (marker) {
      await waitForMarker(marker, "opened");
      await hooks!.afterRootOpen!();
      await fs.writeFile(marker, "continue");
    }
    const opened = await new Promise<{ child: ReturnType<typeof spawn>; size: number }>((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error("not found"));
      };
      child.once("error", fail);
      child.stderr.once("error", fail);
      child.stdout.once("error", fail);
      // stderr carries the one-line metadata header. Wait for it to finish
      // rather than `exit`: an empty file can exit before its buffered header
      // reaches Node.
      child.stderr.once("end", () => { if (!settled) fail(); });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        stderr += chunk.toString("utf8");
        const newline = stderr.indexOf("\n");
        if (newline === -1) return;
        try {
          const header = JSON.parse(stderr.slice(0, newline)) as { size?: unknown; error?: unknown };
          if (typeof header.size !== "number" || !Number.isSafeInteger(header.size) || header.size < 0 || header.error) return fail();
          settled = true;
          resolve({ child, size: header.size });
        } catch { fail(); }
      });
    });
    if (markerDir) child.once("exit", () => { void fs.rm(markerDir, { recursive: true, force: true }); });
    return opened;
  } catch (err) {
    child.kill();
    if (markerDir) await fs.rm(markerDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The harness's one web server: the read-only console, `/health`,
 * `/api/status` and, when enabled, channel artifact downloads, all on one
 * listener. The class keeps its historical name.
 */
export class ArtifactServer {
  private server?: Server;
  private readonly config: ArtifactServerConfig;
  private readonly dataDir: string;
  private readonly hooks: ArtifactServerHooks;

  /** Provides the console's data. Without it, the console routes are not served. */
  private readonly consoleSource?: () => ConsoleSource;

  private readonly oauth?: ConsoleConnectorOAuth;
  private readonly access?: CloudflareAccess;

  /** Provides `/api/status`. Without it, that route is not served. */
  private readonly statusSource?: StatusSource;

  /** Provides webConsole2 (`/console2`). Without it, those routes are not served. */
  private readonly console2Source?: () => Console2Source;
  /** Limits and in-flight actions for console actions: held for the server's life so they count across requests. */
  private readonly actionLimiter = new ActionLimiter();
  private readonly actionsInflight = new Set<string>();
  private readonly hub?: EventHub;

  constructor(config: ArtifactServerConfig, dataDir: string, hooks: ArtifactServerHooks = {}, consoleSource?: () => ConsoleSource, oauth?: ConsoleConnectorOAuth, statusSource?: StatusSource, console2Source?: () => Console2Source) {
    this.config = config;
    if (config.cloudflareAccess) {
      const access = CloudflareAccessSchema.parse(config.cloudflareAccess);
      if (access.enabled) this.access = new CloudflareAccess(access, hooks.accessFetch);
    }
    this.console2Source = console2Source;
    this.hub = console2Source ? new EventHub(console2Source) : undefined;
    this.statusSource = statusSource;
    this.oauth = oauth;
    this.consoleSource = consoleSource;
    this.dataDir = dataDir;
    this.hooks = hooks;
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.server) return;
    if (this.config.artifacts !== false) await verifyPython();
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => { if (!res.destroyed && !res.headersSent) notFound(res); });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.config.host, () => { this.server!.off("error", reject); resolve(); });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    // Event streams never end on their own; close them or `close` below would wait for them forever.
    this.hub?.closeAll();
    await new Promise<void>((resolve, reject) => { server.close((err) => err ? reject(err) : resolve()); server.closeIdleConnections?.(); });
  }

  address(): AddressInfo | string | null { return this.server?.address() ?? null; }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req.headers.host, this.config)) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Misdirected request");
      return;
    }
    const request = new URL(req.url ?? "/", "http://artifacts.local");
    const path = pathBelowBaseUrl(request.pathname, this.config.baseUrl);
    if (path === "/mcp" && this.config.mcp?.enabled && this.console2Source) {
      const found = this.console2Source();
      await handleFactoryMcp(req, res, {
        source: { ...found, actionsEnabled: this.config.actions === true && !!found.actions },
        bearerToken: this.config.mcp.bearerToken,
        originAllowed: (origin) => { try { return isAllowedHost(new URL(origin).host, this.config); } catch { return false; } },
        limiter: this.actionLimiter, inflight: this.actionsInflight,
      });
      return;
    }
    // Only the data-free liveness probe and separately configured MCP transport are exempt.
    // Gate ALL other paths/methods before dispatch (OAuth, redirects, static files, status, APIs and artifacts).
    const health = path === "/health" || request.pathname === "/health";
    let accessSession: AccessSession | undefined;
    if (this.access && !health) {
      accessSession = await this.access.authenticate(req);
      if (!accessSession) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end("A valid Cloudflare Access session is required.");
        return;
      }
      res.setHeader("x-harness-access-protected", "1");
      // An open SSE/download must not keep delivering data after its credential expires.
      const lifetime = Math.min(accessSession.expiresAt - Date.now(), 2_147_483_647);
      if (lifetime <= 0) { res.writeHead(401, { "cache-control": "no-store" }); res.end(); return; }
      const expiry = setTimeout(() => res.destroy(), lifetime);
      expiry.unref();
      res.once("close", () => clearTimeout(expiry));
    }
    if (this.config.console && this.oauth && await handleConsoleOAuth(req, res, this.oauth)) return;
    // POSTs may administer config or perform a console action. Anything else, or an action name that is not on the list, is not served.
    if (req.method === "POST") {
      const action = this.config.console && this.console2Source && this.hub && path ? console2Route(path, request.searchParams) : undefined;
      if (action?.page !== "action" && action?.page !== "admin" && action?.page !== "secrets" && action?.page !== "lists") {
        // An action name that is not on the list does not exist; any other POST is the method the page does not take.
        if (this.config.console && path !== undefined && /^\/console2\/api\/v1\/channels\/[^/]+\/(workflows\/[^/]+\/actions\/|factory\/)[^/]+$/.test(path)) return notFound(res);
        res.writeHead(405, { allow: "GET, HEAD" }); res.end("Method not allowed"); return;
      }
    } else if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end("Method not allowed"); return; }
    // Health and status answer both below the baseUrl prefix (through the
    // proxy) and at the bare path (a local probe straight at the listener).
    const isPath = (wanted: string) => path === wanted || request.pathname === wanted;
    if (isPath("/health")) { res.writeHead(200, { "content-type": "application/json", "x-content-type-options": "nosniff" }); res.end('{"ok":true}'); return; }
    if (this.statusSource && isPath("/api/status")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(statusSnapshot(this.statusSource, this.config.historyLimit ?? 100))); return;
    }
    // The app names its files relatively (`./assets/...`), which only resolves under a trailing slash.
    if (this.config.console && this.console2Source && path === "/console2") {
      res.writeHead(308, { location: `${request.pathname}/${request.search}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    const route2 = this.config.console && this.console2Source && this.hub && path ? console2Route(path, request.searchParams) : undefined;
    if (route2) {
      const originAllowed = (origin: string): boolean => { try { return isAllowedHost(new URL(origin).host, this.config); } catch { return false; } };
      const found = this.console2Source!();
      // The web server's own switch is the one that counts: a source cannot turn actions on by itself.
      const source = found.actions && this.config.actions === true ? { ...found, actionsEnabled: true } : { ...found, actionsEnabled: false };
      await handleConsole2(route2, req, res, { source: { ...source, listsWritable: this.config.actions === true }, identity: accessSession?.identity, accessProtected: !!this.access, hub: this.hub!, originAllowed, onClose: (callback) => { res.once("close", callback); }, actions: { limiter: this.actionLimiter, inflight: this.actionsInflight } }, request.searchParams);
      return;
    }
    const redirectSource = this.console2Source ?? this.consoleSource;
    const legacy = this.config.console && redirectSource && path !== undefined ? legacyConsoleTarget(path, new ConsoleLinks(redirectSource().baseUrl)) : undefined;
    if (legacy) { redirectLegacyConsole(res, legacy); return; }
    const requested = this.config.artifacts !== false && path ? artifactRequestPath(path) : undefined;
    if (!requested) return notFound(res);

    let child: ReturnType<typeof spawn> | undefined;
    let responseClosed = false;
    const abort = () => { responseClosed = true; child?.kill(); };
    // A browser can close while the helper is preparing its metadata or while
    // its stdout is backpressured. Either way, the process owns a file
    // descriptor and must not be left waiting for a pipe nobody reads.
    res.once("close", abort);
    res.once("error", abort);
    const root = join(this.dataDir, "channels", requested.channelId, "workspace", "artifacts");
    const opened = await openArtifact(root, requested.path, {
      ...this.hooks,
      onHelperSpawn: (spawned) => {
        // Record it before waiting for the metadata header: FIFO/device files
        // can block in the helper's final open, while the browser may already
        // have disconnected.
        child = spawned;
        this.hooks.onHelperSpawn?.(spawned);
      },
    });
    child = opened.child;
    if (responseClosed || res.destroyed) { child.kill(); return; }

    res.writeHead(200, {
      "content-type": contentType(requested.path.at(-1) ?? ""), "content-length": opened.size,
      "cache-control": this.access ? "no-store" : "no-cache", "x-content-type-options": "nosniff",
      // User-authored artifacts share an origin with the console, /api/status
      // and any OAuth routes, so they always run in an opaque sandbox origin.
      "content-security-policy": ARTIFACT_CSP,
    });
    if (req.method === "HEAD") { child.kill(); res.end(); return; }
    const stdout = child.stdout;
    if (!stdout) { child.kill(); return notFound(res); }
    const cleanup = () => { res.off("close", abort); res.off("error", abort); };
    child.once("exit", cleanup);
    stdout.once("error", () => { child!.kill(); res.destroy(); });
    child.once("error", () => res.destroy());
    stdout.pipe(res);
  }
}
