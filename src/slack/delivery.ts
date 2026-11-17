import type { WebClient } from "@slack/web-api";
import type { DurableChannelStore } from "../agent/durable/channel-store.ts";
import { digest } from "../agent/durable/identity.ts";
import { chunk, toMrkdwn } from "./format.ts";
import { logger } from "../util/log.ts";

/**
 * Making "the answer reached Slack" an idempotent fact.
 *
 * Committed agent events cannot prevent a duplicate Slack message on their own: a crash between the send and
 * recording its timestamp leaves no trace that it happened. So every reply carries its request id in invisible
 * message metadata, and the store records intent before the first send:
 *
 *   intended ──send──▶ sent(ts) ──all parts──▶ delivered
 *
 * Anything found `intended` without a timestamp is reconciled by looking for that metadata in the thread
 * before sending again. `delivered` is terminal: a redelivered Slack event or a resumed turn finds it and
 * posts nothing.
 */

export const REPLY_EVENT_TYPE = "harness_reply";

export type ReplyMetadata = { event_type: typeof REPLY_EVENT_TYPE; event_payload: { request_id: string; part: number } };

export type BeginResult =
  | { delivered: true }
  /** `fresh`: nothing was recorded for this request before, so there is no earlier attempt to reconcile with. */
  | { delivered: false; ts?: string; partsSent: number; fresh: boolean };

export interface DeliveryLedger {
  /** Attached to the first message of the reply, so it can be found again after a crash. */
  readonly metadata: ReplyMetadata;
  /** The same for a later part of a long reply. */
  metadataFor(part: number): ReplyMetadata;
  /** Whether a later part already reached the thread (an earlier attempt died after sending it). */
  findPart(part: number): Promise<string | undefined>;
  /** Before the first send. Says whether to skip, to update an existing reply, or to send. */
  begin(): Promise<BeginResult>;
  posted(ts: string): Promise<void>;
  partSent(parts: number): Promise<void>;
  delivered(text: string): Promise<void>;
}

/**
 * The message (or one part of a long reply) that already reached the thread for a request, found by the metadata it was
 * sent with. Reads the whole thread: the reply is near the end, so a first page alone would miss it on a long thread.
 */
export async function findReply(
  client: Pick<WebClient, "conversations">,
  channel: string,
  threadTs: string,
  requestId: string,
  part = 0,
): Promise<string | undefined> {
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.conversations.replies({
        channel, ts: threadTs, include_all_metadata: true, limit: 200, ...(cursor ? { cursor } : {}),
      });
      for (const message of result.messages ?? []) {
        const metadata = (message as { metadata?: { event_type?: string; event_payload?: { request_id?: string; part?: number } } }).metadata;
        if (metadata?.event_type === REPLY_EVENT_TYPE && metadata.event_payload?.request_id === requestId && (metadata.event_payload.part ?? 0) === part) {
          return message.ts;
        }
      }
      cursor = result.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (err) {
    // Without history access a crashed send cannot be reconciled; say so rather than guess.
    logger.warn(`could not look for an earlier reply to ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

export type DeliveryActivity = (text: string, requestId: string, threadTs: string) => void;

export function storeLedger(input: {
  store: Pick<DurableChannelStore, "deliveryState" | "recordDelivery">;
  client: Pick<WebClient, "conversations">;
  channel: string;
  threadTs: string;
  threadKey: string;
  requestId: string;
  onDelivered?: DeliveryActivity;
}): DeliveryLedger {
  const { store, client, channel, threadTs, threadKey, requestId } = input;
  return {
    metadata: { event_type: REPLY_EVENT_TYPE, event_payload: { request_id: requestId, part: 0 } },
    metadataFor: (part) => ({ event_type: REPLY_EVENT_TYPE, event_payload: { request_id: requestId, part } }),
    findPart: (part) => findReply(client, channel, threadTs, requestId, part),
    async begin() {
      const record = await store.deliveryState(requestId);
      if (record?.state === "delivered") return { delivered: true };
      if (record?.ts) return { delivered: false, ts: record.ts, partsSent: record.partsSent, fresh: false };
      if (record) {
        // Intent was recorded but not the timestamp: the send may or may not have happened.
        const found = await findReply(client, channel, threadTs, requestId);
        if (found) {
          await store.recordDelivery(requestId, threadKey, { state: "sent", ts: found });
          return { delivered: false, ts: found, partsSent: record.partsSent, fresh: false };
        }
        return { delivered: false, partsSent: record.partsSent, fresh: false };
      }
      await store.recordDelivery(requestId, threadKey, { state: "intended", threadTs });
      return { delivered: false, partsSent: 0, fresh: true };
    },
    async posted(ts) {
      await store.recordDelivery(requestId, threadKey, { state: "sent", ts });
    },
    async partSent(parts) {
      await store.recordDelivery(requestId, threadKey, { partsSent: parts });
    },
    async delivered(text) {
      await store.recordDelivery(requestId, threadKey, { state: "delivered", textHash: digest(text) });
      try { input.onDelivered?.(text, requestId, threadTs); } catch { logger.warn("activity: delivery hook failed"); }
    },
  };
}

/**
 * Deliver a finished answer that no live turn is waiting to stream (a turn resumed after a restart).
 * Posts once, edits an earlier send of the same reply, or does nothing when it was already delivered.
 */
export async function deliverAnswer(input: {
  client: Pick<WebClient, "chat">;
  ledger: DeliveryLedger;
  channel: string;
  threadTs: string;
  text: string;
}): Promise<"delivered" | "already-delivered"> {
  const { client, ledger, channel, threadTs } = input;
  const begun = await ledger.begin();
  if (begun.delivered) return "already-delivered";
  const parts = chunk(toMrkdwn(input.text) || "_(no response)_");
  let ts = begun.ts;
  if (ts) {
    try {
      await client.chat.update({ channel, ts, text: parts[0]! });
    } catch (err) {
      // The message an earlier attempt recorded is gone (the live message is cleared to keep the reply last): send it afresh.
      if ((err as { data?: { error?: string } })?.data?.error !== "message_not_found") throw err;
      ts = undefined;
    }
  }
  if (!ts) {
    const res = await client.chat.postMessage({ channel, thread_ts: threadTs, text: parts[0]!, metadata: ledger.metadata });
    ts = res.ts as string;
    await ledger.posted(ts);
  }
  await ledger.partSent(Math.max(1, begun.partsSent));
  for (let index = Math.max(1, begun.partsSent); index < parts.length; index++) {
    // An earlier attempt may have died after sending this part but before recording it.
    if (!begun.fresh && (await ledger.findPart(index))) { await ledger.partSent(index + 1); continue; }
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: parts[index]!, metadata: ledger.metadataFor(index) });
    await ledger.partSent(index + 1);
  }
  await ledger.delivered(input.text);
  return "delivered";
}

const RESUMED = ":arrows_counterclockwise: _Resumed after a restart._\n\n";
const FAILED_AFTER_RESTART = (reason: string) =>
  `:warning: I was restarted while working on this and could not finish it (${reason}). Please ask again.`;

/**
 * A request that was resumed after a restart has no live turn streaming it to Slack: wait for it to settle,
 * then deliver the answer (or an honest failure) through the ledger.
 */
export async function deliverRecoveredRequest(input: {
  store: Pick<DurableChannelStore, "awaitRequest" | "deliveryState" | "recordDelivery">;
  client: Pick<WebClient, "chat" | "conversations">;
  channel: string;
  conversationId: Parameters<DurableChannelStore["awaitRequest"]>[0];
  threadKey: string;
  threadTs: string;
  requestId: string;
  onDelivered?: DeliveryActivity;
}): Promise<"delivered" | "already-delivered"> {
  const result = await input.store.awaitRequest(input.conversationId, input.requestId);
  const text = "text" in result
    ? `${RESUMED}${result.text.trim() || "_(no response)_"}`
    : FAILED_AFTER_RESTART(result.failed);
  return deliverAnswer({
    client: input.client,
    ledger: storeLedger({ ...input, client: input.client }),
    channel: input.channel,
    threadTs: input.threadTs,
    text,
  });
}

/**
 * After a restart: finish deliveries that were started but not completed. A request whose answer was committed
 * but never (fully) reached Slack gets it now; one still being worked on is handled by recovery itself.
 */
export async function reconcileDeliveries(input: {
  store: Pick<DurableChannelStore, "pendingDeliveries" | "requestOutcome" | "deliveryState" | "recordDelivery">;
  client: Pick<WebClient, "chat" | "conversations">;
  channel: string;
  onDelivered?: DeliveryActivity;
}): Promise<{ delivered: string[]; skipped: string[] }> {
  const out = { delivered: [] as string[], skipped: [] as string[] };
  for (const record of await input.store.pendingDeliveries()) {
    const outcome = await input.store.requestOutcome(record.threadKey, record.requestId);
    if (!outcome || outcome.status === "pending") { out.skipped.push(record.requestId); continue; }
    const text = outcome.status === "answered" ? outcome.text : FAILED_AFTER_RESTART(outcome.reason);
    try {
      await deliverAnswer({
        client: input.client,
        ledger: storeLedger({ store: input.store, client: input.client, channel: input.channel, threadTs: record.threadTs, threadKey: record.threadKey, requestId: record.requestId, onDelivered: input.onDelivered }),
        channel: input.channel,
        threadTs: record.threadTs,
        text: outcome.status === "answered" && !text.trim() ? "_(no response)_" : text,
      });
      out.delivered.push(record.requestId);
    } catch (err) {
      logger.warn(`could not finish delivery of ${record.requestId}: ${err instanceof Error ? err.message : String(err)}`);
      out.skipped.push(record.requestId);
    }
  }
  return out;
}
