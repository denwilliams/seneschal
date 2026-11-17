import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { CloudflareAccess } from "./cloudflare-access.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ArtifactServer, webServerPlan } from "../artifacts/server.ts";

const config = { enabled: true, issuer: "https://example.cloudflareaccess.com", audience: "console-app" };
const key = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(key.publicKey), kid: "key-1", alg: "RS256", use: "sig" };
const now = () => Math.floor(Date.now() / 1000);
async function token(patch: JWTPayload = {}, privateKey = key.privateKey, kid = "key-1") {
  return new SignJWT({ iss: config.issuer, aud: config.audience, sub: "user-1", email: "operator@example.test", iat: now() - 1, exp: now() + 300, ...patch }).setProtectedHeader({ alg: "RS256", kid }).sign(privateKey);
}
const req = (headers: Record<string, string | undefined>) => ({ headers }) as IncomingMessage;
const goodFetch: typeof fetch = async () => Response.json({ keys: [jwk] });

test("Access config is opt-in, requires canonical team issuer and audience, and reaches the listener", () => {
  assert.equal(HarnessConfigSchema.parse({}).webConsole.cloudflareAccess, undefined);
  const parsed = HarnessConfigSchema.parse({ webConsole: { cloudflareAccess: config } });
  assert.deepEqual(webServerPlan(parsed).cloudflareAccess, config);
  for (const input of [
    { enabled: true }, { ...config, issuer: undefined }, { ...config, audience: undefined }, { ...config, audience: "" },
    ...["http://example.cloudflareaccess.com", "https://example.cloudflareaccess.com/", "https://example.cloudflareaccess.com/keys", "https://attacker.test", "https://example.cloudflareaccess.com@attacker.test", "https://example.cloudflareaccess.com?x=1"].map((issuer) => ({ ...config, issuer })),
  ]) {
    assert.equal(HarnessConfigSchema.safeParse({ webConsole: { cloudflareAccess: input } }).success, false);
    assert.throws(() => new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, cloudflareAccess: input as typeof config }, "/tmp"));
  }
});

test("Access verifies header or cookie and only returns verified minimal identity", async () => {
  const urls: string[] = [];
  const verifier = new CloudflareAccess(config, async (url, options) => {
    urls.push(String(url)); assert.equal(options?.redirect, "error"); return goodFetch(url, options);
  });
  const jwt = await token();
  const session = await verifier.authenticate(req({ "cf-access-jwt-assertion": jwt, "cf-access-authenticated-user-email": "attacker@test" }));
  assert.deepEqual(session?.identity, { subject: "user-1", email: "operator@example.test" });
  assert.ok(session!.expiresAt > Date.now());
  assert.deepEqual((await verifier.authenticate(req({ cookie: `other=value; CF_Authorization=${jwt}` })))?.identity, session?.identity);
  assert.deepEqual((await verifier.authenticate(req({ cookie: `CF_Authorization=${await token({ email: undefined })}` })))?.identity, { subject: "user-1" });
  assert.deepEqual(urls, [config.issuer + "/cdn-cgi/access/certs"]);
});

test("Access rejects absent, forged, expired, premature, wrong issuer/audience and incomplete claims", async () => {
  const verifier = new CloudflareAccess(config, goodFetch);
  const jwt = await token();
  const attacker = await generateKeyPair("RS256");
  const badTokens = ["not-a-jwt", jwt.slice(0, -10) + "abcdefghij", await token({}, attacker.privateKey),
    await token({ exp: now() - 1 }), await token({ nbf: now() + 100 }), await token({ iat: now() + 100 }),
    await token({ aud: "other-app" }), await token({ iss: "https://attacker.cloudflareaccess.com" }),
    await token({ exp: undefined }), await token({ iat: undefined }), await token({ sub: "" }),
    await new SignJWT({ iss: config.issuer, aud: config.audience, sub: "user-1", iat: now(), exp: now() + 300 }).setProtectedHeader({ alg: "HS256", kid: "key-1" }).sign(new TextEncoder().encode("a".repeat(32))),
  ];
  for (const jwt of badTokens) assert.equal(await verifier.authenticate(req({ "cf-access-jwt-assertion": jwt })), undefined);
  for (const headers of [{}, { "cf-access-authenticated-user-email": "operator@test" }, { cookie: "CF_Authorization=present" },
    { cookie: `CF_Authorization=${jwt}; CF_Authorization=${jwt}` }, { cookie: `CF_Authorization=${jwt}`, "cf-access-jwt-assertion": "invalid" }]) {
    assert.equal(await verifier.authenticate(req(headers)), undefined);
  }
});

test("Access fails closed on unavailable/malformed keys; bounded cached keys survive transient outage and rotate", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let keys = [jwk]; let outage = false; let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; if (outage) throw new Error("unavailable"); return Response.json({ keys }); };
  const verifier = new CloudflareAccess(config, fetcher);
  const jwt = await token({ exp: now() + 3600 });
  assert.ok(await verifier.authenticate(req({ "cf-access-jwt-assertion": jwt })));
  outage = true;
  assert.ok(await verifier.authenticate(req({ "cf-access-jwt-assertion": jwt })), "valid cached key works within cache lifetime");
  assert.equal(await new CloudflareAccess(config, fetcher).authenticate(req({ "cf-access-jwt-assertion": jwt })), undefined);
  assert.equal(await new CloudflareAccess(config, async () => Response.json({ keys: "bad" })).authenticate(req({ "cf-access-jwt-assertion": jwt })), undefined);
  t.mock.timers.tick(601_000);
  assert.equal(await verifier.authenticate(req({ "cf-access-jwt-assertion": jwt })), undefined, "stale keys cannot bypass a fetch failure");
  outage = false;
  const next = await generateKeyPair("RS256");
  keys = [{ ...await exportJWK(next.publicKey), kid: "key-2", alg: "RS256", use: "sig" }];
  const rotated = await token({}, next.privateKey, "key-2");
  assert.ok(await verifier.authenticate(req({ "cf-access-jwt-assertion": rotated })));
  assert.ok(calls >= 3);
  assert.equal(await verifier.authenticate(req({ "cf-access-jwt-assertion": jwt })), undefined, "removed key is not trusted after refresh");
});
