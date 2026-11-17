import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSteps, type TaskWorkflow } from "../tasks/workflow.ts";
import { taskWorkflowRunView } from "./task-workflows.ts";
import { buildWorkflowRun, buildWorkflows } from "./workflows.ts";
import { fixture } from "./fixture.ts";

function workflow(channelId = "C1"): TaskWorkflow {
  const steps = validateSteps(["Research", "Draft", "Verify"].map((name) => ({ name, directive: "secret directive", gates: ["secret gate"] })));
  Object.assign(steps[0]!, { status: "approved", output: "Found three primary sources.", attempt: 1, runKey: "secret-capability" });
  Object.assign(steps[1]!, { status: "submitted", output: "<script>window.injected=true</script>\nDraft result", attempt: 2, feedback: "Include citations" });
  return { id: "workflow_visibility", channelId, parentThreadKey: "1700000000.000100", parentTaskId: "task", revision: 5, status: "active", index: 1, steps,
    history: [{ revision: 1, at: 1_700_000_000_000, step: 0, actor: "parent", event: "created", detail: "secret history" }] };
}

test("task view: ordered native states, readable persisted results and no premature completion", () => {
  const w = workflow();
  const run = taskWorkflowRunView(w, false);
  assert.equal(run.kind, "task"); assert.equal(run.status, "waiting"); assert.equal(run.current, "Draft");
  assert.deepEqual(run.stages.map((s) => [s.name, s.status, s.taskStatus]), [["Research", "success", "approved"], ["Draft", "in_progress", "submitted"], ["Verify", "not_started", "ready"]]);
  assert.equal(run.stages[0]!.result?.summary, w.steps[0]!.output);
  assert.equal(run.stages[2]!.result?.available, false);
  assert.equal(run.stages[1]!.result?.feedback, "Include citations");
  assert.equal(run.guidance, undefined); assert.equal(run.mergeRule, undefined);
  assert.ok(!JSON.stringify(run).includes("secret"));
  w.steps[1]!.status = "return_requested";
  assert.equal(taskWorkflowRunView(w, false).status, "waiting");
  w.steps[1]!.status = "working";
  assert.equal(taskWorkflowRunView(w, false).status, "running");
  w.status = "aborted";
  assert.equal(taskWorkflowRunView(w, false).status, "aborted");
  w.status = "completed"; w.index = w.steps.length; w.steps.forEach((s) => { s.status = "approved"; });
  w.steps[2]!.output = "";
  const done = taskWorkflowRunView(w, false);
  assert.equal(done.current, "Verify"); assert.ok(done.endedAt);
  assert.equal(done.stages[2]!.status, "success"); assert.equal(done.stages[2]!.result?.available, false);
});

test("task view: bounded result excerpts and complete DM free-text redaction", () => {
  const w = workflow(); w.steps[0]!.output = "x".repeat(32_000);
  const result = taskWorkflowRunView(w, false).stages[0]!.result!;
  assert.equal(result.summary!.length, 6000); assert.equal(result.truncated, true);
  const dm = taskWorkflowRunView(w, true);
  assert.deepEqual(dm.stages.map((s) => s.name), ["Stage 1", "Stage 2", "Stage 3"]);
  assert.equal(dm.current, "Stage 2"); assert.equal(dm.stages[0]!.result?.available, true);
  for (const word of ["Research", "Draft", "Verify", "secret", "citations", "script"] ) assert.ok(!JSON.stringify(dm).includes(word));
});

test("task runs share the console list/detail without factory config; channel boundaries and factory visibility survive", async () => {
  const f = fixture();
  const base = f.source.runtime(f.channelId)!;
  const w = workflow(f.channelId);
  Object.assign(base.store, { listTaskWorkflows: async () => [w, { ...w, id: "workflow_other", channelId: "OTHER" }], taskWorkflow: async (id: string) => id === w.id ? w : id === "workflow_other" ? { ...w, channelId: "OTHER" } : undefined });
  const channel = f.source.channels()[0]!;
  const list = await buildWorkflows(f.source, channel);
  assert.ok(list.runs.some((r) => r.kind === "task")); assert.ok(list.runs.some((r) => r.runId === "frun_wait"));
  assert.ok(!list.runs.some((r) => r.runId === "workflow_other"));
  assert.ok(!JSON.stringify(list).includes("Draft result"), "list doesn't carry stage outputs");
  assert.equal((await buildWorkflowRun(f.source, channel, w.id))?.run.stages[1]!.result?.summary, w.steps[1]!.output);
  assert.equal(await buildWorkflowRun(f.source, channel, "workflow_other"), undefined);
  assert.equal(await buildWorkflowRun(f.source, channel, "workflow_missing"), undefined);
  const closed = { ...f.source, runtime: () => undefined };
  assert.deepEqual((await buildWorkflows(closed, channel)).runs, []);
  assert.equal(await buildWorkflowRun(closed, channel, w.id), undefined);
  const dm = await buildWorkflowRun(f.source, { ...channel, isDm: true }, w.id);
  assert.ok(!JSON.stringify(dm).includes("Draft"));
});

test("task runs are served by the existing channel-scoped HTTP list/detail routes", async () => {
  const f = fixture(); const w = workflow(f.channelId);
  Object.assign(f.source.runtime(f.channelId)!.store, { listTaskWorkflows: async () => [w], taskWorkflow: async (id: string) => id === w.id ? w : undefined });
  await f.server.start();
  try {
    const port = (f.server.address() as { port: number }).port;
    const get = (path: string) => fetch(`http://127.0.0.1:${port}/console2/api/v1/channels/${f.channelId}/workflows${path}`, { headers: { host: "console.test" } });
    const list = await (await get("")).json() as { runs: { runId: string }[] };
    assert.ok(list.runs.some((run) => run.runId === w.id));
    const one = await get(`/${w.id}`); assert.equal(one.status, 200);
    const body = await one.text(); assert.match(body, /Found three primary sources/); assert.ok(!body.includes("secret"));
    assert.equal((await get("/workflow_missing")).status, 404);
  } finally { await f.server.stop(); }
});


test("task activity never treats old persisted working as proof of execution and redacts diagnostics in DMs", () => {
  const w = workflow(); w.steps[1]!.status = "working";
  const unknown = taskWorkflowRunView(w, false, { actions: true, bump: true });
  assert.equal(unknown.taskActivity?.state, "unknown"); assert.match(unknown.taskActivity!.summary, /cause is unknown/);
  assert.deepEqual(unknown.taskControl, { revision: w.revision, actions: ["stop", "bump"] });
  assert.equal(unknown.taskActivity?.lastAt, undefined, "another step's creation is not this step's activity");
  const executing = taskWorkflowRunView(w, false, { executingAt: 1_700_000_100_000 });
  assert.equal(executing.taskActivity?.state, "executing"); assert.equal(executing.taskActivity?.lastAt, new Date(1_700_000_100_000).toISOString());
  w.steps[1]!.diagnostic = { at: 1_700_000_200_000, interrupted: false, detail: "blocked: secret unavailable connector" };
  const returned = taskWorkflowRunView(w, false);
  assert.equal(returned.taskActivity?.state, "waiting"); assert.match(returned.taskActivity!.diagnostic!, /blocked: secret/);
  w.steps[1]!.diagnostic!.interrupted = true;
  assert.equal(taskWorkflowRunView(w, false).taskActivity?.state, "interrupted");
  const paused = taskWorkflowRunView(w, false, { blocked: "secret interrupted shell tool" });
  assert.equal(paused.taskActivity?.state, "interrupted"); assert.match(paused.taskActivity!.diagnostic!, /interrupted shell/);
  const dm = taskWorkflowRunView(w, true, { blocked: "secret interrupted shell tool" });
  assert.ok(!JSON.stringify(dm).includes("secret")); assert.equal(dm.taskActivity?.diagnostic, undefined);
  w.status = "aborted";
  assert.deepEqual(taskWorkflowRunView(w, false, { actions: true, bump: true }).taskControl?.actions, []);
  assert.equal(taskWorkflowRunView(w, false).taskActivity?.state, "stopped");
});

test("task stop/bump HTTP controls work without factory config but retain authorization, revision and channel boundaries", async () => {
  const inspections: TaskWorkflow[] = [];
  const f = fixture({ actions: { service: () => undefined, pollNow: () => false, audit: () => {},
    inspectTaskWorkflow: async (_channel, w) => { inspections.push(w); } } });
  let w = workflow(f.channelId); w.steps[1]!.status = "working";
  Object.assign(f.source.runtime(f.channelId)!.store, {
    taskWorkflow: async (id: string) => id === w.id ? structuredClone(w) : undefined,
    changeTaskWorkflow: async (id: string, change: (current: TaskWorkflow | undefined) => TaskWorkflow) => {
      const next = change(id === w.id ? structuredClone(w) : undefined); w = structuredClone(next); return next;
    },
  });
  await f.server.start();
  try {
    const port = (f.server.address() as { port: number }).port;
    const root = "http://127.0.0.1:" + port + "/console2/api/v1/channels/" + f.channelId + "/workflows/";
    const post = (action: string, body: unknown = { revision: w.revision }, headers = {}, id = w.id) => fetch(root + id + "/actions/" + action, {
      method: "POST", headers: { host: "console.test", "content-type": "application/json", "x-console-action": "1", ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await post("stop", {}, { "x-console-action": "0" })).status, 403);
    assert.equal((await post("bump", { revision: w.revision }, { origin: "https://attacker.test" })).status, 403);
    assert.equal((await post("stop", { revision: w.revision, runKey: "forged" })).status, 400);
    assert.equal((await post("stop", {})).status, 400);
    assert.equal((await post("retry")).status, 404);
    assert.equal((await post("stop", { revision: 0 })).status, 409);
    assert.equal((await post("stop", { revision: w.revision }, {}, "workflow_missing")).status, 404);
    const bumped = await post("bump"); assert.equal(bumped.status, 200); assert.match(await bumped.text(), /No step was retried/);
    assert.equal(inspections[0]!.parentThreadKey, w.parentThreadKey); assert.equal(w.steps[1]!.attempt, 2);
    const old = w.revision;
    const stopped = await post("stop"); assert.equal(stopped.status, 200); assert.match(await stopped.text(), /authority invalidated/);
    assert.equal(w.status, "aborted"); assert.equal((await post("bump", { revision: old })).status, 409);
    w = { ...w, status: "active", channelId: "OTHER" };
    assert.equal((await post("stop")).status, 404);
  } finally { await f.server.stop(); }
});
