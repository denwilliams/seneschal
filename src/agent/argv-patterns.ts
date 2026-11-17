/**
 * Argv allowlist matching shared by every restricted command runner: `exec`
 * (per-channel configured commands) and the shared-tool bin (published
 * scripts other channels may be allowed to run by name). Patterns describe
 * argv shapes, not shell syntax:
 *
 * - a literal token matches itself;
 * - `*` matches exactly one positional (non-option) token;
 * - a trailing `**` matches the remaining positional (non-option) tokens;
 * - option-shaped tokens must be explicitly listed as literals in a pattern;
 * - an empty allowlist means no agent-supplied args are accepted at all.
 */

function isOptionToken(token: string): boolean {
  return token.startsWith("-");
}

export function patternMatches(pattern: string[], args: string[]): boolean {
  let i = 0;
  for (; i < pattern.length; i++) {
    const expected = pattern[i]!;
    if (expected === "**" && i === pattern.length - 1) {
      return args.slice(i).every((arg) => !isOptionToken(arg));
    }
    if (i >= args.length) return false;
    if (expected === "*" && isOptionToken(args[i]!)) return false;
    if (expected !== "*" && expected !== args[i]) return false;
  }
  return i === args.length;
}

export function argsAllowed(allowArgs: string[][], args: string[]): boolean {
  if (args.length === 0) return true;
  return allowArgs.some((pattern) => patternMatches(pattern, args));
}

export function describeAllowArgs(allowArgs: string[][]): string {
  if (allowArgs.length === 0) return "no extra arguments";
  return allowArgs.map((p) => JSON.stringify(p)).join(", ");
}
