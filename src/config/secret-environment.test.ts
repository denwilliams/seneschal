import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "./schema.ts";
import { KeychainClient, KeychainError } from "./keychain.ts";
import { initializeOpenBao } from "./openbao.ts";
import { scopedChannelEnvironment } from "./secret-environment.ts";
import { ScopedSecretAdmin } from "./scoped-secrets.ts";
import { checkRequirements } from "./requirements.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import type { SecretScope } from "./keychain-schema.ts";

for (const mode of ["docker", "macos-container", "kiri"] as const) {
  test(`combined backends preserve explicit scopes, precedence and filtered legacy names in ${mode}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "combined-secrets-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, "synthetic-bootstrap", { mode: 0o600 });
    const dataDir = join(root, "data"); mkdirSync(dataDir);
    const config = HarnessConfigSchema.parse({
      openbao: { address: "http://127.0.0.1:1", tokenFile, mainProcess: ["MAIN", "KC_VISIBLE"], globalChannel: ["OPEN_VISIBLE", "BOTH"], channels: { C1: ["LOCAL"], C2: ["OPEN_OTHER"] } },
      keychain: { helperPath: "/private/helper", mainProcess: ["KC_MAIN", "OPEN_VISIBLE"], globalChannel: ["KC_VISIBLE", "BOTH"], channels: { C1: ["KC_LOCAL"], C2: ["KC_OTHER"] } },
      defaults: { tools: [], sandbox: { mode } },
      channels: { C1: { requires: { env: ["OPEN_VISIBLE", "KC_VISIBLE", "LOCAL", "KC_LOCAL"], onMissing: "fail" } } },
    });
    const before = { ...process.env };
    await initializeOpenBao(config, { fetch: async (url) => Response.json({ data: { data: { value: `bao:${String(url).split("/").at(-1)}` } } }) });
    let fail = false;
    t.mock.method(KeychainClient.prototype, "read", (_principal: unknown, scope: SecretScope, name: string) => {
      if (fail) throw new KeychainError("locked");
      return `kc:${scope.kind}:${name}`;
    });
    const legacy = { MAIN: "hidden", KC_MAIN: "hidden", KC_OTHER: "hidden", OPEN_OTHER: "hidden", BAO_TOKEN: "hidden", VAULT_TOKEN: "hidden", BOTH: "legacy", KEEP: "legacy" };
    const visible = scopedChannelEnvironment(config, "C1", legacy, dataDir);
    const expected: Record<string, string> = { KEEP: "legacy", OPEN_VISIBLE: "bao:OPEN_VISIBLE", BOTH: "kc:global-channel:BOTH", LOCAL: "bao:LOCAL", KC_VISIBLE: "kc:global-channel:KC_VISIBLE", KC_LOCAL: "kc:channel:KC_LOCAL" };
    assert.deepEqual(visible, expected);
    assert.equal(checkRequirements(config.channels.C1!.requires, visible).ok, true);
    // The runtime consumes exactly the same visibility policy as doctor.
    const channel = resolveChannel(config, dataDir, { id: "C1", isDm: false }, new ChannelRegistry(dataDir)).channel!;
    for (const name of config.channels.C1!.requires.env) assert.equal(channel.env[name], visible[name]);
    assert.equal(channel.env.MAIN, undefined); assert.equal(channel.env.KC_MAIN, undefined);
    assert.equal(channel.env.OPEN_OTHER, undefined); assert.equal(channel.env.KC_OTHER, undefined);
    fail = true;
    assert.throws(() => scopedChannelEnvironment(config, "C1", legacy, dataDir), /locked/);
    assert.deepEqual({ ...process.env }, before);
  });
}

test("shared Admin dispatch retains both backends and Keychain-only delete without credential leaks", async () => {
  const writes: string[] = [];
  const service = new ScopedSecretAdmin([
    { id: "openbao", label: "OpenBao", enabled: () => true, save: async () => { writes.push("bao"); } },
    { id: "macos-keychain", label: "macOS Keychain", enabled: () => true, save: async () => { writes.push("kc"); }, remove: async () => { writes.push("delete"); } },
  ], () => [{ id: "C1" }]);
  assert.deepEqual(service.snapshot().backends.map((b) => [b.id, b.canDelete ?? false]), [["openbao", false], ["macos-keychain", true]]);
  for (const backend of ["openbao", "macos-keychain"]) await service.save(backend, { kind: "channel", channel: "C1" }, "TOKEN", "private-value", true);
  await assert.rejects(service.remove("openbao", { kind: "channel", channel: "C1" }, "TOKEN", true), /Deletion is unavailable/);
  await service.remove("macos-keychain", { kind: "channel", channel: "C1" }, "TOKEN", true);
  assert.deepEqual(writes, ["bao", "kc", "delete"]);
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /private-value/);
});

test("shared Admin sanitizes provider failures for writes and deletes", async () => {
  const service = new ScopedSecretAdmin([{ id: "synthetic", label: "Synthetic", enabled: () => true,
    save: async () => { throw new Error("private-value private-credential"); }, remove: async () => { throw new Error("private-value private-credential"); },
  }], () => []);
  for (const operation of [() => service.save("synthetic", { kind: "main-process" }, "TOKEN", "private-value", true), () => service.remove("synthetic", { kind: "main-process" }, "TOKEN", true)]) {
    await assert.rejects(operation(), (error: Error) => /Backend secret/.test(error.message) && !/private-value|private-credential/.test(error.message));
  }
});
