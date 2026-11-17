import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describeState, StateError, STATE_LIMITS, type StateJson, type StateObject, type StateOp, type StateRead } from "./durable/state.ts";

/** What the state tools need from the channel's store. The real one is `DurableChannelStore`. */
export interface StateService {
  readState(path?: string): Promise<StateRead & { rev: number; updatedAt: number }>;
  stateSnapshot(): Promise<{ rev: number; value: StateObject; bytes: number }>;
  updateState(input: { op: StateOp; path: string; value?: StateJson; expectedRev?: number; by: { source: "agent"; threadKey?: string; userId?: string } }): Promise<{ rev: number; changed: boolean }>;
}

export interface StateToolsContext {
  /** Resolved when a tool runs, because the store does not exist until after the tools are built. Absent fails closed. */
  store: () => StateService | undefined;
  threadKey: string;
  currentUserId: () => string;
}

/** Past this a value is summarized rather than returned whole, so one read cannot swamp the context. */
const MAX_READ_CHARS = 24_000;

const text = (body: string, details: Record<string, unknown> | null = null) => ({ content: [{ type: "text" as const, text: body }], details });

/** A refusal is told to the model plainly, with what it needs to fix the call. Anything else is not for the model to see. */
function explain(error: unknown): never {
  if (error instanceof StateError) throw new Error(error.message);
  throw error;
}

/**
 * `state_read` and `state_update`: the channel's shared state object. It is one JSON object for the whole channel, the same
 * from every thread and for every subagent, so it is for working data several conversations (or runs) need to agree on.
 */
export function createStateTools(ctx: StateToolsContext): ToolDefinition[] {
  const service = (): StateService => {
    const store = ctx.store();
    if (!store) throw new Error("The state object is not available in this session.");
    return store;
  };

  const read = defineTool({
    name: "state_read",
    label: "Read the channel state",
    description:
      "Read the channel's shared state object, or part of it. It is one JSON object for this whole channel, the same from every thread, " +
      "for structured working data: cursors, counters, the last result of a job, a checklist. It is not memory: use `remember` for facts to recall later. " +
      "Give a JSON Pointer path such as /jobs/last/status to read part of it; leave it out for everything. " +
      "Returns the value and its revision. Pass that revision as expectedRev to state_update to make sure nothing changed in between.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'JSON Pointer to read: "" or omitted for the whole object, or like "/jobs/last/status". Use "~1" for "/" and "~0" for "~" inside a key.' })),
    }),
    execute: async (_id, params: { path?: string }) => {
      try {
        const path = params.path ?? "";
        const result = await service().readState(path);
        if (!result.found) return text(JSON.stringify({ rev: result.rev, path, found: false }), { rev: result.rev, found: false });
        const body = JSON.stringify({ rev: result.rev, path, found: true, value: result.value }, null, 2);
        if (body.length <= MAX_READ_CHARS) return text(body, { rev: result.rev, found: true });
        const summary = result.value !== null && typeof result.value === "object" && !Array.isArray(result.value)
          ? describeState(result.value as StateObject)
          : undefined;
        return text(JSON.stringify({
          rev: result.rev, path, found: true, truncated: true,
          note: `The value is ${body.length} characters, too large to return whole. Read a smaller path.`,
          ...(summary ? { keys: summary } : {}),
        }, null, 2), { rev: result.rev, found: true, truncated: true });
      } catch (error) {
        explain(error);
      }
    },
  });

  const update = defineTool({
    name: "state_update",
    label: "Update the channel state",
    description:
      "Change the channel's shared state object. One call is one atomic change; two threads updating at once never lose each other's work. Operations: " +
      '"set" writes a value at a path (creating objects on the way; path "" replaces everything and must be an object), ' +
      '"merge" copies the keys of an object value onto the object at the path, one level deep, ' +
      '"delete" removes a key or array item (nothing there is fine), ' +
      '"append" adds a value to the end of the array at the path (created if missing). ' +
      "Paths are JSON Pointers like /jobs/last/status. Values are plain JSON. " +
      `The whole object is limited to ${STATE_LIMITS.bytes} bytes, ${STATE_LIMITS.depth} levels deep, ${STATE_LIMITS.arrayItems} items per array, ${STATE_LIMITS.stringChars} characters per string. ` +
      "Pass expectedRev (from state_read) to fail instead of overwriting a change someone else made since you read it. " +
      "Returns the new revision, and whether anything actually changed.",
    parameters: Type.Object({
      op: Type.Union([Type.Literal("set"), Type.Literal("merge"), Type.Literal("delete"), Type.Literal("append")], { description: "set, merge, delete or append." }),
      path: Type.String({ description: 'JSON Pointer to change: "" for the whole object, or like "/jobs/last/status".' }),
      value: Type.Optional(Type.Unknown({ description: "The JSON value for set, merge (an object) and append. Not used by delete." })),
      expectedRev: Type.Optional(Type.Integer({ minimum: 0, description: "Refuse the change unless the state is at exactly this revision." })),
    }),
    execute: async (_id, params: { op: StateOp; path: string; value?: StateJson; expectedRev?: number }) => {
      try {
        const result = await service().updateState({
          op: params.op, path: params.path,
          ...(params.value !== undefined ? { value: params.value } : {}),
          ...(params.expectedRev !== undefined ? { expectedRev: params.expectedRev } : {}),
          by: { source: "agent", threadKey: ctx.threadKey, userId: ctx.currentUserId() },
        });
        return text(
          result.changed ? `Updated. The state is now at revision ${result.rev}.` : `Nothing changed: the state was already like that (revision ${result.rev}).`,
          { rev: result.rev, changed: result.changed },
        );
      } catch (error) {
        explain(error);
      }
    },
  });

  return [read, update] as ToolDefinition[];
}
