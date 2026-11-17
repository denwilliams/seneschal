import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelRegistry } from "./registry.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "registry-"));
}

test("a channel's name survives a restart", () => {
  const dataDir = dir();
  new ChannelRegistry(dataDir).record({ id: "C1", name: "ops", isDm: false });

  // The index is on disk for exactly this: the next process starts knowing
  // nothing, and background work has only an id to go on.
  assert.equal(new ChannelRegistry(dataDir).nameFor("C1"), "ops");
});

test("a later sighting without a name does not erase the one on record", () => {
  const dataDir = dir();
  const registry = new ChannelRegistry(dataDir);
  registry.record({ id: "C1", name: "ops", isDm: false });
  registry.record({ id: "C1", isDm: false });

  assert.equal(registry.nameFor("C1"), "ops");
  assert.equal(new ChannelRegistry(dataDir).nameFor("C1"), "ops");
});

test("an unseen channel has no name to give", () => {
  assert.equal(new ChannelRegistry(dir()).nameFor("C404"), undefined);
});

test("names and ids resolve to the same channel", () => {
  const registry = new ChannelRegistry(dir());
  registry.record({ id: "C1", name: "ops", isDm: false });

  assert.equal(registry.resolveId("ops"), "C1");
  assert.equal(registry.resolveId("#ops"), "C1");
  assert.equal(registry.resolveId("C1"), "C1");
});

test("an explicit Slack ID wins over a matching stored name", () => {
  const registry = new ChannelRegistry(dir());
  registry.record({ id: "C0EXAMPLE02", name: "qa", isDm: false });
  // Channel names normally cannot look like Slack IDs, but a corrupt cache
  // must not be able to redirect work that explicitly names one.
  registry.record({ id: "C0OTHER123", name: "C0EXAMPLE02", isDm: false });

  assert.equal(registry.resolveId("C0EXAMPLE02"), "C0EXAMPLE02");
});

test("a stale name-as-id record cannot shadow the real channel", () => {
  const dataDir = dir();
  const indexDir = join(dataDir, "channels");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(
    join(indexDir, "index.json"),
    JSON.stringify([
      { id: "C0EXAMPLE02", name: "qa", isDm: false, firstSeen: "2026-09-01T00:00:00.000Z", lastSeen: "2026-09-01T00:00:00.000Z" },
      { id: "qa", name: "qa", isDm: false, firstSeen: "2026-09-10T00:00:00.000Z", lastSeen: "2026-09-10T00:00:00.000Z" },
    ]),
  );

  const registry = new ChannelRegistry(dataDir);

  assert.equal(registry.resolveId("qa"), "C0EXAMPLE02");
  assert.equal(registry.resolveId("#qa"), "C0EXAMPLE02");
  assert.deepEqual(registry.all().map((record) => record.id), ["C0EXAMPLE02"]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(indexDir, "index.json"), "utf-8")).map((record: { id: string }) => record.id),
    ["C0EXAMPLE02"],
    "loading migrates the stale cache record without touching channel data",
  );
});

test("names and other non-Slack IDs are not recorded", () => {
  const dataDir = dir();
  const registry = new ChannelRegistry(dataDir);

  registry.record({ id: "qa", name: "qa", isDm: false });

  assert.deepEqual(registry.all(), []);
  assert.equal(registry.resolveId("qa"), undefined);
});
