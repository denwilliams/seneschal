import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecTools } from "./exec-tools.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRegistry } from "../workspace/registry.ts";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "harness-exec-"));
  mkdirSync(join(dir, "bin"));
  return dir;
}

async function run(tool: any, params: unknown): Promise<string> {
  const result = await tool.execute("test", params);
  return result.content[0].text;
}

test("restricted cli tool runs a configured command without a shell", async () => {
  const cwd = realpathSync(workspace());
  const script = join(cwd, "print.mjs");
  writeFileSync(
    script,
    "console.log(JSON.stringify({argv: process.argv.slice(2), token: process.env.TOKEN, cwd: process.cwd()}));\n",
  );

  const [tool] = createExecTools({
    cwd,
    binDir: join(cwd, "bin"),
    env: { PATH: process.env.PATH ?? "", TOKEN: "channel" },
    config: {
      commands: {
        acli: {
          description: "test cli",
          command: process.execPath,
          args: [script],
          allowArgs: [["issue", "view", "*"], ["issue", "search", "**"]],
          allowAllArgs: false,
          env: { TOKEN: "command" },
          timeoutSeconds: 5,
          maxOutputBytes: 10_000,
        },
      },
    },
  });

  assert.equal(tool?.name, "cli__acli");
  const out = await run(tool, { args: ["issue", "view", "ABC-1"] });
  assert.match(out, /exit: 0/);
  assert.match(out, /"argv":\["issue","view","ABC-1"\]/);
  assert.match(out, /"token":"command"/);
  assert.match(out, new RegExp(`"cwd":"${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
});

test("restricted cli tool refuses argv outside the allowlist", async () => {
  const cwd = workspace();
  const [tool] = createExecTools({
    cwd,
    binDir: join(cwd, "bin"),
    env: { PATH: process.env.PATH ?? "" },
    config: {
      commands: {
        acli: {
          description: "test cli",
          command: process.execPath,
          args: ["-e", "console.log('should not run')"],
          allowArgs: [["issue", "view", "*"]],
          allowAllArgs: false,
          env: {},
          timeoutSeconds: 5,
          maxOutputBytes: 10_000,
        },
      },
    },
  });

  await assert.rejects(
    () => run(tool, { args: ["admin", "delete", "everything"] }),
    /Arguments refused/,
  );
});

test("restricted cli tool refuses option-shaped values in a wildcard slot", async () => {
  const cwd = workspace();
  const [tool] = createExecTools({
    cwd,
    binDir: join(cwd, "bin"),
    env: { PATH: process.env.PATH ?? "" },
    config: {
      commands: {
        playwright: {
          description: "test cli",
          command: process.execPath,
          args: ["-e", "console.log('should not run')"],
          allowArgs: [["open", "*"]],
          allowAllArgs: false,
          env: {},
          timeoutSeconds: 5,
          maxOutputBytes: 10_000,
        },
      },
    },
  });

  await assert.rejects(
    () => run(tool, { args: ["open", "--config=/tmp/evil.json"] }),
    /Arguments refused/,
  );
  await assert.rejects(() => run(tool, { args: ["open", "--headed"] }), /Arguments refused/);
});

test("restricted cli tool accepts no extra args when allowArgs is empty", async () => {
  const cwd = workspace();
  const [tool] = createExecTools({
    cwd,
    binDir: join(cwd, "bin"),
    env: { PATH: process.env.PATH ?? "" },
    config: {
      commands: {
        node_version: {
          description: "node version",
          command: process.execPath,
          args: ["--version"],
          allowArgs: [],
          allowAllArgs: false,
          env: {},
          timeoutSeconds: 5,
          maxOutputBytes: 10_000,
        },
      },
    },
  });

  assert.match(await run(tool, {}), /exit: 0/);
  await assert.rejects(() => run(tool, { args: ["--eval", "console.log(1)"] }), /Arguments refused/);
});

test("whole-CLI access accepts flags and literal shell syntax only for the opted-in executable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-whole-cli-"));
  const fixed = ["-e", "console.log(JSON.stringify({argv: process.argv.slice(1), token: process.env.TOKEN}))", "--", "fixed-prefix"];
  const config = HarnessConfigSchema.parse({
    cliTools: {
      mycli: { command: process.execPath, args: fixed, allowAllArgs: true, allowArgs: [["status"]], env: { TOKEN: "${WHOLE_CLI_TOKEN}" } },
      restricted: { command: process.execPath, args: fixed, allowArgs: [["**"]] },
      unused: { command: "never-run", allowAllArgs: true, env: { TOKEN: "${MISSING_WHOLE_CLI_SECRET}" } },
    },
    channels: {
      trusted: { tools: ["exec"], exec: { shared: ["mycli", "restricted"] } },
      qa: { tools: ["exec"], exec: { shared: ["mycli"] } },
      observer: { tools: ["exec"] },
    },
  });
  const registry = new ChannelRegistry(dataDir);
  for (const name of ["trusted", "qa"]) {
    const id = `C${name}`;
    const channelDir = join(dataDir, "channels", id);
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "env"), `WHOLE_CLI_TOKEN=${name}-secret\n`);
    const channel = resolveChannel(config, dataDir, { id, name, isDm: false }, registry).channel!;
    assert.equal(channel.exec.commands.mycli?.allowAllArgs, true);
    const tools = createExecTools({ config: channel.exec, cwd: channel.paths.workspace, binDir: channel.paths.bin, env: channel.env });
    assert.deepEqual(tools.map((tool) => tool.name), name === "trusted" ? ["cli__mycli", "cli__restricted"] : ["cli__mycli"]);
    const tool = tools.find((tool) => tool.name === "cli__mycli")!;
    assert.match(tool.description, /all supplied arguments, including flags/);
    assert.match(tool.description, /allowArgs is ignored/);
    for (const args of [[], ["--help"], ["a", "b", "c"], ["a", "b", "c", "--json"], ["--", "-x"], [";", "$(echo injected)", "|", ">", "*"]]) {
      const output = await run(tool, { args });
      assert.match(output, /exit: 0/);
      const body = JSON.parse(output.split("\n\n")[1]!);
      assert.deepEqual(body, { argv: ["fixed-prefix", ...args], token: `${name}-secret` });
    }
    await assert.rejects(() => run(tool, { args: "--help" }), /array of strings/);
    await assert.rejects(() => run(tool, { args: [1] }), /array of strings/);
    const restricted = tools.find((tool) => tool.name === "cli__restricted");
    if (restricted) {
      assert.match(restricted.description, /positional tokens only, never flags/);
      assert.match(await run(restricted, { args: ["a", "b", "c"] }), /exit: 0/);
      assert.match(await run(restricted, {}), /exit: 0/);
      for (const args of [["--help"], ["a", "b", "c", "--json"], ["-x"]]) {
        await assert.rejects(() => run(restricted, { args }), /positional tokens only, never flags.*allowlist the option as a literal.*allowAllArgs: true/);
      }
    }
  }
  const observer = resolveChannel(config, dataDir, { id: "COBSERVER", name: "observer", isDm: false }, registry).channel!;
  assert.deepEqual(Object.keys(observer.exec.commands), []);
});

test("resolved shared CLIs retain direct execution, per-channel secrets and argv restrictions", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-shared-exec-"));
  const config = HarnessConfigSchema.parse({
    cliTools: {
      status: {
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({argv: process.argv.slice(1), token: process.env.TOKEN}))", "--"],
        env: { TOKEN: "${SHARED_CLI_TEST_TOKEN}" },
        allowArgs: [["--environment", "staging"]],
      },
      unused: { command: "never-run", env: { TOKEN: "${MISSING_UNSELECTED_CLI_SECRET}" } },
    },
    defaults: { exec: { commands: { version: { command: process.execPath, args: ["--version"] } } } },
    channels: {
      release: { tools: ["exec"], exec: { shared: ["status"] } },
      qa: { tools: ["exec"], exec: { shared: ["status"] } },
      observer: { tools: ["exec"] },
    },
  });
  const registry = new ChannelRegistry(dataDir);
  for (const [name, id, token] of [["release", "CRELEASE", "release-secret"], ["qa", "CQA", "qa-secret"]] as const) {
    const channelDir = join(dataDir, "channels", id);
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(join(channelDir, "env"), `SHARED_CLI_TEST_TOKEN=${token}\n`);
    const channel = resolveChannel(config, dataDir, { id, name, isDm: false }, registry).channel!;
    const tools = createExecTools({
      config: channel.exec,
      cwd: channel.paths.workspace,
      binDir: channel.paths.bin,
      env: channel.env,
    });
    assert.deepEqual(tools.map((tool) => tool.name), ["cli__version", "cli__status"]);
    const tool = tools.find((tool) => tool.name === "cli__status")!;
    const output = await run(tool, { args: ["--environment", "staging"] });
    assert.match(output, /exit: 0/);
    assert.ok(output.includes(`"token":"${token}"`));
    assert.ok(output.includes('"argv":["--environment","staging"]'));
    await assert.rejects(() => run(tool, { args: ["--environment", "production"] }), /Arguments refused/);
  }
  const observer = resolveChannel(config, dataDir, { id: "COBSERVER", name: "observer", isDm: false }, registry).channel!;
  assert.deepEqual(Object.keys(observer.exec.commands), ["version"]);
});
