import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HarnessConfigSchema } from "../config/schema.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { createThreadSession } from "./session.ts";
import { kiriUnavailableReason } from "./sandbox-kiri.ts";
import { containerNameFor, createContainerBashOperations, ensureChannelImage, startSandboxCleanup, stopAllSandboxes } from "./sandbox.ts";

// Real runtime, faux model: no Slack/model credentials or host-execution fallback.
test("live Kiri: main/factory bash, isolation, reuse, start/stop and one-shot removal", {
  skip: process.env.HARNESS_TEST_KIRI !== "1", timeout: 1_000_000,
}, async () => {
  assert.equal(kiriUnavailableReason(), undefined);
  const data = mkdtempSync(join(tmpdir(), "harness-kiri-live-")), id = `live-${randomUUID()}`;
  const image = `harness-kiri-live-${randomUUID()}:latest`, thread = "123.456", name = containerNameFor(id, thread, "kiri");
  const cli = (args: string[]) => execFileSync("kiri", args, { encoding: "utf8", timeout: 60_000 });
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(data, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({
    agentSets: { factory: { agents: { coder: { description: "Smoke-test the configured shell", tools: ["bash"], model: "fixture/model" } } } },
    channels: { smoke: { model: "fixture/model", tools: ["bash"], agentSet: "factory", sandbox: { mode: "kiri", image, network: "none", user: "0" } } },
  });
  const channel = resolveChannel(config, data, { id, name: "smoke", isDm: false }, new ChannelRegistry(data)).channel!;
  channel.env = { ...channel.env, KIRI_SMOKE_SECRET: "dummy-secret" };
  const file = join(data, "Smoke.Dockerfile");
  writeFileSync(file, "FROM debian:bookworm-slim\nRUN mkdir -m 1777 /repos\n");
  const runtimes = new ChannelRuntimes({ modelRuntime });
  startSandboxCleanup(data);
  try {
    ensureChannelImage(file, channel.paths.workspace, image, "kiri");
    const session = await createThreadSession({ channel, threadKey: thread, harnessName: "Smoke", slackChannelLabel: "#smoke", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1" });
    try {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: `set -eu
[ "$KIRI_SMOKE_SECRET" = dummy-secret ]
grep -q '^NoNewPrivs:.*1' /proc/self/status
grep -q '^CapBnd:.*0000000000000000' /proc/self/status
[ ! -e /workspace/../auth.json ]
for net in /sys/class/net/*; do [ "${"${net##*/}"}" = lo ]; done
printf main > /workspace/main-result
printf reused > /repos/reused` }, { id: "main" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "Smoke test" }, { id: "delegate" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("bash", { command: "set -eu; test \"$(cat /repos/reused)\" = reused; printf factory > /workspace/factory-result" }, { id: "factory" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("STATUS: done\nNEXT: none\nSmoke completed"), fauxAssistantMessage("Smoke completed"),
      ]);
      await session.session.prompt("Exercise both shells", { requestId: "live-kiri", userId: "U1" });
      assert.equal(readFileSync(join(channel.paths.workspace, "main-result"), "utf8"), "main");
      assert.equal(readFileSync(join(channel.paths.workspace, "factory-result"), "utf8"), "factory");
      assert.equal(existsSync(join(channel.paths.workspace, "repos/reused")), false);
    } finally { await session.dispose(); }
    const opts = { config: channel.sandbox, dataDir: data, workspace: channel.paths.workspace, channelId: id, threadKey: thread, env: channel.env };
    const ops = createContainerBashOperations(opts);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
    try { assert.equal((await ops.exec("sleep 600 & wait", opts.workspace, { signal: controller.signal, onData: () => {} })).exitCode, 137); }
    finally { clearTimeout(timer); }
    assert.equal(JSON.parse(cli(["inspect", name]))[0].State.Running, false);
    let output = "";
    assert.equal((await ops.exec("cat /repos/reused", opts.workspace, { onData: (d) => { output += d.toString(); } })).exitCode, 0, output);
    assert.match(output, /reused/, "writable container layer survives stop/start");
    const once = createContainerBashOperations({ ...opts, config: { ...opts.config, reuse: false } });
    assert.equal((await once.exec("true", opts.workspace, { onData: () => {} })).exitCode, 0);
    const remaining = cli(["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"]);
    assert.deepEqual(remaining.trim().split("\n"), [name], "one-shot was removed");
  } finally {
    await runtimes.closeAll(); stopAllSandboxes();
    try { cli(["stop", "--time", "0", name]); } catch { /* not created */ }
    try { cli(["rm", name]); } catch { /* not created */ }
    try { cli(["image", "rm", image]); } finally { rmSync(data, { recursive: true, force: true }); }
  }
});
