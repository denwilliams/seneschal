import { describe, expect, it } from "vitest";
import { graphCell, graphWidth, laneColor, laneX, showStatusBadge, statusRing, statusTone, timelineCost, timelineDuration, LANE_COLORS, ROW_H } from "./timeline";

const row = (over: Partial<Parameters<typeof graphCell>[0]> = {}) => ({ lane: 0, shape: "node" as const, dead: false, through: [] as number[], kind: "turn.start" as const, status: undefined as string | undefined, ...over });

describe("graph geometry", () => {
  it("sizes the cell from the lane count and places lanes 18px apart", () => {
    expect(graphWidth(0)).toBe(34);
    expect(graphWidth(2)).toBe(70);
    expect(laneX(0)).toBe(17);
    expect(laneX(2)).toBe(53);
  });
  it("draws the main line straight through lane 0", () => {
    const cell = graphCell(row(), 0);
    expect(cell.paths).toEqual([{ d: "M17 0V34", lane: 0, dashed: false }]);
    expect(cell.dot).toMatchObject({ cx: 17, cy: ROW_H / 2, r: 5, lane: 0, dead: false });
  });
  it("draws a fork as a stub up plus a curve down into the main line", () => {
    const cell = graphCell(row({ lane: 1, shape: "fork" }), 1);
    expect(cell.paths.map((p) => p.d)).toEqual(["M35 17V0", "M35 17C35 34 17 17 17 34"]);
    expect(cell.dot.r).toBe(6);
  });
  it("draws a dead fork without the stub upwards", () => {
    const cell = graphCell(row({ lane: 1, shape: "fork", dead: true }), 1);
    expect(cell.paths.map((p) => p.d)).toEqual(["M35 17C35 34 17 17 17 34"]);
    expect(cell.dot.dead).toBe(true);
  });
  it("draws a merge as a stub down plus a curve up into the main line", () => {
    const cell = graphCell(row({ lane: 2, shape: "merge" }), 2);
    expect(cell.paths.map((p) => p.d)).toEqual(["M53 17V34", "M53 17C53 0 17 17 17 0"]);
  });
  it("draws a branch that ends quietly as a dashed half line", () => {
    const cell = graphCell(row({ lane: 1, dead: true }), 1);
    expect(cell.paths).toEqual([{ d: "M35 17V34", lane: 1, dashed: true }]);
  });
  it("draws a step on a live branch as a full line, and adds the lanes passing through", () => {
    const cell = graphCell(row({ lane: 1, through: [0, 2] }), 2);
    expect(cell.paths.map((p) => [p.lane, p.d])).toEqual([[0, "M17 0V34"], [2, "M53 0V34"], [1, "M35 0V34"]]);
  });
  it("keeps a branch that continues from older rows as a full line (fromOlder rows are drawn as ordinary steps)", () => {
    const cell = graphCell(row({ lane: 1, through: [0] }), 1);
    expect(cell.paths.at(-1)).toEqual({ d: "M35 0V34", lane: 1, dashed: false });
  });
  it("makes tool dots small and rings failed or blocked rows", () => {
    expect(graphCell(row({ kind: "tool" }), 0).dot.r).toBe(3);
    expect(graphCell(row({ kind: "tool", shape: "fork", lane: 1 }), 1).dot.r).toBe(6);
    expect(graphCell(row({ status: "failed" }), 0).dot.ring).toBe("#d1495b");
    expect(graphCell(row({ status: "blocked" }), 0).dot.ring).toBe("#c9a227");
    expect(graphCell(row({ status: "done" }), 0).dot.ring).toBeUndefined();
  });
});

describe("lane colours and status", () => {
  it("cycles eight colours", () => {
    expect(laneColor(0)).toBe("#4c8dd6");
    expect(laneColor(7)).toBe("#7b8794");
    expect(laneColor(8)).toBe(laneColor(0));
    expect(laneColor(9)).toBe(LANE_COLORS[1]);
  });
  it("rings the bad endings red and the stalls amber", () => {
    for (const s of ["failed", "error", "denied", "interrupted"]) expect(statusRing(s)).toBe("#d1495b");
    for (const s of ["blocked", "needs_input", "needs-input"]) expect(statusRing(s)).toBe("#c9a227");
    expect(statusRing(undefined)).toBeUndefined();
  });
  it("classifies tones, and hides a tool's ordinary status badge", () => {
    expect(statusTone("done")).toBe("good");
    expect(statusTone("denied")).toBe("bad");
    expect(statusTone("needs_input")).toBe("warn");
    expect(statusTone("whatever")).toBe("neutral");
    expect(showStatusBadge({ kind: "tool", status: "ok" })).toBe(false);
    expect(showStatusBadge({ kind: "tool", status: "error" })).toBe(true);
    expect(showStatusBadge({ kind: "run.end", status: "done" })).toBe(true);
    expect(showStatusBadge({ kind: "run.end", status: undefined })).toBe(false);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(timelineDuration(undefined)).toBeUndefined();
    expect(timelineDuration(850)).toBe("850ms");
    expect(timelineDuration(12_400)).toBe("12s");
    expect(timelineDuration(185_000)).toBe("3m 5s");
    expect(timelineDuration(3_720_000)).toBe("1h 2m");
  });
  it("formats cost, hiding zero", () => {
    expect(timelineCost(0)).toBeUndefined();
    expect(timelineCost(undefined)).toBeUndefined();
    expect(timelineCost(0.0042)).toBe("$0.0042");
    expect(timelineCost(1.5)).toBe("$1.50");
  });
});
