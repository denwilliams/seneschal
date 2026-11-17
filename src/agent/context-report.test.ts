import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { RecentConversationList } from "./recent-conversations.ts";
import { buildContextUsageReport } from "./context-report.ts";

function runtime() {
  const model = {
    id: "test-model",
    provider: "test",
    name: "Test Model",
    contextWindow: 100_000,
    input: ["text"],
  } as any;
  return {
    getProviders: () => [{ id: "test", name: "Test" } as any],
    getModels: () => [model],
    getModel: (provider: string, id: string) => provider === "test" && id === "test-model" ? model : undefined,
    hasConfiguredAuth: () => true,
  } as any;
}

function channelFor(configInput: unknown) {
  const dataDir = mkdtempSync(join(tmpdir(), "context-report-"));
  const config = HarnessConfigSchema.parse(configInput);
  const { channel } = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "eng", isDm: false },
    new ChannelRegistry(dataDir),
  );
  assert.ok(channel);
  return channel;
}

test("context report shows fresh overhead and separates memory from fresh prompt", () => {
  const channel = channelFor({
    defaults: { model: "test/test-model" },
    channels: { eng: { tools: ["read", "write", "web"], schedules: true } },
  });
  writeFileSync(channel.memory.channelFile, "Den prefers reviewed PRs before deployment.\n");
  new RecentConversationList(channel.paths.recentConversationsFile).upsert(
    {
      threadKey: "1710000000.000001",
      summary: "Den asked to see fresh context usage.",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summarizedAt: "2026-01-01T00:01:00.000Z",
    },
    10,
  );

  const report = buildContextUsageReport({
    channel,
    threadKey: "1710000000.000002",
    harnessName: "Harness",
    slackChannelLabel: "#eng",
    botUserId: "U0",
    modelRuntime: runtime(),
  });

  assert.match(report, /Fresh context estimate for #eng/);
  assert.match(report, /Fresh-start overhead: \*[\d,]+ tokens\*/);
  assert.match(report, /System prompt/);
  assert.match(report, /Available skills list/);
  assert.match(report, /Tool definitions/);
  assert.match(report, /Recent conversations/);
  assert.match(report, /Memory files: 0 fresh tokens \([\d,]+ if recalled in full\)/);
  assert.match(report, /Slack backfill: up to thread/);
});

test("context report counts skill list separately from skill bodies", () => {
  const channel = channelFor({
    defaults: { model: "test/test-model" },
    channels: { eng: { share: { skills: [] } } },
  });
  const skillDir = join(channel.paths.skills, "weekly-report");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: weekly-report\ndescription: Produce the Friday rollup. Use when asked for the weekly report.\n---\n\nLong instructions live here.\n",
  );

  const report = buildContextUsageReport({
    channel,
    threadKey: "t",
    harnessName: "Harness",
    slackChannelLabel: "#eng",
    botUserId: "U0",
    modelRuntime: runtime(),
  });

  assert.match(report, /Available skills list: [\d,]+ tokens .* — \d+ skill\(s\); bodies load only when a skill is read/);
  assert.match(report, /Skill bodies: 0 fresh tokens \([\d,]+ if all read in full\)/);
});

test("the context report measures post_as_user only for a channel that may post as a person", async () => {
  const { contextToolDefinitions } = await import("./context-report.ts");
  const opts = { threadKey: "t", harnessName: "Harness", slackChannelLabel: "#eng", botUserId: "U0", modelRuntime: runtime() };
  const withPostAs = channelFor({
    defaults: { model: "test/test-model" },
    agentSets: { guards: { agents: { post_guard: { description: "Reviews posts.", tools: [] } } } },
    channels: { eng: { agentSet: "guards", share: { postAs: { user: "U01OWNER1", reviewer: "post_guard" } } } },
  });
  const without = channelFor({ defaults: { model: "test/test-model" }, channels: { eng: {} } });
  const names = (channel: typeof without, extra: Record<string, unknown> = {}) =>
    contextToolDefinitions({ ...opts, channel, ...extra }).map((tool) => tool.name);
  assert.ok(names(withPostAs).includes("post_as_user"));
  assert.ok(!names(without).includes("post_as_user"));
  assert.ok(!names(withPostAs, { canPost: false }).includes("post_as_user"), "headless callers that cannot post are not counted");
});
