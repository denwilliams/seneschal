import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelRuntimes } from "../agent/channel-runtime.ts";
import type { ScheduledTask } from "../agent/schedules.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { forgetFiled } from "../factory/workflow/issue-ledger.ts";
import { fixture, REPO } from "../factory/workflow/test-support.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { HarnessApp } from "./app.ts";
import type { ScheduledTaskRunResult } from "./scheduler.ts";

async function run(t: TestContext, options: { enabled?: boolean; repository?: string; heartbeat?: boolean } = {}) {
  forgetFiled();
  const f = fixture(t, { issues: { create: options.enabled ?? true } });
  const modelRuntime = await f.ready;
  const runtimes = new ChannelRuntimes({ modelRuntime, factoryGitHub: () => f.github });
  f.toRelease.push(() => runtimes.closeAll());
  const config = HarnessConfigSchema.parse({});
  // Use the real app/session construction without connecting to Slack. Only the external GitHub backend is replaced.
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config, opts: { config, dataDir: f.dataDir, modelRuntime }, runtimes, botUserId: "UBOT",
    factoryBackend: (channel: ResolvedChannel) => {
      assert.equal(channel, f.channel, "the backend is selected for the scheduled task's channel");
      return f.github;
    },
  }) as {
    runQuietScheduledTask(channel: ResolvedChannel, task: ScheduledTask): Promise<ScheduledTaskRunResult>;
  };
  let before: TranscriptContext | undefined;
  let after: TranscriptContext | undefined;
  f.faux.setResponses([
    (context) => {
      before = context;
      return fauxAssistantMessage(fauxToolCall("create_factory_issue", {
        title: "Scheduled export misses the CSV header", body: "Include the column names in the first row.",
        ...(options.repository ? { repository: options.repository } : {}),
      }, { id: "file-issue" }), { stopReason: "toolUse" });
    },
    (context) => { after = context; return fauxAssistantMessage("Done."); },
  ]);
  const result = await harness.runQuietScheduledTask(f.channel, {
    id: "file-issue", channelId: f.channel.ref.id, createdBy: "USCHEDULER", prompt: "File an issue for the missing CSV header.",
    quiet: true, timezone: "UTC", createdAt: new Date().toISOString(), runCount: 0,
    ...(options.heartbeat ? { heartbeat: true, intervalMinutes: 30 } : {}),
  });
  assert.equal(result.status, "completed", result.error);
  assert.equal(f.faux.state.callCount, 2);
  assert.ok(before && after, "the model saw both the request and the tool result");
  const toolNames = before.messages.filter((m) => m.role === "system")
    .flatMap((m) => ((m as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((tool) => tool.name));
  const toolResult = after.messages.find((m) => m.role === "toolResult" && m.toolName === "create_factory_issue");
  assert.ok(toolResult && toolResult.role === "toolResult");
  const text = toolResult.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  return { f, toolNames, toolResult, text, runtimes };
}

for (const heartbeat of [false, true]) {
  test(`${heartbeat ? "heartbeat" : "quiet scheduled"} sessions file issues through their own channel-scoped backend`, async (t) => {
    const e = await run(t, { heartbeat });
    assert.ok(e.toolNames.includes("create_factory_issue"));
    assert.ok(!e.toolResult.isError, e.text);
    assert.match(e.text, /Filed acme\/app#8/);
    assert.equal(e.f.github.created.length, 1);
    const filed = e.f.github.created[0]!;
    assert.equal(filed.repo, REPO);
    assert.deepEqual(filed.labels, ["status:triage"]);
    assert.match(filed.body, /requested by `USCHEDULER`/);
    assert.deepEqual(await e.runtimes.peek(e.f.channel.ref.id)!.store.listFactoryRuns(10), [], "filing alone does not start a run");
  });
}

test("quiet scheduled sessions without issue-creation permission have no filing tool and cannot file", async (t) => {
  const e = await run(t, { enabled: false });
  assert.ok(!e.toolNames.includes("create_factory_issue"));
  assert.ok(e.toolResult.isError, "even a model attempting the absent tool is refused");
  assert.equal(e.f.github.created.length, 0);
});

test("quiet scheduled sessions cannot file outside the channel's configured repositories", async (t) => {
  const e = await run(t, { repository: "other/private" });
  assert.ok(e.toolResult.isError);
  assert.match(e.text, /other\/private is not one of this factory's repositories \(acme\/app\)/);
  assert.equal(e.f.github.created.length, 0);
});
