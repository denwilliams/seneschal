import type { FactoryActivity } from "./dashboard.ts";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const KINDS = {
  deployment: { symbol: "▲", label: "Deployment created" },
  issueOpened: { symbol: "◆", label: "Issue opened" },
  push: { symbol: "➜", label: "Changes pushed" },
  merged: { symbol: "✓", label: "PR merged" },
  issue: { symbol: "◇", label: "Issue activity" },
  pr: { symbol: "□", label: "PR activity" },
  review: { symbol: "◎", label: "PR review" },
  reviewComment: { symbol: "✎", label: "Review comment" },
  comment: { symbol: "◌", label: "Issue/PR comment" },
  commitComment: { symbol: "※", label: "Commit comment" },
  create: { symbol: "⊕", label: "Branch/tag created" },
  delete: { symbol: "⊖", label: "Branch/tag deleted" },
  release: { symbol: "★", label: "Release published" },
  fork: { symbol: "⑂", label: "Fork" },
  wiki: { symbol: "▤", label: "Wiki update" },
  member: { symbol: "♙", label: "Collaborator activity" },
  public: { symbol: "◉", label: "Repository made public" },
  star: { symbol: "☆", label: "Star" },
  discussion: { symbol: "☷", label: "Discussion" },
  other: { symbol: "·", label: "Other event" },
} as const;
export type ActivityKind = keyof typeof KINDS;

export function activityKind(event: FactoryActivity): ActivityKind {
  switch (event.type) {
    case "Deployment": return "deployment";
    case "IssuesEvent": return event.action === "opened" ? "issueOpened" : "issue";
    case "PushEvent": return "push";
    case "PullRequestEvent": return event.action === "merged" || (event.action === "closed" && event.merged === true) ? "merged" : "pr";
    case "PullRequestReviewEvent": return "review";
    case "PullRequestReviewCommentEvent": return "reviewComment";
    case "IssueCommentEvent": return "comment";
    case "CommitCommentEvent": return "commitComment";
    case "CreateEvent": return "create";
    case "DeleteEvent": return "delete";
    case "ReleaseEvent": return "release";
    case "ForkEvent": return "fork";
    case "GollumEvent": return "wiki";
    case "MemberEvent": return "member";
    case "PublicEvent": return "public";
    case "WatchEvent": return "star";
    case "DiscussionEvent": return "discussion";
    default: return "other";
  }
}

export interface TimelineMarker {
  event: FactoryActivity;
  kind: ActivityKind;
  position: number;
  lane: number;
}

/** Snapshot time is the right endpoint, not the newest event or the viewer's clock. */
export function layoutFactoryTimeline(activity: FactoryActivity[], generatedAt: string): TimelineMarker[] {
  const end = Date.parse(generatedAt);
  if (!Number.isFinite(end)) return [];
  const start = end - SEVEN_DAYS_MS;
  const lanes: number[] = [];
  return activity.map((event, index) => ({ event, index, time: Date.parse(event.createdAt) }))
    .filter(({ time }) => Number.isFinite(time) && time >= start && time <= end)
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ event, time }) => {
      const position = (time - start) / SEVEN_DAYS_MS * 100;
      // The track is at least 800px wide: 4% leaves room for a 28px marker.
      let lane = lanes.findIndex((previous) => position - previous >= 4);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = position;
      return { event, kind: activityKind(event), position, lane };
    });
}

const browserUrl = (raw?: string): string | undefined => {
  try { const url = new URL(raw ?? ""); return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : undefined; } catch { return undefined; }
};
const shortDate = (time: number): string => new Date(time).toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });

export interface TimelineMarkerView {
  kind: ActivityKind;
  symbol: string;
  /** Full accessible description, also shown in the tooltip. */
  label: string;
  date: string;
  /** Percent along the seven-day track. */
  position: number;
  lane: number;
  /** Only ever an https://github.com URL. */
  url?: string;
}

export interface TimelineView {
  range: string;
  note: string;
  legend: { symbol: string; label: string }[];
  axis: { left: number; iso: string; text: string }[];
  height: number;
  markers: TimelineMarkerView[];
}

const DEFAULT_NOTE = "Read-only GitHub snapshot; only returned records are shown. Events may be delayed or omitted; this is not a complete activity history. Deployments appear only from deployment creation records, not inferred pushes, releases or successful outcomes.";

/**
 * Plain data for the seven-day timeline. Layout and wording are decided here so
 * the interactive client only has to draw it; returns undefined for an invalid
 * snapshot date rather than drawing a misleading axis.
 */
export function factoryTimelineView(activity: FactoryActivity[], generatedAt: string, coverage?: string): TimelineView | undefined {
  const end = Date.parse(generatedAt);
  if (!Number.isFinite(end)) return undefined;
  const start = end - SEVEN_DAYS_MS;
  const markers = layoutFactoryTimeline(activity, generatedAt);
  const kinds = new Set<ActivityKind>(["deployment", "issueOpened", "push", "merged", ...markers.map(({ kind }) => kind)]);
  return {
    range: `${new Date(start).toISOString()} – ${new Date(end).toISOString()}`,
    note: coverage ?? DEFAULT_NOTE,
    legend: [...kinds].map((kind) => ({ symbol: KINDS[kind].symbol, label: KINDS[kind].label })),
    axis: Array.from({ length: 8 }, (_, day) => {
      const time = start + day * SEVEN_DAYS_MS / 7;
      return { left: day / 7 * 100, iso: new Date(time).toISOString(), text: shortDate(time) };
    }),
    height: 60 + Math.max(0, ...markers.map(({ lane }) => lane)) * 36,
    markers: markers.map(({ event, kind, position, lane }) => {
      const date = new Date(event.createdAt).toISOString();
      return {
        kind, symbol: KINDS[kind].symbol, date, position, lane, url: browserUrl(event.url),
        label: [KINDS[kind].label, kind === "other" ? event.type : "", event.details, event.actor ? `by ${event.actor}` : "", date].filter(Boolean).join(" · "),
      };
    }),
  };
}

