import type { TaskWorkflow } from "../tasks/workflow.ts";
import type { WorkflowRunView } from "./api-types.ts";

const RESULT_CHARS = 6_000;
const bound = (text: string): string => text.length > RESULT_CHARS ? text.slice(0, RESULT_CHARS - 1) + "…" : text;

/** Adapt task state without exposing attempt capabilities, directives or raw history. */
export function taskWorkflowRunView(workflow: TaskWorkflow, direct: boolean, options: { actions?: boolean; bump?: boolean; executingAt?: number; lastAt?: number; blocked?: string } = {}): WorkflowRunView {
  const label = (index: number): string => direct ? `Stage ${index + 1}` : workflow.steps[index]?.name ?? "";
  const current = Math.min(workflow.index, workflow.steps.length - 1);
  const reviewing = ["submitted", "return_requested"].includes(workflow.steps[current]?.status ?? "");
  const first = workflow.history[0]?.at ?? 0;
  const last = workflow.history.at(-1)?.at ?? first;
  const step = workflow.steps[current];
  const activityAt = Math.max(options.lastAt ?? 0, options.executingAt ?? 0, step?.status === "working" ? step.diagnostic?.at ?? 0 : 0,
    ...workflow.history.filter((entry) => entry.step === current && entry.event !== "bumped").map((entry) => entry.at));
  const state = workflow.status === "aborted" ? "stopped" : workflow.status === "completed" ? "completed"
    : reviewing ? "waiting" : step?.status === "ready" ? "ready" : options.blocked || step?.diagnostic?.interrupted ? "interrupted"
    : options.executingAt !== undefined ? "executing" : step?.diagnostic ? "waiting" : "unknown";
  const summaries = {
    stopped: "Workflow stopped. Attempt authority is invalid; external effects are not undone.",
    completed: "Workflow completed after parent approval.",
    waiting: reviewing ? "Waiting for the parent to review the submission or return request." : "The worker returned without submitting. Waiting for the parent to inspect the report and any external effects; no retry is automatic.",
    ready: "Waiting for the parent to start the next step.",
    interrupted: options.blocked ? "The channel is paused by interruption recovery; work cannot safely resume yet." : "The attempt was interrupted. Inspect its effects before considering any retry.",
    executing: "A live worker attempt is executing, possibly waiting on a model or tool. Activity is not proof of progress.",
    unknown: "No live worker is confirmed. The persisted working attempt may have been interrupted or finished without submitting. The cause is unknown; inspect before retrying.",
  };
  return {
    taskControl: { revision: workflow.revision, actions: options.actions && workflow.status === "active" ? ["stop", ...(options.bump ? ["bump" as const] : [])] : [] },
    taskActivity: { state, summary: summaries[state], ...(activityAt > 0 ? { lastAt: new Date(activityAt).toISOString() } : {}),
      ...(!direct && (options.blocked || step?.status === "working" && step.diagnostic?.detail) ? { diagnostic: bound(options.blocked || step!.diagnostic!.detail) } : {}) },
    kind: "task", runId: workflow.id, repo: "", issue: 0,
    ...(!direct ? { title: workflow.steps.map((step) => step.name).join(" → ").slice(0, 200) } : {}),
    status: workflow.status === "active" ? reviewing ? "waiting" : "running" : workflow.status,
    current: label(current), round: 0, risk: { scored: false },
    by: { source: "agent", threadKey: workflow.parentThreadKey }, origin: "manual",
    updates: { trusted: 0, untrusted: 0 }, updatesReceived: [],
    startedAt: new Date(first).toISOString(),
    ...(workflow.status !== "active" ? { endedAt: new Date(last).toISOString() } : {}), costUsd: 0,
    stages: workflow.steps.map((step, index) => ({
      name: label(index), kind: "agent", ...(!direct && step.agent ? { role: step.agent } : {}),
      status: step.status === "approved" ? "success" : step.status === "ready" ? "not_started" : "in_progress",
      taskStatus: step.status, entries: step.attempt, attempts: [],
      result: {
        available: !!step.output,
        ...(!direct && step.output ? { summary: bound(step.output), ...(step.output.length > RESULT_CHARS ? { truncated: true } : {}) } : {}),
        ...(!direct && step.feedback ? { feedback: bound(step.feedback) } : {}),
      },
    })),
  };
}
