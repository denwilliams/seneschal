import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp } from "./app.ts";
import { sharedPaths } from "../workspace/paths.ts";
import { UsageLog } from "../agent/usage.ts";

const methods = HarnessApp.prototype as any;

test("idle heartbeat bypasses the model and all automatic Slack output", async () => {
  let posts = 0, modelStarts = 0;
  const harness = {
    app: { client: {} },
    async resolveBackgroundChannel() { return { channel: { ref: { id: "C1" }, schedulesEnabled: true, tools: [], envSources: [] } }; },
    async post() { posts++; },
    async runQuietScheduledTask() { modelStarts++; },
  };
  const result = await methods.runScheduledTask.call(harness, { id: "heartbeat", channelId: "C1", createdBy: "U1", heartbeat: true, prompt: "nothing to do" });
  assert.deepEqual(result, { status: "completed" });
  assert.equal(posts, 0); assert.equal(modelStarts, 0);
});

for (const notify of [false, true]) {
  test(`heartbeat is always quiet, attributes model tokens and ${notify ? "allows warranted explicit posts" : "discards routine final replies"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "heartbeat-app-"));
    try {
      const shared = sharedPaths(dir);
      const channel = { ref: { id: "C1", name: "ops" }, shared, schedulesEnabled: true, tools: [], envSources: [] };
      const posts: string[] = [], prompts: string[] = [];
      let disposed = false;
      const message = { role: "assistant", provider: "test", model: "test", stopReason: "stop", content: [{ type: "text", text: "Routine completion must not be posted" }], usage: { input: 100, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 125 } };
      const harness = {
        app: { client: {} }, config: { name: "Harness", schedules: { timezone: "UTC" } }, opts: {},
        baseSessionOptions() { return {}; },
        async resolveBackgroundChannel() { return { channel }; },
        runQuietScheduledTask: methods.runQuietScheduledTask,
        async createQuietScheduledThread(input: any) {
          let subscriber: (event: any) => void;
          return { currentUserId: "", session: {
            subscribe(fn: typeof subscriber) { subscriber = fn; return () => {}; },
            async prompt(text: string) {
              prompts.push(text);
              subscriber({ type: "assistant_message_end", message });
              // Delegated model work is also charged to the originating heartbeat.
              input.onSubagentMessage({ runKey: "sub-heartbeat", message });
              if (notify) await input.poster.post({ channelId: "C1", text: "John's email arrived." });
            },
          }, async dispose() { disposed = true; } };
        },
        async post(input: any) { posts.push(input.text); return { permalink: "https://slack.example/actionable" }; },
      };
      const result = await methods.runScheduledTask.call(harness, { id: "hb", channelId: "C1", createdBy: "U1", heartbeat: true, quiet: false, intervalMinutes: 15, timezone: "UTC", prompt: "Watch for John's email." });
      assert.equal(result.status, "completed");
      assert.deepEqual(posts, notify ? ["John's email arrived."] : []);
      assert.match(prompts[0]!, /heartbeat, running every 15 minutes/);
      assert.match(prompts[0]!, /normal reply will not be shown/);
      assert.equal(disposed, true);
      const usage = new UsageLog(shared).query({ channelId: "C1", sources: ["heartbeat"] });
      assert.equal(usage.length, 2);
      assert.equal(usage.reduce((sum, record) => sum + record.totalTokens, 0), 250);
      assert.equal(new UsageLog(shared).query({ sources: ["agent", "scheduled"] }).length, 0);
      assert.equal(result.slackOutputUrl, notify ? "https://slack.example/actionable" : undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("heartbeat cannot bypass disabled scheduling", async () => {
  const harness = { app: { client: {} }, async resolveBackgroundChannel() { return { channel: { ref: { id: "C1" }, schedulesEnabled: false } }; } };
  const result = await methods.runScheduledTask.call(harness, { id: "hb", channelId: "C1", heartbeat: true, prompt: "nothing to do" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /disabled/);
});
