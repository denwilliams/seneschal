import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { TaskStatusStore } from "../tasks/store.ts";

const failure = "404: Route unavailable";
function assistant(stopReason: string, errorMessage?: string) {
  return { role: "assistant", content: [], stopReason, errorMessage,
    provider: "synthetic", model: "test-model", api: "openai-completions", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function visibleRun(
  events: any[] | ((emit: (event: any) => void) => Promise<void>),
  model = "synthetic/test-model",
  beforeRender?: (method: "post" | "update", text: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "visible-provider-error-"));
  try {
    const config = HarnessConfigSchema.parse({ channels: { test: { model } } });
    const { channel } = resolveChannel(config, dir, { id: "C1", name: "test", isDm: false }, new ChannelRegistry(dir));
    const taskStore = new TaskStatusStore(dir);
    const replies: string[] = [];
    let listener: (event: any) => void;
    let unsubscribed = false;
    let tracker: unknown;
    const thread = {
      currentUserId: "",
      store: { steeringParent: async () => undefined, deliveryState: async () => undefined, recordDelivery: async () => ({}) },
      setTaskTracker(value: unknown) { tracker = value; },
      setSubagentProgress() {},
      session: {
        async model() { return undefined; },
        subscribe(fn: (event: any) => void) { listener = fn; return () => { unsubscribed = true; }; },
        async prompt() {
          if (typeof events === "function") await events(listener);
          else for (const event of events) listener(event);
        },
        getLastAssistantText() { return ""; },
      },
    };
    const harness = {
      taskStore, pool: { get() { return thread; } },
      pendingThread: new Map(), pendingUser: new Map(),
      config: { ui: { ackEmoji: "hourglass", showToolActivity: false }, schedules: { timezone: "UTC" } },
      opts: { botToken: "synthetic" }, botUserId: "UBOT", resumedRequests: new Set<string>(),
    };
    const client = {
      reactions: { add: async () => {}, remove: async () => {} },
      chat: {
        postMessage: async ({ text }: { text: string }) => {
          await beforeRender?.("post", text);
          const ts = String(replies.length);
          replies.push(text);
          return { ts };
        },
        update: async ({ ts, text }: { ts: string; text: string }) => {
          await beforeRender?.("update", text);
          replies[Number(ts)] = text;
          return { ts };
        },
      },
    };
    const result = await (HarnessApp.prototype as any).runAgentTurn.call(
      harness, client, channel, "1.1", "1.1",
      { channelId: "C1", userId: "U1", ts: "1.2" }, "Synthetic diagnostic.", { scheduled: { timezone: "UTC" } },
    );
    assert.equal(unsubscribed, true);
    assert.equal(tracker, undefined);
    return { result, replies, status: taskStore.all()[0]?.status };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("resolved provider HTTP errors produce a visible failure and failed task", async () => {
  const { result, replies, status } = await visibleRun([{ type: "assistant_message_end", message: assistant("error", failure) }]);
  assert.deepEqual(result, { status: "failed", error: failure });
  assert.equal(status, "failed");
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /:warning:.*404: Route unavailable/);
});

test("partial text and publishing do not turn a terminal provider error into success", async () => {
  const { result, replies, status } = await visibleRun([
    { type: "text_delta", delta: "Partial answer" },
    { type: "tool_end", toolName: "post_message", callId: "c1", isError: false },
    { type: "assistant_message_end", message: assistant("error", failure) },
  ]);
  assert.equal(result.status, "failed");
  assert.equal(status, "failed");
  assert.match(replies[0]!, /404/);
});

test("successful retries do not retain an intermediate provider failure", async () => {
  const { result, replies, status } = await visibleRun([
    { type: "assistant_message_end", message: assistant("error", "503: Retry later") },
    { type: "text_delta", delta: "Recovered." },
    { type: "assistant_message_end", message: assistant("stop") },
  ]);
  assert.equal(result.status, "completed");
  assert.equal(status, "closed_successfully");
  assert.deepEqual(replies, ["Recovered."]);
});

test("empty successful output is distinct from a provider error", async () => {
  const { result, replies } = await visibleRun([{ type: "assistant_message_end", message: assistant("stop") }]);
  assert.equal(result.status, "completed");
  assert.deepEqual(replies, ["_(no response)_"]);
});

test("returned codex quota errors preserve the existing no-response policy but fail the task", async () => {
  const { result, replies, status } = await visibleRun(
    [{ type: "assistant_message_end", message: assistant("error", "You have reached your usage limit.") }],
    "openai-codex/test-model",
  );
  assert.equal(result.status, "failed");
  assert.equal(status, "failed");
  assert.deepEqual(replies, ["_(no response)_"]);
});

test("quiet runs inspect provider outcomes even without a task tracker", async () => {
  let listener: (event: any) => void;
  let disposed = false;
  let unsubscribed = false;
  const harness = {
    config: { name: "Harness", schedules: { timezone: "UTC" } }, botUserId: "UBOT", opts: { modelRuntime: {} },
    runtimes: {}, baseSessionOptions() { return {}; },
    async createQuietScheduledThread(input: any) {
      return { currentUserId: "", session: {
        subscribe(fn: (event: any) => void) { listener = fn; return () => { unsubscribed = true; }; },
        async prompt() {
          await input.poster.post({ channelId: "C1", text: "Published result" });
          listener({ type: "assistant_message_end", message: assistant("error", failure) });
        },
      }, async dispose() { disposed = true; } };
    },
    async post() { return { ts: "1.1", permalink: "https://example.slack.com/result" }; }, async upload() {},
  };
  const result = await (HarnessApp.prototype as any).runQuietScheduledTask.call(
    harness, { ref: { id: "C1" }, schedulesEnabled: false }, { id: "test", prompt: "Synthetic task", createdBy: "U1" },
  );
  assert.deepEqual(result, { status: "failed", error: failure, slackOutputUrl: "https://example.slack.com/result" });
  assert.equal(disposed, true);
  assert.equal(unsubscribed, true);
});

for (const delayedMethod of ["update", "post"] as const) {
  test(`terminal provider failure survives a delayed interim ${delayedMethod}`, { timeout: 5_000 }, async (t) => {
    const keepAlive = setTimeout(() => {}, 5_000);
    t.after(() => clearTimeout(keepAlive));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    t.after(release);
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    let posted!: () => void;
    const firstPost = new Promise<void>((resolve) => { posted = resolve; });
    const interrupted = "502: stream interrupted";
    let releaseTimer: NodeJS.Timeout | undefined;
    t.after(() => clearTimeout(releaseTimer));
    const { result, replies, status } = await visibleRun(async (emit) => {
      emit({ type: "text_delta", delta: "Partial" });
      if (delayedMethod === "update") {
        await firstPost;
        emit({ type: "text_delta", delta: " answer" });
      }
      await inFlight;
      emit({ type: "assistant_message_end", message: assistant("error", interrupted) });
      // Prompt resolves with an older request still held. Without serialization,
      // the warning lands first and is overwritten (or a second reply is left).
      releaseTimer = setTimeout(release, 100);
    }, "synthetic/test-model", async (method, text) => {
      if (text.startsWith(":warning:")) return;
      if (method === delayedMethod) {
        started();
        await held;
      }
      if (method === "post") posted();
    });
    await held;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(result, { status: "failed", error: interrupted });
    assert.equal(status, "failed");
    assert.deepEqual(replies, [":warning: Something went wrong: 502: stream interrupted"],
      "only the final warning survives, with no orphan partial reply");
  });
}
