import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, parseConfigText } from "./load.ts";
import { CAPABILITIES } from "../agent/grants.ts";

/**
 * Documentation that does not compile.
 *
 * Config examples drift silently: a key gets renamed and the README keeps
 * telling people to use the old one. Every YAML block in the docs that starts
 * at a top-level key is parsed against the real schema, so a rename breaks the
 * build instead of quietly misleading someone.
 */

const TOP_LEVEL = [
  "name:",
  "dataDir:",
  "documentsDir:",
  "authPath:",
  "envFile:",
  "connectors:",
  "cliTools:",
  "modelProviders:",
  "agentSets:",
  "knowledgeBases:",
  "librarian:",
  "defaults:",
  "requires:",
  "channels:",
  "channelTopicUsage:",
  "schedules:",
  "dreams:",
  "backups:",
  "notifications:",
  "shortcuts:",
  "feedback:",
  "artifacts:",
  "ui:",
  "allowUnconfiguredChannels:",
  "allowDirectMessages:",
];

function yamlBlocks(markdown: string): { block: string; line: number }[] {
  const out: { block: string; line: number }[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== "```yaml") continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end]?.trim() !== "```") end++;
    out.push({ block: lines.slice(start, end).join("\n"), line: start + 1 });
    i = end;
  }
  return out;
}

/** Only blocks that begin at a top-level key are complete enough to validate. */
function isFullConfig(block: string): boolean {
  const first = block.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
  return Boolean(first && TOP_LEVEL.some((k) => first.startsWith(k)));
}

function checkFile(path: string) {
  const markdown = readFileSync(path, "utf-8");
  const blocks = yamlBlocks(markdown).filter((b) => isFullConfig(b.block));
  assert.ok(blocks.length > 0, `${path} has no complete config examples to check`);

  for (const { block, line } of blocks) {
    // ${VAR} placeholders are expanded from the environment at load time, so
    // give the documented ones a value rather than failing on the example.
    process.env.GITHUB_TOKEN ??= "example";
    process.env.GITHUB_MCP_TOKEN ??= "example";
    process.env.GMAIL_TOKEN ??= "example";
    process.env.ACLI_TOKEN ??= "example";
    process.env.OPENAI_API_KEY ??= "example";
    try {
      parseConfigText(block, `${path}:${line}`);
    } catch (err) {
      assert.fail((err as Error).message);
    }
  }
}

test("every complete config example in the README is valid", () => {
  checkFile(join(REPO_ROOT, "README.md"));
});

test("every complete config example in RECIPES.md is valid", () => {
  // The recipes are the examples people copy, so they matter most.
  checkFile(join(REPO_ROOT, "RECIPES.md"));
});

test("the shipped example config is valid", () => {
  const raw = readFileSync(join(REPO_ROOT, "config/harness.example.yaml"), "utf-8");
  parseConfigText(raw, "config/harness.example.yaml");
});

test("the QA Playwright example is a named, narrowly allowlisted exec command", () => {
  const raw = readFileSync(join(REPO_ROOT, "config/harness.example.yaml"), "utf-8");
  const config = parseConfigText(raw, "config/harness.example.yaml");
  const qa = config.channels.qa;
  const playwright = qa?.exec?.commands?.playwright;

  assert.ok(qa?.tools?.includes("exec"));
  assert.ok(qa?.requires.binaries.includes("playwright-cli"));
  assert.equal(playwright?.command, "/app/node_modules/.bin/playwright-cli");
  assert.deepEqual(playwright?.args, ["-s=harness-qa"]);
  assert.equal(playwright?.env.PWTEST_CLI_GLOBAL_CONFIG, "/app");
  assert.ok(playwright?.allowArgs.some((pattern) => pattern.join(" ") === "open *"));
  assert.ok(playwright?.allowArgs.some((pattern) => pattern.join(" ") === "screenshot"));
  assert.ok(playwright?.allowArgs.every((pattern) => !pattern.includes("**")));
  for (const denied of ["eval", "run-code", "upload", "drop", "state-load", "attach", "close-all", "kill-all"]) {
    assert.ok(
      playwright?.allowArgs.every((pattern) => pattern[0] !== denied),
      `QA Playwright policy must not expose ${denied}`,
    );
  }
});

test("documented capabilities are ones the schema actually accepts", () => {
  // The examples name capabilities in permissions.grantable; a typo there is
  // invisible until someone tries to use it.
  const markdown =
    readFileSync(join(REPO_ROOT, "README.md"), "utf-8") +
    readFileSync(join(REPO_ROOT, "RECIPES.md"), "utf-8");
  // Derived rather than restated: a hand-kept copy of the list is one more
  // thing to forget, and it has already been forgotten once per capability.
  const known = new Set<string>(CAPABILITIES);
  for (const match of markdown.matchAll(/grantable:\s*\[([^\]]*)\]/g)) {
    for (const raw of match[1]!.split(",")) {
      const name = raw.trim();
      if (!name) continue;
      assert.ok(
        known.has(name) || name.startsWith("connector:"),
        `README documents an unknown capability "${name}"`,
      );
    }
  }
});
