import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import type { SecretScope } from "../config/keychain-schema.ts";
import { KeychainClient, KeychainError } from "../config/keychain.ts";
import { ChannelRegistry } from "./registry.ts";
import { GrantStore } from "../agent/grants.ts";
import { resolveChannel } from "./resolve.ts";
import { buildExecArgs } from "../agent/sandbox.ts";

test("both container backends receive only explicit channel imports; argv and metadata never receive secrets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "keychain-resolve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(KeychainClient.prototype, "read", (_principal: unknown, scope: SecretScope, name: string) => `${scope.kind === "channel" ? scope.channel : scope.kind}-${name}-sentinel`);
  const registry = new ChannelRegistry(root);
  for (const mode of ["docker", "macos-container", "kiri"] as const) {
    const config = HarnessConfigSchema.parse({
      keychain: { helperPath: "/private/helper", globalChannel: ["GLOBAL"], channels: { C1: ["LOCAL"], C2: ["OTHER"] }, mainProcess: ["MAIN"] },
      defaults: { sandbox: { mode }, tools: ["read", "bash"] },
      channels: { C1: { connectors: { example: { transport: "stdio", command: "example", description: "Do not expand ${LOCAL}", env: { TOKEN: "${LOCAL}" } } } } },
    });
    const channel = resolveChannel(config, root, { id: "C1", isDm: false }, registry).channel!;
    assert.equal(channel.env.MAIN, undefined); assert.equal(channel.env.OTHER, undefined);
    assert.equal(channel.env.LOCAL, "C1-LOCAL-sentinel");
    assert.equal(channel.env.GLOBAL, "global-channel-GLOBAL-sentinel");
    assert.equal(channel.connectors[0]!.config.description, "Do not expand ${LOCAL}");
    const args = buildExecArgs({ config: channel.sandbox, workspace: channel.paths.workspace, dataDir: root, dockerDataDir: root, env: channel.env, channelId: "C1", threadKey: "thread", mounts: channel.containerMounts }, "test-container", "true");
    assert.ok(args.includes("LOCAL"));
    assert.ok(!args.includes("MAIN") && !args.includes("OTHER"));
    assert.doesNotMatch(JSON.stringify(args), /sentinel|helper|Keychains/);
    config.channels.C1!.connectors.example = { transport: "stdio", command: "example", args: ["${LOCAL}"], env: {} } as never;
    assert.throws(() => resolveChannel(config, root, { id: "C1", isDm: false }, registry), /cannot be used in subprocess/);
  }
});
test("host bash with .env works without Keychain and legacy connector expansion remains unchanged", (t) => {
  const root = mkdtempSync(join(tmpdir(), "keychain-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "env"), "LEGACY_KEY=legacy-fixture\n");
  const config = HarnessConfigSchema.parse({
    envFile: join(root, "env"),
    defaults: { tools: ["read", "bash"], sandbox: { mode: "host" } },
    channels: { C1: { connectors: { example: { transport: "stdio", command: "example", args: ["${LEGACY_KEY}"], description: "${LEGACY_KEY}", env: {} } } } },
  });
  const channel = resolveChannel(config, root, { id: "C1", isDm: false }, new ChannelRegistry(root)).channel!;
  assert.equal(channel.sandbox.mode, "host");
  assert.ok(channel.tools.includes("bash"));
  assert.equal(channel.env.LEGACY_KEY, "legacy-fixture");
  assert.equal(channel.connectors[0]!.config.description, "legacy-fixture");
  assert.deepEqual((channel.connectors[0]!.config as { args: string[] }).args, ["legacy-fixture"]);
});
test("accepted mixed deployments keep dotenv, scoped imports, denied/missing errors and argv protections", (t) => {
  const root = mkdtempSync(join(tmpdir(), "keychain-mixed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "host.env"), "LEGACY_KEY=legacy-fixture\nMAIN=legacy-main\nOTHER=legacy-other\nLOCAL=legacy-local\n");
  const read = t.mock.method(KeychainClient.prototype, "read", (_principal: unknown, scope: SecretScope, name: string) =>
    [scope.kind === "channel" ? scope.channel : scope.kind, name, "sentinel"].join("-"));
  for (const mode of ["docker", "macos-container", "kiri"] as const) {
    const config = HarnessConfigSchema.parse({
      keychain: { helperPath: "/private/helper", acceptHostExecutionRisk: true, channels: { C1: ["LOCAL"], C2: ["OTHER"] }, mainProcess: ["MAIN"] },
      defaults: { tools: ["read", "bash"], sandbox: { mode } },
      channels: {
        C1: {},
        CHOST: { sandbox: { mode: "host" }, envFile: join(root, "host.env"), tools: ["read", "bash", "exec"], exec: { commands: { echo: { command: "/bin/echo", allowArgs: [["ok"]], env: { TOKEN: "${LEGACY_KEY}" } } } } },
      },
    });
    const registry = new ChannelRegistry(root);
    const resolve = (id: string) => resolveChannel(config, root, { id, isDm: false }, registry).channel!;
    const beforeHost = read.mock.callCount();
    const host = resolve("CHOST");
    assert.equal(host.sandbox.mode, "host");
    assert.ok(host.tools.includes("bash") && host.tools.includes("exec"));
    assert.equal(host.env.LEGACY_KEY, "legacy-fixture");
    assert.equal(host.exec.commands.echo!.env.TOKEN, "legacy-fixture");
    for (const key of ["MAIN", "OTHER", "LOCAL"]) assert.equal(host.env[key], undefined);
    assert.equal(read.mock.callCount(), beforeHost, "host channel does not import container or main secrets");
    const container = resolve("C1");
    assert.equal(container.sandbox.mode, mode);
    assert.equal(container.env.LOCAL, "C1-LOCAL-sentinel");
    assert.equal(container.env.MAIN, undefined);
    assert.equal(container.env.OTHER, undefined);
    config.channels.C1!.tools = ["exec"];
    const echo = { ...host.exec.commands.echo!, args: ["${LOCAL}"] };
    config.channels.C1!.exec = { commands: { echo }, shared: [] };
    assert.throws(() => resolve("C1"), /cannot be used in subprocess/);
    echo.args = [];
    for (const code of ["missing", "denied"] as const) {
      read.mock.mockImplementation(() => { throw new KeychainError(code); });
      assert.throws(() => resolve("C1"), { code });
      assert.equal(resolve("CHOST").env.LEGACY_KEY, "legacy-fixture");
    }
    read.mock.mockImplementation((_principal: unknown, scope: SecretScope, name: string) => [scope.kind === "channel" ? scope.channel : scope.kind, name, "sentinel"].join("-"));
  }
});

test("Keychain rejects host bash in config and runtime grants", (t) => {
  assert.equal(HarnessConfigSchema.safeParse({ keychain: { helperPath: "/helper" }, defaults: { tools: ["bash"], sandbox: { mode: "host" } } }).success, false);
  const root = mkdtempSync(join(tmpdir(), "keychain-grants-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = HarnessConfigSchema.parse({ keychain: { helperPath: "/helper" }, defaults: { sandbox: { mode: "host" }, permissions: { grantable: ["bash"] } } });
  new GrantStore(root).grant("C1", { capability: "bash", grantedBy: "U1", grantedAt: new Date().toISOString(), expiresAt: null });
  assert.throws(() => resolveChannel(config, root, { id: "C1", isDm: false }, new ChannelRegistry(root)), /including runtime grants/);
  assert.equal(config.keychain!.acceptHostExecutionRisk, false, "a runtime grant cannot accept the risk");
  config.keychain!.acceptHostExecutionRisk = true;
  const channel = resolveChannel(config, root, { id: "C1", isDm: false }, new ChannelRegistry(root)).channel!;
  assert.equal(channel.sandbox.mode, "host");
  assert.ok(channel.tools.includes("bash"));
  config.keychain!.acceptHostExecutionRisk = false;
  assert.throws(() => resolveChannel(config, root, { id: "C1", isDm: false }, new ChannelRegistry(root)), /including runtime grants/);
});
