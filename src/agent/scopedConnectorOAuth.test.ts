import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";
import { createScopedConnectorOAuthFetch } from "./scopedConnectorOAuth.ts";
import { oauthTestDiscovery as discovery } from "./connectorOAuth-fixture.ts";

const connectorUrl = "https://mcp.example.org/mcp";
const oauth = { redirectUrl: "http://localhost:37645/oauth/callback", manualCompletionTtlSeconds: 600, scope: "mcp:read account:read" };
function provider() {
  const value = new FileConnectorOAuthProvider({ connectorName: "test", channelRoot: mkdtempSync(join(tmpdir(), "scoped-oauth-")), oauth });
  value.saveDiscoveryState(discovery);
  return value;
}
const rejection = (status = 401) => new Response("private server response", { status,
  headers: { "www-authenticate": 'Bearer scope="mcp:read account:read rules:write", error="insufficient_scope"' },
});

test("runtime real SDK registration and consent obey scope despite broader challenges and metadata", async () => {
  for (const status of [401, 403]) {
    const value = provider();
    let consent: URL | undefined;
    value.redirectToAuthorization = async (url) => { consent = url; };
    let registered = false;
    const scopedFetch = createScopedConnectorOAuthFetch({ provider: value, connectorUrl, oauth, fetch: async (url, init) => {
      if (String(url) === connectorUrl) return rejection(status);
      assert.equal(String(url), "https://login.example.org/register");
      const metadata = JSON.parse(String(init?.body));
      assert.equal(metadata.scope, oauth.scope);
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      registered = true;
      return Response.json({ ...metadata, client_id: "dynamic-client" });
    } });
    await assert.rejects(() => scopedFetch(connectorUrl), UnauthorizedError);
    assert.equal(registered, true);
    assert.equal(consent?.searchParams.get("scope"), oauth.scope);
  }
});

test("scoped fetch retries once, refreshes bearer, isolates credentials and sanitizes errors", async () => {
  const value = provider();
  value.saveTokens({ access_token: "old", token_type: "Bearer" });
  const sent: (string | null)[] = [];
  let authCalls = 0;
  const scopedFetch = createScopedConnectorOAuthFetch({ provider: value, connectorUrl, oauth,
    authorize: async (_provider, input) => {
      authCalls++;
      assert.equal(input.scope, oauth.scope);
      value.saveTokens({ access_token: "fresh", token_type: "Bearer" });
      return "AUTHORIZED";
    },
    fetch: async (_url, init) => { sent.push(new Headers(init?.headers).get("authorization")); return rejection(); },
  });
  await assert.rejects(() => scopedFetch(connectorUrl), { message: "Connector OAuth authentication failed; run connector-auth to authorize again." });
  assert.deepEqual(sent, ["Bearer old", "Bearer fresh"]);
  assert.equal(authCalls, 1);
  await scopedFetch("https://unrelated.example.org/mcp");
  await scopedFetch("https://mcp.example.org/redirect-target");
  assert.deepEqual(sent.slice(2), [null, null]);
  const failure = createScopedConnectorOAuthFetch({ provider: value, connectorUrl, oauth,
    fetch: async () => rejection(), authorize: async () => { throw new Error("private-token-and-state"); },
  });
  await assert.rejects(() => failure(connectorUrl), { message: "Connector OAuth authentication failed; run connector-auth to authorize again." });
});

test("parallel runtime challenges share one OAuth refresh", async () => {
  const value = provider();
  let calls = 0;
  const scopedFetch = createScopedConnectorOAuthFetch({ provider: value, connectorUrl, oauth,
    authorize: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      value.saveTokens({ access_token: "fresh", token_type: "Bearer" });
      return "AUTHORIZED";
    },
    fetch: async (_url, init) => new Headers(init?.headers).has("authorization") ? new Response("ok") : rejection(),
  });
  const responses = await Promise.all([scopedFetch(connectorUrl), scopedFetch(connectorUrl)]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.equal(calls, 1);
});

test("real SDK transport initializes and lists tools through scoped fetch with token refresh", async () => {
  const value = provider();
  value.saveClientInformation({ client_id: "cached-client", issuer: discovery.authorizationServerUrl });
  value.saveTokens({ access_token: "expired", refresh_token: "refresh", token_type: "Bearer", issuer: discovery.authorizationServerUrl });
  let tokenRequests = 0;
  const scopedFetch = createScopedConnectorOAuthFetch({ provider: value, connectorUrl, oauth, fetch: async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url) === "https://login.example.org/token") {
      tokenRequests++;
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("x-connector-only"), false);
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
      return Response.json({ access_token: "fresh", token_type: "Bearer" });
    }
    assert.equal(String(url), connectorUrl);
    assert.equal(headers.get("x-connector-only"), "private-header");
    if (headers.get("authorization") !== "Bearer fresh") return rejection();
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } }
      : { tools: [] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(connectorUrl), { fetch: scopedFetch, requestInit: { headers: { "x-connector-only": "private-header" } } });
  try {
    await client.connect(transport);
    assert.deepEqual(await client.listTools(), { tools: [] });
    assert.equal(tokenRequests, 1);
    assert.equal(value.tokens()?.refresh_token, "refresh");
  } finally { await client.close(); }
});

test("migrated scoped connector failures direct recovery to Slack/web Connect, never incompatible manual CLI", async () => {
  const value = provider();
  const consoleOauth = { ...oauth, consoleCallback: true, redirectUrl: "https://console.example.org/oauth/callback" };
  const scopedFetch = createScopedConnectorOAuthFetch({ provider: value, connectorUrl, oauth: consoleOauth,
    fetch: async () => rejection(), authorize: async () => { throw new Error("synthetic-private-provider-data"); },
  });
  await assert.rejects(() => scopedFetch(connectorUrl), (e: Error) => {
    assert.match(e.message, /!connector-auth connect/);
    assert.match(e.message, /channel web page/);
    assert.doesNotMatch(e.message, /run connector-auth|synthetic-private-provider-data/);
    return true;
  });
});

test("scoped console recovery errors direct Slack connect, not incompatible CLI auth", async () => {
  for (const failure of ["provider", "retry"] as const) {
    const scopedFetch = createScopedConnectorOAuthFetch({ provider: provider(), connectorUrl,
      oauth: { ...oauth, consoleCallback: true, redirectUrl: "https://console.example.org/harness/oauth/callback" },
      fetch: async () => rejection(),
      authorize: async () => {
        if (failure === "provider") throw new Error("synthetic-private-provider-error");
        return "AUTHORIZED";
      },
    });
    await assert.rejects(() => scopedFetch(connectorUrl), (error: Error) => {
      assert.match(error.message, /!connector-auth connect/);
      assert.doesNotMatch(error.message, /run connector-auth|synthetic-private/);
      return true;
    });
  }
});
