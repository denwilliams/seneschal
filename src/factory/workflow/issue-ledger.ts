import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * What a channel has filed recently, for the hourly limit and for recognising the same request twice. The source is the factory
 * audit file the channel already writes (`issue_created` lines), so it survives a restart; the process also remembers what it filed
 * itself, so an audit line that could not be written does not reset the limit.
 */

export interface FiledIssue { at: number; repo: string; issue: number; url: string; titleKey: string }

const READ_BYTES = 1_000_000;
const KEEP_MS = 60 * 60 * 1000;

const mine = new Map<string, FiledIssue[]>();

/** The tail of the audit file: recent lines are all that is needed, so a long-lived file is not read whole. */
function tailLines(file: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, READ_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    return size > length ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ }
  }
}

export function recentlyFiled(channelId: string, auditFile: string, now = Date.now()): FiledIssue[] {
  const found = new Map<string, FiledIssue>();
  for (const line of tailLines(auditFile)) {
    if (!line.includes("issue_created")) continue;
    try {
      const entry = JSON.parse(line) as { at?: string; channelId?: string; event?: string; repo?: string; issue?: number; url?: string; titleKey?: string };
      const at = Date.parse(entry.at ?? "");
      if (entry.event !== "issue_created" || entry.channelId !== channelId || !Number.isFinite(at) || now - at > KEEP_MS) continue;
      if (typeof entry.repo === "string" && typeof entry.issue === "number" && typeof entry.url === "string") {
        found.set(`${entry.repo}#${entry.issue}`, { at, repo: entry.repo, issue: entry.issue, url: entry.url, titleKey: entry.titleKey ?? "" });
      }
    } catch { /* a line that is not ours is not ours */ }
  }
  for (const filed of mine.get(channelId) ?? []) if (now - filed.at <= KEEP_MS) found.set(`${filed.repo}#${filed.issue}`, filed);
  return [...found.values()].sort((a, b) => a.at - b.at);
}

export function rememberFiled(channelId: string, filed: FiledIssue, now = Date.now()): void {
  mine.set(channelId, [...(mine.get(channelId) ?? []).filter((entry) => now - entry.at <= KEEP_MS), filed]);
}

/** For tests: forget what this process filed. */
export function forgetFiled(): void { mine.clear(); }

/** One creation at a time per channel, so two requests together cannot both pass the same limit check. */
const chains = new Map<string, Promise<unknown>>();
export function serially<T>(channelId: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(channelId) ?? Promise.resolve()).catch(() => undefined).then(work);
  chains.set(channelId, next);
  void next.finally(() => { if (chains.get(channelId) === next) chains.delete(channelId); }).catch(() => undefined);
  return next;
}
