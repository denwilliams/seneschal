import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { parseConfigText } from "./load.ts";
import { audit, backUp, redact, serialised, type ConfigEdit } from "./edit.ts";
import { expectedTree, normalizeTree, patchText } from "./edit-text.ts";
import { configRevision, safeConfigMessage, saveOperatorConfig, validateOperatorConfig, type OperatorConfig } from "./operator.ts";

export type ConfiguratorScope = "channel" | "harness";
/** Supplied by the host runner, never by tool arguments. */
export interface ConfiguratorActor { scope: ConfiguratorScope; channelKey: string; channelId: string; userId: string }
// Fail closed: future schema fields cannot silently become channel-admin grants.
export const CHANNEL_CONFIGURATOR_FIELDS = new Set([
  "description", "model", "thinkingLevel", "models", "preferences", "respondToRootMessages",
  "context", "recentConversations", "interactiveComponents",
]);
const at = (tree: unknown, path: string[]): unknown => path.reduce<unknown>((v, key) =>
  v && typeof v === "object" && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined, tree);

export function createConfiguratorService(config: OperatorConfig, actor: ConfiguratorActor) {
  const identity = actor.channelId + ":" + actor.userId + ":" + actor.scope + "Configurator";
  function current() {
    const text = readFileSync(config.configPath, "utf8");
    // Recheck opt-in on every operation, including already-running roles after revocation.
    let loaded: ReturnType<typeof parseConfigText>;
    try { loaded = parseConfigText(text); }
    catch (error) {
      if (actor.scope === "channel") throw new Error("The persisted harness configuration is invalid; ask the host operator to repair it.");
      throw error;
    }
    if (!loaded.channels[actor.channelKey]?.configurators[actor.scope]) throw new Error("This configurator is no longer enabled for the invoking channel.");
    return { text, tree: parseYaml(text) as unknown, revision: configRevision(text) };
  }
  function checkPath(path: string[], writing: boolean) {
    if (!Array.isArray(path) || path.some((key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("Invalid configuration path.");
    if (actor.scope === "harness") return;
    if (path[0] !== "channels" || path[1] !== actor.channelKey) throw new Error("Channel configurators can access only their invoking channel's configuration.");
    if (writing && (path.length < 3 || !CHANNEL_CONFIGURATOR_FIELDS.has(path[2]!))) throw new Error("This setting changes trust, access or execution boundaries; use harnessConfigurator or edit it on the host.");
  }
  function prepare(edits: ConfigEdit[], revision: string) {
    const before = current();
    if (revision !== before.revision) throw new Error("The persisted config changed since you loaded it; read it again and reconcile your edits.");
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > 25) throw new Error("Provide between 1 and 25 edits.");
    for (const edit of edits) {
      checkPath(edit.path, true);
      // Non-deferred strings are expanded by the loader. A channel editor must not turn a host secret into prompt text.
      if (actor.scope === "channel" && !edit.remove && JSON.stringify(edit.value)?.includes("${")) throw new Error("Channel edits cannot introduce environment references; use harnessConfigurator.");
      if (edit.path.length === 0) throw new Error("Edit individual top-level settings, not the whole document.");
      // The posting reviewer inherits these settings; channel administration cannot weaken that guard.
      if (actor.scope === "channel" && ["model", "thinkingLevel", "preferences"].includes(edit.path[2]!) &&
          at(before.tree, ["channels", actor.channelKey, "share", "postAs"])) throw new Error("Changing the posting reviewer's inherited settings requires harnessConfigurator.");
    }
    const text = patchText(before.text, edits);
    if (!isDeepStrictEqual(normalizeTree(parseYaml(text)), normalizeTree(expectedTree(before.text, edits)))) throw new Error("A YAML alias would change another setting. Edit the alias explicitly with harness-level authority.");
    validateOperatorConfig(text);
    return { text };
  }
  return {
    get(path?: string[]) {
      const { tree, revision } = current();
      const selected = path ?? (actor.scope === "channel" ? ["channels", actor.channelKey] : []);
      checkPath(selected, false);
      // Redact before selection: direct reads of a generic header/env key must retain its secret-map context.
      const value = at(redact(tree), selected);
      return { revision, path: selected, found: value !== undefined, value };
    },
    async backup() {
      const real = realpathSync(config.configPath);
      return serialised(real, async () => {
        const { revision } = current();
        if (realpathSync(config.configPath) !== real) throw new Error("The configured file target changed; retry the backup.");
        const backup = backUp(real, config.dataDir);
        audit(config.dataDir, { event: "configurator-backup", remote: identity, backup, revision });
        return { backup: basename(backup), revision };
      });
    },
    validate(edits: ConfigEdit[], revision: string) {
      prepare(edits, revision);
      return { valid: true, saved: false, applied: false };
    },
    async save(edits: ConfigEdit[], revision: string) {
      const { text } = prepare(edits, revision);
      // The shared writer rechecks the revision INSIDE its queue before any backup or replacement.
      return saveOperatorConfig(config, text, revision, identity);
    },
    error(error: unknown) {
      let text = "";
      try { text = readFileSync(config.configPath, "utf8"); } catch { /* no file */ }
      return safeConfigMessage(text, error instanceof Error ? error.message : "Configuration operation failed.");
    },
  };
}
export type ConfiguratorService = ReturnType<typeof createConfiguratorService>;
