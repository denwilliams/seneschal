import type { KnownBlock } from "@slack/types";
import {
  CANNED_RESPONSE_LABELS,
  cannedResponseActionId,
  isCannedResponse,
  type CannedResponse,
} from "../agent/interactive-tools.ts";

/** The complete route is carried by Slack's signed action payload, never text. */
export interface InteractiveResponsePayload {
  version: 1;
  channelId: string;
  threadTs: string;
  question: string;
  response: CannedResponse;
}

export function encodeInteractiveResponsePayload(payload: InteractiveResponsePayload): string {
  return JSON.stringify(payload);
}

export function decodeInteractiveResponsePayload(value: string): InteractiveResponsePayload | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<InteractiveResponsePayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.channelId !== "string" ||
      !parsed.channelId ||
      typeof parsed.threadTs !== "string" ||
      !parsed.threadTs ||
      typeof parsed.question !== "string" ||
      !parsed.question ||
      parsed.question.length > 2_500 ||
      !isCannedResponse(parsed.response)
    ) {
      return undefined;
    }
    return parsed as InteractiveResponsePayload;
  } catch {
    return undefined;
  }
}

const MAX_BUTTON_VALUE_LENGTH = 2_000;

export function buildInteractiveResponseBlocks(input: {
  channelId: string;
  threadTs: string;
  question: string;
  responses: CannedResponse[];
}): KnownBlock[] {
  const elements = input.responses.map((response) => {
    const value = encodeInteractiveResponsePayload({
      version: 1,
      channelId: input.channelId,
      threadTs: input.threadTs,
      question: input.question,
      response,
    });
    // Block Kit rejects values over 2,000 characters. Count UTF-8 bytes as a
    // conservative bound too, so an emoji/control-character-heavy question
    // cannot slip past the final encoded-value check.
    if (
      value.length > MAX_BUTTON_VALUE_LENGTH ||
      Buffer.byteLength(value, "utf8") > MAX_BUTTON_VALUE_LENGTH
    ) {
      throw new Error("The interactive question is too long for Slack's 2,000-character button value limit.");
    }
    return {
      type: "button" as const,
      text: { type: "plain_text" as const, text: CANNED_RESPONSE_LABELS[response] },
      ...(response === "yes" || response === "continue" ? { style: "primary" as const } : {}),
      ...(response === "stop" || response === "cancel" ? { style: "danger" as const } : {}),
      action_id: cannedResponseActionId(response),
      value,
    };
  });

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: input.question },
    },
    { type: "actions", elements },
  ];
}

/** Replaces the controls after a click, so ordinary repeat clicks do not run a second turn. */
export function answeredInteractiveResponseBlocks(input: {
  question: string;
  response: CannedResponse;
  userId: string;
}): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${input.question}\n\n:white_check_mark: *${CANNED_RESPONSE_LABELS[input.response]}* selected by <@${input.userId}>.`,
      },
    },
  ];
}

/**
 * This is deliberately a fixed JSON envelope rather than copied Slack text.
 * The only user-controlled field is their Slack identity; the value is one of
 * the fixed canned choices validated above.
 */
export function interactiveResponsePrompt(input: {
  userId: string;
  response: CannedResponse;
  question: string;
}): string {
  return [
    "A user selected a canned interactive response in this Slack thread.",
    "[Structured user response]",
    JSON.stringify({
      type: "canned_response",
      userId: input.userId,
      response: input.response,
      label: CANNED_RESPONSE_LABELS[input.response],
      question: input.question,
    }),
  ].join("\n");
}
