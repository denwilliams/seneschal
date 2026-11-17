import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore } from "../agent/durable/channel-store.ts";
import { deliverAnswer, findReply, reconcileDeliveries, storeLedger, REPLY_EVENT_TYPE } from "./delivery.ts";
import { SlackResponseStream } from "./stream.ts";

type Message = { ts: string; text: string; thread_ts?: string; metadata?: unknown };

/** A tiny Slack: a thread that remembers what was sent, with an injectable failure. */
function slack() {
  const thread: Message[] = [];
  let counter = 0;
  const calls: string[] = [];
  const state = { failNextPostAfterSend: false };
  const client = {
    chat: {
      postMessage: async (args: { text: string; thread_ts?: string; metadata?: unknown }) => {
        calls.push("post");
        const message: Message = { ts: `100.${++counter}`, text: args.text, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}), ...(args.metadata ? { metadata: args.metadata } : {}) };
        thread.push(message);
        return { ok: true, ts: message.ts };
      },
      update: async (args: { ts: string; text: string }) => {
        calls.push("update");
        const message = thread.find((m) => m.ts === args.ts);
        if (!message) throw new Error("message_not_found");
        message.text = args.text;
        return { ok: true, ts: args.ts };
      },
      delete: async (args: { ts: string }) => { calls.push("delete"); thread.splice(thread.findIndex((m) => m.ts === args.ts), 1); return { ok: true }; },
    },
    conversations: { replies: async () => ({ ok: true, messages: thread }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  } as unknown as WebClient;
  return { client, thread, calls, state };
}

async function stores(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "delivery-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const open = () => DurableChannelStore.open({
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
  });
  const opened: DurableChannelStore[] = [];
  t.after(async () => { for (const store of opened) await store.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  return { faux, open: async () => { const store = await open(); opened.push(store); return store; }, close: async (store: DurableChannelStore) => { await store.close(); opened.splice(opened.indexOf(store), 1); } };
}

const ledgerFor = (store: DurableChannelStore, client: WebClient, requestId = "slack:C1:1.2") =>
  storeLedger({ store, client, channel: "C1", threadTs: "1.1", threadKey: "1.1", requestId });
const newStream = (client: WebClient) => new SlackResponseStream({ client, channel: "C1", threadTs: "1.1", anchorTs: "1.2", ackEmoji: "hourglass" });

test("a reply is sent once with its request id in invisible metadata, and then recorded as delivered", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  const stream = newStream(s.client);
  await stream.open(); await stream.attachLedger(ledgerFor(store, s.client));
  stream.appendText("The answer.");
  await stream.close("The answer.");
  assert.equal(s.thread.length, 1);
  assert.deepEqual(s.thread[0]!.metadata, { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "slack:C1:1.2", part: 0 } });
  assert.equal((await store.deliveryState("slack:C1:1.2"))?.state, "delivered");
});

test("a redelivered event after completion sends nothing, even across a restart", async (t) => {
  const s = slack(); const f = await stores(t); let store = await f.open();
  const first = newStream(s.client);
  await first.open(); await first.attachLedger(ledgerFor(store, s.client)); await first.close("Done.");
  await f.close(store); store = await f.open();
  const again = newStream(s.client);
  await again.open(); await again.attachLedger(ledgerFor(store, s.client));
  assert.equal(again.delivered, true, "the ledger remembers across restarts");
  again.appendText("would be a duplicate"); await again.close("would be a duplicate");
  assert.equal(s.thread.length, 1, "no second message");
  assert.equal(s.thread[0]!.text, "Done.");
});

test("a crash after the send but before the timestamp was recorded does not post a second reply", async (t) => {
  const s = slack(); const f = await stores(t); let store = await f.open();
  const real = ledgerFor(store, s.client);
  // The send succeeds, then the process dies before `posted` can be recorded.
  const crashing = { ...real, posted: async () => { throw new Error("process died"); } };
  const first = newStream(s.client);
  await first.open(); await first.attachLedger(crashing);
  await assert.rejects(first.close("The answer."), /process died/);
  assert.equal(s.thread.length, 1, "the message did reach Slack");
  assert.equal((await store.deliveryState("slack:C1:1.2"))?.ts, "", "but its timestamp was never recorded");
  await f.close(store); store = await f.open();
  const retry = newStream(s.client);
  await retry.open(); await retry.attachLedger(ledgerFor(store, s.client));
  await retry.close("The answer.");
  assert.equal(s.thread.length, 1, "reconciled by the metadata: the existing message is adopted, not duplicated");
  assert.equal((await store.deliveryState("slack:C1:1.2"))?.state, "delivered");
});

test("intent recorded but nothing sent: the retry sends exactly once", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  await store.recordDelivery("slack:C1:1.2", "1.1", { state: "intended" });
  const stream = newStream(s.client);
  await stream.open(); await stream.attachLedger(ledgerFor(store, s.client));
  await stream.close("Now it goes out.");
  assert.equal(s.thread.length, 1);
  assert.equal(s.thread[0]!.text, "Now it goes out.");
});

test("a long reply that died part-way resumes with only the parts not yet sent", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  const long = ["A".repeat(3500), "B".repeat(3500), "C".repeat(3500)].join("\n\n");
  const first = newStream(s.client);
  await first.open(); await first.attachLedger(ledgerFor(store, s.client));
  await first.close(long);
  const total = s.thread.length;
  assert.ok(total >= 2, "the reply was split across messages");
  // Simulate a run that only got as far as the first two parts.
  await store.recordDelivery("slack:C1:9.9", "1.1", { state: "sent", ts: s.thread[0]!.ts, partsSent: 2 });
  const before = s.thread.length;
  const resume = newStream(s.client);
  await resume.open(); await resume.attachLedger(ledgerFor(store, s.client, "slack:C1:9.9"));
  await resume.close(long);
  assert.equal(s.thread.length - before, total - 2, "only the unsent tail was posted");
});

test("an agent that published directly counts as delivered, and an error notice is delivered once", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  const direct = newStream(s.client);
  await direct.open(); await direct.attachLedger(ledgerFor(store, s.client, "direct"));
  await direct.discard();
  assert.equal((await store.deliveryState("direct"))?.state, "delivered");
  const failing = newStream(s.client);
  await failing.open(); await failing.attachLedger(ledgerFor(store, s.client, "failing"));
  await failing.fail("Model unavailable.");
  assert.equal(s.thread.filter((m) => m.text.includes("Model unavailable")).length, 1);
  const retry = newStream(s.client);
  await retry.open(); await retry.attachLedger(ledgerFor(store, s.client, "failing"));
  await retry.fail("Model unavailable.");
  assert.equal(s.thread.filter((m) => m.text.includes("Model unavailable")).length, 1, "the same failure is not announced twice");
});

test("a message posted before the ledger existed is recorded, so a crash cannot orphan it", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  const stream = newStream(s.client);
  await stream.open();
  stream.setStatus("starting up…");
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.ok(s.thread.length <= 1);
  await stream.attachLedger(ledgerFor(store, s.client));
  if (s.thread.length === 1) assert.equal((await store.deliveryState("slack:C1:1.2"))?.ts, s.thread[0]!.ts);
  await stream.close("Final.");
  assert.equal(s.thread.length, 1, "the pre-ledger status message became the reply, not an orphan");
});

test("deliverAnswer (a turn resumed after a restart) posts once, edits an earlier send, and never repeats", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  const ledger = ledgerFor(store, s.client, "recovered");
  assert.equal(await deliverAnswer({ client: s.client, ledger, channel: "C1", threadTs: "1.1", text: "Recovered answer." }), "delivered");
  assert.equal(await deliverAnswer({ client: s.client, ledger, channel: "C1", threadTs: "1.1", text: "Recovered answer." }), "already-delivered");
  assert.equal(s.thread.length, 1);
  // An earlier attempt had sent the message but not finished: the answer edits it instead of adding another.
  const partial = await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "working…" });
  await store.recordDelivery("half", "1.1", { state: "sent", ts: partial.ts as string });
  await deliverAnswer({ client: s.client, ledger: ledgerFor(store, s.client, "half"), channel: "C1", threadTs: "1.1", text: "All done." });
  assert.equal(s.thread.at(-1)!.text, "All done.");
  assert.equal(s.thread.length, 2);
});

test("findReply matches only this request's metadata", async () => {
  const s = slack();
  await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "other", metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "someone-else" } } } as never);
  await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "plain human message" });
  assert.equal(await findReply(s.client, "C1", "1.1", "mine"), undefined);
  const mine = await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "mine", metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "mine" } } } as never);
  assert.equal(await findReply(s.client, "C1", "1.1", "mine"), mine.ts);
});

test("an answer committed but never sent before a crash is delivered exactly once after the restart", async (t) => {
  const s = slack(); const f = await stores(t); let store = await f.open();
  f.faux.setResponses([fauxAssistantMessage("The committed answer.")]);
  await store.wait(await store.submit("1.1", { requestId: "slack:C1:1.2", content: "question", userId: "U1" }));
  // The turn finished and its answer is committed; the process died after recording intent, before sending.
  await store.recordDelivery("slack:C1:1.2", "1.1", { state: "intended", threadTs: "1.1" });
  await f.close(store); store = await f.open();
  assert.deepEqual((await store.pendingDeliveries()).map((record) => record.requestId), ["slack:C1:1.2"]);
  const first = await reconcileDeliveries({ store, client: s.client, channel: "C1" });
  assert.deepEqual(first.delivered, ["slack:C1:1.2"]);
  assert.equal(s.thread.length, 1);
  assert.equal(s.thread[0]!.text, "The committed answer.");
  const again = await reconcileDeliveries({ store, client: s.client, channel: "C1" });
  assert.deepEqual(again.delivered, []);
  assert.equal(s.thread.length, 1, "a second pass must not send it again");
});

test("reconciliation leaves a request that is still being worked on alone, and reports unknown ones as skipped", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  await store.recordDelivery("ghost", "no-such-thread", { state: "intended", threadTs: "9.9" });
  const result = await reconcileDeliveries({ store, client: s.client, channel: "C1" });
  assert.deepEqual(result, { delivered: [], skipped: ["ghost"] });
  assert.equal(s.thread.length, 0);
});

test("requestOutcome distinguishes answered, unknown and unanswered requests", async (t) => {
  const f = await stores(t); const store = await f.open();
  assert.equal(await store.requestOutcome("1.1", "never-sent"), undefined);
  f.faux.setResponses([fauxAssistantMessage("fine")]);
  await store.wait(await store.submit("1.1", { requestId: "ok", content: "hi", userId: "U1" }));
  assert.deepEqual(await store.requestOutcome("1.1", "ok"), { status: "answered", text: "fine" });
  assert.equal(await store.requestOutcome("1.1", "other-request"), undefined);
});

// ── Real process crashes ─────────────────────────────────────────────────────────────────────────────────────
// The tests above inject failures in-process. These kill a real process (SIGKILL) at the dangerous moments and
// retry from a fresh one, against a Slack whose state lives in a file so it survives the kill.
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

async function runChild(root: string, mode: "after-send" | "before-send" | "final", kill: boolean, t: TestContext) {
  const child = fork(fileURLToPath(new URL("./fixtures/delivery-crash-child.ts", import.meta.url)), [root, mode], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = ""; child.stderr?.on("data", (data) => { errors += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const message = await Promise.race([
    once(child, "message").then(([value]) => value as { ready?: boolean; done?: boolean }),
    once(child, "exit").then(([code]) => { throw new Error(`child exited ${code} before signalling: ${errors}`); }),
    new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`child timed out: ${errors}`)), 15_000); timer.unref(); }),
  ]);
  if (kill) { child.kill("SIGKILL"); await once(child, "exit"); } else await once(child, "exit");
  return message;
}
const slackMessages = (root: string) => readFileSync(join(root, "slack.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ts: string; text: string });

test("SIGKILL after the message reached Slack but before its timestamp was recorded: the retry posts nothing new", { timeout: 40_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "delivery-kill-")); await mkdir(join(root, "workspace"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await runChild(root, "after-send", true, t)).ready, true);
  assert.equal(slackMessages(root).length, 1, "the message really is in Slack");
  assert.equal((await runChild(root, "final", false, t)).done, true);
  assert.equal(slackMessages(root).length, 1, "a fresh process reconciled by metadata instead of posting again");
  assert.equal(slackMessages(root)[0]!.text, "The answer.");
});

test("SIGKILL after intent was recorded but before anything was sent: the retry sends exactly one reply", { timeout: 40_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "delivery-kill-")); await mkdir(join(root, "workspace"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await runChild(root, "before-send", true, t)).ready, true);
  assert.equal(slackMessages(root).length, 0, "nothing reached Slack");
  await runChild(root, "final", false, t);
  assert.equal(slackMessages(root).length, 1);
  await runChild(root, "final", false, t);
  assert.equal(slackMessages(root).length, 1, "and a further redelivery adds nothing");
});

// ── Regressions from the independent review ──────────────────────────────────────────────────────────────────

test("findReply reads past the first page, because on a long thread the earlier reply is near the end", async () => {
  const pages = [
    { messages: Array.from({ length: 3 }, (_, i) => ({ ts: `1.${i}`, text: "human chatter" })), response_metadata: { next_cursor: "page2" } },
    { messages: [{ ts: "9.9", text: "our reply", metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "late", part: 0 } } }] },
  ];
  const seen: (string | undefined)[] = [];
  const client = { conversations: { replies: async (args: { cursor?: string }) => { seen.push(args.cursor); return { ok: true, ...(args.cursor ? pages[1]! : pages[0]!) }; } } } as unknown as WebClient;
  assert.equal(await findReply(client, "C1", "1.0", "late"), "9.9");
  assert.deepEqual(seen, [undefined, "page2"], "the second page was requested");
});

test("findReply distinguishes the parts of a long reply", async () => {
  const s = slack();
  await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "part 0", metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "r", part: 0 } } } as never);
  const second = await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "part 1", metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "r", part: 1 } } } as never);
  assert.equal(await findReply(s.client, "C1", "1.1", "r", 1), second.ts);
  assert.equal(await findReply(s.client, "C1", "1.1", "r", 2), undefined);
});

test("a later part that reached Slack before the crash (never recorded) is not posted again on the retry", async (t) => {
  const s = slack(); const f = await stores(t); const store = await f.open();
  const long = ["A".repeat(3500), "B".repeat(3500), "C".repeat(3500)].join("\n\n");
  // First attempt: part 0 posted and recorded; part 1 posted but the process died before `partSent(2)`.
  const first = await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "A…", metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "slack:C1:5.5", part: 0 } } } as never);
  await s.client.chat.postMessage({ channel: "C1", thread_ts: "1.1", text: "B…", metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: "slack:C1:5.5", part: 1 } } } as never);
  await store.recordDelivery("slack:C1:5.5", "1.1", { state: "sent", ts: first.ts as string, partsSent: 1, threadTs: "1.1" });
  const before = s.thread.length;
  await deliverAnswer({ client: s.client, ledger: ledgerFor(store, s.client, "slack:C1:5.5"), channel: "C1", threadTs: "1.1", text: long });
  const posted = s.thread.slice(before).map((m) => (m.metadata as { event_payload: { part: number } } | undefined)?.event_payload.part);
  assert.ok(!posted.includes(1), "part 1 was already in the thread and is not duplicated");
});
