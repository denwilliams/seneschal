import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { redactTaskUrls } from "../tasks/store.ts";
import { logger } from "../util/log.ts";
import type { ActivityEntry } from "../console2/api-types.ts";

/** In-memory approvals cannot survive a process restart. Never present them as actionable afterwards. */
export const ACTIVITY_SESSION = randomUUID();
export const ACTIVITY_STARTED_AT = new Date().toISOString();
export const ACTIVITY_MAX_BYTES = 4 * 1024 * 1024;
export interface ActivityRecord extends Omit<ActivityEntry, "channel" | "sourceUrl"> {
  sourceTs?: string;
  fileUrl?: string;
  session?: string;
  expiresAt?: string;
}
export interface ActivityInput {
  key: string;
  kind: ActivityEntry["kind"];
  title: string;
  text?: string;
  sourceTs?: string;
  fileUrl?: string;
  interaction?: ActivityEntry["interaction"];
  expiresAt?: string;
  ephemeral?: boolean;
}

/** Only public-facing text, never tool arguments/results or button values. Redact before persistence, not just rendering. */
export function activitySnippet(text: string): string {
  return redactTaskUrls(text
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^-]*-----|$)/g, "[credential omitted]")
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, "[code omitted]")
    .replace(/\b(?:Bearer\s+\S+|(?:xox[baprs]-|sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|(?:AKIA|ASIA)[0-9A-Z]{16})/gi, "[credential omitted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[credential omitted]")
    .replace(/((?:[\w.-]*(?:token|secret|password|api[_-]?key)[\w.-]*)[\s"']*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[redacted]"))
    .replace(/\s+/g, " ").trim().slice(0, 280);
}
export const activityId = (channelId: string, key: string): string => createHash("sha256").update(`${channelId}\0${key}`).digest("hex").slice(0, 24);
export const slackActivityUrl = (channelId: string, ts: string): string | undefined =>
  /^[CG][A-Z0-9]+$/.test(channelId) && /^\d+\.\d+$/.test(ts) ? `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}` : undefined;

/** Only a Slack-returned file permalink may be used when an upload has no message/thread timestamp. */
export function slackFileUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) || !/^\/files\/[A-Z0-9]+\/[A-Z0-9]+(?:\/|$)/.test(url.pathname)) return undefined;
    url.search = ""; url.hash = "";
    return url.href;
  } catch { return undefined; }
}

/** Bounded append-only snapshots. An edit replaces only that entry, never the channel's previous activity. */
export class ChannelActivityLog {
  private readonly root: string;
  private readonly channelId: string;
  private readonly now: () => number;
  constructor(root: string, channelId: string, now: () => number = Date.now) {
    this.root = root; this.channelId = channelId; this.now = now;
  }
  read(): ActivityRecord[] {
    const records = new Map<string, ActivityRecord>();
    for (const file of ["activity.1.jsonl", "activity.jsonl"]) {
      const path = join(this.root, file);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const row = JSON.parse(line) as ActivityRecord;
          if (/^[a-f0-9]{24}$/.test(row.id) && Number.isFinite(Date.parse(row.at)) && Number.isFinite(Date.parse(row.updatedAt))) records.set(row.id, row);
        } catch { /* torn line after a crash */ }
      }
    }
    return [...records.values()];
  }
  record(input: ActivityInput): void {
    // DMs are excluded entirely from the cross-channel feed, including metadata and source links.
    if (!/^[CG][A-Z0-9]+$/.test(this.channelId)) return;
    try {
      const id = activityId(this.channelId, input.key);
      const old = this.read().find((row) => row.id === id);
      const at = new Date(this.now()).toISOString();
      const row: ActivityRecord = {
        id, at: old?.at ?? at, updatedAt: at, kind: input.kind,
        title: activitySnippet(input.title), snippet: activitySnippet(input.text ?? input.title),
        interaction: input.interaction ?? "none",
        ...(input.sourceTs ? { sourceTs: input.sourceTs } : {}),
        ...(slackFileUrl(input.fileUrl) ? { fileUrl: slackFileUrl(input.fileUrl) } : {}),
        ...(input.ephemeral ? { session: ACTIVITY_SESSION } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      };
      if (old && JSON.stringify({ ...old, updatedAt: at }) === JSON.stringify(row)) return;
      this.append(row);
    } catch (error) { logger.warn(`activity: could not record: ${error instanceof Error ? error.message : String(error)}`); }
  }
  resolveKey(key: string): void {
    try {
      const row = this.read().find((r) => r.id === activityId(this.channelId, key));
      if (row?.interaction === "pending") this.append({ ...row, interaction: "resolved", updatedAt: new Date(this.now()).toISOString() });
    } catch (error) { logger.warn(`activity: could not settle prompt: ${String(error)}`); }
  }
  resolve(sourceTs: string, interaction: ActivityEntry["interaction"] = "resolved", exceptKey?: string): void {
    try {
      for (const row of this.read()) {
        if (row.sourceTs === sourceTs && row.interaction === "pending" && row.id !== (exceptKey ? activityId(this.channelId, exceptKey) : undefined)) {
          this.append({ ...row, interaction, updatedAt: new Date(this.now()).toISOString() });
        }
      }
    } catch (error) { logger.warn(`activity: could not settle interaction: ${String(error)}`); }
  }
  private append(row: ActivityRecord): void {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, "activity.jsonl");
    if (existsSync(path) && statSync(path).size > ACTIVITY_MAX_BYTES) renameSync(path, join(this.root, "activity.1.jsonl"));
    // Isolate the next snapshot even when a crash left an unterminated partial line.
    appendFileSync(path, `\n${JSON.stringify(row)}\n`, { mode: 0o600 });
  }
}

/** Only typed workflow state is used, never guessed from a label or a button's payload. */
export interface PresenceInteraction { key: string; pending: boolean }
export function recordPresenceActivity(log: ChannelActivityLog, input: { ts: string; text: string; interaction?: PresenceInteraction }): void {
  const pending = input.interaction?.pending === true;
  const version = pending ? createHash("sha256").update(input.interaction!.key).digest("hex").slice(0, 16) : "post";
  const key = `presence:${input.ts}:${version}`;
  log.resolve(input.ts, "resolved", pending ? key : undefined);
  log.record({ key, kind: "workflow", sourceTs: input.ts, title: "Workflow update", text: input.text, interaction: pending ? "pending" : "none" });
}
