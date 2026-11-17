import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { SessionPool, type ThreadSession } from "../agent/session.ts";
import { resolveChannel, type ResolvedChannel } from "../workspace/resolve.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { listSkills } from "../agent/skills.ts";

/**
 * Hot reload for Workstream B (precedent: config-reload.test.ts): collection
 * assignment, ro/rw mode, the admin flag and the CLI pool all take effect on
 * the next resolve after `reloadConfig()` — no restart — and idle sessions
 * holding the old resolution are retired (a running container is recreated
 * separately, because its mounts are part of its fingerprint).
 */

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-wsb-reload-"));
  const configPath = join(dataDir, "harness.yaml");
  for (const c of ["team", "other"]) {
    mkdirSync(join(dataDir, "shared", "skills", c, `${c}-skill`), { recursive: true });
    writeFileSync(
      join(dataDir, "shared", "skills", c, `${c}-skill`, "SKILL.md"),
      `---\nname: ${c}-skill\ndescription: "${c} skill."\n---\nbody\n`,
    );
  }
  const base = {
    dataDir,
    cliTools: { echoer: { command: "/bin/echo", allowArgs: [["**"]] } },
  };
  const write = (channels: unknown, extra: Record<string, unknown> = {}) =>
    writeFileSync(configPath, JSON.stringify({ ...base, ...extra, channels }));
  write({ C1: { tools: ["exec"], share: { skillCollections: [{ name: "team", mode: "rw" }] }, exec: { shared: ["echoer"] } } });
  const pool = new SessionPool();
  const registry = new ChannelRegistry(dataDir);
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config: HarnessConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf-8"))),
    opts: { configPath, dataDir },
    registry,
    pool,
    turnQueue: new Map(),
    botUserId: "UBOT",
    runtimes: { invalidateAll: async () => {}, invalidate: async () => {} },
    scheduleRecentConversationSummary() {},
  }) as any;
  const resolve = (id = "C1"): ResolvedChannel =>
    resolveChannel(harness.config, dataDir, { id, isDm: false }, registry).channel!;
  return { harness, pool, write, resolve, dataDir, cleanup: async () => { await pool.disposeAll(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("reload applies collection assignment, mode, admin flag and CLI pool changes without a restart", async () => {
  const f = fixture();
  try {
    assert.equal((await f.harness.reloadConfig()).applied, true);
    const before = f.resolve();
    assert.deepEqual(before.skillCollections.map((c) => [c.name, c.mode]), [["team", "rw"]]);
    assert.deepEqual(Object.keys(before.exec.commands), ["echoer"]);
    assert.equal(before.admin, false);
    assert.equal(before.containerMounts.find((m) => m.name === "team")?.readOnly, false);

    // a cached idle session built from that resolution
    let disposed = 0;
    await f.pool.set("C1", "1.1", { channel: before, threadKey: "1.1", lastUsed: Date.now(), async dispose() { disposed++; } } as unknown as ThreadSession);

    // demote rw -> ro, swap the collection, drop the CLI, make C1 the admin
    f.write({ C1: { admin: true, share: { skillCollections: ["other"] } } });
    const result = await f.harness.reloadConfig();
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(disposed, 1, "the idle session holding the old resolution is retired");
    assert.equal(f.pool.get("C1", "1.1"), undefined);

    const after = f.resolve();
    assert.deepEqual(after.skillCollections.map((c) => [c.name, c.mode]), [["other", "ro"]]);
    assert.deepEqual(Object.keys(after.exec.commands), [], "revoked pool tool is gone on the next resolve");
    assert.equal(after.admin, true);
    assert.ok(listSkills(after).some((s) => s.name === "other-skill"));
    assert.ok(!listSkills(after).some((s) => s.name === "team-skill"), "the dropped collection is no longer loaded");
    assert.deepEqual(after.containerMounts.filter((m) => m.kind === "collection").map((m) => [m.name, m.readOnly]), [["other", true]]);
    assert.ok(!after.jail.readRoots.includes(join(f.dataDir, "shared", "skills", "team")));
  } finally {
    await f.cleanup();
  }
});

test("a reload that breaks the new rules (two admins, unknown pool tool, removed share.skills) is rejected and changes nothing", async () => {
  const f = fixture();
  try {
    await f.harness.reloadConfig();
    const current = f.harness.config;
    for (const [channels, expected] of [
      [{ C1: { admin: true }, C2: { admin: true } }, /at most one channel may set admin/],
      [{ C1: { exec: { shared: ["nope"] } } }, /no account-wide cliTools entry/],
      [{ C1: { share: { skills: ["old"] } } }, /replaced by share\.skillCollections/],
      [{ C1: { share: { skillCollections: [{ name: "team", mode: "write" }] } } }, /./],
    ] as const) {
      f.write(channels);
      const result = await f.harness.reloadConfig();
      assert.equal(result.applied, false);
      assert.match(result.error, expected);
      assert.equal(f.harness.config, current);
    }
  } finally {
    await f.cleanup();
  }
});
