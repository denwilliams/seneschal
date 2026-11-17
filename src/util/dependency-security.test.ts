import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const root = new URL("../../", import.meta.url);
const require = createRequire(import.meta.url);
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const sdkRequire = createRequire(sdkEntry);

// Advisory floors from issue #267. Check every copy, not just the hoisted package:
// the SDK and Wrangler pin different Undici majors. This supplements, not replaces, npm audit.
const floors: Record<string, string> = {
  "body-parser": "2.4.0",
  "fast-uri": "3.1.9",
  "ip-address": "10.7.4",
  "minimatch": "11.0.1",
  "qs": "6.16.1",
  "zod": "4.6.6",
};

function atLeast(version: string, floor: string): boolean {
  const actual = version.split(".").map(Number);
  const minimum = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i]! > minimum[i]!;
  }
  return true;
}

for (const file of ["package-lock.json", "scripts/wrangler/package-lock.json"]) {
  test(`${file} has no copies below the confirmed advisory fixes`, () => {
    const lock = JSON.parse(readFileSync(new URL(file, root), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    let checked = 0;
    for (const [path, entry] of Object.entries(lock.packages)) {
      const name = path.split("node_modules/").at(-1)!;
      let floor = floors[name];
      if (name === "undici") floor = entry.version?.startsWith("7.") ? "7.30.1" : "8.12.2";
      if (!floor) continue;
      assert.ok(entry.version && atLeast(entry.version, floor), `${path}: ${entry.version} must be >= ${floor}`);
      checked++;
    }
    assert.ok(checked > 0, "the lockfile must contain the affected dependencies");
  });
}

test("the SDK's overridden minimatch preserves model scopes and package globs", async () => {
  // Exercise the SDK consumer too: minimatch 11 is an intentional major override until upstream updates its pin.
  const { resolveModelScopeFromModels } = await import(new URL("core/model-resolver.js", sdkEntry).href);
  const models = [
    { provider: "anthropic", id: "claude-sonnet" },
    { provider: "anthropic", id: "claude-opus" },
    { provider: "openai", id: "gpt-5" },
  ];
  const { scopedModels, diagnostics } = resolveModelScopeFromModels(["ANTHROPIC/claude-*:high", "gpt-?"], models);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(scopedModels.map((entry: { model: unknown }) => entry.model), models);
  assert.deepEqual(scopedModels.map((entry: { thinkingLevel?: string }) => entry.thinkingLevel), ["high", "high", undefined]);

  const { minimatch } = sdkRequire("minimatch");
  assert.equal(minimatch("extensions/nested/tool.ts", "extensions/**/*.ts"), true);
  assert.equal(minimatch("extensions/tool.js", "extensions/*.{ts,js}"), true);
  assert.equal(minimatch("extensions/tool.txt", "extensions/*.{ts,js}"), false);
});

for (const [name, load] of [["harness", require], ["Pi SDK", sdkRequire]] as const) {
  test(`${name}'s patched Undici fetch still decodes compressed JSON`, async (t) => {
    const { Agent, fetch } = load("undici");
    const payload = gzipSync(JSON.stringify({ ok: true }));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(payload);
    });
    const dispatcher = new Agent({ allowH2: false });
    t.after(async () => {
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/`, { dispatcher });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
}
