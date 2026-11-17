import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describeCapability, formatExpiry, type Capability, type Grant } from "./grants.ts";

/**
 * Lets the agent ask for a capability it does not have, instead of failing and
 * leaving the human to work out which config line to edit.
 *
 * The request is deliberately non-blocking: approval can take minutes, and
 * holding the turn open would keep a session and a Slack message pending on a
 * human. The agent asks, says so, and stops; the harness re-prompts the thread
 * once someone approves.
 */

export interface PermissionService {
  /** Capabilities this channel is allowed to request at all. */
  grantable(channelId: string): Capability[];
  active(channelId: string): Grant[];
  /** Post the approval message. Resolves once posted, not once decided. */
  request(input: {
    channelId: string;
    capability: Capability;
    reason: string;
    minutes?: number;
  }): Promise<void>;
}

export interface PermissionToolsContext {
  service: PermissionService;
  channelId: string;
  /** Grantable minus what the channel already has, so it cannot ask pointlessly. */
  requestable: Capability[];
}

export function createPermissionTools(ctx: PermissionToolsContext): ToolDefinition[] {
  const grantable = ctx.requestable;
  if (grantable.length === 0) return [];

  const request = defineTool({
    name: "request_access",
    label: "Request access",
    description:
      "Ask a human in this channel to grant a capability you do not currently have, such as internet access. " +
      "A message with approve/deny buttons is posted; approval is not instant. " +
      "Call this when a task genuinely needs the capability, explain plainly why, then stop and tell the user you have asked. " +
      "Do not call it speculatively or repeatedly for the same thing.",
    parameters: Type.Object({
      capability: Type.String({
        description: `What to request. Available here: ${grantable.join(", ")}.`,
      }),
      reason: Type.String({
        description:
          "Why you need it, in one sentence a human can judge — what you are about to do, not a restatement of the capability.",
      }),
      minutes: Type.Optional(
        Type.Number({
          description:
            "How long you need it for. Ask for the shortest that works; the approver chooses the final duration.",
        }),
      ),
    }),
    execute: async (
      _id,
      params: { capability: string; reason: string; minutes?: number },
    ) => {
      const capability = params.capability as Capability;
      if (!grantable.includes(capability)) {
        throw new Error(
          `"${params.capability}" cannot be requested in this channel. ` +
            `Available: ${grantable.join(", ") || "nothing"}. ` +
            `An operator has to change the harness config to allow anything else.`,
        );
      }
      if (ctx.service.active(ctx.channelId).some((g) => g.capability === capability)) {
        throw new Error(
          `You already have ${describeCapability(capability)}. Try what you were doing.`,
        );
      }

      await ctx.service.request({
        channelId: ctx.channelId,
        capability,
        reason: params.reason,
        ...(params.minutes ? { minutes: params.minutes } : {}),
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Asked the channel to approve ${describeCapability(capability)}. ` +
              `Nobody has decided yet — tell the user you have requested it and stop. ` +
              `You will be prompted again automatically if it is approved.`,
          },
        ],
        details: { capability },
      };
    },
  });

  const list = defineTool({
    name: "list_access",
    label: "List access",
    description:
      "Show what this channel has currently granted you and what you could request.",
    parameters: Type.Object({}),
    execute: async () => {
      const active = ctx.service.active(ctx.channelId);
      const lines = [
        active.length > 0
          ? `Currently granted:\n${active
              .map((g) => `  ${g.capability} (${formatExpiry(g)})`)
              .join("\n")}`
          : "Nothing is currently granted beyond the channel's normal configuration.",
        `Can be requested here: ${grantable.join(", ")}`,
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
        details: { active: active.length },
      };
    },
  });

  return [request, list] as ToolDefinition[];
}
