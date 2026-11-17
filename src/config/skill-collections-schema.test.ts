import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessConfigSchema } from "./schema.ts";

// Workstream B: admin channel and skill collections (config validation).

const rejects = (input: unknown, expected: RegExp) => {
  const result = HarnessConfigSchema.safeParse(input);
  assert.equal(result.success, false, "config should be rejected");
  if (!result.success) assert.match(result.error.issues.map((i) => i.message).join("\n"), expected);
};

test("at most one channel may be the admin channel", () => {
  assert.equal(HarnessConfigSchema.parse({ channels: { ops: { admin: true }, dev: {} } }).channels.ops?.admin, true);
  assert.equal(HarnessConfigSchema.safeParse({ channels: { ops: { admin: true }, dev: { admin: false } } }).success, true);
  rejects({ channels: { ops: { admin: true }, dev: { admin: true } } }, /at most one channel may set admin: true/);
  rejects({ channels: { ops: { admin: "yes" } } }, /./);
});

test("skill collection assignments default to read-only and validate names and modes", () => {
  const parsed = HarnessConfigSchema.parse({
    channels: {
      dev: { share: { skillCollections: ["software-development", { name: "life-admin" }, { name: "ops", mode: "rw" }] } },
    },
  });
  assert.deepEqual(parsed.channels.dev?.share.skillCollections, [
    { name: "software-development", mode: "ro" },
    { name: "life-admin", mode: "ro" },
    { name: "ops", mode: "rw" },
  ]);
  rejects({ channels: { dev: { share: { skillCollections: [{ name: "ops", mode: "write" }] } } } }, /./);
  rejects({ channels: { dev: { share: { skillCollections: [{ name: "ops", mode: "rw", extra: 1 }] } } } }, /./);
  for (const bad of ["../etc", "Has Caps", "a/b", "", "-x", "x-", "channel", "builtin", ".hidden"]) {
    rejects({ channels: { dev: { share: { skillCollections: [bad] } } } }, /./);
  }
  rejects(
    { channels: { dev: { share: { skillCollections: ["ops", { name: "ops", mode: "rw" }] } } } },
    /assigned more than once/,
  );
  assert.deepEqual(HarnessConfigSchema.parse({}).defaults.share.skillCollections, []);
});

test("the removed flat share.skills list is rejected with a migration message", () => {
  rejects({ channels: { dev: { share: { skills: ["code-review"] } } } }, /replaced by share\.skillCollections/);
  rejects({ defaults: { share: { skills: ["code-review"] } } }, /replaced by share\.skillCollections/);
  assert.equal(HarnessConfigSchema.safeParse({ channels: { dev: { share: { skills: [] } } } }).success, true);
});
