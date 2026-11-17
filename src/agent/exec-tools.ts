import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cliToolName, type ExecCommandConfig, type ExecConfig } from "../config/schema.ts";
import { argsAllowed, describeAllowArgs } from "./argv-patterns.ts";
import { runRestrictedCommand } from "./restricted-exec.ts";
import { withBinOnPath } from "./sandbox.ts";

/**
 * Restricted CLI access for channels that need a named command-line tool but
 * should not get a shell. Each configured command becomes one tool named
 * `cli__<name>`. The harness calls the executable directly with argv — no
 * shell, pipes, redirects, glob expansion or command substitution — and rejects
 * arguments that do not match the operator's allowlist before anything runs,
 * unless the operator explicitly trusts all arguments for this command.
 */

export interface ExecToolsContext {
  config: ExecConfig;
  /** Channel workspace; the command's cwd and the only path the agent normally sees. */
  cwd: string;
  /** Workspace bin directory, prepended to PATH just like bash gets. */
  binDir: string;
  /** The operator's global bin: after `binDir` on PATH, before the system's. */
  globalBinDir?: string;
  /** Effective channel environment. */
  env: Record<string, string>;
}

export { cliToolName } from "../config/schema.ts";

function describe(command: ExecCommandConfig): string {
  const fixed = command.args.length ? ` Fixed argv prefix: ${JSON.stringify(command.args)}.` : "";
  return [
    command.description || "Run this configured command-line tool with restricted argv.",
    "The harness executes the configured binary directly, not through a shell: no pipes, redirects, globbing or command substitution.",
    fixed,
    command.allowAllArgs
      ? "Whole-CLI access: allowAllArgs is enabled; all supplied arguments, including flags, are allowed (allowArgs is ignored)."
      : `Allowed supplied argv patterns: ${describeAllowArgs(command.allowArgs)}. Wildcards * and ** match positional tokens only, never flags; options must be explicit literals.`,
    `Timeout: ${command.timeoutSeconds}s. Output cap: ${command.maxOutputBytes} bytes.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function createExecTools(ctx: ExecToolsContext): ToolDefinition[] {
  return Object.entries(ctx.config.commands).map(([name, command]) =>
    defineTool({
      name: cliToolName(name),
      label: `Run ${name}`,
      description: describe(command),
      parameters: Type.Object({
        args: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Arguments to pass after the command's configured fixed argv prefix. Each item is one argv token, not a shell string.",
          }),
        ),
      }),
      execute: async (_id, params: { args?: string[] }) => {
        const supplied = params.args ?? [];
        if (!Array.isArray(supplied) || !supplied.every((a) => typeof a === "string")) {
          throw new Error("args must be an array of strings.");
        }
        if (!command.allowAllArgs && !argsAllowed(command.allowArgs, supplied)) {
          throw new Error(
            `Arguments refused for ${name}: ${JSON.stringify(supplied)}. Allowed patterns: ${describeAllowArgs(command.allowArgs)}. Wildcards * and ** match positional tokens only, never flags. Ask the operator to allowlist the option as a literal, or explicitly trust this entire CLI with allowAllArgs: true.`,
          );
        }

        const argv = [...command.args, ...supplied];
        const env = { ...withBinOnPath(ctx.env, ctx.binDir, ctx.globalBinDir), ...command.env };
        return runRestrictedCommand({
          command: command.command,
          argv,
          cwd: ctx.cwd,
          env,
          timeoutSeconds: command.timeoutSeconds,
          maxOutputBytes: command.maxOutputBytes,
        });
      },
    }),
  );
}
