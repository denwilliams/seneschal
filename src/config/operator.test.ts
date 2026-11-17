import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configRevision, inspectOperatorConfig, patchOperatorConfig, readOperatorConfig, safeConfigMessage, saveOperatorConfig, type OperatorConfig } from "./operator.ts";
import { parseConfigText } from "./load.ts";
import { editConfig } from "./edit.ts";
const original = '# kept comment\nname: original\ndefaults: {model: deepseek-v4-pro}\nchannels:\n  admin:\n    admin: true\n    description: Old\nconnectors:\n  github:\n    transport: http\n    url: https://example.test/mcp\n    headers: {Authorization: "Bearer \u0024{GITHUB_TOKEN}"}\n';
function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "operator-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service: OperatorConfig = { configPath: join(root, "config.yaml"), dataDir: root };
  writeFileSync(service.configPath, original, { mode: 0o640 });
  return service;
}
test("read is persisted text, never expanded runtime credentials; forms preserve unrelated bytes and references", (t) => {
  const s = fixture(t);
  const before = readOperatorConfig(s);
  assert.equal(before.text, original);
  assert.equal(inspectOperatorConfig(original).channels[0]!.key, "admin");
  const patched = patchOperatorConfig(original, [{ path: ["channels", "admin", "description"], value: "New" }]);
  assert.equal(patched, original.replace("description: Old", "description: New"));
  const inherited = patchOperatorConfig(patched, [{ path: ["defaults", "model"], remove: true }]);
  assert.equal(parseConfigText(inherited).defaults.model, "deepseek-v4-pro");
  assert.equal(readFileSync(s.configPath, "utf8"), original);
});
test("forms refuse alias side effects and fields outside their subset", () => {
  const aliased = 'defaults: &d {model: one}\nchannels: {admin: *d}\n';
  assert.throws(() => patchOperatorConfig(aliased, [{ path: ["defaults", "model"], value: "two" }]), /alias/);
  assert.throws(() => patchOperatorConfig(original, [{ path: ["channels", "admin", "admin"], value: "false" }]), /raw YAML/);
});
test("full operator saves are backed up, atomic, retain mode and symlinks, and do not inherit agent restrictions", async (t) => {
  const s = fixture(t);
  const real = s.configPath;
  s.configPath += ".link";
  symlinkSync(real, s.configPath);
  const result = await saveOperatorConfig(s, original.replace("admin: true", "admin: false"), configRevision(original), "test");
  assert.equal(result.saved, true);
  assert.equal(result.applied, false);
  assert.match(result.warnings[0]!, /Restart required/);
  assert.ok(lstatSync(s.configPath).isSymbolicLink());
  assert.equal(statSync(real).mode & 0o777, 0o640);
  const backups = readdirSync(join(s.dataDir, "config-backups"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(s.dataDir, "config-backups", backups[0]!), "utf8"), original);
  assert.equal(statSync(join(s.dataDir, "config-backups", backups[0]!)).mode & 0o777, 0o600);
  const audit = readFileSync(join(s.dataDir, "shared/audit/config-edits.jsonl"), "utf8");
  assert.ok(!audit.includes("GITHUB_TOKEN") && !audit.includes("Bearer"));
  await assert.rejects(editConfig({ ...s, actor: { channelId: "C1", channelKey: "admin", userId: "U1" }, edits: [{ path: ["webConsole", "enabled"], value: false }] }), /Nothing was changed/);
});
test("loader failures and stale revisions leave file and backups untouched", async (t) => {
  const s = fixture(t);
  for (const text of ["defaults: [", "defaults: {thinkingLevel: wrong}", "dashboard: {}", "name: \u0024{OPERATOR_TEST_MISSING_ENV_159}", "channels: {x: {agentSet: missing}}"])
    await assert.rejects(saveOperatorConfig(s, text, configRevision(original), "test"));
  await assert.rejects(saveOperatorConfig(s, "name: new", configRevision("old"), "test"), /changed since/);
  assert.equal(readFileSync(s.configPath, "utf8"), original);
  assert.ok(!readdirSync(s.dataDir).includes("config-backups"));
});
test("concurrent saves share one queue; second stale editor cannot overwrite first", async (t) => {
  const s = fixture(t);
  s.reload = async () => { await new Promise((r) => setTimeout(r, 20)); return { applied: true, warnings: ["restart required for timers"] }; };
  const results = await Promise.allSettled(["first", "second"].map((name) => saveOperatorConfig(s, "name: " + name, configRevision(original), "test")));
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  assert.equal(readFileSync(s.configPath, "utf8"), "name: first");
});
test("reload refusal and thrown reload restore old file and report uncertain runtime", async (t) => {
  const s = fixture(t);
  for (const throws of [false, true]) {
    s.reload = async () => { if (throws) throw new Error("runtime failure"); return { applied: false, error: "no", warnings: [] }; };
    await assert.rejects(saveOperatorConfig(s, "name: next", configRevision(original), "test"), /previous file was restored.*Runtime state is uncertain/);
    assert.equal(readFileSync(s.configPath, "utf8"), original);
  }
});
test("reload failure never rolls back over a newer host edit", async (t) => {
  const s = fixture(t);
  s.reload = async () => { writeFileSync(s.configPath, "name: host-edit"); throw new Error("no"); };
  await assert.rejects(saveOperatorConfig(s, "name: next", configRevision(original), "test"), /No rollback was attempted/);
  assert.equal(readFileSync(s.configPath, "utf8"), "name: host-edit");
});
test("backup/write failures leave the original intact and no temp file remains", async (t) => {
  const s = fixture(t);
  writeFileSync(join(s.dataDir, "config-backups"), "not a directory");
  await assert.rejects(saveOperatorConfig(s, "name: next", configRevision(original), "test"));
  assert.equal(readFileSync(s.configPath, "utf8"), original);
  assert.ok(!readdirSync(s.dataDir).some((n) => n.endsWith(".tmp")));
  rmSync(join(s.dataDir, "config-backups"));
  if (process.getuid?.() !== 0) {
    chmodSync(s.dataDir, 0o500);
    try { await assert.rejects(saveOperatorConfig(s, "name: next", configRevision(original), "test"), /read-only/); }
    finally { chmodSync(s.dataDir, 0o700); }
  }
});

test("diagnostic redaction scans decoded nested YAML scalars and aliases, retaining malformed-YAML feedback", (t) => {
  const previous = process.env.OPERATOR_REDACTION_TEST_SECRET;
  t.after(() => { if (previous === undefined) delete process.env.OPERATOR_REDACTION_TEST_SECRET; else process.env.OPERATOR_REDACTION_TEST_SECRET = previous; });
  process.env.OPERATOR_REDACTION_TEST_SECRET = "resolved-private-diagnostic";
  const text = String.raw`items: [&ref "\x24{OPERATOR_REDACTION_TEST_SECRET}", {nested: *ref}]`;
  assert.equal(safeConfigMessage(text, "items.1.nested: resolved-private-diagnostic"), "items.1.nested: ${OPERATOR_REDACTION_TEST_SECRET}");
  const cyclic = String.raw`items: &cycle [*cycle, "\u0024{OPERATOR_REDACTION_TEST_SECRET}"]`;
  assert.equal(safeConfigMessage(cyclic, "resolved-private-diagnostic"), "${OPERATOR_REDACTION_TEST_SECRET}");
  assert.equal(safeConfigMessage("defaults: [", "Malformed YAML at line 1"), "Malformed YAML at line 1");
  assert.equal(safeConfigMessage("name: ${OPERATOR_REDACTION_TEST_SECRET}\ndefaults: [", "resolved-private-diagnostic"), "${OPERATOR_REDACTION_TEST_SECRET}");
});
test("save warnings redact YAML-escaped environment references without rewriting persisted text", async (t) => {
  const s = fixture(t);
  const previous = process.env.OPERATOR_REDACTION_TEST_SECRET;
  t.after(() => { if (previous === undefined) delete process.env.OPERATOR_REDACTION_TEST_SECRET; else process.env.OPERATOR_REDACTION_TEST_SECRET = previous; });
  process.env.OPERATOR_REDACTION_TEST_SECRET = "resolved-private-warning";
  s.reload = async () => ({ applied: true, warnings: ["name: restart required for resolved-private-warning"] });
  for (const reference of [String.raw`\x24{OPERATOR_REDACTION_TEST_SECRET}`, String.raw`\u0024{OPERATOR_REDACTION_TEST_SECRET}`, String.raw`\U00000024{OPERATOR_REDACTION_TEST_SECRET}`, String.raw`$\x7bOPERATOR_REDACTION_TEST_SECRET}`, "${OPERATOR_REDACTION_TEST_SECRET}"]) {
    const text = original.replace("name: original", `name: "${reference}"`);
    const result = await saveOperatorConfig(s, text, readOperatorConfig(s).revision, "test");
    assert.deepEqual(result.warnings, ["name: restart required for ${OPERATOR_REDACTION_TEST_SECRET}"]);
    assert.equal(readFileSync(s.configPath, "utf8"), text);
  }
});
