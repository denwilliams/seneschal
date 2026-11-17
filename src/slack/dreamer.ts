import { Cron } from "croner";
import type { DreamSettings } from "../agent/dream.ts";
import type { ChannelRegistry } from "../workspace/registry.ts";
import { logger } from "../util/log.ts";

/**
 * The clock behind the nightly consolidation pass.
 *
 * Deliberately not the `Scheduler`. A dream is not a scheduled task: nobody
 * created it, it should not count against a channel's schedule limit, it should
 * not appear in `!schedules` beside the things people actually asked for, and
 * cancelling it is a config decision rather than something the agent can do to
 * itself mid-conversation. Same machinery, different thing.
 *
 * One timer per channel rather than one for the whole harness, so that a
 * channel whose dream throws does not take the others down with it, and so
 * per-channel timezones remain possible later without restructuring this.
 *
 * Channels come from the registry, which knows every channel the harness has
 * ever seen. A channel with no state on disk has nothing to consolidate, and
 * `worthDreaming` will say so at the other end.
 */

export type RunDream = (channelId: string) => Promise<void>;

export class Dreamer {
  private readonly settings: DreamSettings;
  private readonly registry: ChannelRegistry;
  private readonly run: RunDream;
  private readonly jobs = new Map<string, Cron>();
  private stopped = false;

  constructor(settings: DreamSettings, registry: ChannelRegistry, run: RunDream) {
    this.settings = settings;
    this.registry = registry;
    this.run = run;
  }

  start(): void {
    if (!this.settings.enabled) return;
    for (const record of this.registry.all()) this.register(record.id);
    if (this.jobs.size > 0) {
      logger.info(
        `dreamer: ${this.jobs.size} channel(s) will consolidate at "${this.settings.cron}" (${this.settings.timezone})`,
      );
    }
  }

  /**
   * Start dreaming for a channel discovered after startup.
   *
   * A channel first spoken to at lunchtime should still dream that night, and
   * the registry only learns about it when a message arrives. Idempotent, so
   * the message handler can call it on every message without thinking.
   */
  register(channelId: string): void {
    if (this.stopped || !this.settings.enabled || this.jobs.has(channelId)) return;

    let job: Cron;
    try {
      job = new Cron(
        this.settings.cron,
        { timezone: this.settings.timezone, catch: true },
        () => this.fire(channelId),
      );
    } catch (err) {
      logger.warn(`dreamer: "${this.settings.cron}" is not a usable cron expression`, err);
      return;
    }
    if (!job.nextRun()) {
      job.stop();
      return;
    }
    this.jobs.set(channelId, job);
  }

  private async fire(channelId: string): Promise<void> {
    if (this.stopped) return;
    try {
      await this.run(channelId);
    } catch (err) {
      // A dream is housekeeping. It failing is worth a log line and nothing
      // more — certainly not an exception escaping into the timer.
      logger.warn(`dreamer: ${channelId} failed to consolidate`, err);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
