import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfigText } from "./load.ts";
import { appleConfigProblem } from "../agent/sandbox-apple.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";

test("a config with the removed top-level dashboard block fails with where it moved", () => {
  assert.throws(
    () => parseConfigText("dashboard:\n  enabled: true\n  token: secret\n", "test"),
    (err: Error) => /`dashboard`/.test(err.message) && /webConsole/.test(err.message)
      && /\/health/.test(err.message) && /\/api\/status/.test(err.message)
      && /historyLimit/.test(err.message) && /token/.test(err.message),
  );
});

test("a config with the removed top-level artifacts block fails with where it moved", () => {
  assert.throws(
    () => parseConfigText("artifacts:\n  enabled: true\n  baseUrl: https://files.example.test\n", "test"),
    (err: Error) => /`artifacts`/.test(err.message) && /webConsole\.artifacts: true/.test(err.message)
      && /webConsole\.enabled: true/.test(err.message) && /enabled/.test(err.message)
      && /console/.test(err.message) && /\/api\/status/.test(err.message) && /no authentication/.test(err.message)
      && /host/.test(err.message) && /port/.test(err.message) && /baseUrl/.test(err.message),
  );
});

test("an empty removed block is still refused, and loadConfig refuses it too", () => {
  assert.throws(() => parseConfigText("artifacts:\n", "test"), /`artifacts`/);
  const dir = mkdtempSync(join(tmpdir(), "harness-load-"));
  try {
    const path = join(dir, "harness.yaml");
    writeFileSync(path, "dashboard:\n  enabled: false\n");
    assert.throws(() => loadConfig(path), /`dashboard`[\s\S]*webConsole/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * `${VAR}` in most of the config is expanded once, against the process
 * environment, before the schema even sees it. A handful of sections are
 * deferred instead — expanded per channel later — because their values are
 * meant to come from that channel's own secrets, not whatever the harness
 * process happens to have. `exec` is the model for this; `share.sharedTools`
 * needs the same treatment for the same reason (a shared tool's env is a
 * per-consuming-channel decision), and it is easy to forget when a new
 * ${VAR}-bearing section is added.
 */

test("share.sharedTools env keeps ${VAR} placeholders for per-channel expansion", () => {
  const yaml = `
channels:
  home:
    share:
      sharedTools:
        deploy-notify:
          allowArgs: []
          env:
            TOKEN: \${NOT_SET_ANYWHERE_AT_LOAD_TIME}
`;
  // If this were expanded eagerly (like most of the config), parsing would
  // throw here because the variable is not set in the test process.
  const config = parseConfigText(yaml, "test");
  assert.equal(
    config.channels.home?.share.sharedTools["deploy-notify"]?.env.TOKEN,
    "${NOT_SET_ANYWHERE_AT_LOAD_TIME}",
  );
});

test("cliTools keeps ${VAR} placeholders until a consuming channel resolves them", () => {
  const config = parseConfigText(`
cliTools:
  status:
    command: /usr/local/bin/status
    args: [--account, "\${CLI_ACCOUNT_NOT_SET_AT_LOAD_TIME}"]
    env:
      TOKEN: \${CLI_TOKEN_NOT_SET_AT_LOAD_TIME}
channels:
  release:
    tools: [read, exec]
    exec:
      shared: [status]
`, "test");
  assert.deepEqual(config.cliTools.status?.args, ["--account", "${CLI_ACCOUNT_NOT_SET_AT_LOAD_TIME}"]);
  assert.equal(config.cliTools.status?.env.TOKEN, "${CLI_TOKEN_NOT_SET_AT_LOAD_TIME}");
});

// Exercise the on-disk loader and channel merge, not just the nullable schemas.
for (const scope of ["defaults", "channel"] as const) {
  test(`YAML sandbox.pidsLimit null survives loading and resolution at ${scope} scope`, (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "harness-pids-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const path = join(dataDir, "harness.yaml");
    const apple = "mode: macos-container, readOnlyRoot: true, pidsLimit: null";
    writeFileSync(path, scope === "defaults" ? `
defaults:
  sandbox: { ${apple} }
channels:
  C1: {}
` : `
defaults:
  sandbox: { mode: docker, pidsLimit: 512 }
channels:
  C1:
    sandbox: { ${apple} }
`);
    const { config } = loadConfig(path);
    if (scope === "defaults") assert.equal(config.defaults.sandbox.pidsLimit, null);
    else {
      assert.equal(config.defaults.sandbox.pidsLimit, 512);
      assert.equal(config.channels.C1?.sandbox?.pidsLimit, null);
    }
    const { channel } = resolveChannel(config, dataDir, { id: "C1", isDm: false }, new ChannelRegistry(dataDir));
    assert.ok(channel);
    assert.equal(channel.sandbox.mode, "macos-container");
    assert.equal(channel.sandbox.pidsLimit, null);
    // This is the config validation used by doctor, independent of Mac hardware.
    assert.equal(appleConfigProblem(channel.sandbox), undefined);
  });
}

test("YAML omission and numeric PID limits retain Docker defaults and Apple rejection", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-pids-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const registry = new ChannelRegistry(dataDir);
  for (const mode of ["docker", "macos-container", "kiri"] as const) {
    for (const [defaults, override, expected] of [
      ["", "", 256],
      [", pidsLimit: 512", "", 512],
      [", pidsLimit: 512", "pidsLimit: 64", 64],
      [", pidsLimit: null", "pidsLimit: 64", 64],
    ] as const) {
      const config = parseConfigText(`
defaults:
  sandbox: { mode: ${mode}, readOnlyRoot: true${defaults} }
channels:
  C1:
    sandbox: { ${override} }
`);
      const { channel } = resolveChannel(config, dataDir, { id: "C1", isDm: false }, registry);
      assert.ok(channel);
      assert.equal(channel.sandbox.pidsLimit, expected);
      if (mode === "macos-container") assert.match(appleConfigProblem(channel.sandbox)!, /pidsLimit: null/);
    }
  }
});

test("empty and comment-only YAML sections still normalize to unset", () => {
  assert.deepEqual(parseConfigText(`
defaults:
  # Account defaults left unset.
channels:
connectors:
webConsole:
  # Optional server left unset.
`), parseConfigText(""));
  assert.deepEqual(parseConfigText(`
defaults:
  sandbox:
    # Example only; no sandbox settings.
  exec:
  web:
channels:
  C1:
    sandbox:
      # Keep inheriting account settings.
    exec:
    connectors:
`), parseConfigText("channels: { C1: {} }"));
  // Null outside the two nullable PID-limit paths must still be normalized.
  const config = parseConfigText(`
connectors:
  example:
    transport: stdio
    command: example
    env: { pidsLimit: null }
`);
  const connector = config.connectors.example;
  assert.ok(connector?.transport === "stdio");
  assert.deepEqual(connector.env, {});
});

test("YAML PID limits still reject invalid numbers and quoted null", () => {
  for (const value of ["0", "-1", "1.5", '"null"']) {
    assert.throws(() => parseConfigText(`defaults: { sandbox: { pidsLimit: ${value} } }`), /pidsLimit/);
    assert.throws(() => parseConfigText(`channels: { C1: { sandbox: { pidsLimit: ${value} } } }`), /pidsLimit/);
  }
});
