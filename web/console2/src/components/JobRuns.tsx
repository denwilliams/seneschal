import { AlertTriangle, Ban, CheckCircle2, Circle, Loader2, MinusCircle, XCircle, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { JobPhaseStatus, JobPhaseView, JobRunStatus, JobRunView } from "@api/api-types";
import { formatDuration, relativeTime, threadLabel } from "@/lib/format";
import {
  currentPhaseIndex, inputEntries, isLongSummary, NEEDS_DECISION_HELP, PHASE_STATUS_LABEL, phaseMeta, progressLabel, RUN_STATUS_LABEL, runDurationMs, runTone,
  shortSummary, TONE_BADGE, TONE_NOTICE, type Tone,
} from "@/lib/jobs";
import { cn } from "@/lib/utils";

const RUN_ICON: Record<JobRunStatus, LucideIcon> = { running: Loader2, needs_decision: AlertTriangle, completed: CheckCircle2, failed: XCircle, aborted: Ban };
const PHASE_ICON: Record<JobPhaseStatus, LucideIcon> = { pending: Circle, running: Loader2, done: CheckCircle2, failed: XCircle, skipped: MinusCircle };
const PHASE_ICON_TONE: Record<JobPhaseStatus, string> = {
  pending: "text-muted-foreground", running: "text-sky-600 dark:text-sky-300", done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400", skipped: "text-muted-foreground",
};

function RunBadge({ status }: { status: JobRunStatus }) {
  const Icon = RUN_ICON[status];
  return (
    <span data-testid="job-status" data-status={status} className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold", TONE_BADGE[runTone(status)])}>
      <Icon className={cn("size-3", status === "running" && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

function RunNotice({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div role="status" className={cn("space-y-1 rounded-md border px-3 py-2 text-xs", TONE_NOTICE[tone])}>{children}</div>;
}

/** One line of what a phase did, with the rest a click away when it is long. */
function PhaseSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = isLongSummary(text);
  return (
    <p className="min-w-0 break-words text-[11px] text-muted-foreground" data-testid="phase-summary">
      {open || !long ? text : shortSummary(text)}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="ml-1.5 underline underline-offset-2">
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </p>
  );
}

function PhaseRow({ phase, current }: { phase: JobPhaseView; current: boolean }) {
  const Icon = PHASE_ICON[phase.status];
  return (
    <li
      data-testid="job-phase"
      data-status={phase.status}
      aria-current={current ? "step" : undefined}
      className={cn("flex items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm", current && "border-border bg-muted/60")}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", PHASE_ICON_TONE[phase.status], phase.status === "running" && "animate-spin motion-reduce:animate-none")} aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="break-all font-medium">{phase.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{phaseMeta(phase)}</span>
          <span className="text-[11px] text-muted-foreground">· {PHASE_STATUS_LABEL[phase.status]}{current ? " (current)" : ""}</span>
        </div>
        {phase.summary && <PhaseSummary text={phase.summary} />}
      </div>
    </li>
  );
}

function RunCard({ run, now }: { run: JobRunView; now: number }) {
  const current = currentPhaseIndex(run);
  const duration = formatDuration(runDurationMs(run));
  const inputs = inputEntries(run.input);
  return (
    <li data-testid="job-run" data-status={run.status} className="space-y-2 rounded-md border px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-all text-sm font-medium">{run.job}</span>
        <RunBadge status={run.status} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {progressLabel(run.phases)} · started {relativeTime(run.startedAt, now)}{duration ? ` · took ${duration}` : ""} · by {run.by.source}
        {run.by.threadKey ? ` in thread ${threadLabel(run.by.threadKey, "")}` : ""}
      </p>
      {run.status === "needs_decision" && (
        <RunNotice tone="warn">
          <p className="font-medium">{NEEDS_DECISION_HELP}</p>
          {run.reason && <p className="text-muted-foreground">{run.reason}</p>}
        </RunNotice>
      )}
      {run.status !== "needs_decision" && run.reason && (run.status === "failed" || run.status === "aborted") && (
        <RunNotice tone={runTone(run.status)}><p className="break-words">{run.reason}</p></RunNotice>
      )}
      <ol className="space-y-0.5" aria-label={`Phases of ${run.job}`}>
        {run.phases.map((phase, index) => <PhaseRow key={`${index}-${phase.name}`} phase={phase} current={index === current} />)}
      </ol>
      {inputs.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Inputs ({inputs.length})</summary>
          <dl className="mt-1 space-y-0.5 pl-3">
            {inputs.map(([key, value]) => (
              <div key={key} className="flex gap-2"><dt className="shrink-0 font-mono text-muted-foreground">{key}</dt><dd className="min-w-0 break-all font-mono">{value}</dd></div>
            ))}
          </dl>
        </details>
      )}
    </li>
  );
}

export function JobRuns({ runs, isDm, now }: { runs: JobRunView[]; isDm: boolean; now: number }) {
  return (
    <div className="space-y-2">
      {isDm && <p className="text-xs text-muted-foreground" data-testid="jobs-hidden">Details are hidden for direct messages.</p>}
      <ul className="space-y-3" aria-label="Job runs">
        {runs.map((run) => <RunCard key={run.runId} run={run} now={now} />)}
      </ul>
    </div>
  );
}
