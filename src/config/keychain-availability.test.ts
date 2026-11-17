import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessConfigSchema } from "./schema.ts";
import { keychainIsolationIssues, keychainRiskWarning } from "./keychain-policy.ts";
import { keychainWriter, ScopedSecretAdmin } from "./scoped-secrets.ts";
import { KeychainClient, validateKeychainHost } from "./keychain.ts";
import { KeychainSchema } from "./keychain-schema.ts";
import { checkEdits } from "./edit-policy.ts";

const hostConfig = () => HarnessConfigSchema.parse({ defaults: { tools: ["bash"], sandbox: { mode: "host" } } });
test("host bash without Keychain stays valid; availability explains .env and both container choices", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const config = hostConfig();
  const nativeWrite = t.mock.method(KeychainClient.prototype, "write", () => { throw new Error("must not reach Keychain"); });
  const admin = new ScopedSecretAdmin([keychainWriter(() => config, "/private/data")], () => [{ id: "C1" }]);
  assert.equal(config.keychain, undefined);
  const [backend] = admin.snapshot().backends;
  assert.equal(backend!.enabled, false);
  assert.match(backend!.unavailableReason!, /unavailable with host bash.*harness OS identity/);
  assert.match(backend!.unavailableReason!, /Docker or Apple Containers \(macos-container\)/);
  assert.match(backend!.unavailableReason!, /keep using \.env without container isolation/);
  await assert.rejects(admin.save("macos-keychain", { kind: "channel", channel: "C1" }, "TOKEN", "secret", true), /not enabled/);
  await assert.rejects(admin.remove("macos-keychain", { kind: "main-process" }, "TOKEN", true), /not enabled/);
  assert.equal(nativeWrite.mock.callCount(), 0);
});

test("explicit Keychain is still rejected for default, inherited and overridden host bash, even with empty imports", () => {
  for (const input of [
    { defaults: { tools: ["bash"], sandbox: { mode: "host" } } },
    { defaults: { tools: ["bash"], sandbox: { mode: "docker" } }, channels: { C1: { sandbox: { mode: "host" } } } },
    { defaults: { sandbox: { mode: "host" } }, channels: { C1: { tools: ["bash"] } } },
  ]) {
    assert.equal(HarnessConfigSchema.safeParse(input).success, true);
    for (const acceptHostExecutionRisk of [undefined, false]) {
      const result = HarnessConfigSchema.safeParse({ ...input, keychain: { helperPath: "/helper", acceptHostExecutionRisk } });
      assert.equal(result.success, false);
      if (!result.success) assert.match(result.error.message, /Keychain is unavailable with host bash.*leave Keychain unconfigured/);
    }
  }
  for (const mode of ["docker", "macos-container", "kiri"] as const) {
    const config = HarnessConfigSchema.parse({ defaults: { tools: ["bash"], sandbox: { mode } }, keychain: { helperPath: "/helper" } });
    assert.deepEqual(keychainIsolationIssues(config), []);
  }
});

test("risk acceptance requires a literal operator boolean and keeps agent config edits denied", () => {
  assert.equal(KeychainSchema.parse({ helperPath: "/helper" }).acceptHostExecutionRisk, false);
  for (const acceptHostExecutionRisk of ["true", "false", 1, null]) {
    assert.equal(KeychainSchema.safeParse({ helperPath: "/helper", acceptHostExecutionRisk }).success, false);
  }
  for (const privileged of [false, true]) {
    const errors = checkEdits([{ path: ["keychain", "acceptHostExecutionRisk"], value: true }], {
      before: {}, after: { keychain: { acceptHostExecutionRisk: true } }, protectedChannels: new Set(), privileged,
    });
    assert.match(errors.join(" "), /keychain.*edited on the host/);
  }
});

test("risk acceptance does not bypass native host or helper validation", (t) => {
  const config = HarnessConfigSchema.parse({ keychain: { helperPath: "/nonexistent-private-helper", acceptHostExecutionRisk: true }, defaults: { tools: ["bash"], sandbox: { mode: "host" } } });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => Object.defineProperty(process, "platform", platform));
  Object.defineProperty(process, "platform", { value: "linux" });
  assert.throws(() => validateKeychainHost(config, "/private/data"), { code: "unsupported" });
  Object.defineProperty(process, "platform", { value: "darwin" });
  assert.throws(() => validateKeychainHost(config, "/private/data"), { code: "helper" });
});

test("explicit acceptance permits every host execution guard across inherited and overridden modes", () => {
  for (const mode of ["host", "docker", "macos-container", "kiri"]) {
    for (const settings of [{ tools: ["bash"] }, { tools: ["exec"] }, { share: { sharedTools: { planted: {} } } }]) {
      for (const location of ["defaults", "channel", "inherited"]) {
        const config = HarnessConfigSchema.parse({
          keychain: { helperPath: "/helper", acceptHostExecutionRisk: true },
          defaults: { sandbox: { mode }, ...(location !== "channel" ? settings : {}) },
          channels: location === "defaults" ? {} : { C1: location === "channel" ? settings : {} },
        });
        assert.deepEqual(keychainIsolationIssues(config), []);
        assert.match(keychainRiskWarning(config)!, /Same-user host execution is trusted.*outside configured channel scopes/);
      }
    }
  }
});

test("accepted risk is a warning, not unavailability, and follows reloads without bypassing platform/Admin checks", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let config = HarnessConfigSchema.parse({ defaults: { tools: ["bash"], sandbox: { mode: "docker" } }, keychain: { helperPath: "/helper", adminWrites: true } });
  const admin = new ScopedSecretAdmin([keychainWriter(() => config, "/private/data")], () => []);
  assert.equal(admin.snapshot().backends[0]!.warning, undefined);
  config = HarnessConfigSchema.parse({ ...config, defaults: { tools: ["bash", "exec"], sandbox: { mode: "host" } }, keychain: { ...config.keychain, acceptHostExecutionRisk: true } });
  let backend = admin.snapshot().backends[0]!;
  assert.equal(backend.enabled, true);
  assert.equal(backend.unavailableReason, undefined);
  assert.match(backend.warning!, /risk accepted.*Container channels do not isolate their secrets from the host/);
  config.keychain!.adminWrites = false;
  backend = admin.snapshot().backends[0]!;
  assert.equal(backend.enabled, false);
  assert.match(backend.unavailableReason!, /Admin writes are disabled/);
  assert.ok(backend.warning);
  Object.defineProperty(process, "platform", { value: "linux" });
  config.keychain!.adminWrites = true;
  assert.match(admin.snapshot().backends[0]!.unavailableReason!, /native macOS/);
  config.keychain!.acceptHostExecutionRisk = false;
  assert.equal(admin.snapshot().backends[0]!.warning, undefined);
  assert.match(admin.snapshot().backends[0]!.unavailableReason!, /forbids host CLI.*unavailable with host bash/);
});

test("availability follows current config and still blocks host exec/shared tools", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let config = hostConfig();
  const writer = keychainWriter(() => config, "/private/data");
  assert.equal(writer.enabled(), false);
  config = HarnessConfigSchema.parse({ defaults: { tools: ["bash"], sandbox: { mode: "docker" } } });
  assert.match(writer.unavailableReason!()!, /not configured/);
  config = HarnessConfigSchema.parse({ ...config, keychain: { helperPath: "/helper" } });
  assert.match(writer.unavailableReason!()!, /Admin writes are disabled/);
  config.keychain!.adminWrites = true;
  assert.equal(writer.enabled(), true);
  assert.equal(writer.unavailableReason!(), undefined);
  config.defaults.tools.push("exec"); // Deliberately bypass parsing: Admin must fail closed too.
  assert.equal(writer.enabled(), false);
  assert.match(writer.unavailableReason!()!, /forbids host CLI execution/);
  config.defaults.tools = ["bash"];
  config.defaults.share.sharedTools.planted = { allowArgs: [[]] } as never;
  assert.equal(writer.enabled(), false);
  assert.match(writer.unavailableReason!()!, /forbids host shared-tool execution/);
});
