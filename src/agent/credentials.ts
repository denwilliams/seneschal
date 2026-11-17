import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/**
 * Provider credentials are account-level, not channel-level.
 *
 * Channels are isolated from each other, but they are all run by the same
 * operator on the same subscription or API key. Storing credentials per channel
 * would mean logging in once per channel and refreshing N OAuth tokens in
 * parallel, so they live in a single auth.json shared by every session.
 *
 * Two credential sources are supported:
 * - Environment API keys (DEEPSEEK_API_KEY, OPENAI_API_KEY, ...).
 * - Stored credentials in auth.json, which is how subscription/OAuth providers
 *   such as `openai-codex` (ChatGPT) and `github-copilot` authenticate.
 */

let authPath: string | undefined;

/** Default location pi itself uses, so an existing `pi` login is picked up. */
export function defaultPiAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

export function resolveAuthPath(configured: string | undefined, dataDir: string): string {
  const raw = configured ?? process.env.HARNESS_AUTH_PATH;
  if (!raw) return join(dataDir, "auth.json");
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(dataDir, expanded);
}

export function setAuthPath(path: string): void {
  authPath = path;
}

export function getAuthPath(): string | undefined {
  return authPath;
}

export type AuthSource = "env" | "stored" | "none";

/** Where a provider's credentials come from, if anywhere. */
export function authSourceFor(provider: string): AuthSource {
  try {
    const keys = findEnvKeys(provider as any);
    if (Array.isArray(keys) && keys.length > 0) return "env";
  } catch {
    // fall through to stored credentials
  }
  try {
    if (readStoredCredential(provider, authPath)) return "stored";
  } catch {
    // an unreadable auth.json is the same as having no credential
  }
  return "none";
}

export function hasCredentials(provider: string): boolean {
  return authSourceFor(provider) !== "none";
}
