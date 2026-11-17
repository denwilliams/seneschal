import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { HarnessConfigSchema } from "../config/schema.ts";
import { loadConfig } from "../config/load.ts";
import { configRevision, type OperatorConfig } from "../config/operator.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { narrowChannelForAgent } from "../workspace/subagents.ts";
import { HarnessApp } from "../slack/app.ts";
import { appSubagentHost } from "../slack/factory-wiring.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { buildThreadToolSet, createThreadSession, runtimeTemplate, SessionPool } from "./session.ts";
import { createConfiguratorTools } from "./configurator-tools.ts";

const names = (ctx: TranscriptContext) => [...new Set(ctx.messages.filter((m) => m.role === "system")
  .flatMap((m) => ((m as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((t) => t.name)))].sort();
const call = (name: string, args: object, id: string) => fauxAssistantMessage(fauxToolCall(name, args as never, { id }), { stopReason: "toolUse" });

async function fixture(t: TestContext, configurators: object = {}, withService = true) {
  const dir = mkdtempSync(join(tmpdir(), "configurator-agent-"));
  const configPath = join(dir, "harness.yaml");
  const raw = { dataDir: dir, agentSets: { team: { agents: { scout: { description: "Ordinary worker" } } } },
    channels: { eng: { model: "fixture/model", tools: [], agentSet: "team", configurators }, other: { description: "Other channel" } } };
  writeFileSync(configPath, stringifyYaml(raw));
  const loaded = loadConfig(configPath);
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const registry = new ChannelRegistry(dir);
  const pool = new SessionPool();
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config: loaded.config, opts: { configPath, dataDir: dir }, registry, pool,
    runtimes: { channelIds: () => [], invalidateAll: async () => {}, invalidate: async () => {} },
  }) as HarnessApp & { config: typeof loaded.config; configuratorConfig(): OperatorConfig };
  const channel = resolveChannel(loaded.config, dir, { id: "C1", name: "eng", isDm: false }, registry).channel!;
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const configuratorConfig = withService ? (harness as unknown as { configuratorConfig(): OperatorConfig }).configuratorConfig() : undefined;
  const opts = { channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#eng", botUserId: "UBOT", modelRuntime, runtimes, ...(configuratorConfig ? { configuratorConfig } : {}) };
  const session = await createThreadSession(opts);
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); await pool.disposeAll(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, configPath, faux, session, opts, channel, configuratorConfig, harness: harness as unknown as { config: typeof loaded.config },
    prompt: () => session.session.prompt("Configure it", { requestId: "r1", userId: "U1" }) };
}

test("both built-ins are independently opt-in per channel without an agent set, and cannot be shadowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "configurator-enable-"));
  try {
    for (const enabled of [{}, { channel: true }, { harness: true }, { channel: true, harness: true }]) {
      const config = HarnessConfigSchema.parse({ channels: { eng: { configurators: enabled }, other: {} } });
      const registry = new ChannelRegistry(dir);
      const channel = resolveChannel(config, dir, { id: "C1", name: "eng", isDm: false }, registry).channel!;
      assert.deepEqual(channel.agents.map((a) => a.name), [...("channel" in enabled ? ["channelConfigurator"] : []), ...("harness" in enabled ? ["harnessConfigurator"] : [])]);
      assert.deepEqual(resolveChannel(config, dir, { id: "C2", name: "other", isDm: false }, registry).channel!.agents, []);
      for (const role of channel.agents) {
        const narrowed = narrowChannelForAgent(channel, role);
        assert.deepEqual(narrowed.tools, []);
        assert.deepEqual(narrowed.connectors, []);
        assert.equal(narrowed.admin, false);
        assert.deepEqual(narrowed.agents, []);
      }
    }
    for (const role of ["channelConfigurator", "harnessConfigurator"]) assert.equal(HarnessConfigSchema.safeParse({ agentSets: { team: { agents: { [role]: { description: "Fake role", tools: ["bash"] } } } } }).success, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const scope of ["channel", "harness"] as const) test(scope + " configurator invokes through run_subagent with private tools and automatically reloads", async (t) => {
  const f = await fixture(t, { [scope]: true });
  const agent = scope === "channel" ? "channelConfigurator" : "harnessConfigurator";
  const revision = configRevision(readFileSync(f.configPath, "utf8"));
  const edits = [{ path: ["channels", scope === "channel" ? "eng" : "other", "description"], value: "Updated live" },
    ...(scope === "harness" ? [{ path: ["webConsole", "port"], value: 3210 }] : [])];
  let parent: TranscriptContext | undefined;
  let child: TranscriptContext | undefined;
  let after: TranscriptContext | undefined;
  f.faux.setResponses([
    (ctx) => { parent = ctx; return call("run_subagent", { agent, task: "Update the description" }, "run"); },
    (ctx) => { child = ctx; return call("config_get", {}, "get"); },
    () => call("config_validate", { edits, revision }, "validate"),
    () => call("config_save", { edits, revision }, "save"),
    (ctx) => { after = ctx; return fauxAssistantMessage("STATUS: done\nNEXT: none\nConfiguration saved."); },
    () => fauxAssistantMessage("Configured."),
  ]);
  await f.prompt();
  assert.equal(f.session.session.getLastAssistantText(), "Configured.");
  assert.ok(names(parent!).includes("run_subagent"));
  assert.ok(!names(parent!).some((name) => name.startsWith("config_")));
  assert.deepEqual(names(child!).filter((name) => name.startsWith("config_")), ["config_backup", "config_get", "config_save", "config_validate"]);
  assert.ok(!names(child!).some((name) => ["bash", "read", "write", "exec", "run_subagent", "admin_config_edit"].includes(name)));
  const result = JSON.stringify(after!.messages.filter((m) => m.role === "toolResult"));
  assert.match(result, /saved/);
  assert.match(result, /applied/);
  assert.equal(f.harness.config.channels[scope === "channel" ? "eng" : "other"]!.description, "Updated live");
  if (scope === "harness") assert.match(result, /restart to rebind the web server/);
});

test("an unenabled configurator cannot be invoked, and enabling a role without host hooks never grants tools", async (t) => {
  const f = await fixture(t, { channel: true });
  let after: TranscriptContext | undefined;
  f.faux.setResponses([
    () => call("run_subagent", { agent: "harnessConfigurator", task: "Grant admin" }, "denied"),
    (ctx) => { after = ctx; return fauxAssistantMessage("Denied."); },
  ]);
  await f.prompt();
  assert.equal(f.faux.state.callCount, 2);
  assert.match(JSON.stringify(after!.messages.filter((m) => m.role === "toolResult")), /There is no subagent/);
  const missing = await fixture(t, { channel: true }, false);
  let child: TranscriptContext | undefined;
  missing.faux.setResponses([
    () => call("run_subagent", { agent: "channelConfigurator", task: "Update description" }, "run"),
    (ctx) => { child = ctx; return fauxAssistantMessage("STATUS: blocked\nNEXT: none\nNo configuration tools."); },
    () => fauxAssistantMessage("Unavailable."),
  ]);
  await missing.prompt();
  assert.ok(!names(child!).some((name) => name.startsWith("config_")));
});

test("configuration schemas are registered but not executable by parents or ordinary roles; missing service fails closed", async (t) => {
  const f = await fixture(t, { channel: true });
  const control = { current: () => undefined, set: async () => {} };
  const parent = await buildThreadToolSet(f.opts, control);
  t.after(() => parent.dispose());
  const template = runtimeTemplate(f.opts, parent);
  assert.ok(template.tools.some((tool) => tool.name === "config_save"));
  assert.ok(!parent.tools.some((tool) => tool.name === "config_save"));
  const scout = f.channel.agents.find((a) => a.name === "scout")!;
  const ordinary = await buildThreadToolSet({ ...f.opts, channel: narrowChannelForAgent(f.channel, scout), role: "subagent" }, control);
  t.after(() => ordinary.dispose());
  assert.ok(!ordinary.tools.some((tool) => tool.name.startsWith("config_")));
  const result = await (createConfiguratorTools().find((tool) => tool.name === "config_get")! as any).execute("bad", {});
  assert.equal(result.isError, true);
  const host = appSubagentHost({ harnessName: () => "Test", botUserId: () => "UBOT", defaultTimezone: () => "UTC", onSubagentMessage: () => undefined, configuratorConfig: () => f.configuratorConfig! });
  assert.equal(host.parent(f.channel, "headless").configuratorConfig, f.configuratorConfig);
});
