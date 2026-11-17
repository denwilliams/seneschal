import type { JobPhaseStatus, JobPhaseView, JobRunStatus, JobRunView } from "@api/api-types";

/** How a run's state is told: always a word as well as a colour. */
export const RUN_STATUS_LABEL: Record<JobRunStatus, string> = {
  running: "Running",
  needs_decision: "Needs a decision",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
};

export const PHASE_STATUS_LABEL: Record<JobPhaseStatus, string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

export type Tone = "info" | "warn" | "ok" | "bad" | "muted";

export function runTone(status: JobRunStatus): Tone {
  return status === "running" ? "info" : status === "needs_decision" ? "warn" : status === "completed" ? "ok" : status === "failed" ? "bad" : "muted";
}

/** Classes for a status badge, by tone. Colour is never the only signal: the badge carries the label too. */
export const TONE_BADGE: Record<Tone, string> = {
  info: "border-sky-500/40 bg-sky-500/15 text-sky-800 dark:text-sky-200",
  warn: "border-amber-500/50 bg-amber-500/15 text-amber-900 dark:text-amber-200",
  ok: "border-emerald-500/40 bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
  bad: "border-red-500/50 bg-red-500/15 text-red-900 dark:text-red-200",
  muted: "border-border bg-muted text-muted-foreground",
};

export const TONE_NOTICE: Record<Tone, string> = {
  info: "border-sky-500/40 bg-sky-500/10",
  warn: "border-amber-500/50 bg-amber-500/10",
  ok: "border-emerald-500/40 bg-emerald-500/10",
  bad: "border-red-500/50 bg-red-500/10",
  muted: "border-border bg-muted/40",
};

/** What to tell a reader about a run that needs a decision. The console cannot act, so it says who can. */
// The server's own `reason` already says what happened and what the choices are, so this only says where to make the choice.
export const NEEDS_DECISION_HELP = "Waiting for a person. This console cannot act: tell the agent in Slack which to do.";

/** The position of the phase a run is at, or -1 once every phase is done (or the name is unknown). */
export function currentPhaseIndex(run: Pick<JobRunView, "currentPhase" | "phases">): number {
  return run.currentPhase === undefined ? -1 : run.phases.findIndex((phase) => phase.name === run.currentPhase);
}

/** "2 of 3 done": how far a run got. A skipped phase counts as passed. */
export function progressLabel(phases: readonly Pick<JobPhaseView, "status">[]): string {
  const passed = phases.filter((phase) => phase.status === "done" || phase.status === "skipped").length;
  return `${passed} of ${phases.length} done`;
}

/** How long a finished run took, in milliseconds; undefined while it is still going or when the times are unreadable. */
export function runDurationMs(run: Pick<JobRunView, "startedAt" | "endedAt">): number | undefined {
  if (!run.endedAt) return undefined;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** A phase summary longer than this is cut to one line until the reader asks for the rest. */
export const SUMMARY_CUT = 120;
export const isLongSummary = (text: string): boolean => text.length > SUMMARY_CUT;
export const shortSummary = (text: string): string => (isLongSummary(text) ? `${text.slice(0, SUMMARY_CUT - 1)}…` : text);

/** A phase's one-line label: its name, then its kind and exit code. */
export function phaseMeta(phase: Pick<JobPhaseView, "kind" | "exit">): string {
  return phase.exit === undefined ? phase.kind : `${phase.kind} · exit ${phase.exit}`;
}

/** The inputs of a run as sorted `[key, value]` pairs, or none when the server withheld them. */
export function inputEntries(input: Record<string, string> | undefined): [string, string][] {
  return input ? Object.entries(input).sort(([a], [b]) => a.localeCompare(b)) : [];
}
