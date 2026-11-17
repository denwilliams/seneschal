import { rmSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.ts";
import { buildSession, usageSummary } from "./session.ts";
import { usageRecord } from "../agent/usage.ts";

test("heartbeat usage is durable, isolated and distinguishable from schedules/conversations", async () => {
  const f = fixture();
  try {
    for (const [channelId, source, tokens] of [[f.channelId, "heartbeat", 42], [f.channelId, "scheduled", 18], ["OTHER", "heartbeat", 999]] as const) {
      f.source.usage.append({ channelId, source, provider: "test", model: "test", usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens } as any });
    }
    const s = await buildSession(f.source, f.source.channels()[0]!, undefined);
    assert.deepEqual(s.usage.bySource!.find((row) => row.source === "heartbeat"), { source: "heartbeat", calls: 1, tokens: 42, costUsd: 0, unpricedCalls: 1 });
    assert.equal(s.usage.bySource!.find((row) => row.source === "scheduled")!.tokens, 18);
    assert.ok(s.usage.bySource!.some((row) => row.source === "agent"));
    assert.equal(f.source.usage.query({ channelId: f.channelId, sources: ["heartbeat"] }).length, 1);
    const priced = usageRecord({ channelId: "C", source: "heartbeat", provider: "test", model: "test", usage: { input: 10, output: 1, cacheRead: 20, cacheWrite: 0, totalTokens: 31, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0, total: 0.06 } } });
    assert.deepEqual(usageSummary([priced]).bySource![0], { source: "heartbeat", calls: 1, tokens: 31, costUsd: 0.06, unpricedCalls: 0 });
    assert.equal(usageSummary([]).bySource![0]!.calls, 0);
  } finally { rmSync(f.dataDir, { recursive: true, force: true }); }
});
