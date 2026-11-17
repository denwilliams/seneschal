import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactServer } from "../artifacts/server.ts";
import { consoleOAuthFixture, until } from "../agent/consoleConnectorOAuth-fixture.ts";

const origin = "https://console.example.org";
async function serverFixture(t: Parameters<typeof consoleOAuthFixture>[0], artifacts = false) {
  const f = consoleOAuthFixture(t);
  const server = new ArtifactServer({ enabled: true, console: true, artifacts, host: "127.0.0.1", port: 0, baseUrl: `${origin}/harness` }, f.target.channelRoot, {}, undefined, f.manager);
  await server.start();
  t.after(() => server.stop());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const local = `http://127.0.0.1:${address.port}`;
  const post = (route: string, value: unknown, cookie?: string, from = origin) => fetch(`${local}/harness/oauth${route}`, {
    method: "POST", headers: { Origin: from, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(value), redirect: "manual",
  });
  return { ...f, local, post };
}

test("HTTP connect page strips fragment, uses restrictive CSP, ignores Host/forwarded identity and never claims on GET/HEAD", async (t) => {
  const f = await serverFixture(t);
  const link = f.manager.start(f.target);
  const res = await fetch(`${f.local}/harness/oauth/connect`, { headers: { Host: "attacker.example.org", "X-Forwarded-Host": "attacker.example.org", "Cf-Access-Authenticated-User-Email": "unrelated@example.org" } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(html, /history.replaceState\(null, '', location.pathname\)/);
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1]; assert.ok(script);
  assert.ok(res.headers.get("content-security-policy")!.includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`));
  assert.doesNotMatch(html, /attacker|unrelated@example.org/);
  assert.equal((await fetch(`${f.local}/harness/oauth/connect`, { method: "HEAD" })).status, 405);
  assert.equal((await fetch(`${f.local}/harness/oauth/claim`)).status, 405);
  assert.equal(f.pairings.length, 0);
  assert.equal((await f.post("/claim", { link: new URL(link).hash.slice(1) })).status, 200);
});

test("claim and poll require exact Origin, bounded JSON, fixed routes and secure HttpOnly browser cookie", async (t) => {
  const f = await serverFixture(t);
  const link = new URL(f.manager.start(f.target)).hash.slice(1);
  assert.equal((await f.post("/claim", { link }, undefined, "https://attacker.example.org")).status, 403);
  assert.equal((await f.post("/claim", { link }, undefined, "null")).status, 403);
  assert.equal((await fetch(`${f.local}/harness/oauth/claim`, { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ link }) })).status, 400);
  assert.equal((await f.post("/claim", { link, callbackUrl: "https://attacker.example.org" })).status, 400);
  assert.equal((await f.post("/claim", { link: "x".repeat(3000) })).status, 400);
  assert.equal((await fetch(`${f.local}/oauth/connect`)).status, 404, "proxy path prefix is preserved, never guessed from headers");
  const res = await f.post("/claim", { link });
  const json = await res.json() as Record<string, string>;
  assert.deepEqual(Object.keys(json), ["phrase"]);
  const setCookie = res.headers.get("set-cookie")!;
  assert.match(setCookie, /^__Secure-harness-connector-oauth=[A-Za-z0-9_-]{43}; Path=\/harness\/oauth\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  const cookie = setCookie.split(";")[0]!;
  assert.equal((await f.post("/claim", { link })).status, 400);
  assert.equal((await f.post("/poll", {}, cookie, "https://attacker.example.org")).status, 403);
  assert.equal((await f.post("/poll", {})).status, 400);
  assert.equal((await f.post("/poll", {}, `${cookie}; ${cookie}`)).status, 400);
  assert.deepEqual(await (await f.post("/poll", {}, cookie)).json(), { status: "waiting" });
  f.manager.decide(f.pairings[0]!.id, f.target.userId, f.target.channelId, true);
  const consent = await (await f.post("/poll", {}, cookie)).json() as { authorizationUrl: string };
  assert.equal(new URL(consent.authorizationUrl).searchParams.get("redirect_uri"), f.manager.callbackUrl);
  assert.equal((await f.post("/poll", {}, cookie)).status, 400, "one consent initiation only");
});

test("callback requires paired browser, consumes state once, removes sensitive query via fixed redirect and sends only safe Slack completion", async (t) => {
  const f = await serverFixture(t);
  const link = new URL(f.manager.start(f.target)).hash.slice(1);
  const res = await f.post("/claim", { link });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  f.manager.decide(f.pairings[0]!.id, f.target.userId, f.target.channelId, true);
  const consent = await (await f.post("/poll", {}, cookie)).json() as { authorizationUrl: string };
  const state = new URL(consent.authorizationUrl).searchParams.get("state")!;
  const callback = `${f.local}/harness/oauth/callback?state=${state}&code=synthetic-sensitive-code&error_description=synthetic-sensitive-description`;
  const wrongVisitor = await fetch(callback, { redirect: "manual" });
  assert.equal(wrongVisitor.status, 303);
  assert.equal(wrongVisitor.headers.get("location"), "/harness/oauth/result");
  assert.equal(f.exchanges.length, 0);
  const wrongState = await fetch(`${f.local}/harness/oauth/callback?state=wrong&code=synthetic-code`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(wrongState.headers.get("set-cookie"), null, "invalid callback cannot clear valid browser pairing");
  const valid = await fetch(callback, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(valid.status, 303);
  assert.equal(valid.headers.get("location"), "/harness/oauth/result");
  assert.match(valid.headers.get("set-cookie")!, /Max-Age=0/);
  assert.doesNotMatch(await valid.text(), /synthetic-sensitive|code=|state=/);
  await fetch(callback, { headers: { Cookie: cookie }, redirect: "manual" });
  await until(() => f.notices.length === 1);
  assert.equal(f.exchanges.length, 1);
  const result = await fetch(`${f.local}/harness/oauth/result`);
  assert.doesNotMatch(await result.text(), /synthetic-sensitive|synthetic-new-access|state=/);
  assert.doesNotMatch(JSON.stringify(f.notices.map((n) => n.message)), /synthetic-sensitive|synthetic-new-access/);
});

test("OAuth opt-in sandboxes active channel artifacts away from console cookies and blocks worker creation", async (t) => {
  const f = await serverFixture(t, true);
  const root = join(f.target.channelRoot, "channels", "CTARGET", "workspace", "artifacts");
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, "active.html"), "<script>/* user authored */</script>");
  const res = await fetch(`${f.local}/harness/channels/CTARGET/artifacts/active.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts allow-downloads; worker-src 'none'");
  assert.doesNotMatch(res.headers.get("content-security-policy")!, /allow-same-origin|allow-top-navigation|allow-popups/);
});

test("web request HTTP route only selects known channel/connector, preserves browser binding and refuses proxy/user/callback assertions", async (t) => {
  const f = await serverFixture(t);
  const body = { channelId: f.target.channelId, connectorName: f.target.connectorName };
  assert.equal((await fetch(`${f.local}/harness/oauth/request`)).status, 405);
  assert.equal((await f.post("/request", body, undefined, "https://attacker.example.org")).status, 403);
  assert.equal((await f.post("/request", { ...body, userId: "UINITIATOR" })).status, 400);
  assert.equal((await f.post("/request", { ...body, callbackUrl: "https://attacker.example.org" })).status, 400);
  assert.equal((await f.post("/request", { ...body, channelId: "CUNKNOWN" })).status, 400);
  assert.equal((await f.post("/request", { ...body, connectorName: "unknown" })).status, 400);
  assert.equal(f.webPairings.length, 0);
  const response = await f.post("/request", body);
  assert.equal(response.status, 200);
  const result = await response.json() as Record<string, string>;
  assert.deepEqual(Object.keys(result), ["phrase"]);
  assert.equal(result.phrase, f.webPairings[0]!.phrase);
  assert.equal(f.exchanges.length, 0);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(response.headers.get("set-cookie")!, /Secure; HttpOnly; SameSite=Lax/);
  assert.deepEqual(await (await f.post("/poll", {}, cookie)).json(), { status: "waiting" });
  f.manager.decide(f.webPairings[0]!.id, f.target.userId, f.target.channelId, true);
  const consent = await (await f.post("/poll", {}, cookie)).json() as { authorizationUrl: string };
  const state = new URL(consent.authorizationUrl).searchParams.get("state")!;
  await fetch(`${f.local}/harness/oauth/callback?state=${state}&code=synthetic-web-code`, { headers: { Cookie: cookie }, redirect: "manual" });
  await until(() => f.notices.length === 1);
  assert.match(f.notices[0]!.message, /Authorization complete/);
  assert.equal(f.notices[0]!.target.userId, f.target.userId);
  assert.equal(f.notices[0]!.target.threadTs, "789.012");
});
