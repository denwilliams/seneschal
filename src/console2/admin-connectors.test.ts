import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./fixture.ts";

test("HTTP connector draft patches share guarded validation, revision, backup and reload semantics", async (t) => {
  const f = fixture();
  const configPath = join(f.source.dataDir, "harness.yaml");
  const original = '# host comment\nconnectors:\n  remote:\n    transport: http\n    url: https://example.test/mcp\n    headers: {Authorization: "Bearer ${ADMIN_CONNECTOR_SECRET}"}\n';
  const previous = process.env.ADMIN_CONNECTOR_SECRET;
  process.env.ADMIN_CONNECTOR_SECRET = "runtime-value-not-for-the-browser";
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_CONNECTOR_SECRET; else process.env.ADMIN_CONNECTOR_SECRET = previous; });
  writeFileSync(configPath, original);
  let reloads = 0;
  f.source.admin = { configPath, dataDir: f.source.dataDir, reload: async () => { reloads++; return { applied: true, warnings: [] }; } };
  await f.server.start();
  try {
    const port = (f.server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/console2/api/v1/config`;
    const headers = { host: "console.test", "content-type": "application/json", "x-console-admin": "1" };
    const post = (body: unknown) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const loaded = await (await fetch(url, { headers })).json() as { revision: string };
    const inspect = await post({ operation: "inspect", text: original });
    const inspected = await inspect.text();
    assert.equal(inspect.status, 200);
    assert.ok(inspected.includes("ADMIN_CONNECTOR_SECRET"));
    assert.ok(!inspected.includes(process.env.ADMIN_CONNECTOR_SECRET!));
    const created = await post({ operation: "patch", text: original, edits: [{ path: ["connectors", "local"], create: true, yaml: "transport: stdio\ncommand: node\n" }] });
    assert.equal(created.status, 200);
    const draft = (await created.json() as { text: string }).text;
    const edited = await post({ operation: "patch", text: draft, edits: [
      { path: ["connectors", "local", "args"], value: ["server.js", "--stdio"] },
      { path: ["connectors", "local", "env", "TOKEN"], value: "${ADMIN_CONNECTOR_SECRET}" },
      { path: ["connectors", "remote", "headers", "X-Test"], value: "test" },
    ] });
    assert.equal(edited.status, 200);
    const text = (await edited.json() as { text: string }).text;
    for (const yaml of ["transport: [", "[]"]) assert.equal((await post({ operation: "patch", text, edits: [{ path: ["connectors", "local"], yaml }] })).status, 422);
    assert.equal((await post({ operation: "patch", text, edits: [{ path: ["connectors", "local"], create: true, yaml: "transport: http\nurl: https://overwrite.test" }] })).status, 400);
    assert.equal((await post({ operation: "patch", text, edits: [{ path: ["defaults", "model"], value: { unexpected: true } }] })).status, 400);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(reloads, 0);
    assert.ok(!readdirSync(f.source.dataDir).includes("config-backups"));
    assert.equal((await post({ operation: "validate", text })).status, 200);
    const saved = await post({ operation: "save", text, revision: loaded.revision });
    assert.equal(saved.status, 200);
    assert.equal(reloads, 1);
    assert.equal(readFileSync(configPath, "utf8"), text);
    assert.equal(readdirSync(join(f.source.dataDir, "config-backups")).length, 1);
    assert.equal((await post({ operation: "save", text: original, revision: loaded.revision })).status, 409);
    const removed = await post({ operation: "patch", text, edits: [{ path: ["connectors", "local"], remove: true }] });
    assert.equal(removed.status, 200);
    assert.equal(readFileSync(configPath, "utf8"), text);
    assert.equal(reloads, 1);
  } finally { await f.server.stop(); }
});
