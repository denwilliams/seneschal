import { execFileSync } from "node:child_process";
import type { RequirementsConfig } from "./schema.ts";

export interface RequirementCheck {
  kind: "binary" | "env";
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RequirementReport {
  checks: RequirementCheck[];
  missing: RequirementCheck[];
  ok: boolean;
  onMissing: "fail" | "warn";
}

const binaryCache = new Map<string, { ok: boolean; detail?: string }>();

function checkBinary(name: string): { ok: boolean; detail?: string } {
  const cached = binaryCache.get(name);
  if (cached) return cached;

  let result: { ok: boolean; detail?: string };
  try {
    // `command -v` is POSIX and resolves builtins, aliases and PATH entries.
    const out = execFileSync("/bin/sh", ["-c", `command -v ${JSON.stringify(name)}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    result = out ? { ok: true, detail: out } : { ok: false };
  } catch {
    result = { ok: false };
  }
  binaryCache.set(name, result);
  return result;
}

/**
 * `env` is the channel's layered bundle when checking a channel, so a token
 * that only exists in that channel's env file still satisfies the requirement.
 */
export function checkRequirements(
  req: RequirementsConfig,
  env: Record<string, string | undefined> = process.env,
): RequirementReport {
  const checks: RequirementCheck[] = [];

  for (const name of req.binaries) {
    const { ok, detail } = checkBinary(name);
    checks.push({ kind: "binary", name, ok, ...(detail ? { detail } : {}) });
  }

  for (const name of req.env) {
    const value = env[name];
    checks.push({ kind: "env", name, ok: typeof value === "string" && value.length > 0 });
  }

  const missing = checks.filter((c) => !c.ok);
  return { checks, missing, ok: missing.length === 0, onMissing: req.onMissing };
}

export function describeMissing(report: RequirementReport): string {
  return report.missing
    .map((m) =>
      m.kind === "binary"
        ? `  - executable "${m.name}" not found on PATH`
        : `  - environment variable "${m.name}" is unset or empty`,
    )
    .join("\n");
}

/** Merge account-level and channel-level requirements. */
export function mergeRequirements(
  base: RequirementsConfig,
  extra: RequirementsConfig,
): RequirementsConfig {
  return {
    binaries: [...new Set([...base.binaries, ...extra.binaries])],
    env: [...new Set([...base.env, ...extra.env])],
    // The stricter of the two wins.
    onMissing: base.onMissing === "fail" || extra.onMissing === "fail" ? "fail" : "warn",
  };
}
