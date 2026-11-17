import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { RecentConversationList } from "../agent/recent-conversations.ts";
import { logger } from "../util/log.ts";

const threadKey = "1710000000.000001";
const app = HarnessApp.prototype as any;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "recent-background-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models.json"), refreshOnCreate: false,
  });
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "summary" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({ defaults: {
    recentConversations: { model: "fixture/summary", debounceSeconds: 1 },
  } });
  const channel = resolveChannel(config, root, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(root)).channel!;
  const digests: string[] = [];
  const store = {
    listThreads: async () => [{ threadKey, lastActivityAt: Date.parse("2026-01-01T00:00:00Z") }],
    threadTurns: async () => [{ role: "user", text: "Fix the boiler timer." }],
    appendMainContext: async (_kind: string, text: string) => { digests.push(text); },
  };
  const warnings: string[] = [];
  t.mock.method(logger, "warn", (message: string) => warnings.push(message));
  const harness = {
    opts: { modelRuntime },
    resolveBackgroundChannel: async () => ({ channel }),
    runtimes: { peek: () => ({ store }) },
    recentConversationTimers: new Map(),
    updateRecentConversationSummary: (_channelId: string, _threadKey: string): Promise<void> => update(),
  };
  const update = () => app.updateRecentConversationSummary.call(harness, "C1", threadKey) as Promise<void>;
  return { modelRuntime, channel, digests, warnings, harness, update };
}

for (const previous of [undefined, "A useful earlier summary.", "This thread has no usable summary yet."]) {
  test("background failures preserve " + (previous ?? "an unsummarised thread") + " and a later success recovers", async (t) => {
    const f = await fixture(t);
    const file = f.channel.paths.recentConversationsFile;
    if (previous) writeFileSync(file, JSON.stringify({ entries: [{
      threadKey, summary: previous, updatedAt: "2025-12-31T00:00:00Z", summarizedAt: "2025-12-31T00:01:00Z",
    }] }));
    const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    for (const result of [
      fauxAssistantMessage(""), fauxAssistantMessage(" \n "),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 synthetic outage" }),
      fauxAssistantMessage("Partial summary.", { stopReason: "aborted" }),
    ]) {
      const mock = t.mock.method(f.modelRuntime, "completeSimple", async () => result);
      await f.update();
      mock.mock.restore();
      assert.equal(existsSync(file) ? readFileSync(file, "utf8") : undefined, before);
      assert.deepEqual(f.digests, [], "no fallback or partial digest is emitted to the main transcript");
    }
    assert.equal(f.warnings.length, 4);
    assert.ok(f.warnings.every((message) => message.includes("C1/" + threadKey)));
    assert.ok(f.warnings.some((message) => message.includes("no usable summary text")));
    assert.ok(f.warnings.some((message) => message.includes("HTTP 503 synthetic outage")));

    t.mock.method(f.modelRuntime, "completeSimple", async () => fauxAssistantMessage("The boiler timer is fixed."));
    await f.update();
    assert.equal(new RecentConversationList(file).read()[0]?.summary, "The boiler timer is fixed.");
    assert.deepEqual(f.digests, ["[recent thread " + threadKey + "] The boiler timer is fixed."]);
  });
}

test("debouncing coalesces updates and a failed attempt does not prevent the next handled turn", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending: Promise<void> | undefined;
  f.harness.updateRecentConversationSummary = () => { pending = f.update(); return pending; };
  let result = fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic outage" });
  const complete = t.mock.method(f.modelRuntime, "completeSimple", async () => result);
  const schedule = () => app.scheduleRecentConversationSummary.call(f.harness, f.channel, threadKey);
  schedule();
  t.mock.timers.tick(500);
  schedule();
  t.mock.timers.tick(500);
  assert.equal(complete.mock.callCount(), 0);
  t.mock.timers.tick(500);
  await pending;
  assert.equal(complete.mock.callCount(), 1);
  assert.equal(f.harness.recentConversationTimers.size, 0);
  assert.deepEqual(f.digests, []);

  result = fauxAssistantMessage("The boiler timer is fixed.");
  schedule();
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(complete.mock.callCount(), 2);
  assert.equal(f.harness.recentConversationTimers.size, 0);
  assert.deepEqual(f.digests, ["[recent thread " + threadKey + "] The boiler timer is fixed."]);
});
