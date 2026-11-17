import { Cron } from "croner";
import { UsageLog, type UsageSummary } from "../agent/usage.ts";
import { logger } from "../util/log.ts";

/** The visible marker also tells us it is safe to replace or clear the topic. */
export const TOPIC_USAGE_PREFIX = "🤖 ";
export const TOPIC_USAGE_CRON = "*/15 * * * *";

export interface ChannelTopicUsageSettings {
  enabled: boolean;
  /** Required public Slack channel ID (validated in the harness config). */
  channel: string;
  timezone: string;
}

export interface SlackTopic {
  value: string;
  creator?: string;
}

export interface TopicUsageSnapshot {
  oneHour: UsageSummary;
  twentyFourHours: UsageSummary;
  /** Undefined when neither rolling window has recorded usage. */
  topic?: string;
}

function nonCachedTokens(summary: UsageSummary): number {
  return Math.max(0, summary.totalTokens - summary.cacheReadTokens - summary.cacheWriteTokens);
}

function cachedTokens(summary: UsageSummary): number {
  return summary.cacheReadTokens + summary.cacheWriteTokens;
}

function hasUsage(summary: UsageSummary): boolean {
  return nonCachedTokens(summary) > 0 || cachedTokens(summary) > 0 || summary.costUsd > 0;
}

/** Compact token formatting for the deliberately short Slack channel topic. */
export function formatTopicTokenCount(value: number): string {
  if (value < 1000) return Math.round(value).toString();
  const divisor = value < 1_000_000 ? 1000 : 1_000_000;
  const suffix = divisor === 1000 ? "k" : "M";
  const scaled = value / divisor;
  const digits = scaled < 10 ? 1 : 0;
  return `${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
}

function formatTopicCost(value: number, unknownCostCalls: number): string {
  if (unknownCostCalls > 0) {
    // A zero known-cost subtotal must not imply that the actual cost was zero.
    // Keep this explicit rather than hiding uncertainty behind the estimate mark.
    if (value === 0) return "unknown";
    const known = Math.abs(value) < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
    return `${known} + unknown`;
  }
  if (value === 0) return "$0";
  return Math.abs(value) < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function windowText(label: "1h" | "24h", summary: UsageSummary): string {
  return `${label}: ${formatTopicTokenCount(nonCachedTokens(summary))} [+${formatTopicTokenCount(cachedTokens(summary))}] ~${formatTopicCost(summary.costUsd, summary.unknownCostCalls)}`;
}

export function formatTopicUsage(oneHour: UsageSummary, twentyFourHours: UsageSummary): string {
  return `${TOPIC_USAGE_PREFIX}${windowText("1h", oneHour)} | ${windowText("24h", twentyFourHours)}`;
}

/** Aggregate all channels' recorded usage using a single, consistent clock. */
export function topicUsageSnapshot(log: UsageLog, now = new Date()): TopicUsageSnapshot {
  const oneHour = log.summarize({
    since: new Date(now.getTime() - 60 * 60 * 1000),
    until: now,
  });
  const twentyFourHours = log.summarize({
    since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    until: now,
  });
  return {
    oneHour,
    twentyFourHours,
    ...(hasUsage(oneHour) || hasUsage(twentyFourHours)
      ? { topic: formatTopicUsage(oneHour, twentyFourHours) }
      : {}),
  };
}

export function isTopicUsageTopic(topic: SlackTopic, botUserId: string): boolean {
  return topic.value.startsWith(TOPIC_USAGE_PREFIX) && topic.creator === botUserId;
}

export type TopicUsageUpdateStatus = "updated" | "cleared" | "unchanged" | "human-topic" | "private-channel";

/** A conversation type response reduced to what the public-only feature needs. */
export interface TopicUsageChannel {
  topic: SlackTopic;
  /** `false` only when Slack explicitly identifies this as a public channel. */
  isPrivate: boolean;
}

/**
 * Apply the topic safely. Reading the current topic is necessary to avoid
 * overwriting a person who changed it between scheduled runs; only setTopic is
 * used for a visible change. Topic usage deliberately supports public channels
 * only, so it never needs the broader private-channel topic scope.
 */
export async function syncTopicUsage(input: {
  log: UsageLog;
  botUserId: string;
  getChannel: () => Promise<TopicUsageChannel>;
  setTopic: (topic: string) => Promise<void>;
  now?: Date;
}): Promise<TopicUsageUpdateStatus> {
  const { topic } = topicUsageSnapshot(input.log, input.now);
  const channel = await input.getChannel();
  if (channel.isPrivate) return "private-channel";
  const current = channel.topic;
  const owned = isTopicUsageTopic(current, input.botUserId);

  if (!topic) {
    if (!owned) return "unchanged";
    await input.setTopic("");
    return "cleared";
  }

  if (current.value === topic) return "unchanged";
  if (current.value && !owned) return "human-topic";
  await input.setTopic(topic);
  return "updated";
}

/** One account-wide topic updater, independent of user-created schedules. */
export class ChannelTopicUsageIndicator {
  private readonly settings: ChannelTopicUsageSettings;
  private readonly input: {
    log: UsageLog;
    resolveChannel: (configured: string) => string | undefined;
    botUserId: () => string;
    getChannel: (channelId: string) => Promise<TopicUsageChannel>;
    setTopic: (channelId: string, topic: string) => Promise<void>;
  };
  private job?: Cron;
  private stopped = false;

  constructor(
    settings: ChannelTopicUsageSettings,
    input: {
      log: UsageLog;
      resolveChannel: (configured: string) => string | undefined;
      botUserId: () => string;
      getChannel: (channelId: string) => Promise<TopicUsageChannel>;
      setTopic: (channelId: string, topic: string) => Promise<void>;
    },
  ) {
    this.settings = settings;
    this.input = input;
  }

  start(): void {
    if (!this.settings.enabled || !this.settings.channel.trim()) return;
    try {
      this.job = new Cron(
        TOPIC_USAGE_CRON,
        { timezone: this.settings.timezone, catch: true },
        () => this.fire(),
      );
    } catch (err) {
      logger.warn(`channel topic usage: "${TOPIC_USAGE_CRON}" is not a usable cron expression`, err);
      return;
    }
    if (!this.job.nextRun()) {
      this.job.stop();
      this.job = undefined;
      return;
    }
    logger.info(
      `channel topic usage: updating ${this.settings.channel} every 15 minutes (${this.settings.timezone})`,
    );
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    const channelId = this.input.resolveChannel(this.settings.channel);
    if (!channelId) {
      logger.warn(
        `channel topic usage: no public channel matching "${this.settings.channel}" — ` +
          "check the configured Slack channel ID.",
      );
      return;
    }
    try {
      const status = await syncTopicUsage({
        log: this.input.log,
        botUserId: this.input.botUserId(),
        getChannel: () => this.input.getChannel(channelId),
        setTopic: (topic) => this.input.setTopic(channelId, topic),
      });
      logger.debug(`channel topic usage: ${channelId} ${status}`);
    } catch (err) {
      logger.warn(`channel topic usage: failed to update ${channelId}`, err);
    }
  }

  stop(): void {
    this.stopped = true;
    this.job?.stop();
    this.job = undefined;
  }
}
