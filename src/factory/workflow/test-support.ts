import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { parse } from "yaml";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { HarnessConfigSchema, type FactoryMergeRules } from "../../config/schema.ts";
import { REPO_ROOT } from "../../config/load.ts";
import { ChannelRegistry } from "../../workspace/registry.ts";
import { resolveChannel, type ResolvedChannel } from "../../workspace/resolve.ts";
import { ChannelRuntimes, type ChannelRuntime } from "../../agent/channel-runtime.ts";
import { isSubagentRunKey } from "../../agent/durable/channel-store.ts";
import { recoverChannel, type RecoveryOutcome } from "../../agent/recovery.ts";
import { buildThreadToolSet, runtimeTemplate, type CreateThreadSessionOptions, type ThreadToolSet } from "../../agent/session.ts";
import { headlessParent } from "../../agent/subagent-task.ts";
import { ChannelTimelineLog } from "../../agent/timeline.ts";
import { SOFTWARE_FACTORY_WORKFLOW, type WorkflowDefinition } from "./definition.ts";
import type { FactoryGitHub, IssueFacts } from "./deps.ts";
import type { FactoryLabels } from "./labels.ts";
import type { FactoryRunData, FactoryRunStatus } from "./docs.ts";
import type { ChecksFacts, PrFacts } from "./merge.ts";
import type { IssueSource, SourceComment, SourceIssue } from "./source.ts";

/**
 * A channel with the shipped software factory roles on a scripted model, a store opened the way a session opens it, and a fake
 * GitHub. Nothing here is the network: a workflow run is exercised end to end against the real durable store.
 */

export const REPO = "acme/app";
export const HEAD = "aaaaaaa1111111111111111111111111111111aa";

/** A fake of the factory's labels on GitHub: which exist, what was created, and what goes wrong. */
export class FakeLabels implements FactoryLabels {
  existing = new Set<string>();
  /** What was created, in order, as GitHub was asked: name, colour and description. */
  made: { repo: string; name: string; color: string; description: string }[] = [];
  listCalls = 0;
  listError: string | undefined;
  /** Names whose creation reports that someone else made them a moment ago. */
  raced = new Set<string>();
  createError: string | undefined;
  async list(): Promise<string[]> {
    this.listCalls++;
    if (this.listError) throw new Error(this.listError);
    return [...this.existing];
  }
  async create(repo: string, label: { name: string; color: string; description: string }): Promise<"created" | "exists"> {
    if (this.createError) throw new Error(this.createError);
    if (this.raced.has(label.name)) { this.existing.add(label.name); return "exists"; }
    this.made.push({ repo, ...label });
    this.existing.add(label.name);
    return "created";
  }
}

/** A fake GitHub the test steers: what the pull request looks like, and when someone merges it by hand. */
export class FakeGitHub implements FactoryGitHub {
  pr: PrFacts = { state: "open", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: HEAD, changedFiles: ["src/login.ts"], additions: 12, deletions: 3 };
  checks: ChecksFacts = { required: 1, failing: 0, pending: 0 };
  merges: { repo: string; number: number; method: string; expectedHead: string }[] = [];
  mergeError: string | undefined;
  checksError: string | undefined;
  /** Make reading the pull request fail (GitHub unreachable, no token). */
  readPrError: string | undefined;
  private waiters: { signal: AbortSignal; resolve: (facts: PrFacts) => void; reject: (error: Error) => void }[] = [];

  /** Issues the repository has, by number. Tests add to it; #7 is open by default. */
  issues = new Map<number, IssueFacts>([[7, { number: 7, title: "Login fails on an empty password", url: `https://github.com/${REPO}/issues/7`, state: "open" }]]);
  async readIssue(_repo: string, number: number): Promise<IssueFacts | undefined> { const issue = this.issues.get(number); return issue && { ...issue }; }
  /** What was filed, in order. Numbers continue from the highest the repository has. */
  created: { repo: string; title: string; body: string; labels: readonly string[] }[] = [];
  createError: string | undefined;
  /** Failures for the next calls to `createIssue`, one each, before any call succeeds. */
  createErrors: string[] = [];
  /** The factory's labels, steered by the test. */
  labels = new FakeLabels();
  async createIssue(input: { repo: string; title: string; body: string; labels: readonly string[] }): Promise<IssueFacts> {
    const once = this.createErrors.shift();
    if (once) throw new Error(once);
    if (this.createError) throw new Error(this.createError);
    this.created.push({ ...input, labels: [...input.labels] });
    const number = Math.max(0, ...this.issues.keys()) + 1;
    const issue: IssueFacts = { number, title: input.title, url: `https://github.com/${input.repo}/issues/${number}`, state: "open" };
    this.issues.set(number, issue);
    return { ...issue };
  }
  /** What was commented on issues, in order. */
  comments: { repo: string; number: number; body: string }[] = [];
  commentError: string | undefined;
  async commentIssue(input: { repo: string; number: number; body: string }): Promise<void> {
    if (this.commentError) throw new Error(this.commentError);
    this.comments.push({ ...input });
  }
  /** The issues side of intake, steered by the test (see FakeSource). */
  source: IssueSource = new FakeSource();
  async readPr(): Promise<PrFacts> {
    if (this.readPrError) throw new Error(this.readPrError);
    return { ...this.pr, changedFiles: [...this.pr.changedFiles] };
  }
  async readChecks(): Promise<ChecksFacts> {
    if (this.checksError) throw new Error(this.checksError);
    return { ...this.checks };
  }
  async mergePr(input: { repo: string; number: number; method: "squash" | "merge" | "rebase"; expectedHead: string }) {
    if (this.mergeError) throw new Error(this.mergeError);
    this.merges.push(input);
    this.pr = { ...this.pr, state: "merged", mergeCommit: "bbbbbbb2222222222222222222222222222222bb" };
    return { mergeCommit: "bbbbbbb2222222222222222222222222222222bb" };
  }
  untilSettled(input: { signal: AbortSignal }): Promise<PrFacts> {
    return new Promise<PrFacts>((resolve, reject) => {
      this.waiters.push({ signal: input.signal, resolve, reject });
      input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  /** Someone merges or closes the pull request on GitHub. */
  settle(state: "merged" | "closed"): void {
    this.pr = { ...this.pr, state, ...(state === "merged" ? { mergeCommit: "ccccccc3333333333333333333333333333333cc" } : {}) };
    for (const waiter of this.waiters.splice(0)) if (!waiter.signal.aborted) waiter.resolve(this.pr);
  }
}

/** A fake tracker: the issues and comments a poll sees, and how many calls it made. */
export class FakeSource implements IssueSource {
  login = "harness-bot";
  issues = new Map<number, SourceIssue>();
  comments_ = new Map<number, SourceComment[]>();
  calls = { list: 0, issue: 0, comments: 0 };
  listError: string | undefined;
  async selfLogin(): Promise<string> { return this.login; }
  async changedSince(repo: string, since: number, page: number): Promise<{ issues: SourceIssue[]; full: boolean }> {
    this.calls.list++;
    if (this.listError) throw new Error(this.listError);
    const all = [...this.issues.values()].filter((issue) => issue.repo === repo && issue.updatedAt >= since).sort((a, b) => a.updatedAt - b.updatedAt);
    const pageSize = 100;
    return { issues: all.slice((page - 1) * pageSize, page * pageSize).map((issue) => ({ ...issue })), full: all.length > page * pageSize };
  }
  async issue(repo: string, number: number): Promise<SourceIssue | undefined> {
    this.calls.issue++;
    const found = this.issues.get(number);
    return found && found.repo === repo ? { ...found } : undefined;
  }
  async comments(_repo: string, number: number, since: number): Promise<SourceComment[]> {
    this.calls.comments++;
    return (this.comments_.get(number) ?? []).filter((comment) => comment.updatedAt >= since).map((comment) => ({ ...comment }));
  }
  /** Add or change an issue. `at` is the time of the change. */
  put(number: number, fields: Partial<SourceIssue> & { at?: number } = {}): SourceIssue {
    const at = fields.at ?? Date.now();
    const before = this.issues.get(number);
    const issue: SourceIssue = {
      repo: REPO, number, title: `Issue ${number}`, body: `Body of issue ${number}`, url: `https://github.com/${REPO}/issues/${number}`, author: "maintainer", association: "MEMBER",
      state: "open", locked: false, isPullRequest: false, labels: [], createdAt: at, updatedAt: at, comments: 0, ...before, ...fields, ...(before ? { updatedAt: at } : {}),
    };
    delete (issue as { at?: number }).at;
    this.issues.set(number, issue);
    return issue;
  }
  comment(number: number, fields: { author?: string; association?: string; body?: string; at?: number }): void {
    const at = fields.at ?? Date.now();
    const list = this.comments_.get(number) ?? [];
    list.push({ author: fields.author ?? "maintainer", association: fields.association ?? "MEMBER", body: fields.body ?? "a comment", createdAt: at, updatedAt: at });
    this.comments_.set(number, list);
    this.put(number, { comments: list.length, at });
  }
}

export interface FixtureOptions {
  merge?: FactoryMergeRules;
  repositoryRules?: Record<string, FactoryMergeRules>;
  /** Assign the deployer role to the channel. Default false, so deploy is skipped. */
  deployer?: boolean;
  /** Name the agent set something else than `software_factory` (an operator's own name for it). */
  agentSetName?: string;
  /** The channel's `sandbox` config, for a test that needs the container-mode resolution (mounts, path translation). */
  sandbox?: Record<string, unknown>;
  allowUsers?: string[];
  /** The factory's repositories. Default: just `REPO`. */
  repositories?: string[];
  /** The factory's `issues` setting. */
  issues?: { create?: boolean; labels?: string[]; maxPerHour?: number };
  /** The factory's `intake` setting. */
  intake?: Record<string, unknown>;
  /** More factory settings: `autonomy`, `autoRetries`, `reviewRounds`. */
  factory?: Record<string, unknown>;
  /** How long a run waits for an answer on its issue, in milliseconds: a test cannot wait days. */
  needsInfoMs?: number;
  /** After how long with no answer triage goes on with assumptions, in milliseconds. */
  assumeAfterMs?: number;
}

export function exampleAgentSet(): Record<string, unknown> {
  return (parse(readFileSync(join(REPO_ROOT, "config", "harness.example.yaml"), "utf8")) as { agentSets: Record<string, unknown> }).agentSets;
}

export function fixture(t: TestContext, options: FixtureOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "factory-workflow-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const set = JSON.parse(JSON.stringify(exampleAgentSet())) as { software_factory: { agents: Record<string, { model?: string }> } };
  for (const agent of Object.values(set.software_factory.agents)) agent.model = "fixture/model";
  const config = HarnessConfigSchema.parse({
    agentSets: options.agentSetName ? { [options.agentSetName]: set.software_factory } : set,
    channels: {
      factory: {
        model: "fixture/model", agentSet: options.agentSetName ?? "software_factory", tools: ["read", "write", "edit", "ls", "find", "grep", "bash"],
        ...(options.allowUsers ? { allowUsers: options.allowUsers } : {}),
        ...(options.sandbox ? { sandbox: options.sandbox } : {}),
        ...(options.deployer ? {} : { agentOverrides: { cloudflare_deployer: { enabled: false } } }),
        factory: {
          name: "Acme", repositories: options.repositories ?? [REPO],
          ...(options.merge ? { merge: options.merge } : {}),
          ...(options.repositoryRules ? { repositoryRules: options.repositoryRules } : {}),
          ...(options.issues ? { issues: options.issues } : {}),
          ...(options.intake ? { intake: options.intake } : {}),
          ...(options.factory ?? {}),
        },
      },
    },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "factory", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const toRelease: (() => Promise<void>)[] = [];
  const github = new FakeGitHub();
  t.after(async () => {
    for (const release of toRelease.reverse()) await release().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir, faux, channel, toRelease, github, needsInfoMs: options.needsInfoMs, assumeAfterMs: options.assumeAfterMs,
    /** The footer each role's shell was given, in the order the roles ran. */
    footers: [] as string[],
    ready: ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false }).then((runtime) => { runtime.registerNativeProvider(faux.provider); return runtime; }),
  };
}
export type Fixture = ReturnType<typeof fixture>;

/** One process's worth of runtime: the channel's store opened with the recovery gate, workflow runs and a fake GitHub wired in. */
export async function openProcess(f: Fixture, recovered?: (outcome: RecoveryOutcome) => void, extra: { factoryProblem?: (run: FactoryRunData) => string | undefined } = {}) {
  const modelRuntime = await f.ready;
  const probe = (runtimes: ChannelRuntimes): CreateThreadSessionOptions => ({
    channel: f.channel, threadKey: "channel-runtime", harnessName: "Test", slackChannelLabel: "#factory", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1",
  });
  const control = { current: () => undefined, set: async () => { throw new Error("no session"); } };
  const timeline = new ChannelTimelineLog(f.channel.paths.root);
  const runtimes: ChannelRuntimes = new ChannelRuntimes({
    modelRuntime,
    factoryGitHub: () => f.github,
    ...(f.needsInfoMs !== undefined ? { factoryNeedsInfoMs: () => f.needsInfoMs! } : {}),
    ...(f.assumeAfterMs !== undefined ? { factoryAssumeAfterMs: () => f.assumeAfterMs! } : {}),
    subagentHost: {
      parent: (channel: ResolvedChannel, runId: string) => headlessParent(channel, runId, { harnessName: "Test", botUserId: "UBOT", timeline }),
      buildToolSet: (runOpts) => { f.footers.push(runOpts.channel.env.HARNESS_AGENT_FOOTER ?? ""); return buildThreadToolSet(runOpts, { current: () => undefined, set: async () => { throw new Error("A subagent cannot switch models."); } }); },
    },
    gate: async (runtime) => {
      const outcome = await recoverChannel(runtime, {
        isEphemeral: (key) => isSubagentRunKey(key), speakerAllowed: () => true,
        ...(extra.factoryProblem ? { factoryProblem: extra.factoryProblem } : {}),
        bind: async () => { throw new Error("nothing here is a live conversation"); },
      });
      recovered?.(outcome);
    },
  });
  let toolSet: ThreadToolSet | undefined;
  const lease = await runtimes.acquire(f.channel, async () => {
    toolSet = await buildThreadToolSet(probe(runtimes), control);
    return runtimeTemplate(probe(runtimes), toolSet);
  });
  await toolSet?.dispose().catch(() => undefined);
  const runtime: ChannelRuntime = lease.runtime;
  lease.release();
  const close = async () => { await runtimes.closeAll(); };
  // At the end of a test only (a test closes a process to simulate a restart, and must not abort what it means to recover): a test that
  // fails with a role still working would otherwise hang in the close, which waits for running task code, and hide why it failed.
  f.toRelease.push(async () => {
    for (const run of await runtime.store.liveFactoryRuns().catch(() => [])) await runtime.store.abortFactoryRun(run.runId, "test teardown").catch(() => undefined);
    await close();
  });
  return { runtimes, runtime, store: runtime.store, close, timeline };
}
export type Process = Awaited<ReturnType<typeof openProcess>>;

export async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait for a run to reach one of the statuses (and, optionally, to be waiting on something). A timeout says where the run was. */
export async function reach(p: Pick<Process, "store">, runId: string, statuses: FactoryRunStatus[], wait?: string): Promise<FactoryRunData> {
  const what = `run ${runId} to be ${statuses.join(" or ")}${wait ? ` (${wait})` : ""}`;
  try {
    return await until(async () => {
      const run = await p.store.factoryRun(runId);
      return run && statuses.includes(run.status) && (wait === undefined || run.wait.kind === wait) ? run : undefined;
    }, what);
  } catch (error) {
    const run = await p.store.factoryRun(runId);
    const where = run ? `it was ${run.status} at ${run.current} (${run.wait.kind || "no wait"}): ${run.reason} | stages ${run.stages.map((s) => `${s.name}:${s.status}x${s.entries}`).join(" ")}` : "it does not exist";
    throw new Error(`${(error as Error).message}; ${where}`);
  }
}

/** The shipped workflow with the coder not resumable: a restart that cuts it off asks a person, as a deploy would. */
export const NO_RESUME_WORKFLOW: WorkflowDefinition = {
  ...SOFTWARE_FACTORY_WORKFLOW,
  stages: SOFTWARE_FACTORY_WORKFLOW.stages.map((stage) => (stage.name === "implement" ? { ...stage, resumable: false } : stage)),
};

export const startRun = (p: Pick<Process, "store">, overrides: { issue?: number; repo?: string; notes?: string; definition?: WorkflowDefinition } = {}) =>
  p.store.startFactoryRun({
    definition: overrides.definition ?? SOFTWARE_FACTORY_WORKFLOW, repo: overrides.repo ?? REPO, issue: overrides.issue ?? 7, issueTitle: "Login fails on an empty password",
    issueUrl: `https://github.com/${overrides.repo ?? REPO}/issues/${overrides.issue ?? 7}`, ...(overrides.notes ? { notes: overrides.notes } : {}),
    by: { source: "operator", threadKey: "1700000000.000100", userId: "U1" },
  });

export const stageOf = (run: FactoryRunData, name: string) => run.stages.find((stage) => stage.name === name)!;
export const statuses = (run: FactoryRunData) => run.stages.map((stage) => stage.status);

const userTexts = (context: TranscriptContext) =>
  context.messages.filter((m) => m.role === "user").flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))));
export const briefOf = (context: TranscriptContext): string => userTexts(context).join("\n");

/** Scripted role replies. Each is one model turn; the stage order decides which is used when. */
export const reply = {
  triage: (verdict: "READY" | "NEEDS_INFO" | "REJECT" = "READY") => `STATUS: done\nNEXT: ${verdict === "READY" ? "coder" : "none"}\n#7 — ${verdict.toLowerCase()}\nVERDICT: ${verdict}`,
  implement: (pr = "https://github.com/acme/app/pull/12") => `STATUS: done\nNEXT: reviewer\nBranch fix/7, PR ${pr}.\nTests: npm test, 41 passed.`,
  review: (verdict: "APPROVED" | "CHANGES_REQUESTED", risk: number | string = 2, findings = "") =>
    `STATUS: done\nNEXT: ${verdict === "APPROVED" ? "none" : "coder"}\nVERDICT: ${verdict}\n${findings}\nRISK: ${risk}\nRISK_REASON: small and tested`,
  deploy: () => "STATUS: done\nNEXT: none\nDeployed the commit to staging.",
};

export const respond = (text: string, capture?: (context: TranscriptContext) => void): FauxResponseFactory => (context) => { capture?.(context); return fauxAssistantMessage(text); };

/** A scripted turn that waits (until released or its request is aborted) before it answers. */
export function held(replyText: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const factory: FauxResponseFactory = async (_context, options) => {
    entered();
    await Promise.race([gate, new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    return fauxAssistantMessage(replyText);
  };
  return { factory, release, reached };
}
