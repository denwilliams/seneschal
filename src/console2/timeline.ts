import { timelineEvents } from "./data.ts";
import { layoutGraph, summarize } from "./timeline-graph.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { TimelineResponse, TimelineRowView } from "./api-types.ts";
import type { Console2Source } from "./source.ts";

/**
 * The channel timeline as data. The layout (lanes, forks and merges) is the original's pure function of the events; the browser
 * draws it. Only fields the view needs are copied out: not the Slack user id, the run key, or the model. A direct message's log
 * was written with no excerpts, so none can appear here.
 */
const DM_TITLES: Partial<Record<TimelineRowView["kind"], string>> = {
  "turn.start": "Turn started", "turn.end": "Turn ended", "approval.requested": "Approval requested",
  "approval.decided": "Approval decided", post: "Message posted",
};

export function buildTimeline(source: Console2Source, channel: ChannelRecord, query: URLSearchParams, now = Date.now()): TimelineResponse {
  const limit = Number(query.get("limit") ?? "");
  const events = timelineEvents(source, channel.id, Number.isFinite(limit) && limit > 0 ? limit : undefined);
  const layout = layoutGraph(events, now);
  const hideTools = query.get("tools") === "0";
  const actor = query.get("actor") || undefined;
  const rows: TimelineRowView[] = [...layout.rows].reverse()
    .filter((row) => !(hideTools && row.event.kind === "tool") && (!actor || row.event.actor === actor))
    .map(({ event, lane, shape, dead, fromOlder, through }) => ({
      id: event.id, at: event.at, kind: event.kind, actor: event.actor,
      // Titles are meant to be safe labels, but in a direct message the ones that can carry a request or a target are replaced by the kind.
      title: channel.isDm ? (DM_TITLES[event.kind] ?? event.title) : event.title,
      ...(event.detail && !channel.isDm ? { detail: event.detail } : {}), ...(event.status ? { status: event.status } : {}), ...(event.next ? { next: event.next } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}), ...(event.steps !== undefined ? { steps: event.steps } : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}), ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
      lane, shape, dead, fromOlder, through: [...through],
    }));
  return {
    generatedAt: new Date(now).toISOString(), count: events.length, lanes: layout.lanes,
    actors: [...new Set(events.map((event) => event.actor))].sort((a, b) => (a === "channel" ? -1 : b === "channel" ? 1 : a.localeCompare(b))),
    summary: summarize(events), rows,
  };
}
