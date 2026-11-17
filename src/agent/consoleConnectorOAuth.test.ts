import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { consoleOAuthFixture, paired, until } from "./consoleConnectorOAuth-fixture.ts";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";
import { oauthTestDiscovery } from "./connectorOAuth-fixture.ts";

function response(state: string, extra = {}) { return new URLSearchParams({ state, code: "synthetic-auth-code", ...extra }); }

test("SDK console consent uses explicit scope, exact redirect and S256; atomic channel grant has no prior refresh token", async (t) => {
  const f = consoleOAuthFixture(t);
  f.file.saveTokens({ access_token: "synthetic-old-access", token_type: "Bearer", refresh_token: "synthetic-old-refresh" });
  const before = readFileSync(f.file.storePath, "utf8");
  const { browser, url } = await paired(f);
  assert.equal(url.searchParams.get("scope"), "mcp:read");
  assert.equal(url.searchParams.get("redirect_uri"), f.target.oauth.redirectUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(readFileSync(f.file.storePath, "utf8"), before, "pending consent never writes into runtime/manual state");
  const other = new FileConnectorOAuthProvider({ connectorName: "other", channelRoot: f.target.channelRoot, oauth: f.target.oauth });
  assert.equal(f.manager.callback(browser, response(url.searchParams.get("state")!)), true);
  assert.equal(f.manager.callback(browser, response(url.searchParams.get("state")!)), false, "state consumed before async exchange");
  await until(() => f.notices.length === 1);
  assert.match(f.notices[0]!.message, /Authorization complete/);
  assert.equal(f.file.tokens()?.access_token, "synthetic-new-access");
  assert.equal(f.file.tokens()?.refresh_token, undefined);
  assert.equal(other.tokens(), undefined);
  assert.equal(statSync(f.file.storePath).mode & 0o777, 0o600);
  const saved = readFileSync(f.file.storePath, "utf8");
  assert.doesNotMatch(saved, /codeVerifier|authorizationSession|synthetic-auth-code/);
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.exchanges[0]!.get("redirect_uri"), f.target.oauth.redirectUrl);
  assert.equal(f.exchanges[0]!.get("code"), "synthetic-auth-code");
  assert.ok(f.exchanges[0]!.get("code_verifier"));
  assert.doesNotMatch(JSON.stringify(f.notices), /synthetic-auth-code|synthetic-new-access|synthetic-old-refresh/);
  assert.equal(f.notices[0]!.target.threadTs, "123.456");
});

test("private link claim requires initiating Slack user approval; console visitor and other channel cannot claim consent", async (t) => {
  const f = consoleOAuthFixture(t);
  const link = f.manager.start(f.target);
  assert.equal(new URL(link).search, "");
  assert.equal(new URL(link).origin, f.manager.origin);
  const capability = new URL(link).hash.slice(1);
  const claimed = await f.manager.claim(capability);
  await assert.rejects(f.manager.claim(capability), /unavailable/);
  const id = f.pairings[0]!.id;
  assert.equal(f.manager.decide(id, "UOTHER", f.target.channelId, true), false);
  assert.equal(f.manager.decide(id, f.target.userId, "COTHER", true), false);
  assert.deepEqual(await f.manager.poll(claimed.browser), { status: "waiting" });
  assert.equal(f.exchanges.length, 0);
  await assert.rejects(f.manager.poll("another-console-visitor"));
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, true), true);
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, true), false);
  const consent = await f.manager.poll(claimed.browser);
  const state = new URL(consent.authorizationUrl!).searchParams.get("state")!;
  assert.equal(f.manager.callback("another-console-visitor", response(state)), false);
  assert.equal(f.manager.callback(claimed.browser, response("wrong-state")), false);
  assert.equal(f.manager.callback(claimed.browser, response(state)), true);
  await until(() => f.notices.length === 1);
  assert.equal(f.exchanges.length, 1);
});

test("flights serialize the channel/connector even for another Slack user; distinct channels have separate state", async (t) => {
  const f = consoleOAuthFixture(t);
  const first = f.manager.start(f.target);
  assert.throws(() => f.manager.start({ ...f.target, userId: "UOTHER" }), /already pending/);
  const second = f.manager.start({ ...f.target, channelId: "COTHER", channelRoot: `${f.target.channelRoot}/other-channel` });
  assert.notEqual(first, second);
  await f.manager.claim(new URL(first).hash.slice(1));
  assert.equal(f.manager.decide(f.pairings[0]!.id, f.target.userId, "COTHER", false), false);
  assert.equal(f.manager.decide(f.pairings[0]!.id, f.target.userId, f.target.channelId, false), true);
  assert.match(f.notices[0]!.message, /denied or cancelled/);
  assert.ok(f.manager.start(f.target));
});

test("fixed external callback, opt-in, safe names, custom store and stale DCR registration guards", (t) => {
  const f = consoleOAuthFixture(t);
  assert.throws(() => f.manager.start({ ...f.target, oauth: { ...f.target.oauth, consoleCallback: false } }));
  assert.throws(() => f.manager.start({ ...f.target, oauth: { ...f.target.oauth, redirectUrl: "https://attacker.example.org/oauth/callback" } }));
  assert.throws(() => f.manager.start({ ...f.target, oauth: { ...f.target.oauth, tokenFile: "../shared.json" } }), /default channel-private/);
  assert.throws(() => f.manager.start({ ...f.target, connectorName: "calendar/other" }));
  const dynamic = { ...f.target, oauth: { ...f.target.oauth, clientId: undefined } };
  const registration = new FileConnectorOAuthProvider({ connectorName: dynamic.connectorName, channelRoot: dynamic.channelRoot, oauth: dynamic.oauth });
  registration.saveClientInformation({ client_id: "synthetic-dcr", redirect_uris: ["http://localhost:9876/callback"] });
  assert.throws(() => f.manager.start(dynamic), /another redirect URI/);
});

test("expiry cleans and reports link and consent state; restart invalidates all uncompleted links", async (t) => {
  let now = 1000;
  const f = consoleOAuthFixture(t, { now: () => now });
  const link = f.manager.start(f.target);
  now += 600_000;
  f.manager.sweep();
  assert.match(f.notices[0]!.message, /expired/);
  await assert.rejects(f.manager.claim(new URL(link).hash.slice(1)));
  now++;
  const pending = await paired(f);
  now += 600_000;
  assert.equal(f.manager.callback(pending.browser, response(pending.url.searchParams.get("state")!)), false);
  assert.equal(f.exchanges.length, 0);
  f.manager.start(f.target);
  f.manager.close();
  assert.throws(() => f.manager.start(f.target));
  assert.match(f.notices.at(-1)!.message, /harness stopped/);
});

test("expired delayed exchange cannot commit credentials or report success", async (t) => {
  let now = 0;
  const f = consoleOAuthFixture(t, { now: () => now });
  let resolve!: (response: Response) => void;
  f.setResponse(() => new Promise<Response>((r) => { resolve = r; }));
  const pending = await paired(f);
  f.manager.callback(pending.browser, response(pending.url.searchParams.get("state")!));
  await until(() => f.exchanges.length === 1);
  now = 600_001;
  f.manager.sweep();
  resolve(Response.json({ access_token: "synthetic-late-token", token_type: "Bearer" }));
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.file.tokens(), undefined);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!.message, /expired/);
});

for (const mutation of ["runtime", "permissions"] as const) test(`concurrent ${mutation} change prevents commit without destroying newer state`, async (t) => {
  let allowed = true;
  const f = consoleOAuthFixture(t, { allowed: () => allowed });
  const pending = await paired(f);
  let resolve!: (response: Response) => void;
  f.setResponse(() => new Promise<Response>((r) => { resolve = r; }));
  f.manager.callback(pending.browser, response(pending.url.searchParams.get("state")!));
  await until(() => f.exchanges.length === 1);
  if (mutation === "runtime") f.file.saveTokens({ access_token: "synthetic-rotated-token", token_type: "Bearer" });
  else allowed = false;
  const before = readFileSync(f.file.storePath, "utf8");
  resolve(Response.json({ access_token: "synthetic-must-not-save", token_type: "Bearer" }));
  await until(() => f.notices.length === 1);
  assert.equal(readFileSync(f.file.storePath, "utf8"), before);
  assert.match(f.notices[0]!.message, /could not be saved/);
});

for (const extra of [{ error: "access_denied", error_description: "synthetic-sensitive-description" }, { iss: "https://attacker.example.org" }]) {
  test("denial/issuer mismatch consumes session without exchange or error reflection", async (t) => {
    const f = consoleOAuthFixture(t);
    const pending = await paired(f);
    const query = response(pending.url.searchParams.get("state")!, extra);
    assert.equal(f.manager.callback(pending.browser, query), true);
    assert.equal(f.manager.callback(pending.browser, query), false);
    assert.equal(f.exchanges.length, 0);
    assert.equal(f.file.tokens(), undefined);
    assert.doesNotMatch(JSON.stringify(f.notices), /synthetic-sensitive-description|attacker/);
  });
}

test("duplicate code/state, malformed response, exchange errors and unsupported PKCE remain bounded and sanitized", async (t) => {
  const f = consoleOAuthFixture(t);
  const pending = await paired(f);
  const query = response(pending.url.searchParams.get("state")!);
  query.append("state", query.get("state")!);
  assert.equal(f.manager.callback(pending.browser, query), false, "ambiguous state cannot consume valid flight");
  query.delete("state"); query.set("state", pending.url.searchParams.get("state")!); query.append("code", "second-code");
  assert.equal(f.manager.callback(pending.browser, query), true);
  assert.equal(f.exchanges.length, 0);
  const other = await paired(f);
  f.setResponse(async () => { throw new Error("synthetic-provider-token-code-secret"); });
  assert.equal(f.manager.callback(other.browser, response(other.url.searchParams.get("state")!)), true);
  await until(() => f.notices.length === 2);
  assert.doesNotMatch(JSON.stringify(f.notices), /synthetic-provider-token-code-secret/);
  assert.equal(f.file.tokens(), undefined);
  f.file.saveDiscoveryState({ ...oauthTestDiscovery, authorizationServerMetadata: {
    ...oauthTestDiscovery.authorizationServerMetadata, code_challenge_methods_supported: ["plain"],
  } });
  const link = f.manager.start(f.target);
  const claimed = await f.manager.claim(new URL(link).hash.slice(1));
  f.manager.decide(f.pairings.at(-1)!.id, f.target.userId, f.target.channelId, true);
  await assert.rejects(f.manager.poll(claimed.browser));
  assert.match(f.notices.at(-1)!.message, /PKCE support/);
});

test("pending state is capped at 100 globally and cleanup releases capacity", (t) => {
  let now = 0;
  const f = consoleOAuthFixture(t, { now: () => now });
  for (let i = 0; i < 100; i++) f.manager.start({ ...f.target, channelId: `C${i}`, channelRoot: `${f.target.channelRoot}/c${i}` });
  assert.throws(() => f.manager.start(f.target), /Too many pending/);
  now = 600_001;
  f.manager.sweep();
  assert.equal(f.notices.length, 100);
  assert.ok(f.manager.start(f.target));
});

test("revoked permissions and private pairing notification failure do not enter consent", async (t) => {
  let allowed = true;
  const f = consoleOAuthFixture(t, { allowed: () => allowed });
  const link = f.manager.start(f.target);
  const claimed = await f.manager.claim(new URL(link).hash.slice(1));
  allowed = false;
  assert.equal(f.manager.decide(f.pairings[0]!.id, f.target.userId, f.target.channelId, true), false);
  await assert.rejects(f.manager.poll(claimed.browser));
  assert.match(f.notices[0]!.message, /no longer enabled/);
  assert.equal(f.exchanges.length, 0);
  const failing = consoleOAuthFixture(t, { pairing: async () => { throw new Error("synthetic-Slack-private-data"); }, notify: async () => { throw new Error("synthetic-notify-private-data"); } });
  const privateLink = failing.manager.start(failing.target);
  await assert.rejects(failing.manager.claim(new URL(privateLink).hash.slice(1)), (e: Error) => !/synthetic-/.test(e.message));
  assert.ok(failing.manager.start(failing.target));
});

test("channel-page initiation has no user/state/PKCE/consent until an allowed Slack user confirms their own browser", async (t) => {
  const f = consoleOAuthFixture(t, { allowed: (target) => target.userId === "UINITIATOR" });
  const before = readFileSync(f.file.storePath, "utf8");
  const requested = await f.manager.startBrowser(f.target.channelId, f.target.connectorName);
  assert.equal(f.webPairings.length, 1);
  const pairing = f.webPairings[0]!;
  assert.equal(pairing.phrase, requested.phrase);
  assert.equal(Object.hasOwn(pairing.target, "userId"), false);
  assert.equal(Object.hasOwn(pairing, "state"), false);
  assert.equal(Object.hasOwn(pairing, "provider"), false);
  assert.equal(readFileSync(f.file.storePath, "utf8"), before);
  assert.deepEqual(await f.manager.poll(requested.browser), { status: "waiting" });
  assert.equal(f.exchanges.length, 0);
  assert.equal(f.manager.callback(requested.browser, response("unknown-state")), false);
  assert.equal(f.manager.decide(pairing.id, "UOTHER", f.target.channelId, true), false);
  assert.equal(f.manager.decide(pairing.id, "UOTHER", f.target.channelId, false), false, "unauthorized visitor cannot cancel another request either");
  assert.equal(f.manager.decide(pairing.id, "UINITIATOR", "COTHER", true), false);
  assert.equal(f.manager.decide(pairing.id, "", f.target.channelId, true), false);
  assert.deepEqual(await f.manager.poll(requested.browser), { status: "waiting" });
  assert.equal(f.manager.decide(pairing.id, "UINITIATOR", f.target.channelId, true), true);
  assert.equal(f.manager.decide(pairing.id, "UOTHER", f.target.channelId, true), false);
  const consent = new URL((await f.manager.poll(requested.browser)).authorizationUrl!);
  assert.equal(consent.searchParams.get("redirect_uri"), f.manager.callbackUrl);
  assert.equal(f.manager.callback("another-visitor", response(consent.searchParams.get("state")!)), false);
  assert.equal(f.manager.callback(requested.browser, response(consent.searchParams.get("state")!)), true);
  await until(() => f.notices.length === 1);
  assert.match(f.notices[0]!.message, /Authorization complete/);
  assert.equal(f.notices[0]!.target.userId, "UINITIATOR");
  assert.equal(f.notices[0]!.target.threadTs, "789.012", "completion follows the new Slack pairing message thread");
});

test("web requests use trusted channel/connector resolution and share TTL/capacity/scope serialization with Slack starts", async (t) => {
  let now = 0;
  const f = consoleOAuthFixture(t, { now: () => now });
  await assert.rejects(f.manager.startBrowser("CUNKNOWN", "calendar"));
  await assert.rejects(f.manager.startBrowser(f.target.channelId, "unknown"));
  const requested = await f.manager.startBrowser(f.target.channelId, f.target.connectorName);
  await assert.rejects(f.manager.startBrowser(f.target.channelId, f.target.connectorName), /already pending/);
  assert.throws(() => f.manager.start(f.target), /already pending/);
  now = 600_000;
  f.manager.sweep();
  await assert.rejects(f.manager.poll(requested.browser));
  assert.equal(f.manager.decide(f.webPairings[0]!.id, f.target.userId, f.target.channelId, true), false);
  assert.match(f.notices[0]!.message, /expired/);
  assert.equal(f.notices[0]!.target.userId, "", "unapproved request never invents a Slack identity");
  assert.ok(f.manager.start(f.target));
  await assert.rejects(f.manager.startBrowser(f.target.channelId, f.target.connectorName), /already pending/);
});

test("web initiation permission changes and denial cannot promote a stale/unapproved request", async (t) => {
  let allowed = true;
  const f = consoleOAuthFixture(t, { allowed: () => allowed });
  const requested = await f.manager.startBrowser(f.target.channelId, f.target.connectorName);
  const id = f.webPairings[0]!.id;
  allowed = false;
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, true), false);
  assert.equal(f.exchanges.length, 0);
  allowed = true;
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, false), true);
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, true), false);
  await assert.rejects(f.manager.poll(requested.browser));
  assert.match(f.notices[0]!.message, /denied or cancelled/);
});

test("web request delivery, shutdown and delayed delivery failures clean state without leaking Slack data", async (t) => {
  const failing = consoleOAuthFixture(t, { webPairing: async () => { throw new Error("synthetic-sensitive-Slack-response"); } });
  await assert.rejects(failing.manager.startBrowser(failing.target.channelId, failing.target.connectorName), (e: Error) => !/synthetic/.test(e.message));
  assert.ok(failing.manager.start(failing.target));
  let deliver!: (ts: string) => void;
  const delayed = consoleOAuthFixture(t, { webPairing: () => new Promise<string>((r) => { deliver = r; }) });
  const request = delayed.manager.startBrowser(delayed.target.channelId, delayed.target.connectorName);
  delayed.manager.close();
  deliver("789.012");
  await assert.rejects(request);
  assert.equal(delayed.notices.length, 1);
  assert.match(delayed.notices[0]!.message, /expired or was cancelled/);
  assert.equal(delayed.notices[0]!.target.threadTs, "789.012");
  assert.equal(delayed.exchanges.length, 0);
});

for (const phase of ["approved", "consent", "exchanging"] as const) test(`initiator cancellation in ${phase} phase prevents any late credential save or success`, async (t) => {
  const f = consoleOAuthFixture(t);
  const before = readFileSync(f.file.storePath, "utf8");
  let resolve!: (response: Response) => void;
  f.setResponse(() => new Promise<Response>((r) => { resolve = r; }));
  const link = f.manager.start(f.target);
  const claimed = await f.manager.claim(new URL(link).hash.slice(1));
  const id = f.pairings[0]!.id;
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, true), true);
  if (phase !== "approved") {
    const url = new URL((await f.manager.poll(claimed.browser)).authorizationUrl!);
    if (phase === "exchanging") {
      assert.equal(f.manager.callback(claimed.browser, response(url.searchParams.get("state")!)), true);
      await until(() => f.exchanges.length === 1);
    }
  }
  assert.equal(f.manager.decide(id, "UOTHER", f.target.channelId, false), false);
  assert.equal(f.manager.decide(id, f.target.userId, "COTHER", false), false);
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, false), true);
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, false), false);
  if (phase === "exchanging") {
    resolve(Response.json({ access_token: "synthetic-after-cancel", token_type: "Bearer" }));
    await new Promise<void>((r) => setImmediate(r));
  }
  await assert.rejects(f.manager.poll(claimed.browser));
  assert.equal(readFileSync(f.file.storePath, "utf8"), before);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!.message, /cancelled/);
  assert.doesNotMatch(f.notices[0]!.message, /Authorization complete/);
  assert.ok(f.manager.start(f.target), "cancel releases credential scope immediately");
});

test("promoted channel-page authorizer can cancel exchange; another Slack user cannot", async (t) => {
  const f = consoleOAuthFixture(t);
  const requested = await f.manager.startBrowser(f.target.channelId, f.target.connectorName);
  const id = f.webPairings[0]!.id;
  f.manager.decide(id, f.target.userId, f.target.channelId, true);
  const url = new URL((await f.manager.poll(requested.browser)).authorizationUrl!);
  let resolve!: (response: Response) => void;
  f.setResponse(() => new Promise<Response>((r) => { resolve = r; }));
  f.manager.callback(requested.browser, response(url.searchParams.get("state")!));
  await until(() => f.exchanges.length === 1);
  assert.equal(f.manager.decide(id, "UOTHER", f.target.channelId, false), false);
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, false), true);
  resolve(Response.json({ access_token: "synthetic-after-web-cancel", token_type: "Bearer" }));
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(f.file.tokens(), undefined);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0]!.target.userId, f.target.userId);
  assert.match(f.notices[0]!.message, /cancelled/);
});

for (const phase of ["approved", "consent", "exchanging"] as const) {
  test(`initiator Cancel after approval in ${phase} blocks a later callback and late token save`, async (t) => {
    const f = consoleOAuthFixture(t);
    f.file.saveTokens({ access_token: "synthetic-existing-grant", token_type: "Bearer" });
    const before = readFileSync(f.file.storePath, "utf8");
    const link = f.manager.start(f.target);
    const { browser } = await f.manager.claim(new URL(link).hash.slice(1));
    const id = f.pairings[0]!.id;
    assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, true), true);
    let state = "unused-state";
    let release: ((value: Response) => void) | undefined;
    if (phase !== "approved") {
      const consent = await f.manager.poll(browser);
      state = new URL(consent.authorizationUrl!).searchParams.get("state")!;
    }
    if (phase === "exchanging") {
      // Deliberately ignores AbortSignal: even a late SDK/token response cannot save.
      f.setResponse(() => new Promise<Response>((resolve) => { release = resolve; }));
      assert.equal(f.manager.callback(browser, response(state)), true);
      await until(() => f.exchanges.length === 1);
    }
    assert.equal(f.manager.decide(id, "UOTHER", f.target.channelId, false), false);
    assert.equal(f.manager.decide(id, f.target.userId, "COTHER", false), false);
    assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, true), false, "approval stays pairing-only");
    assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, false), true);
    assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, false), false, "cancel is consumed once");
    await assert.rejects(f.manager.poll(browser));
    assert.equal(f.manager.callback(browser, response(state)), false);
    // Cancellation releases the channel/connector lock. A late old exchange must
    // neither finish the new flight nor replace its credentials.
    const newer = await paired(f);
    release?.(Response.json({ access_token: "synthetic-after-cancel", token_type: "Bearer" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readFileSync(f.file.storePath, "utf8"), before);
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0]!.message, /cancelled/);
    f.setResponse(async () => Response.json({ access_token: "synthetic-newer-grant", token_type: "Bearer" }));
    assert.equal(f.manager.callback(newer.browser, response(newer.url.searchParams.get("state")!)), true);
    await until(() => f.notices.length === 2);
    assert.equal(f.file.tokens()?.access_token, "synthetic-newer-grant");
    assert.match(f.notices[1]!.message, /Authorization complete/);
  });
}

test("Cancel while preparing consent aborts production fetch and guards later SDK writes", async (t) => {
  let entered = false;
  let signal: AbortSignal | undefined;
  let release!: (value: Response) => void;
  let lateWriteRejected = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    entered = true;
    return new Promise<Response>((resolve) => { release = resolve; });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const f = consoleOAuthFixture(t, { authorize: async (provider, input) => {
    await input.fetchFn!("https://login.example.org/register");
    try { await provider.saveClientInformation!({ client_id: "synthetic-late-client" }); }
    catch { lateWriteRejected = true; }
    return "REDIRECT";
  } });
  const before = readFileSync(f.file.storePath, "utf8");
  const link = f.manager.start(f.target);
  const claimed = await f.manager.claim(new URL(link).hash.slice(1));
  const id = f.pairings[0]!.id;
  f.manager.decide(id, f.target.userId, f.target.channelId, true);
  const pending = assert.rejects(f.manager.poll(claimed.browser));
  await until(() => entered);
  assert.equal(signal?.aborted, false);
  assert.equal(f.manager.decide(id, f.target.userId, f.target.channelId, false), true);
  assert.equal(signal?.aborted, true);
  await pending;
  release(Response.json({ client_id: "synthetic-late-client" }));
  await until(() => lateWriteRejected);
  assert.equal(readFileSync(f.file.storePath, "utf8"), before);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!.message, /cancelled/);
});
