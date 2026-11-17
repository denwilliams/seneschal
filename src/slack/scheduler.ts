import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
  ScheduleStore,
  applyScheduleUpdate,
  buildCron,
  heartbeatAfter,
  missedCronRun,
  type CreateScheduleInput,
  type ScheduleLimits,
  type ScheduleRun,
  type ScheduledTask,
  type UpdateScheduleInput,
} from "../agent/schedules.ts";
import type { ScheduleService } from "../agent/schedule-tools.ts";
import { logger } from "../util/log.ts";

/**
 * Owns the live timers for scheduled work.
 *
 * Definitions live on disk per channel; this keeps one Cron per task in memory
 * and re-registers everything at startup. Runs missed while the harness was
 * down are normally not replayed — a home deployment restarting should not
 * suddenly fire a week of backlogged reminders. Individual cron tasks can opt
 * in to one catch-up run after startup.
 */

/** Outcome returned by the Slack/agent runner after one scheduled execution. */
export interface ScheduledTaskRunResult {
  status: "completed" | "failed";
  error?: string;
  /** Permalink to the visible scheduled thread, if there is one. */
  slackOutputUrl?: string;
}

export type RunScheduledTask = (task: ScheduledTask) => Promise<ScheduledTaskRunResult>;

export class Scheduler implements ScheduleService {
  private readonly store: ScheduleStore;
  private readonly limits: ScheduleLimits;
  private readonly run: RunScheduledTask;
  private readonly jobs = new Map<string, Cron>();
  private stopped = false;
  private readonly activeHeartbeats = new Set<string>();

  constructor(dataDir: string, limits: ScheduleLimits, run: RunScheduledTask) {
    this.store = new ScheduleStore(dataDir);
    this.limits = limits;
    this.run = run;
  }

  /** Register everything already on disk. */
  start(): void {
    let count = 0;
    for (const channelId of this.store.channelsWithSchedules()) {
      for (const task of this.store.list(channelId)) {
        if (this.register(task)) {
          count++;
          const missed = missedCronRun(task);
          if (missed) {
            logger.info(
              `scheduler: task ${task.id} missed ${missed.toISOString()}, running once now`,
            );
            void this.fire(task);
          }
        }
      }
    }
    if (count > 0) logger.info(`scheduler: ${count} task(s) registered`);
  }

  private key(task: ScheduledTask): string {
    return `${task.channelId}:${task.id}`;
  }

  private register(task: ScheduledTask): boolean {
    this.unregister(task.channelId, task.id);

    if (task.heartbeat) {
      if (!task.enabled) return false;
      // Skip downtime, never replay a heartbeat backlog. Keep future due times across restarts.
      if (Date.parse(task.nextHeartbeatAt!) <= Date.now()) {
        task = { ...task, nextHeartbeatAt: heartbeatAfter(task.intervalMinutes!) };
        this.store.updateRunState(task.channelId, task.id, { nextHeartbeatAt: task.nextHeartbeatAt });
      }
    }

    // Check the pattern is valid and still has a future run before committing
    // a live timer to it.
    let probe: Cron;
    try {
      probe = buildCron(task);
    } catch (err) {
      logger.warn(`scheduler: ignoring invalid task ${task.id}`, err);
      return false;
    }
    const next = probe.nextRun();
    probe.stop();

    if (!next) {
      // Usually a one-shot whose time passed while the harness was down.
      if (task.runAt) {
        logger.info(`scheduler: dropping expired one-shot ${task.id}`);
        this.store.cancel(task.channelId, task.id);
      }
      return false;
    }

    const pattern = task.cron ?? new Date(task.heartbeat ? task.nextHeartbeatAt! : task.runAt!);
    const job = new Cron(
      pattern,
      // `catch` keeps a throwing task from taking down the process; failures
      // are recorded on the task itself in fire().
      { timezone: task.timezone, catch: true },
      () => this.fire(task),
    );

    this.jobs.set(this.key(task), job);
    return true;
  }

  private async fire(task: ScheduledTask): Promise<void> {
    if (this.stopped) return;
    const key = this.key(task);
    if (task.heartbeat) {
      const current = this.current(task);
      if (!current?.enabled) return;
      task = current; // Never execute an old closure's prompt.
      const nextHeartbeatAt = heartbeatAfter(task.intervalMinutes!);
      this.store.updateRunState(task.channelId, task.id, { nextHeartbeatAt });
      this.register({ ...task, nextHeartbeatAt });
      // A slow run skips ticks rather than queueing or overlapping.
      if (this.activeHeartbeats.has(key)) return;
      this.activeHeartbeats.add(key);
    }
    const startedAt = new Date().toISOString();
    logger.info(`scheduler: running ${task.id} in ${task.channelId}`);

    let outcome: ScheduledTaskRunResult | undefined;
    let error: string | undefined;
    try {
      outcome = await this.run(task);
      if (outcome.status === "failed") {
        error = outcome.error || "Scheduled agent run did not complete.";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const endedAt = new Date().toISOString();
    const run: ScheduleRun = {
      id: randomUUID(),
      channelId: task.channelId,
      taskId: task.id,
      startedAt,
      endedAt,
      status: error ? "failed" : "completed",
      ...(error ? { error } : {}),
      ...(outcome?.slackOutputUrl ? { slackOutputUrl: outcome.slackOutputUrl } : {}),
    };

    try {
      this.store.appendRun(run);
    } catch (err) {
      // Keep the task's current status honest even if its history disk is full
      // or otherwise unavailable; the next run can still repair lastError.
      logger.error(`scheduler: could not record outcome for ${task.id}`, err);
    }

    try {
      if (error) {
        logger.error(`scheduler: task ${task.id} failed: ${error}`);
        this.store.updateRunState(task.channelId, task.id, {
          lastRun: endedAt,
          lastError: error,
        });
      } else {
        this.store.updateRunState(task.channelId, task.id, {
          lastRun: endedAt,
          runCount: (this.current(task)?.runCount ?? 0) + 1,
          lastError: undefined,
        });
      }
    } finally {
      // Do not delete a replacement schedule edited while this run was in flight.
      this.activeHeartbeats.delete(key);
      const current = this.current(task);
      if (task.runAt && current?.runAt === task.runAt && !current.cron) {
        this.cancel(task.channelId, task.id);
      }
    }
  }

  private current(task: ScheduledTask): ScheduledTask | undefined {
    return this.store.list(task.channelId).find((t) => t.id === task.id);
  }

  private unregister(channelId: string, id: string): void {
    const job = this.jobs.get(`${channelId}:${id}`);
    if (job) {
      job.stop();
      this.jobs.delete(`${channelId}:${id}`);
    }
  }

  // --- ScheduleService, used by the agent tools -----------------------------

  create(input: CreateScheduleInput): ScheduledTask {
    const task = this.store.create(input, this.limits);
    this.register(task);
    return task;
  }

  list(channelId: string): ScheduledTask[] {
    return this.store.list(channelId);
  }

  update(channelId: string, id: string, patch: UpdateScheduleInput): ScheduledTask | undefined {
    const current = this.store.list(channelId).find((task) => task.id === id);
    if (!current) return undefined;
    const proposed = applyScheduleUpdate(current, patch, this.limits);
    if (proposed.heartbeat) {
      const task = this.store.update(channelId, id, patch, this.limits);
      if (task) this.register(task);
      return task;
    }
    // Prepare the replacement before touching disk or stopping the original job.
    const job = new Cron(
      proposed.cron ?? new Date(proposed.runAt!),
      { timezone: proposed.timezone, paused: true, catch: true },
      () => this.fire(proposed),
    );
    let task: ScheduledTask | undefined;
    try {
      task = this.store.update(channelId, id, patch, this.limits);
    } catch (err) {
      job.stop();
      throw err;
    }
    if (!task) {
      job.stop();
      return undefined;
    }
    this.unregister(channelId, id);
    this.jobs.set(this.key(task), job);
    job.resume();
    return task;
  }

  cancel(channelId: string, id: string): boolean {
    this.unregister(channelId, id);
    return this.store.cancel(channelId, id);
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
