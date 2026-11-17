import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOp, assertJsonValue, describeState, parsePointer, readPath, StateError, STATE_LIMITS, stateBytes, toPointer,
  type StateObject,
} from "./state.ts";

const fails = (fn: () => unknown, code: string, pattern?: RegExp) =>
  assert.throws(fn, (error: unknown) => error instanceof StateError && error.code === code && (!pattern || pattern.test(error.message)), `expected a ${code} error`);

test("pointers: the root, nested keys, escapes, and refusals", () => {
  assert.deepEqual(parsePointer(""), []);
  assert.deepEqual(parsePointer("/a/b/0"), ["a", "b", "0"]);
  assert.deepEqual(parsePointer("/a~1b/c~0d"), ["a/b", "c~d"]);
  assert.equal(toPointer(["a/b", "c~d"]), "/a~1b/c~0d");
  fails(() => parsePointer("jobs/last"), "invalid_path", /JSON Pointer/);
  fails(() => parsePointer("/a//b"), "invalid_path", /empty segment/);
  fails(() => parsePointer("/"), "invalid_path");
  fails(() => parsePointer(`/${"k".repeat(STATE_LIMITS.keyChars + 1)}`), "invalid_path");
});

test("pointers: keys that reach a prototype are refused, in any spelling", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    fails(() => parsePointer(`/${key}`), "invalid_path");
    fails(() => parsePointer(`/safe/${key}/x`), "invalid_path");
  }
});

test("values: plain JSON only, within the limits", () => {
  assertJsonValue({ a: [1, "two", null, true, { b: 1.5 }] });
  fails(() => assertJsonValue(undefined), "invalid_value");
  fails(() => assertJsonValue(() => 1), "invalid_value");
  fails(() => assertJsonValue({ d: new Date() }), "invalid_value");
  fails(() => assertJsonValue(Number.NaN), "invalid_value", /not finite/);
  fails(() => assertJsonValue(Infinity), "invalid_value");
  fails(() => assertJsonValue({ a: undefined }), "invalid_value");
  fails(() => assertJsonValue("x".repeat(STATE_LIMITS.stringChars + 1)), "too_large");
  fails(() => assertJsonValue(Array.from({ length: STATE_LIMITS.arrayItems + 1 }, () => 0)), "too_large");
  fails(() => assertJsonValue({ [`k${"x".repeat(STATE_LIMITS.keyChars)}`]: 1 }), "too_large");
  let deep: unknown = 1;
  for (let i = 0; i < STATE_LIMITS.depth + 1; i++) deep = { n: deep };
  fails(() => assertJsonValue(deep), "too_large", /deeper/);
  let ok: unknown = 1;
  for (let i = 0; i < STATE_LIMITS.depth - 1; i++) ok = { n: ok };
  assertJsonValue(ok);
});

test("values: a forbidden key anywhere inside is refused, even one JSON.parse makes", () => {
  fails(() => assertJsonValue(JSON.parse('{"__proto__": {"polluted": true}}')), "invalid_value", /__proto__/);
  fails(() => assertJsonValue({ nested: [{ constructor: 1 }] }), "invalid_value");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("set: writes at a path, creating objects on the way, and the empty path replaces the object", () => {
  const empty: StateObject = {};
  const one = applyOp(empty, { op: "set", path: "/jobs/last/status", value: "ok" });
  assert.deepEqual(one.root, { jobs: { last: { status: "ok" } } });
  assert.equal(one.changed, true);
  assert.deepEqual(empty, {}, "the input is never touched");
  const replaced = applyOp(one.root, { op: "set", path: "", value: { fresh: true } });
  assert.deepEqual(replaced.root, { fresh: true });
  fails(() => applyOp(one.root, { op: "set", path: "", value: [1] }), "type_mismatch", /must be an object/);
  fails(() => applyOp(one.root, { op: "set", path: "", value: "x" }), "type_mismatch");
});

test("set: array items are replaced by index; the next index appends; beyond is refused", () => {
  const base: StateObject = { items: ["a", "b"] };
  assert.deepEqual(applyOp(base, { op: "set", path: "/items/1", value: "B" }).root, { items: ["a", "B"] });
  assert.deepEqual(applyOp(base, { op: "set", path: "/items/2", value: "c" }).root, { items: ["a", "b", "c"] });
  fails(() => applyOp(base, { op: "set", path: "/items/5", value: "x" }), "type_mismatch", /append/);
  fails(() => applyOp(base, { op: "set", path: "/items/-", value: "x" }), "type_mismatch");
  fails(() => applyOp(base, { op: "set", path: "/items/9/x", value: 1 }), "type_mismatch", /does not exist/);
});

test("set: it will not walk through a value that is not a container", () => {
  fails(() => applyOp({ a: "text" }, { op: "set", path: "/a/b", value: 1 }), "type_mismatch", /not an object or array/);
  fails(() => applyOp({ a: null }, { op: "set", path: "/a/b", value: 1 }), "type_mismatch", /null/);
});

test("set: an update that changes nothing reports changed: false and returns the same object", () => {
  const base: StateObject = { a: 1 };
  const result = applyOp(base, { op: "set", path: "/a", value: 1 });
  assert.equal(result.changed, false);
  assert.equal(result.root, base);
});

test("merge: copies keys one level deep, creating the target", () => {
  const base: StateObject = { cfg: { a: 1, nested: { x: 1 } } };
  const merged = applyOp(base, { op: "merge", path: "/cfg", value: { b: 2, nested: { y: 2 } } });
  assert.deepEqual(merged.root, { cfg: { a: 1, nested: { y: 2 }, b: 2 } }, "one level: a nested object is replaced, not merged");
  assert.deepEqual(applyOp({}, { op: "merge", path: "/new/spot", value: { a: 1 } }).root, { new: { spot: { a: 1 } } });
  assert.deepEqual(applyOp({ a: 1 }, { op: "merge", path: "", value: { b: 2 } }).root, { a: 1, b: 2 });
  fails(() => applyOp(base, { op: "merge", path: "/cfg", value: [1] }), "type_mismatch", /object value/);
  fails(() => applyOp({ n: 5 }, { op: "merge", path: "/n", value: { a: 1 } }), "type_mismatch", /not an object/);
});

test("delete: removes a key or an item; a missing target is a quiet no-op; the root cannot be deleted", () => {
  const base: StateObject = { a: 1, list: ["x", "y", "z"], deep: { k: 1 } };
  assert.deepEqual(applyOp(base, { op: "delete", path: "/a" }).root, { list: ["x", "y", "z"], deep: { k: 1 } });
  assert.deepEqual(applyOp(base, { op: "delete", path: "/list/1" }).root, { a: 1, list: ["x", "z"], deep: { k: 1 } });
  for (const path of ["/missing", "/deep/missing/more", "/list/9", "/list/x"]) {
    const result = applyOp(base, { op: "delete", path });
    assert.equal(result.changed, false, path);
    assert.equal(result.root, base);
  }
  fails(() => applyOp(base, { op: "delete", path: "" }), "invalid_path", /set.*\{\}/);
});

test("append: adds to an array, creating it; refuses a non-array and the root", () => {
  assert.deepEqual(applyOp({}, { op: "append", path: "/log", value: "one" }).root, { log: ["one"] });
  assert.deepEqual(applyOp({ log: ["one"] }, { op: "append", path: "/log", value: { n: 2 } }).root, { log: ["one", { n: 2 }] });
  fails(() => applyOp({ log: "text" }, { op: "append", path: "/log", value: 1 }), "type_mismatch", /not an array/);
  fails(() => applyOp({}, { op: "append", path: "", value: 1 }), "invalid_path");
});

test("operations need a value where one is meant, and validate it", () => {
  fails(() => applyOp({}, { op: "set", path: "/a" }), "invalid_value", /needs a value/);
  fails(() => applyOp({}, { op: "append", path: "/a" }), "invalid_value");
  fails(() => applyOp({}, { op: "set", path: "/a", value: JSON.parse('{"__proto__":1}') }), "invalid_value");
  applyOp({ a: 1 }, { op: "delete", path: "/a" });
});

test("limits apply to what would be stored, and a failed update leaves the input alone", () => {
  const big: StateObject = {};
  for (let i = 0; i < 4; i++) big[`k${i}`] = "x".repeat(STATE_LIMITS.stringChars - 100);
  assert.ok(stateBytes(big) < STATE_LIMITS.bytes, "four large strings still fit");
  fails(() => applyOp(big, { op: "set", path: "/k4", value: "y".repeat(STATE_LIMITS.stringChars - 100) }), "too_large", /limit is 65536/);
  assert.equal(Object.keys(big).length, 4, "the input is untouched after a refused update");
  const nearlyDeep: StateObject = {};
  let cursor: StateObject = nearlyDeep;
  for (let i = 0; i < STATE_LIMITS.depth - 2; i++) { const inner: StateObject = {}; cursor.n = inner; cursor = inner; }
  fails(() => applyOp(nearlyDeep, { op: "set", path: `/${Array.from({ length: STATE_LIMITS.depth - 2 }, () => "n").join("/")}/extra`, value: { a: { b: { c: 1 } } } }), "too_large", /deeper/);
});

test("prototype pollution is not possible through any operation", () => {
  for (const op of ["set", "merge", "append"] as const) {
    fails(() => applyOp({}, { op, path: "/__proto__/polluted", value: op === "merge" ? { x: 1 } : op === "append" ? 1 : true }), "invalid_path");
  }
  fails(() => applyOp({}, { op: "merge", path: "", value: JSON.parse('{"__proto__": {"polluted": true}}') }), "invalid_value");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(applyOp({}, { op: "set", path: "/a", value: 1 }).root), Object.prototype);
});

test("reading a path: found, not found, and through arrays", () => {
  const root: StateObject = { a: { b: [10, { c: "deep" }] }, z: null };
  assert.deepEqual(readPath(root, []), { found: true, value: root });
  assert.deepEqual(readPath(root, ["a", "b", "1", "c"]), { found: true, value: "deep" });
  assert.deepEqual(readPath(root, ["z"]), { found: true, value: null });
  for (const segments of [["nope"], ["a", "b", "9"], ["a", "b", "x"], ["a", "b", "0", "deeper"], ["toString"]]) {
    assert.equal(readPath(root, segments).found, false, segments.join("/"));
  }
});

test("describing a large state lists its top-level keys with sizes", () => {
  assert.deepEqual(describeState({ list: [1, 2], text: "hi", none: null, n: 3 }).map((e) => [e.key, e.type]), [["list", "array(2)"], ["text", "string"], ["none", "null"], ["n", "number"]]);
});
