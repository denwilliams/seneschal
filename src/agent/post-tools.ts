import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DelegationTargetConfig } from "../config/schema.ts";

/**
 * Lets the agent post to the channel deliberately, rather than only by
 * replying. This is what makes "post the standup summary every morning" or
 * "announce when the deploy finishes" work: the output is a proper channel
 * message, not a reply buried in a thread.
 *
 * Scoped to the current channel, for the same reason scheduling is: a tool
 * that took a channel id would let work started in one channel speak as the
 * bot in another.
 */

export interface ChannelPoster {
  post(input: {
    channelId: string;
    text: string;
    /** Omit to post at channel level; pass a thread ts to reply in-thread. */
    threadTs?: string;
  }): Promise<{ ts: string; permalink?: string }>;
}

export interface PostToolsContext {
  poster: ChannelPoster;
  channelId: string;
  channelLabel: string;
  /** Thread the agent is currently working in, if any. */
  currentThreadTs: () => string | undefined;
}

export function createPostTools(ctx: PostToolsContext): ToolDefinition[] {
  const post = defineTool({
    name: "post_message",
    label: "Post to channel",
    description:
      `Post a message to ${ctx.channelLabel} itself, as a new top-level message everyone sees. ` +
      "Use this when the task is to publish something to the channel — an announcement, a summary, " +
      "a scheduled update — rather than to answer someone in a thread. " +
      "Do not use it to reply to the person you are talking to: your normal reply already reaches them. " +
      "Post the finished content only, with no preamble about what you are doing.",
    parameters: Type.Object({
      text: Type.String({
        description:
          "The message to post, in Slack mrkdwn (*bold*, _italic_, `code`). This is the whole message.",
      }),
      in_thread: Type.Optional(
        Type.Boolean({
          description:
            "Post inside the current thread instead of at channel level. Defaults to false.",
        }),
      ),
    }),
    execute: async (_id, params: { text: string; in_thread?: boolean }) => {
      const text = params.text.trim();
      if (!text) throw new Error("Refusing to post an empty message.");

      const threadTs = params.in_thread ? ctx.currentThreadTs() : undefined;
      const result = await ctx.poster.post({
        channelId: ctx.channelId,
        text,
        ...(threadTs ? { threadTs } : {}),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Posted to ${ctx.channelLabel}${threadTs ? " (in thread)" : ""}. You do not need to repeat it in your reply.`,
          },
        ],
        details: { ts: result.ts, permalink: result.permalink },
      };
    },
  });

  return [post] as ToolDefinition[];
}

/**
 * Publishing to *other* channels, which `post_message` deliberately cannot do.
 *
 * The model never gets to name an arbitrary channel: it chooses from the
 * allowlist this source channel was configured with (`share.postTo`), and the
 * poster re-checks that list before anything is sent. A channel with no
 * targets does not get the tool at all.
 */

export interface CrossChannelPoster {
  postToChannel(input: {
    sourceChannelId: string;
    allowedTargets: DelegationTargetConfig[];
    target: string;
    text: string;
  }): Promise<{ channelLabel: string; ts: string; permalink?: string }>;
}

export interface CrossChannelPostToolsContext {
  poster: CrossChannelPoster;
  sourceChannelId: string;
  /** Configured channel names/ids this channel may publish to, with optional hints. */
  allowedTargets: DelegationTargetConfig[];
}

function targetList(targets: DelegationTargetConfig[]): string {
  return targets
    .map((t) => `\`${t.channel}\`${t.reason ? ` (${t.reason})` : ""}`)
    .join(", ");
}

export function createCrossChannelPostTools(ctx: CrossChannelPostToolsContext): ToolDefinition[] {
  if (ctx.allowedTargets.length === 0) return [];

  const postTo = defineTool({
    name: "post_to_channel",
    label: "Post to another channel",
    description:
      "Publish a new top-level message to a different Slack channel than the one you are working in. " +
      `This channel may post only to: ${targetList(ctx.allowedTargets)}. ` +
      "Use it when the task is to notify or inform that channel — for example, flag a particular email or event to the people there. " +
      "Do not use it to answer the person you are talking to, and do not post to the current channel with it: use `post_message` for that. " +
      "Post the finished message only, with no preamble, and include enough context that it makes sense without this conversation.",
    parameters: Type.Object({
      channel: Type.String({
        description:
          "The target channel name or Slack channel id. Must be one of the channels listed in the tool description.",
      }),
      text: Type.String({
        description:
          "The message to post, in Slack mrkdwn (*bold*, _italic_, `code`). This is the whole message.",
      }),
    }),
    execute: async (_id, params: { channel: string; text: string }) => {
      const target = params.channel.trim();
      const text = params.text.trim();
      if (!target) throw new Error("Choose a target channel.");
      if (!text) throw new Error("Refusing to post an empty message.");

      const result = await ctx.poster.postToChannel({
        sourceChannelId: ctx.sourceChannelId,
        allowedTargets: ctx.allowedTargets,
        target,
        text,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Posted to ${result.channelLabel}` +
              (result.permalink ? `: ${result.permalink}` : ".") +
              " You do not need to repeat it in your reply.",
          },
        ],
        details: { ts: result.ts, permalink: result.permalink },
      };
    },
  });

  return [postTo] as ToolDefinition[];
}
