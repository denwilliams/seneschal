import type { WebClient } from "@slack/web-api";
import { chunk, toMrkdwn } from "./format.ts";
import { logger } from "../util/log.ts";
import type { DeliveryLedger } from "./delivery.ts";

/**
 * Streams an agent response into a Slack message.
 *
 * Slack has no typing indicator for bots, so acknowledgement is a reaction on
 * the user's own message — it appears instantly, reads as "seen, working on
 * it", and disappears when the reply lands. No placeholder message is posted.
 *
 * The reply message is created lazily: on the first token of real text, or
 * once a tool has been running long enough that silence would look like a
 * hang. A fast answer therefore produces exactly one message with no visible
 * intermediate state.
 *
 * Status lines can also be deferred individually (see `setStatus`), which is
 * how tool activity is kept off screen until a turn actually goes quiet.
 *
 * In assistant threads (the DM surface) Slack does provide a native status
 * indicator, so we drive that too where it is available.
 *
 * Updates are throttled: Slack allows roughly one chat.update per second.
 */

const UPDATE_INTERVAL_MS = 1_200;
/** How long to work silently before showing progress for a slow turn. */
const PROGRESS_AFTER_MS = 3_000;
/** How long a turn must produce nothing before deferred status is worth showing. */
const QUIET_AFTER_MS = 10_000;
/** How often to refresh a visible status-only reply so it is clearly alive. */
const STATUS_HEARTBEAT_MS = 30_000;

/**
 * A failing reaction is a configuration problem, not a transient blip, so it
 * is reported once at warn level with the fix rather than buried in debug
 * logs — a silently missing acknowledgement is near-impossible to diagnose.
 */
const reportedReactionErrors = new Set<string>();

function warnReactionFailure(error: string, emoji: string): void {
  if (reportedReactionErrors.has(error)) return;
  reportedReactionErrors.add(error);

  const hint =
    error === "missing_scope" || error === "not_allowed_token_type"
      ? "Add the `reactions:write` bot scope under OAuth & Permissions, then reinstall the app."
      : error === "invalid_name"
        ? `":${emoji}:" is not a valid emoji in this workspace. Set ui.ackEmoji to one that exists.`
        : error === "not_in_channel"
          ? "Invite the bot to this channel (/invite @yourbot)."
          : "Falling back to a progress message instead.";

  logger.warn(`Could not add the acknowledgement reaction (${error}). ${hint}`);
}

/**
 * Messages the harness posts into a thread ahead of a reply (a hand-off to a subagent, an update from one). They carry their
 * own event type so the delivery ledger, which looks for `harness_reply`, never mistakes one for a reply.
 */
export const PROGRESS_EVENT_TYPE = "harness_progress";

const isMessageNotFound = (err: unknown): boolean => (err as { data?: { error?: string } })?.data?.error === "message_not_found";

export interface StreamTargets {
  client: WebClient;
  channel: string;
  threadTs: string;
  /** The user's message, used as the anchor for the acknowledgement reaction. */
  anchorTs?: string;
  /** Reaction used to acknowledge, without colons. */
  ackEmoji: string;
  /** Assistant threads support a native status indicator. */
  assistantThread?: boolean;
  /** Override the throttle. Lower values risk Slack rate limits. */
  updateIntervalMs?: number;
  /** Override how long to work silently before showing progress. */
  progressAfterMs?: number;
  /** Override how long a turn must go quiet before deferred status is shown. */
  quietAfterMs?: number;
  /** Override how often a visible status line is refreshed. */
  statusHeartbeatMs?: number;
}

export class SlackResponseStream {
  private readonly target: StreamTargets;
  private text = "";
  private status = "";
  private messageTs?: string;
  private timer?: NodeJS.Timeout;
  private pending = false;
  private flushing = false;
  private closed = false;
  private startedAt = 0;
  /** Last time the turn produced something the user can see. Resets the quiet clock. */
  private lastOutputAt = 0;
  /** A status held back until the turn goes quiet. See `setStatus`. */
  private deferredStatus?: string;
  /** When the current visible status became active, for elapsed-time heartbeats. */
  private statusStartedAt = 0;
  /** Last time a visible status heartbeat was queued. */
  private lastStatusHeartbeatAt = 0;
  /** Makes the reply idempotent across crashes and redeliveries; attached once the thread's store exists. */
  private ledger?: DeliveryLedger;
  /** How many parts of a multi-part reply an earlier attempt already sent. */
  private partsSent = 0;
  /** An earlier attempt left a record, so a part it may have sent unrecorded must be looked for before sending. */
  private reconcileParts = false;
  /** The ledger says this reply already reached Slack, so nothing more is sent. */
  private alreadyDelivered = false;
  private reacted = false;
  /** Set when acknowledgement failed, so progress is shown in a message instead. */
  private needsVisibleProgress = false;
  /** Text already committed to its own message because something was posted after it (see `postInterjection`). */
  private frozen = "";
  /** Interjections run one at a time, in order. */
  private interjections: Promise<void> = Promise.resolve();

  constructor(target: StreamTargets) {
    this.target = target;
  }

  /**
   * Attach the delivery ledger once it can exist (it lives in the thread's store, which is opened after the
   * acknowledgement). A message already posted before this point is recorded so a crash cannot orphan it.
   */
  async attachLedger(ledger: DeliveryLedger): Promise<void> {
    this.ledger = ledger;
    const begun = await ledger.begin();
    if (begun.delivered) { this.alreadyDelivered = true; return; }
    this.partsSent = begun.partsSent;
    this.reconcileParts = !begun.fresh;
    if (begun.ts && !this.messageTs) this.messageTs = begun.ts;
    else if (this.messageTs && !begun.ts) await ledger.posted(this.messageTs);
  }

  /** Whether the ledger says this request's reply was already delivered (a redelivered event, a resumed turn). */
  get delivered(): boolean {
    return this.alreadyDelivered;
  }

  /** Send the reply message, or edit the one an earlier attempt already sent. The one place a reply is first posted. */
  private async sendReply(text: string): Promise<void> {
    if (this.messageTs) {
      try {
        await this.target.client.chat.update({ channel: this.target.channel, ts: this.messageTs, text });
        return;
      } catch (err) {
        // The message was removed (the live message is cleared to keep it last, and a restart can leave a record of one
        // that is gone): send a fresh one instead of failing the reply.
        if (!isMessageNotFound(err)) throw err;
        this.messageTs = undefined;
      }
    }
    const res = await this.target.client.chat.postMessage({
      channel: this.target.channel,
      thread_ts: this.target.threadTs,
      text,
      ...(this.ledger ? { metadata: this.ledger.metadata } : {}),
    });
    this.messageTs = res.ts as string;
    await this.ledger?.posted(this.messageTs);
  }

  /** Acknowledge the request. Posts nothing; the reply message comes later. */
  async open(): Promise<void> {
    this.startedAt = Date.now();
    this.lastOutputAt = this.startedAt;

    if (this.target.anchorTs) {
      try {
        await this.target.client.reactions.add({
          channel: this.target.channel,
          timestamp: this.target.anchorTs,
          name: this.target.ackEmoji,
        });
        this.reacted = true;
      } catch (err: any) {
        // already_reacted is harmless. Anything else (usually a missing
        // reactions:write scope) means the user has no acknowledgement at all,
        // so fall back to showing progress in a message.
        if (err?.data?.error === "already_reacted") {
          this.reacted = true;
        } else {
          this.needsVisibleProgress = true;
          warnReactionFailure(err?.data?.error ?? String(err), this.target.ackEmoji);
        }
      }
    } else {
      this.needsVisibleProgress = true;
    }

    if (this.target.assistantThread) {
      await this.setAssistantStatus("is thinking...");
    }

    this.timer = setInterval(
      () => void this.flush(),
      this.target.updateIntervalMs ?? UPDATE_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  private async setAssistantStatus(status: string): Promise<void> {
    if (!this.target.assistantThread) return;
    try {
      await this.target.client.assistant.threads.setStatus({
        channel_id: this.target.channel,
        thread_ts: this.target.threadTs,
        status,
      });
    } catch {
      // The app may not have the assistant feature enabled; not worth failing.
    }
  }

  /**
   * Post a message into the thread ahead of the reply while the turn is still running: a hand-off to a subagent, an update
   * from one. The reply is a single live message that is edited as the turn goes on, so a plain post would land BELOW it
   * and the final answer would then appear above everything that came after it was started. To keep the answer last, the
   * live message is first cleared away: removed when it only holds a status line, or fixed in place as an ordinary message
   * when it holds text the agent already streamed. It reappears below the new post on the next update.
   */
  postInterjection(text: string): Promise<void> {
    const run = this.interjections.then(() => this.interject(text));
    this.interjections = run.catch(() => undefined);
    return run;
  }

  private async interject(text: string): Promise<void> {
    if (this.closed || this.alreadyDelivered) return;
    while (this.flushing) await new Promise((r) => setTimeout(r, 25));
    if (this.closed) return;
    this.flushing = true; // keeps an interim update from rewriting the message while it is being moved
    try {
      const { client, channel, threadTs } = this.target;
      if (this.messageTs) {
        const body = toMrkdwn(this.text);
        if (!body) {
          await client.chat.delete({ channel, ts: this.messageTs }).catch((err) => logger.debug("could not clear the live message", err));
        } else {
          await client.chat.update({ channel, ts: this.messageTs, text: body });
          this.frozen += this.text;
          this.text = "";
        }
        this.messageTs = undefined;
      }
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        metadata: { event_type: PROGRESS_EVENT_TYPE, event_payload: { request_id: this.ledger?.metadata.event_payload.request_id ?? "" } },
      });
      this.pending = true; // the live message comes back underneath
    } catch (err) {
      logger.debug("could not post an interjection", err);
    } finally {
      this.flushing = false;
    }
  }

  /** The reply text that is still to be sent: what the final text says beyond what was already fixed in place. */
  private remainder(finalText: string | undefined): string {
    const body = toMrkdwn(finalText ?? this.text);
    if (!this.frozen) return body;
    const already = toMrkdwn(this.frozen);
    if (finalText === undefined) return body; // this.text only ever holds what came after the freeze
    return body.startsWith(already) ? body.slice(already.length).trim() : body;
  }

  appendText(delta: string): void {
    this.text += delta;
    this.lastOutputAt = Date.now();
    this.pending = true;
  }

  /**
   * Transient line describing what the agent is doing right now.
   *
   * With `defer`, the status is held back until the turn has produced nothing
   * for `quietAfterMs` — the point at which silence starts to read as a hang.
   * A tool that starts and finishes inside that window is never shown at all,
   * which keeps a quick answer free of status flicker. Once a turn is in that
   * quiet stretch the clock stays elapsed, so subsequent statuses flow through
   * at the normal flush cadence and the line tracks what is actually running.
   *
   * A deferred status is parked rather than dropped: text arriving resets the
   * clock, but the tool it describes may still be going, so it stays eligible.
   */
  setStatus(status: string, opts?: { defer?: boolean }): void {
    if (this.status === status) {
      this.deferredStatus = undefined;
      return;
    }
    // Without a reaction there is no other acknowledgement, so nothing is held
    // back — the same reason `shouldPost` skips the progress delay.
    if (opts?.defer && !this.needsVisibleProgress && !this.hasGoneQuiet()) {
      this.deferredStatus = status;
      return;
    }
    this.deferredStatus = undefined;
    this.applyStatus(status);
  }

  private applyStatus(status: string): void {
    if (this.status === status) return;
    const now = Date.now();
    this.status = status;
    this.statusStartedAt = now;
    this.lastStatusHeartbeatAt = now;
    this.pending = true;
    void this.setAssistantStatus(status);
  }

  /** Whether the turn has produced nothing for long enough to warrant progress. */
  private hasGoneQuiet(): boolean {
    const quiet = Date.now() - this.lastOutputAt;
    return quiet >= (this.target.quietAfterMs ?? QUIET_AFTER_MS);
  }

  /** Promote a held-back status once the turn has been quiet long enough. */
  private promoteDeferredStatus(): void {
    if (this.deferredStatus === undefined) return;
    if (!this.hasGoneQuiet()) return;
    const status = this.deferredStatus;
    this.deferredStatus = undefined;
    this.applyStatus(status);
  }

  private statusHeartbeatMs(): number {
    return this.target.statusHeartbeatMs ?? STATUS_HEARTBEAT_MS;
  }

  private static formatElapsed(ms: number): string {
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  private maybeQueueStatusHeartbeat(): void {
    if (this.closed || !this.messageTs || !this.status) return;
    const interval = this.statusHeartbeatMs();
    if (interval <= 0) return;

    const now = Date.now();
    if (now - this.lastStatusHeartbeatAt < interval) return;
    this.lastStatusHeartbeatAt = now;
    this.pending = true;
  }

  /**
   * Whether there is anything worth putting on screen yet. Avoids posting a
   * bare "working…" message for a turn that answers in under a second.
   */
  private shouldPost(): boolean {
    if (this.messageTs) return true;
    if (this.text.trim().length > 0) return true;
    const elapsed = Date.now() - this.startedAt;
    if (!this.status) return false;
    // Without a reaction the user has no other signal, so show progress sooner.
    return elapsed >= (this.needsVisibleProgress ? 0 : this.target.progressAfterMs ?? PROGRESS_AFTER_MS);
  }

  private renderStatus(): string {
    if (!this.status) return "";
    const heartbeatDue =
      this.messageTs !== undefined &&
      this.statusStartedAt > 0 &&
      Date.now() - this.statusStartedAt >= this.statusHeartbeatMs();
    const elapsed = heartbeatDue
      ? ` still working (${SlackResponseStream.formatElapsed(Date.now() - this.statusStartedAt)})`
      : "";
    return `_${this.status}${elapsed}_`;
  }

  private renderInterim(): string {
    const body = toMrkdwn(this.text);
    const status = this.renderStatus();
    if (!body) return status || "_working…_";
    const trimmed = body.length > 3600 ? `${body.slice(0, 3600)}…` : body;
    return status ? `${trimmed}\n\n${status}` : trimmed;
  }

  private async flush(): Promise<void> {
    // Runs first: promoting a status is what makes the flush worth doing.
    this.promoteDeferredStatus();
    this.maybeQueueStatusHeartbeat();
    if (!this.pending || this.flushing || this.closed || this.alreadyDelivered) return;
    if (!this.shouldPost()) return;

    this.flushing = true;
    this.pending = false;
    try {
      await this.sendReply(this.renderInterim());
    } catch (err) {
      // Interim failures are not worth failing the turn; close() carries the
      // full text regardless.
      logger.debug("interim update failed", err);
    } finally {
      this.flushing = false;
    }
  }

  private async clearAcknowledgement(): Promise<void> {
    if (this.target.assistantThread) await this.setAssistantStatus("");
    if (!this.reacted || !this.target.anchorTs) return;
    try {
      await this.target.client.reactions.remove({
        channel: this.target.channel,
        timestamp: this.target.anchorTs,
        name: this.target.ackEmoji,
      });
    } catch (err) {
      logger.debug("reactions.remove failed", err);
    } finally {
      this.reacted = false;
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Final render. Posts or updates the reply and drops the acknowledgement. */
  async close(finalText?: string): Promise<void> {
    this.closed = true;
    this.stopTimer();

    // Posts queued ahead of the reply go first, so the answer is the last thing in the thread.
    await this.interjections;
    const remaining = this.remainder(finalText);
    const body = remaining || (this.frozen ? "" : "_(no response)_");
    const parts = chunk(body);

    // Let any in-flight interim update settle so it cannot land after this one.
    while (this.flushing) await new Promise((r) => setTimeout(r, 50));

    try {
      if (this.alreadyDelivered) return;
      if (!body) {
        // Everything the agent said was already fixed in place before a post went out: there is nothing left to add.
        if (this.messageTs) await this.target.client.chat.delete({ channel: this.target.channel, ts: this.messageTs }).catch(() => undefined);
        await this.ledger?.delivered(finalText ?? this.text);
        return;
      }
      await this.sendReply(parts[0]!);
      // Parts an earlier attempt already sent are not sent again; the first is always (re)written.
      await this.ledger?.partSent(Math.max(1, this.partsSent));
      for (let index = Math.max(1, this.partsSent); index < parts.length; index++) {
        if (this.reconcileParts && this.ledger && (await this.ledger.findPart(index))) {
          await this.ledger.partSent(index + 1);
          continue;
        }
        await this.target.client.chat.postMessage({
          channel: this.target.channel,
          thread_ts: this.target.threadTs,
          text: parts[index]!,
          ...(this.ledger ? { metadata: this.ledger.metadataFor(index) } : {}),
        });
        await this.ledger?.partSent(index + 1);
      }
      await this.ledger?.delivered(finalText ?? this.text);
    } finally {
      await this.clearAcknowledgement();
    }
  }

  /**
   * Finish without leaving a reply behind.
   *
   * Used when the agent already said what it had to say through `post_message`
   * and has nothing left to add — posting "(no response)" underneath would just
   * be noise. Any progress message that was shown gets cleaned up.
   */
  async discard(): Promise<void> {
    this.closed = true;
    this.stopTimer();
    await this.interjections;
    while (this.flushing) await new Promise((r) => setTimeout(r, 50));

    try {
      if (this.messageTs && !this.alreadyDelivered) {
        await this.target.client.chat.delete({
          channel: this.target.channel,
          ts: this.messageTs,
        });
      }
      // The agent said what it had to through post_message: that is this request's delivery.
      await this.ledger?.delivered("");
    } catch (err) {
      logger.debug("could not remove progress message", err);
    } finally {
      await this.clearAcknowledgement();
    }
  }

  /** Replace the acknowledgement with an error notice. */
  async fail(message: string): Promise<void> {
    this.closed = true;
    this.stopTimer();
    await this.interjections;
    // Let an active update finish before replacing it, or an initial post
    // establish messageTs so the notice edits it instead of leaving an orphan.
    while (this.flushing) await new Promise((r) => setTimeout(r, 50));

    const text = `:warning: ${message}`;
    try {
      if (!this.alreadyDelivered) {
        await this.sendReply(text);
        await this.ledger?.delivered(text);
      }
    } catch (err) {
      logger.error("failed to report error to Slack", err);
    } finally {
      await this.clearAcknowledgement();
    }
  }
}
