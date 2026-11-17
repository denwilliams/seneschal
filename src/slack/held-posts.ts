import { randomBytes } from "node:crypto";
import type { KnownBlock } from "@slack/types";
import { escapeSlack } from "./subagent-progress.ts";

/**
 * Posts the reviewer held back, waiting for the person they would be posted as.
 *
 * The draft is kept here on the server and the buttons carry only a random id, so a click cannot be pointed at different text.
 * A held post that is not decided within the time limit is dropped, and a decided one can never be sent twice.
 */

export const HELD_UNBLOCK_ACTION = "harness_post_unblock";
export const HELD_DISMISS_ACTION = "harness_post_dismiss";

export const HELD_POST_TTL_MS = 30 * 60_000;
const MAX_PENDING = 20;
/** Slack allows 3000 characters in one block; long text goes in several. */
const BLOCK_CHARS = 2600;

export interface HeldPost {
  id: string;
  postAsUser: string;
  sourceChannelId: string;
  sourceThreadTs?: string;
  targetChannelId: string;
  targetLabel: string;
  text: string;
  source: string;
  reason: string;
  heldBecause: string;
  threadTs?: string;
  expiresAt: number;
}

export class PendingHeldPosts {
  private readonly items = new Map<string, HeldPost>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  add(input: Omit<HeldPost, "id" | "expiresAt">): HeldPost {
    this.sweep();
    if (this.items.size >= MAX_PENDING) throw new Error("Too many held posts are waiting; unblock or dismiss those, or let them expire first.");
    const item: HeldPost = { ...input, id: randomBytes(6).toString("hex"), expiresAt: this.now() + HELD_POST_TTL_MS };
    this.items.set(item.id, item);
    return item;
  }

  /** Removes and returns it, so a second click finds nothing. Undefined when unknown, already decided, or expired. */
  take(id: string): HeldPost | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    return item.expiresAt > this.now() ? item : undefined;
  }

  /** Looks without taking. */
  peek(id: string): HeldPost | undefined {
    const item = this.items.get(id);
    return item && item.expiresAt > this.now() ? item : undefined;
  }

  private sweep(): void {
    for (const [id, item] of this.items) if (item.expiresAt <= this.now()) this.items.delete(id);
  }
}

const section = (text: string): KnownBlock => ({ type: "section", text: { type: "mrkdwn", text } });

const ZWJ = "\u200D";

/**
 * Untrusted text that will sit inside a ``` fence. No two backticks are left next to each other (a zero-width joiner goes
 * between them), so the text can never close the fence it is quoted in and carry on as live mrkdwn.
 */
const defuseFences = (s: string): string => s.replace(/`(?=`)/g, `\`${ZWJ}`);

/** Untrusted text for a header line: one line, escaped, so it can neither mention anything nor fake another header line. */
export const line = (s: string): string => escapeSlack(defuseFences(s.replace(/\s+/g, " ").trim()));

/** Untrusted text as quoted blocks that each fit in one Slack block. Escaped, so it cannot mention or link anything. None is dropped. */
function quoteBlocks(label: string, raw: string): KnownBlock[] {
  // Sized by the escaped length ("&" becomes "&amp;"), and never split inside an entity.
  const pieces: string[] = [];
  let piece = "";
  for (const ch of defuseFences(raw)) {
    const escaped = escapeSlack(ch);
    if (piece.length + escaped.length > BLOCK_CHARS) { pieces.push(piece); piece = ""; }
    piece += escaped;
  }
  pieces.push(piece);
  return pieces.map((piece, n) => {
    const head = n === 0 ? `*${label}*\n` : "";
    // Code fences stop mrkdwn from rendering the text as formatting, and the text is escaped on top of that. A piece that
    // starts or ends with a backtick is padded so it does not join the fence.
    const body = `${piece.startsWith("`") ? ZWJ : ""}${piece}${piece.endsWith("`") ? ZWJ : ""}`;
    return section(`${head}\`\`\`${body}\`\`\``);
  });
}

export function buildHeldAlertBlocks(item: HeldPost): KnownBlock[] {
  return [
    section(
      `:no_entry: *A post was held and needs your say-so*\n` +
        `*To:* ${line(item.targetLabel)}\n` +
        `*Held because:* ${line(item.heldBecause)}\n` +
        `*Reason given:* ${line(item.reason)}`,
    ),
    ...quoteBlocks("Draft", item.text),
    ...quoteBlocks("Source", item.source),
    section(`_<@${item.postAsUser}> can unblock or dismiss this. Expires in ${Math.round(HELD_POST_TTL_MS / 60_000)} minutes._`),
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Unblock & send" }, style: "primary", action_id: HELD_UNBLOCK_ACTION, value: item.id },
        { type: "button", text: { type: "plain_text", text: "Dismiss" }, action_id: HELD_DISMISS_ACTION, value: item.id },
      ],
    },
  ];
}

export function buildReceiptBlocks(input: {
  label: string;
  permalink?: string;
  reason: string;
  source: string;
  text: string;
  sourceVerified: boolean;
  unblockedBy?: string;
  /** Sent, but the permalink could not be fetched. */
  noLink?: boolean;
}): KnownBlock[] {
  const label = line(input.label);
  const head = input.permalink
    ? `:white_check_mark: Sent to ${label}: <${input.permalink}|view message>`
    : input.noLink
      ? `:white_check_mark: Sent to ${label} (no link)`
      : `:hourglass_flowing_sand: Sending to ${label}…`;
  const notes = [
    `*Reason:* ${line(input.reason)}`,
    ...(input.unblockedBy ? [`Unblocked by <@${input.unblockedBy}>`] : []),
    ...(input.sourceVerified ? [] : ["_source unverified_"]),
  ];
  return [
    section(`${head}\n${notes.join("\n")}`),
    ...quoteBlocks("Draft", input.text),
    ...quoteBlocks("Source", input.source),
  ];
}

/** After a click: the outcome line (built and escaped by the caller), then the draft, so the record stays visible without buttons. */
export function decidedHeldBlocks(item: HeldPost, text: string): KnownBlock[] {
  return [section(text), ...quoteBlocks("Draft", item.text)];
}
