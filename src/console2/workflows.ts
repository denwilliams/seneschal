import { scopedFactoryStore } from "../factory/workflow/backend.ts";
import { workflowAttemptActivity } from "../tasks/workflow-controls.ts";
import { taskWorkflowRunView } from "./task-workflows.ts";
import { pinnedWorkflow, stageIndex } from "../factory/workflow/definition.ts";
import { effectiveAutonomy } from "../factory/workflow/autonomy.ts";
import { resolveMergeRules } from "../factory/workflow/merge.ts";
import { workflowProblem } from "../factory/workflow/service.ts";
import type { FactoryRunData, StageRun } from "../factory/workflow/docs.ts";
import type { IntakeEntry, IntakeRepoData } from "../factory/workflow/intake-docs.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type {
  IntakeLabelsView, IntakeMappingView, IntakeRepoView, IntakeStatus, IntakeView, WorkflowAttemptView, WorkflowRunResponse, WorkflowRunSummary, WorkflowRunView, WorkflowStageSummary, WorkflowStageView,
  WorkflowAnswer, WorkflowChannelActions, WorkflowRecovery, WorkflowUpdateView, WorkflowsResponse,
} from "./api-types.ts";
import { guidanceFor } from "./stuck.ts";
import { isDirect, type Console2Source } from "./source.ts";

/** Whether the console may act: the operator turned it on and the process can carry the actions out. */
const actionsOn = (source: Console2Source): boolean => source.actions !== undefined && source.actionsEnabled === true;

/** Most runs one list returns. */
const LIST_LIMIT = 20;
const SUMMARY_CHARS = 300;
const REASON_CHARS = 400;
const FLOORS_MAX = 4;
/** A verdict is a short word from the hand-off contract; anything else is not passed on as one. */
const VERDICT = /^[a-z][a-z_]{0,39}$/;

const iso = (ms: number): string => new Date(ms).toISOString();
const bound = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The pinned definition's stage kinds and roles. A run whose definition cannot be read still shows its stages, without them. */
function stageShapes(run: FactoryRunData): Map<string, { kind: "agent" | "gate"; role?: string }> {
  const shapes = new Map<string, { kind: "agent" | "gate"; role?: string }>();
  try {
    const parsed = JSON.parse(run.definition) as { stages?: { name?: unknown; kind?: unknown; role?: unknown }[] };
    for (const stage of parsed.stages ?? []) {
      if (typeof stage.name !== "string") continue;
      shapes.set(stage.name, { kind: stage.kind === "gate" ? "gate" : "agent", ...(typeof stage.role === "string" ? { role: stage.role } : {}) });
    }
  } catch { /* an unreadable definition leaves the shapes empty */ }
  return shapes;
}

function stageSummary(stage: StageRun, shapes: ReturnType<typeof stageShapes>): WorkflowStageSummary {
  const shape = shapes.get(stage.name);
  return { name: stage.name, kind: shape?.kind ?? "agent", ...(shape?.role ? { role: shape.role } : {}), status: stage.status, entries: stage.entries };
}

function attemptView(attempt: StageRun["attempts"][number], direct: boolean): WorkflowAttemptView {
  return {
    entry: attempt.entry, role: attempt.role, status: attempt.status,
    ...(VERDICT.test(attempt.verdict) ? { verdict: attempt.verdict } : {}),
    ...(!direct && attempt.summary ? { summary: bound(attempt.summary, SUMMARY_CHARS) } : {}),
    ...(attempt.reask ? { reask: true } : {}),
    startedAt: iso(attempt.startedAt), ...(attempt.endedAt > 0 ? { endedAt: iso(attempt.endedAt) } : {}),
    durationMs: Math.max(0, attempt.durationMs), costUsd: attempt.costUsd, steps: attempt.steps,
    ...(attempt.runKey ? { runKey: attempt.runKey } : {}),
  };
}

/**
 * What can be done about a failed stage, from the run's own pinned workflow: only a stage the workflow marks optional can be
 * skipped, and only an earlier stage can be gone back to. A run that ended failed is carried on by retry alone.
 */
export function recoveryOf(run: FactoryRunData): WorkflowRecovery | undefined {
  const parked = run.status === "needs_decision" && run.wait.kind === "failed";
  if (!parked && run.status !== "failed") return undefined;
  if (run.trackerPending) return { stage: run.current, attempt: 0, ended: false, answers: ["retry", "abort"], restartFrom: [] };
  const definition = pinnedWorkflow(run);
  const stage = definition?.stages.find((candidate) => candidate.name === run.current);
  if (!definition || !stage) return undefined;
  const record = run.stages.find((candidate) => candidate.name === run.current);
  if (!record || record.status !== "failed") return undefined;
  const restartFrom = parked ? definition.stages.slice(0, stageIndex(definition, run.current)).map((candidate) => candidate.name) : [];
  const answers: WorkflowAnswer[] = parked
    ? ["retry", ...(stage.optional ? ["skip" as const] : []), ...(restartFrom.length > 0 ? ["restart_from" as const] : []), "abort"]
    : ["retry"];
  return { stage: run.current, attempt: record.attempts.length, ended: !parked, answers, restartFrom };
}

/**
 * A run for the list. Titles come from GitHub and can say anything, so a direct message channel gets none; the rest is
 * structure the operator's own workflow defines.
 */
export function workflowRunSummary(run: FactoryRunData, direct: boolean): WorkflowRunSummary {
  const shapes = stageShapes(run);
  const review = run.stages.find((stage) => stage.name === "review");
  return {
    runId: run.runId, repo: run.repo, issue: run.issue,
    ...(!direct && run.issueTitle ? { issueTitle: bound(run.issueTitle, 200) } : {}),
    ...(run.issueUrl ? { issueUrl: run.issueUrl } : {}),
    ...(run.workItem ? { workItem: { tracker: "jira" as const, site: run.workItem.site, key: run.workItem.key, url: run.workItem.url } } : {}),
    status: run.status, current: run.current,
    ...((run.status === "waiting" || run.status === "needs_decision") && run.wait.kind ? { waiting: { kind: run.wait.kind, since: iso(run.wait.since) } } : {}),
    ...(recoveryOf(run) ? { recovery: recoveryOf(run)! } : {}),
    round: review?.entries ?? 0,
    risk: { scored: run.risk.scored, ...(run.risk.scored ? { model: run.risk.model } : {}), ...(run.risk.final >= 0 ? { final: run.risk.final } : {}) },
    stages: run.stages.map((stage) => stageSummary(stage, shapes)),
    ...(run.pr.number > 0 ? { pr: { number: run.pr.number, ...(run.pr.url ? { url: run.pr.url } : {}), merged: run.pr.mergeCommit !== "" } } : {}),
    by: { source: run.by.source, ...(run.by.threadKey ? { threadKey: run.by.threadKey } : {}) },
    origin: run.origin ?? "manual",
    updates: { trusted: (run.updates ?? []).filter((u) => u.trusted).length, untrusted: (run.updates ?? []).filter((u) => !u.trusted).length },
    startedAt: iso(run.startedAt), ...(run.endedAt > 0 ? { endedAt: iso(run.endedAt) } : {}),
    costUsd: run.costUsd,
  };
}

/**
 * One run with every attempt. The merge rule is configuration, so it shows; who may approve is a count and where it comes from,
 * never user ids (allowed-user ids are not sent by any console route).
 */
export function workflowRunView(
  run: FactoryRunData, direct: boolean, channel: Pick<ResolvedChannel, "factory" | "allowUsers"> | undefined, options: { actions?: boolean; mergeVerification?: import("./api-types.ts").WorkflowGuidance["mergeVerification"] } = {},
): WorkflowRunView {
  const summary = workflowRunSummary(run, direct);
  const shapes = stageShapes(run);
  const stages: WorkflowStageView[] = run.stages.map((stage) => ({ ...stageSummary(stage, shapes), attempts: stage.attempts.map((attempt) => attemptView(attempt, direct)) }));
  const rules = channel?.factory ? resolveMergeRules(channel.factory, run.repo) : undefined;
  const approverCount = rules ? (rules.approvers ?? channel?.allowUsers)?.length : undefined;
  const guidance = guidanceFor(run, recoveryOf(run), { actions: options.actions === true, intake: channel?.factory?.intake?.enabled === true, mergeVerification: options.mergeVerification });
  return {
    ...summary,
    ...(guidance ? { guidance } : {}),
    ...(!direct && run.reason ? { reason: bound(run.reason, REASON_CHARS) } : {}),
    updatesReceived: (run.updates ?? []).slice(-20).map((update): WorkflowUpdateView => ({
      kind: update.kind, trusted: update.trusted, at: iso(update.at),
      ...(update.viaToken ? { viaToken: true } : {}),
      ...(!direct && update.author ? { author: bound(update.author, 60) } : {}),
      ...(!direct && update.association ? { association: bound(update.association, 30) } : {}),
      ...(!direct && update.excerpt ? { excerpt: bound(update.excerpt, 1000) } : {}),
    })),
    stages,
    risk: {
      ...summary.risk,
      ...(!direct && run.risk.reason ? { reason: bound(run.risk.reason, SUMMARY_CHARS) } : {}),
      ...(!direct && run.risk.floors.length > 0 ? { floors: run.risk.floors.slice(0, FLOORS_MAX).map((floor) => bound(floor, SUMMARY_CHARS)) } : {}),
    },
    ...(channel?.factory ? { autonomy: effectiveAutonomy(channel.factory, run.repo) } : {}),
    ...(rules ? {
      mergeRule: {
        autoMergeMaxRisk: rules.autoMergeMaxRisk, method: rules.method,
        approvers: { source: rules.approvers ? "factory" : "channel", ...(approverCount !== undefined ? { count: approverCount } : {}) },
      },
    } : {}),
  };
}

const needsAttention = (run: FactoryRunData): boolean => run.status === "waiting" || run.status === "needs_decision";

/** Runs a person has to act on first, then newest first. */
export function orderRuns(runs: FactoryRunData[]): FactoryRunData[] {
  return [...runs].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.startedAt - a.startedAt);
}

const MAPPINGS_MAX = 40;
const STATUS_ORDER: Record<IntakeStatus, number> = { held: 0, queued: 1, open: 2, ignored: 3, closed: 4 };

function mappingView(entry: IntakeEntry, direct: boolean): IntakeMappingView {
  return {
    issue: entry.number, status: entry.status,
    ...(entry.workItem ? { workItem: { ...entry.workItem } } : {}),
    ...(!direct && entry.title ? { title: bound(entry.title, 200) } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(!direct && entry.author ? { author: bound(entry.author, 60) } : {}),
    ...(entry.status === "open" && entry.runId ? { runId: entry.runId } : {}),
    ...(!direct && entry.reason ? { reason: bound(entry.reason, 200) } : {}),
    ...(entry.trust ? { trust: entry.trust } : {}),
    ...(entry.lastUpdatedAt > 0 ? { lastUpdated: iso(entry.lastUpdatedAt) } : {}),
  };
}

function labelsView(labels: NonNullable<IntakeRepoData["labels"]>, direct: boolean): IntakeLabelsView {
  const created = labels.created.slice(0, 20).map((name) => bound(name, 60));
  return {
    status: labels.error ? "failed" : created.length > 0 ? "created" : "ok", checkedAt: iso(labels.checkedAt), created,
    ...(!direct && labels.error ? { error: bound(labels.error, 300) } : {}),
  };
}

function repoView(data: IntakeRepoData, direct: boolean): IntakeRepoView {
  const entries = Object.values(data.entries);
  const counts: IntakeRepoView["counts"] = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const ordered = entries.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastUpdatedAt - a.lastUpdatedAt).slice(0, MAPPINGS_MAX);
  return {
    repo: data.repo, counts, mappings: ordered.map((entry) => mappingView(entry, direct)),
    ...(data.labels && data.labels.checkedAt > 0 ? { labels: labelsView(data.labels, direct) } : {}),
    ...(data.lastPollAt > 0 ? { lastPollAt: iso(data.lastPollAt) } : {}),
    ...(data.lastOkAt > 0 ? { lastOkAt: iso(data.lastOkAt) } : {}),
    ...(!direct && data.lastError ? { lastError: bound(data.lastError, 300) } : {}),
  };
}

/** Issue intake as the console shows it: what is mapped to which run, and what is held or waiting. Absent when the channel has none. */
async function buildIntake(source: Console2Source, channel: ChannelRecord, direct: boolean): Promise<IntakeView | undefined> {
  const settings = source.resolve(channel)?.factory?.intake;
  const runtime = source.runtime(channel.id);
  let repos: IntakeRepoView[] = [];
  if (runtime) {
    try { repos = ((await scopedFactoryStore(runtime.store, source.resolve(channel)?.factory).listFactoryIntake()) ?? []).map((data) => repoView(data, direct)).sort((a, b) => a.repo.localeCompare(b.repo)); } catch { /* an unreadable mapping is an empty one */ }
  }
  if (!settings?.enabled && repos.length === 0) return undefined;
  return { enabled: settings?.enabled === true, ...(settings?.source ? { source: settings.source } : {}), ...(settings?.enabled ? { intervalSeconds: settings.intervalSeconds } : {}), repos };
}

/** The channel's workflow runs, from its open store. A store that is not open, or cannot be read, lists none. */
export async function buildWorkflows(source: Console2Source, channel: ChannelRecord): Promise<WorkflowsResponse> {
  const direct = isDirect(channel);
  let runs: WorkflowRunSummary[] = [];
  const runtime = source.runtime(channel.id);
  if (runtime) {
    try {
      runs = orderRuns(await runtime.store.listFactoryRuns(LIST_LIMIT)).map((run) => workflowRunSummary(run, direct));
    } catch { /* an unreadable run list is an empty one */ }
  }
  if (runtime) {
    try {
      const tasks = (await runtime.store.listTaskWorkflows()).filter((run) => run.channelId === channel.id);
      runs.push(...tasks.map((run) => {
        const { updatesReceived: _updates, taskControl: _control, taskActivity: _activity, ...summary } = taskWorkflowRunView(run, direct);
        return { ...summary, stages: summary.stages.map(({ result: _result, attempts: _attempts, ...stage }) => stage) };
      }));
      runs.sort((a, b) => Number(b.status === "waiting" || b.status === "needs_decision") - Number(a.status === "waiting" || a.status === "needs_decision") || Date.parse(b.startedAt) - Date.parse(a.startedAt));
      runs = runs.slice(0, LIST_LIMIT);
    } catch { /* task visibility must not hide software-factory runs */ }
  }
  const intake = await buildIntake(source, channel, direct);
  const resolved = source.resolve(channel);
  const actions: WorkflowChannelActions | undefined = actionsOn(source) && resolved?.factory && !workflowProblem(resolved)
    ? { start: true, ...(resolved.factory.intake?.source === "jira" ? { source: "jira" as const } : {}), poll: resolved.factory.intake?.enabled === true, repositories: [...resolved.factory.repositories] }
    : undefined;
  return { channelId: channel.id, runs, ...(actions ? { actions } : {}), ...(intake ? { intake } : {}) };
}

/** One run, or undefined when the channel has no such run (or its store is not open). */
export async function buildWorkflowRun(source: Console2Source, channel: ChannelRecord, runId: string, browser = ""): Promise<WorkflowRunResponse | undefined> {
  const runtime = source.runtime(channel.id);
  if (!runtime) return undefined;
  if (runId.startsWith("workflow_")) {
    try {
      const task = await runtime.store.taskWorkflow(runId);
      if (!task || task.channelId !== channel.id) return undefined;
      const step = task.steps[task.index];
      let lastAt: number | undefined;
      let blocked: string | undefined;
      try {
        const pauses = await runtime.store.blocked();
        if (pauses.length) blocked = pauses.map((pause) => pause.reason).join("; ");
        const transcript = await runtime.store.consoleTranscript(step?.agent ? step.runKey : task.parentThreadKey);
        for (const messages of transcript?.view.contributions ?? []) for (const message of messages) {
          const at = (message as { timestamp?: number }).timestamp;
          if (typeof at === "number" && Number.isFinite(at)) lastAt = Math.max(lastAt ?? 0, at);
        }
      } catch { /* Diagnostic failure is unknown, never evidence of execution. */ }
      return { channelId: channel.id, run: taskWorkflowRunView(task, isDirect(channel), {
        actions: actionsOn(source), bump: !!source.actions?.inspectTaskWorkflow,
        executingAt: step ? workflowAttemptActivity(runtime.store, step.runKey) : undefined, lastAt, blocked,
      }) };
    } catch { return undefined; }
  }
  let run: FactoryRunData | undefined;
  try {
    run = await runtime.store.factoryRun(runId);
  } catch {
    return undefined;
  }
  if (!run) return undefined;
  const verification = actionsOn(source) ? await source.actions?.mergeApprovals?.status(browser, channel.id, runId) : undefined;
  return { channelId: channel.id, run: workflowRunView(run, isDirect(channel), source.resolve(channel), { actions: actionsOn(source), mergeVerification: verification?.view }) };
}
