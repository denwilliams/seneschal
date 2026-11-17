import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "@api/api-types";
import { mergeActivity } from "./activity";
const entry = (id: string, at: string, updatedAt = at, interaction: ActivityEntry["interaction"] = "none"): ActivityEntry => ({ id, at, updatedAt, interaction, channel: { id: "C1" }, kind: "chat", title: id, snippet: id });
describe("activity polling/page merge", () => {
  it("deduplicates boundaries, preserves newest-first order and updates old prompts without pinning them", () => {
    const old = entry("approval", "2026-01-01", "2026-01-01", "pending");
    const recent = entry("new", "2026-01-02");
    const resolved = entry("approval", old.at, "2026-01-03", "resolved");
    const result = mergeActivity([recent, old], [resolved, recent]);
    expect(result.map((e) => e.id)).toEqual(["new", "approval"]);
    expect(result[1]!.interaction).toBe("resolved");
    expect(mergeActivity(result, [old])[1]!.interaction).toBe("resolved");
  });
});
