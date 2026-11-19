import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { inspectOperatorConfig, patchOperatorConfig, readOperatorConfig, saveOperatorConfig, validateOperatorConfig, type OperatorConfig } from "./operator.ts";
import { parseConfigText } from "./load.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";

const builtin = { enabled: true, debounceSeconds: 60, maxThreads: 10, model: "deepseek-flash", maxTranscriptChars: 8000 };
const original = `# Synthetic configuration only
name: Example harness
defaults:
  model: deepseek-v4-pro # unrelated comment
  recentConversations:
    enabled: false # keep explicit false
    maxThreads: 12
    model: \${SUMMARY_MODEL}
channels:
  general:
    description: Example channel
    recentConversations:
      enabled: false
      debounceSeconds: 90 # keep sibling
  project:
    description: Inherits summaries
`;
const scopes = [["defaults", "recentConversations"], ["channels", "general", "recentConversations"]];

test("inspection distinguishes built-ins, persisted false, partial overrides and unexpanded references", () => {
  const form = inspectOperatorConfig(original);
  assert.deepEqual(form.recentConversationDefaults, builtin);
  assert.deepEqual(form.defaults.recentConversations, { basic: true, values: { enabled: false, maxThreads: 12, model: "${SUMMARY_MODEL}" }, unsupported: [] });
  assert.deepEqual(form.channels[0]!.recentConversations.values, { enabled: false, debounceSeconds: 90 });
  assert.deepEqual(form.channels[1]!.recentConversations.values, {});
  assert.deepEqual(inspectOperatorConfig("name: Example\n").defaults.recentConversations.values, {});
  for (const value of ["[]", "some scalar", "'${SUMMARY_MAPPING}'"]) {
    assert.equal(inspectOperatorConfig("defaults: {recentConversations: " + value + "}").defaults.recentConversations.basic, false);
  }
  const unusual = inspectOperatorConfig("defaults: {recentConversations: {enabled: '${FLAG}', maxThreads: [1], model: {nested: value}}}");
  assert.deepEqual(unusual.defaults.recentConversations.unsupported, ["enabled", "maxThreads", "model"]);
});

test("all five fields can be added, edited and individually removed without changing siblings, comments or references", () => {
  for (const scope of scopes) for (const [key, value] of Object.entries(builtin)) {
    const path = [...scope, key];
    const changed = key === "enabled" ? false : key === "model" ? "example/summary" : 123;
    const text = patchOperatorConfig(original, [{ path, value }, { path, value: changed }]);
    const expected = parse(original);
    const mapping = scope[0] === "defaults" ? expected.defaults.recentConversations : expected.channels.general.recentConversations;
    mapping[key] = changed;
    assert.deepEqual(parse(text), expected);
    assert.match(text, /model: deepseek-v4-pro # unrelated comment/);
    if (!(scope[0] === "defaults" && key === "model")) assert.match(text, /model: \$\{SUMMARY_MODEL\}/);
    if (!(scope[0] === "channels" && key === "debounceSeconds")) assert.match(text, /debounceSeconds: 90 # keep sibling/);
    const removed = patchOperatorConfig(text, [{ path, remove: true }]);
    delete mapping[key];
    assert.deepEqual(parse(removed), expected);
  }
});

test("absent, empty and partial mappings permit add/remove/re-add; removing an absent field is a byte-for-byte no-op", () => {
  for (const text of ["name: Example\nchannels: {general: {}}\n", "defaults:\n  recentConversations: # not configured\nchannels:\n  general:\n", "defaults: {recentConversations: {}}\nchannels: {general: {recentConversations: {}}}\n"]) {
    for (const scope of scopes) {
      const path = [...scope, "enabled"];
      assert.equal(patchOperatorConfig(text, [{ path, remove: true }]), text);
      const removed = patchOperatorConfig(text, [{ path, value: false }, { path, remove: true }]);
      const readded = patchOperatorConfig(removed, [{ path, value: true }]);
      const form = inspectOperatorConfig(readded);
      assert.equal((scope[0] === "defaults" ? form.defaults : form.channels[0]!).recentConversations.values.enabled, true);
    }
  }
});

test("patch and validation reject invalid types and non-positive or malformed integers at both scopes", () => {
  for (const scope of scopes) {
    for (const key of ["debounceSeconds", "maxThreads", "maxTranscriptChars"]) {
      for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12", "1.5", "oops", true, [], {}]) {
        assert.throws(() => patchOperatorConfig(original, [{ path: [...scope, key], value }]), /positive integer/);
        const raw = { defaults: {}, channels: { general: {} } } as any;
        (scope[0] === "defaults" ? raw.defaults : raw.channels.general).recentConversations = { [key]: value };
        assert.throws(() => validateOperatorConfig(stringify(raw)), /recentConversations/);
      }
    }
    for (const [key, value] of [["enabled", "false"], ["enabled", 0], ["model", false], ["model", {}]] as const) {
      assert.throws(() => patchOperatorConfig(original, [{ path: [...scope, key], value }]), /requires/);
    }
  }
});

test("allowlist remains leaf-scoped, existing-channel-only, and protects aliases", () => {
  for (const path of [["defaults", "recentConversations"], ["defaults", "recentConversations", "other"], ["defaults", "recentConversations", "model", "nested"], ["channels", "new", "recentConversations", "enabled"], ["channels", "general", "other", "enabled"]]) {
    assert.throws(() => patchOperatorConfig(original, [{ path, value: false }]), /raw YAML/);
    assert.throws(() => patchOperatorConfig(original, [{ path, remove: true }]), /raw YAML/);
  }
  const alias = "defaults:\n  recentConversations: &recent {enabled: true, maxThreads: 10}\nchannels:\n  general:\n    recentConversations: *recent\n";
  for (const scope of scopes) assert.throws(() => patchOperatorConfig(alias, [{ path: [...scope, "enabled"], value: false }]), /alias|not a map/);
  const unrelated = "name: Example\nshared: &shared {}\nchannels:\n  general:\n    share: *shared\n";
  assert.match(patchOperatorConfig(unrelated, [{ path: [...scopes[0]!, "enabled"], value: false }]), /share: \*shared/);
});

test("save/reopen resolves inheritance, false and removals, backs up each revision and retains restart warnings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-recent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.SUMMARY_MODEL;
  process.env.SUMMARY_MODEL = "example/summary";
  t.after(() => { if (previous === undefined) delete process.env.SUMMARY_MODEL; else process.env.SUMMARY_MODEL = previous; });
  const service: OperatorConfig = { configPath: join(root, "config.yaml"), dataDir: root,
    reload: async () => ({ applied: true, warnings: ["Restart required for timer changes."] }) };
  writeFileSync(service.configPath, original);
  const registry = new ChannelRegistry(root);
  let step = 0;
  for (const edits of [
    [{ path: [...scopes[0]!, "maxTranscriptChars"], value: 16000 }, { path: [...scopes[1]!, "maxThreads"], value: 3 }],
    [{ path: [...scopes[0]!, "enabled"], value: true }, { path: [...scopes[1]!, "debounceSeconds"], remove: true }],
    [{ path: [...scopes[1]!, "enabled"], remove: true }, { path: [...scopes[1]!, "maxThreads"], remove: true }],
  ]) {
    const before = readOperatorConfig(service);
    const draft = patchOperatorConfig(before.text, edits);
    const saved = await saveOperatorConfig(service, draft, before.revision, "test");
    assert.deepEqual(saved.warnings, ["Restart required for timer changes."]);
    assert.equal(readFileSync(saved.backup, "utf8"), before.text);
    const reopened = readOperatorConfig(service);
    assert.equal(reopened.text, draft);
    assert.equal(reopened.revision, saved.revision);
    assert.equal(inspectOperatorConfig(reopened.text).defaults.recentConversations.values.model, "${SUMMARY_MODEL}");
    const config = parseConfigText(reopened.text);
    for (const name of ["general", "project"]) {
      const resolved = resolveChannel(config, root, { id: name, name, isDm: false }, registry).channel!;
      assert.deepEqual(resolved.recentConversations, { ...config.defaults.recentConversations, ...config.channels[name]?.recentConversations });
      assert.equal(resolved.recentConversations.enabled, name === "general" ? step === 2 : step > 0);
      assert.equal(resolved.recentConversations.maxThreads, name === "general" && step < 2 ? 3 : 12);
      assert.equal(resolved.recentConversations.debounceSeconds, name === "general" && step === 0 ? 90 : 60);
    }
    step++;
  }
  const stable = readOperatorConfig(service);
  await assert.rejects(saveOperatorConfig(service, stable.text.replace("maxThreads: 12", "maxThreads: 0"), stable.revision, "test"), /recentConversations/);
  assert.deepEqual(readOperatorConfig(service), stable, "invalid saves leave persisted state unchanged");
  const config = parseConfigText(stable.text);
  const resolved = resolveChannel(config, root, { id: "general", name: "general", isDm: false }, registry).channel!;
  assert.deepEqual(resolved.recentConversations, { enabled: true, maxThreads: 12, debounceSeconds: 60, model: "example/summary", maxTranscriptChars: 16000 });
});
