import { join } from "node:path";
import { loadConfig } from "../config/load.ts";
import { sharedPaths } from "../workspace/paths.ts";
import { findLegacyFlatSkills, migrateFlatSkills } from "../workspace/collections.ts";

/**
 * Move pre-collection shared skills (`data/shared/skills/<skill>/SKILL.md`)
 * into a collection (`data/shared/skills/<collection>/<skill>/SKILL.md`).
 *
 *   npm run migrate-skills                      # into the "default" collection
 *   npm run migrate-skills -- --collection ops
 *   npm run migrate-skills -- --dry-run
 *
 * Never overwrites; stops before moving anything if a destination exists.
 * Afterwards assign the collection to channels with share.skillCollections.
 */
const args = process.argv.slice(2);
const collectionIndex = args.indexOf("--collection");
const collection = collectionIndex >= 0 ? args[collectionIndex + 1] ?? "" : "default";
const dryRun = args.includes("--dry-run");

const { dataDir } = loadConfig(process.env.HARNESS_CONFIG);
const skillsRoot = sharedPaths(dataDir).skills;
const flat = findLegacyFlatSkills(skillsRoot);

if (flat.length === 0) {
  console.log(`No flat shared skills under ${skillsRoot}; nothing to migrate.`);
} else if (dryRun) {
  for (const name of flat) console.log(`would move ${join(skillsRoot, name)} -> ${join(skillsRoot, collection, name)}`);
} else {
  const moved = migrateFlatSkills(skillsRoot, collection);
  for (const name of moved) console.log(`moved ${name} -> ${collection}/${name}`);
  console.log(`\nAssign it with:  share: { skillCollections: [{ name: ${collection}, mode: ro }] }`);
}
