import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { channelPathEnv } from "./sandbox.ts";
import { createExecTools } from "./exec-tools.ts";
import { createSharedToolTools } from "./shared-tool-tools.ts";
import { publishSharedTool } from "./shared-bin.ts";
import { workspaceFixture } from "../workspace/fixture.ts";
import { checkPath } from "./jail.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * Rows 6 and 7, host side: every route that runs a command for a channel
 * resolves bare names through channel bin, then the operator's global bin, then
 * the system — and a channel cannot reach another channel's bin or write the
 * global one.
 */

const sh = (path: string, body: string, mode = 0o755) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
};

function world() {
  const f = workspaceFixture({
    channels: {
      C1: { tools: ["bash", "exec"], exec: { commands: {
        chan: { command: "chan-tool", allowArgs: [["**"]] },
        glob: { command: "global-tool", allowArgs: [["**"]] },
        both: { command: "both", allowArgs: [] },
        other: { command: "c2-tool", allowArgs: [] },
        missing: { command: "no-such-tool", allowArgs: [] },
      } } },
      C2: { tools: ["bash"] },
      C3: { tools: ["bash"] },
    },
  });
  const c1 = f.resolve("C1");
  const c2 = f.resolve("C2");
  const c3 = f.resolve("C3");
  sh(join(f.shared.globalBin, "global-tool"), 'echo "global-ran $*"');
  sh(join(f.shared.globalBin, "both"), "echo both-from-global");
  sh(join(c1.paths.bin, "both"), "echo both-from-channel");
  sh(join(c1.paths.bin, "chan-tool"), 'echo "chan-ran $*"');
  sh(join(c1.paths.bin, "plain-file"), "echo nope", 0o644);
  sh(join(c2.paths.bin, "c2-tool"), "echo c2-ran");
  return { f, c1, c2, c3 };
}

const bash = (c: ResolvedChannel) =>
  createBashToolDefinition(c.paths.workspace, {
    spawnHook: (ctx) => ({ ...ctx, env: channelPathEnv(c) }),
  });

async function runBash(c: ResolvedChannel, command: string): Promise<string> {
  try {
    const res = await (bash(c) as any).execute("t", { command }, undefined, undefined, undefined as any);
    return res.content.map((p: any) => p.text).join("");
  } catch (err) {
    return String(err instanceof Error ? err.message : err);
  }
}

test("host bash: channel bin, then global bin, then system, by bare name", async () => {
  const { c1 } = world();
  const out = await runBash(c1, "chan-tool a; global-tool b; both; command -v ls >/dev/null && echo system-ok");
  assert.deepEqual(out.trim().split("\n"), ["chan-ran a", "global-ran b", "both-from-channel", "system-ok"]);
  const path = (await runBash(c1, "echo $PATH")).trim().split(":");
  assert.deepEqual(path.slice(0, 2), [c1.paths.bin, c1.globalBin]);
});

test("host bash: the global bin is present with no channel config at all; another channel's bin is not on PATH", async () => {
  const { c3 } = world();
  assert.match(await runBash(c3, "global-tool x"), /global-ran x/);
  assert.match(await runBash(c3, "both"), /both-from-global/);
  const out = await runBash(c3, "c2-tool; echo code=$?");
  assert.match(out, /not found|code=127/);
  assert.ok(!(await runBash(c3, "echo $PATH")).includes("C2"));
});

test("host bash: absent tool is command-not-found, a non-executable file is a clear error", async () => {
  const { c1 } = world();
  assert.match(await runBash(c1, "no-such-tool; echo code=$?"), /not found[\s\S]*code=127|code=127/);
  const out = await runBash(c1, "plain-file; echo code=$?");
  assert.match(out, /Permission denied|not found/i);
  assert.doesNotMatch(out, /code=0/);
});

test("exec tools resolve bare names through channel bin then global bin, and no other channel's bin", async () => {
  const { c1 } = world();
  const tools = createExecTools({ config: c1.exec, cwd: c1.paths.workspace, binDir: c1.paths.bin, globalBinDir: c1.globalBin, env: c1.env });
  const call = async (name: string, args: string[] = []) =>
    (await (tools.find((t) => t.name === `cli__${name}`) as any).execute("t", { args })).content[0].text as string;
  assert.match(await call("chan", ["a"]), /chan-ran a/);
  assert.match(await call("glob", ["b"]), /global-ran b/);
  assert.match(await call("both"), /both-from-channel/);
  assert.match(await call("other"), /failed to start c2-tool|ENOENT/);
  assert.match(await call("missing"), /failed to start no-such-tool|ENOENT/);
});

test("shared tools run with channel bin, then global bin on PATH", async () => {
  const { f, c1 } = world();
  const publisher = f.resolve("C2");
  publishSharedTool(f.shared, publisher, {
    name: "calls-global",
    description: "Calls a global tool by bare name.",
    content: "#!/bin/sh\nglobal-tool from-shared-tool\n",
  });
  c1.sharedTools.execute["calls-global"] = { allowArgs: [], env: {}, timeoutSeconds: 5, maxOutputBytes: 10_000 };
  const [tool] = createSharedToolTools({ channel: c1, cwd: c1.paths.workspace });
  const out = (await (tool as any).execute("t", {})).content[0].text as string;
  assert.match(out, /global-ran from-shared-tool/);
});

test("the global bin and other channels' bins are not writable through the file-tool jail; own bin is", () => {
  const { f, c1, c2 } = world();
  const jail = { readRoots: c1.jail.readRoots, writeRoots: c1.jail.writeRoots, cwd: c1.paths.workspace };
  assert.equal(checkPath(jail, join(f.shared.globalBin, "global-tool"), "write").allowed, false);
  assert.equal(checkPath(jail, join(f.shared.globalBin, "new-tool"), "write").allowed, false);
  assert.equal(checkPath(jail, join(f.shared.globalBin, "global-tool"), "read").allowed, true, "the agent may look at what is installed");
  assert.equal(checkPath(jail, join(c2.paths.bin, "c2-tool"), "read").allowed, false);
  assert.equal(checkPath(jail, join(c2.paths.bin, "c2-tool"), "write").allowed, false);
  assert.equal(checkPath(jail, join(c1.paths.bin, "new"), "write").allowed, true);
  assert.ok(!c1.jail.writeRoots.includes(f.shared.globalBin));
  // the agent-published shared/bin is a different thing and is in nobody's jail
  assert.equal(checkPath(jail, join(f.shared.bin, "x"), "read").allowed, false);
  assert.notEqual(f.shared.globalBin, f.shared.bin);
});
