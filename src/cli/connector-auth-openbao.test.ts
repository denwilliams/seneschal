import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { REPO_ROOT } from "../config/load.ts";
import { FileConnectorOAuthProvider } from "../agent/connectorOAuth.ts";
import { oauthTestDiscovery } from "../agent/connectorOAuth-fixture.ts";
import { encodeManualAuthorizationPayload } from "../agent/manualConnectorOAuth.ts";

const cli = fileURLToPath(new URL("./connector-auth.ts", import.meta.url));
const bootstrap = "PRIVATE_BAO_BOOTSTRAP";

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "connector-auth-bao-")));
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
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = {
    dataDir,
    openbao: { address, tokenFile, mainProcess: [] as string[], globalChannel: [] as string[], channels: {} as Record<string, string[]> },
    connectors: {
      calendar: {
        transport: "http", url: "https://mcp.example.org/mcp",
        oauth: { redirectUrl: "https://completion.example.org/", clientId: "synthetic-client", tokenFile: join(root, "oauth.json"), scope: "mcp:read" },
      },
    },
    channels: { C123: { share: { connectors: ["calendar"] } }, C456: { share: { connectors: ["calendar"] } } },
  };
  const configFile = join(root, "config.yaml");
  const run = async (args: string[], channel = "C123", preload?: string) => {
    writeFileSync(configFile, stringify(config));
    const child = spawn(process.execPath, ["--experimental-strip-types", ...(preload ? ["--import", preload] : []), cli, "--config", configFile, ...args, channel, "calendar"], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
      // A legacy value must not rescue a failed declared import.
      env: { ...process.env, CLIENT_ID: "PRIVATE_LEGACY_CLIENT" },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { status, output };
  };
  const provider = (tokenFile = config.connectors.calendar.oauth.tokenFile) => new FileConnectorOAuthProvider({
    connectorName: "calendar", channelRoot: join(dataDir, "channels", "C123"), oauth: { ...config.connectors.calendar.oauth, tokenFile, manualCompletionTtlSeconds: 600 },
  });
  return { root, dataDir, config, values, requests, run, provider, fail: (status: number) => { failure = status; } };
}

test("connector-auth reset initializes empty OpenBao imports even before the data root exists", async (t) => {
  const f = await fixture(t);
  assert.equal(existsSync(f.dataDir), false);
  const result = await f.run(["--reset"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Local OAuth state cleared/);
  assert.doesNotMatch(result.output, /PRIVATE_|not been initialized/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.config.connectors.calendar.oauth.tokenFile, "utf8"))), ["updatedAt"]);
  assert.deepEqual(f.requests, [], "empty imports require no backend requests");
});

test("connector-auth start, result and reset interpolate only the selected channel's OpenBao connector values", async (t) => {
  const f = await fixture(t);
  f.config.openbao.mainProcess = ["CLIENT_ID"];
  f.config.openbao.globalChannel = ["CLIENT_ID", "CONNECTOR_STORE"];
  f.values.set("main-process/CLIENT_ID", "PRIVATE_MAIN_CLIENT");
  f.values.set("global-channel/CLIENT_ID", "PRIVATE_GLOBAL_CLIENT");
  const globalStore = join(f.root, "global.json");
  f.values.set("global-channel/CONNECTOR_STORE", globalStore);
  const globalProvider = f.provider(globalStore);
  globalProvider.saveTokens({ access_token: "PRIVATE_GLOBAL_TOKEN", token_type: "Bearer" });
  const globalBefore = readFileSync(globalStore, "utf8");
  const stores = new Map<string, string>();
  for (const id of ["C123", "C456"]) {
    f.config.openbao.channels[id] = ["CLIENT_ID", "CONNECTOR_STORE"];
    const store = join(f.root, `${id}.json`);
    stores.set(id, store);
    f.values.set(`channels/${id}/CLIENT_ID`, `synthetic-client-${id}`);
    f.values.set(`channels/${id}/CONNECTOR_STORE`, store);
    f.provider(store).saveDiscoveryState(oauthTestDiscovery);
  }
  f.config.connectors.calendar.oauth.clientId = "${CLIENT_ID}";
  f.config.connectors.calendar.oauth.tokenFile = "${CONNECTOR_STORE}";
  const preload = join(f.root, "offline-oauth.mjs");
  writeFileSync(preload, `const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith(${JSON.stringify(f.config.openbao.address + "/")})) return originalFetch(url, init);
      if (String(url) !== 'https://login.example.org/token') throw new Error('Network forbidden');
      const body = new URLSearchParams(String(init?.body));
      if (body.get('code') !== 'synthetic-code' || !body.get('code_verifier')) throw new Error('Invalid exchange');
      return Response.json({ access_token: 'PRIVATE_OAUTH_TOKEN', token_type: 'Bearer' });
    };`);
  for (const id of ["C123", "C456"]) {
    const otherId = id === "C123" ? "C456" : "C123";
    const otherBefore = readFileSync(stores.get(otherId)!, "utf8");
    const started = await f.run(["--no-wait"], id, preload);
    assert.equal(started.status, 0, started.output);
    const consent = new URL(started.output.split("\n").find((line) => line.startsWith("https://login.example.org/authorize"))!);
    assert.equal(consent.searchParams.get("client_id"), `synthetic-client-${id}`);
    assert.doesNotMatch(started.output, new RegExp(`PRIVATE_|synthetic-client-${otherId}`));
    const payload = encodeManualAuthorizationPayload({ state: consent.searchParams.get("state")!, code: "synthetic-code" });
    const completed = await f.run(["--result", payload], id, preload);
    assert.equal(completed.status, 0, completed.output);
    assert.match(completed.output, /OAuth tokens saved/);
    assert.doesNotMatch(completed.output, /PRIVATE_|synthetic-code|oauth-result-v1/);
    assert.equal(f.provider(stores.get(id)!).tokens()?.access_token, "PRIVATE_OAUTH_TOKEN");
    const reset = await f.run(["--reset"], id, preload);
    assert.equal(reset.status, 0, reset.output);
    assert.match(reset.output, /Local OAuth state cleared/);
    assert.doesNotMatch(reset.output, /PRIVATE_/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(stores.get(id)!, "utf8"))), ["updatedAt"]);
    assert.equal(readFileSync(stores.get(otherId)!, "utf8"), otherBefore);
    assert.equal(readFileSync(globalStore, "utf8"), globalBefore);
  }
});

for (const status of [401, 403, 404, 503]) {
  test(`connector-auth fails closed with sanitized OpenBao ${status} errors before any OAuth operation`, async (t) => {
    const f = await fixture(t);
    f.config.openbao.globalChannel = ["CLIENT_ID"];
    f.config.openbao.channels.C123 = ["CLIENT_ID"];
    f.config.connectors.calendar.oauth.clientId = "${CLIENT_ID}";
    f.values.set("channels/C123/CLIENT_ID", "PRIVATE_CHANNEL_CLIENT");
    f.provider().saveTokens({ access_token: "PRIVATE_OAUTH_TOKEN", token_type: "Bearer" });
    const before = readFileSync(f.config.connectors.calendar.oauth.tokenFile, "utf8");
    f.fail(status);
    for (const args of [["--reset"], ["--no-wait"], ["--result", "PRIVATE_COMPLETION"]]) {
      f.requests.length = 0;
      const result = await f.run(args);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, status === 404 ? /OpenBao secret is missing or deleted/ : /OpenBao request failed/);
      assert.doesNotMatch(result.output, /PRIVATE_|https?:|\.ts:\d|Local OAuth state cleared|Open this URL|OAuth tokens saved/);
      assert.deepEqual(f.requests, ["/v1/secret/data/harness/global-channel/CLIENT_ID"], "no channel/legacy fallback after initialization failure");
      assert.equal(readFileSync(f.config.connectors.calendar.oauth.tokenFile, "utf8"), before);
    }
  });
}

for (const location of ["data", "repository"]) {
  test(`connector-auth rejects bootstrap credentials under the ${location} root before resetting OAuth`, async (t) => {
    const f = await fixture(t);
    f.provider().saveTokens({ access_token: "PRIVATE_OAUTH_TOKEN", token_type: "Bearer" });
    const before = readFileSync(f.config.connectors.calendar.oauth.tokenFile, "utf8");
    const unsafeRoot = location === "data" ? f.dataDir : mkdtempSync(join(REPO_ROOT, ".connector-auth-bao-"));
    if (location === "repository") t.after(() => rmSync(unsafeRoot, { recursive: true, force: true }));
    mkdirSync(unsafeRoot, { recursive: true });
    f.config.openbao.tokenFile = join(unsafeRoot, "bootstrap");
    writeFileSync(f.config.openbao.tokenFile, bootstrap, { mode: 0o600 });
    const result = await f.run(["--reset"]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /owner-only regular token file outside channel-accessible storage/);
    assert.doesNotMatch(result.output, /PRIVATE_|Local OAuth state cleared/);
    assert.equal(readFileSync(f.config.connectors.calendar.oauth.tokenFile, "utf8"), before);
    assert.deepEqual(f.requests, []);
  });
}
