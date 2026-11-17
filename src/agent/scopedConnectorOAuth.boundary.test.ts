import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createScopedConnectorOAuthFetch } from "./scopedConnectorOAuth.ts";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";
import { oauthTestDiscovery as discovery } from "./connectorOAuth-fixture.ts";
import { openConnectors } from "./connectors.ts";
import { logger } from "../util/log.ts";

const endpoint = "https://mcp.example.org/mcp";
const oauth = { redirectUrl: "http://localhost:37645/oauth/callback", manualCompletionTtlSeconds: 600, scope: "mcp:read account:read" };
const secret = "SYNTHETIC_PRIVATE_ACCESS_TOKEN_AND_STATE";
function rejection(status = 401) {
  return new Response(secret, { status, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="mcp:read account:read rules:write"' } });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scoped-oauth-boundary-"));
  const provider = new FileConnectorOAuthProvider({ connectorName: "test", channelRoot: root, oauth });
  provider.saveDiscoveryState(discovery);
  return { root, provider };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function seedRefresh(provider: FileConnectorOAuthProvider) {
  provider.saveClientInformation({ client_id: "cached-client", issuer: discovery.authorizationServerUrl });
  provider.saveTokens({ access_token: "old", refresh_token: "refresh", token_type: "Bearer", issuer: discovery.authorizationServerUrl });
}
async function rejectsPromptly(promise: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(() => Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("aborted caller remained blocked")), 250);
    })]), { name: "AbortError" });
  } finally { clearTimeout(timer); }
}

for (const status of [401, 403]) test(`real transport final ${status} auth rejection is sanitized`, async () => {
  const { provider } = fixture();
  const fetch = createScopedConnectorOAuthFetch({ provider, connectorUrl: endpoint, oauth,
    authorize: async () => "AUTHORIZED", fetch: async () => rejection(status),
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await assert.rejects(() => client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { fetch })), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /OAuth.*authorize again/i);
      return true;
    });
  } finally { await client.close(); }
});

test("production connector failure and logger boundary never expose final auth response bodies", async () => {
  const { root, provider } = fixture();
  seedRefresh(provider);
  const originalFetch = globalThis.fetch;
  const originalWarn = logger.warn;
  const logs: string[] = [];
  globalThis.fetch = async (url) => String(url) === discovery.authorizationServerMetadata.token_endpoint
    ? Response.json({ access_token: "fresh", token_type: "Bearer" }) : rejection();
  logger.warn = (message) => { logs.push(message); };
  try {
    const session = await openConnectors([{ name: "test", origin: "channel", config: { transport: "http", url: endpoint, oauth, headers: {} } }], "C123", {}, root, root);
    try {
      assert.equal(session.failures.length, 1);
      const text = JSON.stringify({ failures: session.failures, logs });
      assert.doesNotMatch(text, new RegExp(secret));
      assert.match(text, /OAuth.*authorize again/i);
    } finally { await session.close(); }
  } finally { globalThis.fetch = originalFetch; logger.warn = originalWarn; }
});

test("one aborted shared-refresh waiter rejects promptly while a live caller completes", async () => {
  const { provider } = fixture();
  seedRefresh(provider);
  const started = deferred<void>();
  const bothChallenged = deferred<void>();
  const gate = deferred<void>();
  let tokenSignal: AbortSignal | null | undefined;
  let challenges = 0;
  let tokens = 0;
  const fetch = createScopedConnectorOAuthFetch({ provider, connectorUrl: endpoint, oauth, fetch: async (url, init) => {
    if (String(url) === discovery.authorizationServerMetadata.token_endpoint) {
      tokens++;
      tokenSignal = init?.signal;
      started.resolve();
      await gate.promise; // Deliberately ignores signal: adapter must guard writes too.
      return Response.json({ access_token: "fresh", token_type: "Bearer" });
    }
    if (new Headers(init?.headers).get("authorization") === "Bearer fresh") return new Response("ok");
    if (++challenges === 2) bothChallenged.resolve();
    return rejection();
  } });
  const controller = new AbortController();
  const canceled = fetch(endpoint, { signal: controller.signal });
  const survivor = fetch(endpoint);
  const rejectionCheck = rejectsPromptly(canceled); // Attach rejection observer before abort.
  try {
    await Promise.all([started.promise, bothChallenged.promise]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(secret);
    await rejectionCheck;
    assert.equal(tokenSignal?.aborted, false);
  } finally { gate.resolve(); }
  assert.equal((await survivor).status, 200);
  assert.equal(tokens, 1);
});

test("last-waiter abort cancels DCR and suppresses post-abort client/PKCE/consent writes", async () => {
  const { provider } = fixture();
  const before = readFileSync(provider.storePath, "utf8");
  const started = deferred<void>();
  const finished = deferred<void>();
  const gate = deferred<void>();
  let oauthSignal: AbortSignal | null | undefined;
  let consent = 0;
  provider.redirectToAuthorization = async () => { consent++; };
  const fetch = createScopedConnectorOAuthFetch({ provider, connectorUrl: endpoint, oauth, fetch: async (url, init) => {
    if (String(url) === endpoint) return rejection();
    assert.equal(String(url), discovery.authorizationServerMetadata.registration_endpoint);
    oauthSignal = init?.signal;
    started.resolve();
    await gate.promise;
    finished.resolve();
    return Response.json({ ...JSON.parse(String(init?.body)), client_id: "post-abort-client" });
  } });
  const controller = new AbortController();
  const canceled = fetch(endpoint, { signal: controller.signal });
  const rejectionCheck = rejectsPromptly(canceled);
  try {
    await started.promise;
    controller.abort(secret);
    await rejectionCheck;
    assert.equal(oauthSignal?.aborted, true);
  } finally { gate.resolve(); }
  await finished.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readFileSync(provider.storePath, "utf8"), before);
  assert.equal(consent, 0);
});

test("already-aborted calls do not fetch, authenticate or echo their abort reason", async () => {
  const { provider } = fixture();
  const controller = new AbortController();
  controller.abort(secret);
  let called = false;
  const fetch = createScopedConnectorOAuthFetch({ provider, connectorUrl: endpoint, oauth,
    authorize: async () => { called = true; return "AUTHORIZED"; },
    fetch: async () => { called = true; return rejection(); },
  });
  await assert.rejects(() => fetch(endpoint, { signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  assert.equal(called, false);
});

test("abandoned refresh cannot save late tokens and a subsequent live flight succeeds", async () => {
  const { provider } = fixture();
  seedRefresh(provider);
  const before = readFileSync(provider.storePath, "utf8");
  const started = deferred<void>();
  const gate = deferred<void>();
  const oldFinished = deferred<void>();
  let requests = 0;
  let oauthSignal: AbortSignal | null | undefined;
  const fetch = createScopedConnectorOAuthFetch({ provider, connectorUrl: endpoint, oauth, fetch: async (url, init) => {
    if (String(url) === discovery.authorizationServerMetadata.token_endpoint) {
      if (++requests === 1) {
        oauthSignal = init?.signal;
        started.resolve();
        await gate.promise;
        oldFinished.resolve();
        return Response.json({ access_token: "must-not-be-saved", token_type: "Bearer" });
      }
      return Response.json({ access_token: "fresh", token_type: "Bearer" });
    }
    return new Headers(init?.headers).get("authorization") === "Bearer fresh" ? new Response("ok") : rejection();
  } });
  const controller = new AbortController();
  const abandoned = fetch(endpoint, { signal: controller.signal });
  const rejectionCheck = rejectsPromptly(abandoned);
  try {
    await started.promise;
    controller.abort();
    await rejectionCheck;
    assert.equal(oauthSignal?.aborted, true);
    assert.equal(readFileSync(provider.storePath, "utf8"), before);
    assert.equal((await fetch(endpoint)).status, 200);
  } finally { gate.resolve(); }
  await oldFinished.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.tokens()?.access_token, "fresh");
  assert.equal(requests, 2);
});

test("late canceled provider calls cannot create consent or delete a newer manual session", async () => {
  const { provider } = fixture();
  const started = deferred<void>();
  const gate = deferred<void>();
  const stopped = deferred<void>();
  let consent = 0;
  const controller = new AbortController();
  provider.redirectToAuthorization = async () => { consent++; };
  const fetch = createScopedConnectorOAuthFetch({ provider, connectorUrl: endpoint, oauth,
    fetch: async () => rejection(),
    authorize: async (guarded) => {
      await guarded.state!();
      guarded.saveCodeVerifier("abandoned-verifier");
      started.resolve();
      await gate.promise;
      try { await guarded.redirectToAuthorization(new URL("https://login.example.org/authorize")); }
      finally { stopped.resolve(); }
      return "REDIRECT";
    },
  });
  const canceled = fetch(endpoint, { signal: controller.signal });
  const rejectionCheck = rejectsPromptly(canceled);
  let freshState: string;
  try {
    await started.promise;
    controller.abort();
    await rejectionCheck;
    freshState = provider.state();
    provider.saveCodeVerifier("fresh-manual-verifier");
  } finally { gate.resolve(); }
  await stopped.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(consent, 0);
  assert.equal(provider.codeVerifier(), "fresh-manual-verifier");
  provider.consumeManualAuthorizationResult({ state: freshState!, code: "fresh-code" });
});
