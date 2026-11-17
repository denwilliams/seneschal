/**
 * The channel state object: one JSON object per channel that the agent (and later jobs) can read and update, shared by
 * every thread and subagent run in the channel. This file is the pure part: addressing, the four operations and the
 * limits. The durable part (atomic commits, the revision counter) is in `channel-store.ts`.
 *
 * It is different from memory on purpose. Memory is prose the model recalls. State is structured working data that code
 * also reads and writes: cursors, counters, the last result of a job, a checklist.
 */

export type StateOp = "set" | "merge" | "delete" | "append";
export const STATE_OPS: readonly StateOp[] = ["set", "merge", "delete", "append"];

export type StateJson = null | boolean | number | string | StateJson[] | { [key: string]: StateJson };
export type StateObject = { [key: string]: StateJson };

export const STATE_LIMITS = {
  /** Serialized size of the whole object. */
  bytes: 65_536,
  depth: 12,
  arrayItems: 1_000,
  keyChars: 128,
  stringChars: 16_384,
  /** Recent changes kept next to the value, for audit and the console. */
  changeLog: 50,
} as const;

export type StateErrorCode = "invalid_path" | "invalid_value" | "too_large" | "conflict" | "type_mismatch";

export class StateError extends Error {
  readonly code: StateErrorCode;
  /** For a `conflict`: the revision the object is at now, so the caller can read and retry. */
  readonly currentRev?: number;
  constructor(code: StateErrorCode, message: string, currentRev?: number) {
    super(message);
    this.name = "StateError";
    this.code = code;
    if (currentRev !== undefined) this.currentRev = currentRev;
  }
}

/** Keys that could reach an object's prototype. Refused in paths and anywhere in a value, so none can ever be assigned. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Split a JSON Pointer (RFC 6901) into its segments. The empty string is the root. Every segment must be a non-empty key of
 * a sane length that cannot reach a prototype.
 */
export function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new StateError("invalid_path", `Path "${path.slice(0, 60)}" must be a JSON Pointer: empty for the whole object, or starting with "/" like "/jobs/last/status".`);
  return path.slice(1).split("/").map((raw) => {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (segment === "") throw new StateError("invalid_path", `Path "${path.slice(0, 60)}" has an empty segment.`);
    if (segment.length > STATE_LIMITS.keyChars) throw new StateError("invalid_path", `A path segment is longer than ${STATE_LIMITS.keyChars} characters.`);
    if (FORBIDDEN_KEYS.has(segment)) throw new StateError("invalid_path", `"${segment}" cannot be used as a key.`);
    return segment;
  });
}

export function toPointer(segments: readonly string[]): string {
  return segments.map((segment) => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

const isObject = (value: unknown): value is StateObject => typeof value === "object" && value !== null && !Array.isArray(value);
const INDEX = /^(0|[1-9]\d*)$/;

/**
 * Check a value is plain JSON within the limits: finite numbers, strings and keys of bounded length, no forbidden keys, depth
 * and array length capped. Anything else (undefined, functions, class instances, NaN) is refused, never coerced.
 */
export function assertJsonValue(value: unknown, where = "value", depth = 1): asserts value is StateJson {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StateError("invalid_value", `${where} contains a number that is not finite.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > STATE_LIMITS.stringChars) throw new StateError("too_large", `${where} contains a string longer than ${STATE_LIMITS.stringChars} characters.`);
    return;
  }
  if (depth > STATE_LIMITS.depth) throw new StateError("too_large", `${where} is nested deeper than ${STATE_LIMITS.depth} levels.`);
  if (Array.isArray(value)) {
    if (value.length > STATE_LIMITS.arrayItems) throw new StateError("too_large", `${where} contains an array of more than ${STATE_LIMITS.arrayItems} items.`);
    for (const item of value) assertJsonValue(item, where, depth + 1);
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.length > STATE_LIMITS.keyChars) throw new StateError("too_large", `${where} contains a key longer than ${STATE_LIMITS.keyChars} characters.`);
      if (FORBIDDEN_KEYS.has(key)) throw new StateError("invalid_value", `${where} contains the key "${key}", which cannot be used.`);
      assertJsonValue(item, where, depth + 1);
    }
    return;
  }
  throw new StateError("invalid_value", `${where} must be plain JSON (objects, arrays, strings, finite numbers, booleans, null).`);
}

export function stateBytes(value: StateJson): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** A deep copy that shares nothing with the original, and is plain JSON. */
export function cloneState<T extends StateJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface StateRead {
  found: boolean;
  value?: StateJson;
}

/** The value at a path, or `found: false` when nothing is there. */
export function readPath(root: StateObject, segments: readonly string[]): StateRead {
  let current: StateJson = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!INDEX.test(segment) || Number(segment) >= current.length) return { found: false };
      current = current[Number(segment)]!;
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = current[segment]!;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

type Container = StateObject | StateJson[];

/**
 * Walk to the container that holds the last segment, creating plain objects for missing keys on the way. Refuses to walk
 * through a value that is not a container, and never creates array slots.
 */
function parentOf(root: StateObject, segments: readonly string[], create: boolean, path: string): Container | undefined {
  let current: Container = root;
  for (const segment of segments.slice(0, -1)) {
    let next: StateJson | undefined;
    if (Array.isArray(current)) {
      if (!INDEX.test(segment) || Number(segment) >= current.length) {
        throw new StateError("type_mismatch", `Path "${path}" goes through array index "${segment}", which does not exist.`);
      }
      next = current[Number(segment)];
    } else {
      next = Object.hasOwn(current, segment) ? current[segment] : undefined;
      if (next === undefined) {
        if (!create) return undefined;
        const made: StateObject = {};
        current[segment] = made;
        next = made;
      }
    }
    if (typeof next !== "object" || next === null) {
      throw new StateError("type_mismatch", `Path "${path}" goes through "${segment}", which holds a ${next === null ? "null" : typeof next}, not an object or array.`);
    }
    current = next as Container;
  }
  return current;
}

function setIn(container: Container, key: string, value: StateJson, path: string): void {
  if (Array.isArray(container)) {
    if (!INDEX.test(key) || Number(key) > container.length) {
      throw new StateError("type_mismatch", `Path "${path}" names array index "${key}", but the array has ${container.length} item(s): use an existing index, or the "append" operation.`);
    }
    container[Number(key)] = value;
  } else {
    container[key] = value;
  }
}

export interface StateChangeInput {
  op: StateOp;
  path: string;
  value?: StateJson;
}

/**
 * Apply one operation to a copy of `root`. Returns the new root and whether anything changed (an update that leaves the
 * object as it was does not advance the revision). The result is checked against every limit; on any error the input is
 * untouched.
 *
 * - `set` writes a value at a path, creating missing objects on the way. The empty path replaces the whole object, which
 *   must stay an object.
 * - `merge` copies the keys of an object onto the object at the path (created if missing), one level deep.
 * - `delete` removes a key or array item; removing something that is not there changes nothing.
 * - `append` adds a value to the end of the array at the path (created if missing).
 */
export function applyOp(root: StateObject, input: StateChangeInput): { root: StateObject; changed: boolean } {
  const segments = parsePointer(input.path);
  const next = cloneState(root);
  const needsValue = input.op !== "delete";
  if (needsValue && input.value === undefined) throw new StateError("invalid_value", `The "${input.op}" operation needs a value.`);
  if (needsValue) assertJsonValue(input.value, "The value");
  const value = input.value as StateJson;
  let result: StateObject = next;

  switch (input.op) {
    case "set": {
      if (segments.length === 0) {
        if (!isObject(value)) throw new StateError("type_mismatch", "The whole state must be an object: set the empty path to an object, or set a path inside it.");
        result = cloneState(value);
      } else {
        const parent = parentOf(next, segments, true, input.path)!;
        setIn(parent, segments.at(-1)!, cloneState(value), input.path);
      }
      break;
    }
    case "merge": {
      if (!isObject(value)) throw new StateError("type_mismatch", 'The "merge" operation needs an object value.');
      let target: StateJson | undefined;
      if (segments.length === 0) target = next;
      else {
        const parent = parentOf(next, segments, true, input.path)!;
        const key = segments.at(-1)!;
        if (Array.isArray(parent)) {
          target = INDEX.test(key) ? parent[Number(key)] : undefined;
          if (target === undefined) throw new StateError("type_mismatch", `Path "${input.path}" names an array index that does not exist.`);
        } else {
          target = Object.hasOwn(parent, key) ? parent[key] : undefined;
          if (target === undefined) { target = {}; parent[key] = target; }
        }
      }
      if (!isObject(target)) throw new StateError("type_mismatch", `Path "${input.path}" holds a value that is not an object, so nothing can be merged into it.`);
      for (const [key, item] of Object.entries(value)) target[key] = cloneState(item);
      break;
    }
    case "delete": {
      if (segments.length === 0) throw new StateError("invalid_path", 'The whole state cannot be deleted: use "set" with the empty path and {} to clear it.');
      const parent = parentOf(next, segments, false, input.path);
      if (!parent) return { root, changed: false };
      const key = segments.at(-1)!;
      if (Array.isArray(parent)) {
        if (!INDEX.test(key) || Number(key) >= parent.length) return { root, changed: false };
        parent.splice(Number(key), 1);
      } else {
        if (!Object.hasOwn(parent, key)) return { root, changed: false };
        delete parent[key];
      }
      break;
    }
    case "append": {
      if (segments.length === 0) throw new StateError("invalid_path", 'The whole state is an object, so there is nothing to "append" to: name an array path.');
      const parent = parentOf(next, segments, true, input.path)!;
      const key = segments.at(-1)!;
      let target: StateJson | undefined;
      if (Array.isArray(parent)) {
        target = INDEX.test(key) ? parent[Number(key)] : undefined;
        if (target === undefined) throw new StateError("type_mismatch", `Path "${input.path}" names an array index that does not exist.`);
      } else {
        target = Object.hasOwn(parent, key) ? parent[key] : undefined;
        if (target === undefined) { target = []; parent[key] = target; }
      }
      if (!Array.isArray(target)) throw new StateError("type_mismatch", `Path "${input.path}" holds a value that is not an array, so nothing can be appended to it.`);
      target.push(cloneState(value));
      break;
    }
  }

  // The result is what is stored, so it is what the limits apply to.
  assertJsonValue(result, "The state");
  if (stateBytes(result) > STATE_LIMITS.bytes) {
    throw new StateError("too_large", `The state would be ${stateBytes(result)} bytes; the limit is ${STATE_LIMITS.bytes}. Remove something first.`);
  }
  const changed = JSON.stringify(result) !== JSON.stringify(root);
  return { root: changed ? result : root, changed };
}

/** Top-level keys with a rough size each, for describing an object too large to show whole. */
export function describeState(root: StateObject): { key: string; type: string; bytes: number }[] {
  return Object.entries(root).map(([key, value]) => ({
    key, bytes: stateBytes(value),
    type: Array.isArray(value) ? `array(${value.length})` : value === null ? "null" : typeof value,
  }));
}
