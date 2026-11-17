import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fixture } from "./fixture.ts";
import { SecretAdmin } from "../config/managed-env.ts";
import { ScopedSecretAdmin } from "../config/scoped-secrets.ts";
import { logger } from "../util/log.ts";

test("scoped Admin API enforces existing Admin boundary, validates scopes, and never reads back/logs values", async (t) => {
  const f = fixture();
  const logs: unknown[] = [];
  for (const level of ["info", "error", "warn", "debug"] as const) t.mock.method(logger, level, (...args: unknown[]) => logs.push(args));
  let failure = false;
  const writes: unknown[] = [];
  f.source.admin = { configPath: join(f.dataDir, "config.yaml"), dataDir: f.dataDir };
  f.source.secrets = new SecretAdmin(undefined, undefined, {});
  f.source.scopedSecrets = new ScopedSecretAdmin([{
    id: "macos-keychain", label: "macOS Keychain", enabled: () => true,
    save: async (scope, name, value) => { if (failure) throw new Error(value); writes.push({ scope, name, value }); },
    remove: async (scope, name) => { if (failure) throw new Error("secret-sentinel"); writes.push({ scope, name }); },
  }], () => [{ id: "C1", name: "one" }, { id: "C2" }]);
  await f.server.start(); t.after(() => f.server.stop());
  const url = `http://127.0.0.1:${(f.server.address() as { port: number }).port}/console2/api/v1/secrets`;
  const headers = { host: "console.test", "content-type": "application/json", "x-console-admin": "1" };
  const body = { operation: "backend-save", backend: "macos-keychain", scope: { kind: "channel", channel: "C1" }, name: "TOKEN", value: "secret-sentinel", overwrite: true };
  async function check(body: unknown, status: number, extra = {}) {
    const response = await fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /secret-sentinel/);
  }
  for (const extra of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }, { "x-console-admin": "" }]) await check(body, 403, extra);
  await check(body, 415, { "content-type": "text/plain" });
  await check({ ...body, scope: { kind: "channel", channel: "CUNKNOWN" } }, 422);
  await check({ ...body, scope: { kind: "channel", channel: "../C1" } }, 400);
  await check({ ...body, scope: { kind: "main-process", channel: "C1" } }, 400);
  await check({ ...body, scope: { kind: "bogus" } }, 400);
  await check({ ...body, overwrite: false }, 422);
  await check({ ...body, backend: "unknown" }, 503);
  await check({ ...body, name: "NODE_OPTIONS" }, 422);
  await check({ ...body, password: "secret-sentinel" }, 400);
  await check({ ...body, value: "x".repeat(16385) }, 400);
  await check(body, 200);
  await check({ ...body, scope: { kind: "global-channel" } }, 200);
  await check({ ...body, scope: { kind: "main-process" } }, 200);
  assert.equal(writes.length, 3);
  const readback = await fetch(url, { headers });
  const text = await readback.text(); assert.doesNotMatch(text, /secret-sentinel|TOKEN/);
  assert.deepEqual(JSON.parse(text).scoped.channels, [{ id: "C1", name: "one" }, { id: "C2" }]);
  failure = true; await check(body, 503);
  const deletion = { operation: "backend-delete", backend: body.backend, scope: body.scope, name: body.name, confirm: true };
  await check(deletion, 503); failure = false;
  await check({ ...deletion, confirm: false }, 400); await check(deletion, 200);
  f.source.admin = undefined;
  await check(body, 503);
  assert.doesNotMatch(JSON.stringify(logs), /secret-sentinel/);
  for (const entry of readdirSync(f.dataDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.doesNotMatch(readFileSync(join(entry.parentPath, entry.name), "utf8"), /secret-sentinel/);
  }
});
