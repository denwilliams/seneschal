import assert from "node:assert/strict";
import { test } from "node:test";
import { StateError, STATE_LIMITS, type StateObject } from "./durable/state.ts";
import { createStateTools, type StateService } from "./state-tools.ts";

function service(overrides: Partial<StateService> = {}): StateService & { updates: unknown[] } {
  const updates: unknown[] = [];
  return {
    updates,
    readState: async (path = "") => (path === "/missing" ? { found: false, rev: 4, updatedAt: 1 } : { found: true, value: { status: "ok", n: 3 }, rev: 4, updatedAt: 1 }),
    stateSnapshot: async () => ({ rev: 4, value: {}, bytes: 2 }),
    updateState: async (input) => { updates.push(input); return { rev: 5, changed: true }; },
    ...overrides,
  };
}

const tools = (store: StateService | undefined, userId = "U7") => {
  const [read, update] = createStateTools({ store: () => store, threadKey: "100.1", currentUserId: () => userId });
  return {
    read: (params: unknown) => (read as any).execute("id", params) as Promise<{ content: { text: string }[]; details: any }>,
    update: (params: unknown) => (update as any).execute("id", params) as Promise<{ content: { text: string }[]; details: any }>,
    names: [read!.name, update!.name],
  };
};

test("two tools, with names that say what they do", () => {
  assert.deepEqual(tools(service()).names, ["state_read", "state_update"]);
});

test("state_read returns the value with its revision; a missing path says so", async () => {
  const t = tools(service());
  const found = JSON.parse((await t.read({ path: "/jobs" })).content[0]!.text);
  assert.deepEqual([found.rev, found.found, found.value, found.path], [4, true, { status: "ok", n: 3 }, "/jobs"]);
  const missing = JSON.parse((await t.read({ path: "/missing" })).content[0]!.text);
  assert.deepEqual([missing.found, missing.rev], [false, 4]);
  assert.equal(JSON.parse((await t.read({})).content[0]!.text).path, "", "no path means the whole object");
});

test("state_read summarizes a value too large to return whole, instead of flooding the context", async () => {
  const huge: StateObject = { logs: Array.from({ length: 900 }, (_, i) => `entry number ${i} with some padding text`), small: 1 };
  const t = tools(service({ readState: async () => ({ found: true, value: huge, rev: 9, updatedAt: 1 }) }));
  const result = JSON.parse((await t.read({})).content[0]!.text);
  assert.equal(result.truncated, true);
  assert.match(result.note, /Read a smaller path/);
  assert.deepEqual(result.keys.map((k: { key: string; type: string }) => [k.key, k.type]), [["logs", "array(900)"], ["small", "number"]]);
  assert.ok(JSON.stringify(result).length < 1_000, "the summary is small");
});

test("state_update passes the operation through, attributed to this thread and speaker", async () => {
  const store = service();
  const t = tools(store, "U42");
  const result = await t.update({ op: "append", path: "/log", value: { n: 1 }, expectedRev: 4 });
  assert.match(result.content[0]!.text, /revision 5/);
  assert.deepEqual(result.details, { rev: 5, changed: true });
  assert.deepEqual(store.updates, [{ op: "append", path: "/log", value: { n: 1 }, expectedRev: 4, by: { source: "agent", threadKey: "100.1", userId: "U42" } }]);
});

test("state_update omits what was not given, and delete needs no value", async () => {
  const store = service();
  await tools(store).update({ op: "delete", path: "/old" });
  assert.deepEqual(store.updates, [{ op: "delete", path: "/old", by: { source: "agent", threadKey: "100.1", userId: "U7" } }]);
});

test("state_update says plainly when nothing changed", async () => {
  const t = tools(service({ updateState: async () => ({ rev: 7, changed: false }) }));
  assert.match((await t.update({ op: "set", path: "/a", value: 1 })).content[0]!.text, /Nothing changed.*revision 7/);
});

test("a refusal reaches the model as an error it can act on", async () => {
  const conflict = tools(service({ updateState: async () => { throw new StateError("conflict", "The state is at revision 9, not 4. Read it again, then retry with the new revision.", 9); } }));
  await assert.rejects(conflict.update({ op: "set", path: "/a", value: 1, expectedRev: 4 }), /revision 9, not 4.*Read it again/);
  const bad = tools(service({ readState: async () => { throw new StateError("invalid_path", 'Path "x" must be a JSON Pointer.'); } }));
  await assert.rejects(bad.read({ path: "x" }), /JSON Pointer/);
});

test("anything that is not a refusal is not dressed up as one", async () => {
  const t = tools(service({ updateState: async () => { throw new Error("disk on fire"); } }));
  await assert.rejects(t.update({ op: "set", path: "/a", value: 1 }), /disk on fire/);
});

test("without a store (a session that has none) the tools fail closed", async () => {
  const t = tools(undefined);
  await assert.rejects(t.read({}), /not available/);
  await assert.rejects(t.update({ op: "set", path: "/a", value: 1 }), /not available/);
});

test("the description tells the model the limits and how state differs from memory", () => {
  const [read, update] = createStateTools({ store: () => undefined, threadKey: "t", currentUserId: () => "u" });
  assert.match(read!.description, /not memory/);
  assert.match(read!.description, /remember/);
  assert.match(update!.description, new RegExp(String(STATE_LIMITS.bytes)));
  assert.match(update!.description, /expectedRev/);
});
