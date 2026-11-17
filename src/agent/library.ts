import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { SharedPaths } from "../workspace/paths.ts";
import { channelSkillDir, listSkills, validateSkillName, writeChannelSkill } from "./skills.ts";

/**
 * The skill library: how one channel's hard-won procedure reaches another.
 *
 * A channel writes its own skills, and until now that was the end of it. The
 * #ops channel could work out exactly how to read a Grafana alert and #home
 * would never know, because the only route between them was an operator
 * copying a directory on the host.
 *
 * The library is that route, made explicit. It is deliberately not the shared
 * catalogue (`shared/skills/`): that one is operator-curated and a channel
 * enables entries from it by name in the config, which means anything landing
 * there activates itself in every channel that named it. The library is
 * agent-curated, so it works the other way round — publishing puts a skill on a
 * shelf, and nothing happens until another channel's agent goes and takes it.
 *
 * Three properties hold the isolation model together:
 *
 * - **Publishing is a permission.** `share.libraryPublish`, or a runtime grant
 *   of `skillPublish` that a human approves. Writing instructions other
 *   channels may follow is not something a channel should be able to do just
 *   because it felt like it.
 * - **Installing is a copy, not a link.** The skill lands in the installing
 *   channel's own directory, so it is inert until that channel takes it, and a
 *   later edit by the publisher cannot change what an installed skill says.
 * - **Provenance is kept.** Every entry records the channel that published it
 *   and when, so a skill is never anonymous advice.
 */

export interface LibraryEntry {
  name: string;
  description: string;
  /** Channel label as it read at publish time, e.g. "#ops". For humans. */
  publishedBy: string;
  /** Slack channel id of the publisher. This is the identity that matters. */
  publishedByChannelId: string;
  publishedAt: string;
  updatedAt: string;
  /** Bumped each time the publisher republishes. */
  version: number;
  /** Why the publisher thought it was worth sharing. */
  note?: string;
}

export interface LibrarySkill extends LibraryEntry {
  instructions: string;
  path: string;
}

/** What a channel has taken from the library, and which version. */
export interface InstallRecord {
  version: number;
  from: string;
  installedAt: string;
}

const META_FILE = "library.json";
const INSTALLED_FILE = ".library.json";

function entryDir(shared: SharedPaths, name: string): string {
  return join(shared.library, name);
}

/**
 * Read a SKILL.md into its parts.
 *
 * pi's loader gives the name and description but not the body, and the body is
 * the thing being moved between channels. Frontmatter is parsed with the real
 * YAML parser rather than a regex, because that is what wrote it.
 */
export function readSkillFile(path: string): {
  name?: string;
  description?: string;
  instructions: string;
} {
  const raw = readFileSync(path, "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { instructions: raw.trim() };

  let front: Record<string, unknown> = {};
  try {
    front = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>;
  } catch {
    // Unparseable frontmatter means pi would not load it either; treat the
    // whole file as a body so the caller can complain about the missing name.
  }
  return {
    ...(typeof front.name === "string" ? { name: front.name } : {}),
    ...(typeof front.description === "string" ? { description: front.description } : {}),
    instructions: raw.slice(match[0].length).trim(),
  };
}

function readEntry(shared: SharedPaths, name: string): LibraryEntry | undefined {
  const file = join(entryDir(shared, name), META_FILE);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as LibraryEntry;
    if (parsed && typeof parsed.name === "string") return parsed;
  } catch {
    // A directory without readable metadata is not a library entry. Dropping it
    // from the listing is the right failure: an entry with no provenance is
    // exactly what should not be offered to another channel.
  }
  return undefined;
}

function writeEntry(shared: SharedPaths, entry: LibraryEntry): void {
  const dir = entryDir(shared, entry.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, META_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

/** Everything on the shelf, newest first. */
export function listLibrary(shared: SharedPaths): LibraryEntry[] {
  if (!existsSync(shared.library)) return [];
  let names: string[];
  try {
    names = readdirSync(shared.library);
  } catch {
    return [];
  }
  const out: LibraryEntry[] = [];
  for (const name of names) {
    if (!existsSync(join(entryDir(shared, name), "SKILL.md"))) continue;
    const entry = readEntry(shared, name);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readLibrarySkill(shared: SharedPaths, rawName: string): LibrarySkill {
  const name = validateSkillName(rawName);
  const entry = readEntry(shared, name);
  const path = join(entryDir(shared, name), "SKILL.md");
  if (!entry || !existsSync(path)) {
    throw new Error(`The library has no skill called \`${name}\`.`);
  }
  return { ...entry, instructions: readSkillFile(path).instructions, path };
}

export interface PublishInput {
  name: string;
  /** Why this is worth other channels having. */
  note?: string;
}

/**
 * Put one of this channel's own skills on the shelf.
 *
 * Only a skill this channel wrote can be published: a channel republishing
 * something it installed from the library would launder another channel's
 * instructions under its own name, and a channel publishing a shared-catalogue
 * skill would fork the operator's copy without anyone deciding to.
 */
export function publishToLibrary(
  shared: SharedPaths,
  channel: ResolvedChannel,
  input: PublishInput,
  now = new Date(),
): LibraryEntry {
  const name = validateSkillName(input.name);

  const own = listSkills(channel).find((s) => s.name === name && s.origin === "channel");
  if (!own) {
    throw new Error(
      `\`${name}\` is not one of this channel's own skills, so there is nothing here to publish. ` +
        `Write it with \`save_skill\` first — you can only publish what this channel wrote.`,
    );
  }

  const existing = readEntry(shared, name);
  if (existing && existing.publishedByChannelId !== channel.ref.id) {
    throw new Error(
      `\`${name}\` is already in the library, published by ${existing.publishedBy}. ` +
        `Only the channel that published a skill can replace it — save yours under a different name.`,
    );
  }

  const source = readSkillFile(join(channelSkillDir(channel, name), "SKILL.md"));
  const description = (source.description ?? own.description).trim();
  if (!description || !source.instructions.trim()) {
    throw new Error(`\`${name}\` has no description or no body, so it is not worth publishing.`);
  }

  const dir = entryDir(shared, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${source.instructions}\n`,
  );

  const entry: LibraryEntry = {
    name,
    description,
    publishedBy: channel.ref.name ? `#${channel.ref.name}` : channel.ref.id,
    publishedByChannelId: channel.ref.id,
    publishedAt: existing?.publishedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    version: (existing?.version ?? 0) + 1,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  writeEntry(shared, entry);
  return entry;
}

/** Take a skill back off the shelf. Only the publisher may. */
export function unpublishFromLibrary(
  shared: SharedPaths,
  channel: ResolvedChannel,
  rawName: string,
): boolean {
  const name = validateSkillName(rawName);
  const entry = readEntry(shared, name);
  if (!entry) return false;
  if (entry.publishedByChannelId !== channel.ref.id) {
    throw new Error(
      `\`${name}\` was published by ${entry.publishedBy}, so this channel cannot withdraw it.`,
    );
  }
  rmSync(entryDir(shared, name), { recursive: true, force: true });
  return true;
}

// --- The installing side --------------------------------------------------

function installedFile(channel: ResolvedChannel): string {
  return join(channel.paths.skills, INSTALLED_FILE);
}

/** What this channel has taken from the library, keyed by skill name. */
export function installedFromLibrary(channel: ResolvedChannel): Record<string, InstallRecord> {
  try {
    const parsed = JSON.parse(readFileSync(installedFile(channel), "utf-8")) as Record<
      string,
      InstallRecord
    >;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // No record means nothing installed, which is the safe reading.
  }
  return {};
}

function recordInstall(channel: ResolvedChannel, entry: LibraryEntry, now: Date): void {
  const all = installedFromLibrary(channel);
  all[entry.name] = {
    version: entry.version,
    from: entry.publishedBy,
    installedAt: now.toISOString(),
  };
  try {
    const file = installedFile(channel);
    mkdirSync(channel.paths.skills, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, file);
  } catch {
    // Provenance is worth keeping but not worth failing an install over.
  }
}

export interface InstallResult {
  entry: LibraryEntry;
  path: string;
  /** Set when this replaced a copy already installed here. */
  replacedVersion?: number;
}

/**
 * Copy a library skill into this channel.
 *
 * Copying rather than referencing is what keeps this inside the isolation
 * model: after the install the skill is an ordinary channel skill that this
 * channel can edit or delete, and the publisher cannot reach into another
 * channel by editing what it published.
 */
export function installFromLibrary(
  shared: SharedPaths,
  channel: ResolvedChannel,
  rawName: string,
  opts: { replace?: boolean } = {},
  now = new Date(),
): InstallResult {
  const skill = readLibrarySkill(shared, rawName);
  const installed = installedFromLibrary(channel);
  const own = listSkills(channel).find((s) => s.name === skill.name && s.origin === "channel");

  // Overwriting a skill this channel wrote itself is a real loss, so it takes
  // an explicit yes. Updating one previously installed from the library is not.
  if (own && !installed[skill.name] && !opts.replace) {
    throw new Error(
      `This channel already has its own skill called \`${skill.name}\`. ` +
        `Installing would overwrite it — pass replace: true if that is what you want.`,
    );
  }

  const path = writeChannelSkill(channel, {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
  });
  recordInstall(channel, skill, now);

  return {
    entry: skill,
    path,
    ...(installed[skill.name] ? { replacedVersion: installed[skill.name]!.version } : {}),
  };
}

/** One line per entry, for `!library` and the listing tool. */
export function describeEntry(entry: LibraryEntry, installed?: InstallRecord): string {
  const state = !installed
    ? ""
    : installed.version < entry.version
      ? `  _(installed here: v${installed.version}, update available)_`
      : "  _(installed here)_";
  return (
    `• \`${entry.name}\` — ${entry.description}\n` +
    `   _from ${entry.publishedBy}, v${entry.version}, ${entry.updatedAt.slice(0, 10)}_${state}` +
    (entry.note ? `\n   _${entry.note}_` : "")
  );
}
