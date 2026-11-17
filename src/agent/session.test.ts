import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { isThreadActive, markThreadActive } from "../workspace/paths.ts";

function channelFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "session-"));
  const config = HarnessConfigSchema.parse({ channels: { general: {} } });
  const registry = new ChannelRegistry(dataDir);
  const { channel } = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "general", isDm: false },
    registry,
  );
  return { dataDir, channel: channel! };
}

test("a thread the bot has never handled is not followed", () => {
  const { dataDir } = channelFixture();
  assert.equal(isThreadActive(dataDir, "C1", "1700000000.000100"), false);
});

test("handling a thread makes the bot follow it, and that survives a restart", () => {
  const { dataDir, channel } = channelFixture();
  const threadKey = "1700000000.000100";

  markThreadActive(channel.paths.sessions, threadKey);

  // Nothing is cached in memory — the filesystem is the record — so a fresh
  // process sees the same answer.
  assert.equal(isThreadActive(dataDir, "C1", threadKey), true);
});

test("following a thread is per channel", () => {
  const { dataDir, channel } = channelFixture();
  markThreadActive(channel.paths.sessions, "1700000000.000100");

  assert.equal(isThreadActive(dataDir, "C1", "1700000000.000100"), true);
  assert.equal(isThreadActive(dataDir, "C2", "1700000000.000100"), false);
});

test("session leases protect running tools from capacity eviction and the idle sweeper", async (t) => {
  const { SessionPool } = await import("./session.ts");
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100_000 });
  const pool = new SessionPool(1, 1_000);
  function session() {
    return { lastUsed: Date.now(), disposed: 0, async dispose() { this.disposed++; } };
  }
  const active = session();
  const idle = session();
  try {
    pool.beginTurn("C1", "active");
    await pool.set("C1", "active", active as any);
    await pool.set("C1", "idle", idle as any);
    assert.equal(active.disposed, 0);
    assert.equal(idle.disposed, 1, "capacity eviction must select idle sessions only");
    t.mock.timers.tick(60_000);
    assert.equal(active.disposed, 0, "a long-running turn is not idle");
    const reload = pool.invalidate();
    await reload.disposed;
    assert.equal(reload.activeTurns, 1);
    await pool.endTurn("C1", "active");
    assert.equal(active.disposed, 1);
  } finally { await pool.disposeAll(); }
});

test("reload detaches idle sessions before asynchronous cleanup and never disposes their replacements", async () => {
  const { SessionPool } = await import("./session.ts");
  const pool = new SessionPool();
  let finish!: () => void;
  const cleanup = new Promise<void>((done) => { finish = done; });
  const old = { lastUsed: Date.now(), async dispose() { await cleanup; } };
  const fresh = { lastUsed: Date.now(), disposed: 0, async dispose() { this.disposed++; } };
  try {
    await pool.set("C1", "same", old as any);
    const reload = pool.invalidate();
    assert.equal(pool.get("C1", "same"), undefined);
    await pool.set("C1", "same", fresh as any);
    finish();
    await reload.disposed;
    assert.equal(pool.get("C1", "same"), fresh);
    assert.equal(fresh.disposed, 0);
  } finally { finish(); await pool.disposeAll(); }
});

test("invalidated session cleanup failures still release the lease and detach old tools", async () => {
  const { SessionPool } = await import("./session.ts");
  const pool = new SessionPool();
  try {
    pool.beginTurn("C1", "same");
    await pool.set("C1", "same", { lastUsed: Date.now(), async dispose() { throw new Error("broken connector close"); } } as any);
    await pool.invalidate().disposed;
    await pool.endTurn("C1", "same");
    assert.equal(pool.get("C1", "same"), undefined);
    pool.beginTurn("C1", "same");
    await pool.endTurn("C1", "same");
  } finally { await pool.disposeAll(); }
});

test("retiring a channel's sessions leaves a running turn's session alone until that turn ends", async () => {
  const { SessionPool } = await import("./session.ts");
  const pool = new SessionPool();
  const running = { lastUsed: Date.now(), disposed: 0, async dispose() { this.disposed++; } };
  const idle = { lastUsed: Date.now(), disposed: 0, async dispose() { this.disposed++; } };
  const other = { lastUsed: Date.now(), disposed: 0, async dispose() { this.disposed++; } };
  try {
    pool.beginTurn("C1", "running");
    await pool.set("C1", "running", running as any);
    await pool.set("C1", "idle", idle as any);
    await pool.set("C2", "other", other as any);
    await pool.disposeChannel("C1");
    assert.equal(idle.disposed, 1, "an idle session is retired at once");
    assert.equal(running.disposed, 0, "a session in the middle of a turn keeps its tools");
    assert.equal(other.disposed, 0, "another channel is untouched");
    await pool.endTurn("C1", "running");
    assert.equal(running.disposed, 1, "and is retired when its own turn finishes");
  } finally { await pool.disposeAll(); }
});
