import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { SandboxSchema } from "../config/schema.ts";
import { SandboxLifecycle } from "./sandbox-lifecycle.ts";
import { createDockerBashOperations, sandboxTimeoutMs, startSandboxCleanup, stopAllSandboxes } from "./sandbox.ts";

// Exercise the installed SDK -> adapter -> Node timer boundary without Docker
// or real 30/300-second waits. Lifecycle provisioning is covered separately.
function fixture(t: TestContext, reuse = true) {
  const root = mkdtempSync(join(tmpdir(), "sandbox-timeout-"));
  const workspace = join(root, "channels/C1/workspace");
  mkdirSync(workspace, { recursive: true });
  t.mock.method(SandboxLifecycle.prototype, "start", () => {});
  const ensure = t.mock.method(SandboxLifecycle.prototype, "ensure", () => {});
  const finish = t.mock.method(SandboxLifecycle.prototype, "finish", () => {});
  const cancel = t.mock.method(SandboxLifecycle.prototype, "cancel", () => {});
  const discard = t.mock.method(SandboxLifecycle.prototype, "discard", () => {});
  const docker = t.mock.method(childProcess, "execFileSync", (_file: string, args: string[]) => {
    if (args[0] === "image") return JSON.stringify([{ Id: "sha256:test", Config: {} }]);
    assert.equal(args[0], "exec", "only repository validation is expected after provisioning");
    return "";
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: t.mock.fn((signal: string) => {
      assert.equal(signal, "SIGKILL");
      queueMicrotask(() => child.emit("close", null));
      return true;
    }),
  });
  const spawn = t.mock.method(childProcess, "spawn", () => child);
  // The adapter uses named builtin imports; propagate the mocks to those live
  // bindings, then restore them explicitly after the test.
  syncBuiltinESMExports();
  startSandboxCleanup(root);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    stopAllSandboxes();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const operations = createDockerBashOperations({
    config: SandboxSchema.parse({ mode: "docker", timeoutSeconds: 300, reuse }),
    workspace, dataDir: root, dockerDataDir: root, env: {}, channelId: "C1", threadKey: "timeout",
  });
  const tool = createBashTool(workspace, { operations, exposeSessionEnvironment: false });
  return { operations, tool, workspace, child, spawn, docker, ensure, finish, cancel, discard };
}

for (const seconds of [30, 300]) {
  test(`SDK explicit timeout ${seconds} is seconds at the Docker timer boundary`, async (t) => {
    const f = fixture(t);
    const result = f.tool.execute("test", { command: "sleep forever", timeout: seconds });
    assert.equal(f.spawn.mock.callCount(), 1);
    t.mock.timers.tick(seconds * 1000 - 1);
    assert.equal(f.cancel.mock.callCount(), 0, "must not cancel after only 30/300 milliseconds");
    assert.equal(f.child.kill.mock.callCount(), 0);
    t.mock.timers.tick(1);
    const completed = await result;
    assert.equal(f.cancel.mock.callCount(), 1);
    assert.equal(f.child.kill.mock.callCount(), 1);
    assert.equal(completed.isError, true);
    assert.match(JSON.stringify(completed.content), /code 137/);
    assert.equal(f.finish.mock.callCount(), 1);
  });
}

test("SDK omission uses the configured 300-second per-command fallback", async (t) => {
  const f = fixture(t);
  const result = f.tool.execute("test", { command: "sleep forever" });
  t.mock.timers.tick(299_999);
  assert.equal(f.child.kill.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal((await result).isError, true);
  assert.equal(f.child.kill.mock.callCount(), 1);
});

test("each command gets its own full fallback budget", async (t) => {
  const f = fixture(t);
  const first = f.operations.exec("first", f.workspace, { onData: () => {} });
  t.mock.timers.tick(299_000);
  f.child.emit("close", 0);
  assert.deepEqual(await first, { exitCode: 0 });
  const second = f.operations.exec("second", f.workspace, { onData: () => {} });
  t.mock.timers.tick(299_999);
  assert.equal(f.child.kill.mock.callCount(), 0, "not a cumulative task deadline");
  t.mock.timers.tick(1);
  assert.deepEqual(await second, { exitCode: 137 });
  assert.equal(f.spawn.mock.callCount(), 2);
});

test("completed commands clear the timer and abort listener", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  const result = f.operations.exec("echo done", f.workspace,
    { timeout: 30, signal: controller.signal, onData: () => {} });
  f.child.emit("close", 0);
  assert.deepEqual(await result, { exitCode: 0 });
  assert.equal(remove.mock.callCount(), 1);
  controller.abort();
  t.mock.timers.tick(300_000);
  assert.equal(f.cancel.mock.callCount(), 0);
  assert.equal(f.child.kill.mock.callCount(), 0);
});

for (const reuse of [true, false]) {
  test(`abort cancels promptly without waiting for a 300-second timeout (reuse=${reuse})`, async (t) => {
    const f = fixture(t, reuse);
    const controller = new AbortController();
    const result = f.operations.exec("sleep forever", f.workspace,
      { timeout: 300, signal: controller.signal, onData: () => {} });
    controller.abort();
    assert.deepEqual(await result, { exitCode: 137 });
    assert.equal(f.cancel.mock.callCount(), 1);
    assert.equal(f.child.kill.mock.callCount(), 1);
    assert.equal(f.discard.mock.callCount(), reuse ? 0 : 1);
    t.mock.timers.tick(300_000);
    assert.equal(f.cancel.mock.callCount(), 1, "abort also clears the timeout");
  });
}

test("an already-aborted signal does not provision or spawn a command", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await f.operations.exec("never", f.workspace,
    { timeout: 300, signal: controller.signal, onData: () => {} });
  assert.deepEqual(result, { exitCode: 137 });
  assert.equal(f.ensure.mock.callCount(), 0);
  assert.equal(f.docker.mock.callCount(), 0);
  assert.equal(f.spawn.mock.callCount(), 0);
});

const invalidTimeouts = [0, -1, NaN, Infinity, -Infinity, 2_147_483.648, Number.MAX_VALUE,
  // Runtime callers can bypass the TypeScript contract; match SDK validation,
  // not JS multiplication/nullish coercion.
  null, "30", true];

test("invalid timeout values fail before Docker or timer setup", async (t) => {
  const f = fixture(t);
  for (const value of invalidTimeouts) {
    let output = "";
    const pending = f.operations.exec("never", f.workspace,
      { timeout: value as number, onData: (data) => { output += data; } });
    // If validation regresses, complete the unexpected fake child so this
    // fails with an assertion rather than a dangling execution promise.
    f.child.emit("close", 0);
    assert.deepEqual(await pending, { exitCode: 127 }, String(value));
    assert.match(output, /timeout/, String(value));
  }
  assert.equal(f.ensure.mock.callCount(), 0);
  assert.equal(f.docker.mock.callCount(), 0);
  assert.equal(f.spawn.mock.callCount(), 0);
});

test("conversion preserves SDK numeric validation, fractional seconds and timer limit", () => {
  assert.equal(sandboxTimeoutMs(300), 300_000);
  assert.equal(sandboxTimeoutMs(300, 30), 30_000);
  assert.equal(sandboxTimeoutMs(300, 300), 300_000);
  assert.equal(sandboxTimeoutMs(300, 0.5), 500);
  assert.equal(sandboxTimeoutMs(300, 2_147_483.647), 2_147_483_647);
  // Like the SDK, positive sub-millisecond values go through to Node, which
  // clamps them to its minimum delay. Even Number.MIN_VALUE remains valid.
  assert.equal(sandboxTimeoutMs(300, Number.MIN_VALUE), Number.MIN_VALUE * 1000);
  for (const value of invalidTimeouts) {
    assert.throws(() => sandboxTimeoutMs(300, value as number), /timeout/, String(value));
    assert.throws(() => sandboxTimeoutMs(value as number), /timeout/, `fallback: ${String(value)}`);
  }
  assert.equal(sandboxTimeoutMs(NaN, 30), 30_000, "a valid explicit timeout takes precedence");
});
