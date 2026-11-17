import assert from "node:assert/strict";
import { test } from "node:test";
import type { FactoryActivity } from "./dashboard.ts";
import { activityKind, layoutFactoryTimeline, factoryTimelineView, SEVEN_DAYS_MS } from "./timeline.ts";

const now = "2026-10-08T12:00:00.000Z";
const end = Date.parse(now);
const start = end - SEVEN_DAYS_MS;
const event = (time: number, type = "PushEvent"): FactoryActivity => ({ type, createdAt: new Date(time).toISOString() });

test("seven-day interval includes both boundaries, excludes old, future and invalid dates", () => {
  const markers = layoutFactoryTimeline([
    event(start - 1), event(end + 1), { type: "PushEvent", createdAt: "bad date" },
    event(start), event(end), event(start + SEVEN_DAYS_MS / 2),
  ], now);
  assert.deepEqual(markers.map(({ position }) => position), [0, 50, 100]);
  assert.deepEqual(markers.map(({ event }) => event.createdAt), [start, start + SEVEN_DAYS_MS / 2, end].map((time) => new Date(time).toISOString()));
  assert.deepEqual(layoutFactoryTimeline([event(end)], "bad date"), []);
  assert.equal(factoryTimelineView([], "bad date"), undefined);
});

test("placement is time-scaled, chronological, stable for ties and independent of newest event", () => {
  const markers = layoutFactoryTimeline([event(start + SEVEN_DAYS_MS / 2), event(start), event(start + SEVEN_DAYS_MS / 4), event(start, "IssuesEvent")], now);
  assert.deepEqual(markers.map(({ position }) => position), [0, 0, 25, 50]);
  assert.deepEqual(markers.map(({ lane }) => lane), [0, 1, 0, 0]);
  assert.equal(markers[1]!.event.type, "IssuesEvent");
  const view = factoryTimelineView(markers.map(({ event }) => event), now)!;
  assert.deepEqual(view.markers.map(({ position }) => position), [0, 0, 25, 50]);
  assert.deepEqual(view.markers.map(({ date }) => date), markers.map(({ event }) => event.createdAt));
});

test("crowded events retain exact timestamps in separate lanes without dropping records", () => {
  const markers = layoutFactoryTimeline(Array.from({ length: 100 }, () => event(end)), now);
  assert.equal(markers.length, 100);
  assert.equal(new Set(markers.map(({ lane }) => lane)).size, 100);
  assert.ok(markers.every(({ position }) => position === 100));
});

test("symbols distinguish actual merges, issue openings, reviews and every supported event", () => {
  const cases: [FactoryActivity, string][] = [
    [{ ...event(end, "Deployment") }, "deployment"],
    [{ ...event(end, "IssuesEvent"), action: "opened" }, "issueOpened"],
    [{ ...event(end, "IssuesEvent"), action: "closed" }, "issue"],
    [event(end, "PushEvent"), "push"],
    [{ ...event(end, "PullRequestEvent"), action: "closed", merged: true }, "merged"],
    [{ ...event(end, "PullRequestEvent"), action: "merged" }, "merged"],
    [{ ...event(end, "PullRequestEvent"), action: "closed", merged: false }, "pr"],
    [event(end, "PullRequestEvent"), "pr"],
    [event(end, "PullRequestReviewEvent"), "review"],
    [event(end, "PullRequestReviewCommentEvent"), "reviewComment"],
    [event(end, "IssueCommentEvent"), "comment"],
    [event(end, "CommitCommentEvent"), "commitComment"],
    [event(end, "CreateEvent"), "create"], [event(end, "DeleteEvent"), "delete"],
    [event(end, "ReleaseEvent"), "release"], [event(end, "ForkEvent"), "fork"],
    [event(end, "GollumEvent"), "wiki"], [event(end, "MemberEvent"), "member"],
    [event(end, "PublicEvent"), "public"], [event(end, "WatchEvent"), "star"],
    [event(end, "DiscussionEvent"), "discussion"], [event(end, "FutureEvent"), "other"],
  ];
  for (const [value, kind] of cases) assert.equal(activityKind(value), kind);
  const view = factoryTimelineView(cases.map(([value]) => value), now)!;
  const symbols = view.legend.map(({ symbol }) => symbol);
  assert.equal(symbols.length, 20);
  assert.equal(new Set(symbols).size, symbols.length);
  assert.ok(view.legend.some(({ label }) => label === "PR merged"));
  assert.ok(view.legend.some(({ label }) => label === "Issue opened"));
});

test("timeline data rejects unsafe event URLs and keeps every label", () => {
  const view = factoryTimelineView([
    { ...event(end), actor: '<img onerror="boom">', details: "<script>", url: "javascript:alert(1)" },
    { ...event(end, "<unknown>"), url: "https://evil.example/path" },
    { ...event(start, "IssuesEvent"), action: "opened", url: "https://github.com/acme/widget/issues/1" },
  ], now, "custom coverage")!;
  assert.deepEqual(view.markers.map(({ url }) => url), ["https://github.com/acme/widget/issues/1", undefined, undefined]);
  assert.match(view.markers[0]!.label, /Issue opened.*2026-10-01T12:00:00\.000Z/);
  assert.match(view.markers[1]!.label, /by <img onerror="boom">/);
  assert.equal(view.note, "custom coverage");
});

test("empty or out-of-window activity still has a seven-day axis and honest coverage note", () => {
  const view = factoryTimelineView([event(start - 1)], now)!;
  assert.equal(view.markers.length, 0);
  assert.equal(view.axis.length, 8);
  assert.match(view.note, /not a complete activity history/);
  assert.match(view.note, /not inferred pushes, releases or successful outcomes/);
  assert.equal(view.height, 60);
});
