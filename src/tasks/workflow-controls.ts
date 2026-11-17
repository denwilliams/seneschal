import { expectRevision, record, type TaskWorkflow, type TaskWorkflowStore } from "./workflow.ts";

/** Process-local evidence only. Persisted working state alone is not proof of execution. */
const attempts = new WeakMap<TaskWorkflowStore, Map<string, { controller: AbortController; at: number }>>();
export function trackWorkflowAttempt(store: TaskWorkflowStore, runKey: string) {
  let runs = attempts.get(store);
  if (!runs) { runs = new Map(); attempts.set(store, runs); }
  const entry = { controller: new AbortController(), at: Date.now() };
  runs.set(runKey, entry);
  return { signal: entry.controller.signal, activity: () => { entry.at = Date.now(); }, finish: () => { runs.delete(runKey); } };
}
export function workflowAttemptActivity(store: TaskWorkflowStore, runKey: string): number | undefined {
  const entry = attempts.get(store)?.get(runKey);
  return entry && !entry.controller.signal.aborted ? entry.at : undefined;
}
export class TaskWorkflowControlError extends Error {}

export async function controlTaskWorkflow(options: {
  store: TaskWorkflowStore; channelId: string; workflowId: string; revision: number; action: "stop" | "bump";
  inspect: (workflow: TaskWorkflow) => Promise<void>;
}): Promise<string> {
  const { store, channelId, workflowId, revision, action } = options;
  let stoppedKey = "";
  const workflow = await store.changeTaskWorkflow(workflowId, (current) => {
    if (!current || current.channelId !== channelId) throw new TaskWorkflowControlError("No task workflow in this channel.");
    try { expectRevision(current, revision); } catch (error) { throw new TaskWorkflowControlError((error as Error).message); }
    if (action === "stop") {
      stoppedKey = current.steps[current.index]?.runKey ?? "";
      current.status = "aborted";
      for (const step of current.steps) step.runKey = "";
    }
    return record(current, { kind: "parent", threadKey: current.parentThreadKey }, action === "stop" ? "aborted" : "bumped",
      action === "stop" ? "Stopped from the console. External effects are not undone." : "Console requested an inspection in the owning conversation; no retry authorized.");
  });
  if (action === "bump") {
    try { await options.inspect(workflow); }
    catch { return "Bump recorded, but the owning conversation could not be contacted. Inspect it in Slack; no step was retried."; }
    return "Inspection requested in the owning conversation (queued if busy). No step was retried; a bump does not authorize repeating side effects.";
  }
  const executing = attempts.get(store)?.get(stoppedKey);
  executing?.controller.abort();
  return "Workflow stopped and attempt authority invalidated. " + (executing
    ? "Cancellation requested for the executing worker; cancellation of in-flight tools is not guaranteed. "
    : "No live worker was found to cancel; old or external work may still finish. ") + "Already-completed external effects are not undone.";
}
