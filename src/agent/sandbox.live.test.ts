import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxSchema } from "../config/schema.ts";
import { buildRunArgs, dockerAvailable, sandboxImageExists, createDockerBashOperations, containerNameFor, stopAllSandboxes, startSandboxCleanup } from "./sandbox.ts";

import { SandboxLifecycle } from "./sandbox-lifecycle.ts";

const image = process.env.HARNESS_SANDBOX_TEST_IMAGE ?? "seneschal-sandbox:latest";
const liveDocker = dockerAvailable() && sandboxImageExists(image);

test("a real sandbox has a writable host workspace and no extra mounts", { skip: !liveDocker }, () => {
  const root = mkdtempSync(join(tmpdir(), "harness-sandbox-"));
  const dataDir = join(root, "data");
  const workspace = join(dataDir, "channels", "C-live", "workspace");
  mkdirSync(workspace, { recursive: true });
  // The image runs as uid 1000. This is the same contract as a Docker Compose
  // deployment where `/app/data` is writable by the unprivileged service user.
  chmodSync(workspace, 0o777);

  try {
    const args = buildRunArgs(
      {
        config: SandboxSchema.parse({ mode: "docker", image }),
        workspace,
        dataDir,
        dockerDataDir: dataDir,
        env: {},
        channelId: `live-${process.pid}`,
        threadKey: "mount",
      },
      `harness-live-${process.pid}`,
      "printf mounted-and-writable > mount-probe.txt",
    );
    execFileSync("docker", args, { stdio: "pipe", timeout: 30_000 });
    assert.equal(readFileSync(join(workspace, "mount-probe.txt"), "utf8"), "mounted-and-writable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("real Docker thread lifecycle: repos/restart/timeout/cancel/config/GC/one-shot", { skip: !liveDocker }, async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-thread-live-"));
  const dataDir = join(root, "data");
  const workspace = join(dataDir, "channels/C-live/workspace");
  mkdirSync(workspace, { recursive: true }); chmodSync(workspace, 0o777);
  const channelId = `test-${process.pid}`;
  const threadKey = `${Date.now()}.live`;
  const name = containerNameFor(channelId, threadKey);
  const sibling = containerNameFor(channelId, `${threadKey}-other`);
  const readonly = containerNameFor(channelId, `${threadKey}-readonly`);
  const changedImage = `harness-thread-test-changed:${process.pid}`;
  const volumeImage = `harness-thread-test-volume:${process.pid}`;
  const opts = { config: SandboxSchema.parse({ mode: "docker", image, idleSeconds: 1 }),
    workspace, dataDir, dockerDataDir: dataDir, env: {}, channelId, threadKey };
  const run = async (command: string, config = opts.config, signal?: AbortSignal, key = threadKey) => {
    let output = "";
    const result = await createDockerBashOperations({ ...opts, config, threadKey: key }).exec(command, workspace,
      { onData: (d) => { output += d.toString(); }, ...(signal ? { signal } : {}) });
    return { ...result, output };
  };
  const inspect = (container = name) => JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0];
  try {
    let result = await run("git init -q /tmp/source && git -C /tmp/source -c user.name=test -c user.email=test@example.test commit -q --allow-empty -m seed && git clone -q /tmp/source /repos/clone && echo durable > /workspace/output && echo clone-state > /repos/clone/state");
    assert.equal(result.exitCode, 0, result.output);
    let overrideOutput = "";
    const override = await createDockerBashOperations(opts).exec("sleep 0.1; echo seconds", workspace,
      { timeout: 1, onData: (d) => { overrideOutput += d; } });
    assert.equal(override.exitCode, 0, overrideOutput); assert.match(overrideOutput, /seconds/);
    const firstId = inspect().Id;
    const mounts = inspect().Mounts;
    assert.deepEqual(mounts.map((m: { Destination: string }) => m.Destination), ["/workspace"]);
    assert.equal(existsInWorkspace(), false);

    // Normal harness shutdown does not remove a persistent container; another
    // process (with a newly loaded manager) adopts exactly the same container.
    stopAllSandboxes();
    const script = `import {createDockerBashOperations,stopAllSandboxes} from ${JSON.stringify(new URL("./sandbox.ts", import.meta.url).href)}; const opts=${JSON.stringify(opts)}; const r=await createDockerBashOperations(opts).exec("cat /repos/clone/state", opts.workspace, {onData:d=>process.stdout.write(d)}); stopAllSandboxes(); if(r.exitCode!==0) process.exit(1);`;
    const resumed = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
    assert.match(resumed, /clone-state/); assert.equal(inspect().Id, firstId);
    startSandboxCleanup(dataDir);
    result = await run("test ! -e /repos/clone", opts.config, undefined, `${threadKey}-other`);
    assert.equal(result.exitCode, 0, result.output); assert.notEqual(inspect(sibling).Id, firstId);

    result = await run("(sleep 2; echo leaked > /workspace/leaked) & wait", { ...opts.config, timeoutSeconds: 1 });
    assert.equal(result.exitCode, 137, result.output); assert.equal(inspect().State.Running, false);
    result = await run("cat /repos/clone/state"); assert.equal(result.exitCode, 0, result.output);
    const controller = new AbortController();
    const cancelled = run("sleep 100 & wait", opts.config, controller.signal);
    setTimeout(() => controller.abort(), 500);
    assert.equal((await cancelled).exitCode, 137); assert.equal(inspect().State.Running, false);
    // A real stopped container restarts with its same writable layer.
    result = await run("test -e /repos/clone/state"); assert.equal(result.exitCode, 0, result.output);
    assert.equal(inspect().Id, firstId);

    result = await run("sleep 100 >/dev/null 2>&1 &"); assert.equal(result.exitCode, 0, result.output);
    const future = new SandboxLifecycle(dataDir, undefined, () => Date.now() + 100_000);
    await future.sweep(); assert.equal(inspect().Id, firstId, "background service prevents cleanup");
    result = await run("true", { ...opts.config, memory: "256m" });
    assert.equal(result.exitCode, 127); assert.match(result.output, /active processes/);
    future.cancel(name);
    result = await run("test ! -e /repos/clone", { ...opts.config, memory: "256m" });
    assert.equal(result.exitCode, 0, result.output); assert.notEqual(inspect().Id, firstId);

    const beforeImageChange = inspect().Id;
    execFileSync("docker", ["commit", "--change", "LABEL lifecycle-test=changed", name, changedImage], { stdio: "pipe" });
    result = await run("true", { ...opts.config, memory: "256m", image: changedImage });
    assert.equal(result.exitCode, 0, result.output); assert.notEqual(inspect().Id, beforeImageChange);
    execFileSync("docker", ["commit", "--change", "VOLUME /repos", name, volumeImage], { stdio: "pipe" });
    const beforeVolume = inspect().Id;
    result = await run("true", { ...opts.config, image: volumeImage });
    assert.equal(result.exitCode, 127); assert.match(result.output, /must not declare VOLUME/);
    assert.equal(inspect().Id, beforeVolume, "rejected images do not touch the existing container");

    result = await run("echo tmpfs > /repos/state", { ...opts.config, readOnlyRoot: true }, undefined, `${threadKey}-readonly`);
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(inspect(readonly).HostConfig.ReadonlyRootfs, true);
    result = await run("echo one-shot > /repos/state", { ...opts.config, reuse: false }); assert.equal(result.exitCode, 0, result.output);
    result = await run("test ! -e /repos/state", { ...opts.config, reuse: false }); assert.equal(result.exitCode, 0, result.output);
    result = await run("sleep 100", { ...opts.config, reuse: false, timeoutSeconds: 1 }); assert.equal(result.exitCode, 137);
    // No delayed descendant writes survived either timeout or cancellation.
    assert.equal(existsSync(join(workspace, "leaked")), false);
    await future.sweep();
    assert.throws(() => inspect(), /No such object/i);
    assert.equal(readFileSync(join(workspace, "output"), "utf8").trim(), "durable");
  } finally {
    stopAllSandboxes();
    for (const container of [name, sibling, readonly]) {
      try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch { /* gone */ }
    }
    for (const tag of [changedImage, volumeImage]) {
      try { execFileSync("docker", ["image", "rm", tag], { stdio: "ignore" }); } catch { /* never built */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
  function existsInWorkspace() { return existsSync(join(workspace, "clone")); }
});
