import assert from "node:assert/strict";
import { test } from "node:test";
import { FactoryDeploySchema, FactorySchema } from "../../config/schema.ts";
import { hashWorkflow, pinnedWorkflow, softwareFactoryWorkflow, SOFTWARE_FACTORY_WORKFLOW, validateWorkflow } from "./definition.ts";
import { createDeploymentReader, type DeploymentRun, type ReadDeploymentRun } from "./github-actions.ts";
import { channelWorkflow } from "./service.ts";
import { fixture, openProcess, reach, REPO, reply, respond, stageOf, startRun, until } from "./test-support.ts";

const SHA = "bbbbbbb2222222222222222222222222222222bb";
const deploy = (extra = {}) => FactoryDeploySchema.parse({ mode: "github-actions", workflow: ".github/workflows/deploy.yml", ...extra });
const observed = (extra: Partial<DeploymentRun> = {}): DeploymentRun => ({ id: 22, attempt: 1, workflowId: 9, repo: REPO, sha: SHA, status: "completed", conclusion: "success", url: `https://github.com/${REPO}/actions/runs/22`, ...extra });
const raw = (extra = {}) => ({ id: 22, run_attempt: 1, workflow_id: 9, repository: { full_name: REPO }, head_sha: SHA, status: "completed", conclusion: "success", ...extra });
const args = { repo: REPO, workflow: ".github/workflows/deploy.yml", sha: SHA };

test("selection defaults to the existing deployer, supports per-repository overrides, and pins monitor configuration", () => {
  assert.equal(softwareFactoryWorkflow(), SOFTWARE_FACTORY_WORKFLOW);
  assert.equal(softwareFactoryWorkflow({ deploy: { mode: "agent" } }), SOFTWARE_FACTORY_WORKFLOW);
  const factory = FactorySchema.parse({ name: "Test", repositories: [REPO, "acme/other"], deploy: deploy(), repositoryRules: { [REPO]: { deploy: { mode: "agent" } } } });
  assert.equal(channelWorkflow({ factory }, REPO.toUpperCase()).stages.at(-1)?.kind, "agent");
  const definition = channelWorkflow({ factory }, "acme/other");
  assert.equal(definition.version, 6);
  assert.equal(definition.stages.filter(s => s.name === "deploy").length, 1);
  assert.equal(definition.stages.at(-1)?.kind, "actions");
  assert.equal(definition.stages.at(-1)?.role, undefined);
  assert.deepEqual(validateWorkflow(definition), []);
  assert.deepEqual(pinnedWorkflow({ definition: JSON.stringify(definition), hash: hashWorkflow(definition) }), definition);
  assert.deepEqual(deploy(), { mode: "github-actions", workflow: ".github/workflows/deploy.yml", pollIntervalSeconds: 15, timeoutSeconds: 1800 });
});

test("monitor config refuses missing/unsafe workflow selectors, unknown keys and unbounded polling", () => {
  for (const input of [{ mode: "github-actions" }, { mode: "github-actions", workflow: "Deploy production" }, { mode: "github-actions", workflow: "../deploy.yml" }, { mode: "github-actions", workflow: 0 }, { ...deploy(), pollIntervalSeconds: 0 }, { ...deploy(), timeoutSeconds: 86401 }, { ...deploy(), dispatch: true }]) assert.equal(FactoryDeploySchema.safeParse(input).success, false);
  const definition = structuredClone(softwareFactoryWorkflow({ deploy: deploy() }));
  definition.stages.at(-1)!.actions = undefined;
  assert.ok(validateWorkflow(definition).length);
});

test("reader uses only GETs, ignores unrelated successes, paginates, and picks the newest matching run", async () => {
  const calls: string[][] = [];
  const read = createDeploymentReader(async argv => {
    calls.push(argv);
    const path = argv.at(-1)!;
    if (path.endsWith("deploy.yml")) return { stdout: JSON.stringify({ id: 9 }) };
    return { stdout: JSON.stringify({ total_count: 102, workflow_runs: path.endsWith("page=1")
      ? Array.from({ length: 100 }, (_, i) => raw({ id: i + 1, head_sha: "a".repeat(40) }))
      : [raw({ id: 200 }), raw({ id: 201 })] }) };
  });
  assert.equal((await read(args)).run?.id, 201);
  assert.ok(calls.every(c => c[0] === "api" && c[1] === "--method" && c[2] === "GET"));
  assert.equal(calls[0]!.at(-1), `repos/${REPO}/actions/workflows/deploy.yml`);
  assert.ok(calls[1]!.at(-1)?.includes(`head_sha=${SHA}`));
  assert.equal(calls.length, 3);
});

test("reader pins ID and revalidates workflow, repository, commit and returned run ID", async () => {
  for (const extra of [{ workflow_id: 8 }, { repository: { full_name: "evil/fork" } }, { head_sha: "a".repeat(40) }, { id: 23 }, { run_attempt: undefined }]) {
    const read = createDeploymentReader(async () => ({ stdout: JSON.stringify(raw(extra)) }));
    await assert.rejects(read({ ...args, workflowId: 9, runId: 22 }), /match|different|invalid/);
  }
  const calls: string[][] = [];
  const read = createDeploymentReader(async argv => { calls.push(argv); return { stdout: JSON.stringify(raw()) }; });
  assert.equal((await read({ ...args, workflowId: 9, runId: 22 })).run?.url, `https://github.com/${REPO}/actions/runs/22`);
  assert.deepEqual(calls, [["api", "--method", "GET", `repos/${REPO}/actions/runs/22`]]);
});

test("reader handles missing runs, numeric workflow ID, malformed/too-large responses and API denial", async () => {
  const missing = createDeploymentReader(async argv => ({ stdout: JSON.stringify(argv.at(-1)!.endsWith("/9") ? { id: 9 } : { total_count: 0, workflow_runs: [] }) }));
  assert.deepEqual(await missing({ ...args, workflow: 9 }), { workflowId: 9, run: undefined });
  for (const response of [{}, { total_count: 1001, workflow_runs: [] }]) {
    await assert.rejects(createDeploymentReader(async () => ({ stdout: JSON.stringify(response) }))({ ...args, workflowId: 9 }), /invalid|limit/);
  }
  await assert.rejects(createDeploymentReader(async () => { throw new Error("HTTP 403: Actions read access denied"); })(args), /403/);
});

async function setup(t: Parameters<typeof fixture>[0], read: ReadDeploymentRun, settings = {}, withDeployer = false) {
  const f = fixture(t, { deployer: withDeployer, merge: { autoMergeMaxRisk: 2, approvers: ["U1ADMIN"] }, factory: { deploy: deploy(settings) } });
  Object.assign(f.github, { readDeploymentRun: read });
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 2))]);
  const p = await openProcess(f);
  const { runId } = await startRun(p, { definition: channelWorkflow(f.channel, REPO) });
  return { f, p, runId };
}

test("engine polls missing/queued/running runs then succeeds without a deploy agent or deploy approval", async t => {
  const calls: Parameters<ReadDeploymentRun>[0][] = [];
  const { f, p, runId } = await setup(t, async input => {
    calls.push(input);
    assert.equal(input.sha, SHA);
    return { workflowId: 9, run: calls.length === 1 ? undefined : observed(calls.length === 2 ? { status: "queued", conclusion: null } : calls.length === 3 ? { status: "in_progress", conclusion: null } : {}) };
  }, { pollIntervalSeconds: 1, timeoutSeconds: 10 }, true);
  const run = await reach(p, runId, ["completed"]);
  assert.equal(calls.length, 4);
  assert.equal(calls[2]!.runId, 22);
  assert.equal(calls[2]!.workflowId, 9);
  assert.equal(f.faux.state.callCount, 3, "enabled Cloudflare deployer was not run");
  assert.equal(run.deployApprovedBy, "");
  assert.match(stageOf(run, "deploy").attempts[0]!.summary, /22, attempt 1: completed \/ success.*https:/);
});

for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale", null]) {
  test(`engine fails terminal conclusion ${conclusion}, with the Actions link`, async t => {
    const { p, runId } = await setup(t, async () => ({ workflowId: 9, run: observed({ conclusion }) }));
    const run = await reach(p, runId, ["needs_decision"], "failed");
    assert.equal(stageOf(run, "deploy").status, "failed");
    assert.match(run.reason, /https:\/\/github.com\/acme\/app\/actions\/runs\/22/);
    assert.match(stageOf(run, "deploy").attempts[0]!.report, /completed/);
  });
}

for (const present of [false, true]) {
  test(`engine deadline distinguishes ${present ? "unfinished" : "missing"} runs`, async t => {
    const { p, runId } = await setup(t, async () => ({ workflowId: 9, run: present ? observed({ status: "queued", conclusion: null }) : undefined }), { pollIntervalSeconds: 1, timeoutSeconds: 1 });
    const run = await reach(p, runId, ["needs_decision"], "failed");
    assert.match(run.reason, present ? /timed out waiting for run 22.*https:/ : /No GitHub Actions deployment run appeared/);
  });
}

test("engine surfaces API/access failures and a hung request, never success", async t => {
  for (const read of [async () => { throw new Error("HTTP 401: bad credentials"); }, () => new Promise<never>(() => {})]) {
    const { p, runId } = await setup(t, read, { timeoutSeconds: 1 });
    const run = await reach(p, runId, ["needs_decision"], "failed");
    assert.match(run.reason, /API\/access failure/);
    assert.match(run.reason, /401|deadline/);
  }
});

test("engine rejects a changed attempt instead of accepting a rerun's success", async t => {
  let count = 0;
  const { p, runId } = await setup(t, async () => ({ workflowId: 9, run: observed(++count === 1 ? { status: "in_progress", conclusion: null } : { attempt: 2 }) }), { pollIntervalSeconds: 1 });
  assert.match((await reach(p, runId, ["needs_decision"], "failed")).reason, /attempt changed from 1 to 2/);
});

test("monitoring cannot start before the existing merge approval gate", async t => {
  const f = fixture(t, { merge: { approvers: ["U1ADMIN"] }, factory: { deploy: deploy() } });
  let calls = 0;
  Object.assign(f.github, { readDeploymentRun: async () => { calls++; return { workflowId: 9, run: observed() }; } });
  f.faux.setResponses([respond(reply.triage()), respond(reply.implement()), respond(reply.review("APPROVED", 2))]);
  const p = await openProcess(f);
  const { runId } = await startRun(p, { definition: channelWorkflow(f.channel, REPO) });
  await reach(p, runId, ["waiting"], "merge");
  assert.equal(calls, 0);
  assert.equal(f.github.merges.length, 0);
  await p.store.decideFactoryRun(runId, "approve", "U1ADMIN", f.github.pr.headSha);
  await reach(p, runId, ["completed"]);
  assert.equal(calls, 1);
});

for (const choice of ["retry", "skip"] as const) {
  test(`existing authorized ${choice} controls recover an unsuccessful observation only`, async t => {
    let ok = false;
    const { f, p, runId } = await setup(t, async () => ({ workflowId: 9, run: observed({ conclusion: ok ? "success" : "failure" }) }));
    await reach(p, runId, ["needs_decision"], "failed");
    ok = true;
    await p.store.decideFactoryRun(runId, choice, "U1ADMIN");
    const run = await reach(p, runId, ["completed"]);
    assert.equal(f.faux.state.callCount, 3);
    assert.equal(f.github.merges.length, 1);
    assert.equal(stageOf(run, "deploy").status, choice === "retry" ? "success" : "skipped");
    assert.equal(stageOf(run, "deploy").attempts.length, 2);
  });
}

test("reader does not continue paginating after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const read = createDeploymentReader(async () => {
    calls++;
    controller.abort();
    return { stdout: JSON.stringify({ total_count: 100, workflow_runs: Array.from({ length: 100 }, () => raw()) }) };
  });
  await assert.rejects(read({ ...args, workflowId: 9, signal: controller.signal }), /abort/i);
  assert.equal(calls, 1);
});

test("a restart cannot extend an expired monitoring deadline", async t => {
  let calls = 0;
  const { f, p, runId } = await setup(t, async () => { calls++; return { workflowId: 9, run: observed({ status: "queued", conclusion: null }) }; }, { pollIntervalSeconds: 1, timeoutSeconds: 1 });
  await until(async () => { const r = await p.store.factoryRun(runId); return r && stageOf(r, "deploy").attempts[0]?.summary.includes("queued") ? r : undefined; }, "selected run");
  await p.close();
  await new Promise(resolve => setTimeout(resolve, 1100));
  const second = await openProcess(f);
  const run = await reach(second, runId, ["needs_decision"], "failed");
  assert.match(run.reason, /timed out waiting for run 22/);
  assert.equal(calls, 1, "an expired checkpoint never polls again");
});

test("restart keeps the selected run/attempt and original deadline, without another deployment or model call", async t => {
  const calls: Parameters<ReadDeploymentRun>[0][] = [];
  let complete = false;
  const { f, p, runId } = await setup(t, async input => {
    calls.push(input);
    return { workflowId: 9, run: observed(complete ? {} : { status: "queued", conclusion: null }) };
  }, { pollIntervalSeconds: 1, timeoutSeconds: 3 });
  await until(async () => { const r = await p.store.factoryRun(runId); return r && stageOf(r, "deploy").attempts[0]?.summary.includes("queued") ? r : undefined; }, "first observation");
  await p.close();
  complete = true;
  const second = await openProcess(f);
  const run = await reach(second, runId, ["completed"]);
  assert.equal(calls.at(-1)!.runId, 22);
  assert.equal(calls.at(-1)!.workflowId, 9);
  assert.equal(stageOf(run, "deploy").attempts.length, 1);
  assert.equal(f.faux.state.callCount, 3);
});
