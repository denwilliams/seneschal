/** Synthetic, offline SDK integration fixture. Nothing here is a live credential/provider. */
import assert from "node:assert/strict";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { oauthTestDiscovery } from "./connectorOAuth-fixture.ts";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";
import { ConsoleConnectorOAuth, type BrowserPairing, type ConsoleOAuthHooks, type ConsoleOAuthTarget, type WebBrowserPairing } from "./consoleConnectorOAuth.ts";

export function consoleOAuthFixture(t: TestContext, hooks: Partial<ConsoleOAuthHooks> = {}) {
  const root = mkdtempSync(join(tmpdir(), "console-oauth-"));
  const target: ConsoleOAuthTarget = { userId: "UINITIATOR", channelId: "CTARGET", threadTs: "123.456", connectorName: "calendar", channelRoot: root,
    connectorUrl: "https://mcp.example.org/mcp", oauth: { clientId: "synthetic-client", redirectUrl: "https://console.example.org/harness/oauth/callback",
      consoleCallback: true, manualCompletionTtlSeconds: 600, scope: "mcp:read", tokenEndpointAuthMethod: "none" } };
  const file = new FileConnectorOAuthProvider({ connectorName: target.connectorName, channelRoot: root, oauth: target.oauth });
  file.saveDiscoveryState(oauthTestDiscovery);
  const pairings: BrowserPairing[] = [];
  const webPairings: WebBrowserPairing[] = [];
  const notices: Array<{ target: ConsoleOAuthTarget; message: string }> = [];
  const exchanges: URLSearchParams[] = [];
  let response: () => Promise<Response> = async () => Response.json({ access_token: "synthetic-new-access", token_type: "Bearer" });
  const authorize: typeof auth = (provider, options) => auth(provider, { ...options, fetchFn: async (url, init) => {
    assert.equal(String(url), "https://login.example.org/token");
    exchanges.push(new URLSearchParams(String(init?.body)));
    return response();
  } });
  const manager = new ConsoleConnectorOAuth({ callbackUrl: target.oauth.redirectUrl, ttlSeconds: 600 }, {
    browserTarget: (channelId, connectorName) => channelId === target.channelId && connectorName === target.connectorName ? {
      channelId, connectorName, channelRoot: target.channelRoot, connectorUrl: target.connectorUrl, oauth: target.oauth,
    } : undefined,
    webPairing: async (pairing) => { webPairings.push(pairing); return "789.012"; },
    allowed: () => true, pairing: async (p) => { pairings.push(p); }, notify: async (target, message) => { notices.push({ target, message }); }, authorize, ...hooks,
  });
  t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
  return { manager, target, file, pairings, webPairings, notices, exchanges, authorize, setResponse: (next: typeof response) => { response = next; } };
}
export async function paired(f: ReturnType<typeof consoleOAuthFixture>) {
  const link = f.manager.start(f.target);
  const claimed = await f.manager.claim(new URL(link).hash.slice(1));
  const pairing = f.pairings.at(-1)!;
  assert.equal(pairing.phrase, claimed.phrase);
  assert.equal(f.manager.decide(pairing.id, f.target.userId, f.target.channelId, true), true);
  const result = await f.manager.poll(claimed.browser);
  assert.ok(result.authorizationUrl);
  return { browser: claimed.browser, url: new URL(result.authorizationUrl), id: pairing.id };
}
export async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected async operation to settle");
}
