import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  RESERVED_COLLECTION_NAMES,
  SKILL_COLLECTION_NAME,
  type SkillCollectionAssignment,
} from "../config/schema.ts";
import { logger } from "../util/log.ts";

/**
 * Skill collections: `data/shared/skills/<collection>/<skill>/SKILL.md`.
 *
 * A skill belongs to exactly one collection (its parent directory) — there is
 * no manifest and no many-to-many. Collections are assigned to channels in
 * config, read-only unless the assignment says `rw`.
 *
 * The older layout, `shared/skills/<skill>/SKILL.md` with no collection, is
 * REJECTED rather than guessed at: those directories are skipped with an
 * error naming the fix. `migrateFlatSkills` (exposed as `npm run
 * migrate-skills`) moves them into a collection on the operator's command; the
 * harness never rewrites the operator's directory on its own.
 */

/** Where a channel's own skills appear inside its container. */
export const CONTAINER_CHANNEL_SKILLS = "/skills/channel";
/** Where an assigned collection appears inside a container. */
export function containerCollectionPath(name: string): string {
  return `/skills/${name}`;
}
/** The operator's global bin inside every container (always read-only). */
export const CONTAINER_GLOBAL_BIN = "/global/bin";

export interface ResolvedCollection {
  name: string;
  mode: "ro" | "rw";
  /** Absolute host directory of the collection. */
  dir: string;
}

export function validateCollectionName(raw: string): string {
  const name = raw.trim();
  if (
    !name ||
    name.length > 64 ||
    !SKILL_COLLECTION_NAME.test(name) ||
    (RESERVED_COLLECTION_NAMES as readonly string[]).includes(name)
  ) {
    throw new Error(
      `"${raw}" is not a valid skill collection name. Use lowercase letters, numbers and single hyphens ` +
        `(not ${RESERVED_COLLECTION_NAMES.join(" or ")}).`,
    );
  }
  return name;
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A directory directly under `shared/skills` that holds a SKILL.md itself is a pre-collection skill. */
export function findLegacyFlatSkills(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot)
    .filter((n) => !n.startsWith(".") && isDirectory(join(skillsRoot, n)))
    .filter((n) => existsSync(join(skillsRoot, n, "SKILL.md")))
    .sort();
}

/** Directories that look like collections: not hidden, not themselves a skill. */
export function listCollectionNames(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const legacy = new Set(findLegacyFlatSkills(skillsRoot));
  return readdirSync(skillsRoot)
    .filter((n) => !n.startsWith(".") && isDirectory(join(skillsRoot, n)) && !legacy.has(n))
    .sort();
}

/** Skill names present in one collection (directories holding a SKILL.md). */
export function listCollectionSkillNames(collectionDir: string): string[] {
  if (!existsSync(collectionDir)) return [];
  return readdirSync(collectionDir)
    .filter((n) => !n.startsWith(".") && existsSync(join(collectionDir, n, "SKILL.md")))
    .sort();
}

let legacyWarned = new Set<string>();
/** Test hook: forget which legacy directories were already reported. */
export function resetLegacyWarnings(): void {
  legacyWarned = new Set();
}

/**
 * Turn config assignments into collections that actually exist on disk.
 *
 * A missing collection is skipped (and logged), never created: a typo in
 * config must not conjure a writable directory. Unassigned collections are
 * never returned, which is what keeps them invisible to the channel.
 */
export function resolveCollections(
  assignments: SkillCollectionAssignment[],
  skillsRoot: string,
  label = "channel",
): ResolvedCollection[] {
  for (const flat of findLegacyFlatSkills(skillsRoot)) {
    const key = join(skillsRoot, flat);
    if (legacyWarned.has(key)) continue;
    legacyWarned.add(key);
    logger.error(
      `shared skill ${key} uses the removed flat layout and is NOT loaded. ` +
        `Run \`npm run migrate-skills\` (moves it to ${join(skillsRoot, "default", flat)}) and assign the ` +
        `collection with share.skillCollections.`,
    );
  }

  const out: ResolvedCollection[] = [];
  const root = resolve(skillsRoot);
  for (const assignment of assignments) {
    let name: string;
    try {
      name = validateCollectionName(assignment.name);
    } catch (err) {
      logger.error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const dir = join(root, name);
    if (dirname(dir) !== root) continue; // defence in depth; the name regex already forbids this
    if (!isDirectory(dir)) {
      logger.warn(`${label}: skill collection "${name}" does not exist under ${root}; skipped`);
      continue;
    }
    if (existsSync(join(dir, "SKILL.md"))) {
      logger.error(`${label}: ${dir} is a flat skill, not a collection; skipped`);
      continue;
    }
    out.push({ name, mode: assignment.mode, dir });
  }
  return out;
}

/**
 * Move pre-collection skills into `<skillsRoot>/<collection>/`. Never
 * overwrites: if the destination exists the whole run stops before moving
 * anything. Returns the skill names moved.
 */
export function migrateFlatSkills(skillsRoot: string, collection = "default"): string[] {
  validateCollectionName(collection);
  const flat = findLegacyFlatSkills(skillsRoot);
  if (flat.length === 0) return [];
  const target = join(skillsRoot, collection);
  for (const name of flat) {
    if (name !== collection && existsSync(join(target, name))) {
      throw new Error(`Cannot migrate "${name}": ${join(target, name)} already exists. Resolve it by hand.`);
    }
  }
  // Stage through a hidden directory so a skill that shares the collection's
  // own name can move "into itself".
  const staging = join(skillsRoot, `.migrating-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  for (const name of flat) renameSync(join(skillsRoot, name), join(staging, name));
  mkdirSync(target, { recursive: true });
  for (const name of flat) renameSync(join(staging, name), join(target, name));
  rmSync(staging, { recursive: true, force: true });
  return flat;
}

/**
 * Whether a skill file, once symlinks are followed, lies outside the
 * directory it is supposed to live in. pi follows symlinks when loading
 * skills, so without this a link planted in a writable collection could pull
 * another channel's files into every prompt that loads the collection.
 */
export function skillFileEscapes(filePath: string, root: string): boolean {
  try {
    const real = realpathSync(filePath);
    const realRoot = realpathSync(root);
    return real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  } catch {
    return true; // cannot prove containment: do not load it
  }
}

// --- Provenance ---------------------------------------------------------

export interface SkillWriteRecord {
  at: string;
  /** What was touched. */
  kind: "collection-skill" | "channel-skill";
  action: "write" | "delete";
  /** Channel whose agent performed the write. */
  actor: string;
  /** Collection name or target channel id. */
  target: string;
  skill: string;
  /** SHA-256 of the written SKILL.md (absent on delete). */
  sha256?: string;
  /** Whether the actor was acting as the admin channel. */
  admin?: boolean;
}

/** Append one provenance line. Failing to log refuses the write, so callers log first. */
export function appendSkillWrite(logFile: string, record: Omit<SkillWriteRecord, "at">): void {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { flag: "a" });
}
