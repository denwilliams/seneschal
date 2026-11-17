import { accessSync, appendFileSync, chmodSync, constants, copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, parseDocument } from "yaml";
import { parseConfigText } from "./load.ts";
import { checkEdits, CHANNEL, DEFAULTS, SHARE, TOP_LEVEL } from "./edit-policy.ts";
import { expectedTree, normalizeTree, patchText, PatchError, type TextEdit } from "./edit-text.ts";

/**
 * Changing `harness.yaml` from the admin channel.
 *
 * The file is the harness's whole security posture, so this is not a free-for-all: `edit-policy.ts` says what may be touched
 * (a blacklist of the things that move trust, with every schema key classified), and the admin channel's own entry is never
 * editable from inside it. Within that, an edit is a batch of changes applied together, because "add this connector and give
 * it to those channels" should land as one validated, backed-up, reloadable change or not at all.
 *
 * Every batch goes through the same steps, and stops at the first that fails, with the file untouched:
 *
 *   resolve channel names -> check the policy -> patch the TEXT of just those settings (comments and layout survive) ->
 *   prove the result means exactly what was asked and nothing else -> validate it as the loader does -> back up ->
 *   replace the real file atomically -> record who did it -> reload, and put the old file back if the reload refuses it.
 */

export class ConfigEditError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigEditError"; }
}

export interface ConfigEdit {
  /** Keys from the top of the file: `["connectors", "github"]`, `["channels", "engineering", "share", "connectors"]`. */
  path: string[];
  /** The new value. Ignored when `remove` is set. */
  value?: unknown;
  remove?: boolean;
}

export interface ReloadResult { applied: boolean; error?: string; warnings: string[] }

export interface ConfigEditRequest {
  /** The config file as the harness was started with it; a symlink is followed, and stays a symlink. */
  configPath: string;
  edits: ConfigEdit[];
  /** Who asked, for the record. `channelKey` is the channel the request came from; nothing about it can be changed. */
  actor: { channelId: string; channelKey?: string; userId: string };
  /** Where backups and the audit record go. */
  dataDir: string;
  /** Checks only the harness can make (that a model exists, for example). Return a message to refuse. */
  validate?: (edits: ConfigEdit[]) => string | undefined;
  /** A person has approved exactly these edits, so the settings that need an approval may change. Everything else is still refused. */
  privileged?: boolean;
  /** Run every check and report what would change, but write nothing and reload nothing. */
  dryRun?: boolean;
  /** Apply the new file to the running harness. A refusal restores the old file. */
  reload?: () => Promise<ReloadResult>;
}

export interface ConfigEditResult {
  changes: { path: string; before: unknown; after: unknown }[];
  backup: string;
  reload?: ReloadResult;
}

const KEEP_BACKUPS = 30;
const MAX_EDITS = 25;

const isTree = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const valueAt = (tree: unknown, path: string[]): unknown => path.reduce<unknown>((node, key) => (isTree(node) ? node[key] : undefined), tree);

/** Edits to the same file run one at a time. */
const queues = new Map<string, Promise<unknown>>();
export function serialised<T>(file: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).then(work, work);
  queues.set(file, run.catch(() => undefined));
  return run;
}

function channelKeysOf(tree: unknown): string[] {
  const channels = valueAt(tree, ["channels"]);
  return isTree(channels) ? Object.keys(channels) : [];
}

/** The config key a person's wording refers to: the key itself, or a name with or without its `#`. */
function resolveChannel(tree: unknown, wanted: string): string | undefined {
  const keys = channelKeysOf(tree);
  const bare = wanted.replace(/^#/, "");
  return keys.find((k) => k === wanted) ?? keys.find((k) => k.replace(/^#/, "") === bare);
}

function parseOrThrow(text: string): unknown {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ConfigEditError(`The config file does not parse as YAML (${doc.errors[0]!.message}); fix it on the host first.`);
  return (parseYaml(text) as unknown) ?? {};
}

export function replaceAtomically(realPath: string, text: string): void {
  // Beside the real file, so the rename stays on one filesystem and a symlink to it is left pointing at it.
  const temp = join(dirname(realPath), `.${randomBytes(6).toString("hex")}.harness-config.tmp`);
  const mode = statSync(realPath).mode & 0o777;
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, realPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new ConfigEditError(notWritable(realPath, error));
  }
}

/** Why the config cannot be written, in terms of what a person would change. The usual cause is a read-only mount. */
function notWritable(realPath: string, error: unknown): string {
  const code = (error as { code?: string })?.code;
  const why = error instanceof Error ? error.message : String(error);
  return code === "EROFS" || code === "EACCES" || code === "EPERM"
    ? `The harness cannot write its config file (${why}). Its folder (${dirname(realPath)}) is read-only for the harness: in Docker the default is \`./config:/app/config:ro\`, and the compose override docker-compose.admin-config.yml makes it writable. Until then this is edited on the host.`
    : `Could not write the config file (${why}). Is its folder writable by the harness?`;
}

/** Checked before anything is backed up or prepared, so a read-only config fails cleanly and leaves nothing behind. */
export function assertWritable(realPath: string): void {
  try { accessSync(dirname(realPath), constants.W_OK); }
  catch (error) { throw new ConfigEditError(notWritable(realPath, error)); }
}

export function backUp(realPath: string, dataDir: string): string {
  const dir = join(dataDir, "config-backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `harness-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}.yaml`);
  copyFileSync(realPath, target);
  chmodSync(target, 0o600); // a config can hold secrets
  const all = readdirSync(dir).filter((name) => name.startsWith("harness-")).sort();
  for (const name of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(join(dir, name), { force: true });
  return target;
}

export function audit(dataDir: string, entry: Record<string, unknown>): void {
  try {
    const dir = join(dataDir, "shared", "audit");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "config-edits.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* the edit happened; a record that cannot be written must not undo it */ }
}

/** The edits with channel names resolved to the keys the file really uses. A channel that is not there yet keeps the name given. */
function normalise(edits: ConfigEdit[], tree: unknown): ConfigEdit[] {
  return edits.map((edit) => {
    const path = [...edit.path];
    if (path[0] === "channels" && path[1]) path[1] = resolveChannel(tree, path[1]) ?? path[1];
    return { ...edit, path };
  });
}

export function editConfig(request: ConfigEditRequest): Promise<ConfigEditResult> {
  const realPath = realpathSync(request.configPath);
  return serialised(realPath, async () => {
    if (request.edits.length === 0) throw new ConfigEditError("Nothing to change.");
    assertWritable(realPath);
    if (request.edits.length > MAX_EDITS) throw new ConfigEditError(`At most ${MAX_EDITS} changes at a time.`);
    for (const edit of request.edits) {
      if (!Array.isArray(edit.path) || edit.path.length === 0 || edit.path.some((p) => typeof p !== "string" || !p)) {
        throw new ConfigEditError("Each change needs a path: a list of keys from the top of the file.");
      }
    }
    const original = readFileSync(realPath, "utf8");
    const readAt = statSync(realPath).mtimeMs;
    const before = parseOrThrow(original);
    const edits = normalise(request.edits, before);
    const textEdits: TextEdit[] = edits.map((e) => ({ path: e.path, ...(e.remove ? { remove: true } : { value: e.value }) }));

    // What the file would mean. Computed on the tree, with no text involved.
    const after = expectedTree(original, textEdits);

    const protectedChannels = new Set<string>();
    for (const key of channelKeysOf(before)) if (valueAt(before, ["channels", key, "admin"]) === true) protectedChannels.add(key);
    const actorKey = request.actor.channelKey ? resolveChannel(before, request.actor.channelKey) : undefined;
    if (actorKey) protectedChannels.add(actorKey);
    const problems = checkEdits(edits, { before, after, protectedChannels, resolve: (name) => resolveChannel(before, name), ...(request.privileged ? { privileged: true } : {}) });
    if (problems.length > 0) throw new ConfigEditError(`Nothing was changed.\n${problems.map((p) => `- ${p}`).join("\n")}`);

    // Edit the text of just those settings, then prove the file means exactly what was asked and nothing more.
    let patched: string;
    try { patched = patchText(original, textEdits); }
    catch (error) {
      if (error instanceof PatchError) throw new ConfigEditError(`That could not be applied exactly (${error.message}), so nothing was changed. It is edited on the host.`);
      throw error;
    }
    let patchedTree: unknown;
    try { patchedTree = parseYaml(patched); }
    catch { throw new ConfigEditError("Applying that would have broken something else in the file (it uses an anchor or alias that another setting depends on), so nothing was changed. It is edited on the host."); }
    if (!isDeepStrictEqual(normalizeTree(patchedTree), normalizeTree(after))) {
      throw new ConfigEditError("Applying that would also have changed something else (the file uses an anchor or alias shared with other settings), so nothing was changed. It is edited on the host.");
    }

    // Exactly what the loader will do with it at the next start.
    try { parseConfigText(patched, "the edited config"); }
    catch (error) { throw new ConfigEditError(`The result is not a valid config, so nothing was written. ${error instanceof Error ? error.message : String(error)}`); }
    const refusal = request.validate?.(edits);
    if (refusal) throw new ConfigEditError(refusal);

    if (request.dryRun) {
      return { changes: edits.map((e) => ({ path: e.path.join("."), before: valueAt(before, e.path), after: e.remove ? undefined : valueAt(after, e.path) })), backup: "(dry run)" };
    }

    if (statSync(realPath).mtimeMs !== readAt) throw new ConfigEditError("The config file changed while this was being prepared, so nothing was written. Try again.");
    const backup = backUp(realPath, request.dataDir);
    replaceAtomically(realPath, patched);
    const changes = edits.map((e) => ({ path: e.path.join("."), before: valueAt(before, e.path), after: e.remove ? undefined : valueAt(after, e.path) }));
    audit(request.dataDir, { event: "edit", actor: request.actor, changes, backup });

    const reload = request.reload ? await request.reload() : undefined;
    if (reload && !reload.applied) {
      // The running harness refused the file. Put the last good one back, so the file and the running config agree.
      replaceAtomically(realPath, original);
      audit(request.dataDir, { event: "rolled-back", actor: request.actor, reason: reload.error ?? "reload failed", backup });
      throw new ConfigEditError(`The harness would not load the new config (${reload.error ?? "reload failed"}), so the previous file has been put back. Nothing changed.`);
    }
    return { changes, backup, ...(reload ? { reload } : {}) };
  });
}

// --- Reading ---------------------------------------------------------------------------------------------------------------

const SECRET_KEY = /secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key/i;
const SECRET_SHAPE = /^(sk-|sk_|xox[abprs]-|xapp-|ghp_|gho_|github_pat_|glpat-|AKIA|AIza|ya29\.)[A-Za-z0-9_\-.]{8,}/;
const REFERENCE = /\$\{[A-Za-z0-9_]+\}/;

/** A tree safe to show: a `${VAR}` reference is shown (it names where a secret is, not what it is); a literal secret never is. */
export function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (REFERENCE.test(value)) return value;
    if (SECRET_KEY.test(key) || SECRET_SHAPE.test(value)) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (isTree(value)) {
    // Everything in a map of headers or environment values is treated as a credential unless it is a reference.
    const secretMap = /^(headers|env)$/i.test(key);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "string" && secretMap && !REFERENCE.test(v) ? "[redacted]" : redact(v, k)]));
  }
  return value;
}

/** What the file says at a path (the whole file with none), with literal secrets removed. */
export function readConfig(configPath: string, path: string[] = []): { path: string; found: boolean; value?: unknown; channels?: string[] } {
  const tree = parseOrThrow(readFileSync(realpathSync(configPath), "utf8"));
  const resolved = [...path];
  if (resolved[0] === "channels" && resolved[1]) resolved[1] = resolveChannel(tree, resolved[1]) ?? resolved[1];
  const value = resolved.length === 0 ? tree : valueAt(tree, resolved);
  return {
    path: resolved.join(".") || "(whole file)",
    found: value !== undefined,
    ...(value !== undefined ? { value: redact(value, resolved.at(-1) ?? "") } : {}),
    ...(resolved.length === 0 || (resolved.length === 1 && resolved[0] === "channels") ? { channels: channelKeysOf(tree) } : {}),
  };
}

/** What the person is told about the limits, assembled from the policy so it cannot drift from it. */
export function describeLimits(): string {
  const denied = (table: Record<string, "allow" | { deny: string }>) => Object.entries(table).filter(([, v]) => v !== "allow").map(([k]) => k);
  return [
    `Not from here (edited on the host): top-level ${denied(TOP_LEVEL).join(", ")}; defaults.${denied(DEFAULTS).join(", defaults.")}; per channel ${denied(CHANNEL).join(", ")}; share.${denied(SHARE).join(", share.")}.`,
    "The admin channel itself, and the channel you are in, are never changed from inside it. `admin` is never set or cleared.",
    "Connectors: remote (`transport: http`) only, never pointing at this machine; secrets only as ${VAR} references starting with the connector's own name in capitals (a connector `github` may use ${GITHUB_TOKEN}).",
    "Four of those need a person's click in Slack instead (use admin_config_request_approval): a channel's `sandbox`, `share.delegateTo`, its `share.postAs` (and the reviewer role that guards it: that role's settings, its removal, the model it inherits, or the channel's `agentSet`), and `bash`/`exec` added to its `tools`. Not for the admin channel.",
    "A channel's tools cannot gain `bash` or `exec` without that approval; allowUsers must be real Slack user IDs and can never be emptied or removed; an approval requirement is never switched off.",
  ].join("\n");
}
