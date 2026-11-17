import { createHash } from "node:crypto";
import type { FactoryGitHub } from "./deps.ts";
import type { PrFacts } from "./merge.ts";
import { canReconcileClosureMerge, hasRecordedMerge } from "./closure-merge.ts";
import type { FactoryIntakeConfig } from "../../config/schema.ts";
import { isTerminalRun, MAX_LIVE_FACTORY_RUNS, UPDATE_EXCERPT_CHARS, type FactoryRunData, type RunUpdate } from "./docs.ts";
import { CLOSED_RETENTION_MS, MAX_INTAKE_ENTRIES, type CommentScan, type IntakeEntry, type IntakeRepoData } from "./intake-docs.ts";
import { parseFooter } from "./footer.ts";
import { PROVENANCE_MARKER } from "./issue-text.ts";
import { FACTORY_STATUS_LABELS } from "./labels.ts";
import { isTrustedAssociation, type IssueSource, type SourceComment, type SourceIssue } from "./source.ts";

/**
 * Issue intake: keep every open issue of a factory's repositories mapped to a run. A new issue gets a run, a changed issue sends
 * its changes to its run, a closed issue ends its run. One call to `pollIntake` is one poll of one channel; the loop that calls
 * it on a timer is intake-loop.ts. See docs/FACTORY_WORKFLOW_DESIGN.md section 15.
 *
 * The mapping is the intake document (intake-docs.ts), written here and by the store, never through the agent-writable channel
 * state. Everything GitHub says is data: a title, a body or a comment is bounded and recorded, and only what a trusted person
 * wrote ever reaches a role's brief.
 */

/** The part of the channel's store a poll uses. The real one is `DurableChannelStore`. */
export interface IntakeStore {
  listFactoryRuns(limit?: number): Promise<FactoryRunData[]>;
  factoryIntake(repo: string): Promise<IntakeRepoData>;
  mutateFactoryIntake(repo: string, change: (data: IntakeRepoData) => void): Promise<void>;
  recordIntakeUpdates(input: { repo: string; issue: number; runId: string; updates: RunUpdate[]; patch: Partial<IntakeEntry> }): Promise<void>;
  factoryRun(runId: string): Promise<FactoryRunData | undefined>;
  reconcileMergedFactoryRun(runId: string, pr: number, facts: PrFacts): Promise<boolean>;
  abortFactoryRun(runId: string, reason: string): Promise<"marked" | "terminal">;
}

/** What a poll tells the people in the channel, as structure: the Slack side words it and escapes it. */
export type IntakeNote = {
  workItem?: import("./source.ts").WorkItem;
  key: string;
  kind: "held" | "queued" | "breaker" | "closed" | "released";
  repo: string;
  issue?: number;
  title?: string;
  author?: string;
  detail?: string;
};

export type IntakeStartRequest = {
  workItem?: import("./source.ts").WorkItem;
  repo: string;
  issue: number;
  title: string;
  url: string;
  trust: string;
  mapping: Partial<Pick<IntakeEntry, "author" | "association" | "createdAt" | "lastUpdatedAt" | "commentWatermark" | "comments" | "bodyHash" | "labelsKey">>;
  updates: RunUpdate[];
  reopened: boolean;
};

export interface IntakeContext {
  channelId: string;
  repositories: readonly string[];
  settings: FactoryIntakeConfig;
  /** The most runs live in the channel at once (`factory.maxLiveRuns`). Absent: `MAX_LIVE_FACTORY_RUNS`. */
  maxLive?: number;
  store: IntakeStore;
  source: IssueSource;
  /** Read actual PR state before interpreting closure as cancellation. Missing credentials defer closure, never guess. */
  github?: Pick<FactoryGitHub, "readPr">;
  /** Start a run for the issue, as intake. Rejects with the reason when it cannot (a full channel, a missing role). */
  start(request: IntakeStartRequest): Promise<void>;
  now(): number;
  audit(event: string, fields: Record<string, unknown>): void;
  note?(note: IntakeNote): void;
  /** Refresh cards even when an already-ended run has no task left to notify its observers. Best effort. */
  onRunChange?(run: FactoryRunData): void;
}

export interface RepoOutcome { repo: string; started: number; updated: number; closed: number; held: number; queued: number; error?: string }
export interface IntakeOutcome { repos: RepoOutcome[]; failed: boolean }

/** Polls ask for a little before the last change they saw, so a change made while one was running is not missed. Applying a change twice is harmless. */
export const OVERLAP_MS = 5 * 60_000;
const MAX_PAGES = 3;
/** A mapped issue with a live run that nothing has been heard of for this long is asked about on its own. */
export const SWEEP_MS = 6 * 60 * 60_000;
const SWEEP_MAX = 5;
const BACKFILL_MS = 30 * 24 * 60 * 60_000;
/** The breaker trips when this many times `maxPerHour` new issues appear at once. */
const BREAKER_FACTOR = 3;

const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩﻿]/g;
const bounded = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const flat = (text: string): string => text.replace(HIDDEN, "").replace(/\s+/g, " ").trim();
const excerpt = (text: string): string => bounded(flat(text), UPDATE_EXCERPT_CHARS);

export const bodyHash = (body: string): string => createHash("sha256").update(body).digest("hex").slice(0, 16);
export const labelsKey = (labels: readonly string[]): string => `L:${[...labels].map((label) => label.toLowerCase()).sort().join("|")}`;

export type Classification =
  | { kind: "eligible"; trust: string }
  | { kind: "held"; reason: string }
  | { kind: "ignored"; reason: string };

/**
 * What a new (or reopened, or reconsidered) open issue is to intake. Order matters: locked and ignore labels are not for the
 * factory at all; a release (a person said go) or the go label overrides trust and the no-backfill rule; then trust decides.
 */
export function classifyIssue(
  issue: SourceIssue, data: Pick<IntakeRepoData, "enabledAt" | "filedByHarness">, settings: FactoryIntakeConfig,
  options: { released: boolean; reopened: boolean },
): Classification {
  if (issue.selection && !issue.selection.eligible) return { kind: issue.selection.ambiguous ? "held" : "ignored", reason: issue.selection.reason };
  if (issue.workItem) {
    if (options.released) return { kind: "eligible", trust: "released" };
    return isTrustedAssociation(issue.association) ? { kind: "eligible", trust: "jira_trusted_account" } : { kind: "held", reason: "Jira author is not in trustedAccountIds; an approver must release it" };
  }
  if (issue.locked) return { kind: "ignored", reason: "locked" };
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
  const ignored = settings.ignoreLabels.find((label) => labels.has(label.toLowerCase()));
  if (ignored) return { kind: "ignored", reason: `carries the label ${ignored}` };
  if (options.released) return { kind: "eligible", trust: "released" };
  if (labels.has(settings.goLabel.toLowerCase())) return { kind: "eligible", trust: "go_label" };
  if (!options.reopened && !settings.backfill && issue.createdAt < data.enabledAt) return { kind: "ignored", reason: "older than intake: it was filed before intake was turned on" };
  if (isTrustedAssociation(issue.association)) return { kind: "eligible", trust: "author_association" };
  if (harnessFiled(issue, data)) return { kind: "eligible", trust: "harness_filed" };
  return { kind: "held", reason: "its author is not an owner, member or collaborator" };
}

/** The harness filed it: the provenance footer AND a filing recorded when it was made. Text alone can be forged by anyone. */
export const harnessFiled = (issue: Pick<SourceIssue, "number" | "body">, data: Pick<IntakeRepoData, "filedByHarness">): boolean =>
  data.filedByHarness.includes(issue.number) && issue.body.includes(PROVENANCE_MARKER);

/**
 * The window of a stage attempt on the clock, with a little room either side. A comment from the harness's own account inside one
 * is taken to be the role's, whether or not it remembered the footer. The room before is small (a person's reply that restarts a
 * stage was posted before it, and was classified when it was first seen); the room after covers GitHub stamping a comment in
 * whole seconds and the two clocks not agreeing.
 */
export const WINDOW_BEFORE_MS = 2_000;
export const WINDOW_AFTER_MS = 5_000;

export function inStageWindow(runs: readonly Pick<FactoryRunData, "stages">[], at: number, now: number): boolean {
  for (const run of runs) {
    for (const stage of run.stages) {
      for (const attempt of stage.attempts) {
        if (attempt.startedAt <= 0) continue;
        const end = attempt.endedAt > 0 ? attempt.endedAt : now;
        if (at >= attempt.startedAt - WINDOW_BEFORE_MS && at <= end + WINDOW_AFTER_MS) return true;
      }
    }
  }
  return false;
}

/**
 * A comment written from the harness's own GitHub account: the agent's, or a person's using the same account? The footer the engine
 * asks every role to end with says it is the agent's; failing that, a comment made while one of the run's stages was working is
 * taken to be the role's; anything else is a person's reply. A role that forgets the footer is covered by the window; the cost is
 * that a person's reply typed while a stage is actively running is taken for the role's (it is audited, and the person can add to
 * it after the stage ends). docs/FACTORY_WORKFLOW_DESIGN.md section 19.
 */
export type OwnComment = "marker" | "window" | "person";
export function classifyOwnComment(comment: Pick<SourceComment, "body" | "createdAt">, runs: readonly Pick<FactoryRunData, "stages">[], now: number): OwnComment {
  if (parseFooter(comment.body)) return "marker";
  return inStageWindow(runs, comment.createdAt, now) ? "window" : "person";
}

/**
 * The version of the rules that sort an issue's comments (who wrote it, and whether it is news). Raised when they change in a way
 * that makes comments an older poll threw away worth reading again: 2 is the shared-account rules (section 19). A repository whose
 * record says less has the comments of its waiting runs read again, once (section 22).
 */
export const COMMENT_RULES_VERSION = 2;

/** Where a re-read of a run's issue starts: just before the run did. The comments that count are sorted again, and no update is recorded twice. */
export const rewindPoint = (run: Pick<FactoryRunData, "startedAt">): number => Math.max(0, run.startedAt - 1);

/** A comment this run already has as an update: the same moment and writer. A re-read must not tell a run the same thing twice. */
const alreadyDelivered = (run: Pick<FactoryRunData, "updates"> | undefined, comment: Pick<SourceComment, "author" | "createdAt">): boolean =>
  (run?.updates ?? []).some((update) => update.kind === "comment" && update.at === comment.createdAt && update.author === comment.author);

/** The harness moves an issue along with these labels by itself; a change to only them is not news for a run. */
const STATUS_LABELS = new Set(FACTORY_STATUS_LABELS.map((label) => label.toLowerCase()));

const newEntry = (issue: SourceIssue, now: number): IntakeEntry => ({
  ...(issue.workItem ? { workItem: issue.workItem } : {}),
  number: issue.number, title: bounded(flat(issue.title), 200), url: issue.url, author: issue.author, association: issue.association, trust: "", status: "ignored", reason: "",
  runId: "", runs: [], createdAt: issue.createdAt, lastUpdatedAt: issue.updatedAt, commentWatermark: 0, comments: issue.comments, bodyHash: bodyHash(issue.body),
  labelsKey: labelsKey(issue.labels), released: false, checkedAt: now, firstSeen: now, closedAt: 0,
});

/** One poll of every repository of one channel. Never throws: a failure is recorded on the repository and reported in the outcome. */
export async function pollIntake(ctx: IntakeContext): Promise<IntakeOutcome> {
  const outcome: IntakeOutcome = { repos: [], failed: false };
  let self: string;
  try {
    self = await ctx.source.selfLogin();
  } catch (error) {
    const message = bounded(flat(error instanceof Error ? error.message : String(error)), 300);
    ctx.audit("intake_error", { error: message, where: "login" });
    for (const repo of ctx.repositories) await ctx.store.mutateFactoryIntake(repo, (data) => { data.lastPollAt = ctx.now(); data.lastError = message; }).catch(() => undefined);
    return { repos: ctx.repositories.map(repo => ({ repo, started: 0, updated: 0, closed: 0, held: 0, queued: 0, error: message })), failed: true };
  }
  for (const repo of ctx.repositories) {
    const stats: RepoOutcome = { repo, started: 0, updated: 0, closed: 0, held: 0, queued: 0 };
    try {
      await pollRepo(ctx, repo, self, stats);
      await ctx.store.mutateFactoryIntake(repo, (data) => { data.lastPollAt = ctx.now(); data.lastOkAt = ctx.now(); data.lastError = ""; });
    } catch (error) {
      const message = bounded(flat(error instanceof Error ? error.message : String(error)), 300);
      stats.error = message;
      outcome.failed = true;
      ctx.audit("intake_error", { repo, error: message });
      await ctx.store.mutateFactoryIntake(repo, (data) => { data.lastPollAt = ctx.now(); data.lastError = message; }).catch(() => undefined);
    }
    outcome.repos.push(stats);
  }
  return outcome;
}

async function pollRepo(ctx: IntakeContext, repo: string, self: string, stats: RepoOutcome): Promise<void> {
  const { store, source, settings } = ctx;
  const now = ctx.now();
  let data = await store.factoryIntake(repo);

  // The first poll after intake is turned on only notes the time: issues filed before it are not started, and the change since is what the next poll asks for.
  if (data.enabledAt === 0) {
    await store.mutateFactoryIntake(repo, (d) => {
      if (d.enabledAt !== 0) return;
      d.enabledAt = settings.backfill ? 1 : now;
      d.since = settings.backfill ? now - BACKFILL_MS : now;
    });
    ctx.audit("intake_baseline", { repo, backfill: settings.backfill });
    if (!settings.backfill) return;
    data = await store.factoryIntake(repo);
  }

  const runs = await store.listFactoryRuns(500);
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const work: Record<string, IntakeEntry> = JSON.parse(JSON.stringify(data.entries));
  const touched = new Set<number>();
  const touch = (entry: IntakeEntry): IntakeEntry => { work[String(entry.number)] = entry; touched.add(entry.number); return entry; };
  const fresh = new Set<number>(); // entries that became eligible in this poll (not already queued before it)
  const seen = new Set<number>();
  let maxUpdated = data.since;

  const note = (n: IntakeNote) => { try { ctx.note?.({ ...n, ...(n.issue && work[String(n.issue)]?.workItem ? { workItem: work[String(n.issue)]!.workItem } : {}) }); } catch { /* telling people is best effort */ } };

  // Several issues/runs may share one PR. Read it once per poll, but reconcile each run independently.
  const prs = new Map<number, Promise<PrFacts>>();
  const readPr = (number: number): Promise<PrFacts> => {
    if (!ctx.github) throw new Error("Cannot reconcile issue closure: GitHub PR reads are unavailable");
    let facts = prs.get(number);
    if (!facts) { facts = ctx.github.readPr(repo, number); prs.set(number, facts); }
    return facts;
  };
  const entryRuns = (entry: IntakeEntry): string[] => [...new Set([entry.runId, ...entry.runs].filter(Boolean))];

  /** An issue closed (or is gone): first reconcile actual PR merges, then cancel genuinely unresolved work. */
  const closeEntry = async (entry: IntakeEntry, why: string, updatedAt?: number): Promise<void> => {
    let aborted = false;
    let merged = false;
    for (const runId of entryRuns(entry)) {
      const run = await store.factoryRun(runId);
      if (!run) continue;
      if (canReconcileClosureMerge(run)) {
        const facts = await readPr(run.pr.number); // Failure leaves the mapping open for the next poll.
        if (facts.state === "merged") {
          const reconciled = await store.reconcileMergedFactoryRun(runId, run.pr.number, facts);
          if (reconciled) {
            const current = await store.factoryRun(runId);
            try { if (current) ctx.onRunChange?.(current); } catch { /* observers cannot undo reconciliation */ }
          }
          merged = true;
          ctx.audit("intake_merge_reconciled", { repo, issue: entry.number, runId, pr: run.pr.number, head: facts.headSha, mergeCommit: facts.mergeCommit, reconciled });
          continue;
        }
      }
      if (!isTerminalRun(run.status) && !hasRecordedMerge(run)) {
        const result = await store.abortFactoryRun(runId, "issue_closed: the issue was closed on GitHub");
        aborted ||= result === "marked";
        ctx.audit("intake_issue_closed", { repo, issue: entry.number, runId, aborted: result === "marked", why });
      }
    }
    if (merged || aborted) note({ key: `closed:${repo}#${entry.number}:${entry.runId}:${merged ? "merged" : "aborted"}`, kind: "closed", repo, issue: entry.number, title: entry.title, detail: merged ? "its PR merged; its run was reconciled without deployment" : "its run was aborted" });
    entry.status = "closed";
    entry.closedAt ||= ctx.now();
    entry.checkedAt = ctx.now();
    entry.reason = merged ? "closed; its associated PR merged" : aborted ? "closed; its run was aborted" : "closed";
    if (updatedAt) entry.lastUpdatedAt = updatedAt;
    touch(entry);
    stats.closed++;
  };

  /** Changes on an open, mapped issue go to its run. */
  const deliver = async (entry: IntakeEntry, issue: SourceIssue): Promise<void> => {
    const run = runsById.get(entry.runId);
    entry.checkedAt = ctx.now();
    const baseline = entry.lastUpdatedAt === 0;
    if (!baseline && issue.updatedAt <= entry.lastUpdatedAt) { touch(entry); return; }
    const issueAuthorTrusted = !source.explicitTrust && (isTrustedAssociation(issue.association) || harnessFiled(issue, data));
    const updates: RunUpdate[] = [];
    const live = run !== undefined && !isTerminalRun(run.status);
    const issueRuns = [entry.runId, ...entry.runs].filter((id, i, all) => id && all.indexOf(id) === i).map((id) => runsById.get(id)).filter((r): r is FactoryRunData => r !== undefined);
    // The roles edit the issue and its labels through the account a person may use, and GitHub does not say who changed what. A change
    // that landed while one of the run's stages was working is the role's own: told to the run it came from, it would wake a run that
    // is waiting for an answer straight away, and triage would ask its question again (section 22).
    const ownChange = inStageWindow(issueRuns, issue.updatedAt, ctx.now());
    let changesInStage = 0;
    const change = (update: RunUpdate): void => { if (ownChange) changesInStage++; else updates.push(update); };
    if (!baseline) {
      const newBody = bodyHash(issue.body);
      if (entry.bodyHash && newBody !== entry.bodyHash) change({ kind: "edited", author: issue.author, association: issue.association, trusted: issueAuthorTrusted, excerpt: excerpt(`the description now reads: ${issue.body}`), at: issue.updatedAt });
      if (entry.title && flat(issue.title) !== entry.title) change({ kind: "edited", author: issue.author, association: issue.association, trusted: issueAuthorTrusted, excerpt: excerpt(`title changed from "${entry.title}" to "${issue.title}"`), at: issue.updatedAt });
      const key = labelsKey(issue.labels);
      if (entry.labelsKey && key !== entry.labelsKey) {
        const before = new Set(entry.labelsKey.slice(2).split("|").filter(Boolean));
        const after = new Set(key.slice(2).split("|").filter(Boolean));
        // The roles move an issue along with the status labels (through the same account a person may use), and GitHub does not say who
        // changed a label, so a change to only those is the workflow's own and is not delivered to the run it came from.
        const added = [...after].filter((label) => !before.has(label) && !STATUS_LABELS.has(label.toLowerCase()));
        const removed = [...before].filter((label) => !after.has(label) && !STATUS_LABELS.has(label.toLowerCase()));
        // Only people with triage rights can change labels, so a label change is from someone trusted.
        if (added.length + removed.length > 0) change({ kind: "labels", author: "", association: "", trusted: !source.explicitTrust, excerpt: excerpt(`labels ${added.length ? `added: ${added.join(", ")}` : ""}${added.length && removed.length ? "; " : ""}${removed.length ? `removed: ${removed.join(", ")}` : ""}`), at: issue.updatedAt });
      }
    }
    let watermark = entry.commentWatermark;
    let scan: CommentScan | undefined;
    if (entry.comments < 0 || issue.comments > entry.comments) {
      // Only when the count grew: a label or an edit does not cost a call. The watermark makes it only the new ones.
      if (source.explicitTrust && !self) throw new Error("Tracker account identity is unavailable; comment intake is closed");
      const comments = await source.comments(repo, entry.number, watermark);
      const counted: CommentScan = { at: ctx.now(), fetched: 0, delivered: 0, untrusted: 0, skippedOwn: 0, skippedByFooter: 0, duplicates: 0, changesInStage, rechecked: entry.recheck === true };
      for (const comment of comments) {
        if (comment.createdAt <= watermark) continue;
        watermark = Math.max(watermark, comment.createdAt);
        if (!flat(comment.body)) continue;
        counted.fetched++;
        if (alreadyDelivered(run, comment)) { counted.duplicates++; continue; }
        if (source.explicitTrust && parseFooter(comment.body)) { counted.skippedOwn++; counted.skippedByFooter++; continue; }
        if (comment.author === self) {
          // The harness's account, which may be a person's too: see classifyOwnComment.
          const kind = classifyOwnComment(comment, issueRuns, ctx.now());
          if (kind !== "person") { counted.skippedOwn++; if (kind === "marker") counted.skippedByFooter++; continue; }
          // GitHub retains token-based trust. Jira falls through to its explicit
          // account allowlist, even for a human using the authenticated account.
          if (!source.explicitTrust) {
            updates.push({ kind: "comment", author: comment.author, association: comment.association, trusted: true, viaToken: true, excerpt: excerpt(comment.body), at: comment.createdAt });
            counted.delivered++;
            continue;
          }
        }
        const trusted = isTrustedAssociation(comment.association);
        updates.push({ kind: "comment", author: comment.author, association: comment.association, trusted, excerpt: excerpt(comment.body), at: comment.createdAt });
        if (trusted) counted.delivered++; else counted.untrusted++;
      }
      scan = counted;
      // Counts only, so a run that goes round in circles can be told from a quiet issue: nothing here is text from the issue.
      if (counted.fetched > 0 || entry.recheck) {
        ctx.audit("intake_comments", { repo, issue: entry.number, runId: entry.runId, ...counted });
        if (counted.skippedOwn - counted.skippedByFooter > 0) ctx.audit("intake_own_comment_in_window", { repo, issue: entry.number, runId: entry.runId, taken: counted.skippedOwn - counted.skippedByFooter, withFooter: counted.skippedByFooter });
      }
    }
    const stamp = ctx.now();
    for (const update of updates) update.seen = stamp;
    const patch: Partial<IntakeEntry> = {
      lastUpdatedAt: issue.updatedAt, title: bounded(flat(issue.title), 200), bodyHash: bodyHash(issue.body), labelsKey: labelsKey(issue.labels), comments: issue.comments,
      commentWatermark: watermark, checkedAt: ctx.now(), author: issue.author, association: issue.association,
      ...(scan ? { lastScan: scan } : {}), ...(entry.recheck ? { recheck: false } : {}),
    };
    if (!live) {
      // Nothing to tell a finished run; the markers still move so it is not asked about again.
      await store.mutateFactoryIntake(repo, (d) => { const e = d.entries[String(entry.number)]; if (e) d.entries[String(entry.number)] = { ...e, ...patch }; });
      Object.assign(entry, patch);
      return;
    }
    await store.recordIntakeUpdates({ repo, issue: entry.number, runId: entry.runId, updates, patch });
    Object.assign(entry, patch);
    if (updates.length > 0) {
      stats.updated++;
      ctx.audit("intake_updates", { repo, issue: entry.number, runId: entry.runId, kinds: updates.map((u) => u.kind), trusted: updates.filter((u) => u.trusted).length, untrusted: updates.filter((u) => !u.trusted).length });
    }
  };

  /** An open issue that is not mapped to a live run: is it for the factory, and may it start by itself? */
  const consider = (issue: SourceIssue, previous: IntakeEntry | undefined, reopened: boolean): void => {
    const entry = previous ? { ...previous } : newEntry(issue, ctx.now());
    entry.title = bounded(flat(issue.title), 200);
    entry.url = issue.url;
    if (issue.workItem) entry.workItem = issue.workItem;
    entry.author = issue.author;
    entry.association = issue.association;
    entry.lastUpdatedAt = issue.updatedAt;
    entry.bodyHash = bodyHash(issue.body);
    entry.labelsKey = labelsKey(issue.labels);
    entry.comments = issue.comments;
    const verdict = classifyIssue(issue, data, settings, { released: entry.released, reopened });
    const before = previous?.status;
    if (verdict.kind === "eligible") {
      entry.status = "queued";
      entry.trust = verdict.trust;
      entry.reason = "";
      if (before !== "queued") fresh.add(entry.number);
    } else if (verdict.kind === "held") {
      entry.status = "held";
      entry.reason = verdict.reason;
      entry.trust = "";
      if (before !== "held") {
        stats.held++;
        note({ key: `held:${repo}#${entry.number}`, kind: "held", repo, issue: entry.number, ...(issue.workItem ? { workItem: issue.workItem } : {}), title: entry.title, author: entry.author, detail: issue.workItem ? verdict.reason : settings.goLabel });
      }
    } else {
      entry.status = "ignored";
      entry.reason = verdict.reason;
    }
    touch(entry);
  };

  // ── Comments read again: once after the comment rules changed, and whenever a person asked for one issue ──────────────────
  // A run waiting for an answer that was dropped by older rules (the harness's own account used to be skipped whole) never sees it:
  // the watermark had moved past it. Reading from the run's start with today's rules finds it; what the run already has is not told twice.
  const upgrade = (data.commentRules ?? 1) < COMMENT_RULES_VERSION;
  let recheckFailed = false;
  for (const entry of Object.values(work)) {
    if (entry.status !== "open" || !entry.runId) continue;
    const run = runsById.get(entry.runId);
    const live = run !== undefined && !isTerminalRun(run.status);
    if (!entry.recheck && !(upgrade && live && run.wait.kind === "info")) continue;
    if (!run || !live) { delete entry.recheck; touch(entry); continue; } // a person asked, but the run has ended: nothing to tell it
    const before = { ...entry };
    entry.recheck = true;
    entry.commentWatermark = Math.min(entry.commentWatermark, rewindPoint(run));
    entry.comments = -1;
    entry.lastUpdatedAt = 1;
    try {
      const issue = await source.issue(repo, entry.number);
      if (!issue || issue.state === "closed") { await closeEntry(entry, issue ? "closed on GitHub" : "gone from GitHub"); continue; }
      seen.add(entry.number);
      await deliver(entry, issue);
      ctx.audit("intake_recheck", { repo, issue: entry.number, runId: entry.runId, why: before.recheck ? "asked" : "comment rules changed" });
    } catch (error) {
      recheckFailed = true;
      Object.assign(entry, before); // nothing was written: the next poll reads again
      ctx.audit("intake_recheck_failed", { repo, issue: entry.number, runId: entry.runId, error: bounded(flat(error instanceof Error ? error.message : String(error)), 300) });
    }
  }

  // ── What changed since the last poll ───────────────────────────────────────────────────────────────────
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { issues, full } = await source.changedSince(repo, Math.max(0, data.since - OVERLAP_MS), page);
    for (const issue of [...issues].sort((a, b) => a.updatedAt - b.updatedAt)) {
      maxUpdated = Math.max(maxUpdated, issue.updatedAt);
      if (issue.isPullRequest) continue;
      seen.add(issue.number);
      const entry = work[String(issue.number)];
      if (issue.state === "closed") {
        if (entry && (entry.status !== "closed" || entryRuns(entry).some((id) => {
          const run = runsById.get(id); return run && canReconcileClosureMerge(run);
        }))) await closeEntry(entry, "closed on GitHub", issue.updatedAt);
        continue;
      }
      if (!entry) consider(issue, undefined, false);
      else if (entry.status === "closed") consider(issue, entry, true);
      else if (entry.status === "open") await deliver(entry, issue);
      else consider(issue, entry, false); // held, ignored or queued: reconsidered, because a label or a release may have changed the answer
    }
    if (!full) break;
  }

  // ── The idle sweep: an issue that was deleted or moved changes nothing visible, so a quiet mapped one is asked about on its own ──
  const sweepable = Object.values(work).filter((e) => e.status === "open" && !seen.has(e.number) && runsById.get(e.runId) && !isTerminalRun(runsById.get(e.runId)!.status) && (source.explicitTrust || now - e.checkedAt > SWEEP_MS));
  for (const entry of sweepable.slice(0, SWEEP_MAX)) {
    const issue = await source.issue(repo, entry.number);
    if (!issue || issue.state === "closed") { await closeEntry(entry, issue ? "closed on GitHub" : "gone from GitHub"); continue; }
    await deliver(entry, issue);
  }

  // Closure can be visible before the merge, or an old poll may already have cancelled the run. Recheck a bounded, rotating
  // set of retained closed mappings even when GitHub has no new issue event; explicit operator aborts are never reopened.
  const closed = Object.values(work).filter((entry) => entry.status === "closed" && !seen.has(entry.number)
    && entryRuns(entry).some((id) => { const run = runsById.get(id); return run && canReconcileClosureMerge(run); }))
    .sort((a, b) => a.checkedAt - b.checkedAt);
  for (const entry of closed.slice(0, SWEEP_MAX)) await closeEntry(entry, "recheck closed issue");

  // ── Admission: who starts now ─────────────────────────────────────────────────────────────────────────
  const queued = Object.values(work).filter((e) => e.status === "queued").sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
  // A flood of new issues at once is held for a person rather than started.
  const limit = BREAKER_FACTOR * settings.maxPerHour;
  const newcomers = queued.filter((e) => fresh.has(e.number));
  if (newcomers.length > limit) {
    for (const entry of newcomers.slice(limit)) {
      entry.status = "held";
      entry.reason = "held by the circuit breaker: too many new issues arrived at once. Add the go label or release it to start it";
      entry.trust = "";
      touch(entry);
      stats.held++;
    }
    if (!data.breaker) note({ key: `breaker:${repo}:${Math.floor(now / 3_600_000)}`, kind: "breaker", repo, detail: `${newcomers.length} new issues arrived at once (the limit is ${limit}); the newest were held` });
    await store.mutateFactoryIntake(repo, (d) => { d.breaker = true; });
  } else if (data.breaker) {
    await store.mutateFactoryIntake(repo, (d) => { d.breaker = false; });
  }

  const live = runs.filter((run) => !isTerminalRun(run.status)).length;
  let capacity = (ctx.maxLive ?? MAX_LIVE_FACTORY_RUNS) - live;
  let hourBudget = settings.maxPerHour - data.starts.filter((at) => now - at < 3_600_000).length;
  let pollBudget = settings.maxStartsPerPoll;
  for (const entry of queued.filter((e) => e.status === "queued")) {
    if (capacity <= 0 || hourBudget <= 0 || pollBudget <= 0) break;
    const current = await source.issue(repo, entry.number);
    if (!current || current.state === "closed") { await closeEntry(entry, current ? "closed on GitHub" : "gone from GitHub"); continue; }
    if (current.isPullRequest) { entry.status = "ignored"; entry.reason = "a pull request"; touch(entry); continue; }
    const verdict = classifyIssue(current, data, settings, { released: entry.released, reopened: entry.runs.length > 0 });
    if (verdict.kind !== "eligible") {
      entry.status = verdict.kind === "held" ? "held" : "ignored";
      entry.reason = verdict.reason;
      touch(entry);
      continue;
    }
    const reopened = entry.runs.length > 0;
    try {
      await ctx.start({
        repo, issue: entry.number, title: current.title, url: current.url, trust: verdict.trust, reopened, ...(current.workItem ? { workItem: current.workItem } : {}),
        mapping: {
          author: current.author, association: current.association, createdAt: current.createdAt, lastUpdatedAt: current.updatedAt, commentWatermark: ctx.now(), comments: current.comments,
          bodyHash: bodyHash(current.body), labelsKey: labelsKey(current.labels),
        },
        updates: reopened ? [{ kind: "reopened", author: current.author, association: current.association, trusted: verdict.trust !== "", excerpt: "the issue was reopened", at: ctx.now() }] : [],
      });
      stats.started++;
      capacity--; hourBudget--; pollBudget--;
      touched.delete(entry.number); // the start wrote the mapping itself
      entry.status = "open";
      ctx.audit("intake_started", { repo, issue: entry.number, trust: verdict.trust, reopened });
    } catch (error) {
      const message = bounded(flat(error instanceof Error ? error.message : String(error)), 300);
      // Another start for this issue won the race (a person's): it wrote the mapping, so there is nothing to do here.
      if (/already has a live run/.test(message)) { touched.delete(entry.number); continue; }
      // A full channel is not a failure: the issue waits in the queue.
      if (/runs are already live/.test(message)) { capacity = 0; break; }
      entry.reason = message;
      touch(entry);
      ctx.audit("intake_start_failed", { repo, issue: entry.number, error: message });
    }
  }
  for (const entry of queued) {
    if (entry.status !== "queued" || !fresh.has(entry.number)) continue;
    stats.queued++;
    note({ key: `queued:${repo}#${entry.number}`, kind: "queued", repo, issue: entry.number, title: entry.title });
  }

  // ── Write down what changed ───────────────────────────────────────────────────────────────────────────
  const nowAfter = ctx.now();
  await store.mutateFactoryIntake(repo, (d) => {
    for (const number of touched) {
      const mine = work[String(number)];
      if (!mine) continue;
      const current = d.entries[String(number)];
      // A run started for this issue while the poll ran (a person's) wrote the mapping: that wins over a status computed before it.
      if (current && current.status === "open" && current.runId && mine.status !== "open" && mine.status !== "closed") continue;
      d.entries[String(number)] = mine;
    }
    d.since = Math.max(d.since, maxUpdated);
    if (!recheckFailed) d.commentRules = COMMENT_RULES_VERSION;
    // Closed mappings are forgotten after a while; past the cap the oldest finished ones go first. A mapping that is still open never does.
    for (const [key, entry] of Object.entries(d.entries)) if (entry.status === "closed" && nowAfter - entry.closedAt > CLOSED_RETENTION_MS) delete d.entries[key];
    const all = Object.values(d.entries);
    if (all.length > MAX_INTAKE_ENTRIES) {
      const removable = all.filter((e) => e.status === "closed" || e.status === "ignored").sort((a, b) => (a.closedAt || a.firstSeen) - (b.closedAt || b.firstSeen));
      for (const entry of removable.slice(0, all.length - MAX_INTAKE_ENTRIES)) delete d.entries[String(entry.number)];
    }
  });
}
