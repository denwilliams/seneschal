import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * User Slack tokens are deliberately not the bot token.
 *
 * The `slack` tool answers "search as me", so credentials are keyed by the
 * Slack user id of whoever is currently speaking. The tool is read-only in the
 * harness; the token should be issued with read/search user scopes only.
 */

export interface SlackUserTokenRecord {
  token: string;
  teamId?: string;
  team?: string;
  updatedAt?: string;
}

type StoredRecord = string | SlackUserTokenRecord;

export interface SlackUserTokenFile {
  users?: Record<string, StoredRecord>;
}

export function defaultSlackUserTokenPath(shared: SharedPaths): string {
  return join(shared.root, "slack-user-tokens.json");
}

/** The user-token store a channel sees: the shared file, with the channel's own environment winning. */
export function userTokensFor(channel: Pick<ResolvedChannel, "shared" | "env">): SlackUserTokenStore {
  return new SlackUserTokenStore(defaultSlackUserTokenPath(channel.shared), channel.env);
}

export function slackUserTokenEnvName(userId: string): string {
  return `SLACK_USER_TOKEN_${userId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function readStore(path: string): SlackUserTokenFile {
  if (!existsSync(path)) return { users: {} };
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return { users: {} };
  const parsed = JSON.parse(raw) as SlackUserTokenFile;
  return { users: parsed.users ?? {} };
}

function normalise(record: StoredRecord | undefined): SlackUserTokenRecord | undefined {
  if (!record) return undefined;
  if (typeof record === "string") return { token: record };
  return record;
}

export class SlackUserTokenStore {
  readonly path: string;
  private readonly env: Record<string, string | undefined>;

  constructor(path: string, env: Record<string, string | undefined> = process.env) {
    this.path = path;
    this.env = env;
  }

  /** Environment wins so an operator can rotate a token without editing JSON. */
  tokenFor(userId: string): string | undefined {
    const fromEnv = this.env[slackUserTokenEnvName(userId)];
    if (fromEnv?.trim()) return fromEnv.trim();

    const record = normalise(readStore(this.path).users?.[userId]);
    const token = record?.token?.trim();
    return token || undefined;
  }

  hasUser(userId: string): boolean {
    return Boolean(this.tokenFor(userId));
  }

  listUsers(): string[] {
    const fileUsers = Object.keys(readStore(this.path).users ?? {});
    const envUsers = Object.keys(this.env)
      .filter((k) => k.startsWith("SLACK_USER_TOKEN_") && this.env[k]?.trim())
      // Env var names may contain underscores substituted for punctuation; Slack
      // user ids are alphanumeric in practice, which is the intended path.
      .map((k) => k.slice("SLACK_USER_TOKEN_".length));
    return [...new Set([...fileUsers, ...envUsers])].sort();
  }

  setUser(userId: string, record: SlackUserTokenRecord): void {
    const current = readStore(this.path);
    const users = { ...(current.users ?? {}), [userId]: { ...record, updatedAt: new Date().toISOString() } };
    this.write({ users });
  }

  removeUser(userId: string): boolean {
    const current = readStore(this.path);
    if (!current.users?.[userId]) return false;
    const users = { ...current.users };
    delete users[userId];
    this.write({ users });
    return true;
  }

  private write(data: SlackUserTokenFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
