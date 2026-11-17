import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SandboxSchema } from "../config/schema.ts";
import { SandboxLifecycle } from "./sandbox-lifecycle.ts";
import { createDockerBashOperations, repositoryStorageScript, startSandboxCleanup, stopAllSandboxes } from "./sandbox.ts";

function fixture(t: TestContext, owner = "1000\n", readOnlyRoot = false, reuse = true, failOperation?: "prepare" | "chmod" | "validate") {
  const root = mkdtempSync(join(tmpdir(), "sandbox-bootstrap-"));
  const workspace = join(root, "channels/C1/workspace");
  mkdirSync(workspace, { recursive: true });
  let ready = false;
  t.mock.method(SandboxLifecycle.prototype, "start", () => {});
  t.mock.method(SandboxLifecycle.prototype, "ensure", (_name: string, _fp: string, _idle: number, create: (labels: Record<string, string>) => void) => {
    if (!ready || !reuse) { create({}); ready = true; }
  });
  t.mock.method(SandboxLifecycle.prototype, "finish", () => {});
  t.mock.method(SandboxLifecycle.prototype, "discard", () => {});
  const docker = t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    assert.equal(file, "docker");
    if (args[0] === "image") return JSON.stringify([{ Id: "sha256:test", Config: {} }]);
    if (failOperation && args.at(-1) === repositoryStorageScript(false, failOperation)) throw new Error(`storage ${failOperation} failed`);
    if (args.at(-1) === repositoryStorageScript(false, "prepare")) return owner;
    return "";
  });
  const spawn = t.mock.method(childProcess, "spawn", () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  syncBuiltinESMExports();
  startSandboxCleanup(root);
  t.after(() => {
    stopAllSandboxes(); t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const operations = createDockerBashOperations({
    config: SandboxSchema.parse({ mode: "docker", readOnlyRoot, reuse, user: "1234" }),
    workspace, dataDir: root, dockerDataDir: root, env: { GH_TOKEN: "not-for-setup" }, channelId: "C1", threadKey: "bootstrap",
  });
  const run = async () => {
    let output = "";
    return { ...await operations.exec("agent command", workspace, { onData: (d) => { output += d; } }), output };
  };
  return { docker, spawn, run, ready: () => ready };
}

for (const owner of ["0", "1000", "9876"]) {
  test(`fresh writable bootstrap chmods as inode UID ${owner}, never adds capabilities`, async (t) => {
    const f = fixture(t, `${owner}\n`);
    assert.equal((await f.run()).exitCode, 0);
    const calls = f.docker.mock.calls.map((c) => c.arguments[1] as string[]);
    const creation = calls.find((a) => a[0] === "run")!;
    assert.equal(creation[creation.indexOf("--cap-drop") + 1], "ALL");
    assert.ok(creation.includes("no-new-privileges:true"));
    assert.equal(creation[creation.indexOf("--user") + 1], "1234");
    assert.deepEqual(calls.filter((a) => a.includes("--user") && a[0] === "exec").map((a) => a[a.indexOf("--user") + 1]), ["0", owner]);
    const preparation = calls.find((a) => a.at(-1) === repositoryStorageScript(false, "prepare"))!;
    const chmod = calls.find((a) => a.at(-1) === repositoryStorageScript(false, "chmod"))!;
    assert.ok(calls.indexOf(preparation) < calls.indexOf(chmod));
    for (const setup of [preparation, chmod]) {
      assert.ok(setup.at(-1)!.includes("PATH=/usr/bin:/bin; export PATH"), "setup tools never resolve through workspace/bin");
      assert.ok(!setup.includes("--env"));
      assert.ok(!setup.includes("--privileged"));
      assert.ok(!setup.includes("--cap-add"));
    }
    const command = f.spawn.mock.calls[0]!.arguments[1] as string[];
    assert.ok(!command.includes("--user"), "agent inherits configured/image user, not setup UID");
    assert.ok(!command.includes("--privileged"));
    assert.equal(calls.filter((a) => a.at(-1) === repositoryStorageScript(false)).length, 2, "actual-user checks before readiness and dispatch");
    const before = f.docker.mock.callCount();
    assert.equal((await f.run()).exitCode, 0);
    const reused = f.docker.mock.calls.slice(before).map((c) => c.arguments[1] as string[]);
    assert.ok(reused.every((a) => !a.includes("--user")), "no root/owner repair on reuse");
    assert.equal(reused.filter((a) => a[0] === "exec").length, 1);
  });
}

test("read-only-root bootstrap and reuse only validate as configured user", async (t) => {
  const f = fixture(t, "not used", true);
  assert.equal((await f.run()).exitCode, 0);
  assert.equal((await f.run()).exitCode, 0);
  const calls = f.docker.mock.calls.map((c) => c.arguments[1] as string[]);
  assert.ok(calls.filter((a) => a[0] === "exec").every((a) => !a.includes("--user") && a.at(-1) === repositoryStorageScript(true)));
  assert.ok(calls.find((a) => a[0] === "run")!.includes("/repos:rw,mode=1777,size=256m"));
});

test("one-shot containers receive fresh owner-directed preparation each time", async (t) => {
  const f = fixture(t, "1000", false, false);
  assert.equal((await f.run()).exitCode, 0);
  assert.equal((await f.run()).exitCode, 0);
  assert.equal(f.docker.mock.calls.filter((c) => (c.arguments[1] as string[]).at(-1) === repositoryStorageScript(false, "chmod")).length, 2);
});

for (const owner of ["", "node", "1000:0", "--privileged", "-1", "01", "1000\n0", "4294967295", "999999999999999999999"]) {
  test(`invalid discovered UID ${JSON.stringify(owner)} fails before chmod/readiness/dispatch`, async (t) => {
    const f = fixture(t, owner);
    const result = await f.run();
    assert.equal(result.exitCode, 127);
    assert.match(result.output, /valid numeric UID/);
    assert.equal(f.ready(), false);
    assert.equal(f.spawn.mock.callCount(), 0);
    assert.ok(!f.docker.mock.calls.some((c) => (c.arguments[1] as string[]).at(-1) === repositoryStorageScript(false, "chmod")));
  });
}

test("every mutation retains symlink, non-directory and mount-redirect guards", () => {
  for (const operation of ["prepare", "chmod", "validate"] as const) {
    const script = repositoryStorageScript(false, operation);
    assert.ok(script.includes("[ ! -L /repos ] || fail"));
    assert.ok(script.includes("[ ! -d /repos ]"));
    assert.ok(script.includes("/repos/*) fail"));
    assert.ok(script.includes("[ \"$repos_mount\" = 0 ] || fail"));
    if (operation === "prepare") {
      assert.ok(script.indexOf("[ \"$repos_mount\" = 0 ]") < script.indexOf("mkdir /repos"));
      assert.ok(!script.includes("chmod 1777"));
    } else {
      assert.ok(!script.includes("mkdir /repos"));
      assert.ok(script.includes('(cd -P /repos && [ "$(pwd -P)" = /repos ]) || fail'));
    }
  }
});


for (const operation of ["prepare", "chmod", "validate"] as const) {
  test(`failed ${operation} cannot mark readiness or dispatch agent code`, async (t) => {
    const f = fixture(t, "1000", false, true, operation);
    const result = await f.run();
    assert.equal(result.exitCode, 127);
    assert.match(result.output, new RegExp(`storage ${operation} failed`));
    assert.equal(f.ready(), false);
    assert.equal(f.spawn.mock.callCount(), 0);
  });
}
