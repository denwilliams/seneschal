import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { initializeOpenBao, OpenBaoClient } from "../config/openbao.ts";
import { KeychainSchema } from "../config/keychain-schema.ts";
import { GrantStore } from "../agent/grants.ts";
import { createExecTools } from "../agent/exec-tools.ts";
import { createSharedToolTools } from "../agent/shared-tool-tools.ts";
import { publishSharedTool } from "../agent/shared-bin.ts";
import { workspaceFixture } from "./fixture.ts";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { channelPathEnv } from "../agent/sandbox.ts";

const backend = (tokenFile: string) => ({ address: "http://127.0.0.1:1", tokenFile, acceptHostExecutionRisk: true });
const privateToken = (t: { after(fn: () => void): void }) => {
  const root = mkdtempSync(join(tmpdir(), "bao-risk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "token"); writeFileSync(path, "private-bootstrap", { mode: 0o600 });
  return { root, path };
};

for (const mode of ["host", "docker", "macos-container", "kiri"] as const) {
  test(`accepted OpenBao risk permits actual host exec/shared tools in ${mode} and strict reload blocks them`, async (t) => {
    const token = privateToken(t);
    const f = workspaceFixture({
      openbao: backend(token.path), defaults: { sandbox: { mode } },
      cliTools: { node: { command: process.execPath, allowArgs: [["--version"]] } },
      channels: {
        C1: { tools: ["exec"], exec: { shared: ["node"], commands: { local: { command: process.execPath, allowArgs: [["--version"]] } } }, share: { sharedTools: { version: { allowArgs: [[]] } } } },
        C2: { share: { sharedToolsPublish: true } },
      },
    });
    t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
    await initializeOpenBao(f.config);
    const published = publishSharedTool(f.shared, f.resolve("C2"), { name: "version", description: "Synthetic version", content: `#!${process.execPath}\nconsole.log('shared-ok')\n` });
    f.config.channels.C1!.share.sharedTools.version!.sha256 = published.sha256;
    const run = async () => {
      const channel = f.resolve("C1");
      const tools = createExecTools({ config: channel.exec, cwd: channel.paths.workspace, binDir: channel.paths.bin, globalBinDir: channel.globalBin, env: channel.env });
      assert.equal(tools.length, 2);
      for (const tool of tools) {
        const result = await tool.execute("exec", { args: ["--version"] }, undefined, undefined, undefined as never);
        assert.match(JSON.stringify(result), new RegExp(`v${process.versions.node.split(".")[0]}\\.`));
      }
      const [tool] = createSharedToolTools({ channel, cwd: channel.paths.workspace });
      const result = await tool!.execute("shared", { args: [] }, undefined, undefined, undefined as never);
      assert.match(JSON.stringify(result), /shared-ok/);
    };
    await run();
    f.config.openbao!.acceptHostExecutionRisk = false;
    await assert.rejects(run, /OpenBao forbids host CLI.*Strict mode/);
    assert.equal(HarnessConfigSchema.safeParse(f.config).success, false);
    f.config.openbao!.acceptHostExecutionRisk = true;
    await run();
  });
}

test("runtime bash grants cannot accept either backend's risk and strict protection resumes immediately", async (t) => {
  const token = privateToken(t);
  const f = workspaceFixture({ openbao: { ...backend(token.path), acceptHostExecutionRisk: false }, defaults: { permissions: { grantable: ["bash"] } } });
  t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
  await initializeOpenBao(f.config);
  new GrantStore(f.dataDir).grant("C1", { capability: "bash", grantedBy: "U1", grantedAt: new Date().toISOString(), expiresAt: null });
  assert.throws(() => f.resolve("C1"), /OpenBao requires container isolation.*runtime grants/);
  assert.equal(f.config.openbao!.acceptHostExecutionRisk, false);
  f.config.openbao!.acceptHostExecutionRisk = true;
  assert.ok(f.resolve("C1").tools.includes("bash"));
  f.config.keychain = KeychainSchema.parse({ helperPath: "/private/helper" });
  assert.throws(() => f.resolve("C1"), /Keychain requires container isolation/);
  f.config.keychain.acceptHostExecutionRisk = true;
  assert.ok(f.resolve("C1").tools.includes("bash"));
  f.config.openbao!.acceptHostExecutionRisk = false;
  assert.throws(() => f.resolve("C1"), /OpenBao requires container isolation/);
});

test("both backend protections remain independent for effective exec and shared tools", async (t) => {
  const token = privateToken(t);
  for (const settings of [{ tools: ["exec"] }, { share: { sharedTools: { version: {} } } }]) {
    const f = workspaceFixture({ openbao: backend(token.path), defaults: settings, channels: { C1: settings } });
    t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
    await initializeOpenBao(f.config);
    f.config.keychain = KeychainSchema.parse({ helperPath: "/private/helper" });
    assert.throws(() => f.resolve("C1"), /Keychain forbids host/);
    f.config.keychain.acceptHostExecutionRisk = true;
    assert.ok(f.resolve("C1"));
    f.config.openbao!.acceptHostExecutionRisk = false;
    assert.throws(() => f.resolve("C1"), /OpenBao forbids host/);
    assert.throws(() => f.resolve("CUNCONFIGURED"), /OpenBao forbids host/);
  }
});

test("mixed host/container deployments retain dotenv, scoped/main-only delivery and fail-closed imports", async (t) => {
  const token = privateToken(t);
  const envFile = join(token.root, "legacy.env");
  writeFileSync(envFile, "LEGACY=ordinary\nMAIN=legacy-main\nOTHER=legacy-other\nLOCAL=legacy-local\nBAO_TOKEN=legacy-auth\n");
  const before = JSON.stringify(process.env);
  for (const mode of ["docker", "macos-container", "kiri"] as const) {
    const f = workspaceFixture({
      openbao: { ...backend(token.path), mainProcess: ["MAIN"], channels: { C1: ["LOCAL"], C2: ["OTHER"] } },
      envFile, defaults: { tools: ["bash"], sandbox: { mode } },
      channels: { C1: {}, CHOST: { tools: ["bash", "exec"], sandbox: { mode: "host" } } },
    });
    t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
    const requested: string[] = [];
    const fetcher = async (url: string | URL | Request) => {
      const path = String(url).split("/harness/")[1]!; requested.push(path);
      return Response.json({ data: { data: { value: `sentinel-${path}` } } });
    };
    await initializeOpenBao(f.config, { fetch: fetcher });
    assert.deepEqual(requested, ["main-process/MAIN", "channels/C1/LOCAL", "channels/C2/OTHER"]);
    const host = f.resolve("CHOST");
    assert.equal(host.sandbox.mode, "host");
    assert.ok(host.tools.includes("bash") && host.tools.includes("exec"));
    assert.equal(host.env.LEGACY, "ordinary");
    const bash = createBashToolDefinition(host.paths.workspace, { spawnHook: (context) => ({ ...context, env: channelPathEnv(host) }) });
    const output = await bash.execute("host", { command: 'printf "%s:%s" "$LEGACY" "${MAIN-unset}"' }, undefined, undefined, undefined as never);
    assert.match(JSON.stringify(output), /ordinary:unset/);
    for (const name of ["MAIN", "OTHER", "LOCAL", "BAO_TOKEN"]) assert.equal(host.env[name], undefined);
    const container = f.resolve("C1");
    assert.equal(container.sandbox.mode, mode);
    assert.equal(container.env.LOCAL, "sentinel-channels/C1/LOCAL");
    assert.equal(container.env.LEGACY, "ordinary");
    assert.equal(container.env.MAIN, undefined);
    assert.equal(container.env.OTHER, undefined);
    assert.equal(JSON.stringify(process.env), before);
    for (const status of [403, 404]) {
      f.reconfigure(f.config); // Fresh config on reload: a failed import must not create a snapshot.
      await assert.rejects(initializeOpenBao(f.config, { fetch: async () => new Response("private-denied-detail", { status }) }),
        (error: Error) => /OpenBao/.test(error.message) && !error.message.includes("private-denied-detail"));
      assert.throws(() => f.resolve("C1"), /not been initialized/);
      await initializeOpenBao(f.config, { fetch: fetcher });
    }
    chmodSync(token.path, 0o644);
    assert.throws(() => new OpenBaoClient(f.config.openbao!), /owner-only/);
    chmodSync(token.path, 0o600);
    assert.equal(HarnessConfigSchema.safeParse({ ...f.config, openbao: { ...f.config.openbao, address: "http://remote.example" } }).success, false);
  }
});
