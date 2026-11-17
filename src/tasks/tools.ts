import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TASK_STATUSES, type TaskLink, type TaskRunTracker, type TaskStatus } from "./store.ts";

/** Lets an agent make a real wait/block visible when automatic tool tracking cannot infer it. */
export function createTaskStatusTools(current: () => TaskRunTracker | undefined): ToolDefinition[] {
  return [defineTool({
    name: "set_task_status",
    label: "Set task status",
    description: "Update the web console task status for the substantive work in this turn. Use only when work is genuinely blocked or waiting on an external person/system, or when you are explicitly abandoning it; ordinary chat replies are not tasks.",
    parameters: Type.Object({
      status: Type.Union(TASK_STATUSES.map((status) => Type.Literal(status)) as any),
      detail: Type.Optional(Type.String({ description: "Brief public-safe reason or next dependency. Do not include secrets." })),
    }),
    execute: async (_id, params: { status: TaskStatus; detail?: string }) => {
      const tracker = current();
      if (!tracker) throw new Error("No active task turn is available to update.");
      const task = tracker.setStatus(params.status, params.detail);
      return { content: [{ type: "text" as const, text: `Task \`${task.id}\` is now ${task.status.replace(/_/g, " ")}.` }], details: task };
    },
  }), defineTool({
    name: "add_task_links",
    label: "Add task links",
    description: "Attach public-safe links to the substantive task in this turn, such as a pull request, incident, source thread, or report. Use this when a link makes the web console task status useful; do not add credentials or secret URLs.",
    parameters: Type.Object({
      links: Type.Array(Type.Object({
        url: Type.String({ description: "An http(s) URL." }),
        label: Type.Optional(Type.String({ description: "Optional short label, e.g. 'PR #84'." })),
      }), { minItems: 1, maxItems: 20 }),
    }),
    execute: async (_id, params: { links: TaskLink[] }) => {
      const tracker = current();
      if (!tracker) throw new Error("No active task turn is available to update.");
      const task = tracker.addLinks(params.links);
      return { content: [{ type: "text" as const, text: `Task \`${task.id}\` now has ${task.links?.length ?? 0} link(s).` }], details: task };
    },
  })] as ToolDefinition[];
}
