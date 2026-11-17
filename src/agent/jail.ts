import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Filesystem isolation between channels.
 *
 * Every file-touching tool call is resolved to an absolute real path and
 * checked against the channel's allowed roots. Reads and writes have separate
 * allowlists, so a channel can read the account knowledge base without being
 * able to rewrite it.
 *
 * Symlinks are resolved before the check (via the nearest existing ancestor),
 * so a symlink planted inside the workspace cannot be used to step outside it.
 *
 * Note on `bash`: a shell cannot be confined this way without OS-level
 * sandboxing. `bash` is therefore opt-in per channel, and when it is enabled
 * the container (or the host) is the real boundary, not this module.
 */

export interface JailConfig {
  readRoots: string[];
  writeRoots: string[];
  /**
   * External directories reachable only through symlinks whose requested path
   * begins inside cwd. These are not general read/write roots.
   */
  workspaceSymlinkRoots?: string[];
  /**
   * In-container path prefixes (`/skills/channel`) that stand for host
   * directories. In docker mode the agent is shown the container path, which
   * is the one that works in bash; file tools translate it here and are then
   * checked against the roots exactly like any other host path, so an alias
   * is a spelling, never an extra permission.
   */
  pathAliases?: { from: string; to: string }[];
  /** Tool calls with relative paths resolve against this. */
  cwd: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Mirror Pi's native file-tool path normalization before enforcing the jail.
 * The extension must validate the same path Pi will open: `@`, `~`, and
 * `file://` otherwise turn a syntactically workspace-relative string into a
 * direct host path after this hook approves it.
 */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

function normalizePiToolPath(input: string): string {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** Translate an in-container alias prefix to its host directory, or return the path unchanged. */
function applyAliases(jail: JailConfig, path: string): string {
  if (!jail.pathAliases?.length || !path.startsWith("/")) return path;
  const normalized = posix.normalize(path);
  for (const { from, to } of jail.pathAliases) {
    if (normalized === from) return to;
    if (normalized.startsWith(from + "/")) return join(to, normalized.slice(from.length + 1));
  }
  return path;
}

/** Resolve a path, following symlinks as far as the path actually exists. */
function realResolve(input: string, cwd: string): string {
  const absolute = isAbsolute(input) ? input : resolve(cwd, input);
  let probe = absolute;
  const trailing: string[] = [];

  // Walk up to the nearest existing ancestor so we can realpath() it, then
  // re-append the non-existent tail. This catches symlinked parent dirs.
  for (;;) {
    try {
      const real = realpathSync(probe);
      return trailing.length > 0 ? resolve(real, ...trailing.reverse()) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute; // hit the filesystem root
      trailing.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  })();
  if (candidate === realRoot) return true;
  return candidate.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

/** Check containment without resolving symlinks. */
function isLexicallyWithin(candidate: string, root: string): boolean {
  const absoluteCandidate = resolve(candidate);
  const absoluteRoot = resolve(root);
  if (absoluteCandidate === absoluteRoot) return true;
  return absoluteCandidate.startsWith(absoluteRoot.endsWith(sep) ? absoluteRoot : absoluteRoot + sep);
}

/**
 * Configured symlink targets are an escape hatch only for a path that started
 * inside the workspace and actually crossed a symlink. In particular, naming
 * `/projects/foo` never permits a tool call directly to `/projects/foo`.
 */
function followsAllowedWorkspaceSymlink(jail: JailConfig, rawPath: string, resolved: string): boolean {
  if (!jail.workspaceSymlinkRoots?.length) return false;
  const requested = isAbsolute(rawPath) ? resolve(rawPath) : resolve(jail.cwd, rawPath);
  if (!isLexicallyWithin(requested, jail.cwd)) return false;
  // `realResolve` differs only when an existing part of the requested path was
  // a symlink. This also handles a non-existent final file beneath a symlink.
  if (requested === resolved) return false;
  return jail.workspaceSymlinkRoots.some((root) => isWithin(resolved, root));
}

export interface JailDecision {
  allowed: boolean;
  resolved: string;
  reason?: string;
}

export function checkPath(
  jail: JailConfig,
  rawPath: string,
  mode: "read" | "write",
): JailDecision {
  let normalized: string;
  try {
    normalized = normalizePiToolPath(rawPath);
  } catch {
    return {
      allowed: false,
      resolved: rawPath,
      reason: "This channel can only access valid local paths within its permitted workspace.",
    };
  }
  normalized = applyAliases(jail, normalized);
  const resolved = realResolve(normalized, jail.cwd);
  const roots = mode === "write" ? jail.writeRoots : jail.readRoots;
  // Writable roots are always readable too.
  const effective = mode === "read" ? [...jail.readRoots, ...jail.writeRoots] : roots;

  if (
    effective.some((root) => isWithin(resolved, root)) ||
    followsAllowedWorkspaceSymlink(jail, normalized, resolved)
  ) {
    return { allowed: true, resolved };
  }
  return {
    allowed: false,
    resolved,
    reason:
      mode === "write"
        ? `Writing to ${resolved} is outside this channel's workspace. This channel can only write within its own workspace and memory.`
        : `Reading ${resolved} is outside this channel's allowed paths. Channels are isolated; ask an admin to share this path in the harness config.`,
  };
}

/**
 * Enforce the jail for one tool call. Returns the reason to block it, or undefined to allow.
 *
 * On allow, `input.path` is rewritten to the checked canonical path: the native tools
 * otherwise reopen the original string after validation, letting a symlink be retargeted
 * between check and use. Shared by the Pi extension below and the Durable tool adapter.
 */
export function enforceJail(
  jail: JailConfig,
  toolName: string,
  input: Record<string, unknown> | undefined,
  onViolation?: (msg: string) => void,
): string | undefined {
  const mode = WRITE_TOOLS.has(toolName) ? "write" : READ_TOOLS.has(toolName) ? "read" : undefined;
  if (!mode) return undefined;

  const raw = input?.["path"];
  // `ls`/`find`/`grep` default to cwd when no path is given, which is
  // inside the jail by construction.
  if (typeof raw !== "string") return undefined;

  const decision = checkPath(jail, raw, mode);
  if (decision.allowed) {
    (input as Record<string, unknown>)["path"] = decision.resolved;
    return undefined;
  }

  onViolation?.(`${toolName} blocked: ${decision.resolved}`);
  return decision.reason ?? "Path outside this channel's workspace.";
}

/**
 * Inline pi extension that enforces the jail. Registered per channel session,
 * closing over that channel's roots.
 */
export function createJailExtension(jail: JailConfig, onViolation?: (msg: string) => void) {
  return {
    name: "channel-jail",
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_call", (event) => {
        const reason = enforceJail(jail, event.toolName, event.input as Record<string, unknown> | undefined, onViolation);
        return reason === undefined ? undefined : { block: true, reason };
      });
    },
  };
}
