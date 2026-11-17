import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ScheduleToolsContext, ScheduleService } from "./schedule-tools.ts";
import { nextRunOf } from "./schedules.ts";

export function heartbeatContext(service: ScheduleService, channelId: string): string {
  const task = service.list(channelId).find((task) => task.heartbeat);
  return task
    ? `Channel heartbeat: ${task.enabled ? "enabled" : "paused"}, every ${task.intervalMinutes} minutes. Use read_heartbeat to inspect the current prompt before editing it.`
    : "Channel heartbeat: not configured. Use update_heartbeat with an explicit interval to opt in when ongoing monitoring is requested.";
}

export function createHeartbeatTools(ctx: ScheduleToolsContext): ToolDefinition[] {
  const snapshot = () => {
    const task = ctx.service.list(ctx.channelId).find((task) => task.heartbeat);
    const details = task ? { prompt: task.prompt, interval_minutes: task.intervalMinutes,
      enabled: task.enabled === true, next: nextRunOf(task)?.toISOString() } : { configured: false };
    return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
  };
  return [
    defineTool({
      name: "read_heartbeat", label: "Read heartbeat",
      description: "Inspect this channel's persistent heartbeat prompt, interval and enabled state. Read before editing so unrelated ongoing watches survive.",
      parameters: Type.Object({}), execute: async () => snapshot(),
    }),
    defineTool({
      name: "update_heartbeat", label: "Update heartbeat",
      description: "Create or maintain this channel's quiet monitoring loop. On creation supply interval_minutes (no default cadence). " +
        "Read first; when changing an existing prompt, pass its exact previous text as expected_prompt, preserving unrelated watches. " +
        "Omitted fields stay unchanged. enabled:false pauses without deleting the prompt. 'nothing to do' skips the model entirely. " +
        "Checks retain this channel's connector and safety limits. Notify explicitly only when warranted; never post routine completions.",
      parameters: Type.Object({
        prompt: Type.Optional(Type.String({ description: "Complete replacement prompt; preserve unrelated watches." })),
        expected_prompt: Type.Optional(Type.String({ description: "Exact current prompt from read_heartbeat, required to replace an existing prompt." })),
        interval_minutes: Type.Optional(Type.Number({ description: "Interval in minutes, subject to the operator's scheduling minimum." })),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params: { prompt?: string; expected_prompt?: string; interval_minutes?: number; enabled?: boolean }) => {
        if (params.prompt === undefined && params.interval_minutes === undefined && params.enabled === undefined) {
          throw new Error("Provide prompt, interval_minutes or enabled.");
        }
        const current = ctx.service.list(ctx.channelId).find((task) => task.heartbeat);
        if (current) {
          ctx.service.update(ctx.channelId, current.id, {
            prompt: params.prompt, expectedPrompt: params.expected_prompt,
            intervalMinutes: params.interval_minutes, enabled: params.enabled,
          });
        } else {
          if (params.interval_minutes === undefined) throw new Error("Choose interval_minutes to configure a heartbeat; none is enabled by default.");
          ctx.service.create({ channelId: ctx.channelId, createdBy: ctx.currentUserId(),
            heartbeat: true, intervalMinutes: params.interval_minutes, enabled: params.enabled,
            prompt: params.prompt ?? "nothing to do", quiet: true });
        }
        return snapshot();
      },
    }),
  ] as ToolDefinition[];
}
