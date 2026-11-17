import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ChannelRegistry } from "../workspace/registry.ts";
import { FileConnectorOAuthProvider } from "../agent/connectorOAuth.ts";

import { oauthTestDiscovery } from "../agent/connectorOAuth-fixture.ts";
import { encodeManualAuthorizationPayload } from "../agent/manualConnectorOAuth.ts";

const cli = fileURLToPath(new URL("./connector-auth.ts", import.meta.url));
test("operator reset CLI resolves the selected config/channel/store, emits no credentials, and exits without auth", () => {
  const root = mkdtempSync(join(tmpdir(), "connector-auth-cli-"));
  const dataDir = join(root, "data");
  new ChannelRegistry(dataDir).record({ id: "C123", name: "test", isDm: false });
  const tokenFile = join(root, "private-store.json");
  const oauth = { redirectUrl: "http://localhost:37645/oauth/callback", tokenFile, manualCompletionTtlSeconds: 600 };
  const target = new FileConnectorOAuthProvider({ connectorName: "redbark", channelRoot: root, oauth });
  target.saveClientInformation({ client_id: "PRIVATE_CLIENT", client_secret: "PRIVATE_SECRET" });
  target.saveTokens({ access_token: "PRIVATE_TOKEN", token_type: "Bearer", refresh_token: "PRIVATE_REFRESH" });
  target.state();
  target.saveCodeVerifier("PRIVATE_VERIFIER");
  const other = new FileConnectorOAuthProvider({ connectorName: "other", channelRoot: root, oauth: { ...oauth, tokenFile: join(root, "other.json") } });
  other.saveTokens({ access_token: "OTHER_TOKEN", token_type: "Bearer" });
  const untouched = readFileSync(other.storePath, "utf8");
  const configFile = join(root, "test.yaml");
  writeFileSync(configFile, `dataDir: ${JSON.stringify(dataDir)}
connectors:
  redbark:
    transport: http
    url: https://must-not-be-contacted.invalid/mcp
    oauth:
      redirectUrl: ${JSON.stringify(oauth.redirectUrl)}
      tokenFile: ${JSON.stringify(tokenFile)}
      scope: mcp:read
channels:
  test:
    share:
      connectors: [redbark]
`);
  const run = (extra: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", cli, "--config", configFile, ...extra, "test", "redbark"], { encoding: "utf8", timeout: 20_000 });
  const completed = run(["--reset"]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stderr, /Local OAuth state cleared/);
  assert.match(completed.stderr, /Server grants were not revoked/);
  assert.doesNotMatch(completed.stderr + completed.stdout, /PRIVATE_|OTHER_TOKEN|https:\/\/|private-store/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(tokenFile, "utf8"))), ["updatedAt"]);
  assert.equal(readFileSync(other.storePath, "utf8"), untouched);
  const denied = run(["--reset", "--result", "PRIVATE_COMPLETION"]);
  assert.equal(denied.status, 2);
  assert.doesNotMatch(denied.stderr + denied.stdout, /PRIVATE_COMPLETION/);
});

test("console callback CLI refuses manual start/result without discovery or state mutation and reset gives Slack/web guidance", () => {
  const root = mkdtempSync(join(tmpdir(), "connector-auth-console-cli-"));
  const dataDir = join(root, "data");
  const oauth = { redirectUrl: "https://console.example.test/oauth/callback", consoleCallback: true, manualCompletionTtlSeconds: 600 };
  const provider = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: join(dataDir, "channels", "C123"), oauth });
  provider.saveTokens({ access_token: "PRIVATE_TEST_TOKEN", token_type: "Bearer" });
  const before = readFileSync(provider.storePath, "utf8");
  const configFile = join(root, "test.yaml");
  writeFileSync(configFile, `dataDir: ${JSON.stringify(dataDir)}
connectors:
  calendar:
    transport: http
    url: https://must-not-be-contacted.invalid/mcp
    oauth:
      redirectUrl: ${JSON.stringify(oauth.redirectUrl)}
      consoleCallback: true
channels:
  C123:
    share:
      connectors: [calendar]
`);
  const run = (extra: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", cli, "--config", configFile, ...extra, "C123", "calendar"], { encoding: "utf8", timeout: 20_000 });
  for (const args of [[], ["--no-wait"], ["--result", "PRIVATE_COMPLETION"]]) {
    const res = run(args);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /CLI manual start\/result is not supported/);
    assert.match(res.stderr, /!connector-auth connect/);
    assert.doesNotMatch(res.stderr + res.stdout, /PRIVATE_|https:\/\/|copy the completion-page payload|provider/);
    assert.equal(readFileSync(provider.storePath, "utf8"), before);
  }
  const reset = run(["--reset"]);
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stderr, /!connector-auth connect/);
  assert.match(reset.stderr, /web page Connect action/);
  assert.doesNotMatch(reset.stderr, /Rerun connector-auth/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(provider.storePath, "utf8"))), ["updatedAt"]);
});

for (const consoleCallback of [true, false]) {
  test(`CLI recovery routes ${consoleCallback ? "console opt-in to Slack without network/payload" : "legacy static callback through manual start/result"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "connector-auth-route-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    new ChannelRegistry(dataDir).record({ id: "C123", name: "test", isDm: false });
    const oauth = { redirectUrl: consoleCallback ? "https://console.example.org/harness/oauth/callback" : "https://completion.example.org/", consoleCallback, clientId: "synthetic-client", manualCompletionTtlSeconds: 600, scope: "mcp:read" };
    const provider = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: join(dataDir, "channels", "C123"), oauth });
    provider.saveDiscoveryState(oauthTestDiscovery);
    // Cached metadata makes start fully offline, as in the QA reproduction.
    // Completion permits exactly one synthetic token endpoint, no real fetch.
    const preload = join(root, "offline.mjs");
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
      globalThis.fetch = async (url, init) => {
        appendFileSync(${JSON.stringify(join(root, "network.log"))}, String(url) + '\\n');
        if (${consoleCallback} || String(url) !== 'https://login.example.org/token') throw new Error('Network forbidden');
        const body = new URLSearchParams(String(init?.body));
        if (body.get('redirect_uri') !== ${JSON.stringify(oauth.redirectUrl)} || !body.get('code_verifier') || body.get('code') !== 'synthetic-code') throw new Error('Invalid manual exchange');
        return Response.json({ access_token: 'synthetic-cli-token', token_type: 'Bearer' });
      };`);
    const configFile = join(root, "config.yaml");
    writeFileSync(configFile, `dataDir: ${JSON.stringify(dataDir)}
webConsole:
  enabled: true
  baseUrl: https://console.example.org/harness
  oauth:
    callbackUrl: https://console.example.org/harness/oauth/callback
connectors:
  calendar:
    transport: http
    url: https://mcp.example.org/mcp
    oauth:
      consoleCallback: ${consoleCallback}
      redirectUrl: ${oauth.redirectUrl}
      clientId: synthetic-client
      scope: mcp:read
channels:
  test:
    share:
      connectors: [calendar]
`);
    const run = (extra: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--import", preload, cli, "--config", configFile, ...extra, "test", "calendar"], { encoding: "utf8", timeout: 20_000 });
    const before = readFileSync(provider.storePath, "utf8");
    const started = run(["--no-wait"]);
    if (consoleCallback) {
      assert.equal(started.status, 1, started.stderr);
      assert.match(started.stderr, /!connector-auth connect/);
      assert.doesNotMatch(started.stdout + started.stderr, /Open this URL|completion-page payload|https:\/\//);
      const completed = run(["--result", "PRIVATE_COMPLETION_PAYLOAD"]);
      assert.equal(completed.status, 1, completed.stderr);
      assert.match(completed.stderr, /!connector-auth connect/);
      assert.doesNotMatch(completed.stdout + completed.stderr, /PRIVATE_COMPLETION_PAYLOAD/);
      assert.equal(readFileSync(provider.storePath, "utf8"), before);
      assert.equal(existsSync(join(root, "network.log")), false);
    } else {
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stderr, /completion-page payload/);
      const url = new URL(started.stderr.split('\n').find((line) => line.startsWith('https://'))!);
      assert.equal(url.searchParams.get("redirect_uri"), oauth.redirectUrl);
      assert.equal(url.searchParams.get("scope"), "mcp:read");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const payload = encodeManualAuthorizationPayload({ state: url.searchParams.get("state")!, code: "synthetic-code" });
      const completed = run(["--result", payload]);
      assert.equal(completed.status, 0, completed.stderr);
      assert.match(completed.stderr, /OAuth tokens saved/);
      assert.doesNotMatch(completed.stderr + completed.stdout, /synthetic-code|synthetic-cli-token|oauth-result-v1/);
      assert.equal(provider.tokens()?.access_token, "synthetic-cli-token");
      assert.equal(readFileSync(join(root, "network.log"), "utf8").trim(), "https://login.example.org/token");
    }
    const reset = run(["--reset"]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stderr, consoleCallback ? /!connector-auth connect/ : /Rerun connector-auth/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(provider.storePath, "utf8"))), ["updatedAt"]);
  });
}

test("legacy CLI localhost recovery still listens for and exchanges its own compatible callback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "connector-auth-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allocation = createServer();
  await new Promise<void>((resolve) => allocation.listen(0, "127.0.0.1", resolve));
  const address = allocation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => allocation.close((error) => error ? reject(error) : resolve()));
  const redirectUrl = `http://127.0.0.1:${address.port}/oauth/callback`;
  const dataDir = join(root, "data");
  new ChannelRegistry(dataDir).record({ id: "C123", name: "test", isDm: false });
  const provider = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: join(dataDir, "channels", "C123"),
    oauth: { redirectUrl, clientId: "synthetic-client", manualCompletionTtlSeconds: 600, scope: "mcp:read" } });
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, `dataDir: ${JSON.stringify(dataDir)}
connectors:
  calendar:
    transport: http
    url: https://mcp.example.org/mcp
    oauth:
      redirectUrl: ${redirectUrl}
      clientId: synthetic-client
      scope: mcp:read
channels:
  test:
    share:
      connectors: [calendar]
`);
  const reset = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--config", configFile, "--reset", "test", "calendar"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stderr, /Rerun connector-auth/);
  provider.saveDiscoveryState(oauthTestDiscovery);
  const preload = join(root, "offline.mjs");
  writeFileSync(preload, `globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://login.example.org/token') throw new Error('Network forbidden');
    const body = new URLSearchParams(String(init?.body));
    if (body.get('redirect_uri') !== ${JSON.stringify(redirectUrl)} || !body.get('code_verifier') || body.get('code') !== 'synthetic-local-code') throw new Error('Invalid localhost exchange');
    return Response.json({ access_token: 'synthetic-local-token', token_type: 'Bearer' });
  };`);
  const child = spawn(process.execPath, ["--experimental-strip-types", "--import", preload, cli, "--config", configFile, "test", "calendar"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  let output = "";
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => { ready = resolve; });
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; if (output.includes("Waiting for OAuth callback")) ready(); });
  const timer = setTimeout(() => child.kill(), 20_000);
  t.after(() => clearTimeout(timer));
  await Promise.race([listening, exited.then(() => { throw new Error(`CLI exited before listening: ${output}`); })]);
  const consent = new URL(output.split("\n").find((line) => line.startsWith("https://login.example.org/authorize"))!);
  assert.equal(consent.searchParams.get("redirect_uri"), redirectUrl);
  assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
  const callback = new URL(redirectUrl);
  callback.searchParams.set("state", consent.searchParams.get("state")!);
  callback.searchParams.set("code", "synthetic-local-code");
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authorization received/);
  assert.equal(await exited, 0, output);
  assert.equal(provider.tokens()?.access_token, "synthetic-local-token");
  assert.match(output, /OAuth tokens saved/);
  assert.doesNotMatch(output, /completion-page payload|synthetic-local-code|synthetic-local-token|!connector-auth connect/);
});
