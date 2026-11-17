import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxLifecycle, CONFIG_LABEL, OWNER_LABEL, type DockerCall } from "./sandbox-lifecycle.ts";

function fixture() {
  const data = mkdtempSync(join(tmpdir(), "sandbox-lifecycle-"));
  let time = 1_000;
  let running = true;
  let busy = false;
  let execs: string[] = [];
  let present = false;
  let containerId = "id";
  let labels: Record<string, string> = {};
  const calls: string[][] = [];
  const docker: DockerCall = (args) => {
    calls.push(args);
    switch (args[0]) {
      case "inspect":
        if (!present) throw new Error("No such object: sandbox");
        return JSON.stringify([{ Id: containerId, Image: "image", Config: { Labels: labels }, State: { Running: running }, ExecIDs: execs }]);
      case "top": return `PID\n1${busy ? "\n2" : ""}\n`;
      case "stop": running = false; busy = false; execs = []; return "id";
      case "start": running = true; return "id";
      case "rm": assert.equal(running, false); present = false; return "id";
      default: throw new Error(`Unexpected docker call: ${args}`);
    }
  };
  const manager = new SandboxLifecycle(data, docker, () => time);
  const create = (ls: Record<string, string>) => { labels = ls; present = true; running = true; };
  const name = "harness-C1-123.456";
  const ensure = async (fingerprint = "v1", ttl = 10) => manager.withLease(name, async () => manager.ensure(name, fingerprint, ttl, create));
  return { data, manager, name, create, ensure, docker, calls,
    advance: (ms: number) => { time += ms; },
    busy: (value: boolean) => { busy = value; }, execs: (value: string[]) => { execs = value; },
    setContainerId: (id: string) => { containerId = id; },
    labels: () => labels, running: () => running, present: () => present,
    close: () => { manager.stop(); rmSync(data, { recursive: true, force: true }); } };
}

test("reuses owned matching containers across manager restart, retaining workspace on idle deletion", async () => {
  const f = fixture();
  try {
    const workspace = join(f.data, "channels/C1/workspace");
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, "durable"), "keep");
    await f.ensure(); f.manager.finish(f.name);
    const restart = new SandboxLifecycle(f.data, f.docker, () => 20_000);
    assert.equal(restart.owner, f.manager.owner);
    await restart.withLease(f.name, async () => restart.ensure(f.name, "v1", 10, () => assert.fail("must reuse")));
    restart.finish(f.name);
    f.advance(40_000); await f.manager.sweep();
    assert.equal(f.present(), false);
    assert.equal(readFileSync(join(workspace, "durable"), "utf8"), "keep");
  } finally { f.close(); }
});

test("24h configurable retention and shutdown do not remove a container", async () => {
  const f = fixture();
  try {
    await f.ensure("v1", 86_400); f.manager.finish(f.name); f.manager.start(); f.manager.stop();
    assert.equal(f.present(), true);
    f.advance(86_399_000); await f.manager.sweep(); assert.equal(f.present(), true);
    f.advance(1_000); await f.manager.sweep(); assert.equal(f.present(), false);
  } finally { f.close(); }
});

test("creation/exec lease excludes concurrent exec and GC, including a second manager", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let secondEntered = false;
    const first = f.manager.withLease(f.name, async () => {
      f.manager.ensure(f.name, "v1", 1, f.create); f.manager.finish(f.name); await gate;
    });
    const other = new SandboxLifecycle(f.data, f.docker);
    const second = other.withLease(f.name, async () => { secondEntered = true; });
    f.advance(10_000); await other.sweep();
    assert.equal(secondEntered, false); assert.equal(f.present(), true);
    release(); await first; await second; assert.equal(secondEntered, true);
  } finally { f.close(); }
});

test("background processes and ExecIDs protect activity after lost harness/CLI", async () => {
  const f = fixture();
  try {
    await f.ensure(); f.busy(true); f.manager.finish(f.name); f.advance(100_000);
    const restart = new SandboxLifecycle(f.data, f.docker, () => 200_000);
    await restart.sweep(); assert.equal(f.present(), true);
    f.busy(false); f.execs(["still-starting"]); await restart.sweep(); assert.equal(f.present(), true);
    f.execs([]); await restart.sweep(); assert.equal(f.present(), true, "recovery starts a fresh idle clock");
    f.advance(210_000); await f.manager.sweep(); assert.equal(f.present(), false);
  } finally { f.close(); }
});

test("image/config mismatch replaces idle containers but refuses active ones", async () => {
  const f = fixture();
  try {
    await f.ensure(); f.busy(true);
    await assert.rejects(f.ensure("v2"), /active processes/); assert.equal(f.labels()[CONFIG_LABEL], "v1");
    f.busy(false); await f.ensure("v2"); assert.equal(f.labels()[CONFIG_LABEL], "v2");
    assert.ok(f.calls.some((c) => c[0] === "rm"));
  } finally { f.close(); }
});

test("ownership collision and daemon errors never cause adoption/deletion", async () => {
  const f = fixture();
  try {
    await f.ensure(); f.labels()[OWNER_LABEL] = "different-installation";
    await assert.rejects(f.ensure(), /another installation/);
    f.advance(100_000); await f.manager.sweep(); assert.equal(f.present(), true);
    const broken = new SandboxLifecycle(f.data, () => { throw new Error("daemon offline"); });
    assert.throws(() => broken.ensure("harness-C2-t", "v1", 10, () => assert.fail()), /daemon offline/);
    assert.equal(f.calls.filter((c) => c[0] === "rm").length, 0);
  } finally { f.close(); }
});

test("cancellation stops all in-container processes, then starts the same container", async () => {
  const f = fixture();
  try {
    await f.ensure(); f.busy(true); f.execs(["exec"]);
    f.manager.cancel(f.name); assert.equal(f.running(), false); assert.equal(f.present(), true);
    f.manager.finish(f.name);
    await f.ensure(); assert.equal(f.running(), true);
    assert.equal(f.calls.filter((c) => c[0] === "rm").length, 0);
  } finally { f.close(); }
});

test("a dead host PID lease is recovered, while aborted wait never enters", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.manager.root, `${f.name}.lock`), JSON.stringify({ pid: 2147483647, identity: "dead" }));
    await f.ensure();
    assert.equal(existsSync(join(f.manager.root, `${f.name}.lock`)), false);
    await assert.rejects(f.manager.withLease(f.name, async () => assert.fail(), AbortSignal.abort()), /cancelled/);
  } finally { f.close(); }
});

test("one-shot discard removes descendants and metadata, without changing ownership scope", async () => {
  const f = fixture();
  try {
    await f.ensure(); f.busy(true); f.manager.discard(f.name);
    assert.equal(f.present(), false); assert.equal(existsSync(join(f.manager.root, `${f.name}.json`)), false);
  } finally { f.close(); }
});


test("PID reuse and a crashed stale-lease reaper are recovered", async () => {
  const f = fixture();
  try {
    const stale = JSON.stringify({ pid: process.pid, identity: "previous-process-incarnation" });
    writeFileSync(join(f.manager.root, `${f.name}.lock`), stale);
    writeFileSync(join(f.manager.root, `${f.name}.lock.recovery`), stale);
    await f.ensure(); assert.equal(f.present(), true);
  } finally { f.close(); }
});


test("malformed Docker inspection cannot be treated as a missing container", () => {
  const f = fixture();
  try {
    const broken = new SandboxLifecycle(f.data, () => "[]");
    assert.throws(() => broken.ensure(f.name, "v1", 10, () => assert.fail()), /Invalid Docker/);
  } finally { f.close(); }
});


test("only completed preparation commits readiness, bound to the exact container ID", async () => {
  const f = fixture();
  try {
    await f.ensure();
    const path = join(f.manager.root, `${f.name}.json`);
    const ready = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(ready.readyContainerId, "id");
    // Simulate a crash before readiness commit, even though final labels exist.
    delete ready.readyContainerId; writeFileSync(path, JSON.stringify(ready));
    f.busy(true);
    await assert.rejects(f.ensure(), /active processes.*incomplete initialization/);
    assert.equal(f.calls.filter((c) => c[0] === "rm").length, 0, "busy incomplete creation stays protected");
    f.busy(false); f.setContainerId("prepared-new");
    let preparations = 0;
    await f.manager.withLease(f.name, async () => f.manager.ensure(f.name, "v1", 10, (labels) => {
      assert.equal(JSON.parse(readFileSync(path, "utf8")).readyContainerId, undefined);
      preparations++; f.create(labels);
    }));
    assert.equal(preparations, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).readyContainerId, "prepared-new");
    await f.manager.withLease(f.name, async () => f.manager.ensure(f.name, "v1", 10, () => assert.fail("never reinitialize a used container")));
    // Matching immutable labels are insufficient if someone replaced its ID.
    f.setContainerId("out-of-band-replacement");
    await f.manager.withLease(f.name, async () => f.manager.ensure(f.name, "v1", 10, (labels) => { preparations++; f.create(labels); }));
    assert.equal(preparations, 2);
  } finally { f.close(); }
});
