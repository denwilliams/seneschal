import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureSharedDirs } from "../workspace/paths.ts";
import {
  formatUsageReport,
  parseUsageWindow,
  summarizeUsage,
  UsageLog,
  type UsageLogRecord,
} from "./usage.ts";

function usage(input = 10, output = 5, cost = 0.001) {
  return {
    input,
    output,
    cacheRead: 2,
    cacheWrite: 1,
    reasoning: 1,
    totalTokens: input + output + 3,
    cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function record(overrides: Partial<UsageLogRecord> = {}): UsageLogRecord {
  return {
    version: 1,
    at: "2026-09-05T12:00:00.000Z",
    channelId: "C1",
    channelName: "admin",
    threadKey: "1700.1",
    source: "agent",
    provider: "openai",
    model: "gpt-5.4",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 1,
    totalTokens: 18,
    costUsd: 0.001,
    cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    ...overrides,
  };
}

test("usage log appends JSONL records and queries by channel and time", () => {
  const shared = ensureSharedDirs(mkdtempSync(join(tmpdir(), "usage-")));
  const log = new UsageLog(shared);

  log.append({
    at: new Date("2026-09-01T12:00:00Z"),
    channelId: "C1",
    channelName: "admin",
    threadKey: "t1",
    source: "agent",
    provider: "openai",
    model: "gpt-5.4",
    usage: usage(100, 50, 0.02),
  });
  log.append({
    at: new Date("2026-09-03T12:00:00Z"),
    channelId: "C2",
    source: "recent-conversation",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: usage(10, 5, 0.001),
  });

  assert.equal(log.read().length, 2);
  assert.equal(log.query({ channelId: "C1" }).length, 1);
  assert.equal(log.query({ since: new Date("2026-09-02T00:00:00Z") }).length, 1);
});

test("usage summary groups by channel, model, and day", () => {
  const summary = summarizeUsage([
    record(),
    record({ channelId: "C2", channelName: "engineering", provider: "deepseek", model: "deepseek-v4-pro", totalTokens: 40 }),
    record({ at: "2026-09-06T00:00:00.000Z", totalTokens: 5 }),
  ]);

  assert.equal(summary.calls, 3);
  assert.equal(summary.totalTokens, 63);
  assert.equal(summary.unknownCostCalls, 0);
  assert.deepEqual(summary.byChannel.map((g) => g.label), ["#engineering", "#admin"]);
  assert.deepEqual(summary.byModel.map((g) => g.key), ["deepseek/deepseek-v4-pro", "openai/gpt-5.4"]);
  assert.deepEqual(summary.byDay.map((g) => g.key), ["2026-09-05", "2026-09-06"]);
});

test("usage log skips structurally invalid JSON records", () => {
  const shared = ensureSharedDirs(mkdtempSync(join(tmpdir(), "usage-")));
  const log = new UsageLog(shared);
  writeFileSync(
    log.path,
    [
      JSON.stringify(record()),
      JSON.stringify(record({ at: "not a date" })),
      JSON.stringify(record({ source: "unknown" as never })),
      JSON.stringify(record({ cacheReadTokens: Number.NaN })),
      JSON.stringify(record({ reasoningTokens: Number.POSITIVE_INFINITY })),
      JSON.stringify(record({ costUsd: -1 })),
      "{not-json",
      "",
    ].join("\n"),
  );

  assert.equal(log.read().length, 1);
});

test("usage summary distinguishes unknown cost from free usage", () => {
  const summary = summarizeUsage([record(), record({ costUsd: undefined, cost: undefined })]);
  assert.equal(summary.calls, 2);
  assert.equal(summary.costUsd, 0.001);
  assert.equal(summary.unknownCostCalls, 1);
  assert.match(
    formatUsageReport({ summary, window: { label: "all time" }, scopeLabel: "#admin" }),
    /\$0\.0010 \+ 1 unknown/,
  );
});

test("usage windows parse common report ranges", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  assert.equal(parseUsageWindow(undefined, now).label, "last 7 days");
  assert.equal(parseUsageWindow("today", now).label, "today");
  assert.equal(parseUsageWindow("24h", now).since?.toISOString(), "2026-09-04T12:00:00.000Z");
  assert.equal(parseUsageWindow("all", now).since, undefined);
  assert.throws(() => parseUsageWindow("soon", now), /Usage:/);
});

test("usage reports are Slack-readable", () => {
  const text = formatUsageReport({
    summary: summarizeUsage([record(), record({ channelId: "C2", channelName: "engineering", totalTokens: 40 })]),
    window: { label: "last 7 days" },
    scopeLabel: "all channels",
  });

  assert.match(text, /\*Token usage — all channels, last 7 days\*/);
  assert.match(text, /\*By channel\*/);
  assert.match(text, /#engineering/);
});
