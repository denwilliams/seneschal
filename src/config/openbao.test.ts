import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HarnessConfigSchema } from "./schema.ts";
import { applyOpenBaoProviderKeys, initializeOpenBao, mainProcessSecret, OpenBaoClient, openBaoChannelEnvironment } from "./openbao.ts";
import { expandWith } from "./envfile.ts";
import { openBaoWriter, ScopedSecretAdmin } from "./scoped-secrets.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { GrantStore } from "../agent/grants.ts";
import { TOP_LEVEL } from "./edit-policy.ts";
import { containerEnvironment } from "../agent/sandbox.ts";
import { runRestrictedCommandDetailed } from "../agent/restricted-exec.ts";
import { parseOpenBaoCommand, runOpenBaoCommand } from "../cli/openbao-secrets.ts";

const bootstrap = "synthetic-bootstrap-do-not-expose";
async function fixture(run: (f: {
  root: string; tokenFile: string; address: string; values: Map<string, string>; requests: string[];
  fail: (status: number) => void;
}) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bao-")));
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, bootstrap, { mode: 0o600 });
  const values = new Map<string, string>();
  const requests: string[] = [];
  let failure = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers["x-vault-token"], bootstrap);
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (failure) { res.writeHead(failure); res.end(JSON.stringify({ errors: [`do not echo ${bootstrap}`] })); return; }
    const path = req.url!.replace(/^\/v1\/secret\/(data|metadata)\/harness\//, "");
    if (path.endsWith("?list=true")) {
      const prefix = path.slice(0, -10) + "/";
      const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
      res.writeHead(keys.length ? 200 : 404); res.end(JSON.stringify({ data: { keys } }));
    } else if (req.method === "POST") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      values.set(path, JSON.parse(Buffer.concat(chunks).toString()).data.value);
      res.end("{}");
    } else if (req.method === "DELETE") { values.delete(path); res.writeHead(204); res.end(); }
    else if (!values.has(path)) { res.writeHead(404); res.end("{}"); }
    else res.end(JSON.stringify({ data: { data: { value: values.get(path) } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ root, tokenFile, address: `http://127.0.0.1:${(server.address() as { port: number }).port}`, values, requests, fail: (status) => { failure = status; } });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
}

test("CLI explicitly selects each scope, never reads back values, and removes all versions", async () => {
  await fixture(async ({ root, tokenFile, address, values, requests }) => {
    const config = HarnessConfigSchema.parse({ openbao: { address, tokenFile } });
    for (const args of [["channel", "C123"], ["global-channel"], ["main-process"]]) {
      const result = await runOpenBaoCommand(["set", ...args, "TOKEN"], config, root + "/data", async () => "synthetic-value");
      assert.doesNotMatch(result, /synthetic-value/);
      assert.equal(await runOpenBaoCommand(["list", ...args], config, root + "/data", async () => ""), "- TOKEN");
      await runOpenBaoCommand(["remove", ...args, "TOKEN"], config, root + "/data", async () => "");
      assert.equal(await runOpenBaoCommand(["list", ...args], config, root + "/data", async () => ""), "No secrets stored.");
    }
    assert.equal(values.size, 0);
    assert.ok(requests.includes("POST /v1/secret/data/harness/main-process/TOKEN"));
    assert.ok(requests.includes("DELETE /v1/secret/metadata/harness/channels/C123/TOKEN"));
    for (const args of [["set", "TOKEN"], ["set", "channel", "../main-process", "TOKEN"], ["list", "main-process", "TOKEN"], ["set", "global-channel", "TOKEN", "value"]]) assert.throws(() => parseOpenBaoCommand(args));
  });
});

test("OpenBao Admin writer requires an explicit provisioning credential and writes through the API", async () => {
  await fixture(async ({ tokenFile, address, values, root }) => {
    let config = HarnessConfigSchema.parse({ openbao: { address, tokenFile } }).openbao!;
    const service = new ScopedSecretAdmin([openBaoWriter(() => config, [])], () => [{ id: "C123" }]);
    assert.equal(service.snapshot().backends[0]!.enabled, false);
    await assert.rejects(service.save("openbao", { kind: "main-process" }, "TOKEN", "private-value", true));
    config = { ...config, adminTokenFile: tokenFile };
    for (const scope of [{ kind: "main-process" }, { kind: "global-channel" }, { kind: "channel", channel: "C123" }] as const) {
      await service.save("openbao", scope, "TOKEN", "private-value", true);
    }
    assert.equal(values.get("channels/C123/TOKEN"), "private-value");
    assert.equal(values.get("main-process/TOKEN"), "private-value");
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /private-value|synthetic-bootstrap/);
    const unsafe = new ScopedSecretAdmin([openBaoWriter(() => config, [root])], () => []);
    await assert.rejects(unsafe.save("openbao", { kind: "global-channel" }, "TOKEN", "private-value", true), /Backend secret write failed/);
  });
});

test("real channel resolution, connectors, prompts and subprocess environments preserve all three boundaries", async () => {
  await fixture(async ({ root, tokenFile, address, values }) => {
    values.set("main-process/TOKEN", "main-only-value");
    values.set("main-process/SLACK_BOT_TOKEN", "main-slack-value");
    values.set("global-channel/TOKEN", "global-value");
    values.set("channels/C1/TOKEN", "channel-one-value");
    values.set("channels/C1/PRIVATE", "one-private-value");
    values.set("channels/C2/TOKEN", "channel-two-value");
    const config = HarnessConfigSchema.parse({
      openbao: { address, tokenFile, mainProcess: ["TOKEN", "SLACK_BOT_TOKEN"], globalChannel: ["TOKEN"], channels: { C1: ["TOKEN", "PRIVATE"], C2: ["TOKEN"] } },
      connectors: { api: { transport: "http", url: "https://example.test", headers: { Authorization: "Bearer ${TOKEN}" } } },
      channels: { C1: { share: { connectors: ["api"] } }, C2: { share: { connectors: ["api"] } } },
    });
    const data = join(root, "data"); mkdirSync(data);
    const before = { ...process.env };
    await initializeOpenBao(config, { forbiddenRoots: [data] });
    assert.deepEqual({ ...process.env }, before, "imports must never modify the ambient environment");
    assert.equal(mainProcessSecret(config, "TOKEN"), "main-only-value");
    const registry = new ChannelRegistry(data);
    for (const [id, expected] of [["C1", "channel-one-value"], ["C2", "channel-two-value"], ["C3", "global-value"]]) {
      const channel = resolveChannel(config, data, { id: id!, isDm: false }, registry).channel!;
      assert.equal(channel.env.TOKEN, expected);
      assert.equal(channel.env.SLACK_BOT_TOKEN, undefined);
      if (id !== "C1") assert.equal(channel.env.PRIVATE, undefined);
      if (channel.connectors.length) assert.equal((channel.connectors[0]!.config as { headers: Record<string, string> }).headers.Authorization, `Bearer ${expected}`);
      const prompt = buildSystemPrompt(channel, { harnessName: "test", slackChannelLabel: id!, botUserId: "bot" });
      const delivered = JSON.stringify([channel, containerEnvironment(channel.env), prompt, config]);
      for (const secret of [bootstrap, "main-only-value", "main-slack-value"]) assert.ok(!delivered.includes(secret));
      assert.ok(!prompt.includes(expected!));
      if (id !== "C1") assert.ok(!delivered.includes("one-private-value"));
      const child = await runRestrictedCommandDetailed({ command: process.execPath, argv: ["-e", "console.log(JSON.stringify(process.env))"], cwd: root, env: channel.env, timeoutSeconds: 5, maxOutputBytes: 100000 });
      assert.doesNotMatch(child.output, /main-only-value|main-slack-value|synthetic-bootstrap/);
      assert.equal(JSON.parse(child.output).TOKEN, expected);
    }
    assert.equal(existsSync(join(data, "channels", "C1", "env")), false);
    assert.equal(readFileSync(tokenFile, "utf8"), bootstrap);
    assert.ok(!JSON.stringify(config).includes("main-only-value"));
    const clean = openBaoChannelEnvironment(config, "C3", { SLACK_BOT_TOKEN: "legacy-copy", BAO_TOKEN: "legacy-auth", VAULT_TOKEN: "legacy-auth", TOKEN: "ambient", OTHER: "keep" });
    assert.deepEqual(clean, { OTHER: "keep", TOKEN: "global-value" });
    const old = process.env.SLACK_BOT_TOKEN;
    try {
      process.env.SLACK_BOT_TOKEN = "legacy-copy";
      assert.throws(() => expandWith("${SLACK_BOT_TOKEN}", clean, "test", false), /not set/);
    } finally { if (old === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = old; }
  });
});

test("missing required secret and backend/auth failures never fall through to global, env or a partial snapshot", async () => {
  await fixture(async ({ tokenFile, address, values, fail, requests }) => {
    values.set("global-channel/TOKEN", "global");
    const config = HarnessConfigSchema.parse({ openbao: { address, tokenFile, globalChannel: ["TOKEN"], channels: { C1: ["TOKEN"] } } });
    await assert.rejects(initializeOpenBao(config), /missing or deleted/);
    assert.throws(() => openBaoChannelEnvironment(config, "C1", { TOKEN: "legacy" }), /not been initialized/);
    for (const status of [401, 403, 429, 500, 503]) {
      fail(status); requests.length = 0;
      await assert.rejects(initializeOpenBao(config), (error: Error) => !error.message.includes(bootstrap) && /OpenBao request failed/.test(error.message));
      assert.equal(requests.length, 1, "no retry or scope fallback");
    }
    fail(0);
    values.set("channels/C1/TOKEN", "one");
    await initializeOpenBao(config);
    values.set("channels/C1/TOKEN", "rotated");
    assert.equal(openBaoChannelEnvironment(config, "C1", {}).TOKEN, "one", "snapshot lasts until reload/restart");
    await initializeOpenBao(config);
    assert.equal(openBaoChannelEnvironment(config, "C1", {}).TOKEN, "rotated");
    fail(403); await assert.rejects(initializeOpenBao(config));
    assert.equal(openBaoChannelEnvironment(config, "C1", {}).TOKEN, "rotated", "failed reload does not replace the active snapshot");
  });
});

test("transport errors, invalid response shapes, redirects and oversized responses stay sanitized", async () => {
  await fixture(async ({ tokenFile, address }) => {
    const config = HarnessConfigSchema.parse({ openbao: { address, tokenFile } }).openbao!;
    for (const fetcher of [
      async () => { throw new Error(bootstrap); },
      async () => new Response("not-json " + bootstrap),
      async () => new Response("null"),
      async () => new Response(JSON.stringify({ data: { data: { value: 1 } } })),
      async () => new Response("x".repeat(1024 * 1024 + 1)),
      async () => new Response("redirect " + bootstrap, { status: 302, headers: { location: "https://attacker.test" } }),
    ]) {
      const client = new OpenBaoClient(config, { fetch: fetcher });
      await assert.rejects(client.read({ kind: "main-process" }, "TOKEN"), (error: Error) => !error.message.includes(bootstrap));
    }
    const client = new OpenBaoClient(config, { fetch: async (_, options) => {
      assert.equal(options?.redirect, "error"); assert.ok(options?.signal);
      return new Response(JSON.stringify({ data: { data: { value: "ok" } } }));
    } });
    assert.equal(await client.read({ kind: "global-channel" }, "TOKEN"), "ok");
    await assert.rejects(client.save({ kind: "global-channel" }, "TOKEN", "x".repeat(16385)));
    await assert.rejects(client.read({ kind: "channel", channel: "../main-process" }, "TOKEN"));
    await assert.rejects(client.read({ kind: "main-process" }, "../TOKEN"));
  });
});

test("bootstrap authentication is private and path/config validation fails closed", async () => {
  await fixture(async ({ root, tokenFile, address }) => {
    const config = HarnessConfigSchema.parse({ openbao: { address, tokenFile } }).openbao!;
    chmodSync(tokenFile, 0o644); assert.throws(() => new OpenBaoClient(config), /owner-only/); chmodSync(tokenFile, 0o600);
    assert.throws(() => new OpenBaoClient(config, { forbiddenRoots: [root] }), /owner-only/);
    const link = join(root, "link"); symlinkSync(tokenFile, link);
    assert.throws(() => new OpenBaoClient({ ...config, tokenFile: link }), /owner-only/);
    for (const change of [{ address: "http://remote.test" }, { address: "https://user:password@host.test" }, { mount: "../secret" }, { prefix: "a//b" }, { channels: { name: ["TOKEN"] } }, { mainProcess: ["BAO_TOKEN"] }, { globalChannel: ["PATH"] }, { providerKeys: { openai: "MISSING" } }]) {
      assert.equal(HarnessConfigSchema.safeParse({ openbao: { address, tokenFile, ...change } }).success, false);
    }
    assert.equal(HarnessConfigSchema.safeParse({ openbao: { address, tokenFile }, defaults: { tools: ["bash"] } }).success, false);
    assert.equal(HarnessConfigSchema.safeParse({ openbao: { address, tokenFile }, defaults: { tools: ["bash"], sandbox: { mode: "docker" } } }).success, true);
  });
});

test("runtime grants cannot enable host bash and agents cannot edit the backend trust boundary", async () => {
  await fixture(async ({ root, tokenFile, address }) => {
    const config = HarnessConfigSchema.parse({ openbao: { address, tokenFile }, defaults: { permissions: { grantable: ["bash"] } } });
    await initializeOpenBao(config);
    const data = join(root, "data"); mkdirSync(data);
    new GrantStore(data).grant("C123", { capability: "bash", grantedBy: "U123", grantedAt: new Date().toISOString(), expiresAt: null });
    assert.throws(() => resolveChannel(config, data, { id: "C123", isDm: false }, new ChannelRegistry(data)), /container isolation for bash/);
    assert.notEqual(TOP_LEVEL.openbao, "allow");
    const denied = TOP_LEVEL.openbao as { deny: string };
    assert.match(denied.deny, /secret scopes/);
  });
});

test("OpenBao rejects host exec/shared tools in defaults, overrides and runtime configs, even with Keychain risk accepted", async () => {
  await fixture(async ({ root, tokenFile, address }) => {
    const openbao = { address, tokenFile };
    for (const mode of ["host", "docker", "macos-container", "kiri"] as const) {
      for (const override of [
        { defaults: { tools: ["exec"], sandbox: { mode } } },
        { channels: { C1: { tools: ["exec"] } } },
        { defaults: { share: { sharedTools: { unsafe: {} } } } },
        { channels: { C1: { share: { sharedTools: { unsafe: {} } } } } },
      ]) assert.equal(HarnessConfigSchema.safeParse({ openbao, ...override }).success, false);
    }
    const config = HarnessConfigSchema.parse({ openbao,
      keychain: { helperPath: "/private/helper", acceptHostExecutionRisk: true } });
    await initializeOpenBao(config);
    const data = join(root, "data"); mkdirSync(data);
    const resolve = () => resolveChannel(config, data, { id: "C1", isDm: false }, new ChannelRegistry(data));
    config.defaults.tools = ["exec"];
    assert.throws(resolve, /OpenBao forbids host CLI/);
    config.defaults.tools = [];
    // share.sharedTools is channel-only at runtime (defaults cannot grant it).
    config.channels.C1 = HarnessConfigSchema.parse({ channels: { C1: { share: { sharedTools: { unsafe: {} } } } } }).channels.C1!;
    assert.throws(resolve, /OpenBao forbids host CLI/);
  });
});

test("main-process provider credentials use SDK memory-only API and sanitize SDK failures", async () => {
  await fixture(async ({ root, tokenFile, address, values }) => {
    values.set("main-process/MODEL_KEY", "synthetic-model-private-value");
    const config = HarnessConfigSchema.parse({ openbao: { address, tokenFile, mainProcess: ["MODEL_KEY"], providerKeys: { openai: "MODEL_KEY" } } });
    await initializeOpenBao(config);
    const authPath = join(root, "auth.json");
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
    const before = existsSync(authPath) ? readFileSync(authPath, "utf8") : undefined;
    await applyOpenBaoProviderKeys(config, runtime);
    const after = existsSync(authPath) ? readFileSync(authPath, "utf8") : undefined;
    assert.equal(after, before, "SDK runtime key does not change auth.json");
    assert.ok(!after?.includes("synthetic-model-private-value"));
    assert.equal(openBaoChannelEnvironment(config, "C1", {}).MODEL_KEY, undefined);
    await assert.rejects(applyOpenBaoProviderKeys(config, { setRuntimeApiKey: async () => { throw new Error("synthetic-model-private-value"); } }), (error: Error) => !error.message.includes("synthetic-model-private-value"));
  });
});
