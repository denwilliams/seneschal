import type { ResolvedChannel } from "../workspace/resolve.ts";
import { isContainerMode } from "./sandbox.ts";

/** Shared by channel agents and subagents; file tools always use host paths. */
export function workspaceFileInstructions(channel: ResolvedChannel): string {
  return [
    "- Put temporary/scratch files in this workspace's `tmp/` directory, not the workspace root or other durable locations.",
    `- With file tools, use \`${channel.paths.tmp}/\` (or \`tmp/...\` relative to the workspace).`,
    ...(channel.tools.includes("bash") && isContainerMode(channel.sandbox.mode)
      ? ["- With container `bash`, use `/workspace/tmp/` for temporary files; it is the same directory mounted from the host workspace."]
      : []),
    "- Files in `tmp/` are disposable. Keep retained outputs, attachments, published `artifacts/`, and reusable `bin/` tools outside `tmp/`.",
    "- No automatic cleanup is performed. Do not move or delete existing workspace files unless asked.",
  ].join("\n");
}
