import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineEvent } from "../agent/timeline.ts";
import { layoutGraph, summarize, STALE_RUN_MS } from "./timeline-graph.ts";

let n = 0;
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 18, 12, 0, 0) + minutes * 60_000).toISOString();
const ev = (minutes: number, partial: Partial<TimelineEvent> & Pick<TimelineEvent, "kind">): TimelineEvent => ({
  id: `e${(n++).toString(16).padStart(6, "0")}`, at: at(minutes), actor: "channel", title: partial.kind, ...partial,
});
const NOW = Date.parse(at(60));

test("a run is a branch: it forks from the main line when it starts and merges back with its report", () => {
  const layout = layoutGraph([
    ev(0, { kind: "turn.start", title: "please fix #7" }),
    ev(1, { kind: "run.start", actor: "coder", runKey: "sub-a", title: "coder started" }),
    ev(2, { kind: "tool", actor: "coder", runKey: "sub-a", title: "bash" }),
    ev(3, { kind: "run.end", actor: "coder", runKey: "sub-a", title: "coder done", status: "done" }),
    ev(4, { kind: "turn.end", title: "replied" }),
  ], NOW);
  assert.deepEqual(layout.rows.map((r) => [r.lane, r.shape]), [[0, "node"], [1, "fork"], [1, "node"], [1, "merge"], [0, "node"]]);
  // Main-line rows before and after the run have nothing else running; rows inside it have the branch open beside it.
  assert.deepEqual(layout.rows.map((r) => r.through), [[], [0], [0], [0], []]);
  assert.equal(layout.lanes, 1);
});

test("overlapping runs get lanes of their own, and a lane is reused after its run has merged", () => {
  const layout = layoutGraph([
    ev(0, { kind: "run.start", actor: "coder", runKey: "a" }),
    ev(1, { kind: "run.start", actor: "reviewer", runKey: "b" }),
    ev(2, { kind: "run.end", actor: "coder", runKey: "a", status: "done" }),
    ev(3, { kind: "run.start", actor: "github_triage", runKey: "c" }),
    ev(4, { kind: "run.end", actor: "reviewer", runKey: "b", status: "done" }),
    ev(5, { kind: "run.end", actor: "github_triage", runKey: "c", status: "done" }),
  ], NOW);
  const lanes = Object.fromEntries(layout.rows.map((r) => [`${r.event.runKey}:${r.event.kind}`, r.lane]));
  assert.equal(lanes["a:run.start"], 1);
  assert.equal(lanes["b:run.start"], 2);
  assert.equal(lanes["c:run.start"], 1, "a's lane is free again");
  assert.equal(layout.lanes, 2);
  // While b runs beside a, a's row sees both branches open.
  const aEnd = layout.rows.find((r) => r.event.runKey === "a" && r.event.kind === "run.end")!;
  assert.deepEqual(aEnd.through, [0, 2]);
});

test("a branch whose start fell out of the log is drawn open to the older side", () => {
  const layout = layoutGraph([ev(5, { kind: "tool", actor: "coder", runKey: "gone" }), ev(6, { kind: "run.end", actor: "coder", runKey: "gone", status: "done" })], NOW);
  assert.equal(layout.rows[0]!.fromOlder, true);
  assert.equal(layout.rows[0]!.lane, 1);
  assert.deepEqual(layout.rows[0]!.through, [0]);
});

test("a run that never reported and went quiet is a dead branch, not a running one", () => {
  const events = [
    ev(0, { kind: "run.start", actor: "coder", runKey: "crashed" }),
    ev(1, { kind: "tool", actor: "coder", runKey: "crashed", title: "bash" }),
  ];
  const stale = layoutGraph(events, Date.parse(at(1)) + STALE_RUN_MS + 60_000);
  assert.equal(stale.rows[1]!.dead, true);
  assert.deepEqual(layoutGraph(events, Date.parse(at(1)) + 60_000).rows.map((r) => r.dead), [false, false], "recent: still running");
  // Its lane is released, so a later run starts on the lane it used.
  const later = layoutGraph([...events, ev(300, { kind: "run.start", actor: "coder", runKey: "next" })], Date.parse(at(300)) + 1000);
  assert.equal(later.rows.at(-1)!.lane, 1);
});

test("the summary counts branches, outcomes and cost", () => {
  const s = summarize([
    ev(0, { kind: "run.start", runKey: "a" }), ev(1, { kind: "tool", runKey: "a" }), ev(2, { kind: "run.end", runKey: "a", status: "done", costUsd: 0.5 }),
    ev(3, { kind: "run.start", runKey: "b" }), ev(4, { kind: "run.end", runKey: "b", status: "failed", costUsd: 0.25 }),
  ]);
  assert.deepEqual(s, { runs: 2, byStatus: { done: 1, failed: 1 }, costUsd: 0.75, tools: 1 });
});
