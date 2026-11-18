import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { inspectOperatorConfig, patchOperatorConfig, readOperatorConfig, saveOperatorConfig, type OperatorConfig } from "./operator.ts";
import { parseConfigText } from "./load.ts";

const original = `# Synthetic operator config
name: Example harness
defaults:
  model: deepseek-v4-pro # keep this comment
channels:
  general:
    preferences: Keep channel-specific guidance.
  project:
    description: Inherits preferences
`;

test("default preferences can be inspected, added, edited, emptied and removed through backed-up saves and reloads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-preferences-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const applied: (string | undefined)[] = [];
  const service: OperatorConfig = {
    configPath: join(root, "config.yaml"), dataDir: root,
    reload: async () => {
      applied.push(parseConfigText(readFileSync(service.configPath, "utf8")).defaults.preferences);
      return { applied: true, warnings: [] };
    },
  };
  writeFileSync(service.configPath, original);
  assert.equal(inspectOperatorConfig(readOperatorConfig(service).text).defaults.preferences, undefined);
  const values = ["Use short paragraphs.\nState assumptions.", "Updated: guidance # literal\n\nKeep a final newline.\n", "", undefined];
  for (const value of values) {
    const before = readOperatorConfig(service);
    const next = patchOperatorConfig(before.text, [{ path: ["defaults", "preferences"], ...(value === undefined ? { remove: true } : { value }) }]);
    assert.equal(inspectOperatorConfig(next).defaults.preferences, value);
    assert.equal(parseConfigText(next).defaults.preferences, value);
    const expected = parse(original);
    if (value !== undefined) expected.defaults.preferences = value;
    assert.deepEqual(parse(next), expected, "no other configuration value changes");
    assert.ok(next.startsWith(original.slice(0, original.indexOf("channels:"))));
    assert.equal(next.slice(next.indexOf("channels:")), original.slice(original.indexOf("channels:")), "channel overrides and unrelated bytes survive");
    const saved = await saveOperatorConfig(service, next, before.revision, "test");
    assert.equal(saved.applied, true);
    assert.equal(readFileSync(saved.backup, "utf8"), before.text);
    assert.deepEqual(readOperatorConfig(service), { text: next, revision: saved.revision });
    assert.equal(inspectOperatorConfig(readOperatorConfig(service).text).defaults.preferences, value);
  }
  assert.deepEqual(applied, values);
  assert.equal(readOperatorConfig(service).text, original, "removal restores the original text");
});

test("default preferences retain form-patch safety boundaries", () => {
  assert.equal(patchOperatorConfig("name: Example\n", [{ path: ["defaults", "preferences"], remove: true }]), "name: Example\n");
  assert.equal(inspectOperatorConfig(patchOperatorConfig("name: Example\n", [{ path: ["defaults", "preferences"], value: "New\nGuidance" }])).defaults.preferences, "New\nGuidance");
  assert.throws(() => patchOperatorConfig(original, [{ path: ["defaults", "preferences"], value: ["not a string"] }]), /raw YAML/);
  assert.throws(() => patchOperatorConfig(original, [{ path: ["defaults", "description"], value: "not supported" }]), /raw YAML/);
  const aliased = "defaults: &defaults {preferences: Original}\nchannels: {general: *defaults}\n";
  assert.throws(() => patchOperatorConfig(aliased, [{ path: ["defaults", "preferences"], value: "Changed" }]), /alias/);
});
