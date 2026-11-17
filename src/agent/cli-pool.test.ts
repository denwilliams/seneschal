import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecTools } from "./exec-tools.ts";
import { workspaceFixture } from "../workspace/fixture.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { containerPathAliases } from "./skills.ts";

/**
 * Row 8: the optional global CLI pool (`cliTools` + `exec.shared`).
 * Defining a tool grants nothing; a channel gets exactly what it names; the
 * tools run on the HOST as `cli__<name>` regardless of sandbox mode, with
 * argv checked identically; nothing about them appears on any PATH or mount.
 */

const pool = {
  echoer: { description: "Echo with a fixed prefix.", command: "/bin/echo", args: ["fixed"], allowArgs: [["hello", "*"]] },
  secretive: {
    command: "/bin/sh",
    args: ["-c", 'echo "secret=[$POOL_SECRET] other=[$OTHER_SECRET]"'],
    allowArgs: [],
    env: { POOL_SECRET: "only-for-secretive" },
  },
  plain: { command: "/bin/sh", args: ["-c", 'echo "secret=[$POOL_SECRET]"'], allowArgs: [] },
};

function world(extra: Record<string, unknown> = {}) {
  return workspaceFixture({
    cliTools: pool,
    channels: {
      CON: { tools: ["exec", "bash"], exec: { shared: ["echoer", "secretive"] }, ...extra },
      COFF: { tools: ["exec", "bash"] },
      CNOEXEC: { exec: { shared: ["echoer"] } }, // names a tool but has no exec tool
    },
  });
}

const toolsOf = (c: ResolvedChannel) =>
  c.tools.includes("exec")
    ? createExecTools({ config: c.exec, cwd: c.paths.workspace, binDir: c.paths.bin, globalBinDir: c.globalBin, env: c.env })
    : [];
const call = async (c: ResolvedChannel, name: string, args: string[] = []) =>
  (await (toolsOf(c).find((t) => t.name === `cli__${name}`) as any).execute("t", { args })).content[0].text as string;

test("an unconfigured channel cannot resolve or run a pool tool, by tool, PATH or mount", () => {
  const f = world();
  const off = f.resolve("COFF");
  assert.deepEqual(Object.keys(off.exec.commands), []);
  assert.deepEqual(toolsOf(off).map((t) => t.name), []);
  // a channel that names a tool but has no `exec` tool in its list still gets nothing
  const noExec = f.resolve("CNOEXEC");
  assert.deepEqual(toolsOf(noExec).map((t) => t.name), []);
  // no PATH entry or container mount exists for any pool tool, on or off
  for (const c of [off, f.resolve("CON")]) {
    assert.ok(!c.containerMounts.some((m) => /pool|echoer|secretive/.test(m.hostPath + m.containerPath)));
    assert.ok(!containerPathAliases(c).some((a) => /pool|echoer|secretive/.test(a.from)));
    assert.ok(!c.env.PATH?.includes("echoer"));
  }
});

test("a configured channel gets exactly the tools it names, and not the rest of the pool", () => {
  const f = world();
  const on = f.resolve("CON");
  assert.deepEqual(toolsOf(on).map((t) => t.name).sort(), ["cli__echoer", "cli__secretive"]);
  assert.ok(!toolsOf(on).some((t) => t.name === "cli__plain"), "defining plain granted it to nobody");
});

test("allowArgs is enforced and the fixed argv prefix always applies", async () => {
  const f = world();
  const on = f.resolve("CON");
  assert.match(await call(on, "echoer", ["hello", "world"]), /exit: 0[\s\S]*fixed hello world/);
  for (const bad of [["goodbye", "world"], ["hello"], ["hello", "a", "b"], ["--version"]]) {
    await assert.rejects(() => call(on, "echoer", bad), /Arguments refused/, JSON.stringify(bad));
  }
  // supplying nothing just runs the fixed argv, which is the operator's own command line
  assert.match(await call(on, "echoer"), /exit: 0[\s\S]*fixed/);
  // no allowArgs at all means no supplied args are accepted
  await assert.rejects(() => call(on, "secretive", ["x"]), /Arguments refused/);
});

test("one tool's env is not visible to another, nor to the channel's other processes", async () => {
  const f = world();
  const on = f.resolve("CON");
  const out = await call(on, "secretive");
  assert.match(out, /secret=\[only-for-secretive\]/);
  assert.match(out, /other=\[\]/);
  assert.equal(on.env.POOL_SECRET, undefined, "per-tool env does not leak into the channel bundle");
  // another channel that names `plain` does not see secretive's env
  f.reconfigure({ cliTools: pool, channels: { CON: { tools: ["exec"], exec: { shared: ["plain"] } } } });
  assert.match(await call(f.resolve("CON"), "plain"), /secret=\[\]/);
});

test("pool tools are host-executed and available to a docker-sandboxed channel's agent", async () => {
  const f = world({ sandbox: { mode: "docker" } });
  const on = f.resolve("CON");
  assert.equal(on.sandbox.mode, "docker");
  // The agent invokes cli__<name>; the harness runs it on the host in the host workspace.
  const out = await call(on, "echoer", ["hello", "from-docker-channel"]);
  assert.match(out, /fixed hello from-docker-channel/);
  assert.match(out, /exit: 0/);
});

test("removing a tool from config revokes it on the next resolve; unknown names are a config error", () => {
  const f = world();
  assert.deepEqual(Object.keys(f.resolve("CON").exec.commands).sort(), ["echoer", "secretive"]);
  f.reconfigure({ cliTools: pool, channels: { CON: { tools: ["exec"], exec: { shared: ["echoer"] } } } });
  assert.deepEqual(Object.keys(f.resolve("CON").exec.commands), ["echoer"]);
  f.reconfigure({ cliTools: pool, channels: { CON: { tools: ["exec"] } } });
  assert.deepEqual(Object.keys(f.resolve("CON").exec.commands), []);
  // The pool entry itself being deleted while a channel still names it never validates.
  assert.throws(
    () => f.reconfigure({ cliTools: { plain: pool.plain }, channels: { CON: { exec: { shared: ["echoer"] } } } }),
    /no account-wide cliTools entry named/,
  );
});
