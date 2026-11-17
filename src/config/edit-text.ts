import { Document, isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify, visit, type Pair, type YAMLMap } from "yaml";

/**
 * Change a YAML file by editing its TEXT, not by parsing it and writing it back.
 *
 * A hand-kept config is full of things a parse-and-reserialise throws away or rewrites: comments (including commented-out
 * examples), the way a list is laid out (`[read, write]`, not `[ read, write ]`), the spacing before a trailing comment,
 * quoting, blank lines. This replaces only the lines of the one setting being changed and leaves every other byte of the
 * file exactly as it was. The parse is used to FIND the setting and to check the result, never to produce the file.
 *
 * It handles the shapes a config actually has: replace a value, add a key to a map (or under a key that is empty but for
 * comments), add a whole new section, remove a key. It refuses what it cannot do exactly (descending into a list, aliases,
 * root flow maps such as JSON) rather than guess. The caller checks the patched file means what was intended before it is used.
 */

export interface TextEdit {
  /** Keys from the top of the file down. Never indexes into a list: set the whole list. */
  path: string[];
  value?: unknown;
  remove?: boolean;
}

export class PatchError extends Error {
  constructor(message: string) { super(message); this.name = "PatchError"; }
}

const lineStart = (text: string, pos: number): number => text.lastIndexOf("\n", pos - 1) + 1;
function lineEnd(text: string, pos: number): number {
  const at = text.indexOf("\n", pos);
  const end = at < 0 ? text.length : at;
  return end > 0 && text[end - 1] === "\r" ? end - 1 : end;
}

/** One level of indentation as this file uses it: the smallest indent it ever steps by, two spaces if it never does. */
function indentUnit(text: string): number {
  let best = Infinity;
  for (const match of text.matchAll(/^( +)\S/gm)) best = Math.min(best, match[1]!.length);
  return Number.isFinite(best) && best > 0 && best <= 8 ? best : 2;
}

const keyText = (pair: Pair): string => {
  const key = pair.key;
  return isScalar(key) ? String(key.value) : String(key);
};

/** The tree with one setting changed. Used both to plan a patch around a flow map and to say what the result must be. */
export function applyToTree(tree: unknown, path: string[], value: unknown, remove: boolean): unknown {
  if (path.length === 0) return remove ? undefined : value;
  const base = tree !== null && typeof tree === "object" && !Array.isArray(tree) ? { ...(tree as Record<string, unknown>) } : {};
  const [head, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) {
    if (remove) delete base[head];
    else base[head] = value;
  } else {
    base[head] = applyToTree(base[head], rest, value, remove);
  }
  return base;
}

interface Located {
  /** The map the last found key lives in, and the pair itself. */
  found: { map: YAMLMap; pair: Pair }[];
  /** How many leading path keys exist as pairs. */
  depth: number;
  /** A flow-style map on the way down: edits through it replace the whole pair that holds it. */
  flow?: { pair: Pair; depth: number };
}

function locate(doc: Document, path: string[]): Located {
  const located: Located = { found: [], depth: 0 };
  let node: unknown = doc.contents;
  for (let i = 0; i < path.length; i++) {
    if (isSeq(node)) throw new PatchError(`"${path.slice(0, i).join(".")}" is a list; set or remove the whole list instead of one item of it`);
    if (!isMap(node)) break;
    const pair = node.items.find((p) => keyText(p) === path[i]);
    if (!pair) break;
    located.found.push({ map: node, pair });
    located.depth = i + 1;
    node = pair.value;
    // A flow map ({ a: 1 }) cannot take a new line inside it; changing anything within one rewrites the pair that holds it.
    if (isMap(node) && node.flow && i + 1 < path.length && !located.flow) located.flow = { pair, depth: i + 1 };
  }
  return located;
}

interface Region { start: number; end: number; indent: string }

/** The whole lines a pair occupies, from the start of its key's line to the end of its value's last line. */
function regionOf(text: string, pair: Pair): Region {
  const key = pair.key as { range?: [number, number, number] };
  if (!key.range) throw new PatchError("cannot find where this setting is in the file");
  const start = lineStart(text, key.range[0]);
  const value = pair.value as { range?: [number, number, number] } | null;
  const valueEnd = value?.range && value.range[1] > value.range[0] ? value.range[1] : key.range[1];
  const end = lineEnd(text, Math.max(valueEnd - 1, key.range[1]));
  return { start, end, indent: text.slice(start, key.range[0]) };
}

/** A comment trailing the pair's first line, so replacing the value does not lose it. */
function trailingComment(text: string, pair: Pair): string {
  const key = pair.key as { range: [number, number, number] };
  const value = pair.value as { range?: [number, number, number]; type?: string } | null;
  const blockScalar = isScalar(pair.value) && (pair.value.type === "BLOCK_LITERAL" || pair.value.type === "BLOCK_FOLDED");
  if (blockScalar) return "";
  const sameLine = value?.range && value.range[1] > value.range[0] && lineStart(text, value.range[0]) === lineStart(text, key.range[0]);
  const after = sameLine
    ? text.slice(value!.range![1], lineEnd(text, value!.range![1]))
    : text.slice(text.indexOf(":", key.range[1]) + 1, lineEnd(text, key.range[1]));
  return /^\s*#/.test(after) ? after.replace(/\s+$/, "") : "";
}

/** The text of `key: value` at an indent, in the style this file uses: short lists of plain values on one line, the rest as blocks. */
function renderPair(keySource: string, value: unknown, indent: string, unit: number, comment: string, eol: string): string {
  const doc = new Document({ __K__: value });
  visit(doc, { Seq(_key, node) { if (node.items.every((item) => isScalar(item))) node.flow = true; } });
  const lines = doc.toString({ indent: unit, lineWidth: 0, flowCollectionPadding: false }).replace(/\s+$/, "").split("\n");
  lines[0] = lines[0]!.replace("__K__", keySource);
  if (comment) lines[0] += comment;
  return lines.map((line) => (line ? indent + line : line)).join(eol);
}

const keySourceOf = (text: string, pair: Pair): string => {
  const key = pair.key as { range: [number, number, number] };
  return text.slice(key.range[0], key.range[1]);
};

/** A key as it must be written when it is new: quoted when plain YAML would read it as something else. */
function newKeySource(key: string): string {
  const out = stringify({ [key]: 0 });
  return out.slice(0, out.lastIndexOf(": 0"));
}

function patchOne(text: string, edit: TextEdit): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new PatchError(`the file does not parse as YAML (${doc.errors[0]!.message})`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = indentUnit(text);
  const { path } = edit;
  if (path.length === 0) throw new PatchError("an edit needs a path");
  // Nested flow maps can replace their enclosing pair with a block. The root has no enclosing pair,
  // so line-based replacements or insertions would put block YAML inside its flow delimiters.
  if (isMap(doc.contents) && doc.contents.flow) {
    throw new PatchError("the document root is a flow map (for example, JSON); convert it to block-style YAML before editing");
  }
  const located = locate(doc, path);

  // Through a flow map: rewrite the pair that holds it, with the change applied inside.
  if (located.flow) {
    const { pair, depth } = located.flow;
    const current = (pair.value as { toJS: (d: Document) => unknown }).toJS(doc);
    const merged = applyToTree(current, path.slice(depth), edit.value, edit.remove === true);
    return replacePair(text, pair, merged, unit, eol);
  }

  if (edit.remove) {
    if (located.depth !== path.length) return text; // nothing there to remove
    const { pair } = located.found[located.depth - 1]!;
    const region = regionOf(text, pair);
    const next = region.end < text.length ? region.end + (text.startsWith("\r\n", region.end) ? 2 : 1) : region.end;
    return text.slice(0, region.start) + text.slice(next);
  }

  if (located.depth === path.length) return replacePair(text, located.found[located.depth - 1]!.pair, edit.value, unit, eol);

  // Add: the first key that does not exist yet, with the rest of the path (if any) as nested maps under it.
  const missing = path[located.depth]!;
  const nested = path.slice(located.depth + 1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), edit.value);
  const keySource = newKeySource(missing);

  if (located.depth === 0) {
    const root = doc.contents;
    if (!isMap(root) || root.items.length === 0) {
      const body = renderPair(keySource, nested, "", unit, "", eol);
      const base = text.replace(/\s+$/, "");
      return (base ? `${base}${eol}${eol}` : "") + body + eol;
    }
    return insertAfterLast(text, root, keySource, nested, unit, eol, true);
  }

  const { pair: parentPair } = located.found[located.depth - 1]!;
  const parent = parentPair.value;
  if (isMap(parent) && parent.items.length > 0) return insertAfterLast(text, parent, keySource, nested, unit, eol, false);
  if (parent === null || parent === undefined || (isScalar(parent) && (parent.value === null || parent.value === undefined)) || (isMap(parent) && parent.items.length === 0 && !parent.flow)) {
    // `connectors:` with nothing under it but comments: the new entry goes straight under the key.
    const region = regionOf(text, parentPair);
    const childIndent = " ".repeat(region.indent.length + unit);
    const at = lineEnd(text, (parentPair.key as { range: [number, number, number] }).range[1]);
    return text.slice(0, at) + eol + renderPair(keySource, nested, childIndent, unit, "", eol) + text.slice(at);
  }
  if (isMap(parent) && parent.flow) throw new PatchError("internal: flow map not redirected");
  throw new PatchError(`"${path.slice(0, located.depth).join(".")}" holds a value that is not a map, so nothing can be added under it`);
}

function insertAfterLast(text: string, map: YAMLMap, keySource: string, value: unknown, unit: number, eol: string, blankLineBefore: boolean): string {
  const first = map.items[0]!.key as { range: [number, number, number] };
  const indent = text.slice(lineStart(text, first.range[0]), first.range[0]);
  const last = map.items[map.items.length - 1]!;
  const at = regionOf(text, last).end;
  const pair = renderPair(keySource, value, indent, unit, "", eol);
  return text.slice(0, at) + eol + (blankLineBefore ? eol : "") + pair + text.slice(at);
}

function replacePair(text: string, pair: Pair, value: unknown, unit: number, eol: string): string {
  const region = regionOf(text, pair);
  const rendered = renderPair(keySourceOf(text, pair), value, region.indent, unit, trailingComment(text, pair), eol);
  return text.slice(0, region.start) + rendered + text.slice(region.end);
}

/** Apply edits in order, each against the text the one before produced. */
export function patchText(text: string, edits: TextEdit[]): string {
  let current = text;
  for (const edit of edits) current = patchOne(current, edit);
  return current;
}

/** What the file must mean after the edits, computed on the parsed tree with no text involved. */
export function expectedTree(text: string, edits: TextEdit[]): unknown {
  let tree: unknown = parseYaml(text) ?? {};
  for (const edit of edits) tree = applyToTree(tree, edit.path, edit.value, edit.remove === true);
  return tree;
}

/** YAML reads a key with nothing under it as null, and a section with every entry removed as an empty map: the same thing here. */
export function normalizeTree(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalizeTree);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeTree(v)] as const);
    return entries.length === 0 ? null : Object.fromEntries(entries);
  }
  return value;
}

