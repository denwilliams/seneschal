import { controlTaskWorkflow, workflowAttemptActivity } from "./workflow-controls.ts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore } from "../agent/durable/channel-store.ts";
import type { SubagentRunner, SubagentRunRequest } from "../agent/subagent-tools.ts";
import type { ResolvedSubagent } from "../workspace/subagents.ts";
import { createTaskWorkflowTools, type TaskWorkflowToolsContext } from "./workflow-tools.ts";
import { needsReworkDispatch, validateSteps, workflowNextAction, type TaskWorkflow, type WorkflowStepDefinition } from "./workflow.ts";
import { TaskWorkflowPresence } from "../slack/task-workflow-presence.ts";

async function fixture(t: TestContext, onChange?: (workflow: TaskWorkflow) => void) {
  const root = await mkdtemp(join(tmpdir(), "task-workflow-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const observed: TaskWorkflow[] = [];
  const options = { onTaskWorkflowChange: (workflow: TaskWorkflow) => { observed.push(workflow); onChange?.(workflow); }, storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"] };
  let store = await DurableChannelStore.open(options);
  const ctx: TaskWorkflowToolsContext = { channelId: "C1", threadKey: "parent", store: () => store, agents: [],
    runner: () => undefined, currentUserId: () => "U1", isApproved: () => false, parentTaskId: () => "task-1" };
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { ctx, observed, store: () => store, reopen: async () => { await store.close(); store = await DurableChannelStore.open(options); } };
}
function tools(ctx: TaskWorkflowToolsContext) {
  const map = new Map(createTaskWorkflowTools(ctx).map((tool) => [tool.name, tool]));
  return async (name: string, params: Record<string, unknown> = {}) => {
    const tool = map.get(name);
    assert.ok(tool, `Tool ${name} available`);
    return (await tool.execute("call", params as never, undefined, undefined, {} as never)).details as any;
  };
}
const definitions = ["research", "draft", "verify"].map((name) => ({ name, directive: `Do ${name}`, gates: [`${name} has evidence`] }));
const ref = (w: TaskWorkflow) => ({ workflowId: w.id, revision: w.revision });
const approval = { decision: "approve", feedback: "Meets the declared criteria", gates: [{ passed: true, evidence: "Inspected the output" }] };
async function create(call: ReturnType<typeof tools>, steps: WorkflowStepDefinition[] = definitions): Promise<TaskWorkflow> {
  return call("create_task_workflow", { steps });
}
async function run(call: ReturnType<typeof tools>, w: TaskWorkflow): Promise<TaskWorkflow> {
  return (await call("run_task_workflow_step", ref(w))).workflow;
}
async function submit(call: ReturnType<typeof tools>, w: TaskWorkflow, output = "Evidence and result"): Promise<TaskWorkflow> {
  return call("submit_task_workflow_step", { ...ref(w), output });
}
async function approve(call: ReturnType<typeof tools>, w: TaskWorkflow): Promise<TaskWorkflow> {
  return call("decide_task_workflow_step", { ...ref(w), ...approval });
}

test("three-step workflow: explicit gates, failed-gate rework, return/resubmission and final approval survive reopen", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await create(call);
  assert.equal(w.parentTaskId, "task-1");
  assert.equal((await call("check_task_workflow"))[0].id, w.id);
  await assert.rejects(approve(call, w), /Only a submitted/);
  w = await submit(call, await run(call, w), "Research sources");
  assert.equal(w.index, 0, "submission never advances");
  await assert.rejects(call("decide_task_workflow_step", { ...ref(w), ...approval, gates: [] }), /every declared gate/);
  await assert.rejects(call("decide_task_workflow_step", { ...ref(w), ...approval, gates: [{ passed: false, evidence: "Missing source" }] }), /every declared gate/);
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "rework", feedback: "Add primary source", gates: [{ passed: false, evidence: "Missing source" }] });
  const rework = await call("run_task_workflow_step", ref(w)); w = rework.workflow;
  assert.match(rework.brief, /Add primary source/);
  w = await approve(call, await submit(call, w, "Primary source provided"));
  assert.equal(w.index, 1);
  const second = await call("run_task_workflow_step", ref(w)); w = second.workflow;
  assert.match(second.brief, /Primary source provided/);
  assert.match(second.brief, /step 2\/3/);
  w = await approve(call, await submit(call, w, "Draft v1"));
  w = await run(call, w);
  w = await call("request_task_workflow_return", { ...ref(w), reason: "Draft misses a requirement" });
  assert.equal(w.index, 2, "request does not move backward");
  await f.reopen();
  assert.deepEqual(await call("check_task_workflow", { workflowId: w.id }), w);
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "return", feedback: "Revise draft to cover the requirement" });
  assert.equal(w.index, 1);
  assert.deepEqual(w.steps.map((step) => step.status), ["approved", "ready", "ready"]);
  assert.match(w.steps[1]!.feedback, /Draft misses a requirement/);
  assert.match(w.steps[1]!.feedback, /Revise draft/);
  w = await approve(call, await submit(call, await run(call, w), "Draft v2"));
  w = await submit(call, await run(call, w), "Verified v2");
  assert.equal(w.status, "active", "final submission still awaits approval");
  await f.reopen();
  w = await approve(call, w);
  assert.equal(w.status, "completed");
  assert.equal(w.index, 3);
  assert.equal(w.history.filter((event) => event.event === "submitted").length, 5);
  assert.ok(w.history.some((event) => event.event === "rework" && event.detail.includes("Missing source")));
  assert.ok(w.history.some((event) => event.event === "return_requested" && event.detail.includes("Draft misses")));
  assert.ok(w.history.some((event) => event.event === "approved" && event.detail.includes("Inspected")));
  await assert.rejects(call("run_task_workflow_step", ref(w)), /completed/);
});

test("invalid, stale, concurrent and unauthorized transitions leave durable state unchanged", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await create(call);
  const other = tools({ ...f.ctx, threadKey: "other" });
  assert.deepEqual(await other("check_task_workflow"), []);
  await assert.rejects(other("check_task_workflow", { workflowId: w.id }), /another parent/);
  await assert.rejects(other("run_task_workflow_step", ref(w)), /another parent/);
  const wrongChannel = tools({ ...f.ctx, channelId: "C2" });
  await assert.rejects(wrongChannel("check_task_workflow", { workflowId: w.id }), /another channel/);
  await assert.rejects(submit(call, w), /not working/);
  await assert.rejects(call("decide_task_workflow_step", { ...ref(w), decision: "return", feedback: "go back" }), /downstream/);
  w = await run(call, w);
  await assert.rejects(call("request_task_workflow_return", { ...ref(w), reason: "go back" }), /first step/);
  const before = structuredClone(w);
  await assert.rejects(call("submit_task_workflow_step", { ...ref(w), revision: w.revision - 1, output: "stale" }), /Stale workflow/);
  assert.deepEqual(await f.store().taskWorkflow(w.id), before);
  const raced = await Promise.allSettled([submit(call, w, "one"), submit(call, w, "two")]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  w = (await f.store().taskWorkflow(w.id))!;
  await assert.rejects(submit(call, w), /not working/);
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "abort", feedback: "Stop task" });
  await assert.rejects(call("run_task_workflow_step", ref(w)), /aborted/);
});

test("subagents only get scoped participant tools and cannot submit for another attempt or advance themselves", async (t) => {
  const f = await fixture(t);
  const role = { name: "writer", requireApproval: true } as ResolvedSubagent;
  let approved = false;
  let captured!: SubagentRunRequest;
  let mode: "submit" | "none" | "throw" = "submit";
  const runner: SubagentRunner = { run: async (request) => {
    captured = request;
    if (mode === "throw") throw new Error("Interrupted after possible side effect");
    const participantCtx = { ...f.ctx, threadKey: request.runKey!, participant: request.workflow! };
    const names = createTaskWorkflowTools(participantCtx).map((tool) => tool.name);
    assert.deepEqual(names, ["check_task_workflow", "submit_task_workflow_step", "request_task_workflow_return"]);
    const worker = tools(participantCtx);
    const current: TaskWorkflow = await worker("check_task_workflow");
    assert.match(request.task, /priorApprovedOutput/);
    if (mode === "submit") await submit(worker, current, "Writer's actual output");
    return { agent: "writer", status: "done", summary: "Done", runKey: request.runKey! };
  } };
  const call = tools({ ...f.ctx, agents: [role], isApproved: () => approved, runner: () => runner });
  let w = await create(call, [{ ...definitions[0]!, agent: "writer" }]);
  await assert.rejects(run(call, w), /person's approval/);
  assert.equal((await f.store().taskWorkflow(w.id))!.revision, w.revision);
  approved = true;
  w = (await call("run_task_workflow_step", ref(w))).workflow;
  assert.equal(w.steps[0]!.status, "submitted");
  assert.equal(w.status, "active");
  assert.equal(captured.userId, "U1");
  assert.equal(captured.runKey, captured.workflow!.runKey);
  await assert.rejects(submit(call, w), /Only the assigned/);
  const worker = tools({ ...f.ctx, participant: captured.workflow! });
  const forged = tools({ ...f.ctx, participant: { ...captured.workflow!, runKey: "forged" } });
  await assert.rejects(forged("check_task_workflow"), /stale or unauthorized/);
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "rework", feedback: "Add a citation" });
  await assert.rejects(worker("check_task_workflow"), /stale or unauthorized/);
  approved = false;
  await assert.rejects(run(call, w), /person's approval/);
  assert.equal((await f.store().taskWorkflow(w.id))!.revision, w.revision, "rework continuation cannot bypass role access");
  approved = true;
  mode = "none";
  w = (await call("run_task_workflow_step", ref(w))).workflow;
  assert.equal(w.steps[0]!.status, "working", "a final report alone does not submit");
  const interruptedAttempt = tools({ ...f.ctx, participant: captured.workflow! });
  await f.reopen();
  assert.equal((await f.store().taskWorkflow(w.id))!.steps[0]!.status, "working");
  await assert.rejects(run(call, w), /explicit retry/);
  mode = "throw";
  await assert.rejects(call("run_task_workflow_step", { ...ref(w), retry: true }), /Interrupted after/);
  w = (await f.store().taskWorkflow(w.id))!;
  await assert.rejects(interruptedAttempt("check_task_workflow"), /stale or unauthorized/);
  assert.equal(w.steps[0]!.attempt, 3);
  mode = "submit";
  w = (await call("run_task_workflow_step", { ...ref(w), retry: true })).workflow;
  w = await approve(call, w);
  assert.equal(w.status, "completed");
});

async function correct(call: ReturnType<typeof tools>, w: TaskWorkflow, edits: { step: number; directive?: string; gates?: string[] }[]): Promise<TaskWorkflow> {
  return call("edit_task_workflow", { ...ref(w), edits, reason: "Correct the misunderstood requirements" });
}

test("definition corrections persist with their reasons and old definitions and drive subsequent briefs and gates", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  const original = await create(call);
  let w = await correct(call, original, [
    { step: 3, directive: "Verify primary sources" },
    { step: 1, directive: "Gather primary sources only", gates: ["Primary sources supplied", "Dates checked"] },
  ]);
  assert.equal(w.id, original.id);
  assert.equal(w.parentTaskId, original.parentTaskId);
  assert.equal(w.revision, original.revision + 1);
  assert.equal(w.steps[1]!.directive, original.steps[1]!.directive);
  assert.equal(w.steps[0]!.attempt, 0);
  const correction = w.history.at(-1)!;
  assert.equal(correction.event, "definition_corrected");
  assert.equal(correction.actor, "parent");
  assert.deepEqual(JSON.parse(correction.detail), {
    reason: "Correct the misunderstood requirements", invalidatedFrom: 1,
    changes: [
      { step: 3, before: { directive: definitions[2]!.directive, gates: definitions[2]!.gates },
        after: { directive: "Verify primary sources", gates: definitions[2]!.gates } },
      { step: 1, before: { directive: definitions[0]!.directive, gates: definitions[0]!.gates },
        after: { directive: "Gather primary sources only", gates: ["Primary sources supplied", "Dates checked"] } },
    ],
  });
  await f.reopen();
  assert.deepEqual(await call("check_task_workflow", { workflowId: w.id }), w);
  assert.deepEqual((await call("check_task_workflow"))[0], w);
  const started = await call("run_task_workflow_step", ref(w)); w = started.workflow;
  assert.match(started.brief, /Gather primary sources only/);
  assert.match(started.brief, /Dates checked/);
  assert.match(started.brief, /Verify primary sources/);
  w = await submit(call, w, "Primary sources and their dates");
  await assert.rejects(approve(call, w), /every declared gate/);
  w = await call("decide_task_workflow_step", { ...ref(w), ...approval, gates: [approval.gates[0], approval.gates[0]] });
  for (let index = 1; index < w.steps.length; index++) w = await approve(call, await submit(call, await run(call, w)));
  assert.equal(w.status, "completed");
});

test("correcting approved work invalidates its submission and downstream work, preserving prior audit history", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await create(call);
  w = await approve(call, await submit(call, await run(call, w), "Old research result"));
  w = await submit(call, await run(call, w), "Old downstream draft");
  const before = structuredClone(w);
  w = await correct(call, w, [{ step: 1, gates: ["Research must cite primary sources"] }]);
  assert.equal(w.index, 0);
  assert.equal(w.status, "active");
  assert.deepEqual(w.steps.map((s) => s.status), ["ready", "ready", "ready"]);
  assert.ok(w.steps.every((s) => !s.runKey && !s.output));
  assert.equal(w.steps[0]!.attempt, 1, "corrections do not reset attempt counters");
  assert.deepEqual(w.history.slice(0, -1), before.history);
  assert.ok(w.history.some((entry) => entry.event === "submitted" && entry.detail === "Old research result"));
  assert.ok(w.history.some((entry) => entry.event === "submitted" && entry.detail === "Old downstream draft"));
  await assert.rejects(approve(call, before), /Stale workflow/);
  await assert.rejects(approve(call, w), /Only a submitted/);
  await f.reopen();
  assert.deepEqual(await call("check_task_workflow", { workflowId: w.id }), w);
  w = await run(call, w);
  assert.equal(w.steps[0]!.attempt, 2);
  w = await approve(call, await submit(call, w, "Corrected research"));
  const downstream = await call("run_task_workflow_step", ref(w)); w = downstream.workflow;
  assert.match(downstream.brief, /Corrected research/);
  assert.doesNotMatch(downstream.brief, /Old research result|Old downstream draft/);
  w = await approve(call, await submit(call, w, "Fresh draft"));
  w = await approve(call, await submit(call, await run(call, w)));
  assert.equal(w.status, "completed");
});

for (const status of ["submitted", "return_requested"] as const) {
  test("correcting a " + status + " step revokes old worker authority even with a refreshed revision", async (t) => {
    const f = await fixture(t); const call = tools(f.ctx);
    let w = await create(call);
    w = await approve(call, await submit(call, await run(call, w)));
    w = await run(call, w);
    const worker = tools({ ...f.ctx, participant: { workflowId: w.id, index: w.index, runKey: w.steps[w.index]!.runKey } });
    w = status === "submitted" ? await submit(worker, w, "Obsolete draft")
      : await worker("request_task_workflow_return", { ...ref(w), reason: "Old return request" });
    const previous = structuredClone(w);
    w = await correct(call, w, [{ step: 2, directive: "Write the corrected draft" }]);
    assert.equal(w.index, 1);
    assert.deepEqual(w.steps[0], previous.steps[0], "unaffected upstream approval survives");
    assert.equal(w.steps[1]!.status, "ready");
    assert.equal(w.steps[1]!.output, "");
    assert.equal(w.steps[1]!.runKey, "");
    await assert.rejects(worker("check_task_workflow"), /stale or unauthorized/);
    await assert.rejects(submit(worker, w), /stale or unauthorized/);
    await assert.rejects(approve(call, w), /Only a submitted/);
    w = await run(call, w);
    await assert.rejects(submit(worker, w), /stale or unauthorized/);
    await assert.rejects(worker("request_task_workflow_return", { ...ref(w), reason: "stale" }), /stale or unauthorized/);
    w = await approve(call, await submit(call, w, "New draft"));
    assert.equal(w.index, 2);
  });
}

test("an assigned worker must finish before correction and its replacement receives the corrected brief", async (t) => {
  const f = await fixture(t);
  let captured!: SubagentRunRequest;
  const runner: SubagentRunner = { run: async (request) => {
    captured = request;
    return { agent: "writer", status: "done", summary: "Inspect this interrupted attempt", runKey: request.runKey! };
  } };
  const call = tools({ ...f.ctx, agents: [{ name: "writer" } as ResolvedSubagent], runner: () => runner });
  let w = await run(call, await create(call, [{ ...definitions[0]!, agent: "writer" }]));
  await assert.rejects(correct(call, w, [{ step: 1, directive: "Corrected worker directive" }]), /Cannot edit while a step is working/);
  assert.deepEqual(await f.store().taskWorkflow(w.id), w);
  const oldWorker = tools({ ...f.ctx, participant: captured.workflow! });
  w = await submit(oldWorker, w, "Old worker output");
  w = await correct(call, w, [{ step: 1, directive: "Corrected worker directive" }]);
  w = await run(call, w);
  assert.match(captured.task, /Corrected worker directive/);
  assert.doesNotMatch(captured.task, /Old worker output/);
  assert.equal(w.steps[0]!.attempt, 2);
  await assert.rejects(submit(oldWorker, w), /stale or unauthorized/);
  const newWorker = tools({ ...f.ctx, participant: captured.workflow! });
  w = await approve(call, await submit(newWorker, w, "Corrected worker output"));
  assert.equal(w.status, "completed");
});

test("future corrections preserve the current submission but invalidate stale review revisions", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  const submitted = await submit(call, await run(call, await create(call)));
  let w = await correct(call, submitted, [
    { step: 1, directive: "  " + submitted.steps[0]!.directive + "  " },
    { step: 3, gates: ["Verify with updated criteria"] },
  ]);
  assert.equal(w.index, 0);
  assert.deepEqual(w.steps[0], submitted.steps[0]);
  await assert.rejects(approve(call, submitted), /Stale workflow/);
  w = await approve(call, w);
  assert.equal(w.index, 1);
});

test("working and interrupted attempts reject all corrections atomically, including future-only edits", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await run(call, await create(call));
  for (const step of [1, 3]) {
    await assert.rejects(correct(call, w, [{ step, directive: "Changed" }]), /Cannot edit while a step is working/);
    assert.deepEqual(await f.store().taskWorkflow(w.id), w);
  }
  await f.reopen();
  await assert.rejects(correct(call, w, [{ step: 2, gates: ["Changed"] }]), /including interrupted attempts/);
  assert.deepEqual(await f.store().taskWorkflow(w.id), w);
  w = await submit(call, w);
  w = await correct(call, w, [{ step: 1, directive: "Safely corrected after submission" }]);
  assert.equal(w.steps[0]!.status, "ready");
});

test("corrections validate all patches before committing and enforce parent/channel/revision/lifecycle boundaries", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  const w = await create(call);
  for (const edits of [
    [], [{ step: 0, directive: "x" }], [{ step: 4, directive: "x" }], [{ step: 1.5, directive: "x" }],
    [{ step: 1 }], [{ step: 1, directive: " " }], [{ step: 1, gates: [] }], [{ step: 1, gates: [" "] }],
    [{ step: 1, directive: "x" }, { step: 1, gates: ["y"] }],
    [{ step: 1, directive: "Valid correction" }, { step: 2, gates: [] }],
    [{ step: 1, directive: "  " + definitions[0]!.directive + " " }],
    [{ step: 1, gates: definitions[0]!.gates }],
  ]) {
    await assert.rejects(correct(call, w, edits));
    assert.deepEqual(await f.store().taskWorkflow(w.id), w);
  }
  await assert.rejects(call("edit_task_workflow", { ...ref(w), reason: " ", edits: [{ step: 1, directive: "x" }] }), /Correction reason/);
  await assert.rejects(correct(tools({ ...f.ctx, threadKey: "other" }), w, [{ step: 1, directive: "x" }]), /another parent/);
  await assert.rejects(correct(tools({ ...f.ctx, channelId: "C2" }), w, [{ step: 1, directive: "x" }]), /another channel/);
  const edited = await correct(call, w, [{ step: 1, directive: "New requirements" }]);
  await assert.rejects(correct(call, w, [{ step: 1, directive: "Stale" }]), /Stale workflow/);
  const completed = await approve(call, await submit(call, await run(call, await create(call, [definitions[0]!]))));
  await assert.rejects(correct(call, completed, [{ step: 1, directive: "x" }]), /completed/);
  const aborted = await call("decide_task_workflow_step", { ...ref(edited), decision: "abort", feedback: "Stop" });
  await assert.rejects(correct(call, aborted, [{ step: 1, directive: "x" }]), /aborted/);
});

test("racing corrections and reviews or starts have a single winner with no partial changes", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  for (const competitor of ["edit", "run", "approve"]) {
    let w = await create(call);
    if (competitor === "approve") w = await submit(call, await run(call, w));
    const raced = await Promise.allSettled([
      correct(call, w, [{ step: 1, directive: "First correction" }]),
      competitor === "edit" ? correct(call, w, [{ step: 2, directive: "Second correction" }])
        : competitor === "run" ? run(call, w) : approve(call, w),
    ]);
    assert.equal(raced.filter((entry) => entry.status === "fulfilled").length, 1);
    const winner = raced.find((entry) => entry.status === "fulfilled") as PromiseFulfilledResult<TaskWorkflow>;
    assert.deepEqual(await f.store().taskWorkflow(w.id), winner.value);
    assert.equal(winner.value.revision, w.revision + 1);
    await assert.rejects(submit(call, w), /Stale workflow/);
  }
});

test("definition and runtime availability validation", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  for (const steps of [[], [{ ...definitions[0]!, gates: [] }], [definitions[0]!, definitions[0]!], [{ ...definitions[0]!, directive: " " }]]) {
    assert.throws(() => validateSteps(steps));
  }
  await assert.rejects(create(call, [{ ...definitions[0]!, agent: "unknown" }]), /Unknown subagent/);
  await assert.rejects(create(tools({ ...f.ctx, parentTaskId: () => undefined })), /No active parent/);
  await assert.rejects(create(tools({ ...f.ctx, store: () => undefined })), /not available/);
  const withRole = tools({ ...f.ctx, agents: [{ name: "writer" } as ResolvedSubagent] });
  const w = await create(withRole, [{ ...definitions[0]!, agent: "writer" }]);
  await assert.rejects(run(withRole, w), /not available/);
});


test("visibility: committed worker changes notify observers; Slack metadata and all-thread listing survive restart without changing revision", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await create(call);
  assert.equal(f.observed.at(-1)?.id, w.id);
  const revision = w.revision; const count = f.observed.length;
  await f.store().setTaskWorkflowSlack(w.id, "1700000001.000100", "channel");
  assert.equal(f.observed.length, count);
  assert.equal((await f.store().taskWorkflow(w.id))?.revision, revision);
  w = await run(call, w);
  w = await submit(call, w);
  assert.equal(f.observed.at(-1)?.steps[0]?.status, "submitted");
  await f.reopen();
  assert.deepEqual((await f.store().taskWorkflow(w.id))?.slack, { ts: "1700000001.000100", location: "channel" });
  assert.equal((await f.store().listTaskWorkflows()).length, 1);
  assert.equal((await f.store().listTaskWorkflows("another-thread")).length, 0);
});


test("rework responses expose exact dispatch guidance; state classifications never grant retry or approval", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await submit(call, await run(call, await create(call)), "Original categorization");
  const decide = createTaskWorkflowTools(f.ctx).find((tool) => tool.name === "decide_task_workflow_step")!;
  const response = await decide.execute("call", { ...ref(w), decision: "rework", feedback: "Fix categorization" } as never, undefined, undefined, {} as never);
  w = response.details as TaskWorkflow;
  const content = JSON.parse((response.content[0] as { text: string }).text);
  assert.match(content.nextAction, /run_task_workflow_step/);
  assert.match(content.nextAction, /no retry/);
  assert.ok(content.nextAction.includes(JSON.stringify(ref(w))));
  assert.equal(needsReworkDispatch(w), true);
  assert.match(workflowNextAction(w), /not a safety\/access block/);
  w = await run(call, w);
  assert.equal(needsReworkDispatch(w), false);
  assert.match(workflowNextAction(w), /inspect its runKey and effects/);
  await assert.rejects(run(call, w), /explicit retry=true/);
  await assert.rejects(approve(call, w), /Only a submitted/);
  w = await submit(call, w);
  assert.equal(needsReworkDispatch(w), false);
  assert.match(workflowNextAction(w), /independent parent gate review/);
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "abort", feedback: "Stop" });
  assert.equal(needsReworkDispatch(w), false);
  assert.match(workflowNextAction(w), /aborted; no dispatch/);
});

test("pending rework is step-local and survives future edits, but not a subsequent dispatch", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await create(call);
  assert.equal(needsReworkDispatch(w), false, "initial readiness is not rework");
  w = await submit(call, await run(call, w));
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "rework", feedback: "Fix categories" });
  w = await correct(call, w, [{ step: 2, directive: "Clarify the future draft" }]);
  assert.equal(w.history.at(-1)!.event, "definition_corrected");
  assert.equal(needsReworkDispatch(w), true);
  await f.reopen();
  w = (await f.store().taskWorkflow(w.id))!;
  assert.equal(needsReworkDispatch(w), true);
  w = await call("defer_task_workflow_step", { ...ref(w), dependency: "Source owner must provide mapping" });
  w = await correct(call, w, [{ step: 2, directive: "Another future clarification" }]);
  assert.equal(needsReworkDispatch(w), false, "future edits do not erase a real dependency");
  w = await submit(call, await run(call, w));
  // A correction after the next dispatch is not undispatched rework from the earlier attempt.
  w = await correct(call, w, [{ step: 1, directive: "Updated categorization requirements" }]);
  assert.equal(needsReworkDispatch(w), false);
  assert.equal(w.steps[0]!.status, "ready");
  assert.equal(w.steps[0]!.attempt, 2);
});

test("dispatch deferral is parent/channel/revision bound, validates input and cannot mask working or submitted work", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await create(call);
  const defer = (actor: ReturnType<typeof tools>, workflow = w, dependency = "Person must supply source data") =>
    actor("defer_task_workflow_step", { ...ref(workflow), dependency });
  await assert.rejects(defer(tools({ ...f.ctx, threadKey: "other" })), /another parent/);
  await assert.rejects(defer(tools({ ...f.ctx, channelId: "C2" })), /another channel/);
  await assert.rejects(defer(call, w, "  "), /External dependency/);
  await assert.rejects(defer(call, w, "x".repeat(32_001)), /External dependency/);
  w = await run(call, w);
  await assert.rejects(defer(call), /Only a ready/);
  w = await submit(call, w);
  await assert.rejects(defer(call), /Only a ready/);
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "rework", feedback: "Correct categories" });
  const ready = w;
  w = await defer(call);
  assert.equal(w.steps[0]!.status, "ready");
  assert.equal(w.steps[0]!.attempt, 1);
  assert.equal(w.steps[0]!.feedback, "Correct categories");
  assert.equal(needsReworkDispatch(w), false);
  await assert.rejects(run(call, ready), /Stale workflow/);
  await f.reopen();
  assert.deepEqual(await f.store().taskWorkflow(w.id), w);
  w = await run(call, w);
  assert.equal(w.steps[0]!.dispatchDependency, undefined);
  assert.equal(w.steps[0]!.attempt, 2);
  assert.ok(!createTaskWorkflowTools({ ...f.ctx, participant: { workflowId: w.id, index: 0, runKey: w.steps[0]!.runKey } })
    .some((tool) => tool.name === "defer_task_workflow_step"));
});

test("concurrent rework dispatch and deferral have one revision winner; stale continuation cannot duplicate work", async (t) => {
  for (const race of ["dispatch", "defer"] as const) {
    const f = await fixture(t); const call = tools(f.ctx);
    let w = await submit(call, await run(call, await create(call)));
    w = await call("decide_task_workflow_step", { ...ref(w), decision: "rework", feedback: "Fix" });
    const ready = structuredClone(w);
    const outcomes = await Promise.allSettled([
      run(call, ready),
      race === "dispatch" ? run(call, ready) : call("defer_task_workflow_step", { ...ref(ready), dependency: "Await data owner" }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    w = (await f.store().taskWorkflow(w.id))!;
    assert.ok(w.steps[0]!.attempt === 1 || w.steps[0]!.attempt === 2);
    assert.equal(w.history.filter((event) => event.event === "started").length, w.steps[0]!.attempt);
    await assert.rejects(run(call, ready), /Stale workflow/);
    assert.deepEqual(await f.store().taskWorkflow(w.id), w);
  }
});

test("console bump preserves pending rework and dependencies; dispatch clears attempt metadata and stop prevents continuation", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await submit(call, await run(call, await create(call)));
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "rework", feedback: "Fix categorization" });
  // A finished subagent may leave presentation-only diagnostics from its prior attempt.
  await f.store().changeTaskWorkflow(w.id, (current) => {
    current!.steps[0]!.diagnostic = { at: Date.now(), interrupted: false, detail: "Previous attempt finished" };
    return current!;
  });
  const bump = async (pending: boolean) => {
    await controlTaskWorkflow({ store: f.store(), channelId: "C1", workflowId: w.id, revision: w.revision, action: "bump",
      inspect: async (workflow) => { assert.equal(needsReworkDispatch(workflow), pending); } });
    w = (await f.store().taskWorkflow(w.id))!;
    assert.equal(w.history.at(-1)!.event, "bumped");
    assert.equal(needsReworkDispatch(w), pending);
  };
  await bump(true);
  assert.equal(w.steps[0]!.attempt, 1, "a bump does not dispatch the ready step");
  w = await call("defer_task_workflow_step", { ...ref(w), dependency: "Await primary source from owner" });
  await bump(false);
  await f.reopen();
  w = (await f.store().taskWorkflow(w.id))!;
  assert.equal(needsReworkDispatch(w), false, "the recorded dependency survives bump and restart");
  w = await run(call, w);
  assert.equal(w.steps[0]!.attempt, 2);
  assert.equal(w.steps[0]!.dispatchDependency, undefined);
  assert.equal(w.steps[0]!.diagnostic, undefined);
  w = await submit(call, w);
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "rework", feedback: "Review source again" });
  assert.equal(needsReworkDispatch(w), true);
  await controlTaskWorkflow({ store: f.store(), channelId: "C1", workflowId: w.id, revision: w.revision, action: "stop",
    inspect: async () => { throw new Error("stop must not prompt the parent"); } });
  w = (await f.store().taskWorkflow(w.id))!;
  assert.equal(needsReworkDispatch(w), false);
  await assert.rejects(run(call, w), /aborted/);
});

test("console stop atomically revokes late worker submissions, survives restart and refuses stale/cross-channel controls", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  let w = await run(call, await create(call));
  const worker = tools({ ...f.ctx, participant: { workflowId: w.id, index: 0, runKey: w.steps[0]!.runKey } });
  const control = (action: "stop" | "bump", revision = w.revision, channelId = "C1") => controlTaskWorkflow({
    store: f.store(), channelId, workflowId: w.id, revision, action, inspect: async () => { throw new Error("must not inspect"); },
  });
  await assert.rejects(control("stop", w.revision, "C2"), /No task workflow/);
  await assert.rejects(control("stop", w.revision - 1), /Stale workflow/);
  const message = await control("stop");
  assert.match(message, /No live worker/); assert.match(message, /not undone/);
  w = (await f.store().taskWorkflow(w.id))!;
  assert.equal(w.status, "aborted"); assert.ok(w.steps.every((step) => !step.runKey));
  await assert.rejects(worker("submit_task_workflow_step", { ...ref(w), output: "late side effect result" }), /stale or unauthorized/);
  await assert.rejects(submit(call, w), /aborted/);
  await assert.rejects(run(call, w), /aborted/);
  await assert.rejects(control("bump"), /aborted/);
  await f.reopen(); assert.deepEqual(await f.store().taskWorkflow(w.id), w);
});

test("bump targets only the owning conversation, preserves the attempt and has one winner against concurrent stop", async (t) => {
  const f = await fixture(t); const call = tools(f.ctx);
  const w = await run(call, await create(call));
  const inspections: TaskWorkflow[] = [];
  const control = (action: "stop" | "bump", revision = w.revision) => controlTaskWorkflow({ store: f.store(), channelId: "C1", workflowId: w.id, revision, action,
    inspect: async (workflow) => { inspections.push(workflow); } });
  const message = await control("bump");
  assert.match(message, /No step was retried/); assert.equal(inspections.length, 1);
  assert.equal(inspections[0]!.parentThreadKey, "parent");
  assert.deepEqual(inspections[0]!.steps, w.steps); assert.equal(inspections[0]!.revision, w.revision + 1);
  const raced = await Promise.allSettled([control("bump", w.revision + 1), control("stop", w.revision + 1)]);
  assert.equal(raced.filter((entry) => entry.status === "fulfilled").length, 1);
  const current = (await f.store().taskWorkflow(w.id))!;
  assert.equal(current.revision, w.revision + 2);
});

test("stop requests live cancellation; bump never starts another worker and retry cannot duplicate a live attempt", async (t) => {
  const f = await fixture(t);
  let request!: SubagentRunRequest;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let runs = 0;
  const call = tools({ ...f.ctx, agents: [{ name: "writer" } as ResolvedSubagent], runner: () => ({ run: async (input) => {
    runs++; request = input; started(); await gate;
    return { agent: "writer", status: "done", summary: "Late report", runKey: input.runKey! };
  } }) });
  const w = await create(call, [{ ...definitions[0]!, agent: "writer" }]);
  const running = call("run_task_workflow_step", ref(w)); await ready;
  let current = (await f.store().taskWorkflow(w.id))!;
  assert.ok(workflowAttemptActivity(f.store(), request.runKey!));
  request.onActivity?.();
  await assert.rejects(call("run_task_workflow_step", { ...ref(current), retry: true }), /still executing/);
  let inspected = 0;
  await controlTaskWorkflow({ store: f.store(), channelId: "C1", workflowId: w.id, revision: current.revision, action: "bump", inspect: async () => { inspected++; } });
  assert.equal(inspected, 1); assert.equal(runs, 1); assert.equal(request.signal?.aborted, false);
  current = (await f.store().taskWorkflow(w.id))!;
  const message = await controlTaskWorkflow({ store: f.store(), channelId: "C1", workflowId: w.id, revision: current.revision, action: "stop", inspect: async () => {} });
  assert.match(message, /Cancellation requested/); assert.equal(request.signal?.aborted, true);
  assert.equal(workflowAttemptActivity(f.store(), request.runKey!), undefined);
  release(); await running;
  current = (await f.store().taskWorkflow(w.id))!;
  assert.equal(current.status, "aborted"); assert.equal(current.steps[0]!.diagnostic, undefined);
});

test("stop between committed intent and worker launch prevents launch entirely", async (t) => {
  const f = await fixture(t); let runs = 0;
  const call = tools({ ...f.ctx, agents: [{ name: "writer" } as ResolvedSubagent], runner: () => ({ run: async () => { runs++; throw new Error("must not run"); } }),
    onChange: async (w) => { if (w.steps[0]!.status === "working") await controlTaskWorkflow({ store: f.store(), channelId: "C1", workflowId: w.id,
      revision: w.revision, action: "stop", inspect: async () => {} }); },
  });
  const w = await create(call, [{ ...definitions[0]!, agent: "writer" }]);
  await assert.rejects(call("run_task_workflow_step", ref(w)), /stale or unauthorized/);
  assert.equal(runs, 0); assert.equal((await f.store().taskWorkflow(w.id))!.status, "aborted");
});

test("finished and interrupted non-submitting attempts retain diagnostics, not execution authority", async (t) => {
  const f = await fixture(t);
  let fail = false;
  const call = tools({ ...f.ctx, agents: [{ name: "writer" } as ResolvedSubagent], runner: () => ({ run: async (input) => {
    if (fail) throw new Error("Connection lost after possible external effects");
    return { agent: "writer", status: "blocked", summary: "Missing ingredient source", runKey: input.runKey! };
  } }) });
  let w = await create(call, [{ ...definitions[0]!, agent: "writer" }]);
  w = (await call("run_task_workflow_step", ref(w))).workflow;
  assert.equal(w.steps[0]!.status, "working"); assert.match(w.steps[0]!.diagnostic!.detail, /blocked: Missing/);
  assert.equal(workflowAttemptActivity(f.store(), w.steps[0]!.runKey), undefined);
  fail = true; await assert.rejects(call("run_task_workflow_step", { ...ref(w), retry: true }), /Connection lost/);
  w = (await f.store().taskWorkflow(w.id))!;
  assert.equal(w.steps[0]!.diagnostic!.interrupted, true);
  await f.reopen(); assert.deepEqual((await f.store().taskWorkflow(w.id))!.steps[0]!.diagnostic, w.steps[0]!.diagnostic);
});

test("committed threaded workflows draw one channel card; real-store restart reconciliation never executes or advances work", async (t) => {
  let presence: TaskWorkflowPresence;
  const f = await fixture(t, (workflow) => presence.notify("C1", workflow));
  f.ctx.threadKey = "1700000000.000100";
  const call = tools(f.ctx);
  const posts: { threadTs?: string; text: string }[] = [];
  const updates: { ts: string; text: string }[] = [];
  const deps = {
    store: () => f.store(),
    // flush() drives the observer, without timers racing store shutdown/reopen.
    schedule: () => () => {},
    slack: {
      post: async (args: { threadTs?: string; text: string }) => { posts.push(args); return { ts: "1700000001.000100" }; },
      update: async (args: { ts: string; text: string }) => { updates.push(args); },
      permalink: async () => "https://example.slack.com/archives/C1/p1700000000000100",
    },
  };
  presence = new TaskWorkflowPresence(deps);
  let w = await create(call);
  await presence.flush();
  assert.equal(posts.length, 1); assert.equal(posts[0]!.threadTs, undefined);
  assert.equal(f.observed.length, 1, "persisting card metadata does not notify or execute work");
  assert.deepEqual((await f.store().taskWorkflow(w.id))!.slack, { ts: "1700000001.000100", location: "channel" });
  const settled = async () => {
    await presence.flush();
    assert.equal(posts.length, 1);
    assert.ok(updates.every((update) => update.ts === "1700000001.000100"));
  };
  w = await run(call, w); await settled(); assert.match(updates.at(-1)!.text, /Working/);
  const beforeRestart = await f.store().taskWorkflow(w.id);
  const observed = f.observed.length;
  await f.reopen();
  presence = new TaskWorkflowPresence(deps);
  await presence.catchUp("C1"); await presence.catchUp("C1"); await settled();
  assert.deepEqual(await f.store().taskWorkflow(w.id), beforeRestart, "working attempt, history and revision are untouched");
  assert.equal(f.observed.length, observed, "reconciliation only observes");
  w = await submit(call, w); await settled(); assert.match(updates.at(-1)!.text, /awaiting parent review/);
  const fromCardThread = tools({ ...f.ctx, threadKey: "1700000001.000100" });
  await assert.rejects(approve(fromCardThread, w), /another parent task\/thread/, "the channel card cannot confer gate authority");
  w = await approve(call, w); await settled(); assert.match(updates.at(-1)!.text, /Current step 2\/3: draft/);
  while (w.status === "active") {
    w = await approve(call, await submit(call, await run(call, w))); await settled();
  }
  assert.match(updates.at(-1)!.text, /completed/);
  const completed = await f.store().taskWorkflow(w.id);
  await f.reopen(); presence = new TaskWorkflowPresence(deps);
  await presence.catchUp("C1"); await settled();
  assert.deepEqual(await f.store().taskWorkflow(w.id), completed);
});

test("legacy reply migration identity survives real-store reopen, including aborted workflows", async (t) => {
  const f = await fixture(t); f.ctx.threadKey = "1700000000.000100";
  const call = tools(f.ctx); let w = await create(call);
  await f.store().setTaskWorkflowSlack(w.id, "1700000000.000200");
  w = await call("decide_task_workflow_step", { ...ref(w), decision: "abort", feedback: "No longer needed" });
  const before = await f.store().taskWorkflow(w.id);
  let posts = 0;
  const updates: string[] = [];
  const deps = {
    store: () => f.store(), schedule: () => () => {},
    slack: {
      post: async () => { posts++; return { ts: "1700000001.000100" }; },
      update: async ({ ts }: { ts: string }) => { updates.push(ts); },
      permalink: async () => "https://example.slack.com/archives/C1/p1700000000000100",
    },
  };
  const p = new TaskWorkflowPresence(deps); await p.catchUp("C1"); await p.flush();
  assert.equal(posts, 1); assert.deepEqual(updates, ["1700000000.000200"]);
  const migrated = { ...before, slack: { ts: "1700000001.000100", location: "channel" } };
  assert.deepEqual(await f.store().taskWorkflow(w.id), migrated);
  await f.reopen();
  const restarted = new TaskWorkflowPresence(deps); await restarted.catchUp("C1"); await restarted.catchUp("C1"); await restarted.flush();
  assert.equal(posts, 1); assert.equal(updates.at(-1), "1700000001.000100");
  assert.deepEqual(await f.store().taskWorkflow(w.id), migrated);
});
