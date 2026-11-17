import type { ChannelRegistry } from "../workspace/registry.ts";

/**
 * A visible heartbeat for the channel that owns harness feedback.
 *
 * The feedback digest can be silent for good reasons: no new reports, an empty
 * log, or a cron in the future. Startup is different. If the process reached
 * the point where Slack is connected and background jobs are registered, the
 * operator channel should hear that once, without depending on an agent's
 * memory or prompt text.
 */

export interface StartupNoticeOptions {
  digestChannel: string;
  registry: Pick<ChannelRegistry, "resolveId">;
  harnessName: string;
  botUser?: string;
  botUserId?: string;
  team?: string;
  now?: Date;
  post: (input: { channelId: string; text: string }) => Promise<void>;
}

export type StartupNoticeResult =
  | { status: "disabled" }
  | { status: "no-channel"; configured: string }
  | { status: "posted"; channelId: string };

export function startupNoticeText(opts: {
  harnessName: string;
  botUser?: string;
  botUserId?: string;
  team?: string;
  now?: Date;
}): string {
  const when = (opts.now ?? new Date()).toISOString();
  const details = [`at ${when}`];
  if (opts.botUser) details.push(`bot ${opts.botUser}${opts.botUserId ? ` (${opts.botUserId})` : ""}`);
  if (opts.team) details.push(`workspace ${opts.team}`);

  return `:white_check_mark: *${opts.harnessName} started successfully*\n${details.join(" · ")}`;
}

export async function postStartupNotice(opts: StartupNoticeOptions): Promise<StartupNoticeResult> {
  const configured = opts.digestChannel.trim();
  if (!configured) return { status: "disabled" };

  const channelId = opts.registry.resolveId(configured);
  if (!channelId) return { status: "no-channel", configured };

  await opts.post({
    channelId,
    text: startupNoticeText({
      harnessName: opts.harnessName,
      ...(opts.botUser ? { botUser: opts.botUser } : {}),
      ...(opts.botUserId ? { botUserId: opts.botUserId } : {}),
      ...(opts.team ? { team: opts.team } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    }),
  });
  return { status: "posted", channelId };
}
