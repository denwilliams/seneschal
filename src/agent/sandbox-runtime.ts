import { execFileSync } from "node:child_process";

export const INSTANCE_LABEL = "harness.sandbox-instance";
export type ContainerBackend = "docker" | "macos-container" | "kiri";
export type DockerCall = (args: string[], env?: NodeJS.ProcessEnv) => string;
export const dockerCall: DockerCall = (args, env) => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  ...(env ? { env } : {}),
});
export const appleCall: DockerCall = (args, env) => execFileSync("container", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  ...(env ? { env } : {}),
});

/** Native Kiri commands forward Docker CLI operations to Kiri's own socket. */
export const kiriCall: DockerCall = (args, env) => execFileSync("kiri", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  ...(env ? { env } : {}),
});

export interface ContainerInfo {
  Id: string;
  /** Apple uses the name as its ID. Bind readiness to creation date + nonce. */
  identity?: string;
  Config: { Labels: Record<string, string> | null };
  State: { Running: boolean };
  /** Undefined means the backend cannot enumerate pending executions, never idle evidence. */
  ExecIDs?: string[] | null;
}

export interface LifecycleRuntime {
  kind: ContainerBackend;
  /** Apple and Kiri have no pending-exec enumeration; crash-interrupted activity stays protected. */
  conservativeRecovery?: boolean;
  inspect(name: string): ContainerInfo | undefined;
  quiescent(info: ContainerInfo): boolean;
  start(info: ContainerInfo): void;
  stop(info: ContainerInfo): void;
  remove(info: ContainerInfo): void;
}

export function dockerRuntime(call: DockerCall = dockerCall): LifecycleRuntime {
  return {
    kind: "docker",
    inspect(name) {
      try {
        const info = (JSON.parse(call(["inspect", name])) as ContainerInfo[])[0];
        if (!info || typeof info.Id !== "string" || typeof info.State?.Running !== "boolean" || !info.Config ||
            (info.ExecIDs !== null && !Array.isArray(info.ExecIDs))) throw new Error("Invalid Docker container inspection");
        return info;
      } catch (err) {
        if (/No such (object|container)/i.test(String(err))) return undefined;
        throw err;
      }
    },
    quiescent(info) {
      if (info.ExecIDs?.length) return false;
      if (!info.State.Running) return true;
      const rows = call(["top", info.Id, "-eo", "pid"]).trim().split("\n");
      return rows.length === 2 && /^\s*\d+\s*$/.test(rows[1] ?? "");
    },
    start: (info) => { call(["start", info.Id]); },
    stop: (info) => { call(["stop", "--time", "0", info.Id]); },
    remove: (info) => { call(["rm", info.Id]); },
  };
}

/** Kiri v0.2.1 daemon/api.rs omits ExecIDs; ops.rs returns a fixed ps -ef
 * table (ignoring ps_args). See docs/kiri-sandbox.md for pinned provenance.
 * Pending execs are protected by the lifecycle's durable conservative recovery.
 */
export function kiriRuntime(call: DockerCall = kiriCall): LifecycleRuntime {
  return {
    kind: "kiri",
    conservativeRecovery: true,
    inspect(name) {
      let raw: string;
      try { raw = call(["inspect", name]); }
      catch (err) {
        if (/No such (object|container)/i.test(String(err))) return undefined;
        throw err;
      }
      const list = JSON.parse(raw);
      const info = Array.isArray(list) && list.length === 1 ? list[0] : undefined;
      const labels = info?.Config?.Labels;
      if (!info || typeof info.Id !== "string" || !/^[0-9a-f]{64}$/.test(info.Id) || typeof info.State?.Running !== "boolean" ||
          !info.Config || typeof info.Config !== "object" || Array.isArray(info.Config) ||
          !(labels === null || (labels && typeof labels === "object" && !Array.isArray(labels) && Object.values(labels).every((v) => typeof v === "string"))) ||
          !(info.ExecIDs === undefined || info.ExecIDs === null || (Array.isArray(info.ExecIDs) && info.ExecIDs.every((id: unknown) => typeof id === "string")))) {
        throw new Error("Invalid Kiri container inspection (requires Kiri 0.2.1 or compatible)");
      }
      return info as ContainerInfo;
    },
    quiescent(info) {
      if (info.ExecIDs?.length) return false;
      if (!info.State.Running) return true;
      const rows = call(["top", info.Id]).trim().split("\n");
      // Do not apply Docker's `-eo pid` parser: Kiri ignores that option.
      return rows.length === 2 && rows[0]!.trim().split(/\s+/).join(" ") === "UID PID PPID C STIME TTY TIME CMD" &&
        /^\S+\s+[1-9]\d*\s+\d+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S/.test(rows[1]!);
    },
    start: (info) => { call(["start", info.Id]); },
    stop: (info) => { call(["stop", "--time", "0", info.Id]); },
    remove: (info) => { call(["rm", info.Id]); },
  };
}

/** Apple container 1.6.1 JSON schemas, not Docker's inspect/top/rm protocol.
 * Unknown states, missing statistics and service errors must not mean absent/idle.
 */
export function appleRuntime(call: DockerCall = appleCall): LifecycleRuntime {
  return {
    kind: "macos-container",
    conservativeRecovery: true,
    inspect(name) {
      let raw: string;
      try { raw = call(["inspect", name]); }
      catch (err) {
        if (/container not found:/i.test(String(err))) return undefined;
        throw err;
      }
      const info = (JSON.parse(raw) as {
        id: string;
        configuration: { id: string; creationDate: string | number; labels: Record<string, string> };
        status: { state: string };
      }[])[0];
      const date = info?.configuration?.creationDate;
      if (info?.id !== name || info.configuration?.id !== name ||
          !((typeof date === "string" && date.length > 0) || (typeof date === "number" && Number.isFinite(date))) ||
          !info.configuration.labels || typeof info.configuration.labels !== "object" ||
          !["running", "stopped"].includes(info.status?.state)) {
        throw new Error("Invalid Apple container inspection (requires container 1.6.1 or compatible)");
      }
      return { Id: name, identity: JSON.stringify([name, date, info.configuration.labels[INSTANCE_LABEL]]), Config: { Labels: info.configuration.labels },
        State: { Running: info.status.state === "running" }, ExecIDs: null };
    },
    quiescent(info) {
      if (!info.State.Running) return true;
      // Daemon-sourced cgroup process count, not a guest-controlled `ps` script.
      // Only the idle sleep process is safe; absent/unknown counts fail closed.
      const stats = JSON.parse(call(["stats", "--no-stream", "--format", "json", info.Id])) as {
        id: string; numProcesses?: number;
      }[];
      return stats.length === 1 && stats[0]?.id === info.Id && stats[0].numProcesses === 1;
    },
    start: (info) => { call(["start", info.Id]); },
    stop: (info) => { if (info.State.Running) call(["stop", "--time", "0", info.Id]); },
    remove: (info) => { call(["delete", info.Id]); },
  };
}
