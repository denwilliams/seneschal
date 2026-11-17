import { describe, expect, it } from "vitest";
import { childrenOf, kindOf, LONG_STRING, pathLabel, percentOf, remaining, sizeLabel, startsOpen, summarize, truncateString, visibleCount } from "./state-tree";

describe("kindOf and summarize", () => {
  it("tells the six JSON kinds apart", () => {
    expect([{}, [], "s", 1, true, null].map((v) => kindOf(v as never))).toEqual(["object", "array", "string", "number", "boolean", "null"]);
  });
  it("summarizes a collapsed container, with the singular", () => {
    expect(summarize({ a: 1, b: 2, c: 3 })).toBe("{3 keys}");
    expect(summarize({ a: 1 })).toBe("{1 key}");
    expect(summarize([1, 2])).toBe("[2 items]");
    expect(summarize([1])).toBe("[1 item]");
    expect(summarize({})).toBe("{0 keys}");
    expect(summarize("text")).toBe("");
  });
});

describe("childrenOf", () => {
  it("keeps object order and indexes array items", () => {
    expect(childrenOf({ z: 1, a: 2 })).toEqual([["z", 1], ["a", 2]]);
    expect(childrenOf(["x", "y"])).toEqual([["0", "x"], ["1", "y"]]);
    expect(childrenOf(5)).toEqual([]);
  });
});

describe("paging a long array", () => {
  it("draws the first 50, then 50 more each time", () => {
    expect(visibleCount(10, 1)).toBe(10);
    expect(visibleCount(120, 1)).toBe(50);
    expect(visibleCount(120, 2)).toBe(100);
    expect(visibleCount(120, 3)).toBe(120);
    expect(remaining(120, 1)).toBe(70);
    expect(remaining(120, 3)).toBe(0);
    expect(visibleCount(120, 0)).toBe(50);
  });
});

describe("truncateString", () => {
  it("leaves short strings alone and cuts long ones, saying so", () => {
    expect(truncateString("short")).toEqual({ text: "short", truncated: false });
    const cut = truncateString("x".repeat(LONG_STRING + 30));
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe(`${"x".repeat(LONG_STRING)}…`);
    expect(truncateString("x".repeat(LONG_STRING)).truncated).toBe(false);
  });
});

describe("size and path labels", () => {
  it("writes a size against its limit", () => {
    expect(sizeLabel(3277, 65536)).toBe("3.2 KB of 64 KB");
    expect(sizeLabel(900, 65536)).toBe("900 B of 64 KB");
    expect(sizeLabel(0, 65536)).toBe("0 B of 64 KB");
    expect(percentOf(32768, 65536)).toBe(50);
    expect(percentOf(999999, 65536)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
  });
  it("opens the top two levels by default", () => {
    expect([0, 1, 2, 3].map(startsOpen)).toEqual([true, true, false, false]);
  });
  it("shows the root as a slash", () => {
    expect([pathLabel(""), pathLabel("/jobs/last")]).toEqual(["/", "/jobs/last"]);
  });
});
