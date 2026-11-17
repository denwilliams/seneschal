import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";
import { oauthTestDiscovery } from "./connectorOAuth-fixture.ts";

const current = { client_id: "current-client", client_secret: "current-static-secret", token_endpoint_auth_method: "client_secret_post" };
const legacy = { client_id: "old-client", client_secret: "old-static-secret" };
const tokens = { access_token: "issued-access", refresh_token: "issued-refresh", token_type: "Bearer" };

test("every OAuth state writer strips legacy static client copies without changing current credentials", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "static-oauth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: root,
    oauth: { clientId: current.client_id, clientSecret: current.client_secret, tokenEndpointAuthMethod: "client_secret_post",
      redirectUrl: "https://console.example.org/oauth/callback", manualCompletionTtlSeconds: 600, tokenFile: join(root, "custom.json") },
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const writers: Record<string, () => unknown> = {
    state: () => provider.state(),
    client: () => provider.saveClientInformation(legacy),
    tokens: () => provider.saveTokens({ access_token: "new-access", token_type: "Bearer" }),
    verifier: () => provider.saveCodeVerifier("new-verifier"),
    discovery: () => provider.saveDiscoveryState(oauthTestDiscovery),
    redirect: () => provider.redirectToAuthorization(new URL("https://login.example.org/authorize?client_id=current-client")),
    cancel: () => provider.cancelAuthorizationSession("pending-state"),
    consume: () => provider.consumeManualAuthorizationResult({ state: "pending-state", code: "code" }),
    denied: () => assert.throws(() => provider.consumeManualAuthorizationResult({ state: "pending-state", error: "access_denied" }), /denied/),
    expired: () => {
      const stored = JSON.parse(readFileSync(provider.storePath, "utf8"));
      stored.authorizationSession.expiresAt = "2025-01-01T00:00:00Z";
      writeFileSync(provider.storePath, JSON.stringify(stored));
      assert.throws(() => provider.consumeManualAuthorizationResult({ state: "pending-state", code: "code" }), /expired/);
    },
    commit: () => provider.commitAuthorization(provider.credentialRevision(), { clientInformation: current, tokens, discoveryState: oauthTestDiscovery }),
    ...Object.fromEntries((["all", "client", "tokens", "verifier", "discovery"] as const).map((scope) => [
      "invalidate-" + scope, () => provider.invalidateCredentials(scope),
    ])),
  };
  for (const [name, write] of Object.entries(writers)) {
    await t.test(name, async () => {
      writeFileSync(provider.storePath, JSON.stringify({ clientInformation: legacy, tokens, codeVerifier: "verifier",
        authorizationSession: { state: "pending-state", expiresAt: "2026-01-01T00:10:00Z" } }));
      assert.deepEqual(provider.clientInformation(), current, "ignore stale disk copy before any write");
      await write();
      const stored = readFileSync(provider.storePath, "utf8");
      assert.equal(JSON.parse(stored).clientInformation, undefined);
      assert.doesNotMatch(stored, /old-static-secret|current-static-secret/);
      assert.deepEqual(provider.clientInformation(), current, "disk writes and invalidation cannot override static config");
    });
  }
});

test("dynamic registration credentials still persist across consent, refresh and restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dynamic-oauth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { connectorName: "calendar", channelRoot: root,
    oauth: { redirectUrl: "https://console.example.org/oauth/callback", manualCompletionTtlSeconds: 600 } };
  const provider = new FileConnectorOAuthProvider(options);
  const registration = { client_id: "dynamic-client", client_secret: "dynamic-issued-secret", redirect_uris: [options.oauth.redirectUrl] };
  provider.saveClientInformation(registration);
  assert.deepEqual(new FileConnectorOAuthProvider(options).clientInformation(), registration);
  provider.commitAuthorization(provider.credentialRevision(), { clientInformation: registration, tokens, discoveryState: oauthTestDiscovery });
  const restarted = new FileConnectorOAuthProvider(options);
  restarted.saveTokens({ access_token: "refreshed-access", token_type: "Bearer" });
  assert.deepEqual(restarted.clientInformation(), registration);
  assert.equal(restarted.tokens()?.refresh_token, tokens.refresh_token);
  assert.deepEqual(JSON.parse(readFileSync(provider.storePath, "utf8")).clientInformation, registration);
});
