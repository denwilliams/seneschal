import { trackWorkflowAttempt, workflowAttemptActivity } from "./workflow-controls.ts";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedSubagent } from "../workspace/subagents.ts";
import type { SubagentRunner } from "../agent/subagent-tools.ts";
import {
  authorize, expectRevision, nonempty, record, requireWorker, validateSteps, workflowBrief, workflowNextAction,
  type TaskWorkflow, type TaskWorkflowStore, type WorkflowActor, type WorkflowParticipant, type WorkflowStepDefinition,
} from "./workflow.ts";

export interface TaskWorkflowToolsContext {
  channelId: string;
  threadKey: string;
  store: () => TaskWorkflowStore | undefined;
  agents: readonly ResolvedSubagent[];
  runner: () => SubagentRunner | undefined;
  isApproved: (agent: string) => boolean;
  currentUserId: () => string;
  parentTaskId: () => string | undefined;
  onChange?: (workflow: TaskWorkflow) => void | Promise<void>;
  participant?: WorkflowParticipant;
}
interface WorkflowCorrection { step: number; directive?: string; gates?: string[] }
const ref = { workflowId: Type.String(), revision: Type.Integer({ minimum: 0 }) };
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value });

export function createTaskWorkflowTools(ctx: TaskWorkflowToolsContext): ToolDefinition[] {
  const actor: WorkflowActor = ctx.participant ? { kind: "step", ...ctx.participant } : { kind: "parent", threadKey: ctx.threadKey };
  const store = () => {
    const found = ctx.store();
    if (!found) throw new Error("Task workflows are not available in this session.");
    return found;
  };
  const checkAccess = (workflow: TaskWorkflow) => {
    if (workflow.channelId !== ctx.channelId) throw new Error("Workflow belongs to another channel.");
    authorize(workflow, actor);
  };
  const change = async (id: string, revision: number, apply: (workflow: TaskWorkflow) => TaskWorkflow) => {
    const workflow = await store().changeTaskWorkflow(id, (current) => {
      if (!current) throw new Error(`There is no workflow ${id}.`);
      checkAccess(current);
      expectRevision(current, revision);
      return apply(current);
    });
    await ctx.onChange?.(workflow);
    return workflow;
  };
  // Keep details/API records unchanged; the model also sees the explicit parent transition.
  const workflowResult = (workflow: TaskWorkflow) => ctx.participant ? result(workflow) : {
    ...result(workflow), content: result({ ...workflow, nextAction: workflowNextAction(workflow) }).content,
  };
  const check = defineTool({
    name: "check_task_workflow", label: "Check task workflow",
    description: "Read a task workflow, its ordered steps, submissions, gates, corrections, decisions and feedback. Omit workflowId to list this parent thread's workflows (a step sees only its own current attempt). Use the returned revision for mutations. This is separate from software factory runs.",
    parameters: Type.Object({ workflowId: Type.Optional(Type.String()) }),
    execute: async (_id, params: { workflowId?: string }) => {
      const id = params.workflowId ?? ctx.participant?.workflowId;
      if (!id) {
        const workflows = await store().listTaskWorkflows(ctx.threadKey);
        return { ...result(workflows), content: result(workflows.map((workflow) => ({ ...workflow, nextAction: workflowNextAction(workflow) }))).content };
      }
      const workflow = await store().taskWorkflow(id);
      if (!workflow) throw new Error(`There is no workflow ${id}.`);
      checkAccess(workflow);
      return workflowResult(workflow);
    },
  });
  const submit = defineTool({
    name: "submit_task_workflow_step", label: "Submit workflow step",
    description: "Submit the current attempt's output to its parent for declared-gate review. This never advances or completes a workflow. Only the assigned attempt (or the parent for a step without a subagent) can submit.",
    parameters: Type.Object({ ...ref, output: Type.String({ minLength: 1, maxLength: 32_000 }) }),
    execute: async (_id, params: { workflowId: string; revision: number; output: string }) => result(await change(params.workflowId, params.revision, (workflow) => {
      const step = requireWorker(workflow, actor);
      step.output = nonempty(params.output, "Output");
      step.status = "submitted";
      return record(workflow, actor, "submitted", step.output);
    })),
  });
  const requestReturn = defineTool({
    name: "request_task_workflow_return", label: "Request workflow return",
    description: "Ask the parent to return work to the immediately previous step, with a reason. Does not itself move backwards; only the parent authorizes the transition. Available only to the current working attempt, after step one.",
    parameters: Type.Object({ ...ref, reason: Type.String({ minLength: 1, maxLength: 32_000 }) }),
    execute: async (_id, params: { workflowId: string; revision: number; reason: string }) => result(await change(params.workflowId, params.revision, (workflow) => {
      const step = requireWorker(workflow, actor);
      if (!workflow.index) throw new Error("The first step has no previous step.");
      step.feedback = nonempty(params.reason, "Return reason");
      step.status = "return_requested";
      return record(workflow, actor, "return_requested", step.feedback);
    })),
  });
  if (ctx.participant) return [check, submit, requestReturn] as ToolDefinition[];

  const create = defineTool({
    name: "create_task_workflow", label: "Create gated task workflow",
    description: "Attach a linear workflow to the current substantive task. Declare each step's directive, plain-language acceptance gates and optional configured subagent. Parent approval is required at every step, including the final one. This is not a software factory run; use factory tools for those.",
    parameters: Type.Object({ steps: Type.Array(Type.Object({
      name: Type.String({ minLength: 1, maxLength: 200 }), directive: Type.String({ minLength: 1, maxLength: 32_000 }),
      gates: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 20 }), agent: Type.Optional(Type.String()),
    }), { minItems: 1, maxItems: 20 }) }),
    execute: async (_id, params: { steps: WorkflowStepDefinition[] }) => {
      const steps = validateSteps(params.steps);
      for (const step of steps) if (step.agent && !ctx.agents.some((agent) => agent.name === step.agent)) throw new Error(`Unknown subagent ${step.agent}.`);
      const parentTaskId = ctx.parentTaskId();
      if (!parentTaskId) throw new Error("No active parent task is available.");
      const id = `workflow_${randomUUID()}`;
      const workflow = await store().changeTaskWorkflow(id, (current) => {
        if (current) throw new Error("Workflow already exists.");
        return record({ id, channelId: ctx.channelId, parentThreadKey: ctx.threadKey, parentTaskId, revision: 0,
          status: "active", index: 0, steps, history: [] }, actor, "created", "Workflow declared.");
      });
      await ctx.onChange?.(workflow);
      return workflowResult(workflow);
    },
  });
  const edit = defineTool({
    name: "edit_task_workflow", label: "Correct task workflow",
    description: "Parent-only correction of an active workflow's plain-English directives and/or gates. Pass 1-based step positions, the latest revision and a reason. No insertion, reordering, renaming or reassignment. Changed and downstream work loses submissions, approvals and attempt authority and must run and be reviewed again; earlier unchanged work remains valid. History retains old definitions and results. Refused atomically while any step is working, including interrupted attempts: inspect and finish/submit that attempt first, then correct; this tool cannot cancel external side effects. Completed/aborted workflows cannot be edited.",
    parameters: Type.Object({ ...ref, reason: Type.String({ minLength: 1, maxLength: 32_000 }),
      edits: Type.Array(Type.Object({ step: Type.Integer({ minimum: 1, maximum: 20 }),
        directive: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })),
        gates: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 20 })),
      }), { minItems: 1, maxItems: 20 }),
    }),
    execute: async (_id, params: { workflowId: string; revision: number; reason: string; edits: WorkflowCorrection[] }) => result(await change(params.workflowId, params.revision, (workflow) => {
      const reason = nonempty(params.reason, "Correction reason");
      if (workflow.steps.some((step) => step.status === "working")) throw new Error("Cannot edit while a step is working (including interrupted attempts). Inspect and finish/submit the attempt before correcting; edits cannot cancel external side effects.");
      if (!Array.isArray(params.edits) || !params.edits.length || params.edits.length > 20) throw new Error("Declare 1–20 step corrections.");
      const seen = new Set<number>();
      const changes = params.edits.flatMap((correction) => {
        if (!Number.isInteger(correction.step) || correction.step < 1 || correction.step > workflow.steps.length) throw new Error("Correction step must be an existing 1-based position.");
        if (seen.has(correction.step)) throw new Error("Correct each step at most once per edit.");
        seen.add(correction.step);
        if (correction.directive === undefined && correction.gates === undefined) throw new Error("Each correction needs a directive or gates.");
        const step = workflow.steps[correction.step - 1]!;
        const before = { directive: step.directive, gates: step.gates };
        const validated = validateSteps([{ ...step,
          ...(correction.directive !== undefined ? { directive: correction.directive } : {}),
          ...(correction.gates !== undefined ? { gates: correction.gates } : {}),
        }])[0]!;
        const after = { directive: validated.directive, gates: validated.gates };
        return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ step: correction.step, before, after }];
      });
      if (!changes.length) throw new Error("No definition changes; the workflow was not modified.");
      const first = Math.min(...changes.map((correction) => correction.step)) - 1;
      for (const correction of changes) Object.assign(workflow.steps[correction.step - 1]!, correction.after);
      for (const affected of workflow.steps.slice(first)) {
        affected.status = "ready";
        affected.runKey = "";
        affected.output = "";
        affected.feedback = reason;
        delete affected.dispatchDependency;
      }
      workflow.index = Math.min(workflow.index, first);
      return record(workflow, actor, "definition_corrected", JSON.stringify({ reason, changes, invalidatedFrom: first + 1 }));
    })),
  });
  const defer = defineTool({
    name: "defer_task_workflow_step", label: "Record workflow dispatch dependency",
    description: "Parent-only: record a concrete external person/system/access dependency that prevents starting the current ready step. Keep the dependency public-safe; no secrets. Readiness alone is NOT a blocker. Do not use for working/interrupted attempts, review gates or ordinary dispatch delay. This does not approve, start or retry work. Once resolved, explicitly run the step with the latest revision; dispatch clears the dependency.",
    parameters: Type.Object({ ...ref, dependency: Type.String({ minLength: 1, maxLength: 32_000 }) }),
    execute: async (_id, params: { workflowId: string; revision: number; dependency: string }) => workflowResult(await change(params.workflowId, params.revision, (workflow) => {
      const step = workflow.steps[workflow.index]!;
      if (step.status !== "ready") throw new Error("Only a ready step can await a dispatch dependency; inspect working attempts or review submitted work instead.");
      step.dispatchDependency = nonempty(params.dependency, "External dependency");
      return record(workflow, actor, "dispatch_deferred", step.dispatchDependency);
    })),
  });
  const run = defineTool({
    name: "run_task_workflow_step", label: "Run task workflow step",
    description: "Start the current ready step. A configured subagent gets the full flow, prior approved output and feedback; otherwise returns a brief for the parent to execute and submit. After rework, start the ready step now without retry=true, or record a concrete external dependency with defer_task_workflow_step. Does not auto-advance. An interrupted or non-submitting attempt stays working: retry=true explicitly supersedes it, may repeat side effects, and invalidates its tools. Never retry automatically after interruption; inspect the attempt first.",
    parameters: Type.Object({ ...ref, retry: Type.Optional(Type.Boolean()) }),
    execute: async (_id, params: { workflowId: string; revision: number; retry?: boolean }, signal) => {
      // Check availability/approval before recording intent; check again in the atomic update using the current step.
      const runner = ctx.runner();
      const workflow = await change(params.workflowId, params.revision, (workflow) => {
        const step = workflow.steps[workflow.index]!;
        if (workflowAttemptActivity(store(), step.runKey) !== undefined) throw new Error("This attempt is still executing; inspect it instead of duplicating it.");
        if (step.status !== "ready" && !(step.status === "working" && params.retry === true)) throw new Error("Step is not ready; an interrupted working attempt needs explicit retry=true.");
        if (step.agent) {
          const role = ctx.agents.find((agent) => agent.name === step.agent);
          if (!role || !runner) throw new Error("The assigned subagent is not available.");
          if (role.requireApproval && !ctx.isApproved(step.agent)) throw new Error(`Subagent ${step.agent} needs a person's approval via request_access (subagent:${step.agent}).`);
        }
        step.status = "working";
        delete step.dispatchDependency;
        delete step.diagnostic;
        step.attempt++;
        step.runKey = `sub-${randomUUID()}`;
        return record(workflow, actor, params.retry ? "retry_started" : "started", `Attempt ${step.attempt}; ${step.runKey}`);
      });
      const brief = workflowBrief(workflow);
      const step = workflow.steps[workflow.index]!;
      if (!step.agent) return result({ workflow, brief });
      // Track before checking persisted authority, closing the stop-before-launch race.
      const live = trackWorkflowAttempt(store(), step.runKey);
      const diagnose = async (detail: string, interrupted: boolean) => {
        await store().changeTaskWorkflow(workflow.id, (current) => {
          if (!current) throw new Error("Workflow disappeared.");
          const currentStep = current.steps[workflow.index];
          if (current.status === "active" && current.index === workflow.index && currentStep?.runKey === step.runKey) {
            currentStep.diagnostic = { at: Date.now(), interrupted, detail: detail.slice(0, 6_000) };
          }
          return current;
        });
      };
      try {
        const current = await store().taskWorkflow(workflow.id);
        if (!current) throw new Error("Workflow disappeared before launch.");
        authorize(current, { kind: "step", workflowId: workflow.id, index: workflow.index, runKey: step.runKey });
        const report = await runner!.run({ agent: step.agent, task: brief, userId: ctx.currentUserId(),
          signal: signal ? AbortSignal.any([signal, live.signal]) : live.signal, onActivity: live.activity,
          runKey: step.runKey, workflow: { workflowId: workflow.id, index: workflow.index, runKey: step.runKey } });
        await diagnose(report.status + ": " + report.summary, false);
        return result({ report, workflow: await store().taskWorkflow(workflow.id),
          note: "A final report does not submit or approve work. If the attempt did not submit/request return, inspect it before explicitly retrying." });
      } catch (error) {
        await diagnose(error instanceof Error ? error.message : String(error), true);
        throw error;
      } finally { live.finish(); }
    },
  });
  const decide = defineTool({
    name: "decide_task_workflow_step", label: "Review task workflow step",
    description: "Parent-only gate review. approve requires a submitted output and a passing evaluation (with evidence) for EVERY gate in order. rework makes the same step ready with feedback; you must next call run_task_workflow_step (without retry), or defer_task_workflow_step for a concrete external dependency. It does not dispatch by itself. return authorizes a downstream return request: invalidates work from the previous step onward, which must be resubmitted/reapproved. abort ends without approval. Final approval alone completes the workflow. Evaluate gates yourself; worker output is not approval authority.",
    parameters: Type.Object({ ...ref, decision: Type.Union([Type.Literal("approve"), Type.Literal("rework"), Type.Literal("return"), Type.Literal("abort")]),
      feedback: Type.String({ minLength: 1, maxLength: 32_000 }),
      gates: Type.Optional(Type.Array(Type.Object({ passed: Type.Boolean(), evidence: Type.String({ minLength: 1, maxLength: 2_000 }) }))),
    }),
    execute: async (_id, params: { workflowId: string; revision: number; decision: "approve" | "rework" | "return" | "abort"; feedback: string; gates?: { passed: boolean; evidence: string }[] }) => workflowResult(await change(params.workflowId, params.revision, (workflow) => {
      const step = workflow.steps[workflow.index]!;
      const feedback = nonempty(params.feedback, "Feedback");
      switch (params.decision) {
        case "approve":
          if (step.status !== "submitted") throw new Error("Only a submitted step can be approved.");
          if (params.gates?.length !== step.gates.length || params.gates.some((gate) => gate.passed !== true || !nonempty(gate.evidence, "Gate evidence", 2_000))) throw new Error("Approval requires passing evidence for every declared gate, in order.");
          step.status = "approved";
          record(workflow, actor, "approved", JSON.stringify({ feedback, gates: params.gates }));
          workflow.index++;
          if (workflow.index === workflow.steps.length) workflow.status = "completed";
          return workflow;
        case "rework":
          if (step.status !== "submitted" && step.status !== "return_requested") throw new Error("Rework requires a submission or return request.");
          step.status = "ready";
          step.runKey = "";
          step.feedback = feedback;
          delete step.dispatchDependency;
          return record(workflow, actor, "rework", JSON.stringify({ feedback, gates: params.gates ?? [] }));
        case "return":
          if (step.status !== "return_requested" || workflow.index === 0) throw new Error("Return requires a downstream return request.");
          const returnFeedback = `Downstream return request: ${step.feedback}\nParent feedback: ${feedback}`;
          record(workflow, actor, "return_authorized", feedback);
          workflow.index--;
          for (const affected of workflow.steps.slice(workflow.index)) {
            affected.status = "ready";
            affected.runKey = "";
            affected.feedback = returnFeedback;
            delete affected.dispatchDependency;
          }
          return workflow;
        case "abort":
          workflow.status = "aborted";
          for (const affected of workflow.steps) affected.runKey = "";
          return record(workflow, actor, "aborted", feedback);
        default: throw new Error("Unknown workflow decision.");
      }
    })),
  });
  return [create, check, edit, run, defer, submit, requestReturn, decide] as ToolDefinition[];
}
