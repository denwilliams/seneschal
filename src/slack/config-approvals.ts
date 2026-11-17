import { randomBytes } from "node:crypto";
import type { KnownBlock } from "@slack/types";
import type { ConfigEdit } from "../config/edit.ts";
import { escapeSlack } from "./subagent-progress.ts";

/**
 * Config changes that wait for a person's click.
 *
 * The agent proposes; nothing is written until someone on the approver list presses Approve. The edits are kept here, on the
 * server, and the button carries only a random id, so a click cannot be pointed at a different change. A request that is not
 * decided within the time limit is dropped, and a decided one can never be applied twice.
 */

export const CONFIG_APPROVE_ACTION = "harness_config_approve";
export const CONFIG_DENY_ACTION = "harness_config_deny";

export const CONFIG_APPROVAL_TTL_MS = 30 * 60_000;
const MAX_PENDING = 20;
/** What an approver is shown must be all of it: a change too big to show in full is refused rather than cut short. */
const MAX_SUMMARY_CHARS = 15_000;
/** Slack allows 3000 characters in one block; a long summary goes in several. */
const BLOCK_CHARS = 2600;

export interface PendingConfigChange {
  id: string;
  edits: ConfigEdit[];
  reason: string;
  /** The admin channel and where the request was made. */
  channelId: string;
  channelKey?: string;
  threadTs: string;
  requestedBy: string;
  approvers: string[];
  expiresAt: number;
  summary: string[];
}

export class PendingConfigChanges {
  private readonly items = new Map<string, PendingConfigChange>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  add(input: Omit<PendingConfigChange, "id" | "expiresAt">): PendingConfigChange {
    this.sweep();
    if (this.items.size >= MAX_PENDING) throw new Error("Too many changes are waiting for approval; decide or let those expire first.");
    const item: PendingConfigChange = { ...input, id: randomBytes(6).toString("hex"), expiresAt: this.now() + CONFIG_APPROVAL_TTL_MS };
    this.items.set(item.id, item);
    return item;
  }

  /** Removes and returns it, so a second click finds nothing. Undefined when unknown, already decided, or expired. */
  take(id: string): PendingConfigChange | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    return item.expiresAt > this.now() ? item : undefined;
  }

  /** Looks without taking. */
  peek(id: string): PendingConfigChange | undefined {
    const item = this.items.get(id);
    return item && item.expiresAt > this.now() ? item : undefined;
  }

  private sweep(): void {
    for (const [id, item] of this.items) if (item.expiresAt <= this.now()) this.items.delete(id);
  }
}

const show = (value: unknown): string => (value === undefined ? "(not set)" : JSON.stringify(value));
const isTree = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only what differs: a change to one key inside a big map shows that key, not the whole map. */
function leaves(path: string, before: unknown, after: unknown): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isTree(before) && isTree(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((k) => leaves(`${path}.${k}`, before[k], after[k]));
  }
  return [{ path, before, after }];
}

/** The lines the approver reads: every difference in full. Throws when they would not fit in a message. */
export function summariseChanges(changes: { path: string; before: unknown; after: unknown }[]): string[] {
  const lines = changes.flatMap((c) => leaves(c.path, c.before, c.after)).map((c) => `${c.path}\n  was: ${show(c.before)}\n  now: ${show(c.after)}`);
  if (lines.join("\n").length > MAX_SUMMARY_CHARS) {
    throw new Error("That change is too large to show in full for approval. Split it into smaller requests.");
  }
  return lines;
}

/** The summary as code blocks that each fit in one Slack block. */
function summaryBlocks(summary: string[]): KnownBlock[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of summary) {
    // A single value longer than a block is cut into pieces, so none of it is hidden.
    for (let i = 0; i < Math.max(line.length, 1); i += BLOCK_CHARS) {
      const piece = line.slice(i, i + BLOCK_CHARS);
      if (current && current.length + piece.length + 1 > BLOCK_CHARS) { chunks.push(current); current = ""; }
      current += (current ? "\n" : "") + piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((text) => ({ type: "section" as const, text: { type: "mrkdwn" as const, text: `\`\`\`${escapeSlack(text)}\`\`\`` } }));
}

export function buildConfigApprovalBlocks(item: PendingConfigChange): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:lock: *Harness config change needs your approval*\n` +
          `*Why:* ${escapeSlack(item.reason)}\n` +
          `_Requested during <@${item.requestedBy}>'s turn. ${item.approvers.map((u) => `<@${u}>`).join(" ")} can approve. Expires in 30 minutes._`,
      },
    },
    ...summaryBlocks(item.summary),
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Approve and apply" }, style: "primary", action_id: CONFIG_APPROVE_ACTION, value: item.id },
        { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: CONFIG_DENY_ACTION, value: item.id },
      ],
    },
  ];
}

export function decidedConfigBlocks(item: PendingConfigChange, text: string): KnownBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    ...summaryBlocks(item.summary),
  ];
}
