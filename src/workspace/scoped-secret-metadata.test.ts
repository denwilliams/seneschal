import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { KeychainClient } from "../config/keychain.ts";
import { initializeOpenBao } from "../config/openbao.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { containerEnvironment } from "../agent/sandbox.ts";
import { runRestrictedCommandDetailed } from "../agent/restricted-exec.ts";
import { ChannelRegistry } from "./registry.ts";
import { resolveChannel } from "./resolve.ts";

for (const backend of ["openbao", "keychain", "combined"] as const) {
  test(`${backend}: scoped secrets reach execution environments, not prompt/tool metadata`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "scoped-metadata-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, "synthetic-bootstrap", { mode: 0o600 });
    const bao = backend !== "keychain";
    const kc = backend !== "openbao";
    const names = [...(bao ? ["OPEN_GLOBAL", "OPEN_LOCAL"] : []), ...(kc ? ["KC_GLOBAL", "KC_LOCAL"] : [])];
    const values = Object.fromEntries(names.map((name) => [name, `synthetic-${name}-secret-not-for-prompts`]));
    t.mock.method(KeychainClient.prototype, "read", (_principal: unknown, _scope: unknown, name: string) => values[name]!);
    const metadata = "Keep literal " + names.map((name) => "${" + name + "}").join(" ");
    const deliveryEnv = Object.fromEntries(names.map((name) => ["DELIVERED_" + name, "${" + name + "}"]));
    const script = `console.log(JSON.stringify(${JSON.stringify(names)}.map(name => Boolean(process.env[name]) && process.env[name] === process.env["DELIVERED_" + name])));`;
    const command = { command: process.execPath, args: ["-e", script], description: metadata, allowArgs: [[metadata]], env: deliveryEnv };
    const config = HarnessConfigSchema.parse({
      ...(bao ? { openbao: { address: "http://127.0.0.1:1", tokenFile, globalChannel: ["OPEN_GLOBAL"], channels: { C1: ["OPEN_LOCAL"] } } } : {}),
      ...(kc ? { keychain: { helperPath: "/private/helper", globalChannel: ["KC_GLOBAL"], channels: { C1: ["KC_LOCAL"] } } } : {}),
      defaults: { tools: [], exec: { commands: { inherited: command } } },
      cliTools: { pooled: command },
      connectors: { api: { transport: "http", url: "https://example.test", description: metadata, headers: deliveryEnv } },
      channels: { C1: {
        exec: { shared: ["pooled"], commands: { local: command } },
        share: { connectors: ["api"] },
        connectors: { child: { transport: "stdio", command: process.execPath, args: ["--version"], description: metadata, env: deliveryEnv } },
      } },
    });
    const before = { ...process.env };
    await initializeOpenBao(config, { fetch: async (url) => Response.json({ data: { data: { value: values[String(url).split("/").at(-1)!] } } }) });
    const dataDir = join(root, "data");
    const registry = new ChannelRegistry(dataDir);
    const channel = resolveChannel(config, dataDir, { id: "C1", isDm: false }, registry).channel!;
    for (const [name, secret] of Object.entries(values)) {
      assert.equal(channel.env[name], secret);
      for (const connector of channel.connectors) {
        const delivered = connector.config.transport === "http" ? connector.config.headers : connector.config.env;
        assert.equal(delivered["DELIVERED_" + name], secret);
      }
      for (const resolved of Object.values(channel.exec.commands)) assert.equal(resolved.env["DELIVERED_" + name], secret);
    }
    assert.deepEqual(channel.connectors.map((c) => c.config.description), [metadata, metadata]);
    for (const resolved of Object.values(channel.exec.commands)) {
      assert.equal(resolved.description, metadata);
      assert.deepEqual(resolved.allowArgs, [[metadata]]);
    }
    // Host CLI/shared-tool execution is now forbidden. Inactive CLI definitions still
    // resolve without leaking secrets into metadata; connector transports remain trusted.
    assert.ok(!channel.tools.includes("exec"));
    const prompt = buildSystemPrompt(channel, { harnessName: "test", slackChannelLabel: "C1", botUserId: "bot" });
    assert.ok(prompt.includes(metadata), "connector descriptions stay literal in the actual prompt");
    const child = await runRestrictedCommandDetailed({ command: process.execPath, argv: ["-e", script],
      cwd: channel.paths.workspace, env: { ...containerEnvironment(channel.env), ...channel.exec.commands.local!.env }, timeoutSeconds: 5, maxOutputBytes: 10000 });
    assert.ok(child.output.includes(JSON.stringify(names.map(() => true))), "explicitly delivered child environment still works");
    const visible = JSON.stringify([prompt, Object.values(channel.exec.commands).map(({ description, allowArgs }) => ({ description, allowArgs }))]);
    for (const secret of Object.values(values)) assert.ok(!visible.includes(secret), "no imported secret in model-visible metadata");
    assert.deepEqual({ ...process.env }, before);

    // Fixed CLI argv is also printed in tool descriptions (and connector argv in process listings).
    // Reject either backend's imported values there without echoing the secret in the error.
    for (const name of names) {
      for (const target of ["cli-command", "cli-args", "connector-command", "connector-args"]) {
        await t.test(`${target} rejects ${name}`, () => {
          const entry = config.channels.C1!;
          const cli = entry.exec!.commands!.local!;
          const connector = entry.connectors.child!;
          assert.equal(connector.transport, "stdio");
          if (connector.transport !== "stdio") throw new Error("expected stdio");
          const original = target === "cli-command" ? cli.command : target === "cli-args" ? cli.args : target === "connector-command" ? connector.command : connector.args;
          try {
            const placeholder = "${" + name + "}";
            if (target === "cli-command") cli.command = placeholder;
            else if (target === "cli-args") cli.args = [placeholder];
            else if (target === "connector-command") connector.command = placeholder;
            else connector.args = [placeholder];
            assert.throws(() => resolveChannel(config, dataDir, { id: "C1", isDm: false }, registry), (error: Error) => {
              assert.match(error.message, /cannot be used in subprocess commands or arguments/);
              assert.ok(!error.message.includes(values[name]!));
              return true;
            });
          } finally {
            if (target === "cli-command") cli.command = original as string;
            else if (target === "cli-args") cli.args = original as string[];
            else if (target === "connector-command") connector.command = original as string;
            else connector.args = original as string[];
          }
        });
      }
    }
  });
}

test("without scoped backends legacy CLI and shared-tool metadata expansion is unchanged", (t) => {
  const root = mkdtempSync(join(tmpdir(), "legacy-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envFile = join(root, "env");
  writeFileSync(envFile, "LEGACY=legacy-fixture\n");
  const config = HarnessConfigSchema.parse({
    envFile,
    channels: { C1: {
      exec: { commands: { local: { command: "example", args: ["${LEGACY}"], description: "${LEGACY}", allowArgs: [["${LEGACY}"]] } } },
      share: { sharedTools: { script: { allowArgs: [["${LEGACY}"]] } } },
    } },
  });
  const channel = resolveChannel(config, root, { id: "C1", isDm: false }, new ChannelRegistry(root)).channel!;
  assert.equal(channel.exec.commands.local!.description, "legacy-fixture");
  assert.deepEqual(channel.exec.commands.local!.args, ["legacy-fixture"]);
  assert.deepEqual(channel.exec.commands.local!.allowArgs, [["legacy-fixture"]]);
  assert.deepEqual(channel.sharedTools.execute.script!.allowArgs, [["legacy-fixture"]]);
});
