import { Cron } from "croner";
import { logger } from "../util/log.ts";

/**
 * The clock behind the feedback digest.
 *
 * Same machinery as the dreamer, different thing again: one job for the whole
 * harness rather than one per channel, because the digest is an account-wide
 * view going to one place. It is the half of `report_limitation` that makes the
 * harness actually improve — reports accumulating in a file change nothing
 * until somebody reads them, and nobody reads a file they have to remember.
 *
 * Firing does not mean posting: the run decides there is nothing new and stays
 * quiet. A digest that arrives every week whether or not anything happened is
 * one people stop opening, which puts us back where we started.
 */

export interface DigestSettings {
  /** Channel name or id. Empty disables the digest entirely. */
  channel: string;
  cron: string;
  timezone: string;
}

export class FeedbackDigester {
  private readonly settings: DigestSettings;
  private readonly run: () => Promise<void>;
  private job?: Cron;
  private stopped = false;

  constructor(settings: DigestSettings, run: () => Promise<void>) {
    this.settings = settings;
    this.run = run;
  }

  start(): void {
    if (!this.settings.channel.trim()) return;

    try {
      this.job = new Cron(
        this.settings.cron,
        { timezone: this.settings.timezone, catch: true },
        () => this.fire(),
      );
    } catch (err) {
      logger.warn(`feedback digest: "${this.settings.cron}" is not a usable cron expression`, err);
      return;
    }
    if (!this.job.nextRun()) {
      this.job.stop();
      this.job = undefined;
      return;
    }
    logger.info(
      `feedback digest: posting to ${this.settings.channel} at "${this.settings.cron}" (${this.settings.timezone})`,
    );
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.run();
    } catch (err) {
      // Telling someone what the harness could not do must never be the reason
      // the harness stops working.
      logger.warn("feedback digest: failed to post", err);
    }
  }

  stop(): void {
    this.stopped = true;
    this.job?.stop();
    this.job = undefined;
  }
}
