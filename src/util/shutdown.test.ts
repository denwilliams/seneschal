import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedShutdown } from "./shutdown.ts";
test("shutdown exits on completion and failure without exposing the error", async () => {
  for (const fail of [false, true]) {
    const codes: number[] = [];
    await boundedShutdown(async () => { if (fail) throw new Error("private-secret"); }, (code) => { codes.push(code); }, 100);
    assert.deepEqual(codes, [0]);
  }
});
test("shutdown deadline exits even if a stream or active turn never drains", async () => {
  await new Promise<void>((resolve) => {
    void boundedShutdown(() => new Promise(() => {}), (code) => { assert.equal(code, 0); resolve(); }, 10);
  });
});
