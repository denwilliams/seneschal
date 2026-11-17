import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ResolvedChannel } from "../../workspace/resolve.ts";
import type { FactoryMergeRules } from "../../config/schema.ts";
import { hashWorkflow, SOFTWARE_FACTORY_WORKFLOW } from "./definition.ts";
import { emptyFactoryRun, type FactoryDecisionKind, type FactoryRunData, type RunUpdate } from "./docs.ts";
import { approvalRoleSkillProblem, createFactoryRunService, FactoryRunError, parseIssueRef, workflowProblem, type FactoryRunService, type FactoryRunStore } from "./service.ts";
import { FakeGitHub, REPO } from "./test-support.ts";

/** An in-memory store: the service is exercised on its own, with no engine under it. The engine's own tests run the real one. */
class MemoryStore implements FactoryRunStore {
  runs = new Map<string, FactoryRunData>();
  decisions: { runId: string; decision: string; by: string; head: string; stage: string }[] = [];
  reopens: string[] = [];
  aborts: { runId: string; reason: string }[] = [];
  startError: Error | undefined;
  private n = 0;
  async startFactoryRun(input: Parameters<FactoryRunStore["startFactoryRun"]>[0]) {
    if (this.startError) throw this.startError;
    const runId = `fr_${++this.n}`;
    this.runs.set(runId, { ...emptyFactoryRun(runId), workflow: input.definition.name, repo: input.repo, issue: input.issue, issueTitle: input.issueTitle, issueUrl: input.issueUrl, by: input.by, notes: input.notes ?? "", status: "running", startedAt: Date.now() });
    return { runId };
  }
  async factoryRun(runId: string) { return this.runs.get(runId); }
  async listFactoryRuns() { return [...this.runs.values()].reverse(); }
  async decideFactoryRun(runId: string, decision: Exclude<FactoryDecisionKind, "">, by: string, head = "", stage = "") { this.decisions.push({ runId, decision, by, head, stage }); }
  async reopenFactoryRun(runId: string) { this.reopens.push(runId); }
  async addFactoryRunUpdate(runId: string, update: RunUpdate) { const run = this.runs.get(runId); if (run) run.updates = [...run.updates, update]; }
  async abortFactoryRun(runId: string, reason: string) {
    const run = this.runs.get(runId);
    if (!run || ["completed", "rejected", "failed", "aborted"].includes(run.status)) return "terminal" as const;
    this.aborts.push({ runId, reason });
    return "marked" as const;
  }
  put(run: Partial<FactoryRunData> & { runId: string }): FactoryRunData {
    const full = { ...emptyFactoryRun(run.runId), workflow: "software-factory", definition: JSON.stringify(SOFTWARE_FACTORY_WORKFLOW), hash: hashWorkflow(SOFTWARE_FACTORY_WORKFLOW), repo: REPO, issue: 9, ...run };
    this.runs.set(run.runId, full);
    return full;
  }
}

async function channelWith(options: { agentSetName?: string; merge?: FactoryMergeRules; repositoryRules?: Record<string, FactoryMergeRules>; allowUsers?: string[]; roles?: "all" | "no_reviewer"; repositories?: string[]; dm?: boolean } = {}): Promise<{ channel: ResolvedChannel; dir: string }> {
  // The shipped agent set, resolved the way the engine tests resolve it, without a model runtime: only the config matters here.
  const { HarnessConfigSchema } = await import("../../config/schema.ts");
  const { ChannelRegistry } = await import("../../workspace/registry.ts");
  const { resolveChannel } = await import("../../workspace/resolve.ts");
  const { exampleAgentSet } = await import("./test-support.ts");
  const dir = mkdtempSync(join(tmpdir(), "factory-service-"));
  const set = JSON.parse(JSON.stringify(exampleAgentSet())) as { software_factory: { agents: Record<string, { model?: string }> } };
  for (const agent of Object.values(set.software_factory.agents)) agent.model = "fixture/model";
  if (options.roles === "no_reviewer") delete set.software_factory.agents.reviewer;
  const config = HarnessConfigSchema.parse({
    agentSets: options.agentSetName ? { [options.agentSetName]: set.software_factory } : set,
    channels: {
      factory: {
        model: "fixture/model", agentSet: options.agentSetName ?? "software_factory", tools: ["read", "bash"],
        ...(options.allowUsers ? { allowUsers: options.allowUsers } : {}),
        factory: { name: "Acme", repositories: options.repositories ?? [REPO], ...(options.merge ? { merge: options.merge } : {}), ...(options.repositoryRules ? { repositoryRules: options.repositoryRules } : {}) },
      },
    },
  });
  const channel = resolveChannel(config, dir, { id: "C1", name: "factory", isDm: options.dm === true }, new ChannelRegistry(dir)).channel!;
  return { channel, dir };
}

async function setup(t: TestContext, options: Parameters<typeof channelWith>[0] & { user?: string } = {}) {
  const { channel, dir } = await channelWith(options);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore();
  const github = new FakeGitHub();
  const speaker = { id: options.user ?? "U1" };
  const service: FactoryRunService = createFactoryRunService({ channel, store: () => store, github: () => github, threadKey: "1700000000.000100", currentUserId: () => speaker.id });
  const audit = () => readFileSync(join(channel.shared.audit, "factory-runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { channel, store, github, service, speaker, audit };
}

const refusal = (fn: () => Promise<unknown>, pattern: RegExp) => assert.rejects(fn, (error) => error instanceof FactoryRunError && pattern.test(error.message));

test("an issue is named three ways, always inside the factory's own repositories and spelled as configured", () => {
  const repos = ["Acme/App", "acme/api"];
  assert.deepEqual(parseIssueRef("acme/app#7", repos), { repo: "Acme/App", issue: 7 });
  assert.deepEqual(parseIssueRef("https://github.com/ACME/api/issues/12", repos), { repo: "acme/api", issue: 12 });
  assert.deepEqual(parseIssueRef("https://github.com/acme/api/issues/12?x=1#c", repos), { repo: "acme/api", issue: 12 });
  assert.deepEqual(parseIssueRef("#7", ["acme/app"]), { repo: "acme/app", issue: 7 });
  assert.deepEqual(parseIssueRef(" 7 ", ["acme/app"]), { repo: "acme/app", issue: 7 });
  assert.throws(() => parseIssueRef("7", repos), /several repositories/);
  assert.throws(() => parseIssueRef("evil/repo#7", repos), /not one of this factory's repositories/);
  assert.throws(() => parseIssueRef("https://github.com/evil/repo/issues/7", repos), /not one of this factory's repositories/);
  assert.throws(() => parseIssueRef("https://github.com/acme/app/pull/7", ["acme/app"]), /pull request/);
  assert.throws(() => parseIssueRef("acme/app#0", ["acme/app"]), /not an issue number/);
  assert.throws(() => parseIssueRef("fix the login; rm -rf /", ["acme/app"]), /is not an issue/);
  assert.throws(() => parseIssueRef("https://github.com.evil.test/acme/app/issues/7", ["acme/app"]), /is not an issue/);
});

test("start: reads the issue, records who started it from the session, and audits it", async (t) => {
  const s = await setup(t);
  s.github.issues.set(7, { number: 7, title: "Login fails on an empty password", url: "https://github.com/acme/app/issues/7", state: "open" });
  const started = await s.service.start("acme/app#7", "  it is blocking the release  ");
  assert.deepEqual([started.repo, started.issue, started.title], [REPO, 7, "Login fails on an empty password"]);
  const run = s.store.runs.get(started.runId)!;
  assert.deepEqual(run.by, { source: "agent", threadKey: "1700000000.000100", userId: "U1" });
  assert.equal(run.notes, "it is blocking the release");
  assert.equal(run.issueUrl, "https://github.com/acme/app/issues/7");
  const [line] = s.audit();
  assert.deepEqual([line!.event, line!.runId, line!.repo, line!.issue, line!.userId, line!.threadKey, line!.notes], ["start", started.runId, REPO, 7, "U1", "1700000000.000100", true]);
});

test("start: with the agent set under another name the deployer's skills are missing, so the run is refused before anything is built, and says why", async (t) => {
  const s = await setup(t, { agentSetName: "factory_team" });
  s.github.issues.set(7, { number: 7, title: "Login fails", url: "https://github.com/acme/app/issues/7", state: "open" });
  await refusal(() => s.service.start("acme/app#7"), /`cloudflare_deployer` is told to follow `cloudflare-deploy`[^]*agent-set-skills\/software_factory\/[^]*named exactly `software_factory`[^]*"factory_team"[^]*after the change is merged/);
  assert.equal(s.store.runs.size, 0, "nothing started");
  assert.equal(approvalRoleSkillProblem(s.channel)?.includes("cloudflare-deploy"), true);
  // Correctly named, the same channel starts.
  const ok = await setup(t);
  ok.github.issues.set(7, { number: 7, title: "Login fails", url: "https://github.com/acme/app/issues/7", state: "open" });
  assert.equal(approvalRoleSkillProblem(ok.channel), undefined);
  await ok.service.start("acme/app#7");
});

test("start: refuses what the engine must not be given, in words the model can pass on", async (t) => {
  const s = await setup(t);
  await refusal(() => s.service.start("acme/app#99"), /has no issue #99/);
  s.github.issues.set(8, { number: 8, title: "Old", url: "u", state: "closed" });
  await refusal(() => s.service.start("acme/app#8"), /is closed/);
  await refusal(() => s.service.start("other/repo#7"), /not one of this factory's repositories/);
  s.github.readIssue = async () => { throw new Error("HTTP 401: Bad credentials\nsecond line"); };
  await refusal(() => s.service.start("acme/app#7"), /Could not read acme\/app#7 from GitHub: HTTP 401: Bad credentials$/);
  assert.equal(s.store.runs.size, 0, "nothing was started by any of them");
});

test("start: one live run per issue, and three live runs per channel, a run waiting for a person counting as live", async (t) => {
  const s = await setup(t);
  s.github.issues.set(7, { number: 7, title: "t", url: "u", state: "open" });
  s.store.put({ runId: "fr_a", issue: 7, status: "waiting", wait: { kind: "merge", since: 1 } });
  await refusal(() => s.service.start("acme/app#7"), /already has a live run \(fr_a, waiting\)/);
  s.store.put({ runId: "fr_a", issue: 7, status: "completed" });
  assert.ok((await s.service.start("acme/app#7")).runId, "a finished run does not block the issue");

  const full = await setup(t);
  for (const n of [1, 2, 3]) full.store.put({ runId: `fr_${n}`, issue: n, status: n === 3 ? "waiting" : "running", ...(n === 3 ? { wait: { kind: "merge" as const, since: 1 } } : {}) });
  full.github.issues.set(7, { number: 7, title: "t", url: "u", state: "open" });
  await refusal(() => full.service.start("acme/app#7"), /3 workflow runs are already live .* a run waiting for a person counts/);
  full.store.put({ runId: "fr_3", issue: 3, status: "failed" });
  assert.ok((await full.service.start("acme/app#7")).runId);
});

test("start: the store's own refusals (recovery, an invalid workflow) reach the model as refusals, anything else stays an error", async (t) => {
  const s = await setup(t);
  s.github.issues.set(7, { number: 7, title: "t", url: "u", state: "open" });
  s.store.startError = new Error("acme/app#7 already has a live run (fr_x); check it, or abort it first.");
  await refusal(() => s.service.start("acme/app#7"), /already has a live run/);
  s.store.startError = new Error("disk full");
  await assert.rejects(s.service.start("acme/app#7"), (error) => !(error instanceof FactoryRunError) && /disk full/.test((error as Error).message));
});

test("a channel that is not a factory, or whose team lacks a role the workflow needs, cannot start runs; a missing deployer is fine", async (t) => {
  const missing = await setup(t, { roles: "no_reviewer" });
  assert.match(missing.service.problem()!, /no `reviewer` subagent/);
  await refusal(() => missing.service.start("acme/app#7"), /Workflow runs are not available here: its team has no `reviewer` subagent/);
  const ok = await setup(t);
  assert.equal(ok.service.problem(), undefined, "the deployer is optional (the example set's channel here has it, and the workflow skips it when it is not assigned)");
  assert.equal(workflowProblem({ factory: undefined, agents: [] }), "this channel is not a software factory");
  const noDeployer = { ...ok.channel, agents: ok.channel.agents.filter((agent) => agent.name !== "cloudflare_deployer") };
  assert.equal(workflowProblem(noDeployer), undefined);
});

test("start: with no way to reach the store or GitHub it fails closed", async (t) => {
  const { channel, dir } = await channelWith();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const noGitHub = createFactoryRunService({ channel, store: () => new MemoryStore(), github: () => undefined, threadKey: "t", currentUserId: () => "U1" });
  await refusal(() => noGitHub.start("acme/app#7"), /not available in this session/);
  const noStore = createFactoryRunService({ channel, store: () => undefined, github: () => new FakeGitHub(), threadKey: "t", currentUserId: () => "U1" });
  await refusal(() => noStore.check(), /not available in this session/);
});

test("approve: only an approver, as the SESSION knows the speaker, and for the commit the run reviewed, never one given to it", async (t) => {
  const s = await setup(t, { merge: { approvers: ["UAPPROVER"] }, user: "UOTHER" });
  const reviewed = "a".repeat(40);
  s.store.put({ runId: "fr_m", status: "waiting", wait: { kind: "merge", since: 1 }, pr: { number: 12, url: "u", reviewedHead: reviewed, mergeCommit: "" }, risk: { model: 3, scored: true, reason: "", final: 3, floors: ["touches infra/x.tf"] } });
  await refusal(() => s.service.approve("fr_m"), /<@UOTHER> is not one of the people who may approve or decline runs for acme\/app/);
  assert.deepEqual(s.store.decisions, [], "no decision was written for someone who may not decide");

  s.speaker.id = "UAPPROVER";
  assert.deepEqual(await s.service.approve("fr_m"), { head: reviewed });
  assert.deepEqual(s.store.decisions, [{ runId: "fr_m", decision: "approve", by: "UAPPROVER", head: reviewed, stage: "" }]);
  const line = s.audit().at(-1)!;
  assert.deepEqual([line.event, line.userId, line.head, line.wait], ["approve", "UAPPROVER", reviewed, "merge"]);
  assert.deepEqual(line.risk, { model: 3, final: 3, floors: ["touches infra/x.tf"] });
});

test("approvers: a repository's list overrides the factory's, and with neither the channel's allowed users decide", async (t) => {
  const repo = await setup(t, { merge: { approvers: ["UFACTORY"] }, repositoryRules: { [REPO]: { approvers: ["UREPO"] } }, user: "UFACTORY" });
  repo.store.put({ runId: "fr_r", status: "waiting", wait: { kind: "merge", since: 1 }, pr: { number: 1, url: "u", reviewedHead: "h", mergeCommit: "" } });
  await refusal(() => repo.service.approve("fr_r"), /not one of the people who may approve/);
  repo.speaker.id = "UREPO";
  await repo.service.approve("fr_r");

  const channelList = await setup(t, { allowUsers: ["U1", "U2"], user: "U3" });
  channelList.store.put({ runId: "fr_c", status: "waiting", wait: { kind: "merge", since: 1 }, pr: { number: 1, url: "u", reviewedHead: "h", mergeCommit: "" } });
  await refusal(() => channelList.service.approve("fr_c"), /not one of the people/);
  channelList.speaker.id = "U2";
  await channelList.service.approve("fr_c");

  const nobody = await setup(t, { user: "" });
  nobody.store.put({ runId: "fr_n", status: "waiting", wait: { kind: "merge", since: 1 }, pr: { number: 1, url: "u", reviewedHead: "h", mergeCommit: "" } });
  await refusal(() => nobody.service.approve("fr_n"), /This speaker is not one of the people/);
});

test("decisions are only accepted for the wait they answer, and a finished or unknown run is said so", async (t) => {
  const s = await setup(t);
  s.store.put({ runId: "fr_run", status: "running" });
  s.store.put({ runId: "fr_rounds", status: "waiting", wait: { kind: "rounds", since: 1 }, guard: { from: "review", target: "implement" } });
  s.store.put({ runId: "fr_merge", status: "waiting", wait: { kind: "merge", since: 1 }, pr: { number: 1, url: "u", reviewedHead: "h", mergeCommit: "" } });
  s.store.put({ runId: "fr_dec", status: "needs_decision", wait: { kind: "decide", since: 1 }, current: "implement" });
  s.store.put({ runId: "fr_done", status: "completed" });

  await refusal(() => s.service.approve("fr_run"), /is running, not waiting for an approval/);
  await refusal(() => s.service.approve("fr_rounds"), /waiting \(waiting on rounds\), not waiting for an approval/);
  await refusal(() => s.service.moreRounds("fr_merge"), /waiting \(waiting on merge\), not waiting for more rounds/);
  await refusal(() => s.service.decide("fr_merge", "retry"), /not waiting for a decision about a stage that was interrupted or failed/);
  await refusal(() => s.service.approve("fr_done"), /has already finished \(completed\)/);
  await refusal(() => s.service.approve("fr_nope"), /There is no workflow run fr_nope/);

  await s.service.moreRounds("fr_rounds");
  await s.service.decline("fr_rounds");
  await s.service.decline("fr_merge");
  await s.service.decide("fr_dec", "skip");
  assert.deepEqual(s.store.decisions.map((d) => [d.runId, d.decision]), [["fr_rounds", "more_rounds"], ["fr_rounds", "stop"], ["fr_merge", "decline"], ["fr_dec", "skip"]], "declining a loop that is out of rounds is stopping it");
  assert.deepEqual(s.audit().map((l) => l.event), ["more_rounds", "stop", "decline", "decide"]);
});

test("a failed stage: retry, skip (an optional stage only), restart_from (an earlier stage) and abort, checked here so the person is told why not", async (t) => {
  const s = await setup(t, { merge: { approvers: ["UAPPROVER"] }, user: "UOTHER" });
  s.store.put({ runId: "fr_f", status: "needs_decision", wait: { kind: "failed", since: 1 }, current: "review", reason: 'stage "review" failed: boom' });
  await refusal(() => s.service.decide("fr_f", "retry"), /not one of the people/);
  s.speaker.id = "UAPPROVER";

  await refusal(() => s.service.decide("fr_f", "skip"), /the "review" stage cannot be skipped: only an optional stage \(deploy\) can/);
  await refusal(() => s.service.decide("fr_f", "restart_from"), /say which earlier stage to restart from \(triage, implement\)/);
  await refusal(() => s.service.decide("fr_f", "restart_from", "merge"), /"merge" is not an earlier stage than "review"/);
  await refusal(() => s.service.decide("fr_f", "restart_from", "nowhere"), /"nowhere" is not an earlier stage/);
  assert.equal(s.store.decisions.length, 0, "none of those reached the store");

  await s.service.decide("fr_f", "retry");
  await s.service.decide("fr_f", "restart_from", " Implement ");
  await s.service.decide("fr_f", "abort");
  assert.deepEqual(s.store.decisions.map((d) => [d.decision, d.by, d.stage]), [["retry", "UAPPROVER", ""], ["restart_from", "UAPPROVER", "implement"], ["abort", "UAPPROVER", ""]]);
  assert.deepEqual(s.audit().filter((l) => l.event === "decide").map((l) => [l.decision, l.wait, l.restartFrom]), [["retry", "failed", undefined], ["restart_from", "failed", "implement"], ["abort", "failed", undefined]]);

  // A deploy that failed may be skipped.
  s.store.put({ runId: "fr_d", status: "needs_decision", wait: { kind: "failed", since: 1 }, current: "deploy" });
  await s.service.decide("fr_d", "skip");
  assert.equal(s.store.decisions.at(-1)!.decision, "skip");

  // A stage a restart interrupted is a different wait: retry, skip or abort, not going back.
  s.store.put({ runId: "fr_i", status: "needs_decision", wait: { kind: "decide", since: 1 }, current: "implement" });
  await refusal(() => s.service.decide("fr_i", "restart_from", "triage"), /interrupted by a restart: retry it, skip it or abort/);
});

test("a run that ended failed is carried on by retry, from its failed stage, once the issue is still open; nothing else carries it on", async (t) => {
  const s = await setup(t, { merge: { approvers: ["UAPPROVER"] }, user: "UOTHER" });
  s.github.issues.set(9, { number: 9, title: "t", url: "u", state: "open" });
  s.store.put({ runId: "fr_old", status: "failed", current: "implement", reason: 'stage "implement" failed: boom' });
  await refusal(() => s.service.decide("fr_old", "retry"), /not one of the people/);
  s.speaker.id = "UAPPROVER";
  await refusal(() => s.service.decide("fr_old", "skip"), /ended failed .*Only "retry" carries it on/);
  await refusal(() => s.service.decide("fr_old", "restart_from", "triage"), /Only "retry" carries it on/);
  await refusal(() => s.service.decide("fr_old", "abort"), /Only "retry" carries it on/);
  assert.deepEqual(s.store.reopens, []);

  s.github.issues.set(9, { number: 9, title: "t", url: "u", state: "closed" });
  await refusal(() => s.service.decide("fr_old", "retry"), /is closed, so its run is not carried on/);
  s.github.issues.set(9, { number: 9, title: "t", url: "u", state: "open" });
  await s.service.decide("fr_old", "retry");
  assert.deepEqual(s.store.reopens, ["fr_old"]);
  assert.deepEqual(s.audit().filter((l) => l.event === "reopen").map((l) => [l.runId, l.stage, l.by]), [["fr_old", "implement", "UAPPROVER"]]);

  // Aborted, rejected and completed runs are not reopened: the answer is to start the issue again.
  s.store.put({ runId: "fr_done", status: "aborted" });
  await refusal(() => s.service.decide("fr_done", "retry"), /has already finished \(aborted\)|not waiting for a decision/);
});

test("abort: an approver stops a live run and it is audited; a finished run is said so", async (t) => {
  const s = await setup(t, { merge: { approvers: ["UAPPROVER"] }, user: "UOTHER" });
  s.store.put({ runId: "fr_live", status: "running", current: "implement" });
  await refusal(() => s.service.abort("fr_live"), /not one of the people/);
  s.speaker.id = "UAPPROVER";
  await s.service.abort("fr_live");
  assert.deepEqual(s.store.aborts, [{ runId: "fr_live", reason: "aborted by UAPPROVER" }]);
  assert.deepEqual(s.audit().map((l) => [l.event, l.stage]), [["abort", "implement"]]);
  s.store.put({ runId: "fr_done", status: "failed" });
  await refusal(() => s.service.abort("fr_done"), /has already finished \(failed\)/);
});

test("check: one run by id, or the most recent runs", async (t) => {
  const s = await setup(t);
  s.store.put({ runId: "fr_1", issue: 1 });
  s.store.put({ runId: "fr_2", issue: 2 });
  assert.deepEqual((await s.service.check("fr_1")).map((run) => run.runId), ["fr_1"]);
  assert.equal((await s.service.check()).length, 2);
  await refusal(() => s.service.check("fr_x"), /There is no workflow run fr_x/);
});

test("in a run's own Slack thread the run id may be left out and means that run; anywhere else it must be named", async (t) => {
  const { store, service } = await setup(t, { allowUsers: ["U1"] });
  store.put({ runId: "fr_a", status: "waiting", wait: { kind: "merge", since: 5 }, pr: { number: 12, url: "", reviewedHead: "h".repeat(40), mergeCommit: "" }, slack: { channel: "C1", ts: "1700000000.000100", posts: 1, events: [], decision: { kind: "", since: 0, by: "", at: 0 } } });
  store.put({ runId: "fr_b", status: "waiting", wait: { kind: "merge", since: 6 }, startedAt: 1, pr: { number: 13, url: "", reviewedHead: "g".repeat(40), mergeCommit: "" }, slack: { channel: "C1", ts: "1700000000.999999", posts: 1, events: [], decision: { kind: "", since: 0, by: "", at: 0 } } });
  // The service in `setup` speaks in thread 1700000000.000100, which is fr_a's.
  assert.deepEqual((await service.check()).map((run) => run.runId), ["fr_a"], "no id: this thread's run, not the recent list");
  await service.approve();
  assert.deepEqual(store.decisions, [{ runId: "fr_a", decision: "approve", by: "U1", head: "h".repeat(40), stage: "" }]);
  await service.decline();
  assert.equal(store.decisions.at(-1)!.runId, "fr_a");
  // Naming another run still works, and is checked like any other.
  await service.approve("fr_b");
  assert.equal(store.decisions.at(-1)!.runId, "fr_b");
});

test("outside a run's thread, a missing run id is a plain refusal, not a guess", async (t) => {
  const { store, service } = await setup(t);
  store.put({ runId: "fr_a", status: "waiting", wait: { kind: "merge", since: 5 }, slack: { channel: "C1", ts: "1700000000.555555", posts: 1, events: [], decision: { kind: "", since: 0, by: "", at: 0 } } });
  await refusal(() => service.approve(), /Name the run.*not a run's status thread/);
  await refusal(() => service.abort(), /Name the run/);
  assert.equal((await service.check()).length, 1, "with no id and no bound run, check lists recent runs");
});

test("starting a run asks for its status post and passes its link on; a Slack that cannot make one does not stop the run", async (t) => {
  const { channel, store, github } = await setup(t);
  const announced: string[] = [];
  const make = (announce: (runId: string) => Promise<{ permalink?: string } | undefined>) =>
    createFactoryRunService({ channel, store: () => store, github: () => github, threadKey: "1700000000.000100", currentUserId: () => "U1", announce });
  store.startFactoryRun = async (input) => { store.put({ runId: "fr_new", repo: input.repo, issue: input.issue }); return { runId: "fr_new" }; };
  const started = await make(async (runId) => { announced.push(runId); return { permalink: "https://example.slack.com/archives/C1/p1" }; }).start("acme/app#7");
  assert.deepEqual([started.runId, started.statusPost, announced], ["fr_new", "https://example.slack.com/archives/C1/p1", ["fr_new"]]);
  store.runs.clear();
  const failing = await make(async () => { throw new Error("slack is down"); }).start("acme/app#7");
  assert.equal(failing.runId, "fr_new");
  assert.equal(failing.statusPost, undefined);
});
