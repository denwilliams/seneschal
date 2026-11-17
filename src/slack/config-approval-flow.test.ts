import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ChannelActivityLog } from "../agent/activity.ts";
import { HarnessApp } from "./app.ts";
import { SessionPool } from "../agent/session.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { loadConfig } from "../config/load.ts";
import { PendingConfigChanges } from "./config-approvals.ts";
import type { AdminConfigService } from "../agent/admin-config-tools.ts";

/** The real propose -> click -> apply path on the app's own methods, with Slack replaced by a recorder. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "config-approval-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const configPath = join(dir, "harness.yaml");
  writeFileSync(configPath, `dataDir: ${dataDir}\nchannels:\n  ops:\n    admin: true\n    model: fixture/model\n    allowUsers: [U01ADMIN1]\n    tools: [read]\n  factory:\n    model: fixture/model\n    tools: [read, write]   # keep\n`);
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const loaded = loadConfig(configPath);
  const posted: any[] = [];
  const updated: any[] = [];
  const ephemeral: any[] = [];
  const client = {
    chat: {
      postMessage: async (m: any) => { posted.push(m); return { ts: "9.9" }; },
      update: async (m: any) => { updated.push(m); },
      postEphemeral: async (m: any) => { ephemeral.push(m); },
    },
  };
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config: loaded.config, opts: { configPath, dataDir, modelRuntime }, registry: new ChannelRegistry(dataDir), pool: new SessionPool(),
    runtimes: { invalidateAll: async () => {}, invalidate: async () => {} },
    configApprovals: new PendingConfigChanges(), pendingThread: new Map([["COPS", "1.1"]]), app: { client },
  }) as unknown as { adminConfigService(): AdminConfigService; decideConfigChange(client: unknown, body: unknown): Promise<void> };
  const service = harness.adminConfigService();
  const actor = { channelId: "COPS", channelKey: "ops", userId: "U01ADMIN1" };
  const edits = [{ path: ["channels", "factory", "tools"], value: ["read", "write", "bash"] }, { path: ["channels", "factory", "sandbox"], value: { mode: "docker" } }];
  const click = (id: string, user: string, approve = true) =>
    harness.decideConfigChange(client, { actions: [{ value: id, action_id: approve ? "harness_config_approve" : "harness_config_deny" }], user: { id: user }, channel: { id: "COPS" }, message: { ts: "9.9" } });
  return { service, actor, edits, click, posted, updated, ephemeral, activity: () => new ChannelActivityLog(join(dataDir, "channels", "COPS"), "COPS").read(), text: () => readFileSync(configPath, "utf8") };
}

test("a request posts the exact change with buttons and writes nothing until an approver clicks", async () => {
  const s = await setup();
  const before = s.text();
  const { id } = await s.service.propose({ edits: s.edits as never, reason: "migrate the factory", actor: s.actor, approvers: ["U01ADMIN1"] });
  assert.equal(s.text(), before, "nothing written yet");
  assert.equal(s.posted.length, 1);
  assert.equal(s.activity()[0]!.interaction, "pending");
  assert.equal(s.activity()[0]!.sourceTs, "9.9");
  assert.ok(!JSON.stringify(s.activity()).includes("channels.factory.sandbox"), "config diffs are never feed snippets");
  assert.equal(s.posted[0].thread_ts, "1.1");
  assert.match(JSON.stringify(s.posted[0].blocks), /channels\.factory\.sandbox/);

  await s.click(id, "U01STRANGER", true);
  assert.equal(s.text(), before, "a click from someone who may not approve does nothing");
  assert.equal(s.activity()[0]!.interaction, "pending");
  assert.match(s.ephemeral[0].text, /Only <@U01ADMIN1> can approve/);

  await s.click(id, "U01ADMIN1", true);
  assert.match(s.text(), /tools: \[read, write, bash\]   # keep/);
  assert.match(s.text(), /sandbox:/);
  assert.match(JSON.stringify(s.updated[0].blocks), /applied/);
  assert.equal(s.activity()[0]!.interaction, "resolved");

  await s.click(id, "U01ADMIN1", true);
  assert.match(s.ephemeral.at(-1).text, /expired or was already decided/, "it cannot be applied twice");
});

test("denying changes nothing, and a change that needs no approval or is refused outright is not asked about", async () => {
  const s = await setup();
  const before = s.text();
  const { id } = await s.service.propose({ edits: s.edits as never, reason: "r", actor: s.actor, approvers: ["U01ADMIN1"] });
  await s.click(id, "U01ADMIN1", false);
  assert.equal(s.text(), before);
  assert.match(JSON.stringify(s.updated[0].blocks), /denied/);

  await assert.rejects(s.service.propose({ edits: [{ path: ["channels", "factory", "description"], value: "x" }] as never, reason: "r", actor: s.actor, approvers: ["U01ADMIN1"] }), /needs no approval/);
  await assert.rejects(s.service.propose({ edits: [{ path: ["channels", "factory", "envFile"], value: "/etc/shadow" }] as never, reason: "r", actor: s.actor, approvers: ["U01ADMIN1"] }), /envFile/);
  await assert.rejects(s.service.propose({ edits: [{ path: ["channels", "ops", "sandbox"], value: { mode: "docker" } }] as never, reason: "r", actor: s.actor, approvers: ["U01ADMIN1"] }), /admin channel/);
  assert.equal(s.posted.length, 1, "only the one real request was posted");
});
