import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_THREAD_KEY,
  DreamState,
  appendDreamLog,
  collectDreamContext,
  dreamLogDir,
  dreamPrompt,
  keepDreamTranscript,
  readDreamLog,
  readJournal,
  recordDream,
  worthDreaming,
  type DreamSettings,
} from "./dream.ts";
import { MemoryFile } from "./memory-store.ts";
import { recentConversations, type TranscriptSource } from "./transcripts.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * A dream edits the channel's memory unattended, so what matters is the
 * boundaries around it: an idle channel must not dream at all, the pass must
 * not read its own previous dreams back as if they were conversations, and
 * whatever it does has to end up in a file a human can open.
 */

const SETTINGS: DreamSettings = {
  enabled: true,
  cron: "0 3 * * *",
  timezone: "UTC",
  forgetAfterDays: 90,
  maxConversations: 8,
  keepTranscripts: 14,
  announce: false,
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-dream-"));
  const memory = join(root, "memory");
  const sessions = join(root, "sessions");
  mkdirSync(memory, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const memoryFile = join(memory, "MEMORY.md");
  writeFileSync(memoryFile, "# Memory\n");

  const channel = {
    ref: { id: "C1", name: "home", isDm: false },
    paths: { root, memory, sessions },
    memory: { channelFile: memoryFile, canWriteShared: false, foreignFiles: [] },
  } as unknown as ResolvedChannel;

  // Conversations live in the channel's Durable store; the tests read them through the same interface.
  const conversations = new Map<string, { at: Date; turns: { role: "user" | "assistant"; text: string }[] }>();
  const source: TranscriptSource = {
    threads: async (since) => [...conversations.entries()]
      .filter(([, value]) => !since || value.at > since)
      .map(([threadKey, value]) => ({ threadKey, lastActivity: value.at })),
    turns: async (threadKey) => conversations.get(threadKey)?.turns ?? [],
  };
  const addConversation = (threadKey: string, turns: { role: string; text: string }[], at = new Date()) => {
    conversations.set(threadKey, { at, turns: turns as { role: "user" | "assistant"; text: string }[] });
  };

  return { root, channel, memoryFile, addConversation, source };
}

test("a channel with nothing new does not dream", async () => {
  const { channel, source } = setup();

  const ctx = await collectDreamContext(channel, SETTINGS, source);

  assert.equal(ctx.conversations.length, 0);
  assert.equal(worthDreaming(ctx), false, "an idle channel must not cost a model call every night");
});

test("a channel that has been talked to has something to think about", async () => {
  const { channel, addConversation, source } = setup();
  addConversation("1754700000.000100", [
    { role: "user", text: "the boiler is serviced in October" },
    { role: "assistant", text: "Noted." },
  ]);

  const ctx = await collectDreamContext(channel, SETTINGS, source);

  assert.equal(worthDreaming(ctx), true);
  assert.equal(ctx.conversations.length, 1);
  assert.match(dreamPrompt(ctx), /serviced in October/);
});

test("clutter alone is enough reason to dream", async () => {
  const { channel, memoryFile, source } = setup();
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(memoryFile, `# Memory\n\n- (${old}) Someone once asked about a printer.\n`);

  const ctx = await collectDreamContext(channel, SETTINGS, source);

  assert.equal(ctx.stale.length, 1);
  assert.equal(worthDreaming(ctx), true);
  assert.match(dreamPrompt(ctx), /Candidates for forgetting/);
});

test("a dream never rereads its own previous dreams", async () => {
  const { channel, addConversation, source } = setup();
  addConversation(DREAM_THREAD_KEY, [
    { role: "user", text: "You are dreaming." },
    { role: "assistant", text: "Today was mostly about the boiler." },
  ]);

  const ctx = await collectDreamContext(channel, SETTINGS, source);

  assert.equal(
    ctx.conversations.length,
    0,
    "consolidating yesterday's summary would compound it night after night",
  );
});

test("every per-run dream fork is excluded from the lookback, not just the bare key", async () => {
  const { channel, addConversation, source } = setup();
  addConversation(`${DREAM_THREAD_KEY}-1754700000000`, [{ role: "assistant", text: "Last night's summary." }]);
  addConversation("1754700000.000100", [{ role: "user", text: "a real conversation" }]);

  const ctx = await collectDreamContext(channel, SETTINGS, source);

  assert.deepEqual(ctx.conversations.map((c) => c.threadKey), ["1754700000.000100"]);
});

test("the lookback starts at the last dream", async () => {
  const { channel, addConversation, root, source } = setup();
  addConversation("1754700000.000100", [{ role: "user", text: "something old" }]);

  new DreamState(root).write({ runs: 1, lastDreamAt: new Date(Date.now() + 60_000).toISOString() });
  const ctx = await collectDreamContext(channel, SETTINGS, source);

  assert.equal(ctx.conversations.length, 0, "a conversation already consolidated is not redone");
  assert.ok(ctx.since && ctx.since.getTime() > Date.now(), "the lookback follows the marker");
});

test("a dream is written up where a human can read it", () => {
  const { channel, root } = setup();

  recordDream(channel, {
    entriesBefore: 12,
    entriesAfter: 9,
    summary: "Mostly the boiler and a deploy that went badly.",
    conversations: 3,
    staleBefore: 4,
  });

  const journal = readFileSync(join(channel.paths.memory, "DREAMS.md"), "utf-8");
  assert.match(journal, /Mostly the boiler/);
  assert.match(journal, /12 → 9 memories/);
  assert.match(readJournal(channel), /Mostly the boiler/);

  const state = new DreamState(root).read();
  assert.equal(state.runs, 1);
  assert.ok(state.lastDreamAt, "without a marker the next dream would redo the same days");
});

test("a memory that halves overnight is flagged in the journal", () => {
  const { channel } = setup();

  recordDream(channel, {
    entriesBefore: 40,
    entriesAfter: 3,
    summary: "Tidied up.",
    conversations: 1,
    staleBefore: 0,
  });

  const journal = readFileSync(join(channel.paths.memory, "DREAMS.md"), "utf-8");
  assert.match(journal, /shrank by more than half/i);
  assert.match(journal, /MEMORY\.archive\.md/);
});

test("the prompt tells the agent nobody is waiting on it", async () => {
  const { channel, addConversation, source } = setup();
  addConversation("1754700000.000100", [{ role: "user", text: "hello" }]);
  new MemoryFile(channel.memory.channelFile).append("A fact worth keeping.");

  const prompt = dreamPrompt(await collectDreamContext(channel, SETTINGS, source));

  assert.match(prompt, /You are dreaming/);
  assert.match(prompt, /nobody is waiting/i);
  assert.match(prompt, /forget/, "the pass has to know which tool rewrites memory");
  assert.match(prompt, /deliberate[\s\S]*new memories/i);
  assert.match(prompt, /conversation since the last dream/i);
  assert.match(prompt, /corrections or teaching/i);
  assert.match(prompt, /mistakes and the remedy/i);
  assert.match(prompt, /lengthy or iterative work/i);
  assert.match(prompt, /important decisions or outcomes/i);
  assert.match(prompt, /not[\s\S]*chat transcripts/i);
  assert.match(prompt, /A fact worth keeping/);
});

test("every run leaves a log line, including the ones that do nothing", () => {
  const { channel } = setup();

  appendDreamLog(channel, {
    at: "2026-08-08T03:00:00.000Z",
    status: "skipped",
    reason: "nothing said since the last pass",
    conversations: 0,
  });
  appendDreamLog(channel, {
    at: "2026-08-09T03:00:00.000Z",
    status: "completed",
    conversations: 3,
    entriesBefore: 24,
    entriesAfter: 17,
    durationMs: 41_000,
    model: "openai/gpt-5.4",
    transcript: "2026-08-09T03-00-41-000Z.jsonl",
  });

  const log = readDreamLog(channel);
  assert.equal(log.length, 2);
  assert.equal(log[0]!.status, "skipped");
  assert.match(log[0]!.reason!, /nothing said/, "a night that did nothing has to say why");
  assert.equal(log[1]!.entriesAfter, 17);
  assert.equal(log[1]!.model, "openai/gpt-5.4");
});

test("the log survives a line half-written when the process died", () => {
  const { channel } = setup();
  appendDreamLog(channel, { at: "2026-08-09T03:00:00.000Z", status: "completed", conversations: 1 });
  appendFileSync(join(dreamLogDir(channel), "log.jsonl"), '{"at":"2026-08-10T03:00');

  const log = readDreamLog(channel);
  assert.equal(log.length, 1, "one bad line must not lose the history before it");
});

test("the transcript is kept for debugging, from the dream's own conversation", async () => {
  const { channel, source } = setup();
  const transcript = [
    JSON.stringify({ role: "user", content: "You are dreaming." }),
    JSON.stringify({ role: "assistant", content: "Tidied up." }),
  ].join("\n");

  const name = keepDreamTranscript(channel, transcript, 14);

  assert.ok(name?.endsWith(".jsonl"));
  const kept = readFileSync(join(dreamLogDir(channel), name!), "utf-8");
  assert.match(kept, /Tidied up/, "the transcript is where the tool calls are");
  assert.ok(kept.endsWith("\n"), "kept as well-formed JSON lines");
  assert.equal(
    (await collectDreamContext(channel, SETTINGS, source)).conversations.length,
    0,
    "a kept transcript must not become something the next pass reads back",
  );
});

test("only the last few transcripts are kept, and none when told none", () => {
  const { channel } = setup();

  for (let i = 0; i < 5; i++) {
    keepDreamTranscript(channel, JSON.stringify({ role: "user", content: `night ${i}` }), 3, new Date(Date.UTC(2026, 7, 9, 3, i)));
  }

  const kept = readdirSync(dreamLogDir(channel)).filter((f) => f.endsWith(".jsonl") && f !== "log.jsonl");
  assert.equal(kept.length, 3);
  assert.match(kept.sort().at(-1)!, /03-04/, "the newest is the one kept");

  assert.equal(keepDreamTranscript(channel, "{}", 0), undefined, "0 keeps none");
  assert.equal(keepDreamTranscript(channel, undefined, 5), undefined, "nothing to keep when the conversation could not be read");
});
