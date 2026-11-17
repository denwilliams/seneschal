/** Bounded local lifecycle experiment. No Slack/model credentials, production connector or container required. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openConnectors, type ConnectorSession } from "../src/agent/connectors.ts";
import { SessionPool, type ThreadSession } from "../src/agent/session.ts";
import { MemoryDiagnostics } from "../src/util/memory-diagnostics.ts";

const root = mkdtempSync(join(tmpdir(), "harness-memory-"));
const fixture = fileURLToPath(new URL("../src/agent/fixtures/memory-connector.mjs", import.meta.url));
const diagnostics = new MemoryDiagnostics();
const pool = new SessionPool(2);
const sessions: ConnectorSession[] = [];
const pids: number[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sample = (phase: string) => console.log(JSON.stringify({ phase, fixtureChildrenAlive: pids.filter(alive).length, ...diagnostics.snapshot() }));
async function open(index: number, fail: boolean) {
  const pidFile = join(root, `${index}.pid`);
  const session = await openConnectors([{ name: "synthetic", origin: "channel", config: {
    transport: "stdio", command: process.execPath, args: [fixture], env: {
      FIXTURE_PID_FILE: pidFile, FIXTURE_FAIL_LIST: fail ? "1" : "0",
    },
  } }], "synthetic-channel", {}, root, root);
  sessions.push(session);
  pids.push(Number(readFileSync(pidFile, "utf8")));
  if (session.failures.length !== (fail ? 1 : 0)) throw new Error("Unexpected fixture initialization result");
  return session;
}
try {
  sample("baseline");
  if (globalThis.gc) { globalThis.gc(); sample("baseline-after-gc"); }
  // Failed connectors must be released even if their owning sessions remain warm.
  for (let i = 0; i < 6; i++) {
    await open(i, true);
    await delay(50);
    sample(`failed-discovery-${i + 1}`);
  }
  await Promise.all(sessions.map((session) => session.close()));
  sessions.length = 0;
  await delay(2500); // Also allow the SDK's unref'ed close grace timers to expire.
  sample("failed-sessions-disposed");
  if (globalThis.gc) { globalThis.gc(); await delay(0); globalThis.gc(); sample("failed-sessions-disposed-after-gc"); }
  // Three batches of fresh threads, each making four 64 KiB tool calls. The real SessionPool retains at most two.
  for (let batch = 0; batch < 3; batch++) {
    for (let i = 0; i < 6; i++) {
      const session = await open(6 + batch * 6 + i, false);
      for (let call = 0; call < 4; call++) {
        const result = await session.tools[0]!.execute("synthetic", {}, undefined, undefined, {} as never);
        if ((result.content[0] as { text: string }).text.length !== 65536) throw new Error("Unexpected fixture output");
      }
      await pool.set("synthetic-channel", `${batch}-${i}`, { lastUsed: Date.now(), dispose: () => session.close() } as ThreadSession);
    }
    sample(`successful-batch-${batch + 1}-warm`);
    await pool.disposeAll();
    sessions.length = 0;
    await delay(2500);
    sample(`successful-batch-${batch + 1}-idle`);
    if (globalThis.gc) { globalThis.gc(); await delay(0); globalThis.gc(); sample(`successful-batch-${batch + 1}-idle-after-gc`); }
  }
} finally {
  await pool.disposeAll();
  await Promise.allSettled(sessions.map((session) => session.close()));
  diagnostics.stop();
  rmSync(root, { recursive: true, force: true });
}
