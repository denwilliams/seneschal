import assert from "node:assert/strict";
import { test } from "node:test";
import { KeychainSchema, type SecretScope } from "./keychain-schema.ts";
import { KeychainClient, KeychainError, assertKeychainHelper, nativeKeychainTransport, keychainChannelEnvironment, keychainMainSecret, applyKeychainProviderKeys } from "./keychain.ts";
import { HarnessConfigSchema } from "./schema.ts";
import { expandWith } from "./envfile.ts";

const channel = (channel: string) => ({ kind: "channel", channel }) as const;
const global = { kind: "global-channel" } as const;
const main = { kind: "main-process" } as const;
function setup(options = {}) {
  const config = KeychainSchema.parse({ helperPath: "/private/helper", adminWrites: true, globalChannel: ["KEY"], channels: { C1: ["KEY", "SECOND"], C2: ["KEY"] }, mainProcess: ["KEY"], ...options });
  let now = 0, reads = 0;
  let failure: Error | undefined;
  const values = new Map([ ["global-channel/KEY", "global"], ["channel/C1/KEY", "one"], ["channel/C1/SECOND", "second"], ["channel/C2/KEY", "two"], ["main-process/KEY", "main"] ]);
  const calls: unknown[] = [];
  const client = new KeychainClient(config, (operation, service, account, value) => {
    calls.push({ operation, service, account });
    if (operation === "read") reads++;
    if (failure) throw failure;
    if (operation === "save") { values.set(account, value!); return ""; }
    if (operation === "delete") { values.delete(account); return ""; }
    const found = values.get(account);
    if (found === undefined) throw new KeychainError("missing");
    return found;
  }, () => now);
  return { config, client, values, calls, reads: () => reads, time: (value: number) => { now = value; }, fail: (error?: Error) => { failure = error; } };
}
test("Keychain cache separates scope/channel and authorizes every hit without exposing state", () => {
  const f = setup();
  assert.equal(f.reads(), 0, "on-demand, no constructor lookups");
  assert.equal(f.client.read(channel("C1"), channel("C1"), "KEY"), "one");
  assert.equal(f.client.read(channel("C2"), channel("C2"), "KEY"), "two");
  assert.equal(f.client.read(channel("C1"), global, "KEY"), "global");
  assert.equal(f.client.read(channel("C2"), global, "KEY"), "global");
  assert.equal(f.client.read(main, main, "KEY"), "main");
  assert.equal(f.reads(), 4);
  for (const [principal, scope] of [[channel("C2"), channel("C1")], [channel("C1"), main], [main, channel("C1")]] as const) {
    assert.throws(() => f.client.read(principal, scope, "KEY"), { code: "unauthorized" });
  }
  f.config.channels.C1 = [];
  assert.throws(() => f.client.read(channel("C1"), channel("C1"), "KEY"), { code: "unauthorized" });
  assert.equal(f.reads(), 4);
  assert.equal(JSON.stringify(f.client), "{}");
  assert.match(JSON.stringify(f.calls), /ai.slack-harness.keychain.v1.default/);
  assert.doesNotMatch(JSON.stringify(f.config), /"one"|"two"|"main"/);
});
test("expiry never returns stale entries after denial, missing, lock or transport failure", () => {
  const f = setup({ cache: { ttlMs: 10, maxEntries: 3 } });
  assert.equal(f.client.read(channel("C1"), global, "KEY"), "global");
  f.time(9); f.fail(new KeychainError("denied"));
  assert.equal(f.client.read(channel("C1"), global, "KEY"), "global", "valid cache may outlive external denial until TTL");
  f.time(10);
  for (const code of ["denied", "locked", "missing", "timeout"] as const) {
    f.fail(new KeychainError(code));
    assert.throws(() => f.client.read(channel("C1"), global, "KEY"), { code });
  }
  f.fail(new Error("secret-sentinel backend diagnostic"));
  assert.throws(() => f.client.read(channel("C1"), global, "KEY"), (error) => error instanceof KeychainError && !JSON.stringify(error).includes("secret-sentinel") && !error.message.includes("secret-sentinel") && !error.cause);
  f.fail(); f.values.set("global-channel/KEY", "fresh");
  assert.equal(f.client.read(channel("C1"), global, "KEY"), "fresh");
});
test("bounded FIFO eviction, disabled cache, and per-provider/namespace isolation", () => {
  for (const cache of [{ ttlMs: 0, maxEntries: 2 }, { ttlMs: 10, maxEntries: 0 }]) {
    const f = setup({ cache });
    f.client.read(channel("C1"), global, "KEY"); f.client.read(channel("C1"), global, "KEY");
    assert.equal(f.reads(), 2);
  }
  const f = setup({ cache: { ttlMs: 100, maxEntries: 1 } });
  f.client.read(channel("C1"), global, "KEY");
  f.client.read(channel("C1"), channel("C1"), "KEY");
  f.client.read(channel("C1"), global, "KEY");
  assert.equal(f.reads(), 3);
  const other = setup({ namespace: "other" });
  other.values.set("global-channel/KEY", "other-provider-value");
  assert.equal(other.client.read(channel("C1"), global, "KEY"), "other-provider-value");
  assert.match(JSON.stringify(other.calls), /v1.other/);
});
test("cache byte bounds count UTF-8, evict old entries and skip oversized values", () => {
  const f = setup({ cache: { maxBytes: 6 } });
  f.values.set("global-channel/KEY", "éé"); // 4 UTF-8 bytes
  f.values.set("channel/C1/KEY", "one");
  f.client.read(channel("C1"), global, "KEY");
  f.client.read(channel("C1"), channel("C1"), "KEY");
  f.client.read(channel("C1"), global, "KEY");
  assert.equal(f.reads(), 3, "byte pressure evicts the oldest entry");
  f.values.set("channel/C1/SECOND", "oversized");
  f.client.read(channel("C1"), channel("C1"), "SECOND");
  f.client.read(channel("C1"), channel("C1"), "SECOND");
  assert.equal(f.reads(), 5, "large valid values are returned but not cached");
  const disabled = setup({ cache: { maxBytes: 0 } });
  disabled.client.read(channel("C1"), global, "KEY");
  disabled.client.read(channel("C1"), global, "KEY");
  assert.equal(disabled.reads(), 2);
});
test("writes/deletes invalidate exact entries including global hits in multiple channels, even on failure", () => {
  const f = setup();
  f.client.read(channel("C1"), global, "KEY"); f.client.read(channel("C2"), global, "KEY");
  f.client.read(channel("C1"), channel("C1"), "KEY");
  f.client.write("save", global, "KEY", "changed");
  assert.equal(f.client.read(channel("C2"), global, "KEY"), "changed");
  assert.equal(f.client.read(channel("C1"), global, "KEY"), "changed");
  assert.equal(f.client.read(channel("C1"), channel("C1"), "KEY"), "one");
  assert.equal(f.reads(), 3, "unrelated scoped cache retained");
  f.fail(new KeychainError("denied"));
  assert.throws(() => f.client.write("save", global, "KEY", "unsaved"));
  assert.throws(() => f.client.read(channel("C1"), global, "KEY"), { code: "denied" });
  f.fail(); f.client.write("delete", channel("C1"), "KEY");
  assert.throws(() => f.client.read(channel("C1"), channel("C1"), "KEY"), { code: "missing" });
});
test("schema and request validation bound names/values and reject unlock credentials/protected names", () => {
  const f = setup();
  for (const name of ["../KEY", "NODE_OPTIONS", "HARNESS_KEY", "", "x"]) assert.throws(() => f.client.write("save", global, name, "value"));
  for (const value of ["", "a\0b", "x".repeat(16385)]) assert.throws(() => f.client.write("save", global, "KEY", value));
  assert.throws(() => f.client.read(channel("C1"), { kind: "channel", channel: "../C1" }, "KEY"));
  const noAdmin = setup({ adminWrites: false });
  assert.throws(() => noAdmin.client.write("delete", global, "KEY"), { code: "unauthorized" });
  for (const input of [{ password: "never" }, { unlockPassword: "never" }, { cache: { ttlMs: -1 } }, { cache: { maxEntries: 4097 } }, { cache: { maxBytes: 67108865 } }, { namespace: "../escape" }, { providerKeys: { openai: "NOT_MAIN" } }]) {
    assert.equal(KeychainSchema.safeParse({ helperPath: "/helper", ...input }).success, false);
  }
  f.values.set("global-channel/KEY", "bad\0value");
  assert.throws(() => f.client.read(channel("C1"), global, "KEY"), { code: "invalid" });
});
test("unsupported platforms and invalid helper paths fail closed with fixed messages", () => {
  if (process.platform !== "darwin") {
    assert.throws(() => nativeKeychainTransport(setup().config, [])("read", "metadata", "KEY"), { code: "unsupported" });
  }
  for (const path of ["relative", "/does-not-exist-secret-sentinel", process.execPath]) {
    assert.throws(() => assertKeychainHelper(path, ["/"]), (error) => error instanceof KeychainError && error.code === "helper" && !error.message.includes("sentinel"));
  }
});
test("channel environment is on-demand, channel > global > legacy, with no main/other-channel fallback", async (t) => {
  const calls: { scope: SecretScope; name: string }[] = [];
  t.mock.method(KeychainClient.prototype, "read", (_principal: unknown, scope: SecretScope, name: string) => { calls.push({ scope, name }); return `${scope.kind === "channel" ? scope.channel : scope.kind}-value`; });
  const config = HarnessConfigSchema.parse({ keychain: { helperPath: "/private/helper", globalChannel: ["SHARED"], channels: { C1: ["SHARED", "LOCAL"], C2: ["OTHER"] }, mainProcess: ["MAIN"], providerKeys: { openai: "MAIN" } } });
  const env = keychainChannelEnvironment(config, "C1", { SHARED: "legacy", MAIN: "ambient", OTHER: "ambient-other", SAFE: "keep" });
  assert.equal(env.SHARED, "C1-value"); assert.equal(env.LOCAL, "C1-value"); assert.equal(env.SAFE, "keep");
  assert.equal(env.MAIN, undefined); assert.equal(env.OTHER, undefined);
  assert.equal(calls.length, 3); assert.ok(calls.every((entry) => entry.scope.kind !== "main-process"));
  assert.equal(keychainMainSecret(config, "MAIN"), "main-process-value");
  assert.equal(keychainMainSecret(config, "LOCAL"), undefined);
  const applied: unknown[] = [];
  await applyKeychainProviderKeys(config, { setRuntimeApiKey: async (...args) => { applied.push(args); } });
  assert.deepEqual(applied, [["openai", "main-process-value"]]);
  t.mock.method(KeychainClient.prototype, "read", () => { throw new KeychainError("denied"); });
  assert.throws(() => keychainChannelEnvironment(config, "C1", { SHARED: "legacy" }), { code: "denied" });
  assert.throws(() => keychainMainSecret(config, "MAIN"), { code: "denied" });
  const old = process.env.MAIN; process.env.MAIN = "ambient-hidden";
  try { assert.throws(() => expandWith("${MAIN}", env, "channel", false), /not set/); }
  finally { if (old === undefined) delete process.env.MAIN; else process.env.MAIN = old; }
});

test("native transport uses stdin only, bounded no-shell subprocesses, redacted errors and safe helper installation (mocked, not Keychain)", async (t) => {
  const { default: childProcess } = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const fs = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = fs.mkdtempSync(join(homedir(), ".harness-keychain-test-"));
  const helper = join(dir, "helper"); fs.writeFileSync(helper, "not executable code", { mode: 0o700 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => { Object.defineProperty(process, "platform", platform); fs.rmSync(dir, { recursive: true, force: true }); });
  Object.defineProperty(process, "platform", { value: "darwin" });
  const config = KeychainSchema.parse({ helperPath: helper });
  const transport = nativeKeychainTransport(config, []);
  let status: number | null = 0;
  let error: NodeJS.ErrnoException | undefined;
  const mock = t.mock.method(childProcess, "spawnSync", (_file: unknown, args: unknown, options: unknown) => {
    assert.doesNotMatch(JSON.stringify(args), /submitted-sentinel/);
    assert.equal((options as { input: string }).input, "submitted-sentinel");
    assert.deepEqual((options as { env: unknown }).env, { PATH: "/usr/bin:/bin" });
    assert.equal((options as { timeout: number }).timeout, 3000);
    assert.equal((options as { killSignal: string }).killSignal, "SIGKILL");
    assert.equal((options as { shell?: boolean }).shell, undefined);
    return { status, error, stdout: "", stderr: "submitted-sentinel private OS diagnostic", signal: null } as never;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  transport("save", "metadata", "account", "submitted-sentinel");
  for (const [exit, code] of [[42, "missing"], [43, "denied"], [44, "locked"], [45, "helper"], [null, "helper"]] as const) {
    status = exit;
    assert.throws(() => transport("save", "metadata", "account", "submitted-sentinel"), (err) => err instanceof KeychainError && err.code === code && !err.message.includes("sentinel"));
  }
  status = null; error = Object.assign(new Error("submitted-sentinel"), { code: "ETIMEDOUT" });
  assert.throws(() => transport("save", "metadata", "account", "submitted-sentinel"), { code: "timeout" });
  fs.chmodSync(helper, 0o722);
  assert.throws(() => assertKeychainHelper(helper, []), { code: "helper" });
  fs.chmodSync(helper, 0o700);
  assert.throws(() => assertKeychainHelper(helper, [dir]), { code: "helper" });
  fs.symlinkSync(helper, join(dir, "link"));
  assert.throws(() => assertKeychainHelper(join(dir, "link"), []), { code: "helper" });
});
