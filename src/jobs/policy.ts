import { argsAllowed, describeAllowArgs } from "../agent/argv-patterns.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { parseTemplate, type JobDefinition, type JobPhase } from "./definition.ts";

/** The part of a channel a job's permissions come from. */
export type JobChannel = Pick<ResolvedChannel, "tools" | "exec">;

/**
 * Why a phase may not run in this channel, or undefined when it may.
 *
 * The ceiling: a job can never do more than the channel could already do interactively. So an `exec` phase needs the `exec`
 * tool to be on, and the command to be one of this channel's own `exec.commands`. This is checked when a run starts, again
 * before every exec phase begins, and by the recovery gate on a run a restart interrupted, so a permission removed from the
 * channel stops a job that depended on it.
 */
export function phaseProblem(phase: JobPhase, channel: JobChannel): string | undefined {
  if (phase.kind === "state") return undefined;
  if (!channel.tools.includes("exec")) return "this channel does not have the exec tool, so a job cannot run commands here";
  const command = channel.exec.commands[phase.command];
  if (!command) {
    const names = Object.keys(channel.exec.commands);
    return `there is no command "${phase.command}" in this channel's exec policy${names.length ? ` (it has ${names.map((n) => `"${n}"`).join(", ")})` : ""}`;
  }
  // Arguments with no references are known now, so a job that could never pass the allowlist is refused before it starts.
  const literal: string[] = [];
  for (const arg of phase.args) {
    const parsed = parseTemplate(arg);
    if ("error" in parsed || parsed.some((part) => "ref" in part)) return undefined;
    literal.push(parsed.map((part) => ("text" in part ? part.text : "")).join(""));
  }
  if (!command.allowAllArgs && !argsAllowed(command.allowArgs, literal)) {
    return `the arguments ${JSON.stringify(literal)} are not allowed for "${phase.command}" (allowed: ${describeAllowArgs(command.allowArgs)})`;
  }
  return undefined;
}

/** The first reason any phase of a job cannot run here, naming the phase, or undefined. */
export function jobProblem(definition: JobDefinition, channel: JobChannel): string | undefined {
  for (const phase of definition.phases) {
    const problem = phaseProblem(phase, channel);
    if (problem) return `phase "${phase.name}": ${problem}`;
  }
  return undefined;
}
