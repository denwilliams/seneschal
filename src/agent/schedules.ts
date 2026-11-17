import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Cron } from "croner";
import { channelPaths } from "../workspace/paths.ts";

/**
 * Scheduled work, stored per channel.
 *
 * A schedule belongs to the channel it was created in and runs with that
 * channel's model, tools, memory and connectors. There is deliberately no way
 * to schedule work into another channel: that would be a hole straight through
 * the isolation boundary, letting a task created in one channel act with
 * another's credentials and post to it.
 */

export interface ScheduledThread {
  /** Session key for the Slack thread to resume. */
  threadKey: string;
  /** Slack thread timestamp to reply under. */
  threadTs: string;
}

export interface ScheduledTask {
  id: string;
  channelId: string;
  /** What the agent should do when this fires, in plain language. */
  prompt: string;
  /** First-class channel heartbeat; always quiet, interval-based and opt-in. */
  heartbeat?: boolean;
  intervalMinutes?: number;
  nextHeartbeatAt?: string;
  enabled?: boolean;
  /** 5-field cron expression for recurring work. */
  cron?: string;
  /** ISO timestamp for one-shot work. Removed after it fires. */
  runAt?: string;
  timezone: string;
  /** If set, resume this Slack thread instead of starting a new channel post. */
  thread?: ScheduledThread;
  /** Slack user who asked for it, for attribution when it fires. */
  createdBy: string;
  /** If true, suppress the automatic scheduled message and normal reply. */
  quiet?: boolean;
  /** If true, run one catch-up execution at startup when the latest cron time was missed. */
  runIfMissed?: boolean;
  createdAt: string;
  lastRun?: string;
  lastError?: string;
  runCount: number;
}

export type ScheduleRunStatus = "completed" | "failed";

/** One immutable outcome for a scheduled task execution. */
export interface ScheduleRun {
  id: string;
  channelId: string;
  taskId: string;
  startedAt: string;
  endedAt: string;
  status: ScheduleRunStatus;
  /** Why a run failed. Absent for a completed run. */
  error?: string;
  /** Permalink to the scheduled Slack thread, when the task has visible output. */
  slackOutputUrl?: string;
}

export interface ScheduleLimits {
  maxPerChannel: number;
  /** Reject schedules that would fire more often than this. */
  minIntervalMinutes: number;
  defaultTimezone: string;
}

interface ScheduleFile {
  tasks: ScheduledTask[];
}

export interface CreateScheduleInput {
  channelId: string;
  prompt: string;
  cron?: string;
  runAt?: string;
  timezone?: string;
  createdBy: string;
  heartbeat?: boolean;
  intervalMinutes?: number;
  enabled?: boolean;
  quiet?: boolean;
  thread?: ScheduledThread;
  runIfMissed?: boolean;
}

export interface UpdateScheduleInput {
  prompt?: string;
  /** Compare-and-set protects unrelated watches edited by another conversation. */
  expectedPrompt?: string;
  intervalMinutes?: number;
  enabled?: boolean;
  cron?: string;
  runAt?: string;
  timezone?: string;
  quiet?: boolean;
  runIfMissed?: boolean;
}

/** Merge only editable fields. A supplied timing field replaces the old mode. */
export function applyScheduleUpdate(
  task: ScheduledTask,
  patch: UpdateScheduleInput,
  limits: ScheduleLimits,
): ScheduledTask {
  if (patch.cron !== undefined && patch.runAt !== undefined) {
    throw new ScheduleError("Provide only one of `cron` or `runAt`, not both.");
  }
  if (patch.prompt !== undefined && task.heartbeat && patch.expectedPrompt !== task.prompt) {
    throw new ScheduleError("Heartbeat changed; read it again and preserve the other watches before editing.");
  }
  const next = { ...task };
  if (patch.intervalMinutes !== undefined) next.intervalMinutes = patch.intervalMinutes;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (task.heartbeat && (patch.intervalMinutes !== undefined || (patch.enabled === true && !task.enabled))) {
    next.nextHeartbeatAt = heartbeatAfter(next.intervalMinutes!);
  }
  if (patch.prompt !== undefined) next.prompt = patch.prompt.trim();
  if (patch.timezone !== undefined) next.timezone = patch.timezone;
  if (patch.quiet !== undefined) next.quiet = patch.quiet;
  if (patch.runIfMissed !== undefined) next.runIfMissed = patch.runIfMissed;
  if (patch.cron !== undefined) {
    next.cron = patch.cron.trim();
    delete next.runAt;
  }
  if (patch.runAt !== undefined) {
    next.runAt = normalizeRunAt(patch.runAt);
    delete next.cron;
  }
  validate(next, limits);
  return next;
}

/** Thrown for user-correctable problems; the message is shown to the agent. */
export class ScheduleError extends Error {}

export function describeSchedule(task: ScheduledTask): string {
  const when = task.heartbeat
    ? `heartbeat every ${task.intervalMinutes} minutes (${task.enabled ? "enabled" : "paused"})`
    : task.cron
    ? `\`${task.cron}\` (${task.timezone})`
    : `once at ${task.runAt} (${task.timezone})`;
  const next = nextRunOf(task);
  const mode = task.quiet ? "quiet" : "visible";
  const where = task.thread ? `, in thread ${task.thread.threadTs}` : "";
  const catchUp = task.runIfMissed ? ", catches up missed cron runs" : "";
  return `\`${task.id}\` — ${when}, ${mode}${where}${catchUp}${next ? `, next ${next.toISOString()}` : ", not scheduled"}\n   ${task.prompt}`;
}

export function nextRunOf(task: ScheduledTask): Date | null {
  if (task.heartbeat) {
    const next = new Date(task.nextHeartbeatAt!);
    return task.enabled && Number.isFinite(next.getTime()) ? next : null;
  }
  try {
    const cron = buildCron(task);
    const next = cron.nextRun();
    cron.stop();
    return next;
  } catch {
    return null;
  }
}

/** Build a paused Cron for a task. Callers must stop() it or attach a handler. */
export function buildCron(task: ScheduledTask): Cron {
  const options = { timezone: task.timezone, paused: true };
  if (task.heartbeat) return new Cron(new Date(task.nextHeartbeatAt!), options);
  if (task.cron) return new Cron(task.cron, options);
  if (task.runAt) return new Cron(new Date(task.runAt), options);
  throw new ScheduleError("A schedule needs either a cron expression or a run-at time.");
}

export function missedCronRun(task: ScheduledTask, now = new Date()): Date | null {
  if (!task.cron || !task.runIfMissed) return null;
  const lastObserved = new Date(task.lastRun ?? task.createdAt);
  if (Number.isNaN(lastObserved.getTime())) return null;

  const cron = buildCron(task);
  try {
    const [previous] = cron.previousRuns(1, now);
    if (!previous) return null;
    return previous.getTime() > lastObserved.getTime() ? previous : null;
  } finally {
    cron.stop();
  }
}

export class ScheduleStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private fileFor(channelId: string): string {
    return join(channelPaths(this.dataDir, channelId).root, "schedules.json");
  }

  private runLogFor(channelId: string): string {
    return join(channelPaths(this.dataDir, channelId).root, "schedule-runs.jsonl");
  }

  list(channelId: string): ScheduledTask[] {
    const file = this.fileFor(channelId);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as ScheduleFile;
      return Array.isArray(parsed.tasks) ? parsed.tasks : [];
    } catch {
      return [];
    }
  }

  private write(channelId: string, tasks: ScheduledTask[]): void {
    const file = this.fileFor(channelId);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tasks } satisfies ScheduleFile, null, 2));
    renameSync(tmp, file);
  }

  create(input: CreateScheduleInput, limits: ScheduleLimits): ScheduledTask {
    if (!input.prompt.trim()) {
      throw new ScheduleError("A schedule needs a prompt describing what to do.");
    }
    if (!input.heartbeat && Boolean(input.cron) === Boolean(input.runAt)) {
      throw new ScheduleError(
        "Provide exactly one of `cron` (recurring) or `runAt` (one-shot ISO timestamp).",
      );
    }
    if (input.runIfMissed && !input.cron) {
      throw new ScheduleError("`runIfMissed` is only for recurring cron schedules.");
    }

    const existing = this.list(input.channelId);
    if (input.heartbeat && existing.some((t) => t.heartbeat)) {
      throw new ScheduleError("This channel already has a heartbeat; update it instead.");
    }
    if (existing.length >= limits.maxPerChannel) {
      throw new ScheduleError(
        `This channel already has ${existing.length} schedules (limit ${limits.maxPerChannel}). Cancel one first.`,
      );
    }

    const task: ScheduledTask = {
      id: randomUUID().slice(0, 8),
      channelId: input.channelId,
      prompt: input.prompt.trim(),
      ...(input.heartbeat ? { heartbeat: true, intervalMinutes: input.intervalMinutes,
        nextHeartbeatAt: heartbeatAfter(input.intervalMinutes!), enabled: input.enabled ?? true, quiet: true } : {}),
      ...(input.cron ? { cron: input.cron.trim() } : {}),
      ...(input.runAt ? { runAt: normalizeRunAt(input.runAt) } : {}),
      timezone: input.timezone ?? limits.defaultTimezone,
      ...(input.thread ? { thread: normalizeThread(input.thread) } : {}),
      createdBy: input.createdBy,
      ...(input.quiet ? { quiet: true } : {}),
      ...(input.runIfMissed ? { runIfMissed: true } : {}),
      createdAt: new Date().toISOString(),
      runCount: 0,
    };

    validate(task, limits);
    this.write(input.channelId, [...existing, task]);
    return task;
  }

  cancel(channelId: string, id: string): boolean {
    const tasks = this.list(channelId);
    const remaining = tasks.filter((t) => t.id !== id);
    if (remaining.length === tasks.length) return false;
    this.write(channelId, remaining);
    return true;
  }

  update(
    channelId: string,
    id: string,
    patch: UpdateScheduleInput,
    limits: ScheduleLimits,
  ): ScheduledTask | undefined {
    const tasks = this.list(channelId);
    const index = tasks.findIndex((t) => t.id === id);
    if (index === -1) return undefined;
    const next = applyScheduleUpdate(tasks[index]!, patch, limits);
    tasks[index] = next;
    this.write(channelId, tasks);
    return next;
  }

  /** Internal execution bookkeeping must also work for a just-fired one-shot. */
  updateRunState(
    channelId: string,
    id: string,
    patch: Partial<Pick<ScheduledTask, "lastRun" | "lastError" | "runCount" | "nextHeartbeatAt">>,
  ): void {
    const tasks = this.list(channelId);
    const index = tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    tasks[index] = { ...tasks[index]!, ...patch };
    this.write(channelId, tasks);
  }

  /** Append one completed or failed scheduled execution for operational history. */
  appendRun(run: ScheduleRun): void {
    const file = this.runLogFor(run.channelId);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(run)}\n`);
  }

  /** Recent run history, oldest first. A truncated/corrupt line does not hide earlier runs. */
  listRuns(channelId: string, limit = 20): ScheduleRun[] {
    const file = this.runLogFor(channelId);
    if (!existsSync(file)) return [];
    try {
      const runs: ScheduleRun[] = [];
      for (const line of readFileSync(file, "utf-8").trimEnd().split("\n")) {
        if (!line) continue;
        try {
          const run = JSON.parse(line) as ScheduleRun;
          if (
            run &&
            run.channelId === channelId &&
            typeof run.id === "string" &&
            typeof run.taskId === "string" &&
            typeof run.startedAt === "string" &&
            typeof run.endedAt === "string" &&
            (run.status === "completed" || run.status === "failed")
          ) {
            runs.push(run);
          }
        } catch {
          // The process may have stopped while appending the final line.
        }
      }
      return runs.slice(-Math.max(0, limit));
    } catch {
      return [];
    }
  }

  /** Every channel that has schedules, for startup registration. */
  channelsWithSchedules(): string[] {
    const root = join(this.dataDir, "channels");
    if (!existsSync(root)) return [];
    try {
      return readdirSync(root).filter((id) => existsSync(this.fileFor(id)));
    } catch {
      return [];
    }
  }
}

export function heartbeatAfter(intervalMinutes: number, now = Date.now()): string {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0 || intervalMinutes > 525_600) {
    throw new ScheduleError("Heartbeat interval must be positive and at most 525600 minutes.");
  }
  // Cron timers have one-second precision. Persist the exact time the timer will use.
  return new Date(Math.ceil((now + intervalMinutes * 60_000) / 1000) * 1000).toISOString();
}

function normalizeThread(thread: ScheduledThread): ScheduledThread {
  const threadKey = thread.threadKey.trim();
  const threadTs = thread.threadTs.trim();
  if (!threadKey || !threadTs) {
    throw new ScheduleError("A threaded schedule needs a Slack thread to resume.");
  }
  return { threadKey, threadTs };
}

function normalizeRunAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ScheduleError('Invalid `runAt` timestamp. Use an ISO 8601 time.');
  }
  return date.toISOString();
}

function validate(task: ScheduledTask, limits: ScheduleLimits): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: task.timezone }).format();
  } catch {
    throw new ScheduleError('Invalid timezone. Use an IANA timezone such as Australia/Sydney.');
  }
  if (!task.prompt.trim()) {
    throw new ScheduleError("A schedule needs a prompt describing what to do.");
  }
  if (task.heartbeat) {
    heartbeatAfter(task.intervalMinutes!);
    if (task.intervalMinutes! < limits.minIntervalMinutes) {
      throw new ScheduleError(`The minimum heartbeat interval is ${limits.minIntervalMinutes} minutes.`);
    }
    if (!task.quiet || task.cron || task.runAt || task.thread || task.runIfMissed) {
      throw new ScheduleError("Heartbeats must be quiet interval tasks, without cron, runAt, thread or catch-up.");
    }
    return;
  }
  if (task.intervalMinutes !== undefined || task.enabled !== undefined) {
    throw new ScheduleError("Interval and enabled settings are only for heartbeats.");
  }
  if (Boolean(task.cron) === Boolean(task.runAt)) {
    throw new ScheduleError("Provide exactly one of `cron` (recurring) or `runAt` (one-shot ISO timestamp).");
  }
  if (task.runIfMissed && !task.cron) {
    throw new ScheduleError("`runIfMissed` is only for recurring cron schedules; set `run_if_missed: false` when switching to one-shot.");
  }
  if (task.thread && task.cron) {
    throw new ScheduleError("Thread-targeted tasks are one-shot check-backs and cannot use `cron`.");
  }
  if (task.thread && task.quiet) {
    throw new ScheduleError("Use either thread targeting or `quiet`, not both.");
  }
  let cron: Cron;
  try {
    cron = buildCron(task);
  } catch (err) {
    throw new ScheduleError(
      task.cron
        ? `"${task.cron}" is not a valid cron expression. Use 5 fields: minute hour day-of-month month day-of-week.`
        : `"${task.runAt}" is not a valid timestamp. Use an ISO 8601 time.`,
    );
  }

  try {
    const runs = cron.nextRuns(2);
    if (runs.length === 0 || !runs[0]) {
      throw new ScheduleError(
        task.runAt
          ? "That time is in the past — schedule something in the future."
          : "That schedule would never fire.",
      );
    }

    // Guard against a runaway schedule hammering the model on someone's own
    // budget, e.g. an agent reaching for "* * * * *".
    if (runs.length > 1 && runs[1]) {
      const gapMinutes = (runs[1].getTime() - runs[0].getTime()) / 60_000;
      if (gapMinutes < limits.minIntervalMinutes) {
        throw new ScheduleError(
          `That would run every ${Math.round(gapMinutes)} minute(s); the minimum interval is ${limits.minIntervalMinutes}.`,
        );
      }
    }
  } finally {
    cron.stop();
  }
}
