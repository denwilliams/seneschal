import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { inspectOperatorConfig, patchOperatorConfig, validateOperatorConfig } from "./operator.ts";

const original = [
  "# unrelated comment", "name: original", "connectors:", "  remote: # remote comment",
  "    # transport comment", "    transport: http", "    url: https://example.test/mcp # url comment",
  "    description: Keep me", "    allowTools: [read]", "    oauth:", "      redirectUrl: https://example.test/callback",
  '      clientSecret: ${CONNECTOR_TEST_SECRET}', "    headers:", '      Authorization: Bearer ${CONNECTOR_TEST_SECRET} # token comment',
  "      Other: retained # other comment", "channels:", "  admin:", "    description: unchanged", "",
].join("\n");

test("inspect exposes only unexpanded connector definitions, including advanced YAML", (t) => {
  const previous = process.env.CONNECTOR_TEST_SECRET;
  process.env.CONNECTOR_TEST_SECRET = "must-not-be-exposed";
  t.after(() => { if (previous === undefined) delete process.env.CONNECTOR_TEST_SECRET; else process.env.CONNECTOR_TEST_SECRET = previous; });
  const form = inspectOperatorConfig(original);
  assert.equal(form.connectors[0]!.transport, "http");
  assert.ok(form.connectors[0]!.basic);
  assert.match(form.connectors[0]!.yaml, /oauth:/);
  assert.match(form.connectors[0]!.yaml, /# transport comment/);
  assert.ok(!JSON.stringify(form).includes("must-not-be-exposed"));
  assert.equal(form.connectors[0]!.headers.Authorization, 'Bearer ${CONNECTOR_TEST_SECRET}');
});

test("add, edit and remove both transports without rewriting unrelated configuration", () => {
  let text = patchOperatorConfig(original, [{ path: ["connectors", "local: tools"], create: true, yaml: 'transport: stdio\ncommand: node\nargs: [server.js]\nenv: {}\n' }]);
  text = patchOperatorConfig(text, [
    { path: ["connectors", "local: tools", "command"], value: "npx" },
    { path: ["connectors", "local: tools", "args"], value: ["-y", "server", "argument with spaces", ""] },
    { path: ["connectors", "local: tools", "env", "TOKEN"], value: '${CONNECTOR_TEST_SECRET}' },
    { path: ["connectors", "remote", "url"], value: "https://new.example.test/mcp" },
    { path: ["connectors", "remote", "headers", "Authorization"], value: 'Token ${CONNECTOR_TEST_SECRET}' },
    { path: ["connectors", "remote", "headers", "New"], value: "value" },
  ]);
  for (const comment of ["Other: retained # other comment", "# transport comment", "# url comment", "# token comment"]) assert.ok(text.includes(comment));
  assert.match(text, /clientSecret: \$\{CONNECTOR_TEST_SECRET\}/);
  assert.match(text, /allowTools: \[read\]/);
  assert.equal(text.slice(text.indexOf("channels:")), original.slice(original.indexOf("channels:")));
  assert.ok(text.startsWith("# unrelated comment\nname: original\n"));
  const local = inspectOperatorConfig(text).connectors.find((c) => c.key === "local: tools")!;
  assert.equal(local.command, "npx");
  assert.deepEqual(local.args, ["-y", "server", "argument with spaces", ""]);
  assert.equal(local.env.TOKEN, '${CONNECTOR_TEST_SECRET}');
  text = patchOperatorConfig(text, [{ path: ["connectors", "local: tools", "env", "TOKEN"], remove: true }, { path: ["connectors", "remote", "headers", "New"], remove: true }]);
  assert.deepEqual(inspectOperatorConfig(text).connectors.find((c) => c.key === "local: tools")!.env, {});
  text = patchOperatorConfig(text, [{ path: ["connectors", "local: tools"], remove: true }]);
  assert.equal(inspectOperatorConfig(text).connectors.length, 1);
  text = patchOperatorConfig(text, [{ path: ["connectors", "another"], create: true, yaml: "transport: http\nurl: https://other.test/mcp\n" }]);
  assert.equal(inspectOperatorConfig(text).connectors[1]!.transport, "http");
  assert.equal(patchOperatorConfig(text, [{ path: ["connectors", "another", "headers", "NEVER_ADDED"], remove: true }]), text);
  const noEnv = "connectors:\n  local:\n    transport: stdio\n    command: node\n";
  assert.equal(patchOperatorConfig(noEnv, [{ path: ["connectors", "local", "env", "NEVER_ADDED"], remove: true }]), noEnv);
});

test("connector YAML/form/full-YAML round trips preserve advanced fields, comments and references", () => {
  const yaml = inspectOperatorConfig(original).connectors[0]!.yaml;
  let text = patchOperatorConfig(original, [{ path: ["connectors", "remote"], yaml: yaml.replace("Keep me", "Edited in YAML") + "# raw comment\n" }]);
  for (const comment of ["# raw comment", "# remote comment", "# transport comment"]) assert.ok(text.includes(comment));
  text = patchOperatorConfig(text, [{ path: ["connectors", "remote", "url"], value: "https://form.test/mcp" }]);
  assert.equal(parse(text).connectors.remote.description, "Edited in YAML");
  assert.deepEqual(parse(text).connectors.remote.oauth, parse(original).connectors.remote.oauth);
  assert.deepEqual(parse(inspectOperatorConfig(text).connectors[0]!.yaml), parse(text).connectors.remote);
  assert.equal(text.slice(text.indexOf("channels:")), original.slice(original.indexOf("channels:")));
  for (const base of ["", "connectors: {}\n", "connectors:\n", "connectors: {old: {transport: http, url: 'https://old.test'}}\n"]) {
    const added = patchOperatorConfig(base, [{ path: ["connectors", "new"], create: true, yaml: "# new comment\ntransport: stdio\ncommand: node\n" }]);
    assert.equal(parse(added).connectors.new.command, "node");
    assert.match(added, /# new comment/);
  }
  const crlf = patchOperatorConfig(original.replaceAll("\n", "\r\n"), [{ path: ["connectors", "remote"], yaml }]);
  assert.equal(crlf.replaceAll("\r\n", "").includes("\n"), false);
  assert.deepEqual(parse(crlf), parse(original));
  const block = "transport: http\nurl: https://block.test\ndescription: |+\n  keep trailing newlines\n\n";
  assert.deepEqual(parse(patchOperatorConfig(original, [{ path: ["connectors", "remote"], yaml: block }])).connectors.remote, parse(block));
});

// Parsed object keys are strings even when YAML's AST keeps their numeric scalar types.
for (const transport of ["http", "stdio"] as const) {
  for (const keySource of ["123", "0", "-7", "1e3", "0x7b", '"00123"']) {
    test(`${transport} connector ${keySource} round-trips YAML/form/full-YAML with comments intact`, () => {
      const field = transport === "http" ? "url" : "command";
      const initial = transport === "http" ? "https://example.test/mcp" : "node";
      const rawValue = transport === "http" ? "https://yaml.test/mcp" : "npx";
      const formValue = transport === "http" ? "https://form.test/mcp" : "python3";
      const before = [
        "# unrelated comment", "name: original", "connectors:", `  ${keySource}: # entry comment`,
        "    # transport comment", `    transport: ${transport}`, `    ${field}: ${initial} # field comment`,
        "    description: Keep advanced settings", "    allowTools: [read]", "channels:",
        "  admin:", "    description: unchanged # channel comment", "",
      ].join("\n");
      const key = Object.keys(parse(before).connectors)[0]!;
      validateOperatorConfig(before);
      const inspected = inspectOperatorConfig(before).connectors[0]!;
      assert.equal(inspected.key, key);
      assert.equal(inspected.basic, true);
      assert.match(inspected.yaml, /# transport comment/);
      assert.match(inspected.yaml, /# field comment/);
      let text = patchOperatorConfig(before, [{ path: ["connectors", key], yaml: inspected.yaml.replace(initial, rawValue) + "# raw comment\n" }]);
      assert.equal(inspectOperatorConfig(text).connectors[0]![field], rawValue);
      text = patchOperatorConfig(text, [{ path: ["connectors", key, field], value: formValue }]);
      // Full-config YAML remains the draft; an unrelated raw edit must survive the return to connector YAML.
      text = text.replace("name: original", "name: edited-in-full-yaml");
      const fragment = inspectOperatorConfig(text).connectors[0]!.yaml;
      text = patchOperatorConfig(text, [{ path: ["connectors", key], yaml: fragment }]);
      assert.equal(inspectOperatorConfig(text).connectors[0]![field], formValue);
      assert.deepEqual(parse(fragment), parse(text).connectors[key]);
      assert.deepEqual(parse(text).connectors[key], { ...parse(before).connectors[key], [field]: formValue });
      assert.ok(text.startsWith("# unrelated comment\nname: edited-in-full-yaml\n"));
      assert.ok(text.includes(`  ${keySource}:\n`));
      for (const comment of ["# entry comment", "# transport comment", "# field comment", "# raw comment"]) assert.ok(text.includes(comment));
      assert.equal(text.slice(text.indexOf("channels:")), before.slice(before.indexOf("channels:")));
      validateOperatorConfig(text);
    });
  }
}

test("invalid drafts, duplicate names and unsupported paths fail atomically; schema validation stays authoritative", () => {
  for (const yaml of ["transport: [", "[]", "null", "url: one\nurl: two\n"]) assert.throws(() => patchOperatorConfig(original, [{ path: ["defaults", "model"], value: "changed" }, { path: ["connectors", "remote"], yaml }]));
  for (const name of ["remote", "", "   "]) assert.throws(() => patchOperatorConfig(original, [{ path: ["connectors", name], create: true, yaml: "transport: stdio\ncommand: node" }]), /unique name/);
  assert.throws(() => patchOperatorConfig(original, [{ path: ["channels", "admin"], yaml: "admin: false" }]), /single connector/);
  assert.throws(() => patchOperatorConfig(original, [{ path: ["connectors", "missing"], yaml: "transport: stdio\ncommand: node" }]), /Connector no longer exists/);
  assert.throws(() => patchOperatorConfig(original, [{ path: ["connectors", "remote", "oauth"], value: "lost" }]), /raw YAML/);
  assert.throws(() => patchOperatorConfig(original, [{ path: ["defaults", "model"], value: ["invalid"] }]), /raw YAML/);
  assert.throws(() => inspectOperatorConfig("connectors: []"), /must be a mapping/);
  const invalid = patchOperatorConfig("", [{ path: ["connectors", "bad"], create: true, yaml: "transport: http\nurl: invalid" }]);
  assert.throws(() => validateOperatorConfig(invalid), /connectors.bad.url/);
  assert.equal(inspectOperatorConfig("connectors: {broken: {transport: stdio, args: wrong}}").connectors[0]!.basic, false);
});

test("connector alias side effects are refused instead of silently rewriting shared definitions", () => {
  const text = "connectors:\n  a: &shared\n    transport: http\n    url: https://old.test\n  b: *shared\n";
  assert.equal(inspectOperatorConfig(text).connectors.length, 2);
  assert.match(inspectOperatorConfig(text).connectors[1]!.yaml, /\*shared/);
  const external = "name: &token value\nconnectors:\n  remote:\n    transport: http\n    url: https://old.test\n    headers: {X: *token}\n";
  assert.equal(inspectOperatorConfig(external).connectors[0]!.headers.X, "value");
  assert.equal(patchOperatorConfig(external, [{ path: ["connectors", "remote", "url"], value: "https://new.test" }]), external.replace("https://old.test", "https://new.test"));
  assert.throws(() => patchOperatorConfig(text, [{ path: ["connectors", "a", "url"], value: "https://new.test" }]), /alias|anchor/);
  assert.throws(() => patchOperatorConfig(text, [{ path: ["connectors", "a"], yaml: "transport: http\nurl: https://new.test" }]), /alias|anchor/);
});
