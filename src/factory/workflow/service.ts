import { scopedFactoryStore } from "./backend.ts";
import { createGitHub, ghRunner } from "./github.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedChannel } from "../../workspace/resolve.ts";
import { availableSkillNames, roleSkillGapMessage, roleSkillGaps } from "../../agent/skills.ts";
import { humanChangesStage, pinnedWorkflow, SOFTWARE_FACTORY_WORKFLOW, softwareFactoryWorkflow, type WorkflowDefinition } from "./definition.ts";
import type { FactoryGitHub } from "./deps.ts";
import { CONSOLE_ACTOR, isTerminalRun, MAX_LIVE_FACTORY_RUNS, UPDATE_EXCERPT_CHARS, type RunUpdate, type FactoryDecisionKind, type FactoryRunData, type FactoryStarter, type RunOrigin } from "./docs.ts";
import { emptyIntakeEntry, type CommentScan, type IntakeEntry, type IntakeRepoData } from "./intake-docs.ts";
import type { IntakeStartRequest } from "./intake.ts";
import { describeAutonomy, effectiveAutonomy } from "./autonomy.ts";
import { canApprove, resolveMergeRules } from "./merge.ts";
import { failedStageProblem } from "./transitions.ts";
import { isLabelMissingError } from "./labels.ts";
import { provenanceFooter, sanitizeIssueBody, sanitizeIssueTitle, titleKey } from "./issue-text.ts";
import { agentFooter } from "./footer.ts";
import { recentlyFiled, rememberFiled, serially } from "./issue-ledger.ts";

/**
 * What the agent's tools do with workflow runs, and the rules that cannot be left to the agent: who may start one, who may
 * approve a merge, and what is written down about it. The engine (task.ts) does the work; this is its front door, the way
 * `JobService` is the jobs'.
 *
 * The user a decision is made as comes from the session (`currentUserId`), never from a tool argument, and the commit an
 * approval is bound to is read from the run, never given. The task re-checks both, so a caller that forgot to would still not
 * get a merge; the check here is so the person is told why, instead of a decision being quietly ignored.
 */

/** The part of the channel's store the service uses. The real one is `DurableChannelStore`. */
export interface FactoryRunStore {
  startFactoryRun(input: {
    definition: WorkflowDefinition; repo: string; issue: number; issueTitle: string; issueUrl: string; workItem?: import("./source.ts").WorkItem; notes?: string; by: FactoryStarter;
    origin?: RunOrigin; trust?: string; mapping?: IntakeStartRequest["mapping"]; updates?: IntakeStartRequest["updates"];
    /** The most runs live at once: `factory.maxLiveRuns`. Absent: `MAX_LIVE_FACTORY_RUNS`. */
    maxLive?: number;
  }): Promise<{ runId: string }>;
  /** Issue intake's mapping, when the store keeps one. */
  factoryIntake?(repo: string): Promise<IntakeRepoData>;
  listFactoryIntake?(): Promise<IntakeRepoData[]>;
  mutateFactoryIntake?(repo: string, change: (data: IntakeRepoData) => void): Promise<void>;
  noteFiledByHarness?(repo: string, issue: number): Promise<void>;
  factoryRun(runId: string): Promise<FactoryRunData | undefined>;
  listFactoryRuns(limit?: number): Promise<FactoryRunData[]>;
  /** Add an answer given in Slack to the run's updates: what a run waiting for information carries on with. */
  addFactoryRunUpdate(runId: string, update: RunUpdate): Promise<void>;
  decideFactoryRun(runId: string, decision: Exclude<FactoryDecisionKind, "">, by: string, head?: string, stage?: string, changes?: { feedback: string; since: number }): Promise<void>;
  /** Carry on a run that ended `failed`, from its failed stage, on the same record. */
  reopenFactoryRun?(runId: string, maxLive?: number): Promise<void>;
  abortFactoryRun(runId: string, reason: string): Promise<"marked" | "terminal">;
}

/** One line in the channel's factory audit file: `shared/audit/factory-runs.jsonl`. Never throws. */
export const factoryAuditFile = (channel: Pick<ResolvedChannel, "shared">): string => join(channel.shared.audit, "factory-runs.jsonl");

export function appendFactoryAudit(channel: Pick<ResolvedChannel, "shared" | "ref">, event: string, fields: Record<string, unknown>, file?: string): void {
  try {
    const target = file ?? factoryAuditFile(channel);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), channelId: channel.ref.id, event, ...fields })}\n`);
  } catch { /* an audit line that cannot be written must not stop a run, but it is not silent in the log */ }
}

export class FactoryRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryRunError";
  }
}

/** The workflow the channel runs: only the shipped one, for now. */
export const channelWorkflow = (channel: Pick<ResolvedChannel, "factory">, repo: string): WorkflowDefinition =>
  softwareFactoryWorkflow({ reviewRounds: effectiveAutonomy(channel.factory, repo).knobs.reviewRounds.value });

/** How many runs may be live in the channel at once. */
export const liveLimit = (channel: Pick<ResolvedChannel, "factory">): number => channel.factory?.maxLiveRuns ?? MAX_LIVE_FACTORY_RUNS;

/**
 * Why this channel cannot run the workflow, or undefined when it can: it is not a software factory, or a sub-agent a required
 * stage needs is not assigned to it. An optional stage (deploy) with no role is skipped, not a problem.
 */
export function workflowProblem(channel: Pick<ResolvedChannel, "factory" | "agents">): string | undefined {
  if (!channel.factory) return "this channel is not a software factory";
  const definition = SOFTWARE_FACTORY_WORKFLOW;
  const missing = definition.stages.filter((stage) => stage.kind === "agent" && !stage.optional && !channel.agents.some((agent) => agent.name === stage.role)).map((stage) => `\`${stage.role}\``);
  return missing.length ? `its team has no ${missing.join(", ")} subagent, which the workflow needs` : undefined;
}

/**
 * A role that needs a person's approval (the deployer) is told to stop when a skill it must follow is missing, and it does, after
 * the change has been built, reviewed and merged. Better to say so before the run starts. Roles without that rule carry on without
 * a missing skill (the stage brief carries what the engine needs from them), and the harness warns about them when it loads the config.
 */
export function approvalRoleSkillProblem(channel: ResolvedChannel): string | undefined {
  if (!channel.agents.some((agent) => agent.requireApproval)) return undefined;
  const gaps = roleSkillGaps(channel, availableSkillNames(channel)).filter((gap) => gap.requireApproval);
  return gaps.length > 0 ? `${roleSkillGapMessage(channel, gaps)} Until then it would stop at that role, after the change is merged.` : undefined;
}

/**
 * An issue named as `owner/repo#7`, `https://github.com/owner/repo/issues/7`, or (when the factory has exactly one repository)
 * `#7` or `7`. Always one of the factory's configured repositories, spelled as configured.
 */
export function parseIssueRef(text: string, repositories: readonly string[]): { repo: string; issue: number } {
  const raw = text.trim();
  const known = (name: string): string | undefined => repositories.find((repo) => repo.toLowerCase() === name.toLowerCase());
  const number = (value: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new FactoryRunError(`"${value}" is not an issue number.`);
    return n;
  };
  let repo: string | undefined;
  let issue: number | undefined;
  const url = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)\/?(?:[?#].*)?$/.exec(raw);
  const short = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(raw);
  const bare = /^#?(\d+)$/.exec(raw);
  if (url) {
    if (url[2] === "pull") throw new FactoryRunError("That is a pull request. A workflow run starts from an issue; name the issue it fixes.");
    repo = known(url[1]!);
    issue = number(url[3]!);
    if (!repo) throw new FactoryRunError(`${url[1]} is not one of this factory's repositories (${repositories.join(", ")}).`);
  } else if (short) {
    repo = known(short[1]!);
    issue = number(short[2]!);
    if (!repo) throw new FactoryRunError(`${short[1]} is not one of this factory's repositories (${repositories.join(", ")}).`);
  } else if (bare) {
    if (repositories.length !== 1) throw new FactoryRunError(`This factory has several repositories (${repositories.join(", ")}); name the issue as owner/repo#${bare[1]}.`);
    repo = repositories[0]!;
    issue = number(bare[1]!);
  } else {
    throw new FactoryRunError(`"${raw.slice(0, 80)}" is not an issue. Use owner/repo#7 or the issue's GitHub URL.`);
  }
  return { repo, issue };
}

/** What filing an issue came to. `existing`: the same request was filed a few minutes ago, so that issue is the answer. */
export interface FiledIssueResult {
  repo: string;
  issue: number;
  url: string;
  title: string;
  existing: boolean;
  /** Set when `startRun` was asked for and the run started. */
  run?: { runId: string; statusPost?: string };
  /** Set when `startRun` was asked for and the run could not start: the issue exists either way. */
  runError?: string;
  /** Intake is on and a poll was asked for: the run starts by itself in a moment. */
  pickedUp?: boolean;
}

/** What `check_factory_intake` tells: each repository's mapping, in counts and short lists. */
export interface IntakeSummary {
  enabled: boolean;
  repos: {
    repo: string;
    /** The autonomy level this repository runs at, in one line. */
    autonomy?: string;
    lastPollAt: number;
    lastError: string;
    counts: Record<string, number>;
    held: { issue: number; title: string; author: string; reason: string }[];
    queued: { issue: number; title: string }[];
    /** What the last read of a mapped issue's comments found, as counts: how a run that seems deaf to an answer can be told from a quiet issue. */
    scans: { issue: number; runId: string; scan: CommentScan }[];
  }[];
}

/** A second request for the same title in this channel within this long is the same request. */
export const ISSUE_DEDUPE_MS = 15 * 60 * 1000;

export interface FactoryRunService {
  /** Why runs cannot be started here, or undefined. */
  problem(): string | undefined;
  /** Whether intake is on for this channel: the workflow can run, and `factory.intake.enabled` is set. */
  intakeEnabled(): boolean;
  /** Whether the channel may file issues: the factory's `issues.create`, on a channel that can run the workflow. */
  issuesEnabled(): boolean;
  /** File a GitHub issue for a request that has none, and (with `startRun`) start a run on it. */
  createIssue(input: { repository?: string; title: string; body: string; startRun?: boolean }): Promise<FiledIssueResult>;
  start(issue: string, notes?: string, options?: { origin?: RunOrigin }): Promise<{ runId: string; repo: string; issue: number; title: string; workItem?: import("./source.ts").WorkItem; statusPost?: string }>;
  /** Start a run for an issue intake found: the same checks as `start`, as the harness itself, with no Slack user behind it. */
  startFromIntake(request: IntakeStartRequest): Promise<{ runId: string }>;
  /** A person says an issue intake held, ignored or has not seen may start. Only the factory's approvers may. */
  releaseIntake(issue: string): Promise<{ repo: string; issue: number; title: string }>;
  /** What intake has mapped, held and queued. */
  checkIntake(): Promise<IntakeSummary>;
  /** The autonomy level this repository runs at, in one line: "balanced · auto-merge at risk ≤2 · assumes after 24h · 4 review rounds". */
  autonomy?(repo: string): string;
  /** One run, or recent runs. In a run's own Slack thread, no id means that run. */
  check(runId?: string): Promise<FactoryRunData[]>;
  /** Every method that takes a run id: in a run's own Slack thread the id may be left out and means that run. */
  approve(runId?: string): Promise<{ head: string }>;
  decline(runId?: string): Promise<void>;
  /** Return the existing PR for revision, answering exactly the merge wait the person saw. */
  requestChanges(runId: string, feedback: string, since: number): Promise<void>;
  moreRounds(runId?: string): Promise<void>;
  /**
   * Answer a run that needs a decision: an interrupted stage (retry, skip, abort) or a failed one (retry, skip an optional stage,
   * restart_from an earlier `stage`, abort). `retry` on a run that already ended `failed` carries it on from the stage it failed at.
   */
  decide(runId: string | undefined, decision: "retry" | "skip" | "restart_from" | "abort", stage?: string): Promise<void>;
  /**
   * A person answers the question a run waiting for information is stuck on, in its Slack thread. The answer goes on the issue as a
   * comment with the agent footer, and the run carries on with it. Only people who may decide for the factory may.
   */
  answer(runId: string | undefined, answer: string): Promise<{ commented: boolean }>;
  /**
   * Read the run's issue comments again from where the run began and tell the run what is new: for a run that is stuck waiting on an
   * answer already given on GitHub. Only the factory's approvers may; it changes nothing on GitHub, and what the run already has is
   * not told twice.
   */
  recheckIssue(runId?: string): Promise<{ repo: string; issue: number }>;
  abort(runId?: string): Promise<void>;
}

export interface FactoryRunServiceContext {
  channel: ResolvedChannel;
  /** Resolved when used: the store does not exist until after the tools are built. Absent fails closed. */
  store: () => FactoryRunStore | undefined;
  /** How an issue is read, with the channel's own credentials. Absent fails closed. */
  github: () => Pick<FactoryGitHub, "readIssue" | "createIssue" | "commentIssue" | "tracker"> | undefined;
  threadKey: string;
  currentUserId: () => string;
  /**
   * Make sure the run's status post exists in Slack, and say where it is. Best effort: a run does not depend on it. Absent when
   * the process is not wired to Slack.
   */
  announce?: (runId: string) => Promise<{ permalink?: string } | undefined>;
  /** Intake for this channel: whether it is on, and a way to ask for a poll now. Absent when the process is not wired to poll. */
  intake?: { kick(): void };
  /** Make sure the factory's labels exist in a repository, once more. Used when filing an issue fails on a label that is not there. */
  labels?: { ensure(repo: string): Promise<void> };
  source?: "agent" | "operator";
  /**
   * Set when the web console is the one asking: a person at the operator's own console, not someone speaking in Slack. It may start
   * a run and answer a stuck one (retry, skip, restart from a stage, abort, read the issue again, answer a question); it may not
   * allow rounds, deploy consent or release an issue. Merge decisions need run-scoped Slack verification, checked again here.
   */
  actor?: { kind: "console"; remote: string; mergeIdentity?: import("./console-approvals.ts").ConsoleMergeIdentity };
  /** Where the record of who started, decided and aborted what goes. Defaults to the shared audit directory. */
  auditFile?: string;
}

export function createFactoryRunService(ctx: FactoryRunServiceContext): FactoryRunService {
  const { channel } = ctx;
  const store = (): FactoryRunStore => {
    const found = ctx.store();
    if (!found) throw new FactoryRunError("Workflow runs are not available in this session.");
    return scopedFactoryStore(found, channel.factory);
  };
  const audit = (event: string, fields: Record<string, unknown>) =>
    appendFactoryAudit(channel, event, { threadKey: ctx.threadKey, userId: ctx.currentUserId(), ...(ctx.actor ? { actor: ctx.actor.kind, remote: ctx.actor.remote } : {}), ...fields }, ctx.auditFile);
  /** Consent that stays in Slack even for a verified browser: deploy, additional rounds, intake release and issue filing. */
  const notForConsole = (what: string): void => {
    if (ctx.actor) throw new FactoryRunError(`The web console cannot ${what}: that stays with the factory's approvers in Slack.`);
  };
  /** The run whose status post this thread is, if it is one: what "this run" means to someone talking in that thread. */
  const boundRun = async (): Promise<FactoryRunData | undefined> => {
    if (!ctx.threadKey) return undefined;
    return (await store().listFactoryRuns(50)).find((run) => run.slack.ts !== "" && run.slack.ts === ctx.threadKey);
  };
  const requireRun = async (runId: string | undefined): Promise<FactoryRunData> => {
    if (!runId) {
      const bound = await boundRun();
      if (!bound) throw new FactoryRunError("Name the run (check_factory_run lists them): this conversation is not a run's status thread.");
      return bound;
    }
    const run = await store().factoryRun(runId);
    if (!run) throw new FactoryRunError(`There is no workflow run ${runId}.`);
    return run;
  };
  /** Only the people who may decide this run's merge. The same rule the task applies; here so the person is told. */
  const requireApprover = (run: FactoryRunData): string => {
    // The console is the operator's own page, reached only by people who can reach it: it answers as itself, not as a Slack user.
    if (ctx.actor) return CONSOLE_ACTOR;
    const user = ctx.currentUserId();
    if (!canApprove(user, resolveMergeRules(channel.factory, run.repo), channel.allowUsers)) {
      throw new FactoryRunError(`${user ? `<@${user}>` : "This speaker"} is not one of the people who may approve or decline runs for ${run.repo}. Say so plainly, and name who can (the factory's approvers).`);
    }
    return user;
  };
  const requireMergeIdentity = (run: FactoryRunData): string => {
    if (!ctx.actor) return requireApprover(run);
    const identity = ctx.actor.mergeIdentity;
    if (!identity || run.status !== "waiting" || run.wait.kind !== "merge" || identity.runId !== run.runId || identity.head !== run.pr.reviewedHead || identity.since !== run.wait.since
      || !canApprove(identity.userId, resolveMergeRules(channel.factory, run.repo), channel.allowUsers)) {
      throw new FactoryRunError("The web console cannot decide this merge without current, run-scoped Slack approver verification.");
    }
    return identity.userId;
  };
  const waitingOn = (run: FactoryRunData, kinds: string[], what: string): void => {
    if (isTerminalRun(run.status)) throw new FactoryRunError(`Run ${run.runId} has already finished (${run.status}).`);
    if (!kinds.includes(run.wait.kind)) {
      throw new FactoryRunError(`Run ${run.runId} is ${run.status.replace("_", " ")}${run.wait.kind ? ` (waiting on ${run.wait.kind})` : ""}, not waiting for ${what}.`);
    }
  };
  /** The refusals the store gives for an issue that is already running, a full channel or a channel in recovery, in the model's words. */
  const explainStart = (error: unknown): never => {
    if (error instanceof Error && /already has a live run|workflow runs are already live|not valid|not available in this channel/.test(error.message)) throw new FactoryRunError(error.message);
    throw error;
  };

  const parseRef = async (text: string): Promise<{ repo: string; issue: number }> => {
    const factory = channel.factory!;
    if (factory.intake?.source !== "jira") return parseIssueRef(text, factory.repositories);
    const repo = factory.repositories[0]!;
    const tracker = ctx.github()?.tracker;
    if (!tracker?.resolve) throw new FactoryRunError("Jira tracker is unavailable");
    return { repo, issue: await tracker.resolve(repo, text.trim()) };
  };
  const backendForRun = (run: FactoryRunData) => {
    if (run.workItem && (channel.factory?.intake?.source !== "jira" || channel.factory.jira?.site !== run.workItem.site)) throw new FactoryRunError("Restore this run’s original Jira tracker/site before updating its ticket.");
    if (!run.workItem && channel.factory?.intake?.source === "jira") return createGitHub(ghRunner(channel.env));
    return ctx.github();
  };
  const issueSettings = () => ({ labels: channel.factory?.issues?.labels ?? ["status:triage"], maxPerHour: channel.factory?.issues?.maxPerHour ?? 10 });
  const auditPath = (): string => ctx.auditFile ?? factoryAuditFile(channel);

  const service: FactoryRunService = {
    problem: () => workflowProblem(channel),

    intakeEnabled: () => channel.factory?.intake?.enabled === true && workflowProblem(channel) === undefined,

    issuesEnabled: () => channel.factory?.issues?.create === true && workflowProblem(channel) === undefined,

    async createIssue(input) {
      notForConsole("file issues");
      const refuse = (reason: string, fields: Record<string, unknown> = {}): never => {
        audit("issue_refused", { reason, ...fields });
        throw new FactoryRunError(reason);
      };
      const problem = workflowProblem(channel);
      if (problem) throw new FactoryRunError(`Issues cannot be filed here: ${problem}.`);
      if (channel.factory?.issues?.create !== true) throw new FactoryRunError("This factory is not set up to file issues (`factory.issues.create` is off). Say so, and ask the person to file the issue themselves, then start a run on it.");
      const factory = channel.factory!;
      let repo: string | undefined;
      if (input.repository?.trim()) {
        repo = factory.repositories.find((name) => name.toLowerCase() === input.repository!.trim().toLowerCase());
        if (!repo) throw new FactoryRunError(`${input.repository.trim().slice(0, 80)} is not one of this factory's repositories (${factory.repositories.join(", ")}).`);
      } else if (factory.repositories.length === 1) {
        repo = factory.repositories[0]!;
      } else {
        throw new FactoryRunError(`This factory has several repositories (${factory.repositories.join(", ")}); say which one the issue belongs in.`);
      }
      const title = sanitizeIssueTitle(input.title);
      if (!title) throw new FactoryRunError("An issue needs a title.");
      const text = sanitizeIssueBody(input.body);
      if (!text) throw new FactoryRunError("An issue needs a description: what is wanted, and how someone will know it is done.");
      const github = ctx.github();
      if (!github) throw new FactoryRunError("Issues cannot be filed in this session.");
      const settings = issueSettings();

      const filed = await serially(channel.ref.id, async () => {
        const now = Date.now();
        const recent = recentlyFiled(channel.ref.id, auditPath(), now);
        const key = titleKey(title);
        // The same request asked twice (a retried message, two people pasting the same ticket): the first issue is the answer, if it is still open.
        const twin = [...recent].reverse().find((entry) => entry.repo === repo && entry.titleKey === key && now - entry.at <= ISSUE_DEDUPE_MS);
        if (twin) {
          let facts;
          try { facts = await github.readIssue(repo!, twin.issue); } catch { facts = undefined; }
          if (facts?.state === "open") return { repo: repo!, issue: twin.issue, url: twin.url, title: facts.title, existing: true };
        }
        if (recent.length >= settings.maxPerHour) {
          return refuse(`${recent.length} issues have been filed from this channel in the last hour (${settings.maxPerHour} at most). Wait, or ask a person to file this one.`, { repo, limit: settings.maxPerHour });
        }
        const body = `${text}${provenanceFooter()}`;
        let created;
        try {
          try {
            created = await github.createIssue({ repo: repo!, title, body, labels: settings.labels });
          } catch (error) {
            // A label that is not there yet: make the factory's labels exist, then try once more. Anything else fails as it did.
            if (!ctx.labels || !isLabelMissingError(error instanceof Error ? error.message : String(error))) throw error;
            await ctx.labels.ensure(repo!);
            created = await github.createIssue({ repo: repo!, title, body, labels: settings.labels });
          }
        } catch (error) {
          const first = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
          audit("issue_failed", { repo, error: first });
          throw new FactoryRunError(`GitHub did not create the issue: ${first}${isLabelMissingError(first) ? " (a label in `factory.issues.labels` is missing and the harness could not create it: the channel's GitHub token needs permission to create labels)" : ""}`);
        }
        const entry = { at: Date.now(), repo: repo!, issue: created.number, url: created.url, titleKey: key };
        rememberFiled(channel.ref.id, entry);
        // Recorded in the channel's store as well: intake starts a harness-filed issue by itself only with this proof, not on its footer alone.
        try { await ctx.store()?.noteFiledByHarness?.(repo!, created.number); } catch (error) { audit("issue_note_failed", { repo, issue: created.number, error: String(error).slice(0, 200) }); }
        audit("issue_created", { repo, issue: created.number, url: created.url, title, titleKey: key, labels: settings.labels, startRun: input.startRun === true });
        return { repo: repo!, issue: created.number, url: created.url, title, existing: false };
      });

      const result: FiledIssueResult = { ...filed };
      if (input.startRun) {
        try {
          const run = await service.start(`${filed.repo}#${filed.issue}`, undefined, { origin: "slack" });
          result.run = { runId: run.runId, ...(run.statusPost ? { statusPost: run.statusPost } : {}) };
        } catch (error) {
          // The issue exists whether or not a run could start on it: say both.
          result.runError = error instanceof FactoryRunError ? error.message : "The run could not be started.";
        }
      } else if (factory.intake?.enabled && ctx.intake) {
        // The tracker is the source of truth: the issue exists, so intake picks it up. Ask for a poll now rather than waiting for the next one.
        result.pickedUp = true;
        try { ctx.intake.kick(); } catch { /* the next poll finds it */ }
      }
      return result;
    },

    async startFromIntake(request) {
      const problem = workflowProblem(channel);
      if (problem) throw new FactoryRunError(`Workflow runs are not available here: ${problem}.`);
      const skills = approvalRoleSkillProblem(channel);
      if (skills) throw new FactoryRunError(`Workflow runs are not available here: ${skills}`);
      const factory = channel.factory!;
      if (!factory.repositories.some((repo) => repo.toLowerCase() === request.repo.toLowerCase())) throw new FactoryRunError(`${request.repo} is not one of this factory's repositories.`);
      if (factory.intake?.source === "jira") {
        const facts = await ctx.github()?.readIssue(request.repo, request.issue);
        if (!facts?.workItem || !facts.selection?.eligible || facts.workItem.site !== request.workItem?.site) throw new FactoryRunError("Jira eligibility changed before dispatch; run not started");
      }
      const live = (await store().listFactoryRuns(50)).filter((run) => !isTerminalRun(run.status));
      const other = live.find((run) => run.repo.toLowerCase() === request.repo.toLowerCase() && run.issue === request.issue && run.workItem?.site === request.workItem?.site);
      if (other) throw new FactoryRunError(`${request.repo}#${request.issue} already has a live run (${other.runId}).`);
      if (live.length >= liveLimit(channel)) throw new FactoryRunError(`${live.length} workflow runs are already live in this channel (${liveLimit(channel)} at most).`);
      let runId: string;
      try {
        ({ runId } = await store().startFactoryRun({
          definition: channelWorkflow(channel, request.repo), repo: request.repo, issue: request.issue, issueTitle: request.title, issueUrl: request.url, ...(request.workItem ? { workItem: request.workItem } : {}),
          by: { source: "intake", threadKey: "", userId: "" }, origin: "intake", trust: request.trust, mapping: request.mapping, updates: request.updates, maxLive: liveLimit(channel),
        }));
      } catch (error) {
        return explainStart(error);
      }
      appendFactoryAudit(channel, "start", { runId, repo: request.repo, issue: request.issue, workflow: SOFTWARE_FACTORY_WORKFLOW.name, origin: "intake", trust: request.trust, reopened: request.reopened }, ctx.auditFile);
      return { runId };
    },

    async releaseIntake(issueText) {
      notForConsole("release held issues");
      const factory = channel.factory;
      if (!factory) throw new FactoryRunError("This channel is not a software factory.");
      const { repo, issue } = await parseRef(issueText);
      const user = ctx.currentUserId();
      if (!canApprove(user, resolveMergeRules(factory, repo), channel.allowUsers)) {
        throw new FactoryRunError(`${user ? `<@${user}>` : "This speaker"} is not one of the people who may release issues for ${repo}. Say so plainly, and name who can (the factory's approvers).`);
      }
      const s = store();
      if (!s.mutateFactoryIntake || !s.factoryIntake) throw new FactoryRunError("Issue intake is not available in this session.");
      const mapped = (await s.factoryIntake(repo)).entries[String(issue)];
      if (mapped?.status === "open" && mapped.runId) throw new FactoryRunError(`${repo}#${issue} already has a run (${mapped.runId}).`);
      const github = ctx.github();
      let facts;
      try { facts = await github?.readIssue(repo, issue); } catch (error) { throw new FactoryRunError(`Could not read ${repo}#${issue} from GitHub: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
      if (!facts) throw new FactoryRunError(`${repo} has no issue #${issue}.`);
      if (facts.state !== "open") throw new FactoryRunError(`${repo}#${issue} is closed.`);
      // Queued and released: the next poll starts it (oldest first, under the limits), whatever its author is.
      await s.mutateFactoryIntake(repo, (data) => {
        const entry: IntakeEntry = data.entries[String(issue)] ?? { ...emptyIntakeEntry(issue), firstSeen: Date.now() };
        data.entries[String(issue)] = { ...entry, ...(facts.workItem ? { workItem: facts.workItem } : {}), title: facts.title.slice(0, 200), url: facts.url, status: "queued", released: true, reason: `released by ${user || "a person"}` };
      });
      audit("intake_release", { repo, issue });
      try { ctx.intake?.kick(); } catch { /* the next poll finds it */ }
      return { repo, issue, title: facts.title };
    },

    async checkIntake() {
      const s = store();
      const all = (await s.listFactoryIntake?.()) ?? [];
      return {
        enabled: channel.factory?.intake?.enabled === true,
        repos: all.map((data) => {
          const entries = Object.values(data.entries);
          const counts: Record<string, number> = {};
          for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
          return {
            repo: data.repo, autonomy: describeAutonomy(effectiveAutonomy(channel.factory, data.repo)), lastPollAt: data.lastPollAt, lastError: data.lastError, counts,
            held: entries.filter((e) => e.status === "held").slice(0, 20).map((e) => ({ issue: e.number, ...(e.workItem ? { key: e.workItem.key, url: e.workItem.url } : {}), title: e.title, author: e.author, reason: e.reason })),
            queued: entries.filter((e) => e.status === "queued").slice(0, 20).map((e) => ({ issue: e.number, ...(e.workItem ? { key: e.workItem.key, url: e.workItem.url } : {}), title: e.title })),
            scans: entries.filter((e) => e.status === "open" && e.lastScan).slice(0, 20).map((e) => ({ issue: e.number, runId: e.runId, scan: e.lastScan! })),
          };
        }),
      };
    },

    async start(issueText, notes, options) {
      const problem = workflowProblem(channel);
      if (problem) throw new FactoryRunError(`Workflow runs are not available here: ${problem}.`);
      const skills = approvalRoleSkillProblem(channel);
      if (skills) throw new FactoryRunError(`Workflow runs are not available here: ${skills}`);
      const factory = channel.factory!;
      const { repo, issue } = await parseRef(issueText);
      const github = ctx.github();
      if (!github) throw new FactoryRunError("Workflow runs are not available in this session.");
      let facts;
      try {
        facts = await github.readIssue(repo, issue);
      } catch (error) {
        throw new FactoryRunError(`Could not read ${repo}#${issue} from GitHub: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
      if (!facts) throw new FactoryRunError(`${repo} has no issue #${issue}.`);
      if (facts.state !== "open") throw new FactoryRunError(`${repo}#${issue} is closed. A run works an open issue; reopen it first if it should be worked again.`);
      if (facts.workItem && !facts.selection?.eligible) throw new FactoryRunError(facts.selection?.reason || "Jira ticket is not eligible");
      // Said before the store is asked, so the person gets the plain answer; the store enforces the same limits atomically.
      const live = (await store().listFactoryRuns(50)).filter((run) => !isTerminalRun(run.status));
      const other = live.find((run) => run.repo.toLowerCase() === repo.toLowerCase() && run.issue === issue && run.workItem?.site === facts.workItem?.site);
      if (other) throw new FactoryRunError(`${repo}#${issue} already has a live run (${other.runId}, ${other.status.replace("_", " ")}). Check it, or abort it first.`);
      if (live.length >= liveLimit(channel)) throw new FactoryRunError(`${live.length} workflow runs are already live in this channel (${liveLimit(channel)} at most, a run waiting for a person counts); wait for one to finish. Abort one that is only waiting, or raise factory.maxLiveRuns.`);
      const by: FactoryStarter = { source: ctx.source ?? "agent", threadKey: ctx.threadKey, userId: ctx.currentUserId() };
      let runId: string;
      try {
        ({ runId } = await store().startFactoryRun({
          definition: channelWorkflow(channel, repo), repo, issue, issueTitle: facts.title, issueUrl: facts.url, ...(facts.workItem ? { workItem: facts.workItem } : {}), ...(notes?.trim() ? { notes: notes.trim() } : {}), by,
          origin: options?.origin ?? "manual", trust: "manual", maxLive: liveLimit(channel),
          // Registers the issue's mapping, so the poller sends its changes to this run instead of starting another.
          mapping: { lastUpdatedAt: Date.now(), commentWatermark: Date.now(), comments: -1 },
        }));
      } catch (error) {
        return explainStart(error);
      }
      audit("start", { runId, repo, issue, workflow: SOFTWARE_FACTORY_WORKFLOW.name, notes: Boolean(notes?.trim()), origin: options?.origin ?? "manual" });
      let statusPost: string | undefined;
      try { statusPost = (await ctx.announce?.(runId))?.permalink; } catch { /* the status post is a courtesy: the run is started either way */ }
      return { runId, repo, issue, title: facts.title, ...(facts.workItem ? { workItem: facts.workItem } : {}), ...(statusPost ? { statusPost } : {}) };
    },

    autonomy: (repo) => describeAutonomy(effectiveAutonomy(channel.factory, repo)),

    async check(runId) {
      if (runId) return [await requireRun(runId)];
      const bound = await boundRun();
      return bound ? [bound] : store().listFactoryRuns(10);
    },

    async approve(runId) {
      const run = await requireRun(runId);
      waitingOn(run, ["merge", "deploy"], "an approval");
      const user = requireMergeIdentity(run);
      // The commit the person is approving is the one the reviewer looked at, as the run records it. Never taken from the caller.
      const head = run.pr.reviewedHead;
      await store().decideFactoryRun(run.runId, "approve", user, head);
      audit("approve", { runId: run.runId, repo: run.repo, issue: run.issue, wait: run.wait.kind, head, risk: { model: run.risk.model, final: run.risk.final, floors: run.risk.floors } });
      return { head };
    },

    async decline(runId) {
      const run = await requireRun(runId);
      waitingOn(run, ["merge", "deploy", "rounds"], "a decision to decline or stop");
      const user = requireMergeIdentity(run);
      // Declining a loop that is out of rounds is stopping it.
      const decision = run.wait.kind === "rounds" ? "stop" : "decline";
      await store().decideFactoryRun(run.runId, decision, user);
      audit(decision, { runId: run.runId, repo: run.repo, issue: run.issue, wait: run.wait.kind });
    },

    async requestChanges(runId, raw, since) {
      notForConsole("request changes");
      const run = await requireRun(runId);
      waitingOn(run, ["merge"], "human review feedback");
      const user = requireApprover(run);
      if (run.status !== "waiting" || run.wait.since !== since) throw new FactoryRunError("That merge approval is no longer waiting for feedback.");
      const definition = pinnedWorkflow(run);
      const merge = definition?.stages.find((stage) => stage.name === run.current && stage.kind === "gate");
      if (!definition || !merge || !humanChangesStage(definition, merge)) throw new FactoryRunError("This pinned workflow does not support requesting changes.");
      const feedback = raw.trim();
      if (!feedback || feedback.length > 3000) throw new FactoryRunError("Supply actionable feedback (1–3000 characters).");
      await store().decideFactoryRun(run.runId, "request_changes", user, run.pr.reviewedHead, "", { feedback, since });
      audit("request_changes", { runId: run.runId, repo: run.repo, issue: run.issue, head: run.pr.reviewedHead, since, chars: feedback.length });
    },

    async moreRounds(runId) {
      notForConsole("allow more review rounds");
      const run = await requireRun(runId);
      waitingOn(run, ["rounds"], "more rounds");
      const user = requireApprover(run);
      await store().decideFactoryRun(run.runId, "more_rounds", user);
      audit("more_rounds", { runId: run.runId, repo: run.repo, issue: run.issue, stage: run.guard.from });
    },

    async answer(runId, raw) {
      const run = await requireRun(runId);
      waitingOn(run, ["info"], "an answer");
      const user = requireApprover(run);
      const text = sanitizeIssueBody(raw);
      if (!text) throw new FactoryRunError("There is no answer to record. Put what the person decided in the answer.");
      const github = backendForRun(run);
      if (!github) throw new FactoryRunError("Answers cannot be recorded in this session.");
      // On the issue first, so what the run goes on from is written where everyone can read it; the run only carries on if that worked.
      const where = ctx.actor ? "Answered in the harness's web console by a person with access to it" : "Answered in Slack by a person allowed to decide for this factory";
      const body = `${where}. The run carries on with this:\n\n${text}\n\n${agentFooter({ role: "factory", stage: run.current, runId: run.runId })}`;
      try {
        await github.commentIssue({ repo: run.repo, number: run.issue, body });
      } catch (error) {
        const first = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
        audit("answer_failed", { runId: run.runId, repo: run.repo, issue: run.issue, error: first });
        throw new FactoryRunError(`GitHub did not take the comment, so the run was not told: ${first}`);
      }
      await store().addFactoryRunUpdate(run.runId, {
        kind: ctx.actor ? "console" : "slack", author: ctx.actor ? "console" : `slack:${user}`, association: "", trusted: true,
        excerpt: text.length > UPDATE_EXCERPT_CHARS ? `${text.slice(0, UPDATE_EXCERPT_CHARS - 1)}…` : text, at: Date.now(),
      });
      audit("answer", { runId: run.runId, repo: run.repo, issue: run.issue, chars: text.length });
      return { commented: true };
    },

    async recheckIssue(runId) {
      const run = await requireRun(runId);
      if (isTerminalRun(run.status)) throw new FactoryRunError(`Run ${run.runId} has already finished (${run.status}).`);
      requireApprover(run);
      if (channel.factory?.intake?.enabled !== true || !ctx.intake) throw new FactoryRunError("Issue intake is not on for this channel, so nothing reads the issue's comments. Turn on `factory.intake.enabled`.");
      const s = run.workItem ? store() : ctx.store()!;
      if (!s.mutateFactoryIntake || !s.factoryIntake) throw new FactoryRunError("Issue intake is not available in this session.");
      const entry = (await s.factoryIntake(run.repo)).entries[String(run.issue)];
      if (!entry || entry.status !== "open" || entry.runId !== run.runId) throw new FactoryRunError(`Intake does not have ${run.repo}#${run.issue} mapped to run ${run.runId}, so there is nothing to read again.`);
      await s.mutateFactoryIntake(run.repo, (data) => { const e = data.entries[String(run.issue)]; if (e && e.runId === run.runId) e.recheck = true; });
      audit("intake_recheck_requested", { runId: run.runId, repo: run.repo, issue: run.issue });
      try { ctx.intake.kick(); } catch { /* the next poll does it */ }
      return { repo: run.repo, issue: run.issue };
    },

    async decide(runId, decision, stage) {
      const run = await requireRun(runId);
      const target = (stage ?? "").trim().toLowerCase();
      if (run.trackerPending && decision !== "retry" && decision !== "abort") throw new FactoryRunError("Jira synchronization must be retried or aborted, never skipped or restarted from an earlier stage.");
      // A run that ended failed (before a failed stage waited for a person, or for something that cannot be recovered) is carried on by retry.
      if (run.status === "failed") {
        if (decision !== "retry") throw new FactoryRunError(`Run ${run.runId} ended failed (${run.reason || "no reason recorded"}). Only "retry" carries it on, from the stage it failed at: it cannot be skipped or restarted from here. To go back further, retry it and answer when it stops again, or start the issue again.`);
        const user = requireApprover(run);
        const github = backendForRun(run);
        let facts;
        try { facts = await github?.readIssue(run.repo, run.issue); } catch (error) { throw new FactoryRunError(`Could not read ${run.repo}#${run.issue} from GitHub: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
        if (!facts) throw new FactoryRunError(`${run.repo} has no issue #${run.issue}.`);
        if (facts.state !== "open") throw new FactoryRunError(`${run.repo}#${run.issue} is closed, so its run is not carried on. Reopen the issue first if it should be worked again.`);
        const reopen = store().reopenFactoryRun?.bind(store());
        if (!reopen) throw new FactoryRunError("Runs cannot be carried on in this session.");
        try { await reopen(run.runId, liveLimit(channel)); } catch (error) { return explainStart(error); }
        audit("reopen", { runId: run.runId, repo: run.repo, issue: run.issue, stage: run.current, by: user });
        return;
      }
      waitingOn(run, ["decide", "failed"], "a decision about a stage that was interrupted or failed");
      const user = requireApprover(run);
      if (run.wait.kind === "decide" && decision === "restart_from") {
        throw new FactoryRunError(`Run ${run.runId} has a stage that was interrupted by a restart: retry it, skip it or abort. Going back to an earlier stage is for a stage that failed.`);
      }
      if (run.wait.kind === "failed") {
        const definition = pinnedWorkflow(run);
        const problem = definition ? failedStageProblem(definition, run.current, decision, target) : "the run's workflow is unreadable";
        if (problem) throw new FactoryRunError(`Run ${run.runId}: ${problem}.`);
      }
      await store().decideFactoryRun(run.runId, decision, user, "", decision === "restart_from" ? target : "");
      audit("decide", { runId: run.runId, repo: run.repo, issue: run.issue, stage: run.current, wait: run.wait.kind, decision, ...(decision === "restart_from" ? { restartFrom: target } : {}) });
    },

    async abort(runId) {
      const run = await requireRun(runId);
      if (isTerminalRun(run.status)) throw new FactoryRunError(`Run ${run.runId} has already finished (${run.status}).`);
      const user = requireApprover(run);
      const outcome = await store().abortFactoryRun(run.runId, `aborted by ${user}`);
      if (outcome === "terminal") throw new FactoryRunError(`Run ${run.runId} has already finished.`);
      audit("abort", { runId: run.runId, repo: run.repo, issue: run.issue, stage: run.current });
    },
  };
  return service;
}
