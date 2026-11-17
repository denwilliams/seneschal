/** Opt-in REAL macOS smoke test and microbenchmark. Uses only randomly generated dummy secrets. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { KeychainSchema, type SecretScope } from "../config/keychain-schema.ts";
import { KeychainClient, KeychainError } from "../config/keychain.ts";

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new KeychainError("unsupported");
  const config = KeychainSchema.parse({ helperPath: process.argv[2], namespace: `smoke_${randomUUID()}`, adminWrites: true,
    globalChannel: ["KEY"], channels: { C1: ["KEY"], C2: ["KEY"] }, mainProcess: ["KEY"], cache: { ttlMs: 0 } });
  const client = new KeychainClient(config);
  const scopes: SecretScope[] = [{ kind: "global-channel" }, { kind: "channel", channel: "C1" }, { kind: "channel", channel: "C2" }, { kind: "main-process" }];
  const principal = (scope: SecretScope) => scope.kind === "main-process" ? { kind: "main-process" } as const : { kind: "channel", channel: scope.kind === "channel" ? scope.channel : "C1" } as const;
  const written: SecretScope[] = [];
  console.log(`Dummy-only test namespace: ${config.namespace}`);
  try {
    for (const scope of scopes) {
      const value = randomUUID(); client.write("save", scope, "KEY", value); written.push(scope);
      assert.equal(client.read(principal(scope), scope, "KEY"), value);
    }
    const ms: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(); client.read(principal(scopes[0]!), scopes[0]!, "KEY"); ms.push(performance.now() - start);
    }
    ms.sort((a, b) => a - b);
    console.log(`No-cache helper+Keychain round trip, n=20: median=${ms[10]!.toFixed(3)}ms p95=${ms[18]!.toFixed(3)}ms`);
    config.cache.ttlMs = 60000;
    client.read(principal(scopes[0]!), scopes[0]!, "KEY");
    const start = performance.now();
    for (let i = 0; i < 1000; i++) client.read(principal(scopes[0]!), scopes[0]!, "KEY");
    console.log(`Authorized cache hits, n=1000: mean=${((performance.now() - start) / 1000).toFixed(4)}ms`);
    assert.throws(() => client.read({ kind: "channel", channel: "C2" }, scopes[1]!, "KEY"), { code: "unauthorized" });
    const replacement = randomUUID(); client.write("save", scopes[0]!, "KEY", replacement);
    assert.equal(client.read({ kind: "channel", channel: "C2" }, scopes[0]!, "KEY"), replacement);
    client.write("delete", scopes[0]!, "KEY"); written.shift();
    assert.throws(() => client.read(principal(scopes[0]!), scopes[0]!, "KEY"), { code: "missing" });
    console.log("PASS: real read/write/update/delete, scope isolation, cache invalidation and missing-entry behavior. No values printed.");
  } finally {
    for (const scope of written) client.write("delete", scope, "KEY");
  }
}
main().catch((error) => {
  console.error(error instanceof KeychainError ? error.message : "Keychain smoke test failed. Check host setup and clean up the printed dummy namespace if needed.");
  process.exitCode = 1;
});
