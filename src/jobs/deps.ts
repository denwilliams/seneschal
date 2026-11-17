import { argsAllowed, describeAllowArgs } from "../agent/argv-patterns.ts";
import { runRestrictedCommandDetailed } from "../agent/restricted-exec.ts";
import { withBinOnPath } from "../agent/sandbox.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { phaseProblem } from "./policy.ts";
import type { JobDeps } from "./task.ts";
import type { JobRunData } from "./docs.ts";

/**
 * What a channel's job runs need, built from the channel's own configuration: the same command policy, working
 * directory, environment and limits its `exec` tool uses. An `exec` phase goes through the same argument policy as the
 * agent's own call would, so a job is exactly as constrained as the channel.
 */
export function createJobDeps(channel: ResolvedChannel, hooks: { onChange?: (run: JobRunData) => void } = {}): JobDeps {
  return {
    phaseProblem: (phase) => phaseProblem(phase, channel),
    ...(hooks.onChange ? { onChange: hooks.onChange } : {}),
    async exec({ command, args, timeoutSeconds, signal }) {
      const configured = channel.exec.commands[command];
      if (!configured) throw new Error(`there is no command "${command}" in this channel's exec policy`);
      if (!configured.allowAllArgs && !argsAllowed(configured.allowArgs, args)) {
        throw new Error(`arguments refused for ${command}: ${JSON.stringify(args)} (allowed: ${describeAllowArgs(configured.allowArgs)})`);
      }
      const outcome = await runRestrictedCommandDetailed({
        command: configured.command,
        argv: [...configured.args, ...args],
        cwd: channel.paths.workspace,
        env: { ...withBinOnPath(channel.env, channel.paths.bin, channel.globalBin), ...configured.env },
        // A phase may ask for less time than the command's own limit, never more.
        timeoutSeconds: Math.min(timeoutSeconds ?? configured.timeoutSeconds, configured.timeoutSeconds),
        maxOutputBytes: configured.maxOutputBytes,
        signal,
      });
      return {
        exitCode: outcome.exitCode, output: outcome.output, timedOut: outcome.timedOut, truncated: outcome.truncated,
        aborted: outcome.aborted === true, ...(outcome.startError ? { startError: outcome.startError } : {}),
      };
    },
  };
}
