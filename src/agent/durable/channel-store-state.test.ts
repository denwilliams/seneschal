import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore, type ChannelStoreOptions } from "./channel-store.ts";
import { StateError, STATE_LIMITS, type StateObject } from "./state.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "durable-state-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const opts: ChannelStoreOptions = {
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
  };
  const open = new Set<DurableChannelStore>();
  t.after(async () => { for (const store of open) await store.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  return {
    root, faux,
    open: async () => { const store = await DurableChannelStore.open(opts); open.add(store); return store; },
    close: async (store: DurableChannelStore) => { await store.close(); open.delete(store); },
  };
}

const by = (threadKey = "t1") => ({ source: "agent" as const, threadKey, userId: "U1" });
const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof StateError && error.code === code);

test("an unused channel has empty state at revision 0, and reading it creates nothing", async (t) => {
  const f = await fixture(t); const store = await f.open();
  const snapshot = await store.stateSnapshot();
  assert.deepEqual([snapshot.rev, snapshot.value, snapshot.changes.length, snapshot.updatedAt], [0, {}, 0, 0]);
  assert.deepEqual(await store.readState("/anything"), { found: false, rev: 0, updatedAt: 0 });
});

test("updates are applied, advance the revision, and are attributed", async (t) => {
  const f = await fixture(t); const store = await f.open();
  assert.deepEqual(await store.updateState({ op: "set", path: "/jobs/last", value: { status: "ok" }, by: by("t1") }), { rev: 1, changed: true });
  assert.deepEqual(await store.updateState({ op: "append", path: "/log", value: "a", by: by("t2") }), { rev: 2, changed: true });
  assert.deepEqual(await store.updateState({ op: "merge", path: "/jobs/last", value: { at: 5 }, by: by("t1") }), { rev: 3, changed: true });
  const read = await store.readState("/jobs/last");
  assert.deepEqual([read.found, read.value, read.rev], [true, { status: "ok", at: 5 }, 3]);
  const snapshot = await store.stateSnapshot();
  assert.deepEqual(snapshot.value, { jobs: { last: { status: "ok", at: 5 } }, log: ["a"] });
  assert.deepEqual(snapshot.changes.map((c) => [c.rev, c.op, c.path, c.threadKey]), [[1, "set", "/jobs/last", "t1"], [2, "append", "/log", "t2"], [3, "merge", "/jobs/last", "t1"]]);
  assert.deepEqual([snapshot.updatedBy.threadKey, snapshot.updatedBy.userId, snapshot.updatedBy.source], ["t1", "U1", "agent"]);
  assert.ok(snapshot.updatedAt > 0 && snapshot.bytes > 0);
});

test("an update that changes nothing does not advance the revision or the log", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.updateState({ op: "set", path: "/a", value: 1, by: by() });
  assert.deepEqual(await store.updateState({ op: "set", path: "/a", value: 1, by: by() }), { rev: 1, changed: false });
  assert.deepEqual(await store.updateState({ op: "delete", path: "/nothing/here", by: by() }), { rev: 1, changed: false });
  assert.equal((await store.stateSnapshot()).changes.length, 1);
});

test("compare-and-set: a stale revision is refused with the current one, and nothing changes", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.updateState({ op: "set", path: "/n", value: 1, by: by() });
  await store.updateState({ op: "set", path: "/n", value: 2, by: by() });
  await assert.rejects(store.updateState({ op: "set", path: "/n", value: 99, expectedRev: 1, by: by() }), (error: unknown) =>
    error instanceof StateError && error.code === "conflict" && error.currentRev === 2 && /revision 2, not 1/.test(error.message));
  assert.deepEqual((await store.readState("/n")).value, 2);
  assert.deepEqual(await store.updateState({ op: "set", path: "/n", value: 3, expectedRev: 2, by: by() }), { rev: 3, changed: true });
});

test("refused updates (bad path, bad value, too large, wrong type) leave the state and the store healthy", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.updateState({ op: "set", path: "/keep", value: "me", by: by() });
  await rejectsWith(store.updateState({ op: "set", path: "no-slash", value: 1, by: by() }), "invalid_path");
  await rejectsWith(store.updateState({ op: "set", path: "/__proto__/x", value: 1, by: by() }), "invalid_path");
  await rejectsWith(store.updateState({ op: "set", path: "/a", by: by() }), "invalid_value");
  await rejectsWith(store.updateState({ op: "append", path: "/keep", value: 1, by: by() }), "type_mismatch");
  await rejectsWith(store.updateState({ op: "set", path: "/big", value: "x".repeat(STATE_LIMITS.stringChars + 1), by: by() }), "too_large");
  const snapshot = await store.stateSnapshot();
  assert.deepEqual([snapshot.rev, snapshot.value], [1, { keep: "me" }]);
  assert.deepEqual(await store.updateState({ op: "set", path: "/after", value: true, by: by() }), { rev: 2, changed: true }, "the store still takes updates");
});

test("many concurrent updates from different threads all land: none is lost, the revision counts each", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await Promise.all(Array.from({ length: 40 }, (_, i) => store.updateState({ op: "append", path: "/log", value: i, by: by(`t${i % 4}`) })));
  const snapshot = await store.stateSnapshot();
  assert.equal(snapshot.rev, 40);
  assert.deepEqual([...(snapshot.value.log as number[])].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
});

test("concurrent compare-and-set: exactly one of several writers holding the same revision wins", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.updateState({ op: "set", path: "/owner", value: "nobody", by: by() });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.updateState({ op: "set", path: "/owner", value: `t${i}`, expectedRev: 1, by: by(`t${i}`) })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected" && (r.reason as StateError).code === "conflict").length, 5);
  assert.equal((await store.stateSnapshot()).rev, 2);
});

test("the change log keeps only the most recent entries", async (t) => {
  const f = await fixture(t); const store = await f.open();
  for (let i = 0; i < STATE_LIMITS.changeLog + 12; i++) await store.updateState({ op: "set", path: "/n", value: i, by: by() });
  const { changes, rev } = await store.stateSnapshot();
  assert.equal(changes.length, STATE_LIMITS.changeLog);
  assert.equal(changes.at(-1)!.rev, rev);
  assert.equal(changes[0]!.rev, rev - STATE_LIMITS.changeLog + 1);
});

test("state survives closing and reopening the store", async (t) => {
  const f = await fixture(t);
  let store = await f.open();
  await store.updateState({ op: "set", path: "/persisted", value: { n: [1, 2, 3] }, by: by() });
  await f.close(store);
  store = await f.open();
  const snapshot = await store.stateSnapshot();
  assert.deepEqual([snapshot.rev, snapshot.value], [1, { persisted: { n: [1, 2, 3] } }]);
  assert.deepEqual(await store.updateState({ op: "append", path: "/persisted/n", value: 4, by: by() }), { rev: 2, changed: true });
});

test("state is the channel's, not a thread's: every thread and the trunk see the same object, and a fork does not copy it", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.updateState({ op: "set", path: "/shared", value: "yes", by: by("100.1") });
  f.faux.setResponses([fauxAssistantMessage("hi"), fauxAssistantMessage("hi again")]);
  for (const thread of ["200.1", "300.1"]) await store.wait(await store.submit(thread, { requestId: `${thread}-r`, content: "hello", userId: "U1" }));
  assert.deepEqual((await store.readState("/shared")).value, "yes", "unchanged by threads being created");
  await store.updateState({ op: "set", path: "/shared", value: "from another thread", by: by("300.1") });
  assert.deepEqual((await store.readState("/shared")).value, "from another thread");
  assert.equal((await store.stateSnapshot()).changes.at(-1)!.threadKey, "300.1");
});

test("a store killed in the middle of updating reopens consistent: the value, the revision and the log agree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "durable-state-crash-"));
  await mkdir(join(root, "workspace"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = fork(fileURLToPath(new URL("./fixtures/state-crash-child.ts", import.meta.url)), [root], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = ""; child.stderr?.on("data", (data) => { errors += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code]) => { throw new Error(`State crash fixture exited ${code}: ${errors}`); }),
    new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`State crash fixture timed out: ${errors}`)), 15000); timer.unref(); }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 15)); // let it be mid-update, not between two
  child.kill("SIGKILL"); await once(child, "exit");

  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const store = await DurableChannelStore.open({
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
  });
  t.after(() => store.close());
  const snapshot = await store.stateSnapshot();
  const log = (snapshot.value as StateObject).log as number[];
  assert.ok(snapshot.rev >= 21, `at least the acknowledged updates survived (rev ${snapshot.rev})`);
  assert.equal(log.length, snapshot.rev, "every revision is one append: a half-applied update would break this");
  assert.deepEqual(log, Array.from({ length: log.length }, (_, i) => i), "in order, nothing missing or repeated");
  assert.equal(snapshot.changes.at(-1)!.rev, snapshot.rev, "the log agrees with the revision");
  assert.deepEqual(await store.updateState({ op: "append", path: "/log", value: -1, by: by() }), { rev: snapshot.rev + 1, changed: true }, "and the store takes updates again");
});
