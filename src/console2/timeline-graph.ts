import type { TimelineEvent } from "../agent/timeline.ts";

/**
 * The timeline drawn like `git log --graph`: the channel agent is the main line (lane 0), and each subagent run is a
 * branch that forks off it when the run starts and merges back when its report arrives. Runs that overlap get lanes of
 * their own; a lane is reused once its run has merged.
 *
 * Layout is a pure function of the events, so it is easy to test; drawing escapes everything it prints.
 */

/** A run with no end this long after its last step is drawn as a dead branch, not as still running. */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

export type RowShape = "node" | "fork" | "merge";

export interface GraphRow {
  event: TimelineEvent;
  lane: number;
  /** `fork`: a run starts here. `merge`: its report arrives. `node`: any other step. */
  shape: RowShape;
  /** The branch ends here without merging: it never reported, and has been quiet too long to be running. */
  dead: boolean;
  /** Lanes with a line running straight through this row (the main line included, unless the dot is on it). */
  through: number[];
  /** The branch carries on from before the earliest event we have (its start was cut off). */
  fromOlder: boolean;
}

export interface GraphLayout {
  /** Oldest first. */
  rows: GraphRow[];
  /** Highest lane used. */
  lanes: number;
}

export function layoutGraph(events: readonly TimelineEvent[], now = Date.now()): GraphLayout {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const ended = new Set<string>();
  const lastIndex = new Map<string, number>();
  ordered.forEach((event, index) => {
    if (!event.runKey) return;
    lastIndex.set(event.runKey, index);
    if (event.kind === "run.end") ended.add(event.runKey);
  });

  const laneOf = new Map<string, number>();
  const open = new Set<number>([0]);
  const allocate = (runKey: string): number => {
    const used = new Set(laneOf.values());
    let lane = 1;
    while (used.has(lane)) lane++;
    laneOf.set(runKey, lane);
    return lane;
  };

  const rows: GraphRow[] = [];
  let lanes = 0;
  ordered.forEach((event, index) => {
    const before = new Set(open);
    let lane = 0;
    let shape: RowShape = "node";
    let dead = false;
    let fromOlder = false;
    const runKey = event.runKey;
    if (runKey) {
      let known = laneOf.get(runKey);
      if (known === undefined) {
        known = allocate(runKey);
        // A run whose start has scrolled out of the log still deserves a lane, open to the older side.
        if (event.kind !== "run.start") { fromOlder = true; before.add(known); }
      }
      lane = known;
      open.add(lane);
      if (event.kind === "run.start") shape = "fork";
      else if (event.kind === "run.end") shape = "merge";
      if (shape === "merge") {
        open.delete(lane);
        laneOf.delete(runKey);
      } else if (!ended.has(runKey) && lastIndex.get(runKey) === index && now - Date.parse(event.at) > STALE_RUN_MS) {
        dead = true;
        open.delete(lane);
        laneOf.delete(runKey);
      }
    }
    const after = new Set(open);
    rows.push({
      event, lane, shape, dead, fromOlder,
      through: [...before].filter((l) => after.has(l) && l !== lane).sort((a, b) => a - b),
    });
    lanes = Math.max(lanes, lane, ...before, ...after);
  });
  return { rows, lanes };
}

/** Totals for the header: how many branches, how they ended, and what they cost. */
export function summarize(events: readonly TimelineEvent[]): { runs: number; byStatus: Record<string, number>; costUsd: number; tools: number } {
  const byStatus: Record<string, number> = {};
  let runs = 0;
  let costUsd = 0;
  let tools = 0;
  for (const event of events) {
    if (event.kind === "run.start") runs++;
    if (event.kind === "run.end") {
      byStatus[event.status ?? "done"] = (byStatus[event.status ?? "done"] ?? 0) + 1;
      costUsd += event.costUsd ?? 0;
    }
    if (event.kind === "tool") tools++;
  }
  return { runs, byStatus, costUsd, tools };
}
