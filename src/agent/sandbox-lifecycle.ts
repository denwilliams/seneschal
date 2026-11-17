import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, linkSync, readFileSync, readdirSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { logger } from "../util/log.ts";
import { dockerCall, dockerRuntime, INSTANCE_LABEL, type ContainerInfo, type DockerCall, type LifecycleRuntime } from "./sandbox-runtime.ts";
export { dockerCall, type DockerCall } from "./sandbox-runtime.ts";

export const BACKEND_LABEL = "harness.sandbox-backend";
export const OWNER_LABEL = "harness.installation";
export const CONFIG_LABEL = "harness.sandbox-config";
export const MANAGED_LABEL = "harness.sandbox-version";
export const SANDBOX_VERSION = "2";

// PIDs alone are not restart identities: a Compose service commonly runs as
// PID 1 again after recreation. Include process start time and PID namespace.
function processIdentity(pid: number): string | undefined {
  try {
    if (existsSync(`/proc/${pid}/stat`)) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return `${readlinkSync(`/proc/${pid}/ns/pid`)}:${start}`;
    }
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
    return started || undefined;
  } catch { return undefined; }
}
const currentIdentity = processIdentity(process.pid);

interface Activity {
  backend?: string;
  name: string;
  owner: string;
  fingerprint: string;
  lastUsed: number;
  idleSeconds: number;
  active: boolean;
  /** A lost Apple/Kiri exec client can leave an unenumerable pending process. */
  uncertain?: boolean;
  /** Written before dispatch; only a confirmed completion clears this phase. */
  inFlight?: boolean;
  /** Written only after preparation, bound to the exact container, not its name. */
  readyContainerId?: string;
}

export function sandboxFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Cross-process leases are on the host, never mounted into an agent container.
 * One installation's data directory must live on a single host/PID namespace
 * (not shared NFS or concurrent Compose replicas).
 * A dead process's lease is recoverable; live PIDs are conservatively protected.
 */
export class SandboxLifecycle {
  readonly root: string;
  readonly owner: string;
  private timer?: NodeJS.Timeout;
  private sweepRunning = false;

  private readonly runtime: LifecycleRuntime;
  private readonly now: () => number;

  constructor(dataDir: string, docker: DockerCall = dockerCall, now = Date.now, runtime = dockerRuntime(docker)) {
    if (!currentIdentity) throw new Error("Cannot determine sandbox lease process identity");
    this.runtime = runtime;
    this.now = now;
    this.root = runtime.kind === "docker" ? join(resolve(dataDir), "sandboxes")
      : join(resolve(dataDir), "sandboxes", runtime.kind);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const ownerPath = join(this.root, "installation-id");
    const ownerIntent = `${ownerPath}.${randomUUID()}.tmp`;
    writeFileSync(ownerIntent, randomUUID(), { mode: 0o600 });
    try { linkSync(ownerIntent, ownerPath); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    finally { unlinkSync(ownerIntent); }
    this.owner = readFileSync(ownerPath, "utf8").trim();
    if (!/^[0-9a-f-]{36}$/.test(this.owner)) throw new Error("Invalid sandbox installation-id");
  }

  labels(fingerprint: string): Record<string, string> {
    return { [OWNER_LABEL]: this.owner, [CONFIG_LABEL]: fingerprint, [MANAGED_LABEL]: SANDBOX_VERSION,
      [BACKEND_LABEL]: this.runtime.kind,
      ...(this.runtime.kind === "macos-container" ? { [INSTANCE_LABEL]: randomUUID() } : {}) };
  }

  private path(name: string, suffix: string): string {
    if (!/^harness-[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid sandbox name");
    return join(this.root, `${name}.${suffix}`);
  }

  private read(name: string): Activity | undefined {
    const path = this.path(name, "json");
    if (!existsSync(path)) return undefined;
    const record = JSON.parse(readFileSync(path, "utf8")) as Activity;
    if ((record.backend ?? "docker") !== this.runtime.kind || record.name !== name || record.owner !== this.owner || !Number.isFinite(record.lastUsed) ||
        !Number.isFinite(record.idleSeconds) || record.idleSeconds <= 0 ||
        (record.readyContainerId !== undefined && (typeof record.readyContainerId !== "string" || !record.readyContainerId))) throw new Error("Invalid sandbox activity record");
    return record;
  }

  private write(record: Activity): void {
    const path = this.path(record.name, "json");
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, path);
  }

  private tryLock(name: string): (() => void) | undefined {
    return this.tryLockPath(this.path(name, "lock"));
  }

  private tryLockPath(path: string, depth = 0): (() => void) | undefined {
    if (depth > 8) return undefined; // pathological/corrupt recovery chain: fail closed
    const intent = `${path}.${randomUUID()}.tmp`;
    writeFileSync(intent, JSON.stringify({ pid: process.pid, identity: currentIdentity }), { mode: 0o600 });
    try { linkSync(intent, path); }
    catch (err) {
      unlinkSync(intent);
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const raw = readFileSync(path, "utf8");
        const lease = JSON.parse(raw) as { pid: number; identity: string };
        if (!Number.isInteger(lease.pid) || lease.pid <= 0 || !lease.identity) return undefined;
        try {
          process.kill(lease.pid, 0);
          const identity = processIdentity(lease.pid);
          if (!identity || identity === lease.identity) return undefined;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined; }
        // Serialize stale-lease reapers; recovery locks themselves use the
        // same restart-safe protocol, including recovery from a reaper crash.
        const releaseRecovery = this.tryLockPath(`${path}.recovery`, depth + 1);
        if (!releaseRecovery) return undefined;
        try { if (existsSync(path) && readFileSync(path, "utf8") === raw) unlinkSync(path); }
        finally { releaseRecovery(); }
      } catch { return undefined; }
      return undefined;
    }
    unlinkSync(intent);
    return () => unlinkSync(path);
  }

  async withLease<T>(name: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (;;) {
      if (signal?.aborted) throw new Error("Sandbox command cancelled before start");
      const release = this.tryLock(name);
      if (release) { try { return await work(); } finally { release(); } }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  inspect(name: string): ContainerInfo | undefined {
    return this.runtime.inspect(name);
  }

  private owned(info: ContainerInfo): boolean {
    return (this.runtime.kind !== "macos-container" || /^[0-9a-f-]{36}$/.test(info.Config.Labels?.[INSTANCE_LABEL] ?? "")) &&
      (info.Config.Labels?.[BACKEND_LABEL] ?? "docker") === this.runtime.kind &&
      info.Config.Labels?.[OWNER_LABEL] === this.owner &&
      info.Config.Labels?.[MANAGED_LABEL] === SANDBOX_VERSION;
  }

  /** ExecIDs catch commands even before their process starts. top also catches
   * orphaned children/background services after the CLI or harness has exited.
   * Only our one idle PID 1 is safe; unknown processes fail closed.
   */
  quiescent(name: string, info = this.inspect(name)): boolean {
    if (!info) return true;
    return this.runtime.quiescent(info);
  }

  /** Must run under withLease. A collision is never adopted or removed. */
  ensure(name: string, fingerprint: string, idleSeconds: number, create: (labels: Record<string, string>) => void): void {
    const prior = this.read(name);
    let info = this.inspect(name);
    if (info && !this.owned(info)) throw new Error(`Sandbox name ${name} belongs to another installation or legacy container; remove/rename it manually`);
    const unfinished = info && (prior?.readyContainerId !== (info.identity ?? info.Id) || prior.fingerprint !== fingerprint);
    if (info && (info.Config.Labels?.[CONFIG_LABEL] !== fingerprint || unfinished)) {
      if ((this.runtime.conservativeRecovery && (prior?.inFlight || prior?.uncertain) && info.State.Running) || !this.quiescent(name, info)) throw new Error(`Sandbox ${name} has active processes and changed image/config or incomplete initialization; stop them before replacement`);
      if (info.State.Running) this.runtime.stop(info);
      this.runtime.remove(info);
      info = undefined;
    }
    // Absence of readyContainerId is a durable preparation phase. A crash
    // anywhere in create() must recreate a quiescent incomplete container;
    // never rerun privileged preparation on a possibly already-used one.
    const record: Activity = { backend: this.runtime.kind, name, owner: this.owner, fingerprint, idleSeconds,
      lastUsed: this.now(), active: true, inFlight: true,
      uncertain: !!(this.runtime.conservativeRecovery && info?.State.Running && (prior?.inFlight || prior?.uncertain)),
      ...(info ? { readyContainerId: info.identity ?? info.Id } : {}) };
    this.write(record);
    if (!info) {
      try {
        create(this.labels(fingerprint));
        const created = this.inspect(name);
        if (!created || !this.owned(created) || created.Config.Labels?.[CONFIG_LABEL] !== fingerprint) {
          throw new Error("Sandbox initialization did not produce a matching owned container");
        }
        // This commit precedes every agent dispatch. Labels alone never prove
        // readiness, including after a daemon/harness crash during setup.
        this.write({ ...record, readyContainerId: created.identity ?? created.Id });
      }
      catch (error) {
        // Setup failed before any agent command. Remove only our quiescent
        // partial creation, so a later call never adopts an unprepared /repos.
        const partial = this.inspect(name);
        if (partial && this.owned(partial) && this.quiescent(name, partial)) this.discard(name);
        throw error;
      }
    }
    else if (!info.State.Running) this.runtime.start(info);
  }

  /** Completion only marks idle when the runtime proves no children remain.
   * Apple/Kiri cannot enumerate pending execs: retain crash/lost-client uncertainty
   * across later commands until a whole-container stop is confirmed.
   */
  finish(name: string, executionUncertain = false): void {
    const record = this.read(name);
    if (!record) return;
    const info = this.inspect(name);
    const uncertain = !!(this.runtime.conservativeRecovery && info?.State.Running && (record.uncertain || executionUncertain));
    this.write({ ...record, uncertain, inFlight: false, lastUsed: this.now(), active: uncertain || !this.quiescent(name, info) });
  }

  /** Cancel the whole thread's process tree, not just the docker CLI. The
   * container (including its writable layer) remains available for restart.
   */
  cancel(name: string): void {
    const info = this.inspect(name);
    if (!info) return;
    if (!this.owned(info)) throw new Error("Refusing to stop an unowned sandbox");
    this.runtime.stop(info);
    if (this.inspect(name)?.State.Running) throw new Error("Sandbox is still running after cancellation");
  }

  /** One-shot completion deliberately tears down all its descendants. */
  discard(name: string): void {
    this.cancel(name);
    const info = this.inspect(name);
    if (info) {
      if (!this.owned(info)) throw new Error("Refusing to remove an unowned sandbox");
      this.runtime.remove(info);
    }
    const path = this.path(name, "json");
    if (existsSync(path)) unlinkSync(path);
  }

  async sweep(): Promise<void> {
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    try {
      for (const file of readdirSync(this.root)) {
        if (!/^harness-[a-zA-Z0-9_.-]+\.json$/.test(file)) continue;
        const name = file.slice(0, -5);
        const release = this.tryLock(name);
        if (!release) continue;
        try {
          const record = this.read(name);
          if (!record) continue;
          const info = this.inspect(name);
          if (info && (!this.owned(info) || info.Config.Labels?.[CONFIG_LABEL] !== record.fingerprint)) continue;
          if (this.runtime.conservativeRecovery && (record.inFlight || record.uncertain) && info?.State.Running) continue;
          if (!this.quiescent(name, info)) continue;
          if (record.active) {
            // A restart recovered an interrupted command. Start its idle clock
            // now, not before the command finished while we were offline.
            this.write({ ...record, active: false, lastUsed: this.now() });
            continue;
          }
          if (this.now() - record.lastUsed < record.idleSeconds * 1000) continue;
          if (info) {
            if (info.State.Running) this.runtime.stop(info);
            this.runtime.remove(info); // no force: a failed stop cannot delete a running container
          }
          unlinkSync(this.path(name, "json"));
          logger.info(`removed idle sandbox ${name}`);
        } catch (err) { logger.warn(`sandbox cleanup deferred for ${name}`, err); }
        finally { release(); }
      }
    } finally { this.sweepRunning = false; }
  }

  start(): void {
    if (this.timer) return;
    const sweep = () => { void this.sweep().catch((err) => logger.warn("sandbox sweep failed", err)); };
    sweep();
    this.timer = setInterval(sweep, 60_000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
