import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp, configReloadWarnings } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { mainProcessSecret } from "../config/openbao.ts";
import { SessionPool, type ThreadSession } from "../agent/session.ts";
import { createExecTools } from "../agent/exec-tools.ts";
import { resolveChannel, type ResolvedChannel } from "../workspace/resolve.ts";
import { ChannelRegistry } from "../workspace/registry.ts";

test("reload diagnostics retain accepted Keychain risk and clear it when strict mode is restored", () => {
  const strict = HarnessConfigSchema.parse({ keychain: { helperPath: "/helper" } });
  const accepted = HarnessConfigSchema.parse({ keychain: { helperPath: "/helper", acceptHostExecutionRisk: true } });
  assert.match(configReloadWarnings(strict, accepted, "/data", "/data").join(" "), /Keychain host-execution risk accepted/);
  assert.match(configReloadWarnings(accepted, accepted, "/data", "/data").join(" "), /outside configured channel scopes/);
  assert.deepEqual(configReloadWarnings(accepted, strict, "/data", "/data"), []);
});

test("reload diagnostics report OpenBao acceptance independently and clear it when strict mode returns", () => {
  const openbao = { address: "https://bao.example.test", tokenFile: "/private/token" };
  const strict = HarnessConfigSchema.parse({ openbao });
  const accepted = HarnessConfigSchema.parse({ openbao: { ...openbao, acceptHostExecutionRisk: true } });
  assert.match(configReloadWarnings(strict, accepted, "/data", "/data").join(" "), /OpenBao host-execution risk accepted/);
  assert.match(configReloadWarnings(accepted, accepted, "/data", "/data").join(" "), /token file or process memory/);
  assert.deepEqual(configReloadWarnings(accepted, strict, "/data", "/data"), []);
  const both = HarnessConfigSchema.parse({ ...accepted, keychain: { helperPath: "/private/helper", acceptHostExecutionRisk: true } });
  const warnings = configReloadWarnings(strict, both, "/data", "/data");
  assert.equal(warnings.filter((warning) => /risk accepted/.test(warning)).length, 2);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const rule = ["issue", "create", "--repo", "denwilliams/example", "--title", "*", "--body", "*"];
const issueArgs = ["issue", "create", "--repo", "denwilliams/example", "--title", "Reload regression", "--body", "Offline echo only"];

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-config-reload-"));
  const configPath = join(dataDir, "harness.yaml");
  function config(allowArgs: string[][]) {
    return HarnessConfigSchema.parse({ dataDir, channels: { C1: {}, C2: {} }, defaults: {
      tools: ["exec"], exec: { commands: { gh: { command: "/bin/echo", allowArgs } } },
    } });
  }
  const oldConfig = config([["**"]]);
  const pool = new SessionPool();
  const registry = new ChannelRegistry(dataDir);
  // Exercise the actual reload and per-thread queue without opening Slack or an LLM.
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config: oldConfig, opts: { configPath, dataDir }, registry, pool,
    turnQueue: new Map(), botUserId: "UBOT",
    runtimes: { channelIds: () => [], invalidateAll: async () => {}, invalidate: async () => {} },
    openChannelStore: async () => "opened",
    scheduleRecentConversationSummary() {},
  }) as any;
  const created: any[] = [];
  const gates = new Map<string, { entered: ReturnType<typeof deferred>; finish: ReturnType<typeof deferred>; beforeSet?: boolean }>();
  harness.runAgentTurn = async (_client: unknown, channel: ResolvedChannel, threadKey: string, _ts: string, _msg: unknown, prompt: string) => {
    const gate = gates.get(prompt);
    let thread = pool.get(channel.ref.id, threadKey) as any;
    if (!thread) {
      thread = makeSession(channel, threadKey);
      if (gate?.beforeSet) { gate.entered.resolve(); await gate.finish.promise; }
      await pool.set(channel.ref.id, threadKey, thread);
    }
    if (gate && !gate.beforeSet) { gate.entered.resolve(); await gate.finish.promise; }
    if (prompt === "issue") {
      const out = await thread.tool.execute("reload-regression", { args: issueArgs });
      return { status: "completed", text: out.content[0].text };
    }
    return { status: "completed" };
  };
  function channel(id = "C1") {
    return resolveChannel(oldConfig, dataDir, { id, isDm: false }, registry).channel!;
  }
  function makeSession(resolved: ResolvedChannel, threadKey: string) {
    const thread = {
      channel: resolved, threadKey, lastUsed: Date.now(), disposed: 0,
      tool: createExecTools({ config: resolved.exec, cwd: resolved.paths.workspace, binDir: resolved.paths.bin, env: resolved.env })[0]! as any,
      async dispose() { this.disposed++; },
    };
    created.push(thread);
    return thread;
  }
  async function seed(id: string, key: string) {
    const thread = makeSession(channel(id), key);
    await pool.set(id, key, thread as unknown as ThreadSession);
    return thread;
  }
  function run(id: string, key: string, prompt: string, captured = channel(id)) {
    return harness.runAgent({}, captured, key, key, { channelId: id, userId: "U1", ts: key }, prompt);
  }
  function gate(prompt: string, beforeSet = false) {
    const value = { entered: deferred(), finish: deferred(), beforeSet };
    gates.set(prompt, value);
    return value;
  }
  async function reload(allowArgs = [rule]) {
    writeFileSync(configPath, JSON.stringify(config(allowArgs)));
    return harness.reloadConfig();
  }
  async function cleanup() { await pool.disposeAll(); rmSync(dataDir, { recursive: true, force: true }); }
  return { harness, pool, created, channel, seed, run, gate, reload, cleanup, configPath, config };
}

test("reload evicts idle gh sessions despite an unrelated active turn; new sessions survive its completion", async () => {
  const f = fixture();
  const active = f.gate("hold unrelated");
  const freshActive = f.gate("hold fresh");
  let running: Promise<unknown> | undefined;
  let freshRunning: Promise<unknown> | undefined;
  try {
    const idle = await f.seed("C1", "idle");
    await assert.rejects(() => idle.tool.execute("old", { args: issueArgs }), /Allowed patterns: \["\*\*"\]/);
    const busy = await f.seed("C2", "busy");
    running = f.run("C2", "busy", "hold unrelated");
    await active.entered.promise;
    const reload = await f.reload();
    assert.equal(reload.applied, true);
    assert.equal(idle.disposed, 1, "idle old tools must be evicted immediately, not after all turns finish");
    assert.equal(busy.disposed, 0, "in-flight tools remain usable");
    const future = await f.run("C1", "idle", "issue");
    assert.match(future.text, /exit: 0/);
    const fresh = f.pool.get("C1", "idle");
    assert.notEqual(fresh, idle);
    freshRunning = f.run("C1", "idle", "hold fresh");
    await freshActive.entered.promise;
    active.finish.resolve();
    await running;
    assert.equal(busy.disposed, 1);
    assert.equal(f.pool.get("C1", "idle"), fresh, "old completion cannot globally dispose newly rebuilt sessions");
    assert.equal((fresh as any).disposed, 0);
  } finally {
    active.finish.resolve(); freshActive.finish.resolve();
    await Promise.allSettled([running, freshRunning].filter(Boolean) as Promise<unknown>[]);
    await f.cleanup();
  }
});

test("queued follow-up resolves current config and rebuilds after its own turn, not unrelated work", async () => {
  const f = fixture();
  const own = f.gate("hold own");
  const unrelated = f.gate("hold unrelated");
  let first: Promise<unknown> | undefined;
  let other: Promise<unknown> | undefined;
  let followup: Promise<any> | undefined;
  try {
    const old = await f.seed("C1", "busy");
    first = f.run("C1", "busy", "hold own");
    other = f.run("C2", "other", "hold unrelated");
    await Promise.all([own.entered.promise, unrelated.entered.promise]);
    followup = f.run("C1", "busy", "issue", f.channel());
    void followup!.catch(() => {});
    await f.reload();
    assert.equal(old.disposed, 0);
    own.finish.resolve();
    await first;
    const result = await followup;
    assert.match(result.text, /exit: 0/);
    assert.equal(old.disposed, 1);
    assert.equal((f.pool.get("C2", "other") as any).disposed, 0);
  } finally {
    own.finish.resolve(); unrelated.finish.resolve();
    await Promise.allSettled([first, other, followup].filter(Boolean) as Promise<unknown>[]);
    await f.cleanup();
  }
});

test("reload during asynchronous session creation retires it after that turn; repeated reload uses latest policy", async () => {
  const f = fixture();
  const starting = f.gate("create slowly", true);
  let first: Promise<unknown> | undefined;
  try {
    first = f.run("C1", "starting", "create slowly");
    await starting.entered.promise;
    await f.reload([["issue", "view", "*"]]);
    await f.reload();
    assert.equal(f.created[0].disposed, 0);
    starting.finish.resolve();
    await first;
    assert.equal(f.created[0].disposed, 1, "sessions not yet cached at reload still belong to the old turn");
    assert.equal(f.pool.get("C1", "starting"), undefined);
    const result = await f.run("C1", "starting", "issue");
    assert.match(result.text, /exit: 0/);
  } finally { starting.finish.resolve(); await first; await f.cleanup(); }
});

test("a turn queued but not started at reload uses the new policy", async () => {
  const f = fixture();
  let future: Promise<any> | undefined;
  try {
    const old = await f.seed("C1", "idle");
    writeFileSync(f.configPath, JSON.stringify(f.config([rule])));
    future = f.run("C1", "idle", "issue");
    void future!.catch(() => {});
    const reload = await f.harness.reloadConfig();
    assert.deepEqual(reload.warnings, [], "a queued microtask is not an executing old-config turn");
    assert.match((await future).text, /exit: 0/);
    assert.equal(old.disposed, 1);
  } finally { await Promise.allSettled(future ? [future] : []); await f.cleanup(); }
});

test("invalid config leaves cached sessions and current policy untouched", async () => {
  const f = fixture();
  try {
    const old = await f.seed("C1", "idle");
    const current = f.harness.config;
    writeFileSync(f.configPath, "defaults: {tools: [not-a-tool]}");
    const reload = await f.harness.reloadConfig();
    assert.equal(reload.applied, false);
    assert.equal(f.harness.config, current);
    assert.equal(f.pool.get("C1", "idle"), old);
    assert.equal(old.disposed, 0);
  } finally { await f.cleanup(); }
});

test("queued users revoked during reload never reach session tools", async () => {
  const f = fixture();
  const active = f.gate("hold own");
  let running: Promise<unknown> | undefined;
  try {
    running = f.run("C1", "busy", "hold own");
    await active.entered.promise;
    const future = f.run("C1", "busy", "issue");
    const next = f.config([rule]);
    next.defaults.allowUsers = ["U2"];
    writeFileSync(f.configPath, JSON.stringify(next));
    await f.harness.reloadConfig();
    active.finish.resolve();
    await running;
    const result = await future;
    assert.equal(result.status, "failed");
    assert.match(result.error, /no longer allowed/);
    assert.equal(f.created.length, 1, "no replacement or CLI execution for a denied queued user");
  } finally { active.finish.resolve(); await running; await f.cleanup(); }
});

test("completion of an old unrelated turn cannot dispose a new-config active session", async () => {
  const f = fixture();
  const oldActive = f.gate("hold old");
  const newActive = f.gate("hold new");
  let oldRun: Promise<unknown> | undefined;
  let newRun: Promise<unknown> | undefined;
  try {
    oldRun = f.run("C2", "old", "hold old");
    await oldActive.entered.promise;
    await f.reload();
    const latest = resolveChannel(f.harness.config, f.harness.opts.dataDir, { id: "C1", isDm: false }, f.harness.registry).channel!;
    newRun = f.run("C1", "new", "hold new", latest);
    await newActive.entered.promise;
    const fresh = f.pool.get("C1", "new") as any;
    assert.deepEqual(fresh.channel.exec.commands.gh.allowArgs, [rule]);
    oldActive.finish.resolve();
    await oldRun;
    // Drain deferred completion callbacks, not a timed sleep. The old reload
    // waits for allSettled and then globally disposes this still-running turn.
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(fresh.disposed, 0, "new-config in-flight tools must not be touched by old completion");
    assert.equal(f.pool.get("C1", "new"), fresh);
  } finally {
    oldActive.finish.resolve(); newActive.finish.resolve();
    await Promise.allSettled([oldRun, newRun].filter(Boolean) as Promise<unknown>[]);
    await f.cleanup();
  }
});

test("a failed old-config turn still retires its session and permits the queued successor", async () => {
  const f = fixture();
  const active = f.gate("hold then fail");
  const turn = f.harness.runAgentTurn;
  f.harness.runAgentTurn = async (...args: any[]) => {
    const result = await turn(...args);
    if (args[5] === "hold then fail") throw new Error("old turn failed");
    return result;
  };
  let running: Promise<any> | undefined;
  let future: Promise<any> | undefined;
  try {
    const old = await f.seed("C1", "busy");
    running = f.run("C1", "busy", "hold then fail");
    void running!.catch(() => {});
    await active.entered.promise;
    future = f.run("C1", "busy", "issue");
    void future!.catch(() => {});
    await f.reload();
    active.finish.resolve();
    await assert.rejects(running!, /old turn failed/);
    assert.match((await future).text, /exit: 0/);
    assert.equal(old.disposed, 1);
  } finally {
    active.finish.resolve();
    await Promise.allSettled([running, future].filter(Boolean) as Promise<unknown>[]);
    await f.cleanup();
  }
});

test("OpenBao reload publishes complete channel snapshots atomically and preserves the running config on backend failure", async (t) => {
  const f = fixture();
  const privateRoot = mkdtempSync(join(tmpdir(), "reload-bao-bootstrap-"));
  const tokenFile = join(privateRoot, "token");
  writeFileSync(tokenFile, "synthetic-bootstrap", { mode: 0o600 });
  let fail = false;
  let generation = "first";
  t.mock.method(globalThis, "fetch", async () => fail
    ? Response.json({ errors: ["synthetic-bootstrap PRIVATE_BACKEND_DETAIL"] }, { status: 403 })
    : Response.json({ data: { data: { value: generation } } }));
  const next = {
    dataDir: f.harness.opts.dataDir,
    defaults: { tools: [] }, channels: { C1: {}, C2: {} },
    openbao: { address: "https://bao.example.test", tokenFile, mainProcess: ["MAIN"], globalChannel: ["GLOBAL"], channels: { C1: ["LOCAL"] } },
  };
  try {
    writeFileSync(f.configPath, JSON.stringify(next));
    const applied = await f.harness.reloadConfig();
    assert.equal(applied.applied, true);
    assert.match(applied.warnings.join(" "), /main-process Slack\/model credentials require a restart/);
    const current = f.harness.config;
    const resolve = (id: string) => resolveChannel(f.harness.config, f.harness.opts.dataDir, { id, isDm: false }, f.harness.registry).channel!;
    assert.equal(resolve("C1").env.LOCAL, "first");
    assert.equal(resolve("C2").env.LOCAL, undefined);
    assert.equal(resolve("C2").env.GLOBAL, "first");
    assert.equal(resolve("C1").env.MAIN, undefined);
    assert.equal(mainProcessSecret(current, "MAIN"), "first");
    generation = "second"; fail = true;
    const rejected = await f.harness.reloadConfig();
    assert.equal(rejected.applied, false);
    assert.doesNotMatch(JSON.stringify(rejected), /synthetic-bootstrap|PRIVATE_BACKEND_DETAIL/);
    assert.equal(f.harness.config, current);
    assert.equal(resolve("C1").env.LOCAL, "first");
    fail = false;
    assert.equal((await f.harness.reloadConfig()).applied, true);
    assert.notEqual(f.harness.config, current);
    assert.equal(resolve("C1").env.LOCAL, "second");
  } finally {
    await f.cleanup(); rmSync(privateRoot, { recursive: true, force: true });
  }
});
