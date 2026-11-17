import { ACTIVITY_SESSION, ACTIVITY_STARTED_AT, ChannelActivityLog, slackActivityUrl, slackFileUrl } from "../agent/activity.ts";
import { channelPaths } from "../workspace/paths.ts";
import { findChannel, listChannels } from "./data.ts";
import type { Console2Source } from "./source.ts";
import type { ActivityEntry, ActivityResponse } from "./api-types.ts";

export class ActivityQueryError extends Error {}
interface Cursor { at: string; id: string; until: string; since?: string }
const validDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const compare = (a: Pick<ActivityEntry, "at" | "id">, b: Pick<ActivityEntry, "at" | "id">) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

export function buildActivity(source: Console2Source, query: URLSearchParams, now = Date.now()): ActivityResponse {
  const limit = Number(query.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ActivityQueryError("limit must be an integer from 1 to 100");
  let cursor: Cursor | undefined;
  if (query.has("cursor")) {
    try {
      const raw = query.get("cursor")!;
      if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (!cursor || !validDate(cursor.at) || !validDate(cursor.until) || !/^[a-f0-9]{24}$/.test(cursor.id) || (cursor.since !== undefined && !validDate(cursor.since))) throw new Error();
    } catch { throw new ActivityQueryError("Invalid activity cursor"); }
  }
  const generatedAt = new Date(now).toISOString();
  const until = cursor?.until ?? generatedAt;
  const since = cursor?.since ?? query.get("since") ?? undefined;
  if (since !== undefined && !validDate(since)) throw new ActivityQueryError("since must be an ISO UTC timestamp");
  const entries: ActivityEntry[] = [];
  const channelIds: string[] = [];
  for (const item of listChannels(source)) {
    if (!item.linkable || item.isDm) continue;
    const channel = findChannel(source, item.id);
    // Re-resolve on every request: removing a channel must immediately hide its retained history.
    if (!channel || !source.resolve(channel)) continue;
    channelIds.push(channel.id);
    for (const row of new ChannelActivityLog(channelPaths(source.dataDir, channel.id).root, channel.id).read()) {
      let interaction = row.interaction;
      let updatedAt = row.updatedAt;
      if (interaction === "pending" && row.session && row.session !== ACTIVITY_SESSION) {
        interaction = "unavailable"; updatedAt = [updatedAt, ACTIVITY_STARTED_AT].sort().at(-1)!;
      } else if (interaction === "pending" && row.expiresAt && row.expiresAt <= generatedAt) {
        interaction = "expired"; updatedAt = [updatedAt, row.expiresAt].sort().at(-1)!;
      }
      if (row.at > until || (since && (updatedAt < since || updatedAt > until))) continue;
      const sourceUrl = (row.sourceTs ? slackActivityUrl(channel.id, row.sourceTs) : undefined) ?? slackFileUrl(row.fileUrl);
      // An unlinked prompt is not actionable; never send a false waiting indicator.
      if (interaction === "pending" && !sourceUrl) interaction = "unavailable";
      entries.push({ id: row.id, at: row.at, updatedAt, kind: row.kind, title: row.title, snippet: row.snippet,
        channel: { id: channel.id, ...(channel.name ? { name: channel.name } : {}) },
        interaction, ...(sourceUrl ? { sourceUrl } : {}) });
    }
  }
  entries.sort(compare);
  const eligible = cursor ? entries.filter((row) => compare(row, cursor!) > 0) : entries;
  const page = eligible.slice(0, limit);
  const last = page.at(-1);
  return { generatedAt, channelIds, watermark: until, entries: page,
    ...(eligible.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ at: last.at, id: last.id, until, ...(since ? { since } : {}) })).toString("base64url") } : {}) };
}
