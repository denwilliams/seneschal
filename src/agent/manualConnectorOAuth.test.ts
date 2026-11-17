import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { oauthTestDiscovery as discovery } from "./connectorOAuth-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConnectorOAuthProvider, ManualAuthorizationError } from "./connectorOAuth.ts";
import {
  completeManualConnectorOAuth,
  encodeManualAuthorizationPayload,
  parseManualAuthorizationPayload,
  startManualConnectorOAuth,
  resetManualConnectorOAuth,
} from "./manualConnectorOAuth.ts";

const oauth = {
  clientId: "client-id",
  redirectUrl: "https://oauth-complete.example.org/",
  manualCompletionTtlSeconds: 600,
};

function options(root: string) {
  return { connectorName: "calendar", channelRoot: root, connectorUrl: "https://mcp.example.org/mcp", oauth };
}

test("manual result payload is strict and does not accept extra redirect fields", () => {
  const payload = encodeManualAuthorizationPayload({ state: "state", code: "code" });
  assert.deepEqual(parseManualAuthorizationPayload(payload), { state: "state", code: "code" });

  const invalid = `oauth-result-v1.${Buffer.from(JSON.stringify({ version: 1, state: "state", code: "code", error_description: "nope" })).toString("base64url")}`;
  assert.throws(() => parseManualAuthorizationPayload(invalid), ManualAuthorizationError);
});

test("manual completion uses the PKCE verifier only after one-time state validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "manual-oauth-"));
  let authorizationUrl: URL | undefined;
  await startManualConnectorOAuth({
    ...options(root),
    authorize: async (provider) => {
      const state = await provider.state!();
      provider.saveCodeVerifier("pkce-verifier");
      authorizationUrl = new URL("https://login.example.org/authorize");
      authorizationUrl.searchParams.set("state", state);
      await provider.redirectToAuthorization(authorizationUrl);
      return "REDIRECT";
    },
  });
  const state = authorizationUrl!.searchParams.get("state")!;
  const payload = encodeManualAuthorizationPayload({ state, code: "one-time-code" });

  let exchanged = false;
  await completeManualConnectorOAuth({
    ...options(root),
    payload,
    authorize: async (provider, input) => {
      assert.equal(input.authorizationCode, "one-time-code");
      assert.equal(await provider.codeVerifier(), "pkce-verifier");
      exchanged = true;
      return "AUTHORIZED";
    },
  });
  assert.equal(exchanged, true);
  await assert.rejects(() => completeManualConnectorOAuth({ ...options(root), payload, authorize: async () => "AUTHORIZED" }), ManualAuthorizationError);
});

test("expired sessions delete their verifier and cannot be exchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "manual-oauth-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const provider = new FileConnectorOAuthProvider({
    connectorName: "calendar",
    channelRoot: root,
    oauth: { ...oauth, manualCompletionTtlSeconds: 60 },
    now: () => now,
  });
  const state = provider.state();
  provider.saveCodeVerifier("pkce-verifier");
  now = new Date("2026-01-01T00:01:00.000Z");
  assert.throws(() => provider.consumeManualAuthorizationResult({ state, code: "code" }), /expired/);
  assert.throws(() => provider.codeVerifier(), /missing/);
});

const readScope = "mcp:read account:read";

test("real SDK uses configured scope for dynamic registration and manual authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "manual-oauth-"));
  const config = { ...oauth, clientId: undefined, scope: readScope };
  new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: root, oauth: config }).saveDiscoveryState(discovery);
  const registered: string[] = [];
  const started = await startManualConnectorOAuth({ ...options(root), oauth: config,
    authorize: (provider, input) => auth(provider, { ...input, fetchFn: async (url, init) => {
      assert.equal(String(url), "https://login.example.org/register");
      const metadata = JSON.parse(String(init?.body));
      registered.push(metadata.scope);
      return Response.json({ ...metadata, client_id: "new-dynamic-client" });
    } }),
  });
  assert.deepEqual(registered, [readScope]);
  assert.equal(started.authorizationUrl?.searchParams.get("scope"), readScope);
  assert.equal(started.authorizationUrl?.searchParams.get("resource"), "https://mcp.example.org");
  assert.equal(started.authorizationUrl?.searchParams.get("code_challenge_method"), "S256");
});

test("manual auth reuses cached client with explicit scope; omitted scope keeps SDK defaults", async () => {
  for (const scope of [readScope, undefined]) {
    const root = mkdtempSync(join(tmpdir(), "manual-oauth-"));
    const config = { ...oauth, clientId: undefined, scope };
    const provider = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: root, oauth: config });
    provider.saveDiscoveryState(discovery);
    provider.saveClientInformation({ client_id: "cached-client", scope: readScope });
    const started = await startManualConnectorOAuth({ ...options(root), oauth: config,
      authorize: (provider, input) => auth(provider, { ...input, fetchFn: async () => { throw new Error("unexpected network"); } }),
    });
    assert.equal(started.authorizationUrl?.searchParams.get("client_id"), "cached-client");
    assert.equal(started.authorizationUrl?.searchParams.get("scope"), scope ?? discovery.resourceMetadata.scopes_supported.join(" "));
  }
});

test("completion passes the same explicit scope to the SDK", async () => {
  const root = mkdtempSync(join(tmpdir(), "manual-oauth-"));
  const config = { ...oauth, scope: readScope };
  const provider = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: root, oauth: config });
  const state = provider.state();
  provider.saveCodeVerifier("verifier");
  await completeManualConnectorOAuth({ ...options(root), oauth: config,
    payload: encodeManualAuthorizationPayload({ state, code: "code" }),
    authorize: async (_provider, input) => { assert.equal(input.scope, readScope); return "AUTHORIZED"; },
  });
});

test("reset clears configured store only, invalidates pending completion and preserves static identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "manual-oauth-"));
  const config = { ...oauth, tokenFile: join(root, "custom-private-store.json") };
  const target = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: root, oauth: config });
  const other = new FileConnectorOAuthProvider({ connectorName: "other", channelRoot: root, oauth });
  other.saveTokens({ access_token: "other-token", token_type: "Bearer" });
  const untouched = readFileSync(other.storePath, "utf8");
  target.saveClientInformation({ client_id: "stale-client" });
  target.saveTokens({ access_token: "old-token", token_type: "Bearer", refresh_token: "old-refresh" });
  target.saveDiscoveryState(discovery);
  const state = target.state();
  target.saveCodeVerifier("old-verifier");
  await target.redirectToAuthorization(new URL("https://login.example.org/authorize?state=private-state"));
  resetManualConnectorOAuth({ ...options(root), oauth: config });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(target.storePath, "utf8"))), ["updatedAt"]);
  assert.deepEqual(target.clientInformation(), { client_id: "client-id" });
  assert.equal(target.tokens(), undefined);
  assert.equal(target.discoveryState(), undefined);
  assert.throws(() => target.codeVerifier(), /missing/);
  await assert.rejects(() => completeManualConnectorOAuth({ ...options(root), oauth: config,
    payload: encodeManualAuthorizationPayload({ state, code: "old-code" }),
    authorize: async () => { assert.fail("must not exchange after reset"); },
  }), ManualAuthorizationError);
  assert.equal(readFileSync(other.storePath, "utf8"), untouched);
});
