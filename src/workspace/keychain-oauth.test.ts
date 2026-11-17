import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { HarnessConfigSchema } from "../config/schema.ts";
import { KeychainClient } from "../config/keychain.ts";
import { FileConnectorOAuthProvider } from "../agent/connectorOAuth.ts";
import { consoleOAuthFixture, paired, until } from "../agent/consoleConnectorOAuth-fixture.ts";
import { oauthTestDiscovery } from "../agent/connectorOAuth-fixture.ts";
import { ChannelRegistry } from "./registry.ts";
import { resolveChannel } from "./resolve.ts";

test("Keychain static OAuth secret stays off disk through real SDK console consent and rotates for fresh providers", async (t) => {
  const f = consoleOAuthFixture(t);
  let secret = "keychain-first-secret-sentinel";
  t.mock.method(KeychainClient.prototype, "read", () => secret);
  const config = HarnessConfigSchema.parse({
    keychain: { helperPath: "/private/helper", channels: { CTARGET: ["OAUTH_CLIENT_SECRET"] } },
    channels: { CTARGET: { connectors: { calendar: { transport: "http", url: f.target.connectorUrl,
      oauth: { ...f.target.oauth, clientSecret: "${OAUTH_CLIENT_SECRET}", tokenEndpointAuthMethod: "client_secret_post" } } } } },
  });
  const registry = new ChannelRegistry(f.target.channelRoot);
  const resolve = () => {
    const channel = resolveChannel(config, f.target.channelRoot, { id: "CTARGET", isDm: false }, registry).channel!;
    const connector = channel.connectors[0]!.config;
    assert.equal(connector.transport, "http");
    if (connector.transport !== "http" || !connector.oauth) throw new Error("Expected HTTP OAuth connector");
    return connector.oauth;
  };
  const discovery = { ...oauthTestDiscovery, authorizationServerMetadata: { ...oauthTestDiscovery.authorizationServerMetadata,
    token_endpoint_auth_methods_supported: ["client_secret_post"] } };
  const disk = () => readFileSync(f.file.storePath, "utf8");
  for (const [index, value] of ["keychain-first-secret-sentinel", "keychain-rotated-secret-sentinel"].entries()) {
    secret = value;
    f.target.oauth = resolve(); // The new resolved consumer receives the current Keychain value.
    assert.equal(f.target.oauth.clientSecret, value);
    const provider = new FileConnectorOAuthProvider({ connectorName: f.target.connectorName, channelRoot: f.target.channelRoot, oauth: f.target.oauth });
    provider.saveDiscoveryState(discovery);
    // Model a state file left by the pre-fix consent path, including a stale registration.
    const stored = JSON.parse(disk());
    stored.clientInformation = { client_id: "stale-client", client_secret: "legacy-secret-sentinel" };
    writeFileSync(provider.storePath, JSON.stringify(stored));
    assert.equal(provider.clientInformation()?.client_secret, value);
    const pending = await paired(f);
    assert.equal(pending.url.searchParams.get("client_id"), "synthetic-client");
    assert.doesNotMatch(pending.url.toString(), /secret-sentinel/);
    assert.equal(f.manager.callback(pending.browser, new URLSearchParams({ state: pending.url.searchParams.get("state")!, code: "synthetic-code" })), true);
    await until(() => f.notices.length === index + 1);
    assert.match(f.notices[index]!.message, /Authorization complete/);
    assert.equal(f.exchanges[index]!.get("client_secret"), value);
    assert.equal(f.exchanges[index]!.get("client_id"), "synthetic-client");
    assert.equal(provider.tokens()?.access_token, "synthetic-new-access");
    assert.equal(JSON.parse(disk()).clientInformation, undefined);
    assert.doesNotMatch(disk(), /secret-sentinel/);
    const restarted = new FileConnectorOAuthProvider({ connectorName: f.target.connectorName, channelRoot: f.target.channelRoot, oauth: f.target.oauth });
    assert.equal(restarted.clientInformation()?.client_secret, value);
    restarted.saveTokens({ access_token: "expired-access", refresh_token: "issued-refresh", token_type: "Bearer" });
    assert.equal(await auth(restarted, { serverUrl: f.target.connectorUrl, fetchFn: async (url, init) => {
      assert.equal(String(url), "https://login.example.org/token");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("client_secret"), value);
      return Response.json({ access_token: "refreshed-access", token_type: "Bearer" });
    } }), "AUTHORIZED");
    assert.equal(restarted.tokens()?.access_token, "refreshed-access");
    assert.doesNotMatch(disk(), /secret-sentinel/);
  }
});
