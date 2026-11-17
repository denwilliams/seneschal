import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessApp } from "./app.ts";
import { channelsToOpen, shouldReopenFailedStore, STORE_REOPEN_COOLDOWN_MS } from "./store-lifecycle.ts";

function dataDirWith(...existing: string[]) {
  const dataDir = mkdtempSync(join(tmpdir(), "store-lifecycle-"));
  for (const id of existing) mkdirSync(join(dataDir, "channels", id, "durable"), { recursive: true });
  return dataDir;
}

test("channels to open: existing stores first, then every known ID that has none", () => {
  const dataDir = dataDirWith("CEXIST1");
  mkdirSync(join(dataDir, "channels", "CNOSTORE", "workspace"), { recursive: true }); // a channel dir with no durable store yet
  try {
    const result = channelsToOpen({
      dataDir,
      seen: ["CSEEN001", "CEXIST1", "DDIRECT1"],
      configured: ["CCONFIG1", "CSEEN001", "general", "#also-a-name", "CEXIST1"],
    });
    assert.deepEqual(result.existing, ["CEXIST1"]);
    assert.deepEqual(result.fresh, ["CSEEN001", "DDIRECT1", "CCONFIG1"], "no duplicates, and names with no Slack ID yet cannot be opened");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("channels to open: a data dir with no channels yet is fine", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "store-lifecycle-empty-"));
  try {
    assert.deepEqual(channelsToOpen({ dataDir, seen: [], configured: ["CONFIG01"] }), { existing: [], fresh: ["CONFIG01"] });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a failed store is reopened once, then left alone for a minute", () => {
  const now = 1_000_000;
  assert.equal(shouldReopenFailedStore(undefined, now), true, "the first failure reopens");
  assert.equal(shouldReopenFailedStore(now - 1_000, now), false, "a second failure right away does not");
  assert.equal(shouldReopenFailedStore(now - STORE_REOPEN_COOLDOWN_MS, now), true, "and after the cooldown it may again");
});

function harnessWith(dataDir: string, events: string[], opened: (id: string) => "opened" | "skipped" | "failed" = () => "opened") {
  return Object.assign(Object.create(HarnessApp.prototype), {
    config: { channels: { CCONFIG1: {}, general: {} } }, opts: { dataDir },
    registry: { all: () => [{ id: "CSEEN001" }] },
    storeFailures: new Map<string, number>(),
    runtimes: { channelIds: () => ["COPEN001", "CEXIST1"], invalidate: async (id: string) => { events.push(`retire ${id}`); } },
    openChannelStore: async (id: string) => { events.push(`open ${id}`); return opened(id); },
  }) as any;
}

test("boot: channels with a store are recovered and awaited; new ones open in the background", async () => {
  const dataDir = dataDirWith("CEXIST1");
  const events: string[] = [];
  const release: (() => void)[] = [];
  const app = harnessWith(dataDir, events);
  // New channels take a while to open; the boot must not wait for them.
  app.openChannelStore = async (id: string) => {
    events.push(`start ${id}`);
    if (id !== "CEXIST1") await new Promise<void>((resolve) => release.push(resolve));
    events.push(`done ${id}`);
    return "opened";
  };
  try {
    await app.openAllChannelStores();
    assert.deepEqual(events.filter((e) => e.endsWith("CEXIST1")), ["start CEXIST1", "done CEXIST1"], "the existing store was finished before boot continued");
    assert.ok(events.includes("start CSEEN001") && !events.includes("done CSEEN001"), "a new channel is still opening while boot has moved on");
    while (release.length < 1) await new Promise((r) => setTimeout(r, 5));
    release.shift()!();
    while (release.length < 1) await new Promise((r) => setTimeout(r, 5));
    release.shift()!();
    for (let spins = 0; spins < 50 && !events.includes("done CCONFIG1"); spins++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events.filter((e) => e.startsWith("done")), ["done CEXIST1", "done CSEEN001", "done CCONFIG1"], "new ones open one at a time, in order");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("boot: one channel that will not open does not stop the rest", async () => {
  const dataDir = dataDirWith("CEXIST1", "CEXIST2");
  const events: string[] = [];
  const app = harnessWith(dataDir, events, (id) => (id === "CEXIST1" ? "failed" : "opened"));
  try {
    await app.openAllChannelStores();
    assert.deepEqual(events.filter((e) => e.startsWith("open CEXIST")), ["open CEXIST1", "open CEXIST2"]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("reload: every store, including ones that were never open, is retired and then reopened on the new config", async () => {
  const dataDir = dataDirWith("CEXIST1");
  const events: string[] = [];
  const app = harnessWith(dataDir, events);
  try {
    await app.reopenChannelStores();
    const ids = ["COPEN001", "CEXIST1", "CSEEN001", "CCONFIG1"];
    for (const id of ids) {
      assert.ok(events.indexOf(`retire ${id}`) >= 0 && events.indexOf(`open ${id}`) > events.indexOf(`retire ${id}`), `${id} is retired before it is reopened`);
    }
    assert.equal(events.length, ids.length * 2, "each channel once, and no duplicates for one that is both open and on disk");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a failed store reopens, but not in a loop", async () => {
  const dataDir = dataDirWith();
  const events: string[] = [];
  const app = harnessWith(dataDir, events);
  try {
    app.reopenFailedStore("CFAILING");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ["open CFAILING"]);
    app.reopenFailedStore("CFAILING"); // fails again straight away
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ["open CFAILING"], "the second failure within the cooldown is left for the next message");
    app.reopenFailedStore("COTHER001");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ["open CFAILING", "open COTHER001"], "another channel is unaffected");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
