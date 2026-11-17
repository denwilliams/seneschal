import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedToolTools, sharedExecuteToolName } from "./shared-tool-tools.ts";
import { publishSharedTool } from "./shared-bin.ts";
import { ensureSharedDirs, type SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { SharedToolConfig } from "../config/schema.ts";

/**
 * Tool-level behaviour for the shared bin: publishing is offered only with
 * permission, execution is only ever what a channel's own `share.sharedTools`
 * names, and the argv/sha256 checks refuse before anything is spawned.
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-shared-tool-tools-"));
  const shared: SharedPaths = ensureSharedDirs(root);
  const cwd = realpathSync(root);

  function channel(opts: {
    id: string;
    name: string;
    canPublish?: boolean;
    execute?: Record<string, SharedToolConfig>;
  }): ResolvedChannel {
    return {
      ref: { id: opts.id, name: opts.name, isDm: false },
      shared,
      env: { PATH: process.env.PATH ?? "" },
      paths: { bin: join(root, "channels", opts.id, "workspace", "bin") },
      sharedTools: { canPublish: opts.canPublish ?? false, execute: opts.execute ?? {} },
    } as unknown as ResolvedChannel;
  }

  return { root, shared, cwd, channel };
}

function policy(overrides: Partial<SharedToolConfig> = {}): SharedToolConfig {
  return { allowArgs: [], env: {}, timeoutSeconds: 5, maxOutputBytes: 10_000, ...overrides };
}

// Shebang points straight at the running node binary (no PATH lookup, no
// `env` indirection), so the test does not depend on how the host's PATH is set up.
const SCRIPT = `#!${process.execPath}\nconsole.log(JSON.stringify({argv: process.argv.slice(2)}));\n`;

async function run(tool: any, params: unknown): Promise<string> {
  const result = await tool.execute("test", params);
  return result.content[0].text;
}

test("publishing tools are offered only with sharedToolsPublish, execution tools only from share.sharedTools", () => {
  const { channel, cwd } = setup();

  const closed = channel({ id: "C1", name: "closed" });
  assert.deepEqual(createSharedToolTools({ channel: closed, cwd }).map((t) => t.name), []);

  const publisher = channel({ id: "C2", name: "ops", canPublish: true });
  const publisherNames = createSharedToolTools({ channel: publisher, cwd }).map((t) => t.name);
  assert.deepEqual(
    publisherNames.sort(),
    ["list_shared_tools", "publish_shared_tool", "read_shared_tool", "unpublish_shared_tool"].sort(),
  );

  const consumer = channel({ id: "C3", name: "home", execute: { "deploy-notify": policy() } });
  const consumerTools = createSharedToolTools({ channel: consumer, cwd }).map((t) => t.name);
  assert.deepEqual(consumerTools, [sharedExecuteToolName("deploy-notify")]);
});

test("publishing does not expose execution to the publishing channel itself", async () => {
  const { channel, cwd } = setup();
  const ops = channel({ id: "C-OPS", name: "ops", canPublish: true });

  const tools = createSharedToolTools({ channel: ops, cwd });
  const publish = tools.find((t) => t.name === "publish_shared_tool")!;
  const result = await run(publish, { name: "deploy-notify", description: "Notifies of a deploy.", content: SCRIPT });
  assert.match(result, /runs nowhere yet/);

  // Publishing alone creates no shared__ tool for this channel's own session,
  // even though it can now see the entry via list_shared_tools/read_shared_tool.
  assert.deepEqual(
    createSharedToolTools({ channel: ops, cwd })
      .map((t) => t.name)
      .filter((n) => n.startsWith("shared__")),
    [],
  );
});

test("a configured shared tool runs the published script directly, with argv checked", async () => {
  const { channel, shared, cwd } = setup();
  const ops = channel({ id: "C-OPS", name: "ops", canPublish: true });
  publishSharedTool(shared, ops, { name: "greet", description: "Greets someone.", content: SCRIPT });

  const consumer = channel({
    id: "C-HOME",
    name: "home",
    execute: { greet: policy({ allowArgs: [["--name", "*"]] }) },
  });
  const [tool] = createSharedToolTools({ channel: consumer, cwd });
  assert.equal(tool?.name, sharedExecuteToolName("greet"));

  const out = await run(tool, { args: ["--name", "Ada"] });
  assert.match(out, /exit: 0/);
  assert.match(out, /"argv":\["--name","Ada"\]/);

  await assert.rejects(() => run(tool, { args: ["--name", "Ada", "--extra"] }), /Arguments refused/);
});

test("a shared tool configured but never published fails clearly", async () => {
  const { channel, cwd } = setup();
  const consumer = channel({ id: "C-HOME", name: "home", execute: { "not-yet": policy() } });
  const [tool] = createSharedToolTools({ channel: consumer, cwd });

  await assert.rejects(() => run(tool, {}), /No shared tool called/);
});

test("a sha256 pin refuses to run a script that has changed since", async () => {
  const { channel, shared, cwd } = setup();
  const ops = channel({ id: "C-OPS", name: "ops", canPublish: true });
  const entry = publishSharedTool(shared, ops, { name: "greet", description: "x", content: SCRIPT });

  const consumer = channel({
    id: "C-HOME",
    name: "home",
    execute: { greet: policy({ sha256: entry.sha256 }) },
  });
  const [tool] = createSharedToolTools({ channel: consumer, cwd });

  assert.match(await run(tool, {}), /exit: 0/);

  publishSharedTool(shared, ops, {
    name: "greet",
    description: "x",
    content: `#!${process.execPath}\nconsole.log("changed");\n`,
  });

  await assert.rejects(() => run(tool, {}), /Refusing to run an unreviewed update/);
});
