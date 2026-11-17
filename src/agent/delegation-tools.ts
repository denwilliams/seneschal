import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DelegationTargetConfig } from "../config/schema.ts";

/**
 * Cross-channel delegation is deliberately narrower than posting: the model
 * chooses only from targets this source channel was configured to use, and the
 * harness creates a normal assistant thread in the target channel. The
 * source thread gets the target result or failure automatically once the
 * delegated initial turn finishes. The target still cannot otherwise post back
 * into the source channel.
 */

export interface DelegationResult {
  targetChannelLabel: string;
  threadTs: string;
  permalink?: string;
}

export interface ChannelDelegator {
  transfer(input: {
    sourceChannelId: string;
    sourceChannelLabel: string;
    sourceThreadTs?: string;
    allowedTargets: DelegationTargetConfig[];
    target: string;
    task: string;
    context?: string;
    requestedBy: string;
  }): Promise<DelegationResult>;
}

export interface DelegationToolsContext {
  delegator: ChannelDelegator;
  sourceChannelId: string;
  sourceChannelLabel: string;
  /** Configured channel names/ids this channel may hand work to, with optional routing hints. */
  allowedTargets: DelegationTargetConfig[];
  currentThreadTs: () => string | undefined;
  currentUserId: () => string;
}

function targetList(targets: DelegationTargetConfig[]): string {
  return targets
    .map((t) => `\`${t.channel}\`${t.reason ? ` (${t.reason})` : ""}`)
    .join(", ");
}

export function createDelegationTools(ctx: DelegationToolsContext): ToolDefinition[] {
  // A delegated outcome must return to a real Slack thread. Quiet/headless
  // sessions do not have one, so do not give them a transfer escape hatch.
  if (ctx.allowedTargets.length === 0 || !ctx.currentThreadTs()) return [];

  const transfer = defineTool({
    name: "transfer_to_channel",
    label: "Transfer to another channel assistant",
    description:
      "Transfer a task to another configured channel assistant, so work can run where the right tools, connectors, memory and channel context live. " +
      `This source channel may transfer only to: ${targetList(ctx.allowedTargets)}. ` +
      "Use it when this channel is the wrong place to do the work; do not use it for ordinary replies. " +
      "It is only for ANOTHER channel in that list. It is never for one of your own subagents (the roles on your team inside this channel): those use run_subagent, whatever verb the person used (\"transfer\", \"delegate\", \"hand off\"). " +
      "The target assistant will continue in a new thread in its own channel, and its completion result or failure will be posted back to this source thread.",
    parameters: Type.Object({
      target: Type.String({
        description:
          "The configured target channel name or Slack channel id. Must be one of the targets listed in the tool description; use the reasons there to choose the right one.",
      }),
      task: Type.String({
        description:
          "The concrete task for the target assistant to perform. Include the desired output and constraints.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Brief context from this conversation that the target assistant needs. Include only what should be copied into the target channel.",
        }),
      ),
    }),
    execute: async (_id, params: { target: string; task: string; context?: string }) => {
      const target = params.target.trim();
      const task = params.task.trim();
      const context = params.context?.trim();
      if (!target) throw new Error("Choose a target channel.");
      if (!task) throw new Error("Refusing to transfer an empty task.");

      const result = await ctx.delegator.transfer({
        sourceChannelId: ctx.sourceChannelId,
        sourceChannelLabel: ctx.sourceChannelLabel,
        sourceThreadTs: ctx.currentThreadTs(),
        allowedTargets: ctx.allowedTargets,
        target,
        task,
        ...(context ? { context } : {}),
        requestedBy: ctx.currentUserId(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Transferred to ${result.targetChannelLabel} in a new assistant thread` +
              (result.permalink ? `: ${result.permalink}` : ".") +
              " Its completion result or failure will be posted back here automatically.",
          },
        ],
        details: result,
      };
    },
  });

  return [transfer] as ToolDefinition[];
}
