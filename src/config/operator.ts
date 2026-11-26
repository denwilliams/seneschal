import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Document, isMap, isNode, isScalar, parse as parseYaml, parseDocument } from "yaml";
import { parseConfigText } from "./load.ts";
import { RecentConversationsSchema } from "./schema.ts";
import { assertWritable, audit, backUp, replaceAtomically, serialised, type ReloadResult } from "./edit.ts";
import { expectedTree, normalizeTree, patchText, type TextEdit } from "./edit-text.ts";

/** Deliberately NOT the agent edit API: this is equivalent to editing the file on the host. */
export interface OperatorConfig {
  configPath: string;
  dataDir: string;
  reload?: () => Promise<ReloadResult>;
}
export class OperatorConfigError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
/** Loader diagnostics can quote expanded cross-reference values; never send those environment values to a browser. */
export function safeConfigMessage(text: string, message: string): string {
  const names = new Set<string>();
  const scan = (value: string) => { for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/gi)) names.add(match[1]!); };
  scan(text);
  try {
    // Match the loader's YAML decoding (including escaped dollars, braces and names).
    // Walk values, not expanded runtime config; aliases may share or cycle objects.
    const pending: unknown[] = [parseYaml(text)];
    const seen = new Set<object>();
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === "string") scan(value);
      else if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        for (const child of Object.values(value)) pending.push(child);
      }
    }
  } catch { /* Malformed YAML never reaches expansion; retain raw-reference scrubbing. */ }
  const references = [...names].map((name) => ({ name, value: process.env[name] }))
    .filter((entry): entry is { name: string; value: string } => !!entry.value).sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of references) message = message.split(value).join("$" + "{" + name + "}");
  return message;
}
export function validateOperatorConfig(text: string): void {
  try { parseConfigText(text, "edited config"); }
  catch (error) { throw new OperatorConfigError(422, safeConfigMessage(text, error instanceof Error ? error.message : "Invalid configuration.")); }
}
export const configRevision = (text: string): string => createHash("sha256").update(text).digest("hex");
export function readOperatorConfig(service: OperatorConfig) {
  const text = readFileSync(service.configPath, "utf8");
  // No runtime config, environment expansion or credential store is ever returned.
  return { text, revision: configRevision(text) };
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function hasPath(tree: unknown, path: string[]): boolean {
  return path.length === 0 || record(tree) && Object.hasOwn(tree, path[0]!) && hasPath(tree[path[0]!], path.slice(1));
}
/** Match scheduled-task runtime validation without expanding configuration references. */
function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.length) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
  catch { return false; }
}
const fields = ["model", "thinkingLevel", "description", "preferences"] as const;
const recentDefaults = RecentConversationsSchema.parse({});
const recentFields = Object.keys(recentDefaults);
function validRecentValue(key: string, value: unknown): boolean {
  return recentFields.includes(key) && value !== undefined && RecentConversationsSchema.safeParse({ [key]: value }).success;
}
function values(v: unknown) {
  const data = record(v) ? v : {};
  const recent = data.recentConversations;
  const entries = Object.fromEntries(recentFields.flatMap((key) => record(recent) && Object.hasOwn(recent, key) ? [[key, recent[key]]] : []));
  return {
    ...Object.fromEntries(fields.flatMap((k) => typeof data[k] === "string" ? [[k, data[k] as string]] : [])) as Partial<Record<(typeof fields)[number], string>>,
    recentConversations: { basic: recent == null || record(recent), values: entries,
      unsupported: Object.keys(entries).filter((key) => !validRecentValue(key, entries[key])) },
  };
}
/** Match parsed object/string path identities, as the text patcher does (YAML keys may be numeric). */
function nodeAtStringPath(doc: Document, path: string[]): unknown {
  let node: unknown = doc.contents;
  for (const key of path) {
    if (!isMap(node)) return undefined;
    node = node.items.find((pair) => (isScalar(pair.key) ? String(pair.key.value) : String(pair.key)) === key)?.value;
  }
  return node;
}

/** Inspection does not require a valid schema, so an operator can fix invalid settings in either mode. */
export function inspectOperatorConfig(text: string) {
  const raw: unknown = parseYaml(text) ?? {};
  if (!record(raw)) throw new OperatorConfigError(422, "The YAML root must be a mapping.");
  if (raw.channels != null && !record(raw.channels)) throw new OperatorConfigError(422, "channels must be a mapping; fix it in raw YAML.");
  if (raw.connectors != null && !record(raw.connectors)) throw new OperatorConfigError(422, "connectors must be a mapping; fix it in raw YAML.");
  const doc = parseDocument(text);
  return {
    connectors: Object.entries(record(raw.connectors) ? raw.connectors : {}).map(([key, value]) => {
      const data = record(value) ? value : {};
      const node = nodeAtStringPath(doc, ["connectors", key]);
      const fragment = new Document();
      fragment.contents = isNode(node) ? node.clone() as Document["contents"] : fragment.createNode(value);
      const strings = (v: unknown): v is Record<string, string> => record(v) && Object.values(v).every((x) => typeof x === "string");
      const args = Array.isArray(data.args) && data.args.every((x) => typeof x === "string") ? data.args as string[] : undefined;
      return { key, yaml: fragment.toString({ verifyAliasOrder: false }), transport: typeof data.transport === "string" ? data.transport : "",
        command: typeof data.command === "string" ? data.command : "", url: typeof data.url === "string" ? data.url : "",
        args: args ?? [], env: strings(data.env) ? data.env : {}, headers: strings(data.headers) ? data.headers : {},
        basic: (data.transport === "stdio" && typeof data.command === "string" && (data.args === undefined || !!args) && (data.env === undefined || strings(data.env)))
          || (data.transport === "http" && typeof data.url === "string" && (data.headers === undefined || strings(data.headers))),
      };
    }),
    schedules: (() => {
      const parent = nodeAtStringPath(doc, ["schedules"]);
      const zone = nodeAtStringPath(doc, ["schedules", "timezone"]);
      const present = hasPath(raw, ["schedules", "timezone"]);
      const value = record(raw.schedules) ? raw.schedules.timezone : undefined;
      // Flow edits rewrite siblings; anchors/aliases and references need explicit operator intent.
      const basic = (doc.contents === null || isMap(doc.contents) && !doc.contents.flow)
        && (parent === undefined || isScalar(parent) && parent.value === null && parent.source === "" && !parent.anchor
          || isMap(parent) && !parent.flow && !parent.anchor)
        && (!present || isScalar(zone) && !zone.anchor && typeof value === "string" && !value.includes("${"));
      return { basic, present, ...(typeof value === "string" ? { timezone: value } : {}), defaultTimezone: "UTC" };
    })(),
    recentConversationDefaults: recentDefaults,
    defaults: values(raw.defaults),
    channels: Object.entries(record(raw.channels) ? raw.channels : {}).map(([key, value]) => ({ key, ...values(value) })),
  };
}

/** Raw fragments are only allowed for one connector; all other form edits remain field-scoped. */
export interface OperatorEdit extends TextEdit { yaml?: string; create?: boolean }
function patchConnectorYaml(text: string, path: string[], yaml: string): string {
  // Reuse the text patcher's key quoting, flow-map handling and alias protection, then insert
  // the original fragment text rather than serialising its values (which would discard comments).
  const marker = "connector_" + randomUUID().replaceAll("-", "");
  const staged = patchText(text, [{ path, value: marker }]);
  const node = nodeAtStringPath(parseDocument(staged), path);
  if (!isScalar(node) || node.value !== marker || !node.range) {
    throw new OperatorConfigError(422, "Cannot locate the connector YAML in this draft; edit it in full-config raw YAML instead.");
  }
  const start = staged.lastIndexOf("\n", node.range[0]) + 1;
  const end = staged.indexOf("\n", node.range[1]);
  const prefix = staged.slice(start, node.range[0]).trimEnd();
  const indent = " ".repeat(prefix.length - prefix.trimStart().length + 2);
  const eol = staged.includes("\r\n") ? "\r\n" : "\n";
  const body = yaml.replace(/\r\n/g, "\n").split("\n").map((line) => line ? indent + line : "").join(eol);
  const suffix = staged.slice(end < 0 ? staged.length : end - (eol === "\r\n" ? 1 : 0));
  return staged.slice(0, start) + prefix + eol + body + (body.endsWith(eol) && suffix.startsWith(eol) ? suffix.slice(eol.length) : suffix);
}

/** Patch only the form subset, prove aliases did not alter another setting, and leave all other text alone. */
export function patchOperatorConfig(text: string, edits: OperatorEdit[]): string {
  let patched = text;
  for (const edit of edits) {
    const form = inspectOperatorConfig(patched);
    const p = edit.path;
    const connector = form.connectors.find((c) => c.key === p[1]);
    const entry = p.length === 2 && p[0] === "connectors";
    if (edit.create && (!entry || !p[1]?.trim() || connector)) throw new OperatorConfigError(400, "A new connector needs a non-empty, unique name.");
    let expected: TextEdit = edit;
    let next: string;
    if (edit.yaml !== undefined) {
      if (!entry || edit.remove || edit.value !== undefined) throw new OperatorConfigError(400, "Raw YAML must replace a single connector definition.");
      const value: unknown = parseYaml(edit.yaml);
      if (!record(value)) throw new OperatorConfigError(422, "Connector YAML must be a mapping (transport and its settings).");
      if (!connector && !edit.create) throw new OperatorConfigError(400, "Connector no longer exists.");
      expected = { path: p, value };
      next = patchConnectorYaml(patched, p, edit.yaml);
    } else {
      const timezonePath = p.length === 2 && p[0] === "schedules" && p[1] === "timezone";
      if (timezonePath) {
        if (edit.remove && !hasPath(parseYaml(patched), p)) continue;
        if (!form.schedules.basic) throw new OperatorConfigError(422, "schedules.timezone uses a reference, alias, or unsupported YAML shape. Edit schedules explicitly in Raw YAML (use a block mapping with a literal timezone for Basic settings).");
        if (!edit.remove && !validTimezone(edit.value)) throw new OperatorConfigError(422, "schedules.timezone requires a non-empty timezone accepted by the runtime, such as UTC or Australia/Sydney.");
      }
      const scalar = edit.remove || typeof edit.value === "string";
      const recentPath = p.length === 3 && p[0] === "defaults" && p[1] === "recentConversations"
        || p.length === 4 && p[0] === "channels" && form.channels.some((c) => c.key === p[1]) && p[2] === "recentConversations";
      if (recentPath && recentFields.includes(p.at(-1)!) && !edit.remove && !validRecentValue(p.at(-1)!, edit.value)) {
        throw new OperatorConfigError(422, "recentConversations." + p.at(-1) + " requires " + (p.at(-1) === "enabled" ? "a boolean." : p.at(-1) === "model" ? "a string." : "a positive integer."));
      }
      const allowed = timezonePath || recentPath && recentFields.includes(p.at(-1)!) && (edit.remove || validRecentValue(p.at(-1)!, edit.value))
        || scalar && (p.length === 2 && p[0] === "defaults" && ["model", "thinkingLevel", "preferences"].includes(p[1]!)
        || p.length === 3 && p[0] === "channels" && form.channels.some((c) => c.key === p[1]) && fields.some((field) => field === p[2]))
        || entry && !!connector && edit.remove
        || p[0] === "connectors" && !!connector && (
          p.length === 3 && scalar && (connector.transport === "stdio" && p[2] === "command" || connector.transport === "http" && p[2] === "url")
          || p.length === 3 && connector.transport === "stdio" && p[2] === "args" && (edit.remove || Array.isArray(edit.value) && edit.value.every((v) => typeof v === "string"))
          || p.length === 4 && scalar && (connector.transport === "stdio" && p[2] === "env" || connector.transport === "http" && p[2] === "headers"));
      if (!allowed) throw new OperatorConfigError(400, "That field has no form control; use raw YAML.");
      // Removing a never-persisted form entry must not invent empty parent mappings.
      if (edit.remove && !hasPath(parseYaml(patched), p)) continue;
      try { next = patchText(patched, [edit]); }
      catch (error) {
        if (timezonePath) throw new OperatorConfigError(422, "Cannot safely patch schedules.timezone; edit it in Raw YAML. " + (error instanceof Error ? error.message : "Unsupported YAML shape."));
        throw error;
      }
    }
    if (!isDeepStrictEqual(normalizeTree(parseYaml(next)), normalizeTree(expectedTree(patched, [expected])))) {
      throw new OperatorConfigError(422, "A YAML alias would also change another setting. Edit it explicitly in raw YAML instead.");
    }
    patched = next;
  }
  return patched;
}

export async function saveOperatorConfig(service: OperatorConfig, text: string, revision: string, remote: string) {
  const realPath = realpathSync(service.configPath);
  // Shares the agent editor's queue, including reload/rollback, to prevent two internal writers racing.
  return serialised(realPath, async () => {
    const original = readFileSync(realPath, "utf8");
    const conflict = () => { throw new OperatorConfigError(409, "The persisted config changed since you loaded it. Copy your draft, reload the persisted config, and reconcile your changes."); };
    if (configRevision(original) !== revision) conflict();
    validateOperatorConfig(text);
    assertWritable(realPath);
    const backup = backUp(realPath, service.dataDir);
    // No await between the final compare and rename. External host edits are checked too.
    if (readFileSync(realPath, "utf8") !== original || realpathSync(service.configPath) !== realPath) conflict();
    replaceAtomically(realPath, text);
    audit(service.dataDir, { event: "operator-config-save", remote, backup, revision: configRevision(text) });
    let reload: ReloadResult;
    try {
      reload = service.reload ? await service.reload() : { applied: false, warnings: ["Restart required: live reload is unavailable."] };
      if (service.reload && !reload.applied) throw new Error(reload.error ?? "reload refused");
    } catch {
      // Never clobber a host edit that landed while reload was running.
      if (readFileSync(realPath, "utf8") !== text || realpathSync(service.configPath) !== realPath) throw new OperatorConfigError(500, "Apply failed and the file changed again during reload. No rollback was attempted; check the persisted config and restart the harness. The draft is retained.");
      try { replaceAtomically(realPath, original); }
      catch { throw new OperatorConfigError(500, "Apply failed and the previous file could not be restored. Check file permissions and restart the harness; the saved config may still be on disk."); }
      audit(service.dataDir, { event: "operator-config-rollback", remote, backup });
      // A throwing reload may have partially applied; try to bring the runtime back to the restored file.
      let restored = false;
      try { restored = (await service.reload?.())?.applied === true; } catch { /* report uncertain runtime below */ }
      throw new OperatorConfigError(500, "Apply/reload failed. The previous file was restored. " + (restored ? "The previous config was reloaded." : "Runtime state is uncertain; restart the harness.") + " Your draft is retained.");
    }
    return { ok: true, saved: true, backup, applied: reload.applied, revision: configRevision(text), warnings: reload.warnings.map((warning) => safeConfigMessage(text, warning)) };
  });
}
