import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { inspectOperatorConfig, patchOperatorConfig, readOperatorConfig, saveOperatorConfig, type OperatorConfig } from "./operator.ts";
import { parseConfigText } from "./load.ts";

const path = ["schedules", "timezone"];
const original = `# Synthetic public fixture
name: Example harness
schedules:
  timezone: UTC # timezone comment
  maxPerChannel: 7 # sibling comment
  minIntervalSeconds: 90
defaults:
  preferences: \${EXAMPLE_PREFERENCES} # keep reference
`;

test("timezone inspection distinguishes absent, explicit, invalid literals, references and unsupported shapes", () => {
  assert.deepEqual(inspectOperatorConfig("name: Example\n").schedules, { basic: true, present: false, defaultTimezone: "UTC" });
  assert.deepEqual(inspectOperatorConfig(original).schedules, { basic: true, present: true, timezone: "UTC", defaultTimezone: "UTC" });
  assert.equal(inspectOperatorConfig("schedules:\n  timezone: Invalid/Zone\n").schedules.basic, true, "invalid literals can be repaired");
  for (const value of ["null", "false", "123", "[]", "{}", "'${EXAMPLE_TIMEZONE}'"]) {
    const form = inspectOperatorConfig("schedules:\n  timezone: " + value + "\n").schedules;
    assert.equal(form.basic, false, value);
    assert.equal(form.present, true);
  }
  assert.equal(inspectOperatorConfig("schedules:\n  timezone: '${EXAMPLE_TIMEZONE}'\n").schedules.timezone, "${EXAMPLE_TIMEZONE}");
  for (const mapping of ["null", "[]", "'${EXAMPLE_SCHEDULES}'", "{timezone: UTC}"]) {
    assert.equal(inspectOperatorConfig("schedules: " + mapping + "\n").schedules.basic, false);
  }
});

test("missing-parent add, change and remove preserve unrelated bytes, siblings and comments", () => {
  for (const initial of ["# Empty synthetic config\n", "name: Example\n", "name: Example\nschedules: # empty block\n", "name: Example\nschedules:\n  maxPerChannel: 7 # sibling\n"]) {
    assert.equal(patchOperatorConfig(initial, [{ path, remove: true }]), initial);
    const added = patchOperatorConfig(initial, [{ path, value: "Australia/Sydney" }]);
    assert.equal(inspectOperatorConfig(added).schedules.timezone, "Australia/Sydney");
    const removed = patchOperatorConfig(added, [{ path, remove: true }]);
    assert.equal(inspectOperatorConfig(removed).schedules.present, false);
    assert.equal(parseConfigText(removed).schedules.timezone, "UTC");
    assert.equal(inspectOperatorConfig(patchOperatorConfig(removed, [{ path, value: "UTC" }])).schedules.timezone, "UTC");
  }
  const changed = patchOperatorConfig(original, [{ path, value: "America/New_York" }]);
  assert.equal(changed, original.replace("timezone: UTC", "timezone: America/New_York"));
  const removed = patchOperatorConfig(changed, [{ path, remove: true }]);
  assert.equal(removed, original.replace("  timezone: UTC # timezone comment\n", ""));
  assert.equal(patchOperatorConfig(removed, [{ path, remove: true }]), removed);
});

test("patch rejects invalid zones/types and neighboring unsupported paths server-side", () => {
  for (const value of ["", " ", " UTC", "Not/A_Zone", "${EXAMPLE_TIMEZONE}", 42, true, null, [], {}, undefined]) {
    assert.throws(() => patchOperatorConfig(original, [{ path, value }]), /non-empty timezone accepted by the runtime/);
  }
  for (const value of ["UTC", "utc", "US/Eastern", "Australia/Sydney", "America/New_York", "Europe/London"]) {
    assert.equal(inspectOperatorConfig(patchOperatorConfig(original, [{ path, value }])).schedules.timezone, value);
  }
  for (const unsupported of [["schedules"], ["schedules", "maxPerChannel"], ["schedules", "timezone", "other"], ["schedules", "other"], ["defaults", "timezone"]]) {
    for (const edit of [{ value: "UTC" }, { remove: true }]) assert.throws(() => patchOperatorConfig(original, [{ path: unsupported, ...edit }]), /raw YAML/);
  }
});

test("unsupported shapes and aliases require Raw YAML without coercion or alias side effects", (t) => {
  const previous = process.env.EXAMPLE_TIMEZONE;
  process.env.EXAMPLE_TIMEZONE = "Australia/Sydney";
  t.after(() => { if (previous === undefined) delete process.env.EXAMPLE_TIMEZONE; else process.env.EXAMPLE_TIMEZONE = previous; });
  const fixtures = [
    "schedules: '${EXAMPLE_SCHEDULES}'\n",
    "schedules: []\n", "schedules: null\n", "schedules: {timezone: UTC} # flow comment\n",
    "schedules:\n  timezone: '${EXAMPLE_TIMEZONE}'\n",
    "schedules:\n  timezone: [UTC]\n",
    "shared: &shared {timezone: UTC}\nschedules: *shared\n",
    "schedules: &shared\n  timezone: UTC\nshared: *shared\n",
    "shared: &zone UTC\nschedules:\n  timezone: *zone\n",
    "schedules:\n  timezone: &zone UTC\nshared: *zone\n",
    "{schedules: {timezone: UTC}}\n",
  ];
  for (const text of fixtures) {
    assert.equal(inspectOperatorConfig(text).schedules.basic, false, text);
    assert.throws(() => patchOperatorConfig(text, [{ path, value: "Europe/London" }]), /Raw YAML/, text);
    if (parse(text).schedules?.timezone !== undefined) assert.throws(() => patchOperatorConfig(text, [{ path, remove: true }]), /Raw YAML/, text);
    else assert.equal(patchOperatorConfig(text, [{ path, remove: true }]), text, "absent removal stays a no-op");
  }
  const reference = "name: Example\nschedules:\n  timezone: '${EXAMPLE_TIMEZONE}' # retained\n";
  assert.equal(inspectOperatorConfig(reference).schedules.timezone, "${EXAMPLE_TIMEZONE}");
  assert.equal(patchOperatorConfig(reference, [{ path: ["defaults", "model"], value: "example/model" }]).slice(0, reference.length), reference);
  const unrelated = "name: Example\nshared: &shared {}\nother: *shared\n";
  assert.match(patchOperatorConfig(unrelated, [{ path, value: "UTC" }]), /other: \*shared/);
});

test("save/reopen preserves state, backups, restart warnings and stale-revision checks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-timezone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service: OperatorConfig = { configPath: join(root, "config.yaml"), dataDir: root,
    reload: async () => ({ applied: true, warnings: ["Restart required for timer changes."] }) };
  writeFileSync(service.configPath, "name: Example\n");
  for (const edit of [{ value: "Australia/Sydney" }, { value: "UTC" }, { remove: true }]) {
    const before = readOperatorConfig(service);
    const draft = patchOperatorConfig(before.text, [{ path, ...edit }]);
    const saved = await saveOperatorConfig(service, draft, before.revision, "test");
    assert.equal(readFileSync(saved.backup, "utf8"), before.text);
    assert.deepEqual(saved.warnings, ["Restart required for timer changes."]);
    const reopened = readOperatorConfig(service);
    assert.deepEqual(reopened, { text: draft, revision: saved.revision });
    assert.equal(inspectOperatorConfig(reopened.text).schedules.present, !edit.remove);
    assert.equal(parseConfigText(reopened.text).schedules.timezone, edit.value ?? "UTC");
    await assert.rejects(saveOperatorConfig(service, draft, before.revision, "test"), /changed since you loaded/);
  }
});
