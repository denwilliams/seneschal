import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { HarnessApp } from "./app.ts";
import { SessionPool, createThreadSession } from "../agent/session.ts";
import { ChannelRuntimes } from "../agent/channel-runtime.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { loadConfig } from "../config/load.ts";

/**
 * The config tools reach the admin channel through the app's OWN session options (`baseSessionOptions`), not through anything a
 * test hands over. This is the path a real message takes, so it is the one that has to work.
 */
async function offered(channelName: string) {
  const dir = mkdtempSync(join(tmpdir(), "wiring-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const configPath = join(dir, "harness.yaml");
  writeFileSync(configPath, `dataDir: ${dataDir}\nchannels:\n  ops:\n    admin: true\n    model: fixture/model\n    tools: [read]\n  school:\n    model: fixture/model\n    tools: [read]\n`);
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const loaded = loadConfig(configPath);
  const registry = new ChannelRegistry(dataDir);
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config: loaded.config, opts: { configPath, dataDir, modelRuntime, config: loaded.config }, registry, pool: new SessionPool(), runtimes, botUserId: "UBOT",
  }) as unknown as { baseSessionOptions(channel: unknown, config: unknown): Parameters<typeof createThreadSession>[0] };
  const channel = resolveChannel(loaded.config, dataDir, { id: `C-${channelName}`, name: channelName, isDm: false }, registry).channel!;
  const options = harness.baseSessionOptions(channel, loaded.config);
  const session = await createThreadSession({ ...options, threadKey: "1.1", threadTs: "1.1", initialUserId: "U1" });
  let names: string[] = [];
  faux.setResponses([((context: { messages: { role: string; toolsAdded?: { name: string }[] }[] }) => {
    names = [...new Set(context.messages.filter((m) => m.role === "system").flatMap((m) => (m.toolsAdded ?? []).map((x) => x.name)))];
    return fauxAssistantMessage("hi");
  }) as unknown as FauxResponseFactory]);
  await session.session.prompt("hello", { requestId: "r1", userId: "U1" });
  await session.dispose();
  await runtimes.closeAll();
  return { channel, names, hasService: Boolean((options as { adminConfig?: unknown }).adminConfig) };
}

test("through the app's own session options, the admin channel is offered the config tools", async () => {
  const ops = await offered("ops");
  assert.equal(ops.channel.admin, true);
  assert.equal(ops.hasService, true);
  assert.ok(ops.names.includes("admin_config_get") && ops.names.includes("admin_config_edit") && ops.names.includes("admin_config_request_approval"), `offered: ${ops.names.filter((n) => n.startsWith("admin_")).join(", ")}`);
});

test("and no other channel is, however it is configured", async () => {
  const school = await offered("school");
  assert.equal(school.channel.admin, false);
  assert.equal(school.hasService, false, "the app does not even hand them the service");
  assert.ok(!school.names.some((n) => n.startsWith("admin_config")), "no config tools");
});
