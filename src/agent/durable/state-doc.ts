import { defineDoc } from "@earendil-works/pi-durable";
import { applyOp, StateError, STATE_LIMITS, type StateJson, type StateObject, type StateOp } from "./state.ts";

/** Who made a state change. Empty strings, not absent keys: a document holds plain JSON. */
export type StateWriter = { source: "agent" | "job" | "operator"; threadKey: string; userId: string };
export type StateChange = { rev: number; at: number; op: StateOp; path: string; source: StateWriter["source"]; threadKey: string };
/**
 * The channel's state object (see `state.ts`). A session-scoped document: one per store, so one per channel, shared by every
 * conversation in it. A fork does not copy it, because it is not conversation state.
 */
export const AppStateDoc = defineDoc<{ rev: number; value: StateObject; updatedAt: number; updatedBy: StateWriter; changes: StateChange[] }>({
  kind: "slack.state", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ rev: 0, value: {}, updatedAt: 0, updatedBy: { source: "agent", threadKey: "", userId: "" }, changes: [] }),
});

/** The part of a state document an update touches. Both a plain object and a pi-durable `Draft` of one satisfy it. */
export interface StateDocShape {
  rev: number;
  value: StateObject;
  updatedAt: number;
  updatedBy: StateWriter;
  changes: StateChange[];
}

export interface StateUpdate {
  op: StateOp;
  path: string;
  value?: StateJson;
  expectedRev?: number;
  by: { source: StateWriter["source"]; threadKey?: string; userId?: string };
}

/**
 * One update of the state document, to be run inside a commit: check the revision, apply the operation, and on a change
 * advance the revision, record who and when, and keep the change log to its limit. Refusals come back as `{ error }` and
 * leave the document untouched. Shared by `DurableChannelStore.updateState` and the jobs' `state` phase, so a job's write is
 * exactly as atomic and as checked as an agent's.
 */
export function applyStateUpdate(doc: StateDocShape, input: StateUpdate): { rev: number; changed: boolean } | { error: StateError } {
  if (input.expectedRev !== undefined && input.expectedRev !== doc.rev) {
    return { error: new StateError("conflict", `The state is at revision ${doc.rev}, not ${input.expectedRev}. Read it again, then retry with the new revision.`, doc.rev) };
  }
  let result: { root: StateObject; changed: boolean };
  try {
    result = applyOp(JSON.parse(JSON.stringify(doc.value)) as StateObject, { op: input.op, path: input.path, ...(input.value !== undefined ? { value: input.value } : {}) });
  } catch (error) {
    if (error instanceof StateError) return { error };
    throw error;
  }
  if (!result.changed) return { rev: doc.rev, changed: false };
  const at = Date.now();
  doc.value = result.root;
  doc.rev += 1;
  doc.updatedAt = at;
  doc.updatedBy = { source: input.by.source, threadKey: input.by.threadKey ?? "", userId: input.by.userId ?? "" };
  doc.changes.push({ rev: doc.rev, at, op: input.op, path: input.path, source: input.by.source, threadKey: input.by.threadKey ?? "" });
  if (doc.changes.length > STATE_LIMITS.changeLog) doc.changes.splice(0, doc.changes.length - STATE_LIMITS.changeLog);
  return { rev: doc.rev, changed: true };
}
