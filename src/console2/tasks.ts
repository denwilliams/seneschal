import { nextRunOf } from "../agent/schedules.ts";
import type { TimelineEvent } from "../agent/timeline.ts";
import { channelOverview } from "./data.ts";
import type { TaskRecord } from "../tasks/store.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { JobRunData } from "../jobs/docs.ts";
import type { ActivityView, ApprovalView, JobRunView, ScheduleRunView, ScheduleView, TaskView, TasksResponse } from "./api-types.ts";
import { iso, isDirect, type Console2Source } from "./source.ts";
import { recentTimeline } from "./timeline-cache.ts";

const ACTIVITY_KINDS = new Set(["turn.start", "turn.end", "tool", "run.start", "run.end"]);
const APPROVAL_KINDS = new Set(["approval.requested", "approval.decided", "post"]);

function taskView(task: TaskRecord, direct: boolean): TaskView {
  return {
    id: task.id, summary: direct ? `${task.kind} task` : task.summary, kind: task.kind, status: task.status,
    ...(task.threadKey ? { threadKey: task.threadKey } : {}), startedAt: task.startedAt, updatedAt: task.updatedAt,
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(!direct && task.detail ? { detail: task.detail } : {}),
    // Link labels and URLs are derived from what was asked, so a direct message keeps none of them.
    ...(!direct && task.links?.length ? { links: task.links.map((link) => ({ url: link.url, ...(link.label ? { label: link.label } : {}) })) } : {}),
  };
}

export function approvalView(event: TimelineEvent, direct = false): ApprovalView {
  const requested = event.kind === "approval.requested";
  return {
    id: event.id, at: event.at, kind: event.kind === "post" ? "post" : "approval",
    status: requested ? "requested" : (event.status as ApprovalView["status"] | undefined) ?? "requested",
    // A post's title can name its destination and subject; in a direct message only the kind of event is shown.
    title: direct && event.kind === "post" ? "Post" : event.title, actor: event.actor, ...(event.threadKey ? { threadKey: event.threadKey } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  };
}

function activityView(event: TimelineEvent): ActivityView {
  return {
    id: event.id, at: event.at, kind: event.kind as ActivityView["kind"], actor: event.actor, title: event.title,
    ...(event.status ? { status: event.status } : {}), ...(event.threadKey ? { threadKey: event.threadKey } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}), ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
    ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
  };
}

/**
 * A job run for the console. Phase names and statuses are the operator's own configuration and structure; what a command printed,
 * why a run stopped (which can quote a state key or a command's output) and the inputs it was given can all carry a
 * conversation's content, so a direct message channel gets none of them.
 */
export function jobRunView(run: JobRunData, direct: boolean): JobRunView {
  const at = (ms: number) => new Date(ms).toISOString();
  return {
    runId: run.runId, job: run.job, status: run.status,
    ...(!direct && run.reason ? { reason: run.reason } : {}),
    ...(run.index < run.phases.length ? { currentPhase: run.phases[run.index]!.name } : {}),
    phases: run.phases.map((phase) => ({
      name: phase.name, kind: phase.kind, status: phase.status,
      ...(phase.exit >= 0 ? { exit: phase.exit } : {}), ...(!direct && phase.summary ? { summary: phase.summary } : {}),
    })),
    startedAt: at(run.startedAt), ...(run.endedAt > 0 ? { endedAt: at(run.endedAt) } : {}),
    by: { source: run.by.source, ...(run.by.threadKey ? { threadKey: run.by.threadKey } : {}) },
    ...(!direct ? { input: run.input } : {}),
  };
}

/**
 * The Tasks tab: the durable task history, schedules and their run ledger, approvals and held posts, recovery-blocked
 * conversations, and the live activity feed. For a direct message channel the free text (task summaries and schedule
 * prompts) is dropped; the shape stays.
 */
export async function buildTasks(source: Console2Source, channel: ChannelRecord): Promise<TasksResponse> {
  const direct = isDirect(channel);
  const overview = channelOverview(source, channel, 25);
  const schedules: ScheduleView[] = source.schedules.list(channel.id).map((task) => ({
    id: task.id, prompt: direct ? "" : task.prompt, ...(task.cron ? { cron: task.cron } : {}), ...(task.runAt ? { runAt: task.runAt } : {}),
    ...(task.heartbeat ? { heartbeat: { intervalMinutes: task.intervalMinutes!, enabled: task.enabled === true } } : {}),
    timezone: task.timezone, quiet: task.quiet === true, reminder: (task as { reminder?: unknown }).reminder !== undefined,
    ...(nextRunOf(task) ? { nextRun: nextRunOf(task)!.toISOString() } : {}),
    ...(task.lastRun ? { lastRun: task.lastRun } : {}), ...(task.lastError ? { lastError: direct ? "failed" : task.lastError } : {}), runCount: task.runCount,
  }));
  const scheduleRuns: ScheduleRunView[] = source.schedules.listRuns(channel.id, 20).reverse().map((run) => ({
    id: run.id, taskId: run.taskId, startedAt: run.startedAt, endedAt: run.endedAt, status: run.status,
    ...(run.error ? { error: direct ? "failed" : run.error } : {}), ...(run.slackOutputUrl ? { slackOutputUrl: run.slackOutputUrl } : {}),
  }));
  const events = recentTimeline(source.dataDir, channel.id, channel.isDm);
  const approvals = events.filter((event) => APPROVAL_KINDS.has(event.kind)).slice(-30).reverse().map((event) => approvalView(event, direct));
  const activity = events.filter((event) => ACTIVITY_KINDS.has(event.kind)).slice(-60).reverse().map(activityView);
  let blocked: TasksResponse["blocked"] = [];
  const runtime = source.runtime(channel.id);
  if (runtime) {
    try {
      blocked = (await runtime.store.blocked()).map((entry) => ({ threadKey: entry.threadKey, reason: direct ? "blocked" : entry.reason, ...(iso(entry.since) ? { since: iso(entry.since)! } : {}) }));
    } catch { /* a failing store reports nothing rather than failing the tab */ }
  }
  let jobs: JobRunView[] = [];
  if (runtime) {
    try {
      jobs = (await runtime.store.listJobRuns(10)).map((run) => jobRunView(run, direct));
    } catch { /* an unreadable run list leaves the rest of the tab intact */ }
  }
  return {
    channelId: channel.id, jobs, active: overview.active.map((task) => taskView(task, direct)), recent: overview.recent.map((task) => taskView(task, direct)),
    schedules, scheduleRuns, approvals, blocked, activity,
  };
}
