import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ScheduleError,
  describeSchedule,
  nextRunOf,
  type ScheduledTask,
  type ScheduledThread,
  type UpdateScheduleInput,
} from "./schedules.ts";

/**
 * Lets the agent schedule its own follow-up work from a conversation:
 * "check the backups every morning", "remind me on Friday", "watch that PR
 * and tell me when CI goes green".
 *
 * Everything scheduled here runs in the channel it was created in. By default
 * each firing posts a new channel message; one-shot check-backs can instead
 * resume the current Slack thread. There is no cross-channel scheduling by design.
 */

export interface ScheduleService {
  create(input: {
    channelId: string;
    prompt: string;
    cron?: string;
    runAt?: string;
    timezone?: string;
    createdBy: string;
    heartbeat?: boolean;
    intervalMinutes?: number;
    enabled?: boolean;
    quiet?: boolean;
    runIfMissed?: boolean;
    thread?: ScheduledThread;
  }): ScheduledTask;
  update(channelId: string, id: string, patch: UpdateScheduleInput): ScheduledTask | undefined;
  list(channelId: string): ScheduledTask[];
  cancel(channelId: string, id: string): boolean;
}

export interface ScheduleToolsContext {
  service: ScheduleService;
  channelId: string;
  /** Slack user id of whoever is talking, for attribution. */
  currentUserId: () => string;
  defaultTimezone: string;
  /** Current Slack thread, if this session can be resumed later. */
  currentThread?: () => ScheduledThread | undefined;
}

export function createScheduleTools(ctx: ScheduleToolsContext): ToolDefinition[] {
  const schedule = defineTool({
    name: "schedule_task",
    label: "Schedule task",
    description:
      "Schedule work to run later in this channel, either once or on a repeating schedule. " +
      "The prompt is what you will be asked to do when it fires, so write it as a standalone " +
      "instruction. By default the task starts a new channel post; for one-shot check-backs " +
      "from the current Slack thread, pass in_thread: true. Use quiet: true for polling tasks " +
      "that should stay silent unless they explicitly publish. For cron tasks that should run once " +
      "after the harness was offline for a scheduled time, use run_if_missed: true. Use this when someone asks for " +
      "a reminder, a recurring check, or a follow-up.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "What to do when this fires, as a complete standalone instruction. E.g. 'Check whether the backup ran last night and report the result.'",
      }),
      cron: Type.Optional(
        Type.String({
          description:
            "5-field cron for repeating work: minute hour day-of-month month day-of-week. E.g. '0 8 * * 1-5' for weekdays at 8am. Omit for one-shot.",
        }),
      ),
      runAt: Type.Optional(
        Type.String({
          description:
            "ISO 8601 timestamp for one-shot work, e.g. '2026-08-09T09:00:00'. Omit for repeating.",
        }),
      ),
      timezone: Type.Optional(
        Type.String({
          description: `IANA timezone, e.g. 'Australia/Sydney'. Defaults to ${ctx.defaultTimezone}.`,
        }),
      ),
      quiet: Type.Optional(
        Type.Boolean({
          description:
            "Suppress the automatic scheduled message and normal reply. Use true for polling or threshold checks where the channel should only see an explicit post_message/upload_file when the condition is met.",
        }),
      ),
      run_if_missed: Type.Optional(
        Type.Boolean({
          description:
            "For recurring cron schedules only: run one catch-up execution after startup if the latest scheduled time was missed while the harness was offline.",
        }),
      ),
      in_thread: Type.Optional(
        Type.Boolean({
          description:
            "For a one-shot follow-up, resume the current Slack thread when this fires instead of starting a new channel post. Use only with runAt.",
        }),
      ),
    }),
    execute: async (
      _id,
      params: {
        prompt: string;
        cron?: string;
        runAt?: string;
        timezone?: string;
        quiet?: boolean;
        run_if_missed?: boolean;
        in_thread?: boolean;
      },
    ) => {
      try {
        if (params.run_if_missed && !params.cron) {
          throw new ScheduleError("`run_if_missed` is only for recurring cron schedules.");
        }
        if (params.in_thread && !params.runAt) {
          throw new ScheduleError(
            "`in_thread` is for one-shot check-backs; use it with `runAt`, not `cron`.",
          );
        }
        if (params.in_thread && params.quiet) {
          throw new ScheduleError("Use either `in_thread` or `quiet`, not both.");
        }
        const thread = params.in_thread ? ctx.currentThread?.() : undefined;
        if (params.in_thread && !thread) {
          throw new ScheduleError("There is no current Slack thread to resume later.");
        }
        const task = ctx.service.create({
          channelId: ctx.channelId,
          prompt: params.prompt,
          ...(params.cron ? { cron: params.cron } : {}),
          ...(params.runAt ? { runAt: params.runAt } : {}),
          ...(params.timezone ? { timezone: params.timezone } : {}),
          ...(thread ? { thread } : {}),
          createdBy: ctx.currentUserId(),
          ...(params.quiet ? { quiet: true } : {}),
          ...(params.run_if_missed ? { runIfMissed: true } : {}),
        });
        const next = nextRunOf(task);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Scheduled ${task.quiet ? "quietly " : ""}as ` +
                `\`${task.id}\`${task.thread ? " in this thread" : ""}` +
                `${task.runIfMissed ? " with missed-run catch-up" : ""}. ` +
                `Next run: ${next ? next.toISOString() : "unknown"} (${task.timezone}).`,
            },
          ],
          details: {
            id: task.id,
            next: next?.toISOString(),
            quiet: task.quiet === true,
            runIfMissed: task.runIfMissed === true,
            ...(task.thread ? { threadTs: task.thread.threadTs } : {}),
          },
        };
      } catch (err) {
        // ScheduleError messages are written for the model to act on.
        if (err instanceof ScheduleError) throw new Error(err.message);
        throw err;
      }
    },
  });

  const list = defineTool({
    name: "list_scheduled_tasks",
    label: "List scheduled tasks",
    description: "List work already scheduled in this channel, with the next run time of each.",
    parameters: Type.Object({}),
    execute: async () => {
      const tasks = ctx.service.list(ctx.channelId);
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Nothing is scheduled in this channel." }],
          details: { count: 0 },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: tasks.map((t) => describeSchedule(t)).join("\n"),
          },
        ],
        details: { count: tasks.length },
      };
    },
  });

  const update = defineTool({
    name: "update_scheduled_task",
    label: "Update scheduled task",
    description:
      "Edit an existing scheduled task in this channel without changing its id. Omitted fields stay unchanged. " +
      "Supplying cron or runAt replaces the previous timing mode; do not supply both. " +
      "Switching to one-shot requires run_if_missed: false if catch-up is enabled. " +
      "Thread-targeted tasks cannot become recurring or quiet. A timezone-only edit does not move a one-shot's absolute time.",
    parameters: Type.Object({
      id: Type.String({ description: "The task id, as shown by list_scheduled_tasks." }),
      prompt: Type.Optional(Type.String({ description: "Replacement standalone instructions for the task." })),
      cron: Type.Optional(Type.String({ description: "Replacement recurring cron expression; replaces any one-shot runAt." })),
      runAt: Type.Optional(Type.String({ description: "Replacement one-shot ISO 8601 timestamp; replaces any cron expression." })),
      timezone: Type.Optional(Type.String({ description: "Replacement IANA timezone, e.g. Australia/Sydney." })),
      quiet: Type.Optional(
        Type.Boolean({
          description:
            "True makes the task quiet: no automatic scheduled message and no normal reply. False restores the visible scheduled run thread.",
        }),
      ),
      run_if_missed: Type.Optional(
        Type.Boolean({
          description:
            "For recurring cron schedules only: true runs one catch-up execution after startup if the latest scheduled time was missed while offline; false disables that behavior.",
        }),
      ),
    }),
    execute: async (_id, params: {
      id: string;
      prompt?: string;
      cron?: string;
      runAt?: string;
      timezone?: string;
      quiet?: boolean;
      run_if_missed?: boolean;
    }) => {
      const patch: UpdateScheduleInput = {
        ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
        ...(params.cron !== undefined ? { cron: params.cron } : {}),
        ...(params.runAt !== undefined ? { runAt: params.runAt } : {}),
        ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
        ...(params.quiet !== undefined ? { quiet: params.quiet } : {}),
        ...(params.run_if_missed !== undefined ? { runIfMissed: params.run_if_missed } : {}),
      };
      if (Object.keys(patch).length === 0) {
        throw new Error("Provide at least one of `prompt`, `cron`, `runAt`, `timezone`, `quiet`, or `run_if_missed`.");
      }
      try {
        const task = ctx.service.update(ctx.channelId, params.id, patch);
        if (!task) {
          throw new Error(
            `No scheduled task \`${params.id}\` in this channel. Call list_scheduled_tasks to see the ids.`,
          );
        }
        const next = nextRunOf(task);
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated schedule:\n${describeSchedule(task)}`,
            },
          ],
          details: {
            id: task.id,
            prompt: task.prompt,
            ...(task.cron ? { cron: task.cron } : {}),
            ...(task.runAt ? { runAt: task.runAt } : {}),
            timezone: task.timezone,
            next: next?.toISOString(),
            quiet: task.quiet === true,
            runIfMissed: task.runIfMissed === true,
            ...(task.thread ? { threadTs: task.thread.threadTs } : {}),
          },
        };
      } catch (err) {
        if (err instanceof ScheduleError) throw new Error(err.message);
        throw err;
      }
    },
  });

  const cancel = defineTool({
    name: "cancel_scheduled_task",
    label: "Cancel scheduled task",
    description:
      "Cancel a scheduled task by id. Use list_scheduled_tasks first if you do not know the id.",
    parameters: Type.Object({
      id: Type.String({ description: "The task id, as shown by list_scheduled_tasks." }),
    }),
    execute: async (_id, params: { id: string }) => {
      const removed = ctx.service.cancel(ctx.channelId, params.id);
      if (!removed) {
        throw new Error(
          `No scheduled task \`${params.id}\` in this channel. Call list_scheduled_tasks to see the ids.`,
        );
      }
      return {
        content: [{ type: "text" as const, text: `Cancelled \`${params.id}\`.` }],
        details: { id: params.id },
      };
    },
  });

  return [schedule, list, update, cancel] as ToolDefinition[];
}
