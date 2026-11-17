import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openConnectors, type ConnectorSession } from "./connectors.ts";
import type { EnabledConnector } from "../workspace/resolve.ts";
import { logger } from "../util/log.ts";

const fixture = fileURLToPath(new URL("./fixtures/memory-connector.mjs", import.meta.url));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function exited(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await delay(20);
  return !alive(pid);
}
function connector(root: string, index: number, fail: boolean): EnabledConnector {
  return { name: `fixture${index}`, origin: "channel", config: {
    transport: "stdio", command: process.execPath, args: [fixture], env: {
      FIXTURE_PID_FILE: join(root, `${index}.pid`), FIXTURE_FAIL_LIST: fail ? "1" : "0",
    },
  } };
}

test("repeated failed MCP discovery releases child processes before session eviction", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "connector-memory-"));
  const sessions: ConnectorSession[] = [];
  t.after(async () => {
    await Promise.allSettled(sessions.map((s) => s.close()));
    rmSync(root, { recursive: true, force: true });
  });
  const pids: number[] = [];
  for (let i = 0; i < 4; i++) {
    const session = await openConnectors([connector(root, i, true)], "C1", {}, root, root);
    sessions.push(session); // Deliberately keep the sessions warm: no close/idle eviction yet.
    assert.equal(session.failures.length, 1);
    assert.match(session.failures[0]!.error, /synthetic discovery failure/);
    assert.equal(session.tools.length, 0);
    pids.push(Number(readFileSync(join(root, `${i}.pid`), "utf8")));
  }
  const stopped = await Promise.all(pids.map(exited));
  assert.deepEqual(stopped, [true, true, true, true], "failed connector processes must not accumulate in warm sessions");
});

test("repeated successful MCP calls and session disposal release each child", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "connector-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 6; i++) {
    const session = await openConnectors([connector(root, i, false)], "C1", {}, root, root);
    try {
      assert.deepEqual(session.failures, []);
      const pid = Number(readFileSync(join(root, `${i}.pid`), "utf8"));
      assert.equal(alive(pid), true);
      for (let call = 0; call < 4; call++) {
        const result = await session.tools[0]!.execute(`call-${call}`, {}, undefined, undefined, {} as never);
        assert.equal(result.content[0]?.type, "text");
        assert.equal((result.content[0] as { text: string }).text.length, 65536);
      }
      await session.close();
      assert.equal(await exited(pid), true);
    } finally { await session.close(); }
  }
});

test("failed discovery does not close another connector in the same session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "connector-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = await openConnectors([connector(root, 0, true), connector(root, 1, false)], "C1", {}, root, root);
  try {
    assert.equal(session.failures.length, 1);
    assert.equal(session.tools.length, 1);
    assert.equal(await exited(Number(readFileSync(join(root, "0.pid"), "utf8"))), true);
    assert.equal(alive(Number(readFileSync(join(root, "1.pid"), "utf8"))), true);
    const result = await session.tools[0]!.execute("call", {}, undefined, undefined, {} as never);
    assert.equal((result.content[0] as { text: string }).text.length, 65536);
  } finally { await session.close(); }
});

test("connector diagnostics attribute distinct channel owners without exposing arguments", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "connector-memory-"));
  const previous = process.env.HARNESS_MEMORY_SAMPLE_SECONDS;
  process.env.HARNESS_MEMORY_SAMPLE_SECONDS = "60";
  const events: Record<string, any>[] = [];
  t.mock.method(logger, "info", (message: string) => { if (message.startsWith("{")) events.push(JSON.parse(message)); });
  t.after(() => {
    if (previous === undefined) delete process.env.HARNESS_MEMORY_SAMPLE_SECONDS;
    else process.env.HARNESS_MEMORY_SAMPLE_SECONDS = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const first = connector(root, 10, false);
  const second = connector(root, 11, false);
  second.name = first.name; // A name alone is not a safe cross-channel/account pooling key.
  const one = await openConnectors([first], "C1", { DO_NOT_LOG: "sensitive-test-value" }, root, root, undefined, "thread");
  let two: ConnectorSession | undefined;
  try {
    two = await openConnectors([second], "C2", {}, root, root, undefined, "subagent");
    const pid1 = Number(readFileSync(join(root, "10.pid"), "utf8"));
    const pid2 = Number(readFileSync(join(root, "11.pid"), "utf8"));
    assert.notEqual(pid1, pid2);
    await one.close();
    await one.close();
    assert.equal(await exited(pid1), true);
    assert.equal(alive(pid2), true, "one owner finishing cannot close another owner's connector");
    await two.tools[0]!.execute("call", {}, undefined, undefined, {} as never);
    await two.close();
    assert.equal(await exited(pid2), true);
    assert.deepEqual(events.map((event) => event.phase), ["opening", "ready", "opening", "ready", "closed", "closed"]);
    assert.equal(events[1]!.channelId, "C1");
    assert.equal(events[1]!.owner, "thread");
    assert.equal(events[3]!.channelId, "C2");
    assert.equal(events[3]!.owner, "subagent");
    assert.equal(events[1]!.processPid, pid1);
    assert.equal(events[3]!.processPid, pid2);
    assert.equal(events[2]!.instanceAttemptsStarted, events[0]!.instanceAttemptsStarted + 1);
    assert.equal(events[5]!.instancesOwned, events[0]!.instancesOwned - 1);
    assert.ok(!JSON.stringify(events).includes("sensitive-test-value"));
    assert.ok(!JSON.stringify(events).includes(root));
  } finally { await one.close(); await two?.close(); }
});
