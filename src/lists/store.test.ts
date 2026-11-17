import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChannelLists } from "./store.ts";

function fixture(t: import("node:test").TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lists-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, "a"), b = join(root, "b"); mkdirSync(a); mkdirSync(b);
  return { root, a, b, store: new ChannelLists(a) };
}

test("list/item lifecycle persists across connections with a physical table per list", (t) => {
  const { a, store } = fixture(t);
  assert.deepEqual(store.read(), { lists: [] });
  store.mutate({ op: "create", list: "todo" });
  store.mutate({ op: "create", list: "shopping" });
  const { id } = store.mutate({ op: "add_item", list: "todo", values: { title: "Ship it" } });
  const item = new ChannelLists(a).read("todo").items![0]!;
  assert.deepEqual(item, { id, title: "Ship it", notes: "", completed: false, created_at: item.created_at, updated_at: item.created_at });
  assert.match(String(item.created_at), /^\d{4}-.*Z$/);
  store.mutate({ op: "update_item", list: "todo", id, values: { notes: "Release notes", completed: true } });
  assert.equal(store.read("todo").items![0]!.title, "Ship it");
  assert.equal(store.read("todo").items![0]!.completed, true);
  store.mutate({ op: "rename", list: "todo", name: "release" });
  assert.deepEqual(new ChannelLists(a).read().lists, ["release", "shopping"]);
  assert.equal(store.read("release").items![0]!.notes, "Release notes");
  const db = new DatabaseSync(join(a, "lists.sqlite"));
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'list_*' ORDER BY name").all().map((r) => r.name), ["list_release", "list_shopping"]); db.close();
  store.mutate({ op: "delete_item", list: "release", id });
  assert.equal(store.read("release").items!.length, 0);
  const next = store.mutate({ op: "add_item", list: "release", values: { title: "Next" } });
  assert.ok(next.id! > id!);
  store.mutate({ op: "delete_list", list: "release", confirm: true });
  assert.deepEqual(store.read().lists, ["shopping"]);
});

test("typed nullable schema changes preserve all unrelated data and standard columns", (t) => {
  const { store } = fixture(t);
  store.mutate({ op: "create", list: "todo" });
  const { id } = store.mutate({ op: "add_item", list: "todo", values: { title: "Before", notes: "Keep" } });
  for (const type of ["text", "integer", "real", "boolean"]) store.mutate({ op: "add_column", list: "todo", column: type + "_value", type });
  assert.equal(store.read("todo").items![0]!.boolean_value, null);
  const values = { text_value: "' ; DROP TABLE list_todo; --\n\0", integer_value: 3, real_value: 2.5, boolean_value: true };
  store.mutate({ op: "update_item", list: "todo", id, values });
  for (const [key, value] of Object.entries(values)) assert.equal(store.read("todo").items![0]![key], value);
  for (const column of ["id", "title", "notes", "completed", "created_at", "updated_at"]) assert.throws(() => store.mutate({ op: "drop_column", list: "todo", column, confirm: true }), /protected/);
  assert.throws(() => store.mutate({ op: "drop_column", list: "todo", column: "text_value" }), /confirm/);
  store.mutate({ op: "drop_column", list: "todo", column: "text_value", confirm: true });
  const after = store.read("todo").items![0]!;
  assert.equal(after.notes, "Keep"); assert.equal(after.real_value, 2.5); assert.equal(after.boolean_value, true);
  assert.ok(!Object.hasOwn(after, "text_value"));
  store.mutate({ op: "update_item", list: "todo", id, values: { boolean_value: null } });
  assert.equal(store.read("todo").items![0]!.boolean_value, null);
});

test("channel isolation, SQL/name/value attacks and failed mutations leave data intact", (t) => {
  const { b, store } = fixture(t); const other = new ChannelLists(b);
  store.mutate({ op: "create", list: "todo" });
  const { id } = store.mutate({ op: "add_item", list: "todo", values: { title: "Private" } });
  assert.deepEqual(other.read().lists, []);
  assert.throws(() => other.read("todo"), /No such list/);
  for (const list of ["../b/lists.sqlite", "todo; DROP TABLE list_todo", "todo\"", "", "sqlite_schema", "__proto__", "A"]) {
    if (list === "sqlite_schema") continue; // A safe ordinary list name; stored as list_sqlite_schema.
    assert.throws(() => store.mutate({ op: "create", list }));
  }
  for (const values of [{ id: 4 }, { created_at: "fake" }, { updated_at: "fake" }, { title: " " }, { title: null }, { notes: 1 }, { completed: 1 }, { missing: "x" }, { 'x"; DROP TABLE list_todo;--': "x" }, { title: "x".repeat(4001) }]) {
    assert.throws(() => store.mutate({ op: "update_item", list: "todo", id, values }));
  }
  assert.throws(() => store.mutate({ op: "add_item", list: "todo", values: { notes: "No title" } }), /Title/);
  assert.throws(() => store.mutate({ op: "update_item", list: "todo", id: 999, values: { title: "Missing" } }), /No such item/);
  assert.throws(() => store.mutate({ op: "delete_list", list: "todo" }), /confirm/);
  assert.throws(() => store.mutate({ op: "rename", list: "todo", name: "elsewhere", channel: b }), /Unrecognized/);
  store.mutate({ op: "create", list: "existing" });
  assert.throws(() => store.mutate({ op: "rename", list: "todo", name: "existing" }));
  assert.equal(store.read("todo").items![0]!.title, "Private");
});

test("custom types are validated, and reads are paginated", (t) => {
  const { store } = fixture(t); store.mutate({ op: "create", list: "todo" });
  for (const type of ["text", "integer", "real", "boolean"]) store.mutate({ op: "add_column", list: "todo", column: "c_" + type, type });
  for (const values of [{ c_text: 1 }, { c_integer: 1.2 }, { c_integer: Number.MAX_SAFE_INTEGER + 1 }, { c_real: "1" }, { c_real: Infinity }, { c_boolean: "true" }]) assert.throws(() => store.mutate({ op: "add_item", list: "todo", values: { title: "x", ...values } }));
  for (let i = 0; i < 52; i++) store.mutate({ op: "add_item", list: "todo", values: { title: String(i) } });
  const first = store.read("todo"); assert.equal(first.items!.length, 50); assert.equal(first.nextOffset, 50);
  assert.equal(store.read("todo", 50).items!.length, 2); assert.equal(store.read("todo", 50).nextOffset, undefined);
  for (const offset of [-1, 0.5, NaN, Infinity]) assert.throws(() => store.read("todo", offset), /offset/);
});

test("refuses symlink/hardlink databases, sidecars and intermediate directories", (t) => {
  const { a, b, root, store } = fixture(t);
  const target = join(b, "target"); writeFileSync(target, "sentinel");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = join(a, "lists.sqlite" + suffix);
    symlinkSync(target, path); assert.throws(() => store.read(), /Unsafe/); unlinkSync(path);
    linkSync(target, path); assert.throws(() => store.read(), /Unsafe/); unlinkSync(path);
  }
  const alias = join(root, "alias"); symlinkSync(a, alias, "dir");
  assert.throws(() => new ChannelLists(alias).read(), /Unsafe/);
  const parent = join(root, "parent"); symlinkSync(root, parent, "dir");
  assert.throws(() => new ChannelLists(join(parent, "a")).read(), /Unsafe/);
});


test("near-limit editable data has one canonical insert/update size, excluding generated fields", (t) => {
  const { store } = fixture(t);
  store.mutate({ op: "create", list: "big" });
  for (let i = 0; i < 3; i++) store.mutate({ op: "add_column", list: "big", column: "c" + i, type: "text" });
  const values = { title: "x".repeat(4000), notes: "x".repeat(4000), c0: "x".repeat(4000), c1: "x".repeat(4000), c2: "x".repeat(250) };
  assert.equal(Buffer.byteLength(JSON.stringify(values)), 16297);
  const { id } = store.mutate({ op: "add_item", list: "big", values });
  const before = store.read("big").items![0]!;
  assert.ok(Buffer.byteLength(JSON.stringify(before)) > 16 * 1024, "generated metadata is not item data");
  store.mutate({ op: "update_item", list: "big", id, values: { completed: true } });
  const completed = store.read("big").items![0]!;
  for (const [key, value] of Object.entries(values)) assert.equal(completed[key], value);
  assert.equal(completed.completed, true);
  store.mutate({ op: "update_item", list: "big", id, values: { completed: false } });
  assert.equal(store.read("big").items![0]!.completed, false);
});

test("exact canonical byte limit includes defaults, nulls, Unicode and JSON escaping; failures roll back", (t) => {
  const { a, store } = fixture(t);
  store.mutate({ op: "create", list: "big" });
  for (let i = 0; i < 4; i++) store.mutate({ op: "add_column", list: "big", column: "c" + i, type: "text" });
  const base = { title: "x".repeat(4000), notes: "x".repeat(4000), c0: "é".repeat(2000), c1: "\\".repeat(2000) };
  const padding = 16 * 1024 - Buffer.byteLength(JSON.stringify({ ...base, completed: false, c2: "", c3: null }));
  const values = { ...base, c2: "x".repeat(padding) };
  const { id } = store.mutate({ op: "add_item", list: "big", values });
  const before = store.read("big").items![0]!;
  const { id: _id, created_at: _created, updated_at: _updated, ...editable } = before;
  assert.equal(Buffer.byteLength(JSON.stringify(editable)), 16 * 1024);
  store.mutate({ op: "update_item", list: "big", id, values: { completed: true } });
  store.mutate({ op: "update_item", list: "big", id, values: { completed: false } });
  const snapshot = store.read("big");
  assert.throws(() => store.mutate({ op: "add_item", list: "big", values: { ...values, c2: values.c2 + "x" } }), /16 KiB/);
  assert.throws(() => store.mutate({ op: "update_item", list: "big", id, values: { c2: values.c2 + "x" } }), /16 KiB/);
  assert.deepEqual(store.read("big"), snapshot, "failed writes preserve values and timestamps");
  const db = new DatabaseSync(join(a, "lists.sqlite"));
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='list_big'").get()!.seq, id, "failed inserts also roll back the ID sequence");
});

for (const type of ["text", "integer", "real", "boolean"]) {
  test(`adding a nullable ${type} column checks every existing item and rolls back overflow`, (t) => {
    const { a, store } = fixture(t);
    store.mutate({ op: "create", list: "big" });
    for (let i = 0; i < 3; i++) store.mutate({ op: "add_column", list: "big", column: "c" + i, type: "text" });
    // Put the oversized candidate beyond the first read page to catch partial scans.
    for (let i = 0; i < 55; i++) store.mutate({ op: "add_item", list: "big", values: { title: "Small " + i } });
    const base = { title: "x".repeat(4000), notes: "x".repeat(4000), c0: "x".repeat(4000), c1: "x".repeat(4000) };
    const padding = 16 * 1024 - Buffer.byteLength(JSON.stringify({ ...base, completed: false, c2: "" }));
    const values = { ...base, c2: "x".repeat(padding) };
    const { id } = store.mutate({ op: "add_item", list: "big", values });
    const firstPage = store.read("big");
    const lastPage = store.read("big", 50);
    const { id: _id, created_at: _created, updated_at: _updated, ...editable } = lastPage.items!.at(-1)!;
    assert.equal(Buffer.byteLength(JSON.stringify(editable)), 16 * 1024);
    assert.throws(() => store.mutate({ op: "add_column", list: "big", column: "extra", type }), /16 KiB/);
    const reopened = new ChannelLists(a);
    assert.deepEqual(reopened.read("big"), firstPage, "failed schema changes preserve columns and earlier rows");
    assert.deepEqual(reopened.read("big", 50), lastPage, "failed schema changes preserve values and timestamps");
    reopened.mutate({ op: "update_item", list: "big", id, values: { completed: true } });
    reopened.mutate({ op: "update_item", list: "big", id, values: { completed: false } });
    // Free exactly the new key/null's canonical byte cost; adding the column must now succeed.
    const extraBytes = Buffer.byteLength(JSON.stringify({ ...editable, extra: null })) - 16 * 1024;
    reopened.mutate({ op: "update_item", list: "big", id, values: { c2: values.c2.slice(extraBytes) } });
    reopened.mutate({ op: "add_column", list: "big", column: "extra", type });
    const item = reopened.read("big", 55).items![0]!;
    const { id: _newId, created_at: _newCreated, updated_at: _newUpdated, ...newEditable } = item;
    assert.equal(Buffer.byteLength(JSON.stringify(newEditable)), 16 * 1024);
    assert.equal(item.extra, null);
    reopened.mutate({ op: "update_item", list: "big", id, values: { completed: true } });
    reopened.mutate({ op: "update_item", list: "big", id, values: { completed: false } });
    assert.deepEqual(reopened.read("big", 55).items![0]!.c2, values.c2.slice(extraBytes));
    assert.equal(reopened.read("big", 55).items![0]!.completed, false);
  });
}

test("large items and read output have byte bounds without losing pagination", (t) => {
  const { store } = fixture(t); store.mutate({ op: "create", list: "big" });
  for (let i = 0; i < 5; i++) store.mutate({ op: "add_column", list: "big", column: "c" + i, type: "text" });
  const values = { title: "x".repeat(4000), notes: "x".repeat(4000), c0: "x".repeat(4000) };
  for (let i = 0; i < 10; i++) store.mutate({ op: "add_item", list: "big", values });
  const page = store.read("big"); assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 64 * 1024);
  assert.ok(page.nextOffset! > 0 && page.nextOffset! < 10);
  const rest = store.read("big", page.nextOffset); assert.equal(page.items!.length + rest.items!.length, 10);
  assert.throws(() => store.mutate({ op: "update_item", list: "big", id: 1, values: { c1: "x".repeat(4000), c2: "x".repeat(4000) } }), /16 KiB/);
  assert.equal(store.read("big").items![0]!.c1, null);
});
