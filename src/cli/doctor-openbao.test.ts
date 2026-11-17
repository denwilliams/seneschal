import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ChannelRegistry } from "../workspace/registry.ts";

const cli = fileURLToPath(new URL("./doctor.ts", import.meta.url));
const bootstrap = "PRIVATE_BAO_BOOTSTRAP";

type Channel = { requires: { env: string[]; onMissing: "fail" }; envFile?: string; exec?: { commands: Record<string, { command: string; allowArgs: string[][] }> } };

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-bao-")));
  const dataDir = join(root, "data");
  const tokenFile = join(root, "bootstrap");
  writeFileSync(tokenFile, bootstrap, { mode: 0o600 });
  const values = new Map<string, string>();
  const requests: string[] = [];
  let failure = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers["x-vault-token"], bootstrap);
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    const value = values.get(req.url!.replace("/v1/secret/data/harness/", ""));
    if (failure || value === undefined) {
      res.writeHead(failure || 404);
      res.end(JSON.stringify({ errors: [bootstrap + " PRIVATE_BACKEND_DETAIL"] }));
    } else res.end(JSON.stringify({ data: { data: { value } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const config = {
    dataDir,
    authPath: join(root, "auth.json"),
    modelProviders: { synthetic: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "test-model", contextWindow: 8192, maxTokens: 2048 }] } },
    defaults: { model: "synthetic/test-model", tools: [] as string[] },
    openbao: {
      address: `http://127.0.0.1:${(server.address() as { port: number }).port}`, tokenFile,
      mainProcess: [] as string[], globalChannel: [] as string[], channels: {} as Record<string, string[]>,
      acceptHostExecutionRisk: false,
    },
    channels: { C123: { requires: { env: ["SEARCH_KEY"], onMissing: "fail" } } } as Record<string, Channel>,
    envFile: undefined as string | undefined,
  };
  // Verify inside the actual CLI process that scoped resolution never exports
  // imported values (or removes legacy values) from the host environment.
  const preload = join(root, "check-environment.mjs");
  writeFileSync(preload, `const before = JSON.stringify(process.env);
    process.on('exit', () => {
      if (JSON.stringify(process.env) !== before) {
        console.error('Host environment changed'); process.exitCode = 97;
      }
    });`);
  const run = async (env: Record<string, string> = {}, openbao = true, unattended = false) => {
    const configFile = join(root, "config.yaml");
    writeFileSync(configFile, stringify({ ...config, openbao: openbao ? config.openbao : undefined }));
    const childEnv: NodeJS.ProcessEnv = unattended ? { PATH: "/usr/bin:/bin", HOME: root } : { ...process.env };
    for (const name of ["SEARCH_KEY", "MAIN_ONLY", "VAULT_TOKEN", "BAO_TOKEN"]) delete childEnv[name];
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import", preload, cli], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
      env: { ...childEnv, ...env, HARNESS_CONFIG: configFile },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.doesNotMatch(output, /PRIVATE_|Host environment changed/);
    return { status, output };
  };
  const implicitEnv = (id: string, content: string) => {
    const dir = join(dataDir, "channels", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "env"), content);
  };
  return { root, dataDir, config, values, requests, run, implicitEnv, fail: (status: number) => { failure = status; } };
}

test("doctor distinguishes strict host blocking from accepted OpenBao risk without printing credentials", async (t) => {
  const f = await fixture(t);
  f.config.defaults.tools = ["bash", "exec"];
  f.config.channels.C123!.exec = { commands: { node: { command: process.execPath, allowArgs: [["--version"]] } } };
  f.config.openbao.globalChannel = ["SEARCH_KEY"];
  f.values.set("global-channel/SEARCH_KEY", "PRIVATE_CHANNEL_VALUE");
  const strict = await f.run();
  assert.notEqual(strict.status, 0);
  assert.match(strict.output, /OpenBao requires container isolation.*Strict mode/);
  assert.doesNotMatch(strict.output, /risk accepted/);
  f.config.openbao.acceptHostExecutionRisk = true;
  const accepted = await f.run();
  assert.equal(accepted.status, 0, accepted.output);
  assert.match(accepted.output, /WARNING: OpenBao host-execution risk accepted/);
  assert.match(accepted.output, /token file or process memory.*backend secrets outside configured channel scopes/);
  assert.match(accepted.output, /All checks passed/);
});

test("doctor accepts required global-channel OpenBao imports without exporting or printing values", async (t) => {
  const f = await fixture(t);
  f.config.openbao.globalChannel = ["SEARCH_KEY"];
  f.values.set("global-channel/SEARCH_KEY", "PRIVATE_GLOBAL_SEARCH");
  const result = await f.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /All checks passed/);
  assert.doesNotMatch(result.output, /requirements MISSING/);
  assert.deepEqual(f.requests, ["/v1/secret/data/harness/global-channel/SEARCH_KEY"]);
});

test("unattended daemon-style startup uses private token files with no login, Keychain or secret environment", async (t) => {
  const f = await fixture(t);
  f.config.openbao.globalChannel = ["SEARCH_KEY"];
  f.config.openbao.mainProcess = ["MAIN_ONLY"];
  f.values.set("global-channel/SEARCH_KEY", "PRIVATE_DAEMON_CHANNEL");
  f.values.set("main-process/MAIN_ONLY", "PRIVATE_DAEMON_MAIN");
  const result = await f.run({}, true, true);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /All checks passed/);
  assert.deepEqual(f.requests, ["/v1/secret/data/harness/main-process/MAIN_ONLY", "/v1/secret/data/harness/global-channel/SEARCH_KEY"]);
});

for (const key of ["C123", "ops", "#ops"]) {
  test(`doctor uses the durable Slack ID for per-channel imports configured as ${key}`, async (t) => {
    const f = await fixture(t);
    new ChannelRegistry(f.dataDir).record({ id: "C123", name: "ops", isDm: false });
    f.config.channels = { [key]: f.config.channels.C123! };
    f.config.openbao.channels.C123 = ["SEARCH_KEY"];
    f.values.set("channels/C123/SEARCH_KEY", "PRIVATE_CHANNEL_SEARCH");
    const result = await f.run();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /All checks passed/);
    assert.deepEqual(f.requests, ["/v1/secret/data/harness/channels/C123/SEARCH_KEY"]);
  });
}

test("doctor never uses another channel's imports for an unseen configured name", async (t) => {
  const f = await fixture(t);
  new ChannelRegistry(f.dataDir).record({ id: "C456", name: "other", isDm: false });
  f.config.channels = { ops: f.config.channels.C123! };
  f.config.openbao.channels.C456 = ["SEARCH_KEY"];
  f.values.set("channels/C456/SEARCH_KEY", "PRIVATE_OTHER_SEARCH");
  const result = await f.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /environment variable "SEARCH_KEY" is unset or empty/);
});

test("doctor rejects main-only, other-channel and bootstrap names despite legacy copies in every layer", async (t) => {
  const f = await fixture(t);
  f.config.channels.C123!.requires.env = ["MAIN_ONLY", "SEARCH_KEY", "VAULT_TOKEN", "BAO_TOKEN"];
  f.config.openbao.mainProcess = ["MAIN_ONLY"];
  f.config.openbao.channels.C456 = ["SEARCH_KEY"];
  f.values.set("main-process/MAIN_ONLY", "PRIVATE_MAIN");
  f.values.set("channels/C456/SEARCH_KEY", "PRIVATE_OTHER_SEARCH");
  f.config.envFile = join(f.root, "global.env");
  const legacy = { SEARCH_KEY: "PRIVATE_OTHER_LEGACY_COPY", MAIN_ONLY: "PRIVATE_LEGACY_MAIN", VAULT_TOKEN: "PRIVATE_VAULT_TOKEN", BAO_TOKEN: "PRIVATE_BAO_TOKEN" };
  const content = Object.entries(legacy).map(([name, value]) => `${name}=${value}`).join("\n");
  writeFileSync(f.config.envFile, content);
  f.implicitEnv("C123", content);
  const result = await f.run(legacy);
  assert.equal(result.status, 1, result.output);
  for (const name of f.config.channels.C123!.requires.env) {
    assert.ok(result.output.includes(`environment variable "${name}" is unset or empty`), result.output);
  }
});

test("doctor permits an explicitly channel-visible same-name import while keeping the main value private", async (t) => {
  const f = await fixture(t);
  f.config.openbao.mainProcess = ["SEARCH_KEY"];
  f.config.openbao.globalChannel = ["SEARCH_KEY"];
  f.config.openbao.channels.C123 = ["SEARCH_KEY"];
  f.values.set("main-process/SEARCH_KEY", "PRIVATE_MAIN_SEARCH");
  f.values.set("global-channel/SEARCH_KEY", "PRIVATE_GLOBAL_SEARCH");
  f.values.set("channels/C123/SEARCH_KEY", "PRIVATE_CHANNEL_SEARCH");
  const result = await f.run({ SEARCH_KEY: "PRIVATE_LEGACY_SEARCH" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /All checks passed/);
});

test("doctor checks learned-ID implicit env files and retains explicit env-file behavior without OpenBao", async (t) => {
  const f = await fixture(t);
  new ChannelRegistry(f.dataDir).record({ id: "C123", name: "ops", isDm: false });
  f.config.channels = { ops: f.config.channels.C123! };
  f.implicitEnv("C123", "SEARCH_KEY=PRIVATE_IMPLICIT_SEARCH");
  const implicit = await f.run({}, false);
  assert.equal(implicit.status, 0, implicit.output);
  f.config.channels.ops!.envFile = join(f.root, "explicit.env");
  writeFileSync(f.config.channels.ops!.envFile!, "SEARCH_KEY=PRIVATE_EXPLICIT_SEARCH");
  const explicit = await f.run({}, false);
  assert.equal(explicit.status, 0, explicit.output);
  assert.deepEqual(f.requests, []);
});

for (const status of [401, 403, 404, 503]) {
  test(`doctor fails closed with sanitized required-import ${status} errors without legacy/global fallback`, async (t) => {
    const f = await fixture(t);
    f.config.openbao.globalChannel = ["SEARCH_KEY"];
    f.config.openbao.channels.C123 = ["SEARCH_KEY"];
    f.values.set("global-channel/SEARCH_KEY", "PRIVATE_GLOBAL_SEARCH");
    f.fail(status);
    const result = await f.run({ SEARCH_KEY: "PRIVATE_LEGACY_SEARCH" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, status === 404 ? /OpenBao secret is missing or deleted/ : /OpenBao request failed/);
    assert.doesNotMatch(result.output, /https?:|\.ts:\d|Channels:|All checks passed/);
    assert.deepEqual(f.requests, ["/v1/secret/data/harness/global-channel/SEARCH_KEY"]);
  });
}
