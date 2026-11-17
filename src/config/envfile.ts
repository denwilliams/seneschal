import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Layered secrets.
 *
 * Provider credentials (the LLM keys) belong to the operator and live in one
 * place. Connector credentials do not: the GitHub token #engineering uses
 * should not be reachable from #home, or the connector isolation is decorative.
 *
 * So env values resolve in layers, most specific winning:
 *
 *   process environment  <  global env file  <  channel env file
 *
 * A channel's file lives in its own directory, outside the channel's tool jail,
 * so the agent can use its secrets without being able to read them back out.
 */

export type EnvBundle = Record<string, string>;

/** Minimal dotenv parser: KEY=VALUE, # comments, quotes, optional `export`. */
export function parseEnvFile(content: string): EnvBundle {
  const out: EnvBundle = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);

    if (quoted) {
      const quote = value[0];
      value = value.slice(1, -1);
      // Only double quotes get escape processing, as in dotenv.
      if (quote === '"') {
        value = value.replace(/\\([n"\\])/g, (_whole, escaped: string) =>
          escaped === "n" ? "\n" : escaped,
        );
      }
    } else {
      // An unquoted trailing comment is not part of the value.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

export function readEnvFile(path: string): EnvBundle {
  if (!existsSync(path)) return {};
  try {
    return parseEnvFile(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Resolve a configured path against a base, expanding a leading `~`. */
export function resolveEnvPath(raw: string, base: string): string {
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export interface LayeredEnv {
  bundle: EnvBundle;
  /** Files that actually contributed, for diagnostics. Never values. */
  sources: string[];
  /**
   * Variable names supplied by env files, excluding the ambient process
   * environment. Names only — values are never surfaced anywhere.
   */
  fileKeys: string[];
}

/**
 * Build the effective environment for a channel. Later layers win.
 * Only the *names* of loaded variables are ever reported.
 */
export function layerEnv(
  layers: Array<{ label: string; values: EnvBundle; ambient?: boolean }>,
): LayeredEnv {
  const bundle: EnvBundle = {};
  const sources: string[] = [];
  const fileKeys = new Set<string>();

  for (const layer of layers) {
    const keys = Object.keys(layer.values);
    if (keys.length === 0) continue;
    Object.assign(bundle, layer.values);
    sources.push(layer.label);
    if (!layer.ambient) for (const key of keys) fileKeys.add(key);
  }
  return { bundle, sources, fileKeys: [...fileKeys].sort() };
}

/** Expand ${VAR} against a bundle. Unresolved names are reported, not guessed. */
export function expandWith(value: string, bundle: EnvBundle, context: string, ambientFallback = true): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
    // Scoped resolvers disable ambient fallback after filtering private names.
    const found = Object.hasOwn(bundle, name) ? bundle[name] : ambientFallback ? process.env[name] : undefined;
    if (found === undefined) {
      throw new Error(
        `${context} references \${${name}}, which is not set in the environment or any env file for this channel.`,
      );
    }
    return found;
  });
}

export function expandDeepWith<T>(value: T, bundle: EnvBundle, context: string, ambientFallback = true): T {
  if (typeof value === "string") return expandWith(value, bundle, context, ambientFallback) as T;
  if (Array.isArray(value)) {
    return value.map((v) => expandDeepWith(v, bundle, context, ambientFallback)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandDeepWith(v, bundle, context, ambientFallback)]),
    ) as T;
  }
  return value;
}
