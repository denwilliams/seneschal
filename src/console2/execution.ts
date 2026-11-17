import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { containerNameFor } from "../agent/sandbox.ts";
import { appleRuntime, dockerRuntime, kiriRuntime, INSTANCE_LABEL, type ContainerBackend } from "../agent/sandbox-runtime.ts";
import { BACKEND_LABEL, MANAGED_LABEL, OWNER_LABEL, SANDBOX_VERSION } from "../agent/sandbox-lifecycle.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { ExecutionEnvironment, SandboxMode, ToolView } from "./api-types.ts";

const exec = promisify(execFile);
export type InspectContainer = (backend: ContainerBackend, name: string) => Promise<string>;
/** Bounded, read-only inspection; never initialize a lifecycle, create a container or execute guest code. */
const inspectContainer: InspectContainer = async (backend, name) => (await exec(backend === "macos-container" ? "container" : backend, ["inspect", name], {
  timeout: 2_000, maxBuffer: 128 * 1024, encoding: "utf8",
})).stdout;

export function sandboxMode(value: unknown): SandboxMode {
  return value === "host" || value === "docker" || value === "macos-container" || value === "kiri" ? value : "unknown";
}

export function executionEnvironment(configured: ResolvedChannel | undefined, runtime: ResolvedChannel | undefined): ExecutionEnvironment {
  const effective = runtime ?? configured;
  return {
    configuredMode: sandboxMode(configured?.sandbox.mode), toolMode: sandboxMode(effective?.sandbox.mode),
    source: runtime ? "runtime" : "configuration",
    ...((effective?.sandbox.mode === "docker" || effective?.sandbox.mode === "macos-container" || effective?.sandbox.mode === "kiri") && typeof effective.sandbox.reuse === "boolean" ? { reuse: effective.sandbox.reuse } : {}),
  };
}

export function toolExecution(tool: ToolView, mode: SandboxMode): NonNullable<ToolView["execution"]> {
  if (tool.name === "bash") return {
    location: mode === "host" ? "outside" : mode,
    detail: mode === "host" ? "Shell on the harness host (or service container), outside channel sandboxes." : mode === "unknown"
      ? "Bash execution location is unavailable." : "Only bash and commands it launches use the channel sandbox.",
  };
  if (tool.group === "connector") return { location: "outside", detail: "Connector dispatch is outside the channel sandbox. Stdio servers are harness-side; HTTP servers are remote (server isolation unknown)." };
  return { location: "outside", detail: "Runs in the harness process or launches harness-side work, not in the channel sandbox. Delegated bash can still use a sandbox." };
}

const unknown = (detail: string): NonNullable<ExecutionEnvironment["status"]> => ({ state: "unknown", detail });
const cache = new Map<string, { at: number; value: Promise<NonNullable<ExecutionEnvironment["status"]>> }>();

/** A per-thread observation, not channel activity, process liveness, or a guarantee of isolation. */
export async function sandboxStatus(dataDir: string, channelId: string, threadKey: string | undefined, execution: ExecutionEnvironment,
  inspect: InspectContainer = inspectContainer, now = Date.now()): Promise<NonNullable<ExecutionEnvironment["status"]>> {
  const mode = execution.toolMode;
  if (mode === "host") return { state: "not-applicable", detail: "No channel sandbox is used by this bash routing. Previously created containers are not inspected." };
  if (mode === "unknown") return unknown("Sandbox configuration is unavailable.");
  // Main is a channel summary; subagent and scheduled routes can override their sandbox key.
  // Their actual key is not exposed by the console store, so never inspect a guessed name.
  if (!threadKey || threadKey === "main") return unknown("Select a Slack thread to inspect its container; channel activity is not container status.");
  if (!/^\d+\.\d+$/.test(threadKey)) return unknown("This route's sandbox identity is unavailable; subagents may share a parent thread's container.");
  if (execution.reuse === undefined) return unknown("Container lifetime is unavailable; no running state is inferred.");
  if (!execution.reuse) return unknown("Per-command containers have no stable inspectable identity; no running state is inferred.");
  const name = containerNameFor(channelId, threadKey, mode);
  const key = JSON.stringify([dataDir, mode, name]);
  const hit = cache.get(key);
  if (inspect === inspectContainer && hit && now - hit.at < 5_000) return hit.value;
  const value = (async (): Promise<NonNullable<ExecutionEnvironment["status"]>> => {
    try {
      // Reuse the backend's strict schema and not-found handling, without its mutating lifecycle.
      let raw: string | undefined, error: unknown;
      try { raw = await inspect(mode, name); } catch (err) { error = err; }
      const call = () => { if (error) throw error; return raw!; };
      const info = (mode === "docker" ? dockerRuntime(call) : mode === "kiri" ? kiriRuntime(call) : appleRuntime(call)).inspect(name);
      const checkedAt = new Date(now).toISOString();
      if (!info) return { state: "absent", detail: "No container found for this thread on the selected backend.", checkedAt };
      const ownerPath = mode === "docker" ? join(dataDir, "sandboxes", "installation-id") : join(dataDir, "sandboxes", mode, "installation-id");
      const owner = (await readFile(ownerPath, "utf8")).trim();
      const labels = info.Config.Labels;
      if (!/^[0-9a-f-]{36}$/.test(owner) || labels?.[OWNER_LABEL] !== owner || labels?.[MANAGED_LABEL] !== SANDBOX_VERSION ||
          (labels?.[BACKEND_LABEL] ?? "docker") !== mode ||
          (mode === "macos-container" && !/^[0-9a-f-]{36}$/.test(labels?.[INSTANCE_LABEL] ?? ""))) return unknown("Container ownership could not be verified for this installation.");
      return { state: info.State.Running ? "running" : "stopped", detail: "Backend inspection of this thread's container. Running does not mean a command is active or the current configuration is applied.", checkedAt };
    } catch { return unknown("Container inspection unavailable or unrecognized (backend, permissions, timeout, or ownership evidence)."); }
  })();
  if (inspect === inspectContainer) {
    // Bound memory even when many threads are browsed.
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now, value });
  }
  return value;
}
