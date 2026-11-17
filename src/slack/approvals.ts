import type { KnownBlock } from "@slack/types";
import { describeCapability, type Capability } from "../agent/grants.ts";

/**
 * The approval message: what the agent asked for, why, and buttons to decide.
 *
 * The capability, channel and duration ride in the button `value` rather than
 * being looked up from message text, so a click cannot be re-pointed at a
 * different channel by editing anything.
 */

export const APPROVE_ACTION = "harness_grant_approve";
export const DENY_ACTION = "harness_grant_deny";

export interface ApprovalPayload {
  capability: Capability;
  channelId: string;
  /** Minutes, or 0 for "until revoked". */
  minutes: number;
  requestedBy: string;
  threadTs: string;
}

export function encodePayload(payload: ApprovalPayload): string {
  return JSON.stringify(payload);
}

export function decodePayload(value: string): ApprovalPayload | undefined {
  try {
    const parsed = JSON.parse(value) as ApprovalPayload;
    if (!parsed.capability || !parsed.channelId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function durationLabel(minutes: number): string {
  if (minutes === 0) return "Until revoked";
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export interface BuildApprovalOptions {
  capability: Capability;
  channelId: string;
  reason: string;
  requestedBy: string;
  threadTs: string;
  /** Offered durations in minutes; 0 means until revoked. */
  durations: number[];
  approvers: string[];
}

export function buildApprovalBlocks(opts: BuildApprovalOptions): KnownBlock[] {
  const who =
    opts.approvers.length > 0
      ? opts.approvers.map((u) => `<@${u}>`).join(" ")
      : "anyone in this channel";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:lock: *Permission request*\n` +
          `I'd like *${describeCapability(opts.capability)}*.\n\n` +
          `*Why:* ${opts.reason}\n` +
          `_Requested by <@${opts.requestedBy}>. ${who} can approve._`,
      },
    },
    {
      type: "actions",
      elements: [
        ...opts.durations.map((minutes) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: durationLabel(minutes) },
          // The first offered duration is the recommended one.
          ...(minutes === opts.durations[0] ? { style: "primary" as const } : {}),
          action_id: `${APPROVE_ACTION}_${minutes}`,
          value: encodePayload({
            capability: opts.capability,
            channelId: opts.channelId,
            minutes,
            requestedBy: opts.requestedBy,
            threadTs: opts.threadTs,
          }),
        })),
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          action_id: DENY_ACTION,
          value: encodePayload({
            capability: opts.capability,
            channelId: opts.channelId,
            minutes: 0,
            requestedBy: opts.requestedBy,
            threadTs: opts.threadTs,
          }),
        },
      ],
    },
  ];
}

/** Replaces the buttons once a decision is made, so it cannot be clicked twice. */
export function decidedBlocks(
  capability: Capability,
  decision: "approved" | "denied",
  by: string,
  detail: string,
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          decision === "approved"
            ? `:white_check_mark: *${describeCapability(capability)}* approved by <@${by}> — ${detail}.`
            : `:no_entry: *${describeCapability(capability)}* denied by <@${by}>.`,
      },
    },
  ];
}
