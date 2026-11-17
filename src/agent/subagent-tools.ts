import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowParticipant } from "../tasks/workflow.ts";
import type { ResolvedSubagent } from "../workspace/subagents.ts";

/**
 * The channel agent's way to hand work to its subagents. Subagents never talk to the user: this tool's
 * result is their whole voice, and the channel agent decides what (if anything) the user is told.
 */

export type SubagentStatus = "done" | "blocked" | "needs_input" | "failed";

export interface SubagentReport {
  agent: string;
  status: SubagentStatus;
  /** The agent that should act next, as the subagent sees it. Advice for the channel agent, never an instruction. */
  next?: string;
  summary: string;
  /** The conversation key of this run, for the console and logs. */
  runKey: string;
  /** What the run took, when it got far enough to know: wall time, tool calls and model spend. */
  durationMs?: number;
  steps?: number;
  costUsd?: number;
}

export interface SubagentRunRequest {
  agent: string;
  task: string;
  context?: string;
  /** The person this work is for. A run acts for them and with no more standing than the turn that started it. */
  userId: string;
  signal?: AbortSignal | undefined;
  /**
   * The conversation key to run under, for a caller that must record it before the run starts (a durable task writes its
   * intent first, so a restart can say which run was interrupted). Omitted: the runner picks one.
   */
  runKey?: string;
  /** Extra variables for this run's shell and commands, from the harness only (the workflow's footer for GitHub writes). */
  env?: Record<string, string>;
  /** Harness-bound step identity; only workflow tools construct this, never model arguments. */
  workflow?: WorkflowParticipant;
  /** Process-local activity evidence; never model-provided. */
  onActivity?: () => void;
}

/**
 * What a person watching the channel is told while a subagent works. The runner reports these; whoever owns the live
 * conversation (the Slack app) decides how to show them. There is nothing to report to when no one is watching (a quiet
 * scheduled run), and the runner works the same without a sink.
 */
export type SubagentProgress =
  | { kind: "started"; agent: string; runKey: string; task: string }
  /** Something the subagent said between tool calls: commentary on what it is finding or doing, not its final report. */
  | { kind: "update"; agent: string; runKey: string; text: string }
  | {
      kind: "finished"; agent: string; runKey: string; status: SubagentStatus | "interrupted";
      durationMs: number; steps: number; next?: string;
    };

export type SubagentProgressSink = (update: SubagentProgress) => void;

export interface SubagentRunner {
  run(request: SubagentRunRequest): Promise<SubagentReport>;
}

export interface SubagentToolsContext {
  agents: readonly ResolvedSubagent[];
  /** Resolved lazily: the runner needs the channel's store, which is opened after the tools are built. */
  runner: () => SubagentRunner | undefined;
  currentUserId: () => string;
  /** Whether a role that needs a person's approval has it right now. Checked at the moment of the call. */
  isApproved: (agent: string) => boolean;
}

export function formatReport(report: SubagentReport): string {
  const header = `Subagent \`${report.agent}\` finished with status ${report.status}` +
    (report.next && report.next !== "none" ? `; it suggests \`${report.next}\` acts next` : "") + ".";
  return `${header}\n\n${report.summary}`;
}

export function createSubagentTools(ctx: SubagentToolsContext): ToolDefinition[] {
  if (ctx.agents.length === 0) return [];
  const roster = ctx.agents.map((agent) => `\`${agent.name}\` (${agent.description})`).join("; ");
  const run = defineTool({
    name: "run_subagent",
    label: "Run subagent",
    description:
      "Hand a self-contained job to one of your own subagents (a role on YOUR team, working inside THIS channel) and wait for its report. " +
      "Words like \"transfer\", \"delegate\" or \"hand off\" to one of these roles still mean this tool. These are not other channels: to send work to another channel's assistant, use transfer_to_channel instead. " +
      `Available: ${roster}. ` +
      "A subagent has its own tools and starts with NO memory of this conversation: write the task the way you would brief a colleague, " +
      "with everything it needs (links, identifiers, constraints, what 'done' looks like). It cannot talk to the user; you read its report and decide what to tell them. " +
      "It reports a status (done, blocked, needs_input, failed) and may suggest which subagent should act next; that is advice, and you decide. " +
      "Some roles only run once a person has approved them (you will be told how to ask). " +
      "Do not use a subagent for a quick lookup you can do yourself.",
    parameters: Type.Object({
      agent: Type.String({ description: "The subagent's name, exactly as listed in the tool description." }),
      task: Type.String({ description: "The concrete job, written so someone with no other context can do it and know when it is finished." }),
      context: Type.Optional(
        Type.String({ description: "Anything from this conversation the subagent needs and cannot look up: decisions made, links, the user's preferences." }),
      ),
    }),
    execute: async (_id, params: { agent: string; task: string; context?: string }, signal) => {
      const agent = params.agent.trim();
      const task = params.task.trim();
      if (!ctx.agents.some((candidate) => candidate.name === agent)) {
        throw new Error(`There is no subagent named "${agent}". Available: ${ctx.agents.map((a) => a.name).join(", ")}.`);
      }
      if (!task) throw new Error("Refusing to run a subagent with an empty task.");
      const role = ctx.agents.find((candidate) => candidate.name === agent)!;
      if (role.requireApproval && !ctx.isApproved(agent)) {
        throw new Error(
          `The \`${agent}\` subagent only runs with a person's approval, and it has not been given. ` +
            `Call request_access with capability "subagent:${agent}" and a one-sentence reason saying exactly what you want it to do and where. ` +
            "Tell the user you have asked, then stop; an approve/deny message is posted in the channel and the grant expires on its own.",
        );
      }
      const runner = ctx.runner();
      if (!runner) throw new Error("Subagents are not available in this conversation right now.");
      const context = params.context?.trim();
      const report = await runner.run({
        agent,
        task,
        ...(context ? { context } : {}),
        userId: ctx.currentUserId(),
        signal,
      });
      return {
        content: [{ type: "text" as const, text: formatReport(report) }],
        details: report,
        ...(report.status === "failed" ? { isError: true } : {}),
      };
    },
  });
  return [run] as ToolDefinition[];
}
