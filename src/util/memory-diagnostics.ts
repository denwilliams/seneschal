import { ChildProcess, spawnSync } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { readdirSync, readFileSync } from "node:fs";
import { logger } from "./log.ts";

/** Numeric ps data only: never collect command lines, environment, paths or outputs. RSS is not unique physical memory. */
export function descendantMemory(table: string, rootPid: number, excludedPid?: number): { count: number; rssBytes: number } | undefined {
  const rows = new Map<number, { parent: number; rss: number }>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.set(Number(match[1]), { parent: Number(match[2]), rss: Number(match[3]) * 1024 });
  }
  if (!rows.has(rootPid)) return undefined;
  const parents = new Map<number, number[]>();
  for (const [pid, row] of rows) {
    const siblings = parents.get(row.parent) ?? [];
    siblings.push(pid);
    parents.set(row.parent, siblings);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  let rssBytes = 0;
  let count = 0;
  for (let index = 0; index < queue.length; index++) {
    for (const pid of parents.get(queue[index]!) ?? []) {
      if (seen.has(pid) || pid === excludedPid) continue;
      seen.add(pid);
      queue.push(pid);
      rssBytes += rows.get(pid)!.rss;
      count++;
    }
  }
  return { count, rssBytes };
}

function readDescendantMemory() {
  if (process.platform === "linux") {
    try {
      const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
      if (pids.length > 65536) return undefined;
      const deadline = Date.now() + 2_000;
      let incomplete = false;
      const table = pids.map((pid) => {
        if (Date.now() > deadline) { incomplete = true; return ""; }
        try {
          const status = readFileSync(`/proc/${pid}/status`, "utf8");
          const parent = /^PPid:\s+(\d+)/m.exec(status)?.[1];
          const rss = /^VmRSS:\s+(\d+) kB/m.exec(status)?.[1] ?? "0";
          return parent ? `${pid} ${parent} ${rss}` : "";
        } catch { return ""; } // Exited or not visible in this namespace.
      }).join("\n");
      return incomplete ? undefined : descendantMemory(table, process.pid);
    } catch { return undefined; }
  }
  // Sync ps is intentionally outside the async-start counters. Bounded time/output; unavailable is not reported as zero.
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? descendantMemory(result.stdout, process.pid, result.pid) : undefined;
}

/** Node's documented child_process diagnostic channel covers async spawn/exec/execFile/fork, NOT spawnSync/execSync. */
export class MemoryDiagnostics {
  private started = 0;
  private exited = 0;
  private failed = 0;
  private readonly since = process.uptime();
  private readonly children = new Map<ChildProcess, { spawned: boolean; detach(): void }>();
  private readonly onChild = (message: unknown) => {
    const child = (message as { process?: unknown } | undefined)?.process;
    if (!(child instanceof ChildProcess) || this.children.has(child)) return;
    const entry = { spawned: false, detach: () => {
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      child.off("close", onClose);
    } };
    const onSpawn = () => { entry.spawned = true; this.started++; };
    const finish = () => { entry.detach(); this.children.delete(child); };
    const onExit = () => { if (entry.spawned) this.exited++; finish(); };
    // Do not attach an error listener: diagnostics must not suppress an otherwise-unhandled spawn error.
    const onClose = () => { if (!entry.spawned) this.failed++; finish(); };
    this.children.set(child, entry);
    child.once("spawn", onSpawn);
    child.once("exit", onExit);
    child.once("close", onClose);
  };

  constructor() { subscribe("child_process", this.onChild); }

  snapshot() {
    const memory = process.memoryUsage();
    const descendants = readDescendantMemory();
    return {
      kind: "harness.memory", timestamp: new Date().toISOString(), pid: process.pid,
      uptimeSeconds: process.uptime(), observedSinceUptimeSeconds: this.since,
      harness: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers },
      asyncChildren: { started: this.started, exited: this.exited, failedStarts: this.failed,
        running: [...this.children.values()].filter((entry) => entry.spawned).length },
      descendants: descendants ? { available: true as const, ...descendants } : { available: false as const },
    };
  }

  stop(): void {
    unsubscribe("child_process", this.onChild);
    for (const entry of this.children.values()) entry.detach();
    this.children.clear();
  }
}

/** Opt-in aggregate logging; no in-memory history, identifiers of children, heap snapshots, or forced GC. */
export function startMemoryDiagnostics(
  seconds: string | undefined,
  emit: (sample: ReturnType<MemoryDiagnostics["snapshot"]>) => void = (sample) => logger.info(JSON.stringify(sample)),
  warn: (message: string) => void = (message) => logger.warn(message),
): () => void {
  if (!seconds) return () => {};
  const interval = Number(seconds);
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) {
    warn("HARNESS_MEMORY_SAMPLE_SECONDS must be an integer from 1 to 3600; memory diagnostics disabled.");
    return () => {};
  }
  const diagnostics = new MemoryDiagnostics();
  const sample = () => { emit(diagnostics.snapshot()); };
  sample();
  const timer = setInterval(sample, interval * 1000);
  timer.unref();
  return () => { clearInterval(timer); diagnostics.stop(); };
}
