import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { RecentConversationList, summarizeRecentConversation } from "./recent-conversations.ts";
import { HarnessConfigSchema, RecentConversationsSchema } from "../config/schema.ts";
import { registerConfiguredModelProviders } from "./model-providers.ts";
import { resolveModel } from "./model.ts";
import type { TranscriptSource } from "./transcripts.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

test("recent conversation list is capped and newest first", () => {
  const file = join(mkdtempSync(join(tmpdir(), "recent-")), "recent.json");
  const list = new RecentConversationList(file);

  for (let i = 0; i < 12; i++) {
    list.upsert(
      {
        threadKey: `1000.${i}`,
        summary: `Thread ${i} discussed a feature request and the next step. Extra sentence is dropped.`,
        updatedAt: new Date(2026, 0, i + 1).toISOString(),
        summarizedAt: new Date(2026, 0, i + 1, 1).toISOString(),
      },
      10,
    );
  }

  const entries = list.read();
  assert.equal(entries.length, 10);
  assert.equal(entries[0]?.threadKey, "1000.11");
  assert.equal(entries.at(-1)?.threadKey, "1000.2");
});

test("recent conversation summaries render as thread id plus one sentence", () => {
  const file = join(mkdtempSync(join(tmpdir(), "recent-")), "recent.json");
  const list = new RecentConversationList(file);

  list.upsert(
    {
      threadKey: "1710000000.000001",
      summary: "Den asked for a recent conversation list. This second sentence should not appear.",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summarizedAt: "2026-01-01T00:01:00.000Z",
    },
    10,
  );

  assert.equal(
    list.render(10),
    "- `1710000000.000001` — Den asked for a recent conversation list.",
  );
});

const threadKey = "1710000000.000001";
const updatedAt = "2026-01-01T00:00:00.000Z";
const now = new Date("2026-01-01T00:01:00.000Z");
const source: TranscriptSource = {
  threads: async () => [{ threadKey, lastActivity: new Date(updatedAt) }],
  turns: async () => [{ role: "user", text: "Fix the boiler timer." }],
};

async function summaryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "recent-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models.json"), refreshOnCreate: false,
  });
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "summary" }], tokensPerSecond: 1_000_000 });
  runtime.registerNativeProvider(faux.provider);
  const input = {
    channel: {} as ResolvedChannel, source, threadKey, modelRuntime: runtime,
    model: "fixture/summary", maxTranscriptChars: 8000, now,
  };
  return { root, runtime, faux, input };
}

test("the default summary model resolves in the pinned SDK catalog", async (t) => {
  const { runtime } = await summaryFixture(t);
  assert.ok(resolveModel(RecentConversationsSchema.parse({}).model, runtime));
});

test("a successful summary is one sentence with transcript and summary timestamps", async (t) => {
  const { faux, input } = await summaryFixture(t);
  faux.setResponses([fauxAssistantMessage("- The thread fixes the boiler timer. Another sentence.")]);
  const usage: AssistantMessage[] = [];
  const entry = await summarizeRecentConversation({ ...input, onUsage: (message) => usage.push(message) });
  assert.deepEqual(entry, {
    threadKey, summary: "The thread fixes the boiler timer.", updatedAt, summarizedAt: now.toISOString(),
  });
  assert.equal(usage.length, 1);
});

test("empty, whitespace, thinking-only and legacy fallback responses are unsuccessful", async (t) => {
  const { runtime, input } = await summaryFixture(t);
  for (const content of [
    [], [{ type: "text", text: "" }], [{ type: "text", text: " \n \t " }],
    [{ type: "text", text: " - • " }], [{ type: "thinking", thinking: "Internal reasoning only" }],
    [{ type: "text", text: "This thread has no usable summary yet." }],
  ]) {
    const result = { ...fauxAssistantMessage(""), content };
    const mock = t.mock.method(runtime, "completeSimple", async () => result);
    const usage: AssistantMessage[] = [];
    await assert.rejects(
      summarizeRecentConversation({ ...input, onUsage: (message) => usage.push(message) }),
      /fixture\/summary.*no usable summary text/,
    );
    assert.deepEqual(usage, [result], "record usage even when the response is unusable");
    mock.mock.restore();
  }
});

test("failed and incomplete results are rejected even if they include plausible text", async (t) => {
  const { runtime, input } = await summaryFixture(t);
  for (const stopReason of ["error", "aborted", "length", "toolUse", "pending"] as const) {
    const mock = t.mock.method(runtime, "completeSimple", async () => ({
      ...fauxAssistantMessage("A partial summary."), stopReason, errorMessage: "Synthetic provider failure",
    }));
    await assert.rejects(summarizeRecentConversation(input), /Synthetic provider failure/);
    mock.mock.restore();
  }
  t.mock.method(runtime, "completeSimple", async () => { throw new Error("Connection failed"); });
  await assert.rejects(summarizeRecentConversation(input), /Connection failed/);
});

test("the SDK resolves an HTTP failure with empty content; the summarizer must reject it", async (t) => {
  const { runtime, input } = await summaryFixture(t);
  registerConfiguredModelProviders(runtime, HarnessConfigSchema.parse({ modelProviders: {
    synthetic: { baseUrl: "https://provider.example.test/v1", apiKey: "fixture-key",
      models: [{ id: "summary", contextWindow: 8192, maxTokens: 2048 }] },
  } }).modelProviders);
  const complete = runtime.completeSimple.bind(runtime);
  t.mock.method(runtime, "completeSimple", (...[model, ctx]: Parameters<ModelRuntime["completeSimple"]>) => complete(model, ctx, {
    maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ message: "Route unavailable" }), {
      status: 404, headers: { "content-type": "application/json" },
    }),
  }));
  const usage: AssistantMessage[] = [];
  await assert.rejects(summarizeRecentConversation({
    ...input, model: "synthetic/summary", onUsage: (message) => usage.push(message),
  }), /synthetic\/summary.*failed \(error\).*404/);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.stopReason, "error");
  assert.deepEqual(usage[0]!.content, []);
});

test("missing or empty transcripts do not call the model", async (t) => {
  const { runtime, input } = await summaryFixture(t);
  const mock = t.mock.method(runtime, "completeSimple", async () => { throw new Error("must not call"); });
  for (const emptySource of [
    { ...source, threads: async () => [] },
    { ...source, turns: async () => [] },
  ]) assert.equal(await summarizeRecentConversation({ ...input, source: emptySource }), undefined);
  assert.equal(mock.mock.callCount(), 0);
});

test("invalid upserts preserve useful summaries, and persisted legacy placeholders are ignored", (t) => {
  const root = mkdtempSync(join(tmpdir(), "recent-list-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "recent.json");
  const list = new RecentConversationList(file);
  const good = { threadKey, summary: "The thread fixes the boiler timer.", updatedAt, summarizedAt: now.toISOString() };
  list.upsert(good, 10);
  const before = readFileSync(file, "utf8");
  for (const summary of ["", " \n ", "- • ", "This thread has no usable summary yet."]) {
    list.upsert({ ...good, summary }, 10);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(list.read(), [good]);
  }
  writeFileSync(file, JSON.stringify({ entries: [
    { ...good, summary: "This thread has no usable summary yet." },
    { ...good, threadKey: "empty", summary: " " },
  ] }));
  assert.deepEqual(list.read(), []);
  assert.equal(list.render(10), "No recent conversations have been summarised yet.");
  list.upsert(good, 10);
  assert.deepEqual(list.read(), [good], "a later successful update replaces the legacy entry");
});
