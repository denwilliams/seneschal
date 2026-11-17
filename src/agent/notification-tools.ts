import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import {
  NotificationError,
  NotificationInbox,
  renderNotifications,
  type NotificationLimits,
} from "./notifications.ts";

/**
 * Tools for the account-wide notification inbox.
 *
 * `submit_notification` is available anywhere batching is enabled: it is the
 * explicit act of sending one channel's update to the shared inbox. Only the
 * configured notification channel gets to collect the whole account's pending
 * submissions, so cross-channel reading stays narrow and deliberate.
 */

export function createNotificationTools(opts: {
  channel: ResolvedChannel;
  /** Slack user id of whoever is talking, for attribution. */
  currentUserId: () => string;
}): ToolDefinition[] {
  const { channel } = opts;
  if (!channel.notifications.enabled) return [];

  const inbox = new NotificationInbox(channel.shared);
  const limits: NotificationLimits = {
    maxPending: channel.notifications.maxPending,
    maxMessageChars: channel.notifications.maxMessageChars,
  };

  const submit = defineTool({
    name: "submit_notification",
    label: "Submit notification",
    description:
      "Submit a short item from this channel to the shared notification inbox for the next batched notification. " +
      "Use this instead of posting noisy one-off morning updates when the user wants them rolled into the notification channel's single digest. " +
      "Do not submit private or sensitive text; the configured notification channel will be able to read it.",
    parameters: Type.Object({
      message: Type.String({
        description:
          "The notification text to include in the batched digest. Keep it concise and self-contained.",
      }),
      title: Type.Optional(
        Type.String({
          description: "Optional short heading for this item, e.g. 'Backups' or 'School calendar'.",
        }),
      ),
    }),
    execute: async (_id, params: { message: string; title?: string }) => {
      try {
        const item = inbox.submit(
          {
            sourceChannelId: channel.ref.id,
            sourceChannelLabel: channel.ref.name ? `#${channel.ref.name}` : channel.ref.id,
            userId: opts.currentUserId(),
            ...(params.title ? { title: params.title } : {}),
            message: params.message,
          },
          limits,
        );
        const target = channel.notifications.channel
          ? ` for ${channel.notifications.channel}`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Queued notification \`${item.id}\`${target}. It will be included when the notification channel collects the batch.`,
            },
          ],
          details: { id: item.id, pending: inbox.pending().length },
        };
      } catch (err) {
        if (err instanceof NotificationError) throw new Error(err.message);
        throw err;
      }
    },
  });

  const collect = defineTool({
    name: "collect_notifications",
    label: "Collect notifications",
    description:
      "Collect pending shared notification submissions so the notification channel's scheduled agent can summarise them into one Slack post. " +
      "Only the channel configured as notifications.channel may use this. Collection marks returned items as delivered so they will not appear in the next batch.",
    parameters: Type.Object({
      max: Type.Optional(
        Type.Number({
          description:
            "Maximum number of pending submissions to collect. Omit to collect up to the configured inbox limit.",
        }),
      ),
    }),
    execute: async (_id, params: { max?: number }) => {
      if (!channel.notifications.canCollect) {
        throw new Error(
          channel.notifications.channel
            ? `Only ${channel.notifications.channel} can collect batched notifications.`
            : "No notification channel is configured. Set notifications.channel in harness.yaml first.",
        );
      }

      const max = params.max ? Math.min(Math.floor(params.max), limits.maxPending) : limits.maxPending;
      const items = inbox.collect({ channelId: channel.ref.id, userId: opts.currentUserId(), max });
      const body = renderNotifications(items);
      return {
        content: [
          {
            type: "text" as const,
            text:
              items.length === 0
                ? "No pending notifications to summarise."
                : [
                    `Collected ${items.length} notification${items.length === 1 ? "" : "s"}.`,
                    "Summarise these into a single Slack post for this channel; do not post each item separately.",
                    "",
                    body,
                  ].join("\n"),
          },
        ],
        details: { count: items.length, ids: items.map((item) => item.id) },
      };
    },
  });

  return [submit, collect] as ToolDefinition[];
}
