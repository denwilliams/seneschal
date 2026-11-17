import type { WebClient } from "@slack/web-api";
import type { ResolvedPostAs } from "../workspace/resolve.ts";
import type { PostAsService } from "./post-as.ts";
import { decidedHeldBlocks, HELD_DISMISS_ACTION, HELD_UNBLOCK_ACTION } from "./held-posts.ts";
import { escapeSlack } from "./subagent-progress.ts";
import { logger } from "../util/log.ts";

/**
 * A click on a held post's **Unblock & send** or **Dismiss**. The service decides who may act on the item and sends;
 * this checks that the channel still has postAs for the same person NOW (the config may have changed since the hold),
 * tells the clicker privately when they cannot act, and redraws the alert when they did.
 */
export async function decideHeldPost(
  deps: {
    client: Pick<WebClient, "chat">;
    service: Pick<PostAsService, "peekHeld" | "unblock" | "dismiss"> | undefined;
    /** The channel's postAs as the config says it is at click time. */
    postAsFor: (channelId: string) => ResolvedPostAs | undefined;
  },
  body: any,
): Promise<void> {
  const action = body?.actions?.[0];
  const id = String(action?.value ?? "");
  const clicker: string = body?.user?.id ?? "";
  const unblock = action?.action_id === HELD_UNBLOCK_ACTION;
  const messageTs: string | undefined = typeof body?.message?.ts === "string" && body.message.ts ? body.message.ts : undefined;

  const tell = async (channel: string, text: string) => {
    if (!channel) {
      logger.warn("post_as_user click: no channel to tell the clicker in; the reply was dropped");
      return;
    }
    await deps.client.chat.postEphemeral({ channel, user: clicker, text }).catch((err: unknown) => {
      logger.warn(`could not post the held-post ephemeral: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  /** Redraw the alert. Never throws: a missing ts or a failed update is logged and the click's outcome stands. */
  const redraw = async (channel: string, text: string, blocks: ReturnType<typeof decidedHeldBlocks>) => {
    if (!messageTs || !channel) {
      logger.warn("post_as_user click: the held-post alert could not be redrawn (no message ts or channel in the click)");
      return;
    }
    try {
      await deps.client.chat.update({ channel, ts: messageTs, text, blocks });
    } catch (err) {
      logger.warn(`could not update the held-post alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const item = deps.service?.peekHeld(id);
  const channel: string = body?.channel?.id || body?.container?.channel_id || item?.sourceChannelId || "";
  if (!deps.service || !item) {
    await tell(channel, "That request has expired or was already decided. Ask again if it is still needed.");
    // An alert from before a restart, or one that expired, would otherwise keep live buttons forever. One that was
    // already redrawn (no buttons left in the clicked message) keeps its record of what was decided.
    const blocks: unknown = body?.message?.blocks;
    const hasButtons = !Array.isArray(blocks) || blocks.some((b: any) => b?.type === "actions" && (b.elements ?? []).some((e: any) => e?.action_id === HELD_UNBLOCK_ACTION || e?.action_id === HELD_DISMISS_ACTION));
    if (messageTs && hasButtons) {
      const line = ":hourglass: This held post expired or was already decided. Nothing more will be sent from it.";
      await redraw(channel, "Held post no longer pending", [{ type: "section", text: { type: "mrkdwn", text: line } }]);
    }
    return;
  }

  let postAs: ResolvedPostAs | undefined;
  try {
    postAs = deps.postAsFor(item.sourceChannelId);
  } catch (err) {
    logger.warn(`post_as_user click: could not resolve ${item.sourceChannelId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!postAs || postAs.user !== item.postAsUser) {
    await tell(channel, `post-as is no longer configured for <@${item.postAsUser}> in this channel, so this post cannot be sent.`);
    return;
  }

  let result: { ok: boolean; message?: string };
  try {
    result = unblock ? await deps.service.unblock(id, clicker) : deps.service.dismiss(id, clicker);
  } catch (err) {
    result = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!result.ok) {
    await tell(channel, result.message ?? "That could not be done.");
    return;
  }

  // The clicker id comes from Slack itself, not from anything in the draft.
  const who = /^[UW][A-Z0-9]{2,}$/.test(clicker) ? `<@${clicker}>` : escapeSlack(clicker);
  const line = unblock ? `:white_check_mark: Unblocked by ${who} and sent.` : `:no_entry: Dismissed by ${who}.`;
  await redraw(channel, unblock ? "Held post sent" : "Held post dismissed", decidedHeldBlocks(item, line));
}
