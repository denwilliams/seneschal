import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SharedToolConfig } from "../config/schema.ts";
import type { SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { argsAllowed, describeAllowArgs } from "./argv-patterns.ts";
import { runRestrictedCommand } from "./restricted-exec.ts";
import { channelPathEnv } from "./sandbox.ts";
import {
  listSharedTools,
  publishSharedTool,
  readSharedToolEntry,
  readSharedToolSource,
  sharedToolPath,
  unpublishSharedTool,
} from "./shared-bin.ts";

/**
 * Tools for the shared CLI-tool bin: publishing on the account side, running
 * on the consuming side. See shared-bin.ts for the isolation model.
 */

export interface SharedToolToolsContext {
  channel: ResolvedChannel;
  /** Channel workspace: cwd and PATH base for anything this channel runs. */
  cwd: string;
}

export function sharedExecuteToolName(name: string): string {
  return `shared__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function describeExecutable(shared: SharedPaths, name: string, policy: SharedToolConfig): string {
  let published: string;
  try {
    const entry = readSharedToolEntry(shared, name);
    published = `${entry.description} Published by ${entry.publishedBy}, v${entry.version}.`;
  } catch {
    published = `Configured here, but no channel has published a shared tool called "${name}" yet — it will fail until one does.`;
  }
  return [
    published,
    "The harness executes the published script directly, not through a shell: no pipes, redirects, globbing or command substitution.",
    `Allowed supplied argv patterns: ${describeAllowArgs(policy.allowArgs)}.`,
    `Timeout: ${policy.timeoutSeconds}s. Output cap: ${policy.maxOutputBytes} bytes.`,
    policy.sha256
      ? "This channel is pinned to one published version; an unreviewed update from the publisher will refuse to run here."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function createSharedToolTools(ctx: SharedToolToolsContext): ToolDefinition[] {
  const { channel } = ctx;
  const shared = channel.shared;
  const tools: ToolDefinition[] = [];

  if (channel.sharedTools.canPublish) {
    const publish = defineTool({
      name: "publish_shared_tool",
      label: "Publish a shared CLI tool",
      description:
        "Publish an executable script to the account-wide shared bin, so an operator can let other channels run it by name. " +
        "The script must start with a shebang line (e.g. #!/usr/bin/env bash or #!/usr/bin/env node) — the harness runs it directly, never through a shell of its own. " +
        "Publishing does not expose the tool to anyone, not even this channel: it can only be run once an operator lists its name under some channel's `share.sharedTools` in config, with an explicit argv allowlist. " +
        "Never publish a script containing secrets or credentials: it is readable and, once configured, executable by other channels.",
      parameters: Type.Object({
        name: Type.String({ description: "Name for the tool: lowercase letters, numbers and hyphens, e.g. `deploy-notify`." }),
        description: Type.String({ description: "What it does and how to call it — shown to every channel allowed to run it." }),
        content: Type.String({ description: "Full script source, including its shebang line." }),
        note: Type.Optional(
          Type.String({ description: "One line for an operator deciding whether to enable this in another channel." }),
        ),
      }),
      execute: async (_id, params: { name: string; description: string; content: string; note?: string }) => {
        const entry = publishSharedTool(shared, channel, params);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Published \`${entry.name}\` to the shared bin as v${entry.version} (sha256 ${entry.sha256.slice(0, 12)}…). ` +
                "It runs nowhere yet — an operator must add it to a channel's `share.sharedTools` before anything can execute it.",
            },
          ],
          details: { name: entry.name, version: entry.version, sha256: entry.sha256 },
        };
      },
    });

    const unpublish = defineTool({
      name: "unpublish_shared_tool",
      label: "Withdraw a shared CLI tool",
      description:
        "Remove a shared tool this channel published from the shared bin. Channels configured to run it lose access immediately.",
      parameters: Type.Object({
        name: Type.String({ description: "Name of the published tool to withdraw." }),
      }),
      execute: async (_id, params: { name: string }) => {
        const removed = unpublishSharedTool(shared, channel, params.name);
        if (!removed) throw new Error(`The shared bin has no tool called \`${params.name}\`.`);
        return {
          content: [{ type: "text" as const, text: `Withdrew \`${params.name}\` from the shared bin.` }],
          details: { name: params.name },
        };
      },
    });

    const list = defineTool({
      name: "list_shared_tools",
      label: "List shared CLI tools",
      description:
        "List every tool in the account-wide shared bin, published by any channel, with who published it and when. " +
        "Use this before publishing, to avoid colliding with an existing name.",
      parameters: Type.Object({}),
      execute: async () => {
        const entries = listSharedTools(shared);
        if (entries.length === 0) {
          return {
            content: [{ type: "text" as const, text: "The shared bin is empty — no channel has published a tool yet." }],
            details: { count: 0 },
          };
        }
        const lines = entries.map(
          (e) =>
            `- \`${e.name}\` (from ${e.publishedBy}, v${e.version}, sha256 ${e.sha256.slice(0, 12)}…) — ${e.description}` +
            (e.note ? `\n    ${e.note}` : ""),
        );
        return {
          content: [{ type: "text" as const, text: `${entries.length} shared tool(s):\n\n${lines.join("\n")}` }],
          details: { count: entries.length },
        };
      },
    });

    const read = defineTool({
      name: "read_shared_tool",
      label: "Read a shared CLI tool's source",
      description: "Read the full published source of a shared bin tool, without needing to run it.",
      parameters: Type.Object({
        name: Type.String({ description: "Name of the tool, as shown by list_shared_tools." }),
      }),
      execute: async (_id, params: { name: string }) => {
        const { entry, source } = readSharedToolSource(shared, params.name);
        return {
          content: [
            {
              type: "text" as const,
              text: `# ${entry.name}\n_Published by ${entry.publishedBy}, v${entry.version}, ${entry.updatedAt.slice(0, 10)}._\n\n${entry.description}\n\n---\n\n${source}`,
            },
          ],
          details: { name: entry.name, version: entry.version, sha256: entry.sha256 },
        };
      },
    });

    tools.push(publish, unpublish, list, read);
  }

  for (const [name, policy] of Object.entries(channel.sharedTools.execute)) {
    tools.push(
      defineTool({
        name: sharedExecuteToolName(name),
        label: `Run shared tool ${name}`,
        description: describeExecutable(shared, name, policy),
        parameters: Type.Object({
          args: Type.Optional(
            Type.Array(Type.String(), {
              description: "Arguments to pass. Each item is one argv token, not a shell string.",
            }),
          ),
        }),
        execute: async (_id, params: { args?: string[] }) => {
          const supplied = params.args ?? [];
          if (!Array.isArray(supplied) || !supplied.every((a) => typeof a === "string")) {
            throw new Error("args must be an array of strings.");
          }
          if (!argsAllowed(policy.allowArgs, supplied)) {
            throw new Error(
              `Arguments refused for shared tool "${name}": ${JSON.stringify(supplied)}. ` +
                `Allowed patterns: ${describeAllowArgs(policy.allowArgs)}.`,
            );
          }

          const entry = readSharedToolEntry(shared, name);
          if (policy.sha256 && entry.sha256 !== policy.sha256) {
            throw new Error(
              `Shared tool "${name}" has changed since this channel's config pinned it to sha256 ` +
                `${policy.sha256.slice(0, 12)}… (currently ${entry.sha256.slice(0, 12)}…). Refusing to run an ` +
                "unreviewed update — an operator needs to update the pinned sha256 after reviewing the change.",
            );
          }

          const command = sharedToolPath(shared, name);
          const env = { ...channelPathEnv(channel), ...policy.env };
          return runRestrictedCommand({
            command,
            argv: supplied,
            cwd: ctx.cwd,
            env,
            timeoutSeconds: policy.timeoutSeconds,
            maxOutputBytes: policy.maxOutputBytes,
          });
        },
      }),
    );
  }

  return tools;
}
