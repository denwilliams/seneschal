import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { fixture } from "./fixture.ts";

test("HTTP admin API: configured file only, guarded JSON writes, loader validation, stale/save/reload/write failures", async () => {
  const f = fixture();
  const configPath = join(f.source.dataDir, "harness.yaml");
  const original = 'name: \u0024{ADMIN_CONFIG_TEST_NAME}\n';
  process.env.ADMIN_CONFIG_TEST_NAME = "resolved-runtime-credential";
  writeFileSync(configPath, original);
  f.source.admin = { configPath, dataDir: f.source.dataDir, reload: async () => ({ applied: true, warnings: ["restart to rebind the web server"] }) };
  await f.server.start();
  const port = (f.server.address() as { port: number }).port;
  const url = 'http://127.0.0.1:' + port + '/console2/api/v1/config';
  const headers = { host: "console.test", "content-type": "application/json", "x-console-admin": "1" };
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    const loaded = await fetch(url, { headers: { host: "console.test" } });
    assert.equal(loaded.headers.get("cache-control"), "no-store");
    const initial = await loaded.json() as { text: string; revision: string };
    assert.equal(initial.text, original);
    assert.ok(!JSON.stringify(initial).includes(process.env.ADMIN_CONFIG_TEST_NAME));
    const body = { operation: "save", text: "name: new", revision: initial.revision };
    for (const extra of ([{ origin: "https://evil.test" }, { "sec-fetch-site": "same-site" }, { "x-console-admin": "" }] as Record<string, string>[])) assert.equal((await post(body, extra)).status, 403);
    assert.equal((await post(body, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post({ ...body, configPath: "/tmp/other" })).status, 400);
    assert.equal((await post({ operation: "save", text: "name: new" })).status, 400);
    for (const text of ["defaults: [", "defaults: {thinkingLevel: wrong}", "artifacts: {}", "name: \u0024{MISSING_ADMIN_TEST_VAR_159}"]) {
      const invalid = await post({ ...body, text });
      assert.equal(invalid.status, 422);
      assert.ok((await invalid.json() as { error: string }).error.length > 0);
      assert.equal(readFileSync(configPath, "utf8"), original);
    }
    const secretReference = await post({ operation: "validate", text: 'channels: {x: {agentSet: "\u0024{ADMIN_CONFIG_TEST_NAME}"}}' });
    const diagnostic = await secretReference.text();
    assert.equal(secretReference.status, 422);
    assert.ok(!diagnostic.includes(process.env.ADMIN_CONFIG_TEST_NAME));
    assert.ok(diagnostic.includes("channels.x.agentSet"));
    const validated = await post({ operation: "validate", text: "name: valid" });
    assert.equal(validated.status, 200);
    assert.equal(readFileSync(configPath, "utf8"), original);
    const saved = await post(body, { origin: "http://console.test", "sec-fetch-site": "same-origin" });
    assert.equal(saved.status, 200);
    const result = await saved.json() as { revision: string; applied: boolean; saved: boolean; warnings: string[] };
    assert.ok(result.applied && result.saved);
    assert.match(result.warnings[0]!, /restart/);
    assert.equal((await post(body)).status, 409);
    assert.equal(readFileSync(configPath, "utf8"), "name: new");
    f.source.admin.reload = async () => { throw new Error("apply failed"); };
    const failed = await post({ ...body, text: "name: rejected", revision: result.revision });
    assert.equal(failed.status, 500);
    assert.match((await failed.json() as { error: string }).error, /Apply.reload failed.*previous file was restored/);
    assert.equal(readFileSync(configPath, "utf8"), "name: new");
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { headers: { host: "evil.test" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    assert.equal(badHost, 421);
    assert.equal((await fetch(url, { headers: { host: "console.test", origin: "https://evil.test" } })).status, 403);
    assert.equal((await fetch(url, { method: "OPTIONS", headers })).status, 405);
    const huge = await post({ operation: "validate", text: "x".repeat(2 * 1024 * 1024) });
    assert.equal(huge.status, 413);
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.write("x".repeat(2 * 1024 * 1024 + 32)); req.end();
    });
    assert.equal(streamed, 413);
    f.source.admin.configPath = join(configPath, "not-a-file");
    const write = await post({ ...body, revision: result.revision });
    assert.equal(write.status, 500);
    assert.match((await write.json() as { error: string }).error, /permissions/);
    f.source.admin = undefined;
    assert.equal((await fetch(url, { headers: { host: "console.test" } })).status, 503);
  } finally { await f.server.stop(); delete process.env.ADMIN_CONFIG_TEST_NAME; }
});

test("HTTP validate and save redact YAML-escaped environment references without changing the file", async (t) => {
  const f = fixture();
  const configPath = join(f.source.dataDir, "harness.yaml");
  const original = "name: original\n";
  const previous = process.env.ADMIN_ESCAPED_CONFIG_TEST_SECRET;
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_ESCAPED_CONFIG_TEST_SECRET; else process.env.ADMIN_ESCAPED_CONFIG_TEST_SECRET = previous; });
  process.env.ADMIN_ESCAPED_CONFIG_TEST_SECRET = "resolved-private-value-never-persisted";
  writeFileSync(configPath, original);
  f.source.admin = { configPath, dataDir: f.source.dataDir };
  await f.server.start();
  try {
    const port = (f.server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/console2/api/v1/config`;
    const headers = { host: "console.test", "content-type": "application/json", "x-console-admin": "1" };
    const initial = await (await fetch(url, { headers })).json() as { revision: string };
    for (const reference of [String.raw`\x24{ADMIN_ESCAPED_CONFIG_TEST_SECRET}`, String.raw`\u0024{ADMIN_ESCAPED_CONFIG_TEST_SECRET}`, String.raw`\U00000024{ADMIN_ESCAPED_CONFIG_TEST_SECRET}`, String.raw`$\x7bADMIN_ESCAPED_CONFIG_TEST_SECRET}`, String.raw`\x24{\x41DMIN_ESCAPED_CONFIG_TEST_SECRET}`]) {
      for (const operation of ["validate", "save"]) {
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ operation, text: `channels: {x: {agentSet: "${reference}"}}`, revision: initial.revision }) });
        const diagnostic = await response.text();
        assert.equal(response.status, 422);
        assert.ok(!diagnostic.includes(process.env.ADMIN_ESCAPED_CONFIG_TEST_SECRET!), `${operation} leaked ${reference}`);
        assert.ok(diagnostic.includes("${ADMIN_ESCAPED_CONFIG_TEST_SECRET}"));
        assert.ok(diagnostic.includes("channels.x.agentSet"));
        assert.equal(readFileSync(configPath, "utf8"), original);
      }
    }
  } finally { await f.server.stop(); }
});
