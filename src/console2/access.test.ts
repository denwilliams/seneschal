import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ArtifactServer } from "../artifacts/server.ts";
import type { ConsoleConnectorOAuth } from "../agent/consoleConnectorOAuth.ts";
import { consoleOAuthFixture } from "../agent/consoleConnectorOAuth-fixture.ts";
import { fixture, roots } from "./fixture.ts";
import { clearTimelineCache } from "./timeline-cache.ts";

const access = { enabled: true, issuer: "https://example.cloudflareaccess.com", audience: "console-app" };
const key = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(key.publicKey), kid: "k", alg: "RS256" };
const accessFetch: typeof fetch = async () => Response.json({ keys: [jwk] });
const token = (seconds = 300) => new SignJWT({ email: "operator@example.test" }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(access.issuer).setAudience(access.audience).setSubject("user-1").setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(key.privateKey);
after(() => { clearTimelineCache(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function boot(enabled = true, prefix = "", options: { artifacts?: boolean; oauth?: ConsoleConnectorOAuth } = {}) {
  const f = fixture();
  f.source.baseUrl = `http://console.test${prefix}`;
  // Only request guards are exercised; no config read/write should be reached.
  f.source.admin = {} as NonNullable<typeof f.source.admin>;
  const dist = mkdtempSync(join(tmpdir(), "access-dist-"));
  writeFileSync(join(dist, "index.html"), "<h1>Console</h1>");
  mkdirSync(join(dist, "assets")); writeFileSync(join(dist, "assets", "app.js"), "/* app */");
  process.env.HARNESS_CONSOLE2_DIST = dist;
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: f.source.baseUrl, console: true, artifacts: options.artifacts ?? false, actions: true,
    cloudflareAccess: enabled ? access : { enabled: false }, mcp: { enabled: true, bearerToken: "mcp-secret" } },
  f.dataDir, { accessFetch }, undefined, options.oauth, { tasks: f.source.tasks, channels: f.source.channels, configuredChannels: () => [] }, () => f.source);
  await server.start();
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, options: RequestInit = {}) => fetch(origin + path, { redirect: "manual", ...options, headers: { host: "console.test", ...options.headers } });
  return { f, server, get, stop: async () => { await server.stop(); delete process.env.HARNESS_CONSOLE2_DIST; rmSync(dist, { recursive: true, force: true }); } };
}

test("Access gates all browser/data routes and methods, with or without proxy prefix or public Host", async () => {
  for (const prefix of ["", "/proxy/harness"]) {
    const b = await boot(true, prefix);
    try {
      const paths = ["/", "/channels/CCHAN001", "/channels/CCHAN001/artifacts/report.txt", "/api/status", "/console2", "/console2/", "/console2/assets/app.js", "/console2/sw.js", "/console2/manifest.webmanifest",
        ...["activity", "tree", "identity", "events", "config", "secrets", "channels/CCHAN001/memory", "channels/CCHAN001/state", "channels/CCHAN001/lists", "channels/CCHAN001/threads/main", "channels/CCHAN001/workflows"].map((p) => "/console2/api/v1/" + p),
        "/oauth/connect", "/oauth/callback", "/oauth/result"];
      for (const path of paths) {
        for (const headers of [{}, { "cf-access-jwt-assertion": "forged", "cf-access-authenticated-user-email": "operator@test" }]) {
          const res = await b.get(prefix + path, { headers });
          assert.equal(res.status, 401, path); assert.equal(res.headers.get("cache-control"), "no-store");
          assert.ok(!(await res.text()).includes("operator@test"));
        }
      }
      for (const path of ["/console2/api/v1/config", "/console2/api/v1/secrets", "/console2/api/v1/channels/CCHAN001/lists", "/console2/api/v1/channels/CCHAN001/factory/start", "/oauth/claim", "/oauth/request", "/oauth/poll"]) {
        assert.equal((await b.get(prefix + path, { method: "POST", body: "{}" })).status, 401, path);
      }
      assert.equal((await b.get(prefix + "/console2/", { method: "HEAD" })).status, 401);
      // Bare local status is served even with a prefix, so it must also be gated.
      assert.equal((await b.get("/api/status", { headers: { host: "127.0.0.1" } })).status, 401);
      assert.equal((await b.get(prefix + "/console2/", { headers: { host: "127.0.0.1" } })).status, 401);
      for (const path of ["/health", prefix + "/health"]) {
        const res = await b.get(path); assert.equal(res.status, 200); assert.deepEqual(await res.json(), { ok: true });
      }
    } finally { await b.stop(); }
  }
});

test("Access permits valid sessions, displays only verified identity, retains Origin/Host/write checks and no-store", async () => {
  const b = await boot(true, "/p");
  try {
    const jwt = await token();
    const headers = { "cf-access-jwt-assertion": jwt, "cf-access-authenticated-user-email": "forged@test" };
    const identity = await b.get("/p/console2/api/v1/identity", { headers });
    assert.equal(identity.status, 200);
    assert.deepEqual(await identity.json(), { identity: { subject: "user-1", email: "operator@example.test" } });
    for (const path of ["/console2/", "/console2/assets/app.js", "/api/status", "/console2/api/v1/tree", "/console2/api/v1/activity", "/console2/api/v1/channels/CCHAN001/state", "/console2/api/v1/channels/CCHAN001/lists"]) {
      const res = await b.get("/p" + path, { headers });
      assert.equal(res.status, 200, path); assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("x-harness-access-protected"), "1");
      assert.ok(!(await res.text()).includes(jwt));
    }
    assert.equal((await b.get("/p/console2/api/v1/tree", { headers: { cookie: `CF_Authorization=${jwt}` } })).status, 200);
    assert.equal((await b.get("/p/console2/api/v1/tree", { headers: { ...headers, origin: "https://evil.test" } })).status, 403);
    const port = (b.server.address() as { port: number }).port;
    const rejectedHost = await new Promise<number>((resolve, reject) => {
      const call = request({ hostname: "127.0.0.1", port, path: "/p/console2/api/v1/tree", headers: { ...headers, host: "evil.test" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      call.on("error", reject); call.end();
    });
    assert.equal(rejectedHost, 421);
    assert.equal((await b.get("/p/console2/api/v1/config", { headers, method: "POST", body: "{}" })).status, 403, "Access does not bypass write request safeguards");
    assert.equal((await b.get("/p/console2/api/v1/identity", { headers: { "cf-access-jwt-assertion": await token(-10) } })).status, 401);
    const stream = await b.get("/p/console2/api/v1/events", { headers: { "cf-access-jwt-assertion": await token(2) }, signal: AbortSignal.timeout(5000) });
    assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type")!, /^text\/event-stream/);
    await assert.rejects(() => stream.text(), "live connection is terminated at token expiry");
    const mcp = (headers: Record<string, string>) => b.get("/p/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    assert.equal((await mcp({ "cf-access-jwt-assertion": jwt })).status, 401, "Access never replaces MCP bearer auth");
    const initialized = await mcp({ authorization: "Bearer mcp-secret", "cf-access-jwt-assertion": "invalid" });
    assert.equal(initialized.status, 200); await initialized.text();
  } finally { await b.stop(); }
});

test("enabled artifact downloads and real OAuth routes require Access without replacing their own safeguards", async (t) => {
  const oauth = consoleOAuthFixture(t);
  const b = await boot(true, "/harness", { artifacts: true, oauth: oauth.manager });
  try {
    const artifactDir = join(b.f.dataDir, "channels", b.f.channelId, "workspace", "artifacts");
    mkdirSync(artifactDir, { recursive: true }); writeFileSync(join(artifactDir, "report.txt"), "protected report");
    const path = `/harness/channels/${b.f.channelId}/artifacts/report.txt`;
    const headers = { "cf-access-jwt-assertion": await token() };
    assert.equal((await b.get(path)).status, 401);
    const report = await b.get(path, { headers });
    assert.equal(report.status, 200); assert.equal(await report.text(), "protected report");
    assert.equal(report.headers.get("cache-control"), "no-store");
    assert.match(report.headers.get("content-security-policy")!, /sandbox/);
    assert.equal((await b.get(path, { method: "HEAD", headers })).status, 200);
    assert.equal((await b.get("/harness/oauth/connect")).status, 401);
    assert.equal((await b.get("/harness/oauth/connect", { headers })).status, 200);
    assert.equal((await b.get("/harness/oauth/callback?code=synthetic&state=synthetic")).status, 401);
    assert.equal(oauth.exchanges.length, 0);
    assert.equal((await b.get("/harness/oauth/request", { method: "POST", headers, body: "{}" })).status, 403, "OAuth still requires its own exact Origin and Slack approval");
    assert.equal(oauth.webPairings.length, 0);
  } finally { await b.stop(); }
});

test("disabled Access leaves console/status/assets accessible and ignores spoofed identity", async () => {
  const b = await boot(false);
  try {
    for (const path of ["/console2/", "/console2/api/v1/tree", "/api/status"]) assert.equal((await b.get(path)).status, 200);
    const identity = await b.get("/console2/api/v1/identity", { headers: { "cf-access-jwt-assertion": await token(), "cf-access-authenticated-user-email": "forged@test" } });
    assert.deepEqual(await identity.json(), { identity: null });
    const asset = await b.get("/console2/assets/app.js");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(asset.headers.get("x-harness-access-protected"), null);
  } finally { await b.stop(); }
});
