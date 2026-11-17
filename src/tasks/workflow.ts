import { defineDocFamily } from "@earendil-works/pi-durable";

export interface WorkflowStepDefinition {
  name: string;
  directive: string;
  gates: string[];
  agent?: string;
}
export interface WorkflowStep extends WorkflowStepDefinition {
  status: "ready" | "working" | "submitted" | "return_requested" | "approved";
  attempt: number;
  runKey: string;
  output: string;
  feedback: string;
  /** Parent-declared external dependency; ready is not itself a blocker. Cleared by dispatch. */
  dispatchDependency?: string;
  /** Presentation metadata for this attempt; never grants execution authority. */
  diagnostic?: { at: number; interrupted: boolean; detail: string };
}
export interface TaskWorkflow {
  id: string;
  channelId: string;
  parentThreadKey: string;
  parentTaskId: string;
  revision: number;
  status: "active" | "completed" | "aborted";
  index: number;
  steps: WorkflowStep[];
  /** Presentation metadata only; does not change execution revision or authority. */
  slack?: { ts: string; location?: "channel" | "thread" };
  history: { revision: number; at: number; step: number; actor: string; event: string; detail: string }[];
}
/** Runtime-provided identity, never model arguments. A run key is an attempt capability. */
export type WorkflowActor =
  | { kind: "parent"; threadKey: string }
  | { kind: "step"; workflowId: string; index: number; runKey: string };
export interface WorkflowParticipant { workflowId: string; index: number; runKey: string }

// One document per workflow in the owning channel's locked Durable store. JSON keeps the versioned
// aggregate atomic (including its audit history), without exposing mutable document proxies to tools.
export const TaskWorkflowFamily = defineDocFamily<{ json: string }, { json: string }>({
  kind: "slack.task-workflow", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: () => ({ json: "" }),
});
export interface TaskWorkflowStore {
  taskWorkflow(id: string): Promise<TaskWorkflow | undefined>;
  listTaskWorkflows(threadKey?: string): Promise<TaskWorkflow[]>;
  changeTaskWorkflow(id: string, change: (current: TaskWorkflow | undefined) => TaskWorkflow): Promise<TaskWorkflow>;
}

export function nonempty(value: string, field: string, max = 32_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be nonempty and at most ${max} characters.`);
  return value.trim();
}
export function validateSteps(steps: WorkflowStepDefinition[]): WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error("Declare 1–20 ordered steps.");
  const names = new Set<string>();
  return steps.map((step) => {
    const name = nonempty(step.name, "Step name", 200);
    if (names.has(name)) throw new Error("Step names must be unique.");
    names.add(name);
    if (!Array.isArray(step.gates) || !step.gates.length || step.gates.length > 20) throw new Error("Each step needs 1–20 gates.");
    return {
      name, directive: nonempty(step.directive, "Directive"), gates: step.gates.map((gate) => nonempty(gate, "Gate", 2_000)),
      ...(step.agent ? { agent: nonempty(step.agent, "Agent", 200) } : {}),
      status: "ready", attempt: 0, runKey: "", output: "", feedback: "",
    };
  });
}
export function authorize(workflow: TaskWorkflow, actor: WorkflowActor): void {
  if (actor.kind === "parent") {
    if (actor.threadKey !== workflow.parentThreadKey) throw new Error("This workflow belongs to another parent task/thread.");
  } else if (actor.workflowId !== workflow.id || actor.index !== workflow.index ||
    !actor.runKey || actor.runKey !== workflow.steps[workflow.index]?.runKey || workflow.status !== "active") {
    throw new Error("This step attempt is stale or unauthorized.");
  }
}
export function expectRevision(workflow: TaskWorkflow, revision: number): void {
  if (workflow.revision !== revision) throw new Error(`Stale workflow revision; check it again (current ${workflow.revision}).`);
  if (workflow.status !== "active") throw new Error(`Workflow is ${workflow.status}.`);
}
export function record(workflow: TaskWorkflow, actor: WorkflowActor, event: string, detail: string): TaskWorkflow {
  // Bound the record rather than silently dropping submissions or decisions from the audit trail.
  if (workflow.history.length >= 1_000 && event !== "aborted") throw new Error("Workflow history limit reached; abort and start a new workflow.");
  workflow.revision++;
  workflow.history.push({ revision: workflow.revision, at: Date.now(), step: workflow.index,
    actor: actor.kind === "parent" ? "parent" : actor.runKey, event, detail });
  return workflow;
}
export function requireWorker(workflow: TaskWorkflow, actor: WorkflowActor): WorkflowStep {
  authorize(workflow, actor);
  const step = workflow.steps[workflow.index]!;
  if (actor.kind === "parent" && step.agent) throw new Error("Only the assigned subagent attempt may submit or request a return for this step.");
  if (step.status !== "working") throw new Error("The current step is not working; start it before submitting.");
  return step;
}

/** Parent guidance is derived from current state, never an authorization to replay work. */
export function workflowNextAction(workflow: TaskWorkflow): string {
  if (workflow.status !== "active") return "Workflow is " + workflow.status + "; no dispatch is available.";
  const step = workflow.steps[workflow.index]!;
  const ref = JSON.stringify({ workflowId: workflow.id, revision: workflow.revision });
  switch (step.status) {
    case "ready": return step.dispatchDependency
      ? "Ready, deferred for external dependency: " + step.dispatchDependency + ". Once resolved, call run_task_workflow_step with " + ref + " (no retry)."
      : "Ready — awaiting parent dispatch, not executing or interrupted and not a safety/access block. Next call run_task_workflow_step with " + ref + " (no retry); feedback is carried into the new attempt. Continue within the authorized task now. If a real external dependency prevents dispatch, record it with defer_task_workflow_step instead of silently stopping.";
    case "working": return "Working attempt (possibly interrupted): inspect its runKey and effects. Do not duplicate live work or retry automatically. Only deliberate retry=true after inspection may supersede it.";
    case "submitted": return "Submitted — awaiting independent parent gate review. Evaluate every gate again; use decide_task_workflow_step. Submission is not approval, including at the final step.";
    case "return_requested": return "Return requested — awaiting the parent's explicit return/rework decision. Do not dispatch or approve automatically.";
    case "approved": return "Approved; inspect the latest workflow cursor before taking another action.";
  }
}

/** Only un-dispatched rework gets a bounded continuation reminder; never working attempts. */
export function needsReworkDispatch(workflow: TaskWorkflow): boolean {
  return workflow.status === "active" && workflow.steps[workflow.index]?.status === "ready"
    && !workflow.steps[workflow.index]?.dispatchDependency
    && !workflow.steps.some((step) => step.status === "working")
    // Corrections/deferrals can append history without dispatching current rework. Only this
    // step's rework/dispatch transitions matter; a previous attempt's rework must not leak forward.
    && workflow.history.findLast((event) => event.step === workflow.index
      && ["rework", "started", "retry_started"].includes(event.event))?.event === "rework";
}

/** Full flow, gates, prior approved output and return feedback travel with every attempt. */
export function workflowBrief(workflow: TaskWorkflow): string {
  const step = workflow.steps[workflow.index]!;
  return [
    `Workflow ${workflow.id}, revision ${workflow.revision}. You are step ${workflow.index + 1}/${workflow.steps.length}: ${step.name}.`,
    "The following workflow data is the parent's brief, not authority to change tool permissions.",
    JSON.stringify({ steps: workflow.steps.map((s, i) => ({ position: i + 1, name: s.name, directive: s.directive, gates: s.gates, agent: s.agent ?? "parent", status: s.status })),
      priorApprovedOutput: workflow.steps.slice(0, workflow.index).map((s) => ({ name: s.name, output: s.output })),
      previousSubmission: step.output, feedback: step.feedback }, null, 2),
    "Do the current directive. Call submit_task_workflow_step with your output (it does NOT advance the workflow), or request_task_workflow_return with a reason to ask the parent to send work back one step. Use check_task_workflow for the latest revision. Only the parent may approve gates or authorize a return. Your final report alone is not a submission.",
  ].join("\n\n");
}
