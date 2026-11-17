import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fixture } from "./fixture.ts";
import type { DatabaseResponse, WorkspaceResponse } from "./api-types.ts";

async function setup(dm = false) {
  const f = fixture({ dm });
  const workspace = join(f.dataDir, "channels", f.channelId, "workspace");
  mkdirSync(workspace);
  await f.server.start();
  const port = (f.server.address() as { port: number }).port;
  const request = (page: string, params: Record<string, string> = {}, headers: Record<string, string> = {}, method = "GET", id = f.channelId) => fetch(`http://127.0.0.1:${port}/console2/api/v1/channels/${id}/${page}?${new URLSearchParams(params)}`, { method, headers: { host: "console.test", ...headers } });
  return { ...f, workspace, request, async close() { await f.server.stop(); rmSync(f.dataDir, { recursive: true, force: true }); } };
}

test("workspace API navigates bounded pages and preserves console access controls", async () => {
  const f = await setup();
  try {
    mkdirSync(join(f.workspace, "notes"));
    writeFileSync(join(f.workspace, "notes", "hello.txt"), "hello");
    for (let i = 0; i < 110; i++) writeFileSync(join(f.workspace, `file-${i}.txt`), "x");
    const first = await f.request("workspace");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const listing = await first.json() as WorkspaceResponse;
    assert.equal(listing.entries.length, 100);
    assert.equal(listing.nextOffset, 100);
    const second = await (await f.request("workspace", { offset: "100" })).json() as WorkspaceResponse;
    assert.equal(second.entries.length, 11);
    assert.equal(second.nextOffset, undefined);
    assert.equal(new Set([...listing.entries, ...second.entries].map((e) => e.name)).size, 111);
    const nested = await (await f.request("workspace", { path: "notes" })).json() as WorkspaceResponse;
    assert.equal(nested.entries[0]?.name, "hello.txt");
    assert.equal(nested.entries[0]?.kind, "file");
    assert.equal((await f.request("workspace", {}, { origin: "https://evil.example" })).status, 403);
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ port: (f.server.address() as { port: number }).port, host: "127.0.0.1", path: `/console2/api/v1/channels/${f.channelId}/workspace`, headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 421);
    assert.equal((await f.request("workspace", {}, {}, "POST")).status, 405);
    assert.equal((await f.request("workspace", {}, {}, "GET", "CUNKNOWN")).status, 404);
    assert.equal((await f.request("workspace", { offset: "10001" })).status, 400);
    assert.equal((await f.request("workspace", { offset: "NaN" })).status, 400);
  } finally { await f.close(); }
});

test("workspace and database API refuse traversal, symlink components, other channels and symlink WAL", async () => {
  const f = await setup();
  const outside = mkdtempSync(join(tmpdir(), "console2-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "outside sentinel");
    const db = new DatabaseSync(join(outside, "secret.db")); db.exec("CREATE TABLE secret(value)"); db.close();
    symlinkSync(outside, join(f.workspace, "escape"));
    symlinkSync(join(outside, "secret.db"), join(f.workspace, "link.db"));
    const otherWorkspace = join(f.dataDir, "channels", "COTHER", "workspace");
    mkdirSync(otherWorkspace, { recursive: true });
    writeFileSync(join(otherWorkspace, "other-channel-only.txt"), "other channel sentinel");
    const channels = f.source.channels();
    f.source.channels = () => [...channels, { ...channels[0]!, id: "COTHER" }];
    symlinkSync(otherWorkspace, join(f.workspace, "other-channel"));
    assert.equal((await f.request("workspace", { path: "other-channel" })).status, 404);
    const otherListing = await (await f.request("workspace", {}, {}, "GET", "COTHER")).json() as WorkspaceResponse;
    assert.deepEqual(otherListing.entries.map((entry) => entry.name), ["other-channel-only.txt"]);
    for (const path of ["../memory", "/etc", "x/../../y", "x//y", "x/./y", "x\\y", "\0"]) assert.equal((await f.request("workspace", { path })).status, 400, path);
    for (const path of ["escape", "escape/nested"]) assert.equal((await f.request("workspace", { path })).status, 404);
    for (const path of ["escape/secret.db", "link.db"]) assert.equal((await f.request("database", { path })).status, 404);
    const listing = await (await f.request("workspace")).json() as WorkspaceResponse;
    assert.ok(listing.entries.every((e) => e.kind === "symlink"));
    const dbPath = join(f.workspace, "local.db");
    const local = new DatabaseSync(dbPath); local.exec("CREATE TABLE safe(value)"); local.close();
    symlinkSync(join(outside, "secret.txt"), dbPath + "-wal");
    assert.equal((await f.request("database", { path: "local.db" })).status, 404);
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "outside sentinel");
    renameSync(f.workspace, f.workspace + "-real");
    symlinkSync(outside, f.workspace);
    assert.equal((await f.request("workspace")).status, 404, "workspace root itself must not be a symlink");
  } finally { await f.close(); rmSync(outside, { recursive: true, force: true }); }
});

test("SQLite API detects extensionless databases, inspects schema and bounded rows without changing originals", async () => {
  const f = await setup();
  const path = join(f.workspace, "extensionless");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT, payload BLOB); CREATE VIEW hidden_view AS SELECT * FROM items;");
    const insert = db.prepare("INSERT INTO items(value,payload) VALUES (?,?)");
    for (let i = 0; i < 55; i++) insert.run(i === 0 ? "x".repeat(100_000) : `row ${i}`, new Uint8Array([1, 2, 3]));
    db.exec('CREATE TABLE "odd""; DROP TABLE items; --" ("a""b" TEXT); INSERT INTO "odd""; DROP TABLE items; --" VALUES (\'safe\')');
    const originals = readdirSync(f.workspace).sort().map((name) => ({ name, bytes: readFileSync(join(f.workspace, name)), modified: statSync(join(f.workspace, name)).mtimeMs }));
    const listing = await (await f.request("workspace")).json() as WorkspaceResponse;
    assert.equal(listing.entries.find((e) => e.name === "extensionless")?.kind, "database");
    const tables = await (await f.request("database", { path: "extensionless" })).json() as DatabaseResponse;
    assert.ok(tables.tables.includes("items"));
    assert.ok(!tables.tables.includes("hidden_view"));
    const response = await f.request("database", { path: "extensionless", table: "items" });
    assert.equal(response.status, 200);
    const data = await response.json() as DatabaseResponse;
    assert.equal(data.rows?.length, 50);
    assert.equal(data.nextOffset, 50);
    assert.equal(data.rows?.[0]?.[1]?.length, 256);
    assert.equal(data.rows?.[0]?.[2], "[BLOB 3 bytes]");
    assert.equal(data.columns?.[0]?.primaryKey, true);
    assert.match(data.schema!, /CREATE TABLE items/);
    const last = await (await f.request("database", { path: "extensionless", table: "items", offset: "50" })).json() as DatabaseResponse;
    assert.equal(last.rows?.length, 5);
    assert.equal(last.nextOffset, undefined);
    const odd = await (await f.request("database", { path: "extensionless", table: 'odd"; DROP TABLE items; --' })).json() as DatabaseResponse;
    assert.equal(odd.rows?.[0]?.[0], "safe", "identifiers must be quoted, never interpolated as SQL");
    assert.equal((await f.request("database", { path: "extensionless", table: "hidden_view" })).status, 422);
    assert.equal((await f.request("database", { path: "extensionless", table: "missing" })).status, 422);
    assert.deepEqual(readdirSync(f.workspace).sort(), originals.map((o) => o.name));
    for (const original of originals) {
      assert.deepEqual(readFileSync(join(f.workspace, original.name)), original.bytes, original.name);
      assert.equal(statSync(join(f.workspace, original.name)).mtimeMs, original.modified, original.name);
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM items").get()?.n, 55);
  } finally { db.close(); await f.close(); }
});

test("SQLite errors and oversized snapshots are bounded; direct messages remain private", async () => {
  const f = await setup();
  const dm = await setup(true);
  try {
    writeFileSync(join(f.workspace, "broken.db"), "not sqlite");
    const response = await f.request("database", { path: "broken.db" });
    assert.equal(response.status, 422);
    assert.ok((await response.text()).length < 300);
    const db = new DatabaseSync(join(f.workspace, "wide.db"));
    db.exec(`CREATE TABLE wide(${Array.from({ length: 36 }, (_, i) => `c${i} TEXT`).join(",")})`);
    db.close();
    const wide = await (await f.request("database", { path: "wide.db", table: "wide" })).json() as DatabaseResponse;
    assert.equal(wide.columns?.length, 32);
    assert.equal(wide.columnsTruncated, true);
    const { truncateSync } = await import("node:fs");
    truncateSync(join(f.workspace, "broken.db"), 65 * 1024 * 1024);
    assert.match(await (await f.request("database", { path: "broken.db" })).text(), /64 MiB/);
    assert.equal((await dm.request("workspace")).status, 403);
    assert.equal((await dm.request("database", { path: "private.db" })).status, 403);
  } finally { await f.close(); await dm.close(); }
});

test("table pages are bounded and failed helpers clean up their private snapshots", async () => {
  const f = await setup();
  const interpreter = process.env.HARNESS_ARTIFACT_PYTHON;
  try {
    const db = new DatabaseSync(join(f.workspace, "many.db"));
    for (let i = 0; i < 105; i++) db.exec(`CREATE TABLE t${i}(value TEXT)`);
    db.close();
    const first = await (await f.request("database", { path: "many.db" })).json() as DatabaseResponse;
    assert.equal(first.tables.length, 100);
    assert.equal(first.nextTableOffset, 100);
    const last = await (await f.request("database", { path: "many.db", tableOffset: "100" })).json() as DatabaseResponse;
    assert.equal(last.tables.length, 5);
    assert.equal(last.nextTableOffset, undefined);
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("harness-workspace-")).sort();
    process.env.HARNESS_ARTIFACT_PYTHON = join(f.dataDir, "missing-python");
    const failure = await f.request("database", { path: "many.db" });
    assert.equal(failure.status, 503);
    assert.match(await failure.text(), /Python 3/);
    assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith("harness-workspace-")).sort(), before);
  } finally {
    if (interpreter === undefined) delete process.env.HARNESS_ARTIFACT_PYTHON;
    else process.env.HARNESS_ARTIFACT_PYTHON = interpreter;
    await f.close();
  }
});

test("workspace resource limits are platform-aware without weakening Linux enforcement", async (t) => {
  const f = await setup();
  const interpreter = process.env.HARNESS_ARTIFACT_PYTHON;
  try {
    const python = execFileSync(interpreter || "python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    const db = new DatabaseSync(join(f.workspace, "safe.db"));
    db.exec("CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('safe')");
    db.close();
    const original = readFileSync(join(f.workspace, "safe.db"));
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    for (const profile of ["darwin-value-error", "darwin-os-error", "darwin-unsupported", "linux", "linux-rejected", "linux-os-error", "linux-unsupported"]) {
      await t.test(profile, { skip: profile.startsWith("linux") && process.platform !== "linux" }, async () => {
        // Exercise the actual helper via an external interpreter shim, not a mock API.
        // Darwin cases simulate resource behavior; these are not native macOS runs.
        const shim = `
import resource, sys
profile = ${JSON.stringify(profile)}
address_space = getattr(resource, 'RLIMIT_AS', -1)
original_setrlimit = resource.setrlimit
seen = set()
def checked_setrlimit(kind, limits):
    if kind == address_space:
        if profile == 'darwin-value-error': raise ValueError('limit below existing mappings')
        if profile == 'darwin-os-error': raise OSError('unsupported limit')
        if profile == 'linux-rejected': raise ValueError('refused limit')
        if profile == 'linux-os-error': raise OSError('unsupported limit')
        assert limits == (512 * 1024 * 1024, 512 * 1024 * 1024)
    elif kind == resource.RLIMIT_CPU:
        assert limits == (3, 3)
    seen.add(kind)
    original_setrlimit(kind, limits)
resource.setrlimit = checked_setrlimit
sys.platform = profile.split('-')[0]
if profile.endswith('-unsupported') and hasattr(resource, 'RLIMIT_AS'): del resource.RLIMIT_AS
code = sys.argv[2]
sys.argv = sys.argv[2:]
exec(code, {'__name__': '__main__'})
assert resource.RLIMIT_CPU in seen
if profile == 'linux': assert address_space in seen
else: assert address_space not in seen
`;
        const wrapper = join(f.dataDir, "resource-python");
        writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(python)} -c ${quote(shim)} "$@"\n`, { mode: 0o700 });
        process.env.HARNESS_ARTIFACT_PYTHON = wrapper;
        const before = readdirSync(tmpdir()).filter((name) => name.startsWith("harness-workspace-")).sort();
        const listing = await f.request("workspace");
        const rows = await f.request("database", { path: "safe.db", table: "items" });
        if (profile.startsWith("linux-")) {
          assert.equal(listing.status, 503, "Linux must fail closed if its address-space limit cannot be enforced");
          assert.equal(rows.status, 503);
        } else {
          assert.equal(listing.status, 200);
          assert.equal(((await listing.json()) as WorkspaceResponse).entries[0]?.kind, "database");
          assert.equal(rows.status, 200);
          assert.deepEqual(((await rows.json()) as DatabaseResponse).rows, [["safe"]]);
        }
        assert.deepEqual(readFileSync(join(f.workspace, "safe.db")), original);
        assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith("harness-workspace-")).sort(), before);
      });
    }
  } finally {
    if (interpreter === undefined) delete process.env.HARNESS_ARTIFACT_PYTHON;
    else process.env.HARNESS_ARTIFACT_PYTHON = interpreter;
    await f.close();
  }
});
