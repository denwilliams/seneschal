import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelRuntimes } from "../agent/channel-runtime.ts";
import { DreamState } from "../agent/dream.ts";
import type { ScheduledTask } from "../agent/schedules.ts";
import type { ScheduledTaskRunResult } from "./scheduler.ts";
import { createThreadSession, type CreateThreadSessionOptions } from "../agent/session.ts";
import { stageRun, startSubagentStage } from "../agent/subagent-task.ts";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel, type ResolvedChannel } from "../workspace/resolve.ts";
import { HarnessApp } from "./app.ts";
import { appSubagentHost } from "./factory-wiring.ts";

const TIMEZONE = "Asia/Kathmandu";

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "time-wiring-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({
    schedules: { timezone: TIMEZONE },
    // A dream timer override must not change the clock tool's harness default.
    dreams: { timezone: "America/New_York", announce: false },
    agentSets: { team: { agents: { reader: { description: "Read the clock", tools: [], model: "fixture/model" } } } },
    channels: { general: { model: "fixture/model", tools: [], schedules: false, agentSet: "team" } },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const runtimes = new ChannelRuntimes({
    modelRuntime,
    subagentHost: appSubagentHost({
      harnessName: () => config.name, botUserId: () => "UBOT", defaultTimezone: () => config.schedules.timezone,
      onSubagentMessage: () => undefined,
    }),
  });
  // Exercise the app's actual session entry points without starting a Slack connection.
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config, opts: { config, dataDir, modelRuntime }, runtimes, botUserId: "UBOT",
    dreamSettings: { ...config.dreams, timezone: config.dreams.timezone! },
    resolveBackgroundChannel: async () => ({ channel }),
  }) as {
    baseSessionOptions(channel: ResolvedChannel, config: HarnessConfig): Omit<CreateThreadSessionOptions, "threadKey">;
    runQuietScheduledTask(channel: ResolvedChannel, task: ScheduledTask): Promise<ScheduledTaskRunResult>;
    runDream(channelId: string): Promise<void>;
  };
  t.after(async () => { await runtimes.closeAll(); rmSync(dataDir, { recursive: true, force: true }); });
  const live = () => createThreadSession({ ...harness.baseSessionOptions(channel, config), threadKey: "1.1", initialUserId: "U1" });
  return { faux, channel, runtimes, config, harness, live };
}

const clockCall = (id: string) => fauxAssistantMessage(fauxToolCall("get_current_time", {}, { id }) as never, { stopReason: "toolUse" });

function assertClock(context: TranscriptContext | undefined, before: number) {
  assert.ok(context, "the model was called after executing get_current_time");
  const result = context.messages.find((m) => m.role === "toolResult" && m.toolName === "get_current_time");
  assert.ok(result && result.role === "toolResult" && !result.isError);
  const block = result.content[0]!;
  assert.equal(block.type, "text");
  assert.ok(block.type === "text");
  const clock = JSON.parse(block.text);
  assert.equal(clock.timezone, TIMEZONE);
  assert.equal(clock.utcOffset, "+05:45");
  assert.ok(Date.parse(clock.timestamp) >= before && Date.parse(clock.timestamp) <= Date.now());
  const names = context.messages.filter((m) => m.role === "system")
    .flatMap((m) => ((m as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((tool) => tool.name));
  assert.ok(names.includes("get_current_time"));
  assert.ok(!names.includes("bash") && !names.includes("schedule_task"));
}

for (const mode of ["live", "quiet scheduled"] as const) {
  test(`${mode} parents and their subagents execute the clock in the configured non-UTC timezone without shell access`, async (t) => {
    const f = await fixture(t);
    let parent: TranscriptContext | undefined;
    let child: TranscriptContext | undefined;
    f.faux.setResponses([
      clockCall("parent-clock"),
      (context) => {
        parent = context;
        return fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "reader", task: "Check the time" }, { id: "run-reader" }), { stopReason: "toolUse" });
      },
      clockCall("child-clock"),
      (context) => { child = context; return fauxAssistantMessage("STATUS: done\nNEXT: none\nChecked the clock."); },
      fauxAssistantMessage("Both clocks checked."),
    ]);
    const before = Date.now();
    if (mode === "live") {
      const session = await f.live();
      try { await session.session.prompt("Check both clocks", { requestId: "clocks", userId: "U1" }); }
      finally { await session.dispose(); }
    } else {
      const result = await f.harness.runQuietScheduledTask(f.channel, {
        id: "clock", channelId: "C1", createdBy: "U1", prompt: "Check both clocks", quiet: true,
        timezone: "America/New_York", createdAt: new Date().toISOString(), runCount: 0,
      });
      assert.equal(result.status, "completed");
    }
    assert.equal(f.faux.state.callCount, 5);
    assertClock(parent, before);
    assertClock(child, before);
  });
}

test("the app's headless task host propagates the harness timezone to subagent clock execution", async (t) => {
  const f = await fixture(t);
  // Register the channel's schemas, then release the live session: the task has no live parent.
  const seed = await f.live();
  await seed.dispose();
  let child: TranscriptContext | undefined;
  f.faux.setResponses([
    clockCall("headless-clock"),
    (context) => { child = context; return fauxAssistantMessage("STATUS: done\nNEXT: none\nChecked the clock."); },
  ]);
  const before = Date.now();
  const store = f.runtimes.peek("C1")!.store;
  const { runId } = await startSubagentStage(store, { agent: "reader", brief: "Check the time", userId: "U1", replaySafe: true });
  let run = await stageRun(store, runId);
  const deadline = Date.now() + 10_000;
  while (run?.status !== "done" && run?.status !== "failed" && Date.now() < deadline) {
    await setTimeout(10);
    run = await stageRun(store, runId);
  }
  assert.equal(run?.status, "done", run?.reason);
  assertClock(child, before);
});

test("dream sessions execute the clock in the harness timezone, not UTC or the dream timer's override", async (t) => {
  const f = await fixture(t);
  const seed = await f.live();
  f.faux.setResponses([fauxAssistantMessage("Something worth remembering.")]);
  try { await seed.session.prompt("Remember this conversation", { requestId: "seed", userId: "U1" }); }
  finally { await seed.dispose(); }
  let dream: TranscriptContext | undefined;
  f.faux.setResponses([
    clockCall("dream-clock"),
    (context) => { dream = context; return fauxAssistantMessage("Memory reviewed."); },
  ]);
  const before = Date.now();
  await f.harness.runDream("C1");
  assert.equal(new DreamState(f.channel.paths.root).read().lastError, undefined);
  assertClock(dream, before);
});
