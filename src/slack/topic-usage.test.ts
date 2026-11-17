import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UsageLog, type UsageLogRecord } from "../agent/usage.ts";
import { ensureSharedDirs } from "../workspace/paths.ts";
import { formatTopicUsage, syncTopicUsage, topicUsageSnapshot } from "./topic-usage.ts";

const now = new Date("2026-09-05T12:00:00.000Z");

function record(overrides: Partial<UsageLogRecord> = {}): UsageLogRecord {
  return {
    version: 1,
    at: "2026-09-05T11:30:00.000Z",
    channelId: "C1",
    source: "agent",
    provider: "openai",
    model: "gpt-5.4",
    inputTokens: 320_000,
    outputTokens: 0,
    cacheReadTokens: 90_000,
    cacheWriteTokens: 10_000,
    totalTokens: 420_000,
    costUsd: 0.14,
    ...overrides,
  };
}

function logWith(records: UsageLogRecord[]): UsageLog {
  const shared = ensureSharedDirs(mkdtempSync(join(tmpdir(), "topic-usage-")));
  const log = new UsageLog(shared);
  writeFileSync(log.path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return log;
}

test("topic usage aggregates every channel and renders non-cached/cache tokens separately", () => {
  const log = logWith([
    record(),
    record({
      at: "2026-09-04T13:00:00.000Z",
      channelId: "C2",
      inputTokens: 2_080_000,
      cacheReadTokens: 650_000,
      cacheWriteTokens: 50_000,
      totalTokens: 2_780_000,
      costUsd: 0.94,
    }),
    record({ at: "2026-09-04T11:59:59.999Z", channelId: "C3", totalTokens: 99_999_999 }),
  ]);

  const snapshot = topicUsageSnapshot(log, now);
  assert.equal(
    snapshot.topic,
    "🤖 1h: 320k [+100k] ~$0.14 | 24h: 2.4M [+800k] ~$1.08",
  );
  assert.equal(snapshot.oneHour.records.length, 1);
  assert.equal(snapshot.twentyFourHours.records.length, 2);
  assert.equal(formatTopicUsage(snapshot.oneHour, snapshot.twentyFourHours), snapshot.topic);
});

test("topic usage labels unknown and partial cost instead of rendering zero", () => {
  const unknown = topicUsageSnapshot(logWith([record({ costUsd: undefined })]), now);
  assert.match(unknown.topic!, /~unknown/);
  assert.doesNotMatch(unknown.topic!, /~\$0(?:\D|$)/);

  const partial = topicUsageSnapshot(logWith([record(), record({ costUsd: undefined })]), now);
  assert.match(partial.topic!, /~\$0\.14 \+ unknown/);
});

test("topic usage does not overwrite a human topic and skips an unchanged feature topic", async () => {
  const log = logWith([record()]);
  const changed: string[] = [];
  assert.equal(
    await syncTopicUsage({
      log,
      now,
      botUserId: "UBOT",
      getChannel: async () => ({ topic: { value: "Human project notes" }, isPrivate: false }),
      setTopic: async (topic): Promise<void> => { changed.push(topic); },
    }),
    "human-topic",
  );
  assert.equal(changed.length, 0);

  const topic = topicUsageSnapshot(log, now).topic!;
  assert.equal(
    await syncTopicUsage({
      log,
      now,
      botUserId: "UBOT",
      getChannel: async () => ({ topic: { value: topic, creator: "UBOT" }, isPrivate: false }),
      setTopic: async (next): Promise<void> => { changed.push(next); },
    }),
    "unchanged",
  );
  assert.equal(changed.length, 0);
});

test("topic usage preserves a human-authored robot-prefixed topic", async () => {
  const changed: string[] = [];
  const result = await syncTopicUsage({
    log: logWith([record()]),
    now,
    botUserId: "UBOT",
    getChannel: async () => ({
      topic: { value: "🤖 Human-authored robotics project notes", creator: "UHUMAN" },
      isPrivate: false,
    }),
    setTopic: async (topic): Promise<void> => { changed.push(topic); },
  });

  assert.equal(result, "human-topic");
  assert.equal(changed.length, 0);
});

test("topic usage refuses a private channel without changing its topic", async () => {
  const changed: string[] = [];
  const result = await syncTopicUsage({
    log: logWith([record()]),
    now,
    botUserId: "UBOT",
    getChannel: async () => ({ topic: { value: "" }, isPrivate: true }),
    setTopic: async (topic): Promise<void> => { changed.push(topic); },
  });

  assert.equal(result, "private-channel");
  assert.deepEqual(changed, []);
});

test("topic usage writes an empty or owned topic, and clears an owned topic once usage expires", async () => {
  const used = logWith([record()]);
  const changed: string[] = [];
  assert.equal(
    await syncTopicUsage({
      log: used,
      now,
      botUserId: "UBOT",
      getChannel: async () => ({ topic: { value: "" }, isPrivate: false }),
      setTopic: async (topic): Promise<void> => { changed.push(topic); },
    }),
    "updated",
  );
  assert.equal(changed.length, 1);
  assert.match(changed[0]!, /^🤖 /);

  const empty = logWith([]);
  assert.equal(
    await syncTopicUsage({
      log: empty,
      now,
      botUserId: "UBOT",
      getChannel: async () => ({ topic: { value: "🤖 1h: old", creator: "UBOT" }, isPrivate: false }),
      setTopic: async (topic): Promise<void> => { changed.push(topic); },
    }),
    "cleared",
  );
  assert.equal(changed.at(-1), "");
  const countAfterClear = changed.length;
  assert.equal(
    await syncTopicUsage({
      log: empty,
      now,
      botUserId: "UBOT",
      getChannel: async () => ({ topic: { value: "Human project notes" }, isPrivate: false }),
      setTopic: async (topic): Promise<void> => { changed.push(topic); },
    }),
    "unchanged",
  );
  assert.equal(changed.length, countAfterClear, "a zero-usage human topic is never changed");
});
