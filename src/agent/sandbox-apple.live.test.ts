import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectAppleImage } from "./sandbox-apple.ts";
import { SandboxSchema } from "../config/schema.ts";
import { containerBackendAvailable, containerNameFor, createContainerBashOperations, ensureChannelImage, stopAllSandboxes } from "./sandbox.ts";

// Opt-in: needs a real native Mac and package-download access for the build.
test("Apple-host sandbox smoke: mounts, isolation, reuse, one-shots and cancellation", {
  skip: process.env.HARNESS_TEST_APPLE_CONTAINER !== "1", timeout: 1_000_000,
}, async (t) => {
  assert.ok(containerBackendAvailable("macos-container"), "native macOS 26+/Apple Silicon and running container 1.6.1+ (1.x) required");
  const data = mkdtempSync(join(tmpdir(), "harness-apple-live-"));
  const workspace = join(data, "channels/C1/workspace"), skills = join(data, "channels/C1/skills");
  mkdirSync(workspace, { recursive: true }); mkdirSync(skills, { recursive: true }); chmodSync(skills, 0o777);
  const channelId = `live-${randomUUID()}`, threadKey = "smoke";
  const name = containerNameFor(channelId, threadKey, "macos-container"), image = `harness-apple-live-${randomUUID()}:latest`;
  const file = join(data, "channels/C1/Dockerfile");
  writeFileSync(file, "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends bash util-linux && mkdir -m 1777 /repos && rm -rf /var/lib/apt/lists/*\n");
  const cli = (args: string[]) => execFileSync("container", args, { encoding: "utf8", timeout: 60_000 });
  t.after(() => {
    stopAllSandboxes();
    try { cli(["stop", "--time", "0", name]); } catch { /* may already be stopped */ }
    try { cli(["delete", name]); } finally {
      try { cli(["image", "delete", inspectAppleImage(image).reference]); } catch { /* alias may not have been created */ }
      try { cli(["image", "delete", image]); } finally { rmSync(data, { recursive: true, force: true }); }
    }
  });
  ensureChannelImage(file, workspace, image, "macos-container");
  const config = SandboxSchema.parse({ mode: "macos-container", image, readOnlyRoot: true, pidsLimit: null, user: "0", memory: "1g" });
  const opts = { config, workspace, dataDir: data, channelId, threadKey, env: { APPLE_SMOKE_SECRET: "name-only-test" },
    mounts: [{ hostPath: skills, containerPath: "/skills/channel", readOnly: true }] };
  const operations = createContainerBashOperations(opts);
  const run = async (command: string) => {
    let output = ""; const result = await operations.exec(command, workspace, { onData: (d) => { output += d.toString(); } });
    assert.equal(result.exitCode, 0, output); return output;
  };
  await run(`set -eu
[ "$APPLE_SMOKE_SECRET" = name-only-test ]
grep -q '^NoNewPrivs:.*1' /proc/self/status
grep -q '^CapBnd:.*0000000000000000' /proc/self/status
! touch /etc/harness-smoke
! touch /skills/channel/forbidden
for net in /sys/class/net/*; do [ "\${net##*/}" = lo ]; done
printf durable > /workspace/result
printf reused > /repos/result`);
  assert.equal(readFileSync(join(workspace, "result"), "utf8"), "durable");
  assert.equal(existsSync(join(workspace, "repos/result")), false);
  assert.match(await run("cat /repos/result"), /reused/);
  const oneShot = createContainerBashOperations({ ...opts, config: { ...config, reuse: false } });
  let output = "";
  assert.equal((await oneShot.exec("echo oneshot", workspace, { onData: (d) => { output += d.toString(); } })).exitCode, 0, output);
  assert.match(output, /oneshot/);
  const records = readdirSync(join(data, "sandboxes/macos-container")).filter((p) => p.endsWith(".json"));
  assert.deepEqual(records, [`${name}.json`], "one-shot activity removed after stopping/deleting descendants");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    assert.equal((await operations.exec("sleep 600 & wait", workspace, { signal: controller.signal, onData: () => {} })).exitCode, 137);
  } finally { clearTimeout(timer); }
  const info = JSON.parse(cli(["inspect", name])) as { status: { state: string } }[];
  assert.equal(info[0]!.status.state, "stopped", "cancellation stops the VM, not just the client");
  await run("test ! -e /repos/result"); // restart recreates tmpfs
});
