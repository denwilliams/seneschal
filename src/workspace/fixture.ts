import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "./registry.ts";
import { resolveChannel, type ResolvedChannel } from "./resolve.ts";
import { sharedPaths } from "./paths.ts";

/**
 * Test fixture for Workstream B suites (skills, collections, bins, CLI pool):
 * a throwaway data dir plus a real config and the real resolver, so a test
 * exercises exactly what a session would be given.
 */
export function workspaceFixture(configInput: unknown = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-wsb-"));
  const make = (input: unknown) => HarnessConfigSchema.parse({ dataDir, ...(input as object) });
  let config = make(configInput);
  const registry = new ChannelRegistry(dataDir);
  const shared = sharedPaths(dataDir);

  const resolve = (id: string, opts: { name?: string; isDm?: boolean } = {}): ResolvedChannel => {
    const result = resolveChannel(
      config,
      dataDir,
      { id, isDm: opts.isDm ?? false, ...(opts.name ? { name: opts.name } : {}) },
      registry,
    );
    if (!result.channel) throw new Error(result.rejected ?? "channel did not resolve");
    return result.channel;
  };

  /** Create `shared/skills/<collection>/<name>/SKILL.md` with a valid frontmatter. */
  const addCollectionSkill = (collection: string, name: string, description = `${name} skill. Use when testing.`) => {
    const dir = join(shared.skills, collection, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nbody of ${name}\n`);
    return dir;
  };

  return {
    dataDir,
    shared,
    registry,
    resolve,
    addCollectionSkill,
    get config() {
      return config;
    },
    reconfigure(input: unknown) {
      config = make(input);
    },
  };
}
