import { constants as fsConstants, realpathSync } from "node:fs";
import { access, cp, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkPath, type JailConfig } from "./jail.ts";

export interface WorkspaceFileToolsContext {
  /** This channel's filesystem jail, applied to every path this tool touches. */
  jail: JailConfig;
}

type WorkspaceFileOperation = "mkdir" | "move" | "copy" | "rename" | "delete";

type WorkspaceFileParams = {
  operation: WorkspaceFileOperation;
  path: string;
  to_path?: string;
  overwrite?: boolean;
  recursive?: boolean;
  create_parents?: boolean;
};

type WorkspaceFileDetails = {
  operation: WorkspaceFileOperation;
  path: string;
  to_path?: string;
  kind?: "file" | "directory" | "other";
};

function realRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(candidate: string, root: string): boolean {
  const absoluteCandidate = resolve(candidate);
  const absoluteRoot = resolve(root);
  if (absoluteCandidate === absoluteRoot) return true;
  return absoluteCandidate.startsWith(absoluteRoot.endsWith(sep) ? absoluteRoot : absoluteRoot + sep);
}

function requestStartsInWorkspace(jail: JailConfig, rawPath: string): boolean {
  const requested = isAbsolute(rawPath) ? resolve(rawPath) : resolve(jail.cwd, rawPath);
  return isWithin(requested, resolve(jail.cwd)) || isWithin(requested, realRoot(jail.cwd));
}

function isAllowedWorkspaceSymlinkTarget(jail: JailConfig, rawPath: string, resolvedPath: string): boolean {
  if (!jail.workspaceSymlinkRoots?.length) return false;
  if (!requestStartsInWorkspace(jail, rawPath)) return false;
  return jail.workspaceSymlinkRoots.some((root) => isWithin(resolvedPath, realRoot(root)));
}

function checkedWorkspacePath(
  jail: JailConfig,
  rawPath: string | undefined,
  mode: "read" | "write",
  label: string,
): string {
  const raw = rawPath?.trim();
  if (!raw) throw new Error(`workspace_file_ops needs ${label}.`);

  const decision = checkPath(jail, raw, mode);
  if (!decision.allowed) {
    throw new Error(decision.reason ?? `${raw} is outside this channel's workspace.`);
  }

  const workspace = realRoot(jail.cwd);
  if (!isWithin(decision.resolved, workspace) && !isAllowedWorkspaceSymlinkTarget(jail, raw, decision.resolved)) {
    throw new Error(
      `${raw} is not inside this channel's workspace. workspace_file_ops only manages workspace files, not memory, skills, or shared libraries.`,
    );
  }

  return decision.resolved;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDestination(path: string, opts: { overwrite: boolean; createParents: boolean }) {
  if (opts.createParents) await mkdir(dirname(path), { recursive: true });
  if ((await exists(path)) && !opts.overwrite) {
    throw new Error(`${path} already exists. Pass overwrite: true if replacing it is intentional.`);
  }
}

function relativeToWorkspace(jail: JailConfig, path: string): string {
  const workspace = realRoot(jail.cwd);
  return path === workspace ? "." : path.startsWith(workspace + sep) ? path.slice(workspace.length + 1) : path;
}

function assertNotWorkspaceRoot(jail: JailConfig, path: string, operation: string) {
  if (resolve(path) === realRoot(jail.cwd)) {
    throw new Error(`Refusing to ${operation} the workspace root.`);
  }
}

function targetDescription(path: string, kind: "file" | "directory" | "other"): string {
  return kind === "directory" ? `directory ${path}` : kind === "file" ? `file ${path}` : path;
}

function result(text: string, details: WorkspaceFileDetails): AgentToolResult<WorkspaceFileDetails> {
  return { content: [{ type: "text", text }], details };
}

export function createWorkspaceFileTools(ctx: WorkspaceFileToolsContext): ToolDefinition[] {
  const manage = defineTool({
    name: "workspace_file_ops",
    label: "Manage workspace files",
    description:
      "Create directories, move/rename, copy, and delete files inside this channel's workspace without needing bash. " +
      "Use one `operation` per call: `mkdir`, `move`, `rename`, `copy`, or `delete`. " +
      "All paths are jailed to the channel workspace; the tool cannot manage memory, skills, shared libraries, or another channel's files. " +
      "For `move`, `rename`, and `copy`, pass `to_path`. Destination parent directories are created by default. " +
      "Existing destinations are refused unless `overwrite` is true. Directories are copied or deleted only when `recursive` is true.",
    parameters: Type.Object({
      operation: Type.Union(
        [
          Type.Literal("mkdir"),
          Type.Literal("move"),
          Type.Literal("copy"),
          Type.Literal("rename"),
          Type.Literal("delete"),
        ],
        { description: "What to do: mkdir, move, rename, copy, or delete." },
      ),
      path: Type.String({
        description: "Workspace path to create, move, copy, rename, or delete. Relative paths resolve from the channel workspace.",
      }),
      to_path: Type.Optional(
        Type.String({
          description: "Destination workspace path for move, rename, or copy.",
        }),
      ),
      overwrite: Type.Optional(
        Type.Boolean({ description: "Replace an existing destination. Defaults to false." }),
      ),
      recursive: Type.Optional(
        Type.Boolean({ description: "Allow recursive directory copy or delete. Defaults to false." }),
      ),
      create_parents: Type.Optional(
        Type.Boolean({ description: "Create destination parent directories for mkdir, move, rename, and copy. Defaults to true." }),
      ),
    }),
    execute: async (_id, params: WorkspaceFileParams): Promise<AgentToolResult<WorkspaceFileDetails>> => {
      const operation = params.operation;
      const overwrite = params.overwrite === true;
      const recursive = params.recursive === true;
      const createParents = params.create_parents !== false;

      if (operation === "mkdir") {
        const target = checkedWorkspacePath(ctx.jail, params.path, "write", "path");
        await mkdir(target, { recursive: createParents });
        return result(`Created directory ${relativeToWorkspace(ctx.jail, target)}.`, { operation, path: target });
      }

      if (operation === "delete") {
        const target = checkedWorkspacePath(ctx.jail, params.path, "write", "path");
        assertNotWorkspaceRoot(ctx.jail, target, "delete");
        const info = await lstat(target).catch(() => undefined);
        if (!info) throw new Error(`There is no file or directory at ${params.path}.`);
        if (info.isDirectory() && !recursive) {
          throw new Error(`${params.path} is a directory. Pass recursive: true if deleting it is intentional.`);
        }
        await rm(target, { recursive, force: false });
        const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
        return result(`Deleted ${targetDescription(relativeToWorkspace(ctx.jail, target), kind)}.`, {
          operation,
          path: target,
          kind,
        });
      }

      if (operation === "move" || operation === "rename" || operation === "copy") {
        const source = checkedWorkspacePath(ctx.jail, params.path, operation === "copy" ? "read" : "write", "path");
        const destination = checkedWorkspacePath(ctx.jail, params.to_path, "write", "to_path");
        assertNotWorkspaceRoot(ctx.jail, source, operation);
        if (resolve(source) === resolve(destination)) throw new Error("Source and destination are the same path.");

        const sourceInfo = await stat(source).catch(() => undefined);
        if (!sourceInfo) throw new Error(`There is no file or directory at ${params.path}.`);
        if (sourceInfo.isDirectory() && operation === "copy" && !recursive) {
          throw new Error(`${params.path} is a directory. Pass recursive: true to copy a directory.`);
        }
        if (sourceInfo.isDirectory() && isWithin(resolve(destination), resolve(source))) {
          throw new Error("Refusing to place a directory inside itself.");
        }

        await ensureDestination(destination, { overwrite, createParents });
        if (overwrite && (await exists(destination))) {
          await rm(destination, { recursive: true, force: false });
        }

        if (operation === "copy") {
          await cp(source, destination, { recursive, force: false, errorOnExist: true });
        } else {
          await rename(source, destination);
        }

        const verb = operation === "copy" ? "Copied" : operation === "rename" ? "Renamed" : "Moved";
        return result(`${verb} ${relativeToWorkspace(ctx.jail, source)} to ${relativeToWorkspace(ctx.jail, destination)}.`, {
          operation,
          path: source,
          to_path: destination,
        });
      }

      throw new Error(`Unknown workspace_file_ops operation: ${operation}.`);
    },
  });

  return [manage] as ToolDefinition[];
}
