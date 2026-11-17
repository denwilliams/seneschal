import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedPostAs } from "../workspace/resolve.ts";

/**
 * `post_as_user`: lets the agent post to a channel as a real person, on that
 * person's behalf. Everything safety-relevant (deterministic checks, reviewer,
 * hold/alert, footer, rate limit) lives in the poster; this tool validates the
 * input, bounds its size, and reports the outcome plainly to the agent.
 */

export type PostAsOutcome =
  | { status: "sent"; label: string; permalink?: string }
  | { status: "held"; reason: string };

export interface UserPoster {
  postAsUser(input: {
    sourceChannelId: string;
    sourceThreadTs?: string;
    postAs: ResolvedPostAs;
    channelDescription?: string;
    target: string;
    text: string;
    source: string;
    reason: string;
    threadTs?: string;
    sourceVerified: boolean;
  }): Promise<PostAsOutcome>;
}

export interface PostAsToolsContext {
  poster: UserPoster;
  sourceChannelId: string;
  postAs: ResolvedPostAs | undefined;
  channelDescription?: string;
  currentThreadTs: () => string | undefined;
  verifySource: (quote: string) => Promise<boolean>;
}

// Caps are enforced here, before the poster runs: the downstream link filter
// has a regex that is quadratic on long dotted strings and relies on them.
const MAX_TEXT = 3000;
const MAX_SOURCE = 1500;
const MAX_REASON = 300;

const MAX_TARGET = 200;
const MIN_QUOTE = 12;
const THREAD_TS = /^\d+\.\d+$/;
// Whitespace and the invisible characters that render as nothing: text made only of these is blank.
const BLANK = /^[\s\u200B-\u200D\u2060\uFEFF\u00AD]*$/;

/**
 * Every quoted run inside `source` of at least MIN_QUOTE characters (after
 * collapsing whitespace), enclosed in matching double quotes (straight or
 * curly) or single quotes. Single quotes only count as delimiters at word
 * boundaries so apostrophes ("don't") are not mistaken for them. Empty when
 * there is none.
 */
export function extractQuotes(source: string): string[] {
  const patterns = [
    /"([^"]+)"/g,
    /“([^“”]+)”/g,
    /(?<![\p{L}\p{N}])'([^']+)'(?![\p{L}\p{N}])/gu,
  ];
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const q = (m[1] ?? "").replace(/\s+/g, " ").trim();
      if (q.length >= MIN_QUOTE && !out.includes(q)) out.push(q);
    }
  }
  return out;
}

/**
 * Whether `source` is backed by the conversation. With quoted runs, EVERY one
 * must be found, so one genuine sentence cannot vouch for a fabricated rest.
 * With none, the whole string is checked.
 */
async function verifyAll(source: string, verify: (quote: string) => Promise<boolean>): Promise<boolean> {
  const quotes = extractQuotes(source);
  for (const q of quotes.length > 0 ? quotes : [source]) {
    try {
      if ((await verify(q)) !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function required(value: unknown, name: string, max?: number): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || BLANK.test(v)) throw new Error(`\`${name}\` is required and must not be blank.`);
  if (max !== undefined && v.length > max) {
    throw new Error(`\`${name}\` is too long (${v.length} characters); the limit is ${max}.`);
  }
  return v;
}

export function createPostAsTools(ctx: PostAsToolsContext): ToolDefinition[] {
  const postAs = ctx.postAs;
  if (!postAs) return [];

  const tool = defineTool({
    name: "post_as_user",
    label: "Post as user",
    description:
      "Post a message to a Slack channel as a real person (the configured user), on their behalf. " +
      "Use only when someone has explicitly asked you to post something for that person. " +
      "The message is text only: no files or attachments. " +
      "A footer saying it was sent by Claude on the person's behalf is added automatically, so do not write one. " +
      "`source` must be the verbatim request that prompted this post, including who sent it and where, " +
      "for example: Alice in #ops: \"please tell #general the deploy is done\". It is checked against the conversation. " +
      "Every post is reviewed or held before it is sent. If it is held, the post was NOT sent, the channel owner is alerted, " +
      "and the hold is final for this attempt: do not retry, re-word, or try another route.",
    parameters: Type.Object({
      target: Type.String({ description: `The destination channel name or Slack channel id. Max ${MAX_TARGET} characters.` }),
      text: Type.String({
        description: `The message to post, in Slack mrkdwn. This is the whole message. Max ${MAX_TEXT} characters.`,
      }),
      source: Type.String({
        description: `The verbatim request that prompted this post, with who sent it and where. Max ${MAX_SOURCE} characters.`,
      }),
      reason: Type.String({ description: `One line on why this post is appropriate. Max ${MAX_REASON} characters.` }),
      thread_ts: Type.Optional(
        Type.String({ description: "Thread timestamp in the target channel to reply in. Omit for a top-level post." }),
      ),
    }),
    execute: async (
      _id,
      params: { target: string; text: string; source: string; reason: string; thread_ts?: string },
    ) => {
      const target = required(params.target, "target", MAX_TARGET);
      const text = required(params.text, "text", MAX_TEXT);
      const source = required(params.source, "source", MAX_SOURCE);
      const reason = required(params.reason, "reason", MAX_REASON);
      const threadTs = typeof params.thread_ts === "string" ? params.thread_ts.trim() : "";
      if (threadTs && !THREAD_TS.test(threadTs)) {
        throw new Error("`thread_ts` must be a Slack message timestamp such as 1712345678.123456, or omitted for a top-level post.");
      }

      const sourceVerified = await verifyAll(source, ctx.verifySource);

      const sourceThreadTs = ctx.currentThreadTs();
      const outcome = await ctx.poster.postAsUser({
        sourceChannelId: ctx.sourceChannelId,
        ...(sourceThreadTs ? { sourceThreadTs } : {}),
        postAs,
        ...(ctx.channelDescription ? { channelDescription: ctx.channelDescription } : {}),
        target,
        text,
        source,
        reason,
        ...(threadTs ? { threadTs } : {}),
        sourceVerified,
      });

      const message =
        outcome.status === "sent"
          ? `Posted to ${outcome.label}` +
            (outcome.permalink ? `: ${outcome.permalink}` : ".") +
            " You do not need to repeat it in your reply."
          : "This post was NOT sent. It was held for review, and the channel owner has been alerted and can release it. " +
            "Do not retry, do not re-word and resend, and do not try another route. " +
            "Tell the person it was held and leave it with the owner.";

      return {
        content: [{ type: "text" as const, text: message }],
        details: outcome,
      };
    },
  });

  return [tool] as ToolDefinition[];
}
