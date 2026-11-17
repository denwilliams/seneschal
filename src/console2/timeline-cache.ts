import { timelineFor, type TimelineEvent } from "../agent/timeline.ts";
import { channelPaths } from "../workspace/paths.ts";

const TTL_MS = 3_000;
/** The tree only needs to know which thread started which run, which changes rarely; it polls every couple of seconds. */
export const TREE_TTL_MS = 15_000;
const MAX_CHANNELS = 200;
const cache = new Map<string, { at: number; events: TimelineEvent[] }>();

/**
 * A channel's recent timeline events, read at most once per few seconds however many viewers poll. The log is a file of up
 * to a few megabytes; the tree, tasks and activity routes would otherwise each re-parse it on every request.
 */
export function recentTimeline(dataDir: string, channelId: string, isDm: boolean, limit = 500, now = Date.now(), ttlMs = TTL_MS): TimelineEvent[] {
  const key = `${dataDir}\0${channelId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.events.slice(-limit);
  const events = timelineFor(channelPaths(dataDir, channelId).root, isDm).read(500);
  if (cache.size >= MAX_CHANNELS) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, events });
  return events.slice(-limit);
}

export function clearTimelineCache(): void {
  cache.clear();
}
