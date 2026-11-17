import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { HarnessApp } from "../slack/app.ts";
import { SessionPool, createThreadSession } from "./session.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { loadConfig } from "../config/load.ts";
import { createAdminConfigTools, type AdminConfigService } from "./admin-config-tools.ts";
import { ConfigEditError } from "../config/edit.ts";

const yaml = (dataDir: string) => `# The home harness. Edited by hand.
dataDir: ${dataDir}

# Connectors. Definitions only.
connectors:
  # gmail:
  #   transport: stdio

agentSets:
  team:
    agents:
      scout: { description: "Looks things up.", tools: [], model: fixture/model }

channels:
  # The admin channel.
  ops:
    admin: true       # the admin
    model: fixture/model
    tools: [read]

  "#engineering":   # the builders
    description: Build things   # keep this
    model: fixture/model
    tools: [read, write]   # no shell
`;

const systemMessages = (context: TranscriptContext) =>
  context.messages.filter((m) => m.role === "system") as unknown as { toolsAdded?: { name: string }[] }[];
const toolNames = (context: TranscriptContext): string[] =>
  [...new Set(systemMessages(context).flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name)))].sort();
const toolResults = (context: TranscriptContext): string[] =>
  context.messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m));

async function fixture(t: TestContext, options: { withService?: boolean; channelName?: string; transform?: (text: string) => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "admin-config-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const configPath = join(dir, "harness.yaml");
  writeFileSync(configPath, options.transform ? options.transform(yaml(dataDir)) : yaml(dataDir));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);

  // The app's real service and real reload, on a stand-in that has only what they use.
  const loaded = loadConfig(configPath);
  const registry = new ChannelRegistry(dataDir);
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config: loaded.config, opts: { configPath, dataDir, modelRuntime }, registry, pool: new SessionPool(),
    runtimes: { invalidateAll: async () => {}, invalidate: async () => {} },
  }) as { config: typeof loaded.config; adminConfigService(): AdminConfigService; pool: SessionPool };
  const service = harness.adminConfigService();

  const channelName = options.channelName ?? "ops";
  const channel = resolveChannel(loaded.config, dataDir, { id: "COPS", name: channelName, isDm: false }, registry).channel!;
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const session = await createThreadSession({
    channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#ops", botUserId: "UBOT",
    modelRuntime, runtimes, initialUserId: "U01ADMIN1",
    ...(options.withService === false ? {} : { adminConfig: service }),
  });
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); await harness.pool.disposeAll(); rmSync(dir, { recursive: true, force: true }); });
  const prompt = (text: string, id = "r1") => session.session.prompt(text, { requestId: id, userId: "U01ADMIN1" });
  return { faux, session, channel, prompt, harness, configPath, dataDir, text: () => readFileSync(configPath, "utf8"), original: options.transform ? options.transform(yaml(dataDir)) : yaml(dataDir) };
}

const call = (name: string, args: unknown, id: string) => fauxAssistantMessage(fauxToolCall(name, args as never, { id }), { stopReason: "toolUse" });

test("the admin agent adds a connector and gives it to a channel in one change: in place, reloaded, and told exactly what moved", async (t) => {
  const f = await fixture(t);
  let after: TranscriptContext | undefined;
  f.faux.setResponses([
    call("admin_config_edit", {
      reason: "Set up GitHub for engineering",
      edits: [
        { path: ["connectors", "github"], value: { transport: "http", url: "https://mcp.github.example/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } },
        { path: ["channels", "engineering", "share", "connectors"], value: ["github"] },
        { path: ["channels", "engineering", "model"], value: "fixture/other" },
      ],
    }, "c1"),
    ((context) => { after = context; return fauxAssistantMessage("Done."); }) as FauxResponseFactory,
  ]);
  await f.prompt("set up github for engineering");

  const text = f.text();
  for (const kept of ["# The home harness. Edited by hand.", "# Connectors. Definitions only.", "  # gmail:", "  #   transport: stdio", "# The admin channel.", "# the admin", "# the builders", "# keep this", "# no shell", '      scout: { description: "Looks things up.", tools: [], model: fixture/model }']) {
    assert.ok(text.includes(kept), `kept exactly: ${kept}`);
  }
  assert.match(text, /connectors:\n  github:\n    transport: http\n    url: https:\/\/mcp\.github\.example\/mcp\n    headers:\n      Authorization: Bearer \$\{GITHUB_TOKEN\}\n  # gmail:/);
  assert.match(text, /    share:\n      connectors: \[github\]\n/);
  assert.match(text, /    model: fixture\/other\n/);

  // The running harness picked it up (the real reload ran).
  assert.ok("github" in f.harness.config.connectors);
  assert.deepEqual(f.harness.config.channels["#engineering"]!.share.connectors, ["github"]);

  // What the agent is told: each path, before and after, and how to undo.
  const told = toolResults(after!).join("\n");
  assert.match(told, /Changed and reloaded \(backup: /);
  assert.match(told, /channels\.#engineering\.model: \\"fixture\/model\\" → \\"fixture\/other\\"/);
  assert.match(told, /connectors\.github: \(not set\) →/);
  assert.equal(readdirSync(join(f.dataDir, "config-backups")).length, 1);
});

test("a refused change comes back to the agent as an answer it can pass on, and the file is untouched", async (t) => {
  const f = await fixture(t);
  const seen: string[][] = [];
  f.faux.setResponses([
    call("admin_config_edit", { reason: "x", edits: [{ path: ["channels", "engineering", "envFile"], value: "/etc/passwd" }] }, "c1"),
    ((context) => { seen.push(toolResults(context)); return call("admin_config_edit", { reason: "x", edits: [{ path: ["channels", "ops", "tools"], value: ["read", "bash"] }] }, "c2"); }) as FauxResponseFactory,
    ((context) => { seen.push(toolResults(context)); return call("admin_config_edit", { reason: "x", edits: [{ path: ["connectors", "evil"], value: { transport: "stdio", command: "sh" } }] }, "c3"); }) as FauxResponseFactory,
    ((context) => { seen.push(toolResults(context)); return call("admin_config_edit", { reason: "x", edits: [{ path: ["channels", "engineering", "model"], value: "ghost/model" }] }, "c4"); }) as FauxResponseFactory,
    ((context) => { seen.push(toolResults(context)); return fauxAssistantMessage("I could not."); }) as FauxResponseFactory,
  ]);
  await f.prompt("do some things you should not");
  const last = seen.at(-1)!.join("\n");
  assert.match(last, /envFile\\" points a channel at a file of secrets[\s\S]*edited on the host/);
  assert.match(last, /is the admin channel[\s\S]*edited on the host/, "its own channel is protected");
  assert.match(last, /only `transport: http`[\s\S]*runs a command on the host/);
  assert.match(last, /No model called \\"ghost\/model\\" is available here/);
  assert.equal(f.text(), f.original, "nothing was written");
  assert.equal(readdirSync(f.dataDir).filter((n) => n === "config-backups").length, 0);
});

test("a config the running harness will not load is put back, and the agent is told", async (t) => {
  const f = await fixture(t);
  // A model that resolves but a config the reload then rejects for a reason only the reload sees: a missing channel directory
  // is not one, so make the reload itself refuse.
  const real = (f.harness as unknown as { reloadConfig: () => Promise<unknown> }).reloadConfig;
  (f.harness as unknown as { reloadConfig: () => Promise<unknown> }).reloadConfig = async () => ({ applied: false, error: "simulated load failure", configPath: f.configPath, warnings: [] });
  void real;
  let after: TranscriptContext | undefined;
  f.faux.setResponses([
    call("admin_config_edit", { reason: "x", edits: [{ path: ["channels", "engineering", "description"], value: "Changed" }] }, "c1"),
    ((context) => { after = context; return fauxAssistantMessage("It failed."); }) as FauxResponseFactory,
  ]);
  await f.prompt("change it");
  assert.equal(f.text(), f.original, "the previous file is back");
  assert.match(toolResults(after!).join("\n"), /would not load the new config \(simulated load failure\)[\s\S]*previous file has been put back/);
});

test("reading shows the config, with the channel named however the person said it", async (t) => {
  const f = await fixture(t);
  let after: TranscriptContext | undefined;
  f.faux.setResponses([
    call("admin_config_get", { path: ["channels", "engineering"] }, "c1"),
    ((context) => { after = context; return fauxAssistantMessage("ok"); }) as FauxResponseFactory,
  ]);
  await f.prompt("what does engineering have");
  const told = toolResults(after!).join("\n");
  assert.match(told, /channels\.#engineering/);
  assert.match(told, /Build things/);
});

test("only the admin channel gets the config tools, and only when the harness supplies the service", async (t) => {
  const withService = await fixture(t);
  let names: string[] = [];
  withService.faux.setResponses([((context) => { names = toolNames(context); return fauxAssistantMessage("hi"); }) as FauxResponseFactory]);
  await withService.prompt("hello");
  assert.ok(names.includes("admin_config_get") && names.includes("admin_config_edit"));

  const noService = await fixture(t, { withService: false });
  noService.faux.setResponses([((context) => { names = toolNames(context); return fauxAssistantMessage("hi"); }) as FauxResponseFactory]);
  await noService.prompt("hello");
  assert.ok(!names.includes("admin_config_get") && !names.includes("admin_config_edit"), "no service, no tools");

  // A channel that is not the admin channel, even when handed the service.
  const other = await fixture(t, { channelName: "#engineering" });
  assert.equal(other.channel.admin, false);
  other.faux.setResponses([((context) => { names = toolNames(context); return fauxAssistantMessage("hi"); }) as FauxResponseFactory]);
  await other.prompt("hello");
  assert.ok(!names.includes("admin_config_get") && !names.includes("admin_config_edit"), "not the admin channel, no tools");
});

test("a subagent of the admin channel never has them", async (t) => {
  // The admin channel needs a team for this.
  const f = await fixture(t, { transform: (text) => text.replace("    admin: true       # the admin\n", "    admin: true       # the admin\n    agentSet: team\n") });
  assert.ok(f.channel.admin && f.channel.agents.length === 1);
  let parent: string[] = [];
  let child: string[] = [];
  f.faux.setResponses([
    ((context) => { parent = toolNames(context); return call("run_subagent", { agent: "scout", task: "look" }, "s1"); }) as FauxResponseFactory,
    ((context) => { child = toolNames(context); return fauxAssistantMessage("STATUS: done\nNEXT: none\nok"); }) as FauxResponseFactory,
    fauxAssistantMessage("done"),
  ]);
  await f.prompt("go");
  assert.ok(parent.includes("admin_config_edit"), "the admin agent has it");
  assert.ok(!child.includes("admin_config_edit") && !child.includes("admin_config_get"), "its subagent does not");
});

test("the tools report a refusal as an error result and let anything unexpected through", async () => {
  const refusing: AdminConfigService = {
    read: (path) => ({ path: path.join("."), found: false }),
    edit: async () => { throw new ConfigEditError("Nothing was changed.\n- no"); },
    propose: async () => { throw new ConfigEditError("Nothing was changed.\n- no"); },
  };
  const [get, edit, ask] = createAdminConfigTools({ service: refusing, channelId: "C", channelKey: "ops", currentUserId: () => "U01", approvers: () => ["U01"] });
  const refused = await edit!.execute("id", { edits: [{ path: ["name"], value: "x" }], reason: "r" } as never, undefined, undefined, {} as never);
  assert.equal((refused as { isError?: boolean }).isError, true);
  assert.match((refused.content[0] as { text: string }).text, /Nothing was changed/);
  const broken = createAdminConfigTools({ service: { ...refusing, edit: async () => { throw new Error("disk exploded"); } }, channelId: "C", channelKey: "ops", currentUserId: () => "U01", approvers: () => ["U01"] })[1]!;
  await assert.rejects(broken.execute("id", { edits: [{ path: ["name"], value: "x" }], reason: "r" } as never, undefined, undefined, {} as never), /disk exploded/);
  const noOne = createAdminConfigTools({ service: refusing, channelId: "C", channelKey: "ops", currentUserId: () => "U01", approvers: () => [] })[2]!;
  const nobody = await noOne.execute("id", { edits: [{ path: ["channels", "x", "sandbox"], value: {} }], reason: "r" } as never, undefined, undefined, {} as never);
  assert.match((nobody.content[0] as { text: string }).text, /Nobody is set up to approve/);
  const asked = await ask!.execute("id", { edits: [{ path: ["channels", "x", "sandbox"], value: {} }], reason: "r" } as never, undefined, undefined, {} as never);
  assert.equal((asked as { isError?: boolean }).isError, true);
  const missing = await get!.execute("id", { path: ["nope"] } as never, undefined, undefined, {} as never);
  assert.match((missing.content[0] as { text: string }).text, /Nothing is set at nope/);
});
