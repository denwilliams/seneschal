import { AlertTriangle, Ban, CheckCircle2, Circle, ExternalLink, GitPullRequest, Loader2, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { IntakeRepoView, IntakeView, WorkflowRunStatus, WorkflowRunSummary, WorkflowRunView, WorkflowStageStatus, WorkflowStageView } from "@api/api-types";
import { Async } from "@/components/common";
import { GuidancePanel, TaskWorkflowActions } from "@/components/RunActions";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { safeGithubUrl } from "@/lib/factory";
import { formatCost, formatDuration, relativeTime, threadLabel } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { isLongSummary, shortSummary, TONE_BADGE, TONE_NOTICE, type Tone } from "@/lib/jobs";
import {
  ATTEMPT_STATUS_LABEL, attemptTitle, describeMergeRule, effectiveRisk, elapsedMs, INTAKE_STATUS_HINT, INTAKE_STATUS_LABEL, intakeCountsLine, issueRef, labelsText, ORIGIN_LABEL, pipLabel, safeWorkItemUrl,
  recoveryChoices, recoveryHeadline, riskLabel, riskTone, runStatusLabel, runTone, STAGE_STATUS_LABEL, STAGE_TONE_CLASS, subagentHref, UPDATE_KIND_LABEL, updatesLabel, updateTrustLabel, verdictLabel, waitingLine,
} from "@/lib/workflows";
import { cn } from "@/lib/utils";

const TASK_STAGE_LABEL = { ready: "Not started / ready", working: "Working attempt recorded — see activity", submitted: "Submitted — awaiting parent review", return_requested: "Return requested — awaiting parent review", approved: "Approved" };

const RUN_ICON: Record<WorkflowRunStatus, LucideIcon> = {
  running: Loader2, waiting: AlertTriangle, needs_decision: AlertTriangle, completed: CheckCircle2, rejected: Ban, failed: XCircle, aborted: Ban,
};
/** Each status has its own shape, so a stage reads without its colour. */
const STAGE_ICON: Record<WorkflowStageStatus, LucideIcon> = { not_started: Circle, in_progress: Loader2, success: CheckCircle2, failed: XCircle, skipped: MinusCircle };

function StatusBadge({ run }: { run: Pick<WorkflowRunSummary, "status" | "waiting" | "kind"> }) {
  const { status } = run;
  const Icon = RUN_ICON[status];
  return (
    <span data-testid="workflow-status" data-status={status} className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold", TONE_BADGE[runTone(status)])}>
      <Icon className={cn("size-3", status === "running" && run.kind !== "task" && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {runStatusLabel(run)}
    </span>
  );
}

function RiskBadge({ risk }: { risk: WorkflowRunSummary["risk"] }) {
  if (!risk.scored) return null;
  return (
    <span data-testid="workflow-risk" className={cn("inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-semibold", TONE_BADGE[riskTone(effectiveRisk(risk))])}>
      {riskLabel(risk)}
    </span>
  );
}

function Pip({ stage }: { stage: { name: string; status: WorkflowStageStatus; taskStatus?: string } }) {
  const Icon = STAGE_ICON[stage.status];
  return (
    <li data-testid="workflow-pip" data-stage={stage.name} data-status={stage.status} aria-label={pipLabel(stage)} title={pipLabel(stage)} className="flex">
      <Icon className={cn("size-4", STAGE_TONE_CLASS[stage.status], stage.status === "in_progress" && !stage.taskStatus && "animate-spin motion-reduce:animate-none")} aria-hidden />
    </li>
  );
}

function Notice({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div role="status" className={cn("space-y-1 rounded-md border px-3 py-2 text-xs", TONE_NOTICE[tone])}>{children}</div>;
}

/** One line of text with the rest a click away when it is long. */
function ShowMore({ text, testId }: { text: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  const long = isLongSummary(text);
  return (
    <p className="min-w-0 whitespace-pre-wrap break-words text-[11px] text-muted-foreground" data-testid={testId}>
      {open || !long ? text : shortSummary(text)}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="ml-1.5 underline underline-offset-2">
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </p>
  );
}

function RunRow({ run, now, onOpen }: { run: WorkflowRunSummary; now: number; onOpen: (runId: string) => void }) {
  const duration = formatDuration(elapsedMs(run, now));
  return (
    <li>
      <button
        type="button"
        data-testid="workflow-run"
        data-run-row={run.runId}
        data-status={run.status}
        onClick={() => onOpen(run.runId)}
        className="w-full space-y-2 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="block break-all font-mono text-xs text-muted-foreground">{issueRef(run)}</span>
            {run.kind !== "task" && run.issueTitle && <span className="block break-words text-sm font-medium">{run.issueTitle}</span>}
          </span>
          <StatusBadge run={run} />
        </span>
        {run.kind === "task" && run.title && <span className="block break-words text-sm font-medium">{run.title}</span>}
        <ol aria-label={`Stages of ${issueRef(run)}`} className="flex flex-wrap items-center gap-2">
          {run.stages.map((stage) => <Pip key={stage.name} stage={stage} />)}
          <li className="ml-1 min-w-0 truncate text-[11px] text-muted-foreground">at {run.current || "start"}</li>
        </ol>
        {run.recovery && <span data-testid="workflow-recovery-line" className="block break-words text-[11px] font-medium text-amber-700 dark:text-amber-300">{recoveryHeadline(run.recovery)}</span>}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <RiskBadge risk={run.risk} />
          {run.origin === "intake" && <span data-testid="workflow-origin" className="rounded border px-1.5 py-0.5">from intake</span>}
          {updatesLabel(run.updates) && <span data-testid="workflow-updates-count">{updatesLabel(run.updates)}</span>}
          {run.round > 0 && <span data-testid="workflow-round">review round {run.round}</span>}
          {duration && <span>{run.endedAt ? "took" : run.kind === "task" ? "elapsed" : "running"} {duration}</span>}
          {run.kind !== "task" && <span>{formatCost(run.costUsd)}</span>}
          <span>started {relativeTime(run.startedAt, now)}</span>
        </span>
      </button>
    </li>
  );
}

function StageItem({ stage, channelId, last, extra, awaitingMerge = false }: { stage: WorkflowStageView; channelId: string; last: boolean; extra?: React.ReactNode; awaitingMerge?: boolean }) {
  const Icon = awaitingMerge ? AlertTriangle : STAGE_ICON[stage.status];
  return (
    <li data-testid="workflow-stage" data-stage={stage.name} data-status={stage.status} className="relative flex gap-3 pb-4">
      {!last && <span aria-hidden className="absolute left-[7px] top-5 h-[calc(100%-1.25rem)] w-px bg-border" />}
      <Icon className={cn("relative mt-0.5 size-4 shrink-0 bg-background", STAGE_TONE_CLASS[stage.status], stage.status === "in_progress" && !stage.taskStatus && !awaitingMerge && "animate-spin motion-reduce:animate-none")} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{stage.name}</span>
          {stage.role && <span className="font-mono text-[11px] text-muted-foreground">{stage.role}</span>}
          <span className="text-[11px] text-muted-foreground">· {stage.taskStatus ? TASK_STAGE_LABEL[stage.taskStatus] : awaitingMerge ? "Awaiting merge authorization" : STAGE_STATUS_LABEL[stage.status]}</span>
        </p>
        {stage.result && (
          <div data-testid="task-stage-result" className="space-y-1 rounded-md border px-2.5 py-2">
            {stage.result.summary ? <>
              <p className="text-[11px] font-medium">{stage.taskStatus === "ready" || stage.taskStatus === "working" ? "Previous submission (not approved)" : "Stage result"}</p>
              <ShowMore text={stage.result.summary} testId="workflow-summary" />
              {stage.result.truncated && <p className="text-[11px] text-muted-foreground">Excerpt — full output is available in the task conversation.</p>}
            </> : <p className="text-[11px] text-muted-foreground">{stage.result.available ? "Result hidden for direct messages." : stage.taskStatus === "approved" ? "Completed — no recorded output." : "No results yet."}</p>}
            {stage.result.feedback && <><p className="text-[11px] font-medium">Feedback</p><ShowMore text={stage.result.feedback} testId="task-stage-feedback" /></>}
          </div>
        )}
        {stage.attempts.length > 0 && (
          <ul aria-label={`Attempts at ${stage.name}`} className="space-y-1.5">
            {stage.attempts.map((attempt, index) => (
              <li key={`${attempt.entry}-${index}`} data-testid="workflow-attempt" data-status={attempt.status} className="space-y-0.5 rounded-md border px-2.5 py-1.5">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium">{attemptTitle(attempt.entry, stage.entries)}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{attempt.role}</span>
                  <span className="text-[11px] text-muted-foreground">· {ATTEMPT_STATUS_LABEL[attempt.status]}</span>
                  {attempt.verdict && <span data-testid="workflow-verdict" className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{verdictLabel(stage, attempt.verdict)}</span>}
                  {attempt.reask && <span className="text-[11px] text-muted-foreground">(asked again for its verdict)</span>}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {attempt.durationMs > 0 ? `${formatDuration(attempt.durationMs)} · ` : ""}{formatCost(attempt.costUsd)} · {attempt.steps} {attempt.steps === 1 ? "step" : "steps"}
                </p>
                {attempt.summary && <ShowMore text={attempt.summary} testId="workflow-summary" />}
                {attempt.runKey && (
                  <a href={subagentHref(channelId, attempt.runKey)} data-testid="workflow-subagent-link" className="inline-block text-[11px] underline underline-offset-2">
                    Open this run's conversation ({threadLabel(attempt.runKey, "")})
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {extra}
      </div>
    </li>
  );
}

function MergeDetails({ run }: { run: WorkflowRunView }) {
  const risk = run.risk;
  return (
    <div data-testid="workflow-merge" className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <p className="font-medium">{run.waiting?.kind === "merge" ? "Merge — awaiting authorization" : "Merge"}</p>
      {run.waiting?.kind === "merge" && <p>Automatic merge was withheld. A person must authorize the reviewed commit; see the reason above. Review approval alone does not authorize merging.</p>}
      <p data-testid="workflow-merge-risk">{risk.scored ? riskLabel(risk) : "Not scored yet: review has not scored this change."}{risk.scored && risk.final !== undefined && risk.final !== risk.model ? " (raised by the merge gate)" : ""}</p>
      {risk.reason && <p className="break-words text-muted-foreground">{risk.reason}</p>}
      {risk.floors && risk.floors.length > 0 && (
        <ul className="list-inside list-disc text-muted-foreground">{risk.floors.map((floor) => <li key={floor} className="break-words">{floor}</li>)}</ul>
      )}
      {run.mergeRule && <p data-testid="workflow-rule" className="text-muted-foreground">Rule: {describeMergeRule(run.mergeRule)}.</p>}
    </div>
  );
}

function RunDetail({ channelId, run, isDm, now, onChanged }: { channelId: string; run: WorkflowRunView; isDm: boolean; now: number; onChanged: () => void }) {
  const actionsOn = run.guidance?.actions !== undefined;
  const issueUrl = run.workItem ? safeWorkItemUrl(run) : safeGithubUrl(run.issueUrl);
  const prUrl = safeGithubUrl(run.pr?.url);
  const duration = formatDuration(elapsedMs(run, now));
  const showMerge = run.kind !== "task" && run.stages.some((stage) => stage.name === "merge");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge run={run} />
        <RiskBadge risk={run.risk} />
        {run.round > 0 && <span className="text-xs text-muted-foreground">review round {run.round}</span>}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {issueUrl && (
          <a href={issueUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
            {run.workItem?.key ?? `Issue #${run.issue}`}<ExternalLink className="size-3" aria-hidden />
          </a>
        )}
        {run.pr && (prUrl ? (
          <a href={prUrl} data-testid="workflow-pr" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
            <GitPullRequest className="size-3" aria-hidden />PR #{run.pr.number}{run.pr.merged ? " (merged)" : ""}<ExternalLink className="size-3" aria-hidden />
          </a>
        ) : <span className="inline-flex items-center gap-1"><GitPullRequest className="size-3" aria-hidden />PR #{run.pr.number}{run.pr.merged ? " (merged)" : ""}</span>)}
      </p>
      <p className="text-[11px] text-muted-foreground">
        started {relativeTime(run.startedAt, now)}{duration ? ` · ${run.endedAt ? "took" : run.kind === "task" ? "elapsed" : "running for"} ${duration}` : ""}{run.kind !== "task" ? ` · ${formatCost(run.costUsd)}` : ""} · by {run.by.source}
        {run.by.threadKey ? ` in thread ${threadLabel(run.by.threadKey, "")}` : ""}
      </p>
      {run.kind === "task" && <>
        <Notice tone="info"><p>Task workflow. The parent reviews each submission against its gates in the original task conversation; a submission alone is not approval.</p></Notice>
        {run.taskActivity && <section aria-label="Current step activity" className="space-y-1 rounded-md border px-3 py-2 text-xs" data-testid="task-activity" data-state={run.taskActivity.state}>
          <p className="font-semibold">Current step activity</p>
          <p>{run.taskActivity.summary}</p>
          <p className="text-muted-foreground">Last recorded activity: {run.taskActivity.lastAt ? <time dateTime={run.taskActivity.lastAt} title={run.taskActivity.lastAt}>{relativeTime(run.taskActivity.lastAt, now)} ({new Date(run.taskActivity.lastAt).toLocaleString()})</time> : "unknown"}. Elapsed time alone does not confirm progress.</p>
          {run.taskActivity.diagnostic && <ShowMore text={run.taskActivity.diagnostic} />}
        </section>}
        <TaskWorkflowActions channelId={channelId} run={run} onChanged={onChanged} />
      </>}
      {run.waiting && (
        <Notice tone="warn">
          <p data-testid="workflow-waiting" className="font-medium">{waitingLine(run.waiting.kind, run.guidance?.actions)}</p>
          <p className="text-muted-foreground">Waiting since {relativeTime(run.waiting.since, now)}.</p>
        </Notice>
      )}
      {run.recovery && (
        <section aria-label="What can be done about the failed stage" data-testid="workflow-recovery" className={cn("space-y-1.5 rounded-md border px-3 py-2 text-xs", TONE_NOTICE.warn)}>
          <p className="font-medium" data-testid="workflow-recovery-title">{recoveryHeadline(run.recovery)}</p>
          {run.recovery.ended && (
            <p className="text-muted-foreground">{actionsOn ? "This run ended failed. Retry carries it on from the stage that failed." : "This run ended failed. A person can carry it on from the stage that failed; the console is read-only, so ask in the run's Slack thread or tell the channel agent."}</p>
          )}
          <ul className="space-y-1">
            {recoveryChoices(run.recovery).map((choice) => (
              <li key={choice.answer} data-testid="workflow-recovery-choice" data-answer={choice.answer}>
                <span className="font-medium">{choice.label}</span> <span className="text-muted-foreground">{choice.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <GuidancePanel channelId={channelId} run={run} showSummary={!run.waiting && !run.recovery} onChanged={onChanged} />
      {run.reason && <Notice tone={runTone(run.status)}><p data-testid="workflow-reason" className="break-words">{run.reason}</p></Notice>}
      {isDm && <p className="text-xs text-muted-foreground" data-testid="workflow-hidden">Details are hidden for direct messages.</p>}
      {run.origin !== "manual" && <p className="text-[11px] text-muted-foreground" data-testid="workflow-origin-line">{ORIGIN_LABEL[run.origin]}.</p>}
      {run.updatesReceived.length > 0 && (
        <section aria-label="Updates from the issue" data-testid="workflow-updates" className="space-y-1.5">
          <h3 className="text-xs font-semibold">Updates from the issue</h3>
          <p className="text-[11px] text-muted-foreground">Only trusted updates (from an owner, member or collaborator) are shown to a role. The others are recorded here and go no further.</p>
          <ul className="space-y-1.5">
            {run.updatesReceived.map((update, index) => (
              <li key={`${update.at}-${index}`} data-testid="workflow-update" data-trusted={update.trusted} className={cn("space-y-0.5 rounded-md border px-2.5 py-1.5", !update.trusted && "border-dashed")}>
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium">{UPDATE_KIND_LABEL[update.kind]}</span>
                  {update.author && <span className="font-mono text-[11px] text-muted-foreground">{update.author}{update.association ? ` · ${update.association.toLowerCase()}` : ""}{update.viaToken ? " · a person, on the token's account" : ""}</span>}
                  <span data-testid="workflow-update-trust" className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]", update.trusted ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
                    {update.trusted ? <CheckCircle2 className="size-3" aria-hidden /> : <Ban className="size-3" aria-hidden />}
                    {updateTrustLabel(update)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{relativeTime(update.at, now)}</span>
                </p>
                {update.excerpt && <ShowMore text={update.excerpt} testId="workflow-update-excerpt" />}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ol aria-label="Stages" className="pt-1">
        {run.stages.map((stage, index) => (
          <StageItem key={stage.name} stage={stage} channelId={channelId} last={index === run.stages.length - 1} awaitingMerge={stage.name === run.current && run.waiting?.kind === "merge"} extra={stage.name === "merge" && showMerge ? <MergeDetails run={run} /> : undefined} />
        ))}
      </ol>
    </div>
  );
}

function RunSheetBody({ channelId, runId, isDm, now, refreshToken, onChanged }: { channelId: string; runId: string; isDm: boolean; now: number; refreshToken: number; onChanged: () => void }) {
  const result = useApi((signal) => api.workflowRun(channelId, runId, signal), `workflow\n${channelId}\n${runId}`, refreshToken);
  if (result.error && result.data === undefined) {
    return (
      <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-xs">
        This run is not available. The channel's store may be closed, or the run no longer exists. ({result.error})
      </p>
    );
  }
  return <Async result={result}>{(data) => <RunDetail channelId={channelId} run={data.run} isDm={isDm} now={now} onChanged={() => { result.reload(); onChanged(); }} />}</Async>;
}

function IntakeRepo({ repo, isDm, now, onOpen }: { repo: IntakeRepoView; isDm: boolean; now: number; onOpen: (runId: string) => void }) {
  return (
    <div data-testid="intake-repo" data-repo={repo.repo} className="space-y-1.5 rounded-md border px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-mono font-medium">{repo.repo}</span>
        <span data-testid="intake-counts" className="text-muted-foreground">{intakeCountsLine(repo.counts)}</span>
      </p>
      <p className="text-[11px] text-muted-foreground" data-testid="intake-poll">
        {repo.lastOkAt ? `Last polled ${relativeTime(repo.lastOkAt, now)}.` : repo.lastPollAt ? `Polled ${relativeTime(repo.lastPollAt, now)}, not yet successfully.` : "Not polled yet."}
      </p>
      {repo.labels && (
        repo.labels.status === "failed"
          ? <div role="alert" data-testid="intake-labels" data-status="failed" className={cn("rounded-md border px-2 py-1 text-[11px]", TONE_NOTICE.bad)}><span className="break-words">{labelsText(repo.labels)}</span> Checked {relativeTime(repo.labels.checkedAt, now)}.</div>
          : <p data-testid="intake-labels" data-status={repo.labels.status} className="break-words text-[11px] text-muted-foreground">{labelsText(repo.labels)} Checked {relativeTime(repo.labels.checkedAt, now)}.</p>
      )}
      {repo.lastError && (
        <div role="alert" data-testid="intake-error" className={cn("rounded-md border px-2 py-1 text-[11px]", TONE_NOTICE.bad)}>The last poll failed: <span className="break-words">{repo.lastError}</span></div>
      )}
      {repo.mappings.length > 0 && (
        <ul aria-label={`Issues of ${repo.repo}`} className="space-y-1">
          {repo.mappings.map((mapping) => {
            const url = mapping.workItem ? safeWorkItemUrl({ issueUrl: mapping.url, workItem: mapping.workItem }) : safeGithubUrl(mapping.url);
            const ref = mapping.workItem?.key ?? `#${mapping.issue}`;
            return (
              <li key={mapping.issue} data-testid="intake-mapping" data-status={mapping.status} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                <span data-testid="intake-status" className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[11px]", mapping.status === "held" && "border-amber-500/50 bg-amber-500/10", mapping.status === "queued" && "border-sky-500/50 bg-sky-500/10")}>
                  {INTAKE_STATUS_LABEL[mapping.status]}
                </span>
                {url ? <a href={url} target="_blank" rel="noreferrer noopener" className="font-mono underline underline-offset-2">{ref}</a> : <span className="font-mono">{ref}</span>}
                {mapping.title && <span className="min-w-0 break-words">{mapping.title}</span>}
                {mapping.status === "open" && mapping.runId && (
                  <button type="button" data-testid="intake-open-run" onClick={() => onOpen(mapping.runId!)} className="text-[11px] underline underline-offset-2">Open its run</button>
                )}
                <span className="basis-full break-words text-[11px] text-muted-foreground" data-testid="intake-hint">
                  {mapping.reason && !isDm ? mapping.reason : INTAKE_STATUS_HINT[mapping.status]}
                  {mapping.author && !isDm ? ` · by ${mapping.author}` : ""}
                  {mapping.lastUpdated ? ` · last change ${relativeTime(mapping.lastUpdated, now)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Issue intake: which issues map to which runs, what is held or waiting, and when GitHub was last asked. */
export function IntakeBlock({ intake, isDm, now, onOpen }: { intake: IntakeView; isDm: boolean; now: number; onOpen: (runId: string) => void }) {
  return (
    <section aria-label="Issue intake" data-testid="intake" className="space-y-2">
      <p className="text-xs text-muted-foreground" data-testid="intake-summary">
        {intake.enabled ? `Intake is on: ${intake.source === "jira" ? "Jira" : "GitHub"} is polled every ${Math.round((intake.intervalSeconds ?? 0) / 60) || 1} min. A new issue from a trusted author starts a run; changes and comments go to its run.` : "Intake is off. What it mapped earlier is shown."}
      </p>
      {intake.repos.length === 0 ? <p className="text-xs text-muted-foreground">Nothing has been polled yet.</p> : intake.repos.map((repo) => <IntakeRepo key={repo.repo} repo={repo} isDm={isDm} now={now} onOpen={onOpen} />)}
    </section>
  );
}

export function WorkflowRuns({
  channelId, runs, isDm, now, runId, onOpen, refreshToken, onChanged = () => {}, actionsOn = false,
}: { channelId: string; runs: WorkflowRunSummary[]; isDm: boolean; now: number; runId: string | undefined; onOpen: (runId: string | undefined) => void; refreshToken: number; onChanged?: () => void; actionsOn?: boolean }) {
  const open = runs.find((run) => run.runId === runId);
  // By the time the sheet has closed the route no longer names the run, so remember which one opened it.
  const lastOpened = useRef<string | undefined>(undefined);
  if (runId) lastOpened.current = runId;
  return (
    <div className="space-y-2">
      {isDm && <p className="text-xs text-muted-foreground" data-testid="workflows-hidden">Details are hidden for direct messages.</p>}
      <ul className="space-y-2" aria-label="Workflow runs">
        {runs.map((run) => <RunRow key={run.runId} run={run} now={now} onOpen={onOpen} />)}
      </ul>
      <Sheet open={runId !== undefined} onOpenChange={(next) => { if (!next) onOpen(undefined); }}>
        <SheetContent
          side="right"
          data-testid="workflow-sheet"
          className="w-full max-w-none gap-0 p-0 sm:w-[34rem] sm:max-w-[34rem]"
          onCloseAutoFocus={(event) => {
            // The sheet is opened by route, not by a trigger, so hand focus back to the row that opened it.
            event.preventDefault();
            if (lastOpened.current) document.querySelector<HTMLElement>(`[data-run-row="${CSS.escape(lastOpened.current)}"]`)?.focus();
          }}
        >
          <div className="space-y-1 border-b p-4 pr-10">
            <SheetTitle className="break-words text-base">{open ? `${issueRef(open)}${open.title || open.issueTitle ? ` ${open.title || open.issueTitle}` : ""}` : "Workflow run"}</SheetTitle>
            <SheetDescription className="text-xs text-muted-foreground">The ordered stages, their status and available results.{open?.kind !== "task" && !actionsOn ? " Read-only." : ""}</SheetDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
            {runId && <RunSheetBody channelId={channelId} runId={runId} isDm={isDm} now={now} refreshToken={refreshToken} onChanged={onChanged} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
