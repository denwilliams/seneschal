import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { HarnessConfigSchema, type HarnessConfig } from "./schema.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Expand ${VAR} references from the process environment. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (whole, name: string) => {
    const found = process.env[name];
    if (found === undefined) {
      throw new Error(`Config references \${${name}} but that environment variable is not set`);
    }
    return found;
  });
}

/**
 * Expand ${VAR} and normalise YAML's empty values.
 *
 * A key whose body is entirely commented out parses as `null`, which is not
 * what the author meant — they meant "leave this unset". Mapping null to
 * undefined lets the schema defaults apply instead of raising a type error.
 * Exception: sandbox.pidsLimit is nullable at defaults and channel scope; null
 * there deliberately disables the limit and must survive validation and merging.
 */
/** Sections whose ${VAR} placeholders are expanded per channel, not here. */
const DEFERRED = new Set(["connectors", "web", "exec", "images", "sharedTools", "cliTools"]);

function expandDeep(value: unknown, deferred = false, path: (string | number)[] = []): unknown {
  if (value === null) {
    const isPidsLimit =
      (path.length === 3 && path[0] === "defaults" && path[1] === "sandbox" && path[2] === "pidsLimit") ||
      (path.length === 4 && path[0] === "channels" && path[2] === "sandbox" && path[3] === "pidsLimit");
    return isPidsLimit ? null : undefined;
  }
  // Connector definitions, shared CLI definitions, web settings, image settings and exec command environments keep
  // their ${VAR} placeholders: all are expanded per channel, so a channel env
  // file can override a global value — one channel's search key, CLI token or
  // GitHub token should not be the same as another's. Expanding here would bake
  // the global value in first.
  if (typeof value === "string") return deferred ? value : expandEnv(value);
  if (Array.isArray(value)) {
    return value.map((v, i) => expandDeep(v, deferred, [...path, i])).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, expandDeep(v, deferred || DEFERRED.has(k), [...path, k])] as const)
      .filter(([, v]) => v !== undefined);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Top-level blocks that were folded into `webConsole`. A config that still
 * has one is refused with where it went: the schema strips unknown keys, so
 * without this the old block would be silently ignored.
 */
const REMOVED_BLOCKS: Record<string, string> = {
  dashboard: "`dashboard` was removed: the task dashboard is now part of the one web server, `webConsole`. "
    + "`/health` and `/api/status` are served from it, `dashboard.historyLimit` moved to `webConsole.historyLimit`, "
    + "and the token is gone (put authentication in a reverse proxy). Delete the `dashboard` block and enable `webConsole` instead.",
  artifacts: "`artifacts` was removed: artifacts are now served by the one web server, `webConsole`. "
    + "Set `webConsole.enabled: true` (required) and `webConsole.artifacts: true` to turn on downloads, with host, port and baseUrl set under `webConsole`. "
    + "Turning it on also serves the console and /api/status on the same origin, with no authentication: keep it on loopback or behind an authenticating proxy. "
    + "Delete the `artifacts` block and move its settings there.",
};

function refuseRemovedBlocks(raw: unknown, label: string): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const found = Object.keys(REMOVED_BLOCKS).filter((key) => key in raw);
  if (found.length) throw new Error(`Invalid ${label}:\n${found.map((key) => `  - ${REMOVED_BLOCKS[key]}`).join("\n")}`);
}

/**
 * Parse config text exactly as the harness does at startup: expand ${VAR},
 * normalise YAML's nulls, then validate. Exported so tests can check
 * documentation and example files through the real path rather than a
 * lookalike that accepts things the loader would reject.
 */
export function parseConfigText(text: string, label = "config") {
  const raw = parseYaml(text) ?? {};
  refuseRemovedBlocks(raw, label);
  const parsed = HarnessConfigSchema.safeParse(expandDeep(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${label}:\n${issues}`);
  }
  return parsed.data;
}

export interface LoadedConfig {
  config: HarnessConfig;
  /** Absolute, resolved data directory. */
  dataDir: string;
  configPath: string;
}

export function loadConfig(configPath?: string): LoadedConfig {
  const path = configPath
    ? resolve(configPath)
    : existsSync(resolve(REPO_ROOT, "config/harness.local.yaml"))
      ? resolve(REPO_ROOT, "config/harness.local.yaml")
      : resolve(REPO_ROOT, "config/harness.yaml");

  if (!existsSync(path)) {
    throw new Error(
      `No config found at ${path}. Copy config/harness.example.yaml to config/harness.yaml to get started.`,
    );
  }

  const config = parseConfigText(readFileSync(path, "utf-8"), `config at ${path}`);
  const dataDir = isAbsolute(config.dataDir)
    ? config.dataDir
    : resolve(REPO_ROOT, config.dataDir);

  return { config, dataDir, configPath: path };
}
