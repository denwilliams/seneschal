import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createConfiguratorService } from "./configurator.ts";
import { parseConfigText } from "./load.ts";
import type { OperatorConfig } from "./operator.ts";
import { editConfig } from "./edit.ts";

const original = `# keep this
channels:
  "#eng":
    configurators: {channel: true, harness: true}
    description: Old
    tools: [read]
  other: {description: Private}
connectors:
  api:
    transport: http
    url: https://example.test/mcp
    headers: {Authorization: "Bearer \u0024{API_TOKEN}", Password: "literal-secret"}
`;
function fixture(t: TestContext, text = original) {
  const dir = mkdtempSync(join(tmpdir(), "configurator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: OperatorConfig = { configPath: join(dir, "config.yaml"), dataDir: dir };
  writeFileSync(config.configPath, text, { mode: 0o640 });
  const service = (scope: "channel" | "harness") => createConfiguratorService(config, { scope, channelKey: "#eng", channelId: "C1", userId: "U1" });
  return { config, channel: service("channel"), harness: service("harness"), text: () => readFileSync(config.configPath, "utf8") };
}
const edit = (field: string, value: unknown) => [{ path: ["channels", "#eng", field], value }];

test("scope is host bound: channel reads only itself; harness reads all without expanded or literal secrets", (t) => {
  const f = fixture(t);
  assert.equal(f.channel.get().path.join("."), "channels.#eng");
  assert.doesNotMatch(JSON.stringify(f.channel.get()), /Private|API_TOKEN|literal-secret/);
  for (const path of [[], ["channels"], ["channels", "other"], ["channels", "eng"], ["defaults"], ["connectors"]]) assert.throws(() => f.channel.get(path), /only their invoking channel/);
  const full = JSON.stringify(f.harness.get());
  assert.match(full, /Private/);
  assert.match(full, /API_TOKEN/);
  assert.doesNotMatch(full, /literal-secret/);
});

test("channel field allowlist refuses direct and indirect trust escalation, removals and whole-map replacement", async (t) => {
  const f = fixture(t);
  const revision = f.channel.get().revision;
  for (const field of ["configurators", "admin", "agentSet", "agentOverrides", "permissions", "tools", "sandbox", "exec", "jobs", "workspace", "web", "images", "envFile", "share", "connectors", "allowUsers", "factory", "requires", "futureField"]) {
    assert.throws(() => f.channel.validate(edit(field, {}), revision), /trust, access or execution/);
    await assert.rejects(f.channel.save([{ path: ["channels", "#eng", field], remove: true }], revision), /trust, access or execution/);
  }
  for (const edits of [[{ path: ["channels", "#eng"], value: { configurators: { harness: true } } }], [{ path: ["channels", "#eng"], remove: true }], [{ path: ["channels", "other", "description"], value: "Changed" }], [{ path: ["defaults", "model"], value: "one" }]]) await assert.rejects(f.channel.save(edits, revision));
  assert.throws(() => f.channel.validate([{ path: ["channels", "#eng", "context", "__proto__"], value: {} }], revision), /Invalid configuration path/);
  assert.throws(() => f.channel.validate(edit("preferences", "${HOST_SECRET}"), revision), /environment references/);
  assert.equal(f.text(), original);
  assert.ok(!readdirSync(f.config.dataDir).includes("config-backups"));
});

test("validated channel save preserves comments, environment references, symlink, mode, and backs up before reload", async (t) => {
  const f = fixture(t);
  const real = f.config.configPath;
  f.config.configPath += ".link";
  symlinkSync(real, f.config.configPath);
  let calls = 0;
  f.config.reload = async () => {
    calls++;
    const backups = readdirSync(join(f.config.dataDir, "config-backups"));
    assert.equal(readFileSync(join(f.config.dataDir, "config-backups", backups[0]!), "utf8"), original);
    assert.match(f.text(), /description: New/);
    return { applied: true, warnings: ["1 active turn(s) will finish on the previous config."] };
  };
  const revision = f.channel.get().revision;
  assert.deepEqual(f.channel.validate(edit("description", "New"), revision), { valid: true, saved: false, applied: false });
  assert.equal(calls, 0);
  assert.equal(f.text(), original);
  const result = await f.channel.save(edit("description", "New"), revision);
  assert.equal(result.saved, true);
  assert.equal(result.applied, true);
  assert.match(result.warnings[0]!, /active turn/);
  assert.equal(calls, 1);
  assert.equal(f.text(), original.replace("description: Old", "description: New"));
  assert.ok(lstatSync(f.config.configPath).isSymbolicLink());
  assert.equal(statSync(real).mode & 0o777, 0o640);
  assert.equal(statSync(result.backup).mode & 0o777, 0o600);
  const audit = readFileSync(join(f.config.dataDir, "shared/audit/config-edits.jsonl"), "utf8");
  assert.match(audit, /C1:U1:channelConfigurator/);
  assert.doesNotMatch(audit, /literal-secret|API_TOKEN/);
});

test("harness authority can change another channel and security settings; unavailable reload is reported separately", async (t) => {
  const f = fixture(t);
  const result = await f.harness.save([{ path: ["channels", "other", "configurators"], value: { harness: true } }, { path: ["webConsole", "enabled"], value: false }], f.harness.get().revision);
  assert.equal(parseConfigText(f.text()).channels.other!.configurators.harness, true);
  assert.equal(result.saved, true);
  assert.equal(result.applied, false);
  assert.match(result.warnings.join(), /Restart required/);
});

test("explicit backup is private, read-only, and returns no file contents", async (t) => {
  const f = fixture(t);
  const result = await f.channel.backup();
  assert.equal(f.text(), original);
  assert.match(result.backup, /^harness-.*yaml$/);
  assert.ok(!result.backup.includes("/"));
  assert.equal(readFileSync(join(f.config.dataDir, "config-backups", result.backup), "utf8"), original);
});

test("loader validation, YAML alias side effects, stale and concurrent saves leave the active file safe", async (t) => {
  const f = fixture(t);
  const revision = f.channel.get().revision;
  for (const edits of [edit("thinkingLevel", "wrong"), edit("context", { threadBackfill: -1 })]) await assert.rejects(f.channel.save(edits, revision));
  assert.equal(f.text(), original);
  await assert.rejects(f.harness.save([{ path: ["channels", "other", "agentSet"], value: "missing" }], revision), /agentSet/);
  const alias = fixture(t, `channels:
  "#eng": &shared
    configurators: {channel: true, harness: true}
    description: Old
  other: *shared
`);
  await assert.rejects(alias.channel.save(edit("description", "New"), alias.channel.get().revision), /alias/);
  f.config.reload = async () => { await new Promise((r) => setTimeout(r, 10)); return { applied: true, warnings: [] }; };
  const results = await Promise.allSettled(["First", "Second"].map((value) => f.channel.save(edit("description", value), revision)));
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  assert.match(f.text(), /description: First/);
});

test("reload failure restores and reloads the old file, but never clobbers a newer host edit", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.config.reload = async () => ({ applied: ++calls > 1, warnings: [] });
  await assert.rejects(f.channel.save(edit("description", "New"), f.channel.get().revision), /previous file was restored.*previous config was reloaded/);
  assert.equal(f.text(), original);
  f.config.reload = async () => { writeFileSync(f.config.configPath, original + "name: Host edit\n"); throw new Error("fail"); };
  await assert.rejects(f.channel.save(edit("description", "New"), f.channel.get().revision), /No rollback was attempted/);
  assert.match(f.text(), /Host edit/);
});

test("backup failure cannot replace the active file", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.config.dataDir, "config-backups"), "not a directory");
  await assert.rejects(f.channel.save(edit("description", "New"), f.channel.get().revision));
  assert.equal(f.text(), original);
});

test("revocation is checked even by previously bound services, including backup and validation", async (t) => {
  const f = fixture(t);
  const revision = f.channel.get().revision;
  writeFileSync(f.config.configPath, original.replace("channel: true, harness: true", "channel: false, harness: false"));
  assert.throws(() => f.channel.get(), /no longer enabled/);
  assert.throws(() => f.harness.get(), /no longer enabled/);
  assert.throws(() => f.channel.validate(edit("description", "New"), revision), /no longer enabled/);
  await assert.rejects(f.channel.backup(), /no longer enabled/);
  await assert.rejects(f.channel.save(edit("description", "New"), revision), /no longer enabled/);
});

test("direct header reads retain credential redaction and invalid global YAML is not disclosed across channel scope", (t) => {
  const f = fixture(t, original.replace('Password: "literal-secret"', '"X-Custom": "literal-secret"'));
  assert.equal(f.harness.get(["connectors", "api", "headers", "X-Custom"]).value, "[redacted]");
  writeFileSync(f.config.configPath, "name: [private-invalid-setting");
  assert.throws(() => f.channel.get(), (error: Error) => {
    assert.match(error.message, /persisted harness configuration is invalid/);
    assert.doesNotMatch(error.message, /private-invalid-setting/);
    return true;
  });
});

test("channel edits cannot weaken a posting reviewer through inherited prompt/model settings", async (t) => {
  const f = fixture(t, original.replace("tools: [read]", 'tools: [read]\n    agentSet: guards\n    share: {postAs: {user: U0123USER, reviewer: guard}}') + '\nagentSets:\n  guards:\n    agents:\n      guard: {description: Review drafts}\n');
  for (const field of ["model", "thinkingLevel", "preferences"]) await assert.rejects(f.channel.save(edit(field, "changed"), f.channel.get().revision), /posting reviewer's inherited settings/);
});

test("the legacy admin editor cannot grant configurator authority directly or through a channel map", async (t) => {
  const f = fixture(t);
  for (const edits of [[{ path: ["channels", "other", "configurators"], value: { harness: true } }], [{ path: ["channels", "other"], value: { configurators: { harness: true } } }]]) await assert.rejects(editConfig({ ...f.config, actor: { channelId: "CADMIN", channelKey: "admin", userId: "U1" }, edits }), /configuration administration/);
});
