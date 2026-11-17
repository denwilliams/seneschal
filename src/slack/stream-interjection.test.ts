import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";
import { PROGRESS_EVENT_TYPE, SlackResponseStream } from "./stream.ts";
import { findReply, storeLedger, type DeliveryLedger } from "./delivery.ts";

/**
 * A Slack thread with real ordering: messages have timestamps, can be edited and deleted, and an edit of a message that is gone
 * fails the way Slack's does. The point of these tests is what a person would SEE, top to bottom.
 */
function slack() {
  const thread: { ts: string; text: string; metadata?: { event_type?: string; event_payload?: Record<string, unknown> } }[] = [];
  let n = 0;
  const notFound = () => Object.assign(new Error("message_not_found"), { data: { error: "message_not_found" } });
  const client = {
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      postMessage: async (args: { text: string; metadata?: never }) => { const ts = `100.${String(++n).padStart(3, "0")}`; thread.push({ ts, text: args.text, ...(args.metadata ? { metadata: args.metadata } : {}) }); return { ok: true, ts }; },
      update: async (args: { ts: string; text: string }) => { const m = thread.find((x) => x.ts === args.ts); if (!m) throw notFound(); m.text = args.text; return { ok: true }; },
      delete: async (args: { ts: string }) => { const i = thread.findIndex((x) => x.ts === args.ts); if (i < 0) throw notFound(); thread.splice(i, 1); return { ok: true }; },
    },
    conversations: { replies: async () => ({ ok: true, messages: thread }) },
  } as unknown as WebClient;
  return { client, thread, texts: () => thread.map((m) => m.text) };
}

const fast = { channel: "C1", threadTs: "1.1", anchorTs: "1.0", ackEmoji: "hourglass", progressAfterMs: 0, updateIntervalMs: 15 };
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function ledgerSpy(): DeliveryLedger & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    metadata: { event_type: "harness_reply", event_payload: { request_id: "req-1", part: 0 } },
    metadataFor: (part) => ({ event_type: "harness_reply", event_payload: { request_id: "req-1", part } }),
    findPart: async () => undefined,
    begin: async () => ({ delivered: false, partsSent: 0, fresh: true }),
    posted: async (ts) => { calls.push(`posted ${ts}`); },
    partSent: async (n) => { calls.push(`partSent ${n}`); },
    delivered: async () => { calls.push("delivered"); },
  };
}

test("the answer is the last thing in the thread: a status-only live message is cleared ahead of a post, and comes back below it", async () => {
  const s = slack();
  const stream = new SlackResponseStream({ client: s.client, ...fast });
  await stream.open();
  stream.setStatus("running run_subagent…");
  await settle();
  assert.deepEqual(s.texts(), ["_running run_subagent…_"], "the live status message is up");

  await stream.postInterjection("Handing this to *coder*");
  await settle();
  assert.deepEqual(s.texts(), ["Handing this to *coder*", "_running run_subagent…_"], "the post is above the live message, which is re-created below it");

  await stream.postInterjection("*coder*: found three providers");
  await settle();
  assert.deepEqual(s.texts(), ["Handing this to *coder*", "*coder*: found three providers", "_running run_subagent…_"]);

  stream.appendText("The coder opened PR 12.");
  await stream.close("The coder opened PR 12.");
  assert.deepEqual(s.texts(), ["Handing this to *coder*", "*coder*: found three providers", "The coder opened PR 12."], "the answer lands last, and no stray status message is left");
});

test("text the agent already streamed is fixed in place, without its status line, and is not repeated in the answer", async () => {
  const s = slack();
  const ledger = ledgerSpy();
  const stream = new SlackResponseStream({ client: s.client, ...fast });
  await stream.attachLedger(ledger);
  await stream.open();
  stream.appendText("I'll hand this to the coder.");
  stream.setStatus("running run_subagent…");
  await settle();
  assert.match(s.texts()[0]!, /I'll hand this to the coder\.\n\n_running run_subagent…_/);

  await stream.postInterjection("Handing this to *coder*");
  await settle();
  assert.deepEqual(s.texts().slice(0, 2), ["I'll hand this to the coder.", "Handing this to *coder*"], "the earlier text stays where it was, as an ordinary message");

  stream.appendText("\n\nThe coder opened PR 12.");
  await stream.close("I'll hand this to the coder.\n\nThe coder opened PR 12.");
  assert.deepEqual(s.texts(), ["I'll hand this to the coder.", "Handing this to *coder*", "The coder opened PR 12."], "only what is new is sent");
  assert.equal(ledger.calls.filter((c) => c === "delivered").length, 1, "the reply is recorded delivered exactly once");
});

test("when everything the agent said was already fixed in place, there is nothing left to send and no stray message", async () => {
  const s = slack();
  const ledger = ledgerSpy();
  const stream = new SlackResponseStream({ client: s.client, ...fast });
  await stream.attachLedger(ledger);
  await stream.open();
  stream.appendText("Handing that over now.");
  stream.setStatus("working…");
  await settle();
  await stream.postInterjection("Handing this to *coder*");
  await settle();
  await stream.close("Handing that over now.");
  assert.deepEqual(s.texts(), ["Handing that over now.", "Handing this to *coder*"]);
  assert.equal(ledger.calls.at(-1), "delivered");
});

test("posts made ahead of the reply never look like a reply to the delivery ledger", async () => {
  const s = slack();
  const stream = new SlackResponseStream({ client: s.client, ...fast });
  await stream.open();
  await stream.postInterjection("Handing this to *coder*");
  assert.equal(s.thread[0]!.metadata?.event_type, PROGRESS_EVENT_TYPE);
  assert.equal(await findReply(s.client, "C1", "1.1", "req-1"), undefined, "reconciliation after a crash does not mistake it for the reply");
  await stream.close("Done.");
  assert.equal(s.thread.length, 2);
});

test("a reply recorded against a message that has since gone is sent afresh instead of failing", async () => {
  const s = slack();
  const stream = new SlackResponseStream({ client: s.client, ...fast });
  await stream.open();
  stream.setStatus("working…");
  await settle();
  s.thread.length = 0; // the live message is gone (cleared, or deleted by someone), but the stream still holds its timestamp
  await stream.close("Here is the answer.");
  assert.deepEqual(s.texts(), ["Here is the answer."]);
});

test("a recorded delivery whose message is gone is recovered by posting, not by throwing", async () => {
  const { deliverAnswer } = await import("./delivery.ts");
  const s = slack();
  const store = new Map<string, { state: string; ts: string; partsSent: number; threadTs: string; threadKey: string; textHash: string; updatedAt: number; requestId: string }>();
  const ledger = storeLedger({
    store: {
      deliveryState: async (id: string) => store.get(id) as never,
      recordDelivery: async (id: string, threadKey: string, change: Record<string, unknown>) => {
        const record = { requestId: id, threadKey, threadTs: "1.1", state: "intended", ts: "", partsSent: 0, textHash: "", updatedAt: 1, ...store.get(id), ...change };
        store.set(id, record as never); return record as never;
      },
    },
    client: s.client, channel: "C1", threadTs: "1.1", threadKey: "1.1", requestId: "req-1",
  });
  await ledger.begin();
  await ledger.posted("100.999"); // recorded, but that message no longer exists
  await deliverAnswer({ client: s.client, ledger, channel: "C1", threadTs: "1.1", text: "The answer." });
  assert.deepEqual(s.texts(), ["The answer."]);
  assert.equal(store.get("req-1")!.state, "delivered");
});

test("nothing is posted ahead of a reply once the stream has finished", async () => {
  const s = slack();
  const stream = new SlackResponseStream({ client: s.client, ...fast });
  await stream.open();
  await stream.close("Done.");
  await stream.postInterjection("too late");
  assert.deepEqual(s.texts(), ["Done."]);
});

test("several posts keep their order even when they are made back to back", async () => {
  const s = slack();
  const stream = new SlackResponseStream({ client: s.client, ...fast });
  await stream.open();
  const all = ["one", "two", "three", "four"].map((t) => stream.postInterjection(t));
  await Promise.all(all);
  await stream.close("answer");
  assert.deepEqual(s.texts(), ["one", "two", "three", "four", "answer"]);
});
