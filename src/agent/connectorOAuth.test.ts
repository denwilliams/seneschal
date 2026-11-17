import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";

test("file connector OAuth provider exposes static client information", () => {
  const root = mkdtempSync(join(tmpdir(), "connector-oauth-"));
  const provider = new FileConnectorOAuthProvider({
    connectorName: "calendar",
    channelRoot: root,
    oauth: {
      clientId: "client-id",
      clientSecret: "secret",
      redirectUrl: "http://localhost:37645/oauth/callback",
      manualCompletionTtlSeconds: 600,
      tokenEndpointAuthMethod: "client_secret_post",
    },
  });

  assert.deepEqual(provider.clientInformation(), {
    client_id: "client-id",
    client_secret: "secret",
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.deepEqual(provider.clientMetadata.redirect_uris, ["http://localhost:37645/oauth/callback"]);
});

test("file connector OAuth provider persists verifier and preserves refresh token", () => {
  const root = mkdtempSync(join(tmpdir(), "connector-oauth-"));
  const tokenFile = join(root, "tokens.json");
  const provider = new FileConnectorOAuthProvider({
    connectorName: "calendar",
    channelRoot: root,
    oauth: {
      redirectUrl: "http://localhost:37645/oauth/callback",
      manualCompletionTtlSeconds: 600,
      tokenFile,
    },
  });

  provider.saveCodeVerifier("verifier");
  assert.equal(provider.codeVerifier(), "verifier");

  provider.saveTokens({ access_token: "one", token_type: "Bearer", refresh_token: "refresh" });
  provider.saveTokens({ access_token: "two", token_type: "Bearer" });

  assert.deepEqual(provider.tokens(), {
    access_token: "two",
    token_type: "Bearer",
    refresh_token: "refresh",
  });
  const stored = JSON.parse(readFileSync(tokenFile, "utf-8"));
  assert.equal(stored.tokens.refresh_token, "refresh");
});

test("canceling an abandoned OAuth session clears only its own pending state", async () => {
  const root = mkdtempSync(join(tmpdir(), "connector-oauth-"));
  const provider = new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: root,
    oauth: { redirectUrl: "http://localhost:37645/oauth/callback", manualCompletionTtlSeconds: 600 },
  });
  provider.saveTokens({ access_token: "existing", token_type: "Bearer" });
  provider.saveClientInformation({ client_id: "existing-client" });
  const state = provider.state();
  provider.saveCodeVerifier("pending-verifier");
  await provider.redirectToAuthorization(new URL("https://login.example.org/authorize?state=synthetic"));
  provider.cancelAuthorizationSession("different-session");
  assert.equal(provider.codeVerifier(), "pending-verifier");
  provider.cancelAuthorizationSession(state);
  const stored = JSON.parse(readFileSync(provider.storePath, "utf8"));
  assert.equal(stored.authorizationSession, undefined);
  assert.equal(stored.authorizationUrl, undefined);
  assert.equal(stored.codeVerifier, undefined);
  assert.equal(provider.tokens()?.access_token, "existing");
  assert.equal(provider.clientInformation()?.client_id, "existing-client");
});
