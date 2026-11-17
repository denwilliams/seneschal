import { describe, expect, it } from "vitest";
import { readCollapsed, SIDEBAR_KEY, writeCollapsed, type KeyValueStore } from "./sidebar";

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const broken: KeyValueStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };

describe("the collapsed workspace panel", () => {
  it("is expanded until someone collapses it", () => {
    expect(readCollapsed(memory())).toBe(false);
  });

  it("remembers the choice either way", () => {
    const store = memory();
    writeCollapsed(true, store);
    expect(store.data.get(SIDEBAR_KEY)).toBe("1");
    expect(readCollapsed(store)).toBe(true);
    writeCollapsed(false, store);
    expect(readCollapsed(store)).toBe(false);
  });

  it("treats anything unexpected in storage as expanded", () => {
    const store = memory();
    store.setItem(SIDEBAR_KEY, "yes please");
    expect(readCollapsed(store)).toBe(false);
  });

  it("works without storage: reads as expanded, and writing never throws", () => {
    expect(readCollapsed(broken)).toBe(false);
    expect(() => writeCollapsed(true, broken)).not.toThrow();
    expect(readCollapsed(undefined)).toBe(false);
    expect(() => writeCollapsed(true, undefined)).not.toThrow();
  });
});
