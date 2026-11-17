import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import type { TaskWorkflow } from "../tasks/workflow.ts";
import { TaskRunTracker, TaskStatusStore } from "../tasks/store.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { buildThreadToolSet, createThreadSession } from "./session.ts";

test("a real parent session runs a scoped step subagent, waits for its submission and explicitly approves", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "workflow-session-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({
    agentSets: { team: { agents: { writer: { description: "Write an evidence-backed report", tools: ["read"], model: "fixture/model" } } } },
    channels: { general: { model: "fixture/model", agentSet: "team", tools: ["read"] } },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const observed: TaskWorkflow[] = [];
  const runtimes = new ChannelRuntimes({ modelRuntime, onTaskWorkflowChange: (_channel, workflow) => { observed.push(workflow); } });
  const base = { channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1" };
  const session = await createThreadSession(base);
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); rmSync(dataDir, { recursive: true, force: true }); });
  const tasks = new TaskStatusStore(dataDir);
  const tracker = () => new TaskRunTracker(tasks, { channelId: "C1", threadKey: "1.1", summary: "Write a report" });
  let tracking = tracker(); session.setTaskTracker(tracking);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("create_task_workflow", { steps: [{ name: "write", directive: "Write report", gates: ["Includes evidence"], agent: "writer" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Workflow created"),
  ]);
  await session.session.prompt("Write a report with a review gate", { requestId: "r1", userId: "U1" });
  tracking.finish("completed");
  let workflow = (await session.store.listTaskWorkflows("1.1"))[0]!;
  assert.equal(workflow.parentTaskId, tasks.all()[0]!.id);
  assert.equal(tasks.all()[0]!.status, "waiting");
  assert.ok(session.store.registeredToolNames().includes("submit_task_workflow_step"));

  tracking = tracker(); session.setTaskTracker(tracking);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision }), { stopReason: "toolUse" }),
    async (context) => {
      const names = context.messages.filter((m) => m.role === "system").flatMap((m) => ((m as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((tool) => tool.name));
      assert.ok(names.includes("check_task_workflow"));
      assert.ok(names.includes("submit_task_workflow_step"));
      assert.ok(names.includes("request_task_workflow_return"));
      for (const forbidden of ["create_task_workflow", "edit_task_workflow", "run_task_workflow_step", "defer_task_workflow_step", "decide_task_workflow_step", "set_task_status", "run_subagent", "state_update"]) assert.ok(!names.includes(forbidden), forbidden);
      assert.match(JSON.stringify(context.messages), /step 1\/1/);
      const current = (await session.store.taskWorkflow(workflow.id))!;
      return fauxAssistantMessage(fauxToolCall("submit_task_workflow_step", { workflowId: current.id, revision: current.revision, output: "Report with evidence" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("STATUS: done\nNEXT: none\nReport submitted for parent review"),
    fauxAssistantMessage("I will now review the gate"),
  ]);
  await session.session.prompt("Run the writer", { requestId: "r2", userId: "U1" });
  tracking.finish("completed");
  workflow = (await session.store.taskWorkflow(workflow.id))!;
  assert.equal(workflow.steps[0]!.status, "submitted");
  assert.equal(workflow.status, "active");
  assert.equal(observed.at(-1)?.steps[0]?.status, "submitted", "worker submissions reach the shared observer, not only parent changes");
  assert.equal(runtimes.peek("C1")!.jobs.version, observed.length, "each committed change invalidates the console poll version");
  assert.equal(tasks.all()[0]!.status, "waiting");
  assert.equal(tasks.all().length, 1, "subsequent turns continue the owning task");

  // The original failure: parent requests rework, then incorrectly ends its turn.
  tracking = tracker(); session.setTaskTracker(tracking);
  const firstRunKey = workflow.steps[0]!.runKey;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("decide_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision,
      decision: "rework", feedback: "Correct the categorization and cite the primary source",
      gates: [{ passed: false, evidence: "The categorization has no primary source" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Blocked: the categorization step is ready"),
    async (context) => {
      assert.match(JSON.stringify(context.messages), /Runtime continuation check/);
      assert.match(JSON.stringify(context.messages), /not a safety\/access block/);
      const current = (await session.store.taskWorkflow(workflow.id))!;
      assert.equal(current.steps[0]!.status, "ready");
      assert.equal(current.steps[0]!.attempt, 1);
      assert.equal(session.currentUserId, "U1");
      return fauxAssistantMessage(fauxToolCall("run_task_workflow_step", { workflowId: current.id, revision: current.revision }), { stopReason: "toolUse" });
    },
    async (context) => {
      assert.match(JSON.stringify(context.messages), /Correct the categorization and cite the primary source/);
      assert.match(JSON.stringify(context.messages), /Report with evidence/);
      const current = (await session.store.taskWorkflow(workflow.id))!;
      assert.equal(current.steps[0]!.attempt, 2);
      assert.notEqual(current.steps[0]!.runKey, firstRunKey);
      return fauxAssistantMessage(fauxToolCall("submit_task_workflow_step", { workflowId: current.id, revision: current.revision,
        output: "Corrected categorization with primary-source evidence" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Resubmitted for independent review"),
    fauxAssistantMessage("The corrected submission still needs my gate review"),
  ]);
  await session.session.prompt("Rework categorization after failed review", { requestId: "rework", userId: "U1" });
  workflow = (await session.store.taskWorkflow(workflow.id))!;
  assert.equal(workflow.steps[0]!.status, "submitted");
  assert.equal(workflow.status, "active", "the continuation cannot auto-approve even the final submission");
  assert.equal(workflow.history.filter((event) => event.event === "approved").length, 0);
  assert.equal(tasks.all()[0]!.status, "waiting");

  tracking = tracker(); session.setTaskTracker(tracking);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("decide_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision, decision: "approve", feedback: "Reviewed report",
      gates: [{ passed: true, evidence: "Read the corrected categorization and its primary-source evidence" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Approved"),
  ]);
  await session.session.prompt("Review the report", { requestId: "r3", userId: "U1" });
  assert.equal((await session.store.taskWorkflow(workflow.id))!.status, "completed");
  assert.equal(tasks.all()[0]!.status, "closed_successfully");

  // Ordinary/factory subagents still have none of the workflow tools without a bound attempt.
  const ordinary = await buildThreadToolSet({ ...base, role: "subagent", threadKey: "sub-ordinary" }, { current: () => undefined, set: async () => {} });
  t.after(() => ordinary.dispose());
  assert.deepEqual(ordinary.tools.filter((tool) => tool.name.includes("task_workflow")), []);
});

async function workflowSession(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "workflow-lifecycle-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({ channels: { general: { model: "fixture/model", tools: ["read"] } } });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const base = { channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1" };
  let session = await createThreadSession(base);
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); rmSync(dataDir, { recursive: true, force: true }); });
  const tasks = new TaskStatusStore(dataDir);
  let request = 0;
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const turn = async (responses: Parameters<typeof faux.setResponses>[0], requestId?: string) => {
    const tracker = new TaskRunTracker(tasks, { channelId: "C1", threadKey: "1.1", summary: "Gated report" });
    // Match SlackApp: a reply to waiting work eagerly resumes the task BEFORE binding/prompting.
    tracker.start();
    session.setTaskTracker(tracker);
    faux.setResponses(responses);
    try {
      await session.session.prompt("Continue the report", { requestId: requestId ?? `r${++request}`, userId: "U1" });
      tracker.finish("completed");
    } finally { session.setTaskTracker(undefined); }
    return tracker.current()!;
  };
  const mutate = async (id: string, tool: string, args: Parameters<typeof fauxToolCall>[1] = {}) => {
    const workflow = (await session.store.taskWorkflow(id))!;
    return turn([call(tool, { workflowId: id, revision: workflow.revision, ...args }), fauxAssistantMessage("Done")]);
  };
  return {
    tasks, turn, call, mutate,
    session: () => session,
    workflows: () => session.store.listTaskWorkflows("1.1"),
    reopen: async () => { await session.dispose(); await runtimes.closeAll(); session = await createThreadSession(base); },
  };
}

const reportSteps = [{ name: "write", directive: "Write report", gates: ["Includes evidence"] }];

for (const read of ["chat", "check", "list"] as const) {
  test(`active workflow keeps its owning task across an eager-start ${read} turn and session recreation`, async (t) => {
    const f = await workflowSession(t);
    const owner = await f.turn([f.call("create_task_workflow", { steps: reportSteps }), fauxAssistantMessage("Created")]);
    const workflow = (await f.workflows())[0]!;
    assert.equal(workflow.parentTaskId, owner.id);
    assert.equal(owner.status, "waiting");
    await f.reopen();
    const responses = read === "chat" ? [] : [f.call("check_task_workflow", read === "check" ? { workflowId: workflow.id } : {})];
    const followup = await f.turn([...responses, fauxAssistantMessage("Still awaiting the writer and review")]);
    assert.equal(followup.id, owner.id);
    assert.equal(followup.status, "waiting", "a non-mutating turn must not close an active workflow's task");
    assert.equal(f.tasks.get(owner.id)!.finishedAt, undefined);
    assert.equal((await f.workflows())[0]!.revision, workflow.revision, "status checks must not mutate the workflow");
    await f.mutate(workflow.id, "run_task_workflow_step");
    await f.mutate(workflow.id, "submit_task_workflow_step", { output: "Report with evidence" });
    await f.mutate(workflow.id, "decide_task_workflow_step", {
      decision: "approve", feedback: "Verified", gates: [{ passed: true, evidence: "Read supporting evidence" }],
    });
    assert.equal((await f.workflows())[0]!.status, "completed");
    assert.equal(f.tasks.get(owner.id)!.status, "closed_successfully");
    assert.equal(f.tasks.all().length, 1, "later workflow turns must retain the original task");
  });
}

for (const decisions of [["approve", "approve"], ["approve", "abort"], ["abort", "approve"], ["abort", "abort"]] as const) {
  test(`shared parent stays waiting until both workflows end (${decisions.join(", ")})`, async (t) => {
    const f = await workflowSession(t);
    const owner = await f.turn([
      f.call("create_task_workflow", { steps: reportSteps }),
      f.call("create_task_workflow", { steps: reportSteps }),
      fauxAssistantMessage("Created two workflows"),
    ]);
    const workflows = await f.workflows();
    assert.equal(workflows.length, 2);
    assert.ok(workflows.every((workflow) => workflow.parentTaskId === owner.id));
    for (const [index, decision] of decisions.entries()) {
      const workflow = workflows[index]!;
      if (decision === "approve") {
        await f.mutate(workflow.id, "run_task_workflow_step");
        await f.mutate(workflow.id, "submit_task_workflow_step", { output: "Report with evidence" });
      }
      await f.mutate(workflow.id, "decide_task_workflow_step", {
        decision, feedback: "Reviewed", ...(decision === "approve" ? { gates: [{ passed: true, evidence: "Read evidence" }] } : {}),
      });
      if (index === 0) {
        assert.equal(f.tasks.get(owner.id)!.status, "waiting", "one finished workflow must not close the shared parent");
        assert.equal(f.tasks.get(owner.id)!.finishedAt, undefined);
        await f.reopen();
        assert.equal((await f.turn([fauxAssistantMessage("The other workflow is still active")])).status, "waiting");
      }
    }
    assert.equal(f.tasks.get(owner.id)!.status, decisions.some((decision) => decision === "abort") ? "abandoned" : "closed_successfully");
    assert.ok(f.tasks.get(owner.id)!.finishedAt);
    assert.equal(f.tasks.all().length, 1);
  });
}

test("a correction through the parent session keeps task ownership and waits for fresh execution and review", async (t) => {
  const f = await workflowSession(t);
  const owner = await f.turn([f.call("create_task_workflow", { steps: [
    ...reportSteps, { name: "verify", directive: "Verify the report", gates: ["No unsupported claims"] },
  ] }), fauxAssistantMessage("Created")]);
  let workflow = (await f.workflows())[0]!;
  for (const output of ["Original report", "Original verification"]) {
    await f.mutate(workflow.id, "run_task_workflow_step");
    await f.mutate(workflow.id, "submit_task_workflow_step", { output });
    if (output === "Original report") await f.mutate(workflow.id, "decide_task_workflow_step", {
      decision: "approve", feedback: "Reviewed", gates: [{ passed: true, evidence: "Read report" }],
    });
  }
  const corrected = await f.mutate(workflow.id, "edit_task_workflow", {
    reason: "The report should use primary sources", edits: [{ step: 1, directive: "Write a primary-source report", gates: ["Primary sources cited"] }],
  });
  workflow = (await f.workflows())[0]!;
  assert.equal(corrected.id, owner.id);
  assert.equal(corrected.status, "waiting");
  assert.equal(workflow.parentTaskId, owner.id);
  assert.equal(workflow.index, 0);
  assert.ok(workflow.steps.every((step) => step.status === "ready" && !step.output));
  await f.reopen();
  assert.equal((await f.turn([f.call("check_task_workflow", { workflowId: workflow.id }), fauxAssistantMessage("Awaiting corrected work")])).status, "waiting");
  for (let index = 0; index < 2; index++) {
    await f.mutate(workflow.id, "run_task_workflow_step");
    await f.mutate(workflow.id, "submit_task_workflow_step", { output: "Corrected work with primary sources" });
    assert.equal(f.tasks.get(owner.id)!.status, "waiting");
    await f.mutate(workflow.id, "decide_task_workflow_step", {
      decision: "approve", feedback: "Reviewed corrected work", gates: [{ passed: true, evidence: "Read primary sources" }],
    });
  }
  assert.equal((await f.workflows())[0]!.status, "completed");
  assert.equal(f.tasks.get(owner.id)!.status, "closed_successfully");
  assert.equal(f.tasks.all().length, 1);
});

test("finished workflows from a previous task do not affect the next task in the same thread", async (t) => {
  const f = await workflowSession(t);
  const first = await f.turn([f.call("create_task_workflow", { steps: reportSteps }), fauxAssistantMessage("Created")]);
  const previous = (await f.workflows())[0]!;
  await f.mutate(previous.id, "decide_task_workflow_step", { decision: "abort", feedback: "No longer needed" });
  const next = await f.turn([f.call("create_task_workflow", { steps: reportSteps }), fauxAssistantMessage("New task")]);
  const workflow = (await f.workflows()).find((candidate) => candidate.parentTaskId === next.id)!;
  assert.notEqual(next.id, first.id);
  assert.equal(next.status, "waiting");
  await f.mutate(workflow.id, "run_task_workflow_step");
  await f.mutate(workflow.id, "submit_task_workflow_step", { output: "Report with evidence" });
  await f.mutate(workflow.id, "decide_task_workflow_step", {
    decision: "approve", feedback: "Verified", gates: [{ passed: true, evidence: "Read supporting evidence" }],
  });
  assert.equal(f.tasks.get(first.id)!.status, "abandoned");
  assert.equal(f.tasks.get(next.id)!.status, "closed_successfully");
  assert.equal(f.tasks.all().length, 2);
});

async function submittedWorkflow(t: TestContext, steps = reportSteps) {
  const f = await workflowSession(t);
  await f.turn([f.call("create_task_workflow", { steps }), fauxAssistantMessage("Created")]);
  const workflow = (await f.workflows())[0]!;
  await f.mutate(workflow.id, "run_task_workflow_step");
  await f.mutate(workflow.id, "submit_task_workflow_step", { output: "Original categorization" });
  const submitted = (await f.workflows())[0]!;
  const rework = f.call("decide_task_workflow_step", { workflowId: submitted.id, revision: submitted.revision,
    decision: "rework", feedback: "Fix the categories" });
  return { f, submitted, rework };
}

test("idle rework gets only one reminder then an explicit stall, without dispatch or false blocking", async (t) => {
  const { f, submitted, rework } = await submittedWorkflow(t);
  let reminders = 0;
  await assert.rejects(f.turn([
    rework, fauxAssistantMessage("Blocked because ready"),
    (context) => {
      reminders++;
      assert.match(JSON.stringify(context.messages), /Runtime continuation check/);
      return fauxAssistantMessage("Still not dispatching");
    },
  ], "idle-rework"), /Parent continuation stalled: .*ready — awaiting parent dispatch/);
  const workflow = (await f.workflows())[0]!;
  assert.equal(reminders, 1);
  assert.equal(workflow.steps[0]!.attempt, 1);
  assert.equal(workflow.steps[0]!.status, "ready");
  assert.equal(workflow.status, "active");
  assert.equal(f.tasks.get(submitted.parentTaskId)!.status, "waiting");
  assert.match(f.tasks.get(submitted.parentTaskId)!.detail!, /not a safety\/access block/);
  assert.equal(workflow.history.filter((event) => event.event === "started").length, 1);
  await f.reopen();
  let replayGenerations = 0;
  await assert.rejects(f.turn([
    () => { replayGenerations++; return fauxAssistantMessage("Must use the durable receipt"); },
  ], "idle-rework"), /Parent continuation stalled/);
  assert.equal(replayGenerations, 0, "redelivery reuses both durable requests, not a fresh dispatch reminder");
  assert.deepEqual((await f.workflows())[0], workflow);
});

for (const loseDelivery of [false, true]) test(
  `redelivery cannot renew the reminder after another dispatch/submit/rework cycle (lost delivery: ${loseDelivery})`, async (t) => {
  const { f, rework } = await submittedWorkflow(t);
  const store = f.session().store;
  const wait = store.wait.bind(store);
  let waits = 0;
  if (loseDelivery) store.wait = async (...args) => {
    const result = await wait(...args);
    // Simulate a crash after the durable reminder ran, before its result reaches prompt().
    if (++waits === 2) throw new Error("Simulated lost continuation delivery");
    return result;
  };
  await assert.rejects(f.turn([
    rework, fauxAssistantMessage("Idle"),
    async () => {
      const workflow = (await f.workflows())[0]!;
      return f.call("run_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision });
    },
    async () => {
      const workflow = (await f.workflows())[0]!;
      return f.call("submit_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision, output: "Still incorrect" });
    },
    async () => {
      const workflow = (await f.workflows())[0]!;
      return f.call("decide_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision,
        decision: "rework", feedback: "Correct the categories again" });
    },
    fauxAssistantMessage("Idle after second review"),
  ], "changing-rework"), loseDelivery ? /Simulated lost continuation delivery/ : /Parent continuation stalled/);
  store.wait = wait;
  const ready = (await f.workflows())[0]!;
  assert.equal(ready.steps[0]!.attempt, 2);
  assert.equal(ready.history.filter((event) => event.event === "rework").length, 2);
  // Reopen the Durable store as well as the session, not only an in-memory binding.
  await f.reopen();
  let generations = 0;
  await assert.rejects(f.turn([
    () => { generations++; return fauxAssistantMessage("Must reuse the exhausted reminder"); },
  ], "changing-rework"), /Parent continuation stalled/);
  assert.equal(generations, 0);
  assert.deepEqual((await f.workflows())[0], ready);
  // A genuinely new request still gets its own reminder and can dispatch deliberately.
  let reminders = 0;
  await f.turn([
    fauxAssistantMessage("Status only"),
    () => {
      reminders++;
      return f.call("run_task_workflow_step", { workflowId: ready.id, revision: ready.revision });
    },
    fauxAssistantMessage("Inspect working attempt before any retry"),
  ], "new-rework-request");
  assert.equal(reminders, 1);
  assert.equal((await f.workflows())[0]!.steps[0]!.attempt, 3);
});

test("editing a future step cannot hide current rework on this or a later parent request", async (t) => {
  const { f, rework } = await submittedWorkflow(t, [...reportSteps,
    { name: "publish", directive: "Publish the report", gates: ["Report published"] },
  ]);
  let reminders = 0;
  await assert.rejects(f.turn([
    rework,
    async () => {
      const workflow = (await f.workflows())[0]!;
      return f.call("edit_task_workflow", { workflowId: workflow.id, revision: workflow.revision,
        reason: "Clarify future publication", edits: [{ step: 2, directive: "Publish with source links" }] });
    },
    fauxAssistantMessage("Idle after future edit"),
    () => { reminders++; return fauxAssistantMessage("Still idle"); },
  ]), /Parent continuation stalled/);
  assert.equal(reminders, 1);
  const ready = (await f.workflows())[0]!;
  assert.equal(ready.history.at(-1)!.event, "definition_corrected");
  assert.equal(ready.steps[0]!.feedback, "Fix the categories");
  await f.reopen();
  await assert.rejects(f.turn([
    fauxAssistantMessage("Status only"),
    () => { reminders++; return fauxAssistantMessage("Still idle on a new request"); },
  ]), /Parent continuation stalled/);
  assert.equal(reminders, 2);
  assert.deepEqual((await f.workflows())[0], ready);
});

test("a failed parent request after rework does not schedule a continuation", async (t) => {
  const { f, rework } = await submittedWorkflow(t);
  let reminders = 0;
  await assert.rejects(f.turn([
    rework,
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Permanent provider failure" }),
    () => { reminders++; return fauxAssistantMessage("Must not run"); },
  ]), /Durable input unanswered/);
  assert.equal(reminders, 0);
  const workflow = (await f.workflows())[0]!;
  assert.equal(workflow.steps[0]!.status, "ready");
  assert.equal(workflow.steps[0]!.attempt, 1);
});

test("a concrete external dependency ends continuation, persists across reopen, and clears on explicit dispatch", async (t) => {
  const { f, rework } = await submittedWorkflow(t);
  await f.turn([
    rework, fauxAssistantMessage("Need the source owner"),
    async () => {
      const workflow = (await f.workflows())[0]!;
      return f.call("defer_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision,
        dependency: "Source owner must supply the missing category mapping" });
    },
    fauxAssistantMessage("Waiting for the source owner to supply the mapping"),
  ]);
  let workflow = (await f.workflows())[0]!;
  assert.equal(workflow.steps[0]!.attempt, 1);
  assert.match(workflow.steps[0]!.dispatchDependency!, /Source owner/);
  assert.match(f.tasks.get(workflow.parentTaskId)!.detail!, /deferred for external dependency: Source owner/);
  await f.reopen();
  const revision = workflow.revision;
  await f.turn([fauxAssistantMessage("The owner has not supplied it yet")]);
  workflow = (await f.workflows())[0]!;
  assert.equal(workflow.revision, revision, "a deferred step must not trigger another reminder or worker");
  await f.mutate(workflow.id, "run_task_workflow_step");
  workflow = (await f.workflows())[0]!;
  assert.equal(workflow.steps[0]!.dispatchDependency, undefined);
  assert.equal(workflow.steps[0]!.status, "working");
  assert.equal(workflow.steps[0]!.attempt, 2);
});

test("a continuation that starts but does not submit stays working and is never retried on idle follow-ups", async (t) => {
  const { f, rework } = await submittedWorkflow(t);
  await f.turn([
    rework, fauxAssistantMessage("Rework requested"),
    async () => {
      const workflow = (await f.workflows())[0]!;
      return f.call("run_task_workflow_step", { workflowId: workflow.id, revision: workflow.revision });
    },
    fauxAssistantMessage("Attempt may have had external effects; inspect before retrying"),
  ]);
  const working = (await f.workflows())[0]!;
  assert.equal(working.steps[0]!.status, "working");
  assert.equal(working.steps[0]!.attempt, 2);
  await f.reopen();
  await f.turn([fauxAssistantMessage("Inspecting the interrupted attempt")]);
  assert.deepEqual((await f.workflows())[0], working);
  assert.match(f.tasks.get(working.parentTaskId)!.detail!, /possibly interrupted.*Do not duplicate live work/);
});

test("an aborted parent request does not schedule a rework continuation", async (t) => {
  const { f, rework } = await submittedWorkflow(t);
  let continuation = false;
  let aborting: Promise<void> | undefined;
  await f.turn([
    rework,
    async () => {
      // Do not await abort inside the generation it is cancelling.
      aborting = f.session().session.abort();
      return fauxAssistantMessage("Stopped");
    },
    () => { continuation = true; return fauxAssistantMessage("Must not run"); },
  ]).catch((error) => assert.match(String(error), /Durable input unanswered/));
  await aborting;
  assert.equal(continuation, false);
  const workflow = (await f.workflows())[0]!;
  assert.equal(workflow.steps[0]!.status, "ready");
  assert.equal(workflow.steps[0]!.attempt, 1);
});

test("a later parent turn recovers undispatched rework after session recreation without needing a new rework mutation", async (t) => {
  const { f, submitted, rework } = await submittedWorkflow(t);
  await assert.rejects(f.turn([rework, fauxAssistantMessage("Idle"), fauxAssistantMessage("Still idle")]), /Parent continuation stalled/);
  const ready = (await f.workflows())[0]!;
  await f.reopen();
  let reminders = 0;
  await f.turn([
    fauxAssistantMessage("Status only"),
    (context) => {
      reminders++;
      assert.match(JSON.stringify(context.messages), /Runtime continuation check/);
      return f.call("run_task_workflow_step", { workflowId: ready.id, revision: ready.revision });
    },
    async () => {
      const working = (await f.workflows())[0]!;
      return f.call("submit_task_workflow_step", { workflowId: working.id, revision: working.revision, output: "Corrected categorization" });
    },
    fauxAssistantMessage("Ready for fresh parent gate review"),
  ]);
  const current = (await f.workflows())[0]!;
  assert.equal(reminders, 1);
  assert.equal(current.steps[0]!.attempt, 2);
  assert.equal(current.steps[0]!.status, "submitted");
  assert.equal(current.status, "active");
  assert.equal(current.parentTaskId, submitted.parentTaskId);
  assert.equal(f.tasks.all().length, 1);
});

test("continuation ignores rework belonging to another task, thread or channel", async (t) => {
  const { f, submitted } = await submittedWorkflow(t);
  const foreign = [
    { id: "other-task", parentTaskId: "not-this-task" },
    { id: "other-thread", parentThreadKey: "2.2" },
  ];
  for (const fields of foreign) await f.session().store.changeTaskWorkflow(fields.id, () => ({
    ...structuredClone(submitted), ...fields,
    steps: submitted.steps.map((step) => ({ ...step, status: "ready", runKey: "", feedback: "Fix categories" })),
    history: [...submitted.history, { revision: submitted.revision + 1, at: Date.now(), step: 0, actor: "parent", event: "rework", detail: "Fix categories" }],
  }));
  await assert.rejects(f.session().store.changeTaskWorkflow("other-channel", () => ({
    ...structuredClone(submitted), id: "other-channel", channelId: "C2",
  })), /identity does not match/);
  await f.turn([fauxAssistantMessage("The current task still awaits gate review")]);
  for (const { id } of foreign) {
    const untouched = (await f.session().store.taskWorkflow(id))!;
    assert.equal(untouched.steps[0]!.status, "ready");
    assert.equal(untouched.steps[0]!.attempt, 1);
  }
  assert.equal((await f.session().store.taskWorkflow(submitted.id))!.steps[0]!.status, "submitted");
});
