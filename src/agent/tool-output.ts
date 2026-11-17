import { lstat, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkPath, enforceJail, type JailConfig } from "./jail.ts";

// Keep transport data out of the conversation while allowing a save to preserve it.
const sources = new WeakMap<object, unknown>();
export function withToolOutputSource<T extends object>(result: T, source: unknown): T {
  sources.set(result, source);
  return result;
}

const completenessWarning = "Saved the full returned result, not a verified complete upstream export. " +
  "Tool/server truncation, pagination, limits, and partial-result indicators still apply; inspect the saved result before claiming completeness.";

async function destination(jail: JailConfig, path: string): Promise<string> {
  if (!path.trim()) throw new Error("A non-empty workspace file path is required.");
  // Deliberately stricter than the normal jail: shared roots, memory, and even
  // explicitly allowed external workspace symlinks are not export destinations.
  const decision = checkPath({ cwd: jail.cwd, readRoots: [], writeRoots: [jail.cwd], pathAliases: jail.pathAliases }, path, "write");
  if (!decision.allowed || decision.resolved === await realpath(jail.cwd)) {
    throw new Error("Output path must be a file inside this channel's own workspace.");
  }
  if (await lstat(decision.resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) throw new Error("Output path already exists; choose a new file path (exports never overwrite).");
  return decision.resolved;
}

// Positive hints only; absence of a known marker never certifies completeness.
function reportsIncomplete(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) =>
    (["truncated", "partial", "incomplete", "hasMore", "has_more"].includes(key) && item === true) ||
    (["nextCursor", "next_cursor", "nextPageToken", "next_page_token"].includes(key) && typeof item === "string" && item.length > 0) ||
    (key === "text" && typeof item === "string" && /\[(?:Showing lines |[^\]\n]*more lines in file)/.test(item)) ||
    reportsIncomplete(item, seen));
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" ||
        (typeof item === "number" && !Number.isFinite(item))) {
      throw new Error("Tool returned data that cannot be represented losslessly as JSON.");
    }
    return item;
  }, 2) + "\n";
}

// A separate Node process gives publication a private, inode-anchored cwd.
// Never chdir the harness process, whose other sessions run concurrently.
function publishOutput(request: { workspace: string; dev: string; ino: string; path: string; data: string }): Promise<void> {
  const helper = new URL(import.meta.url.endsWith(".ts") ? "./tool-output-file.ts" : "./tool-output-file.js", import.meta.url);
  const script = `import { publishToolOutput } from ${JSON.stringify(helper.href)};
    import { readFileSync } from "node:fs";
    try { publishToolOutput(JSON.parse(readFileSync(0, "utf8"))); }
    catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); process.exitCode = 1; }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: {}, stdio: ["pipe", "pipe", "ignore"], shell: false,
    });
    let response = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { response += chunk; });
    child.on("error", reject);
    // A failed helper may close stdin before the large request is delivered.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        try { reject(new Error(JSON.parse(response).error)); }
        catch { reject(new Error("Tool output publication helper failed.")); }
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** One generic dispatcher, closing over exactly the thread/role's authorized tools. */
export function createSaveToolOutputTool(ctx: {
  tools: readonly ToolDefinition[];
  jail: JailConfig;
  onViolation?: (message: string) => void;
}): ToolDefinition {
  // Snapshot the list so adding this dispatcher cannot make it recursively callable.
  const tools = new Map(ctx.tools.map((tool) => [tool.name, tool]));
  return defineTool({
    name: "save_tool_output",
    label: "Save tool output",
    description: "Invoke any tool available to you and save its actual returned result directly to a new workspace JSON file, without copying it through the conversation. " +
      "Use the target tool's normal arguments and name (including connector prefixes). Authorization and filesystem checks still apply. " +
      "Preserves text, structured data, and base64 non-text content; does not fetch linked resources or bypass upstream truncation/pagination. " +
      "Returns the saved path and status, not the result body. Existing files are never overwritten. A failed save after invocation does not undo the tool's effects; do not blindly retry mutations.",
    promptGuidelines: ["To export a tool result to a workspace file, invoke it through save_tool_output instead of manually copying/reconstructing its response. The saved result may still be upstream-limited; never claim a complete export without checking pagination/truncation."],
    parameters: Type.Object({
      tool: Type.String({ description: "Name of a tool available in this conversation." }),
      arguments: Type.Record(Type.String(), Type.Unknown(), { description: "The target tool's normal input object." }),
      path: Type.String({ description: "New JSON file inside your own workspace. Parent directories are created. No overwrite." }),
    }),
    execute: async (id, params, signal, _onUpdate, context): Promise<AgentToolResult<unknown>> => {
      let executed = false;
      let succeeded: boolean | undefined;
      try {
        const tool = tools.get(params.tool);
        if (!tool) throw new Error(`Tool ${params.tool} is not available in this conversation.`);
        const prepared = tool.prepareArguments ? tool.prepareArguments(params.arguments) : params.arguments;
        const input = validateToolArguments(tool, { type: "toolCall", id, name: tool.name, arguments: prepared as ToolCall["arguments"] });
        const blocked = enforceJail(ctx.jail, tool.name, input, ctx.onViolation);
        if (blocked) throw new Error(blocked);
        const target = await destination(ctx.jail, params.path);
        const workspace = await realpath(ctx.jail.cwd);
        const root = await stat(workspace, { bigint: true });
        if (signal?.aborted) throw new Error("Tool output save aborted before invocation.");
        executed = true;
        const result = await tool.execute(id, input, signal, undefined, context);
        succeeded = !result.isError;
        const source = sources.has(result) ? sources.get(result) : result;
        const document = {
          version: 1,
          tool: tool.name,
          representation: sources.has(result) ? "mcp" : "pi",
          toolSucceeded: succeeded,
          completeness: { status: reportsIncomplete(source) ? "reported_incomplete" : "unverified", warning: completenessWarning },
          result: source,
        };
        const data = serialize(document);
        const path = relative(workspace, target);
        await publishOutput({ workspace, dev: String(root.dev), ino: String(root.ino), path, data });
        const details = { saved: true, path, bytes: Buffer.byteLength(data), toolExecuted: true, toolSucceeded: succeeded, completeness: document.completeness };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
          ...(result.isError ? { isError: true } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        };
      } catch (error) {
        const details = { saved: false, toolExecuted: executed, ...(succeeded !== undefined ? { toolSucceeded: succeeded } : {}), error: error instanceof Error ? error.message : String(error) };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(details) }], details };
      }
    },
  }) as ToolDefinition;
}
