import type { FactoryConfig } from "../../config/schema.ts";

/**
 * The GitHub labels a software factory works with, and keeping them in existence. The roles move an issue along with `status:*`
 * labels (the shipped `factory-handoffs` skill), the harness puts `factory.issues.labels` on an issue it files, and an issue
 * carrying `factory.intake.goLabel` starts a run whoever filed it. GitHub refuses a label that does not exist, so on a fresh
 * repository nothing would work until someone created them by hand. This creates the missing ones and nothing else: an existing
 * label is never edited or recoloured. See docs/FACTORY_WORKFLOW_DESIGN.md section 17.
 */

/** The status labels the roles use. A test keeps this equal to the labels the shipped skills name, so the two cannot drift. */
export const FACTORY_STATUS_LABELS: readonly string[] = [
  "status:triage", "status:ready", "status:in-progress", "status:in-review", "status:approved", "status:changes-requested", "status:deployed",
];

/** A label made here: neutral, and says where it came from. (GitHub caps a description at 100 characters.) */
export const CREATED_LABEL_COLOR = "ededed";
export const CREATED_LABEL_DESCRIPTION = "Created by the harness for the software factory workflow";

/** What the harness does with labels on GitHub. Behind an interface so tests use a faux one. */
export interface FactoryLabels {
  /** The names of every label the repository has. All pages. */
  list(repo: string): Promise<string[]>;
  /** Create one label. A label that is already there (someone made it a moment ago) is `exists`, not an error. */
  create(repo: string, label: { name: string; color: string; description: string }): Promise<"created" | "exists">;
}

/** Whether labels are to be kept for this factory: it files issues or watches for them. */
export const wantsLabels = (factory: Pick<FactoryConfig, "issues" | "intake"> | undefined): boolean =>
  factory?.intake?.source !== "jira" && (factory?.issues?.create === true || factory?.intake?.enabled === true);

/** Every label this factory needs, once each (GitHub treats names case-insensitively), in a stable order. */
export function factoryLabels(factory: Pick<FactoryConfig, "issues" | "intake">): string[] {
  const names = [
    ...(factory.issues?.labels ?? ["status:triage"]),
    factory.intake?.goLabel ?? "factory:go",
    ...FACTORY_STATUS_LABELS,
  ];
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** GitHub's complaint when an issue is filed or edited with a label the repository does not have. */
export const isLabelMissingError = (message: string): boolean =>
  /could not add label|label[^\n]*(not found|does not exist|doesn't exist)|(not found|does not exist|doesn't exist)[^\n]*label/i.test(message);

export type LabelsOutcome = {
  repo: string;
  checkedAt: number;
  /** The names created by this check. Empty when nothing was missing. */
  created: string[];
  /** Why the check failed, bounded, or "". */
  error: string;
};

const flat = (text: string, max: number): string => {
  const one = text.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

/** Make sure `names` exist in `repo`. Never throws: a failure is the outcome's `error`. */
export async function ensureRepoLabels(api: FactoryLabels, repo: string, names: readonly string[], now: () => number): Promise<LabelsOutcome> {
  const outcome: LabelsOutcome = { repo, checkedAt: now(), created: [], error: "" };
  try {
    const have = new Set((await api.list(repo)).map((name) => name.toLowerCase()));
    for (const name of names) {
      if (have.has(name.toLowerCase())) continue;
      const result = await api.create(repo, { name, color: CREATED_LABEL_COLOR, description: CREATED_LABEL_DESCRIPTION });
      if (result === "created") outcome.created.push(name);
    }
  } catch (error) {
    const stderr = String((error as { stderr?: unknown } | undefined)?.stderr ?? "");
    outcome.error = flat(stderr.trim() || (error instanceof Error ? error.message : String(error)), 300);
  }
  return outcome;
}

/** How long a failed check is left alone before the next opportunity tries again. */
export const LABELS_RETRY_MS = 10 * 60_000;

export interface LabelKeeperDeps {
  now(): number;
  /** The record of what was done (`labels_created`, `labels_failed`). Best effort. */
  audit(channelId: string, event: string, fields: Record<string, unknown>): void;
  retryMs?: number;
}

export interface LabelsRequest {
  channelId: string;
  repositories: readonly string[];
  labels: readonly string[];
  api: FactoryLabels;
  /** Check again even though the last check succeeded (an operation just failed on a missing label). A recent failure is still left alone. */
  force?: boolean;
  /** Told each outcome, to be kept where the console can show it. Best effort. */
  record?: (outcome: LabelsOutcome) => Promise<void> | void;
}

type RepoState = { fingerprint: string; ok: boolean; attemptedAt: number; running?: Promise<LabelsOutcome | undefined> };

/**
 * Decides when to look. A repository is checked once per process while its needs stay the same, again when they change (a config
 * reload that names other repositories or labels), and after a failure no more than once per `retryMs`, so a missing token or a
 * rate limit is never hammered. Several asks at once share one check.
 */
export class LabelKeeper {
  private readonly deps: LabelKeeperDeps;
  private readonly state = new Map<string, RepoState>();

  constructor(deps: LabelKeeperDeps) { this.deps = deps; }

  /** Forget a channel that no longer wants labels, so turning it back on checks again. */
  forget(channelId: string): void {
    for (const key of this.state.keys()) if (key.startsWith(`${channelId}\n`)) this.state.delete(key);
  }

  async ensure(request: LabelsRequest): Promise<LabelsOutcome[]> {
    const fingerprint = JSON.stringify([...request.labels].map((name) => name.toLowerCase()).sort());
    const wanted = new Set(request.repositories.map((repo) => `${request.channelId}\n${repo.toLowerCase()}`));
    // A repository dropped from the configuration stops being kept.
    for (const key of this.state.keys()) if (key.startsWith(`${request.channelId}\n`) && !wanted.has(key)) this.state.delete(key);
    const outcomes: LabelsOutcome[] = [];
    for (const repo of request.repositories) {
      const outcome = await this.one(request, repo, fingerprint);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  private async one(request: LabelsRequest, repo: string, fingerprint: string): Promise<LabelsOutcome | undefined> {
    const key = `${request.channelId}\n${repo.toLowerCase()}`;
    const known = this.state.get(key);
    const now = this.deps.now();
    if (known?.running) return known.running;
    if (known && known.fingerprint === fingerprint) {
      if (known.ok && !request.force) return undefined;
      if (!known.ok && now - known.attemptedAt < (this.deps.retryMs ?? LABELS_RETRY_MS)) return undefined;
    }
    const state: RepoState = { fingerprint, ok: false, attemptedAt: now };
    this.state.set(key, state);
    state.running = (async () => {
      const outcome = await ensureRepoLabels(request.api, repo, request.labels, this.deps.now);
      state.ok = outcome.error === "";
      state.attemptedAt = outcome.checkedAt;
      if (outcome.error) this.deps.audit(request.channelId, "labels_failed", { repo, error: outcome.error });
      else if (outcome.created.length > 0) this.deps.audit(request.channelId, "labels_created", { repo, labels: outcome.created });
      try { await request.record?.(outcome); } catch { /* the console missing a line is not a reason to fail */ }
      return outcome;
    })().finally(() => { state.running = undefined; });
    return state.running;
  }
}
