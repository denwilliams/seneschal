import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { expectedTree, normalizeTree, patchText, PatchError, type TextEdit } from "./edit-text.ts";

const FILE = `# The harness. Edited by hand.
name: Home            # shown in prompts

defaults:
  model: deepseek-v4-pro   # the cheap one
  tools: [read, write]
  sandbox: { mode: docker, network: none }

# Connectors. Definitions only.
connectors:
  # gmail:
  #   transport: stdio
  #   command: npx

# Teams
agentSets:
  team:
    agents:
      coder: { description: "Writes code.", tools: [read] }

channels:
  # Where I run the house.
  ops:
    admin: true       # the admin
    description: |-
      Admin channel,
      two lines.
    tools: [read, write, bash]   # shell here
    envFile: ./secrets/ops.env

  "#engineering":   # the builders
    description: Build things   # keep this comment
    model: openai/gpt-5.4
    tools: [read, write, edit]   # no shell
    allowUsers: [U01ALICE1, U01BOB001]
    share:
      connectors: [github]
      knowledge: true

  CRANDOM1:
    description: Random

# trailing note
`;

/** The patched file must MEAN what was intended, and every line the edit did not touch must be byte-identical. */
function apply(edits: TextEdit[], text = FILE) {
  const patched = patchText(text, edits);
  assert.ok(
    isDeepStrictEqual(normalizeTree(parse(patched)), normalizeTree(expectedTree(text, edits))),
    `the patched file means something else:\n${patched}`,
  );
  return patched;
}

/** Lines present in the original and gone or changed in the result, and lines new in the result. */
function diff(before: string, after: string): { removed: string[]; added: string[] } {
  const b = before.split("\n"), a = after.split("\n");
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const cb = count(b), ca = count(a);
  const removed: string[] = [], added: string[] = [];
  for (const [line, n] of cb) for (let i = 0; i < n - (ca.get(line) ?? 0); i++) removed.push(line);
  for (const [line, n] of ca) for (let i = 0; i < n - (cb.get(line) ?? 0); i++) added.push(line);
  return { removed, added };
}

test("replacing a value changes that one line, keeps its trailing comment, and leaves every other byte alone", () => {
  const out = apply([{ path: ["channels", "#engineering", "model"], value: "openai/gpt-5.4-mini" }]);
  assert.deepEqual(diff(FILE, out), { removed: ["    model: openai/gpt-5.4"], added: ["    model: openai/gpt-5.4-mini"] });
  const commented = apply([{ path: ["defaults", "model"], value: "x/y" }]);
  assert.deepEqual(diff(FILE, commented), { removed: ["  model: deepseek-v4-pro   # the cheap one"], added: ["  model: x/y   # the cheap one"] }, "the spacing before the comment survives");
});

test("a list keeps the file's own style, a short list on one line", () => {
  const out = apply([{ path: ["channels", "#engineering", "tools"], value: ["read", "write", "edit", "grep"] }]);
  assert.deepEqual(diff(FILE, out), { removed: ["    tools: [read, write, edit]   # no shell"], added: ["    tools: [read, write, edit, grep]   # no shell"] });
});

test("adding a setting puts one new line after the channel's last, indented like its siblings", () => {
  const out = apply([{ path: ["channels", "#engineering", "thinkingLevel"], value: "high" }]);
  const d = diff(FILE, out);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added, ["      knowledge: true", "    thinkingLevel: high"].slice(1), "one line added");
  assert.ok(out.indexOf("    thinkingLevel: high") > out.indexOf("      knowledge: true"));
  assert.ok(out.indexOf("    thinkingLevel: high") < out.indexOf("  CRANDOM1:"), "inside the right channel");
});

test("adding to a section that is empty but for commented examples puts the entry under the key and keeps the examples", () => {
  const out = apply([{ path: ["connectors", "github"], value: { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } }]);
  assert.ok(out.includes("  # gmail:\n  #   transport: stdio\n  #   command: npx"), "the commented examples are intact");
  assert.match(out, /connectors:\n  github:\n    transport: http\n    url: https:\/\/mcp\.example\.com\/mcp\n    headers:\n      Authorization: Bearer \$\{GITHUB_TOKEN\}\n  # gmail:/);
  assert.deepEqual(diff(FILE, out).removed, []);
  // A second connector goes after the first, not in the middle of the comments.
  const two = apply([{ path: ["connectors", "linear"], value: { transport: "http", url: "https://mcp.linear.example/mcp" } }], out);
  assert.ok(two.indexOf("  linear:") > two.indexOf("  github:"));
  assert.ok(two.includes("  # gmail:\n"));
});

test("a setting under a section that does not exist yet creates the section", () => {
  const out = apply([{ path: ["channels", "CRANDOM1", "share", "connectors"], value: ["github"] }]);
  assert.match(out, /  CRANDOM1:\n    description: Random\n    share:\n      connectors: \[github\]\n/);
  assert.deepEqual(diff(FILE, out).removed, []);
});

test("a whole new top-level section goes after the last real setting, ahead of the file's closing comment, after a blank line", () => {
  const out = apply([{ path: ["notifications", "enabled"], value: true }]);
  assert.match(out, /    description: Random\n\nnotifications:\n  enabled: true\n\n# trailing note\n$/);
  assert.deepEqual(diff(FILE, out).removed, []);
  const empty = apply([{ path: ["name"], value: "Home" }], "");
  assert.equal(empty, "name: Home\n");
});

test("removing a setting removes only its lines and leaves the comments around it", () => {
  const out = apply([{ path: ["channels", "#engineering", "model"], remove: true }]);
  assert.deepEqual(diff(FILE, out), { removed: ["    model: openai/gpt-5.4"], added: [] });
  const block = apply([{ path: ["channels", "ops", "description"], remove: true }]);
  assert.deepEqual(diff(FILE, block).removed, ["    description: |-", "      Admin channel,", "      two lines."]);
  assert.deepEqual(apply([{ path: ["channels", "#engineering", "nothing-here"], remove: true }]), FILE, "removing what is not there changes nothing");
});

test("removing a whole channel's last setting, or a section's last entry, leaves a file that still parses", () => {
  const out = apply([{ path: ["channels", "CRANDOM1", "description"], remove: true }]);
  assert.match(out, /  CRANDOM1:\n/);
  const gone = apply([{ path: ["channels", "CRANDOM1"], remove: true }]);
  assert.ok(!gone.includes("CRANDOM1"));
});

test("a setting inside a flow map rewrites that one line and the rest of the file is untouched", () => {
  const out = apply([{ path: ["defaults", "sandbox", "network"], value: "bridge" }]);
  assert.deepEqual(diff(FILE, out).removed, ["  sandbox: { mode: docker, network: none }"]);
  assert.equal(diff(FILE, out).added.length >= 1, true);
  assert.deepEqual((parse(out) as { defaults: { sandbox: unknown } }).defaults.sandbox, { mode: "docker", network: "bridge" });
  const added = apply([{ path: ["agentSets", "team", "agents", "coder", "model"], value: "x/y" }]);
  assert.deepEqual((parse(added) as { agentSets: { team: { agents: { coder: unknown } } } }).agentSets.team.agents.coder, { description: "Writes code.", tools: ["read"], model: "x/y" });
});

test("root flow maps, including pretty-printed JSON, are refused with an actionable error", () => {
  const sources = [
    JSON.stringify({ channels: { eng: { description: "Old" } } }, null, 2),
    "{\n  channels: {\n    eng: { description: Old }\n  }\n}\n",
    "{ channels: { eng: { description: Old } } }\n",
    "{}\n",
  ];
  const edits: TextEdit[] = [
    { path: ["channels", "eng", "description"], value: "New" },
    { path: ["notifications", "enabled"], value: true },
    { path: ["channels", "eng"], remove: true },
    { path: ["channels"], value: { ops: { description: "New" } } },
  ];
  for (const source of sources) {
    for (const edit of edits) {
      assert.throws(
        () => patchText(source, [edit]),
        (error: unknown) => error instanceof PatchError && /root is a flow map.*convert.*block-style YAML/.test(error.message),
        "root flow maps must not return a potentially invalid proposal",
      );
    }
    assert.equal(patchText(source, []), source, "no edits leaves the text unchanged");
  }
});

test("nested multiline flow maps can be replaced, extended and removed without touching their surroundings", () => {
  const prefix = "# before\nname: Home   # untouched\n";
  const suffix = "\n# after\nnotifications: { enabled: true }\n";
  const sources = [
    "channels: {\n  eng: {\n    description: Old,\n    tools: [read, write]\n  },\n  ops: { description: Admin }\n}   # channels",
    "channels:\n  eng: {\n    description: Old,\n    tools: [read, write]\n  }\n  ops: { description: Admin }",
  ];
  const edits: TextEdit[] = [
    { path: ["channels", "eng", "description"], value: "New" },
    { path: ["channels", "eng", "share", "connectors"], value: ["github"] },
    { path: ["channels", "eng", "tools"], remove: true },
  ];
  for (const source of sources) {
    for (const eol of ["\n", "\r\n"]) {
      const text = (prefix + source + suffix).replace(/\n/g, eol);
      for (const edit of edits) apply([edit], text); // Each operation must work before the flow map becomes a block.
      const out = apply(edits, text);
      assert.ok(out.startsWith(prefix.replace(/\n/g, eol)));
      assert.ok(out.endsWith(suffix.replace(/\n/g, eol)));
      if (eol === "\r\n") assert.ok(!/[^\r]\n/.test(out));
      apply([{ path: ["channels", "eng"], remove: true }], text);
    }
  }
});

test("a multi-line text value is replaced as a block and a quoted key is kept as written", () => {
  const out = apply([{ path: ["channels", "ops", "description"], value: "One line now" }]);
  assert.match(out, /    description: One line now\n    tools:/);
  const quoted = apply([{ path: ["channels", "#engineering", "description"], value: "Builders" }]);
  assert.ok(quoted.includes('  "#engineering":   # the builders'), "the key and its comment are untouched");
});

test("several edits apply in order, each against the file the last one produced", () => {
  const out = apply([
    { path: ["connectors", "github"], value: { transport: "http", url: "https://mcp.example.com/mcp" } },
    { path: ["channels", "#engineering", "share", "connectors"], value: ["github", "linear"] },
    { path: ["channels", "CRANDOM1", "model"], value: "a/b" },
    { path: ["channels", "#engineering", "allowUsers"], remove: true },
  ]);
  const config = parse(out) as { channels: Record<string, Record<string, unknown>>; connectors: Record<string, unknown> };
  assert.deepEqual(config.channels["#engineering"]!.share, { connectors: ["github", "linear"], knowledge: true });
  assert.equal(config.channels.CRANDOM1!.model, "a/b");
  assert.ok(!("allowUsers" in config.channels["#engineering"]!));
  assert.ok("github" in config.connectors);
  assert.ok(out.includes("# The harness. Edited by hand.") && out.includes("# trailing note") && out.includes("# the cheap one") && out.includes("# shell here"));
});

test("a file with Windows line endings keeps them", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const out = patchText(crlf, [{ path: ["channels", "#engineering", "thinkingLevel"], value: "high" }]);
  assert.ok(!/[^\r]\n/.test(out), "every line still ends \\r\\n");
  assert.equal((parse(out) as { channels: Record<string, Record<string, unknown>> }).channels["#engineering"]!.thinkingLevel, "high");
});

test("what it cannot do exactly it refuses, instead of guessing", () => {
  const withList = "channels:\n  a:\n    items:\n      - name: x\n        v: 1\n";
  assert.throws(() => patchText(withList, [{ path: ["channels", "a", "items", "name"], value: "y" }]), PatchError);
  assert.throws(() => patchText("channels:\n  a: [unclosed\n", [{ path: ["name"], value: "x" }]), /does not parse as YAML/);
  assert.throws(() => patchText("a: scalar\n", [{ path: ["a", "b"], value: 1 }]), /not a map/);
});

test("values that need quoting are quoted, and a ${VAR} reference is written as plain text", () => {
  const out = apply([
    { path: ["channels", "CRANDOM1", "description"], value: "a: b # not a comment" },
    { path: ["channels", "CRANDOM1", "preferences"], value: "Line one\nLine two" },
    { path: ["channels", "CRANDOM1", "token"], value: "Bearer ${SOME_TOKEN}" },
  ]);
  const random = (parse(out) as { channels: { CRANDOM1: Record<string, string> } }).channels.CRANDOM1;
  assert.equal(random.description, "a: b # not a comment");
  assert.equal(random.preferences, "Line one\nLine two");
  assert.equal(random.token, "Bearer ${SOME_TOKEN}");
});
