import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// These are subprocess/transport mocks, not real macOS Keychain tests.
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(homedir(), ".keychain-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "helper");
  writeFileSync(helper, "mock helper, never executed", { mode: 0o700 });
  const log = join(root, "routes.jsonl");
  const preload = join(root, "preload.mjs");
  writeFileSync(preload, `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'darwin' });
const original = cp.spawnSync;
cp.spawnSync = (file, args, options) => {
  if (file !== ${JSON.stringify(helper)}) return original(file, args, options);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  return { status: 0, signal: null, stdout: args[2] + '-dummy-sentinel', stderr: '' };
};
syncBuiltinESMExports();`);
  const configPath = join(root, "config.yaml");
  function config(body: string) { writeFileSync(configPath, `dataDir: ${JSON.stringify(join(root, "data"))}\nkeychain:\n  helperPath: ${JSON.stringify(helper)}\n${body}`); }
  function run(cli: string, args: string[] = [], mocked = true) {
    return spawnSync(process.execPath, ["--experimental-strip-types", ...(mocked ? ["--import", preload] : []), fileURLToPath(new URL(`./${cli}.ts`, import.meta.url)), ...args], {
      env: { ...process.env, HARNESS_CONFIG: configPath, SECRET_VALUE: "never-write-this-sentinel" }, encoding: "utf8", timeout: 30000,
    });
  }
  return { root, log, configPath, config, run };
}

test("connector-auth standalone resolves only its selected Keychain channel (mock transport)", (t) => {
  const f = fixture(t);
  f.config(`  globalChannel: [SHARED]\n  channels: { C123: [LOCAL], C234: [OTHER] }\n  mainProcess: [MAIN]\nconnectors:\n  example:\n    transport: http\n    url: https://must-not-contact.invalid/mcp\n    headers: { Authorization: '\${LOCAL}' }\n    oauth: { redirectUrl: 'https://callback.invalid/' }\nchannels:\n  C123:\n    share: { connectors: [example] }\n`);
  const result = f.run("connector-auth", ["--config", f.configPath, "--reset", "C123", "example"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Local OAuth state cleared/);
  assert.doesNotMatch(result.stdout + result.stderr, /dummy-sentinel/);
  const routes = readFileSync(f.log, "utf8");
  assert.match(routes, /global-channel\/SHARED/);
  assert.match(routes, /channel\/C123\/LOCAL/);
  assert.doesNotMatch(routes, /OTHER|MAIN|C234/);
});

test("doctor uses scoped requirements and memory-only provider keys without importing other channels (mock transport)", (t) => {
  const f = fixture(t);
  f.config(`  globalChannel: [SHARED]\n  channels: { C123: [LOCAL], C234: [OTHER] }\n  mainProcess: [MODEL]\n  providerKeys: { openai: MODEL }\ndefaults:\n  model: openai/gpt-4o\nchannels:\n  C123:\n    requires: { env: [SHARED, LOCAL] }\n`);
  const result = f.run("doctor");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /openai:.*macOS Keychain/);
  assert.doesNotMatch(result.stdout + result.stderr, /dummy-sentinel|requirements MISSING/);
  const routes = readFileSync(f.log, "utf8");
  assert.match(routes, /main-process\/MODEL/);
  assert.match(routes, /channel\/C123\/LOCAL/);
  assert.doesNotMatch(routes, /OTHER|C234/);
});

test("legacy secrets CLI refuses Keychain-managed names without a plaintext file", (t) => {
  const f = fixture(t);
  f.config(`  channels: { C123: [TOKEN] }\n`);
  for (const command of ["set", "remove"]) {
    const result = f.run("secrets", [command, "C123", "TOKEN"], false);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use the scoped write-only Admin form/);
    assert.doesNotMatch(result.stderr + result.stdout, /never-write-this-sentinel/);
    assert.equal(existsSync(join(f.root, "data", "channels", "C123", "env")), false);
  }
});

test("doctor and connector-auth reject unsupported Keychain hosts before use", { skip: process.platform === "darwin" }, (t) => {
  const f = fixture(t); f.config("");
  for (const [cli, args] of [["doctor", []], ["connector-auth", ["--config", f.configPath, "--reset", "C123", "example"]]] as const) {
    const result = f.run(cli, [...args], false);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Keychain requires a native macOS main process/);
    assert.doesNotMatch(result.stderr, /dummy-sentinel|never-write-this-sentinel/);
  }
});
