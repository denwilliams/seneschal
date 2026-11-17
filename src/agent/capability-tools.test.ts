import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { loadConfig } from "../config/load.ts";
import type { CapabilityRequests } from "../config/capability-requests.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { HarnessApp } from "../slack/app.ts";
import { decideCapabilityRequest } from "../slack/capability-requests.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { buildThreadToolSet, createThreadSession, SessionPool } from "./session.ts";

const names = (ctx: TranscriptContext) => [...new Set(ctx.messages.filter((m) => m.role === "system")
  .flatMap((m) => ((m as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((t) => t.name)))];
const call = (name: string, args: object, id: string) => fauxAssistantMessage(fauxToolCall(name, args as never, { id }), { stopReason: "toolUse" });

test("live channel tools route through Slack, verify human identity, and hand approved edits to the real harnessConfigurator runner", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "capability-agent-"));
  const configPath = join(dir, "harness.yaml");
  writeFileSync(configPath, stringify({ dataDir: dir, cliTools: { report: { command: "/reviewed/report", description: "Reporting CLI" } },
    agentSets: { team: { agents: { scout: { description: "Ordinary role" } } } },
    channels: { COPS: { admin: true, model: "fixture/model", tools: [], allowUsers: ["UHUMAN", "UBOT", "UAUTOBOT", "UAPP", "UDELETED"], configurators: { channel: true, harness: true }, agentSet: "team" }, CTEAM: { model: "fixture/model", tools: [] } } }));
  const loaded = loadConfig(configPath);
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const registry = new ChannelRegistry(dir), pool = new SessionPool();
  const posts: any[] = [], updates: any[] = [], ephemeral: any[] = [], lookups: string[] = [];
  const client = {
    chat: { postMessage: async (p: any) => { posts.push(p); return { ts: String(posts.length) }; }, update: async (p: any) => { updates.push(p); }, postEphemeral: async (p: any) => { ephemeral.push(p); } },
    users: { info: async ({ user }: { user: string }) => { lookups.push(user); return { user: { id: user, is_bot: user === "UBOT" || user === "UAUTOBOT", is_app_user: user === "UAPP", deleted: user === "UDELETED" } }; } },
  };
  let reloads = 0;
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config: loaded.config, opts: { configPath, dataDir: dir, modelRuntime }, registry, pool, runtimes, botUserId: "UBOT", app: { client },
    reloadConfig: async () => { reloads++; return { applied: true, warnings: [] }; },
  }) as unknown as { capabilityService(): CapabilityRequests; baseSessionOptions(channel: unknown, config: unknown): any };
  const service = harness.capabilityService();
  const source = resolveChannel(loaded.config, dir, { id: "CTEAM", isDm: false }, registry).channel!;
  const admin = resolveChannel(loaded.config, dir, { id: "COPS", isDm: false }, registry).channel!;
  const sourceOpts = { ...harness.baseSessionOptions(source, loaded.config), threadKey: "1.1" };
  assert.equal(sourceOpts.capabilityRequests, service, "live host wiring supplies the service");
  const sourceSession = await createThreadSession(sourceOpts);
  const adminOpts = { ...harness.baseSessionOptions(admin, loaded.config), threadKey: "2.2" };
  const adminSession = await createThreadSession(adminOpts);
  t.after(async () => { await sourceSession.dispose(); await adminSession.dispose(); await runtimes.closeAll(); await pool.disposeAll(); rmSync(dir, { recursive: true, force: true }); });
  let sourceContext: TranscriptContext | undefined;
  faux.setResponses([
    (ctx) => { sourceContext = ctx; return call("search_capabilities", { query: "report" }, "search"); },
    () => call("request_enable_capability", { kind: "cli", name: "report", reason: "Need reporting" }, "request"),
    () => fauxAssistantMessage("Requested; waiting for admin approval."),
  ]);
  await sourceSession.session.prompt("Request reporting", { requestId: "source", userId: "UREQUESTER" });
  assert.ok(names(sourceContext!).includes("search_capabilities"));
  assert.ok(!names(sourceContext!).includes("config_capability_request"));
  assert.equal(posts.length, 1); assert.equal(posts[0].channel, "COPS");
  assert.match(JSON.stringify(posts[0].blocks), /CTEAM/);
  assert.ok(!loadConfig(configPath).config.channels.CTEAM!.tools!.includes("exec"));
  const id = posts[0].blocks.at(-1).elements[0].value;
  const click = (user: string) => decideCapabilityRequest(service, client as never, { channel: { id: "COPS" }, user: { id: user }, message: { ts: "1" }, actions: [{ action_id: "harness_capability_approve", value: id }] });
  for (const user of ["UBOT", "UAUTOBOT", "UAPP", "UDELETED"]) { await click(user); assert.match(ephemeral.at(-1).text, /human/); }
  await click("UHUMAN"); assert.deepEqual(lookups, ["UAUTOBOT", "UAPP", "UDELETED", "UHUMAN"]);
  assert.equal(updates.length, 1); assert.match(JSON.stringify(updates[0]), /action apply/);
  assert.equal(reloads, 0);
  let parent: TranscriptContext | undefined, child: TranscriptContext | undefined, after: TranscriptContext | undefined;
  faux.setResponses([
    (ctx) => { parent = ctx; return call("run_subagent", { agent: "harnessConfigurator", task: `Apply approved capability request ${id} using config_capability_request.` }, "run"); },
    (ctx) => { child = ctx; return call("config_capability_request", { id, action: "apply" }, "apply"); },
    (ctx) => { after = ctx; return fauxAssistantMessage("STATUS: done\nNEXT: none\nApproved capability applied."); },
    () => fauxAssistantMessage("Applied."),
  ]);
  await adminSession.session.prompt("Apply the approved request", { requestId: "admin", userId: "UHUMAN" });
  assert.ok(!names(parent!).includes("config_capability_request"));
  assert.ok(names(child!).includes("config_capability_request"));
  assert.ok(!names(child!).includes("request_enable_capability"));
  const applied = after!.messages.find((m) => m.role === "toolResult" && m.toolName === "config_capability_request") as any;
  assert.equal(JSON.parse(applied.content[0].text).state, "applied");
  assert.equal(reloads, 1);
  const config = loadConfig(configPath).config;
  assert.deepEqual(config.channels.CTEAM!.exec?.shared, ["report"]);
  assert.deepEqual(config.channels.CTEAM!.tools, ["exec"]);
  assert.deepEqual(config.channels.COPS!.tools, []);
  for (const agentName of ["scout", "channelConfigurator"]) {
    const role = admin.agents.find((a) => a.name === agentName)!;
    const { narrowChannelForAgent } = await import("../workspace/subagents.ts");
    const tools = await buildThreadToolSet({ ...adminOpts, channel: narrowChannelForAgent(admin, role), role: "subagent" }, { current: () => undefined, set: async () => {} });
    assert.ok(!tools.tools.some((tool) => tool.name.includes("capability")));
    await tools.dispose();
  }
  assert.match(readFileSync(configPath, "utf8"), /shared:/);
});
