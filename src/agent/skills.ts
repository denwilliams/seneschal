import { isContainerMode } from "./sandbox.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { Type } from "typebox";
import { defineTool, loadSkillsFromDir, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { REPO_ROOT } from "../config/load.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { channelPaths } from "../workspace/paths.ts";
import { ChannelRegistry, isSlackChannelId } from "../workspace/registry.ts";
import {
  appendSkillWrite,
  skillFileEscapes,
  type ResolvedCollection,
} from "../workspace/collections.ts";
import { logger } from "../util/log.ts";

/**
 * Skills the agent writes for itself.
 *
 * Memory is what the channel knows; a skill is what it knows how to *do*. The
 * distinction matters because they are loaded differently: memory is read on
 * demand into a conversation, while a skill's name and description sit in
 * every system prompt and its body is read only when the task matches. That
 * makes a skill the right home for a procedure — the steps for the Friday
 * report, how this household's heating actually works, the shape of a good
 * standup summary — and the wrong home for a fact.
 *
 * A channel writes only its own skills, with two explicit exceptions, both
 * deliberate and logged: a collection assigned `rw` in config (instructions
 * every holder of the collection will execute, so rare), and the single admin
 * channel, which may manage other channels' own skills by channel id. Anything
 * else — in particular a read-only collection — is refused by every path.
 *
 * Like memory, the model names a skill rather than a path, so "save this" can
 * never resolve to somewhere else on disk.
 */

/**
 * Skills shipped with the harness itself, in every channel, with nothing to
 * configure.
 *
 * The catalogue is the operator's and the library is the agents'; this is the
 * harness's own, and it holds the things every channel needs before it has
 * learned anything — chiefly how to write a skill. A channel with no skills
 * still writes its first one on day one, and it writes it better having read
 * how. Being on disk in the repo rather than in `data/` is the point: it is
 * reviewed in git, it survives a wiped data directory, and no channel can
 * edit it.
 *
 * It goes last in `skillPaths`, so a channel that saves a skill of the same
 * name shadows it — the same escape hatch the catalogue already has.
 */
export const BUILTIN_SKILLS_DIR = join(REPO_ROOT, "skills");
/** Reviewed lifecycle skill directories enabled only by factory config. */
export const FACTORY_SKILLS_DIR = join(REPO_ROOT, "factory-skills");
/**
 * Skills for running the installation itself (config, secrets, backups, recovery, upgrades). Shipped and reviewed with
 * the harness like the built-ins, but loaded ONLY for the channel configured `admin: true`: every other channel has no
 * business knowing how the host is administered, and no path to this directory.
 */
export const ADMIN_SKILLS_DIR = join(REPO_ROOT, "admin-skills");
/** Skills shipped with the harness for an agent set (`agent-set-skills/<set>/<skill>/SKILL.md`), e.g. the software factory's pipeline. */
export const AGENT_SET_SKILLS_DIR = join(REPO_ROOT, "agent-set-skills");
export function factorySkillPath(name: string): string { return join(FACTORY_SKILLS_DIR, `factory-${name}`); }

/** Agent Skills standard: 1-64 chars, lowercase alphanumeric and hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

export interface SkillSummary {
  name: string;
  description: string;
  /**
   * "channel" = this channel wrote or owns it; "shared" = from an assigned
   * collection; "builtin" = shipped with the harness.
   */
  origin: "channel" | "shared" | "builtin";
  /** Collection a "shared" skill belongs to. */
  collection?: string;
  path: string;
}

export function validateSkillName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name) throw new Error("A skill needs a name.");
  if (name.length > MAX_NAME) {
    throw new Error(`Skill names are at most ${MAX_NAME} characters; "${name}" is longer.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `"${raw}" is not a valid skill name. Use lowercase letters, numbers and single hyphens — ` +
        "for example `weekly-report` or `heating-schedule`.",
    );
  }
  return name;
}

/**
 * Quote a description for YAML frontmatter.
 *
 * A description arrives as free text and routinely contains a colon ("Use
 * when: ..."), which would silently break the frontmatter and make pi drop the
 * skill — a skill missing a description is not loaded at all. A JSON string is
 * a valid YAML double-quoted scalar, so this both escapes and quotes it.
 */
function yamlString(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " ").trim());
}

export function channelSkillDir(channel: ResolvedChannel, name: string): string {
  return join(channel.paths.skills, name);
}

export interface WriteSkillInput {
  name: string;
  description: string;
  instructions: string;
}

/** Validate and render a skill into the exact SKILL.md text. Throws on bad input. */
export function renderSkillMarkdown(input: WriteSkillInput): { name: string; content: string } {
  const name = validateSkillName(input.name);

  const description = input.description.replace(/\s+/g, " ").trim();
  if (!description) {
    throw new Error(
      "A skill needs a description saying what it does and when to use it — that is the only " +
        "part always in context, and it is what decides whether the skill is ever loaded.",
    );
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new Error(`Skill descriptions are at most ${MAX_DESCRIPTION} characters.`);
  }

  const instructions = input.instructions.trim();
  if (!instructions) throw new Error("A skill needs instructions in its body.");

  return {
    name,
    content: `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${instructions}\n`,
  };
}

function assertNotSymlink(path: string, what: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${what} is a symlink; refusing to write through it.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Write one skill under `skillsRoot` atomically: a concurrent reader (another
 * channel loading a shared collection) sees the old file or the new one, never
 * half of one. Returns the SKILL.md path and its sha256.
 */
export function writeSkillAt(skillsRoot: string, input: WriteSkillInput): { path: string; sha256: string } {
  const { name, content } = renderSkillMarkdown(input);
  assertNotSymlink(skillsRoot, "The skills directory");
  const dir = join(skillsRoot, name);
  assertNotSymlink(dir, `The skill directory \`${name}\``);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  assertNotSymlink(path, "SKILL.md");
  // Hidden temp name: pi only discovers SKILL.md, so a crash leaves nothing it would load.
  const tmp = join(dir, `.SKILL.md.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return { path, sha256: createHash("sha256").update(content).digest("hex") };
}

/** Remove one skill under `skillsRoot`. Returns false if there was none. */
export function deleteSkillAt(skillsRoot: string, rawName: string): boolean {
  const name = validateSkillName(rawName);
  assertNotSymlink(skillsRoot, "The skills directory");
  const dir = join(skillsRoot, name);
  assertNotSymlink(dir, `The skill directory \`${name}\``);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Write (or replace) one of this channel's own skills. Returns its SKILL.md path. */
export function writeChannelSkill(channel: ResolvedChannel, input: WriteSkillInput): string {
  return writeSkillAt(channel.paths.skills, input).path;
}

/** Remove one of this channel's own skills. Returns false if it had none by that name. */
export function deleteChannelSkill(channel: ResolvedChannel, rawName: string): boolean {
  return deleteSkillAt(channel.paths.skills, rawName);
}

// --- Collections (rw channels) --------------------------------------------

function writableCollection(channel: ResolvedChannel, rawName: string): ResolvedCollection {
  const name = rawName.trim();
  const collection = (channel.skillCollections ?? []).find((c) => c.name === name);
  if (!collection) {
    throw new Error(`This channel has no skill collection called \`${name}\`.`);
  }
  if (collection.mode !== "rw") {
    throw new Error(
      `The skill collection \`${name}\` is read-only in this channel. An operator can grant read-write ` +
        "access in config (share.skillCollections), but that changes what every channel holding it runs.",
    );
  }
  return collection;
}

/** Write a skill into a collection this channel holds read-write. Provenance is logged first. */
export function writeCollectionSkill(
  channel: ResolvedChannel,
  collectionName: string,
  input: WriteSkillInput,
): string {
  const collection = writableCollection(channel, collectionName);
  const { name, content } = renderSkillMarkdown(input); // validate before logging
  appendSkillWrite(channel.shared.skillWriteLog, {
    kind: "collection-skill",
    action: "write",
    actor: channel.ref.id,
    target: collection.name,
    skill: name,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  return writeSkillAt(collection.dir, input).path;
}

/** Delete a skill from a collection this channel holds read-write. */
export function deleteCollectionSkill(channel: ResolvedChannel, collectionName: string, rawName: string): boolean {
  const collection = writableCollection(channel, collectionName);
  const name = validateSkillName(rawName);
  appendSkillWrite(channel.shared.skillWriteLog, {
    kind: "collection-skill",
    action: "delete",
    actor: channel.ref.id,
    target: collection.name,
    skill: name,
  });
  return deleteSkillAt(collection.dir, name);
}

// --- Admin channel: other channels' own skills ----------------------------

/**
 * Resolve the channel an admin call addresses. Only a real, already-existing
 * channel directory is accepted: the id must be a Slack id (so no `..`, no
 * absolute path), it must have a directory under `channels/`, and a name is
 * only understood through the registry the harness itself maintains.
 */
export function adminTargetPaths(admin: ResolvedChannel, rawTarget: string): { id: string; skills: string } {
  if (!admin.admin) {
    throw new Error("Only the admin channel may manage other channels' skills.");
  }
  const dataDir = dirname(admin.shared.root);
  const id = new ChannelRegistry(dataDir).resolveId(rawTarget.trim());
  if (!id || !isSlackChannelId(id)) {
    throw new Error(`\`${rawTarget}\` is not a known channel. Use its Slack id (like C0123ABCD) or its name.`);
  }
  const paths = channelPaths(dataDir, id);
  if (!existsSync(paths.root) || !lstatSync(paths.root).isDirectory()) {
    throw new Error(`No channel \`${id}\` exists in this harness (it has never been used).`);
  }
  return { id, skills: paths.skills };
}

export function adminWriteChannelSkill(admin: ResolvedChannel, target: string, input: WriteSkillInput): string {
  const { id, skills } = adminTargetPaths(admin, target);
  const { name, content } = renderSkillMarkdown(input);
  appendSkillWrite(admin.shared.skillWriteLog, {
    kind: "channel-skill",
    action: "write",
    actor: admin.ref.id,
    target: id,
    skill: name,
    sha256: createHash("sha256").update(content).digest("hex"),
    admin: true,
  });
  return writeSkillAt(skills, input).path;
}

export function adminDeleteChannelSkill(admin: ResolvedChannel, target: string, rawName: string): boolean {
  const { id, skills } = adminTargetPaths(admin, target);
  const name = validateSkillName(rawName);
  appendSkillWrite(admin.shared.skillWriteLog, {
    kind: "channel-skill",
    action: "delete",
    actor: admin.ref.id,
    target: id,
    skill: name,
    admin: true,
  });
  return deleteSkillAt(skills, name);
}

/** List another channel's own skills (not its collections or built-ins). */
export function adminListChannelSkills(admin: ResolvedChannel, target: string): SkillSummary[] {
  const { skills } = adminTargetPaths(admin, target);
  if (!existsSync(skills)) return [];
  return loadSkillsFromDir({ dir: skills, source: skills })
    .skills.filter((s) => !skillFileEscapes(s.filePath, skills))
    .map((s) => ({ name: s.name, description: s.description, origin: "channel" as const, path: s.filePath }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function adminReadChannelSkill(admin: ResolvedChannel, target: string, rawName: string): string {
  const { skills } = adminTargetPaths(admin, target);
  const name = validateSkillName(rawName);
  const file = join(skills, name, "SKILL.md");
  if (skillFileEscapes(file, skills) || !existsSync(file)) {
    throw new Error(`That channel has no skill called \`${name}\`.`);
  }
  return readFileSync(file, "utf-8");
}

// --- Loading and listing ---------------------------------------------------

function within(file: string, dir: string): boolean {
  const d = dir.endsWith(sep) ? dir : dir + sep;
  return file.startsWith(d);
}

/**
 * Drop skills that, after symlinks are followed, are not inside the
 * directory they were discovered under. pi follows symlinks, so a link
 * planted in a writable collection could otherwise surface another channel's
 * files in every prompt that loads it.
 */
export function withoutEscapingSkills<T extends { filePath: string }>(channel: ResolvedChannel, skills: T[]): T[] {
  const roots = [channel.paths.skills, ...(channel.skillCollections ?? []).map((c) => c.dir)];
  return skills.filter((skill) => {
    const root = roots.find((r) => within(skill.filePath, r));
    if (!root) return true; // built-in / factory: the harness's own, reviewed in git
    if (!skillFileEscapes(skill.filePath, root)) return true;
    logger.error(`skill ${skill.filePath} resolves outside ${root} through a symlink; not loaded`);
    return false;
  });
}

/**
 * Every skill available in this channel, with where it came from.
 *
 * Uses pi's own loader, so what this lists is what the model is actually told
 * about — including the name and description as pi parsed them, rather than as
 * the directory happens to be called. A malformed skill is logged and
 * skipped; it never breaks the channel or hides its neighbours.
 */
export function loadAvailableSkills(channel: ResolvedChannel): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];

  for (const dir of channel.skillPaths) {
    if (!existsSync(dir)) continue;
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: dir });
    for (const d of diagnostics) logger.warn(`skill ${d.path ?? dir}: ${d.message}`);
    for (const skill of withoutEscapingSkills(channel, skills)) {
      // pi keeps the first skill found on a name collision, and this channel's
      // own directory is first in skillPaths — so a channel can refine a shared
      // skill by writing its own of the same name. Between collections the
      // earlier assignment in config wins.
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }

  return out;
}

/**
 * The skills a role's instructions tell it to follow that the harness ships for an agent set. A shipped skill reaches a channel only
 * through an agent set of the SAME NAME as its folder (`agent-set-skills/software_factory/` loads for a set called `software_factory`),
 * so an operator who calls the set something else gets roles that name skills nobody gave them. This names them.
 */
export function shippedAgentSetSkills(): Map<string, string> {
  const shipped = new Map<string, string>();
  try {
    for (const set of readdirSync(AGENT_SET_SKILLS_DIR, { withFileTypes: true })) {
      if (!set.isDirectory()) continue;
      for (const skill of readdirSync(join(AGENT_SET_SKILLS_DIR, set.name), { withFileTypes: true })) {
        if (skill.isDirectory() && existsSync(join(AGENT_SET_SKILLS_DIR, set.name, skill.name, "SKILL.md"))) shipped.set(skill.name, set.name);
      }
    }
  } catch { /* no shipped skills on disk: nothing is named */ }
  return shipped;
}

export interface RoleSkillGap {
  agent: string;
  /** Shipped skills the role's instructions name that this channel cannot load. */
  skills: string[];
  /** A role that only runs with a person's approval (a deployer): its instructions say to stop when a skill is missing, so it will. */
  requireApproval: boolean;
}

/**
 * Which roles are told to follow a shipped agent-set skill this channel does not have. `available` is the skill names the channel
 * can load; by default it is read from disk.
 */
export function roleSkillGaps(channel: Pick<ResolvedChannel, "agents">, available: ReadonlySet<string>): RoleSkillGap[] {
  const shipped = shippedAgentSetSkills();
  const gaps: RoleSkillGap[] = [];
  for (const agent of channel.agents) {
    const named = new Set<string>();
    for (const match of (agent.instructions ?? "").matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)) if (shipped.has(match[1]!)) named.add(match[1]!);
    const missing = [...named].filter((name) => !available.has(name));
    if (missing.length > 0) gaps.push({ agent: agent.name, skills: missing, requireApproval: agent.requireApproval });
  }
  return gaps;
}

/** The explanation, with the cause an operator can act on. */
export function roleSkillGapMessage(channel: Pick<ResolvedChannel, "agentSet">, gaps: readonly RoleSkillGap[]): string {
  const shipped = shippedAgentSetSkills();
  const skills = [...new Set(gaps.flatMap((gap) => gap.skills))];
  const homes = [...new Set(skills.map((name) => shipped.get(name)).filter((name): name is string => name !== undefined))];
  const set = channel.agentSet ? `this channel's agent set is "${channel.agentSet}"` : "this channel has no agent set";
  return `${gaps.map((gap) => `\`${gap.agent}\``).join(", ")} ${gaps.length === 1 ? "is" : "are"} told to follow ${skills.map((name) => `\`${name}\``).join(", ")}, ` +
    `which the channel cannot load. They ship with the harness in ${homes.map((name) => `agent-set-skills/${name}/`).join(", ")}, and load only for an agent set named exactly ${homes.map((name) => `\`${name}\``).join(" or ")}; ${set}. ` +
    "Name the agent set that, or save copies of the skills into this channel's own skills.";
}

/** The skills the channel can load right now, by name. Read from disk. */
export function availableSkillNames(channel: ResolvedChannel): Set<string> {
  return new Set(loadAvailableSkills(channel).map((skill) => skill.name));
}

export function listSkills(channel: ResolvedChannel): SkillSummary[] {
  return loadAvailableSkills(channel)
    .map((skill): SkillSummary => {
      const collection = (channel.skillCollections ?? []).find((c) => within(skill.filePath, c.dir));
      return {
        name: skill.name,
        description: skill.description,
        origin: within(skill.filePath, channel.paths.skills)
          ? "channel"
          : within(skill.filePath, BUILTIN_SKILLS_DIR) || within(skill.filePath, FACTORY_SKILLS_DIR) || within(skill.filePath, ADMIN_SKILLS_DIR) || within(skill.filePath, AGENT_SET_SKILLS_DIR)
            ? "builtin"
            : "shared",
        ...(collection ? { collection: collection.name } : {}),
        path: skill.filePath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Group a listing by where each skill lives: a collection name, "channel" or "builtin". */
export function groupSkillsByCollection(skills: SkillSummary[]): Record<string, SkillSummary[]> {
  const groups: Record<string, SkillSummary[]> = {};
  for (const skill of skills) {
    const key = skill.collection ?? (skill.origin === "shared" ? "shared" : skill.origin);
    (groups[key] ??= []).push(skill);
  }
  return groups;
}

/**
 * What the resource loader hands the model: unsafe skills removed and, when
 * bash runs in a container, each skill's location rewritten to the path it
 * has INSIDE that container (`/skills/channel/<s>/SKILL.md`,
 * `/skills/<collection>/<s>/SKILL.md`). The jail translates the same prefixes
 * back for file tools, so one path works for both `read` and `cat`.
 */
export function presentSkills<T extends { filePath: string; baseDir: string }>(
  channel: ResolvedChannel,
  skills: T[],
): T[] {
  const safe = withoutEscapingSkills(channel, skills);
  if (!isContainerMode(channel.sandbox?.mode)) return safe;
  const mounts = (channel.containerMounts ?? []).filter((m) => m.kind !== "global-bin");
  return safe.map((skill) => {
    const mount = mounts.find((m) => within(skill.filePath, m.hostPath));
    if (!mount) return skill;
    const swap = (p: string) => mount.containerPath + p.slice(mount.hostPath.length);
    return { ...skill, filePath: swap(skill.filePath), baseDir: swap(skill.baseDir) };
  });
}

/** In-container prefix -> host directory pairs the jail should translate (container modes only). */
export function containerPathAliases(channel: ResolvedChannel): { from: string; to: string }[] {
  if (!isContainerMode(channel.sandbox?.mode)) return [];
  return (channel.containerMounts ?? []).map((m) => ({ from: m.containerPath, to: m.hostPath }));
}

export interface SkillToolsContext {
  channel: ResolvedChannel;
  /**
   * Re-scan the channel's skill directory. A skill written mid-conversation is
   * only in the next turn's system prompt if the resource loader has seen it.
   */
  reload: () => Promise<void>;
}

export function createSkillTools(ctx: SkillToolsContext): ToolDefinition[] {
  const save = defineTool({
    name: "save_skill",
    label: "Save a skill",
    description:
      "Write down how to do something, so you can do it the same way next time. " +
      "Use this when you work out a procedure worth repeating: the steps for a recurring report, " +
      "how a particular system here actually behaves, a format someone asked you to always use. " +
      "Saving under an existing name replaces it, which is how you refine a skill as you learn more. " +
      "For a one-off fact use `remember` instead — skills are for procedures, memory is for facts.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short identifier: lowercase letters, numbers and single hyphens, e.g. `weekly-report`.",
      }),
      description: Type.String({
        description:
          "One or two sentences on what the skill does and when to use it. This is the only part " +
          "always in your context, so it is what decides whether you ever load the skill. Be specific.",
      }),
      instructions: Type.String({
        description:
          "The skill itself, in Markdown: the steps to follow, what to watch out for, worked examples. " +
          "Write it for yourself on a day when you have forgotten this conversation entirely.",
      }),
    }),
    execute: async (
      _id,
      params: { name: string; description: string; instructions: string },
    ) => {
      // Shadowing a shared skill is allowed — the channel's own copy wins, and
      // adapting a catalogue skill locally is a reasonable thing to want. It
      // should just be said out loud rather than happening invisibly.
      const existing = listSkills(ctx.channel).find(
        (s) => s.name === params.name.trim().toLowerCase(),
      );

      const path = writeChannelSkill(ctx.channel, params);
      await ctx.reload();

      const verb = existing?.origin === "channel" ? "Updated" : "Saved";
      const note =
        existing?.origin === "shared"
          ? " This channel now has its own version of a shared skill of the same name, which takes precedence here."
          : existing?.origin === "builtin"
            ? " This channel now has its own version of a built-in skill of the same name, which takes precedence here."
            : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${verb} the skill \`${params.name}\`.${note} ` +
              "It is available from your next message onwards — you already know what it says, " +
              "so carry on rather than reading it back.",
          },
        ],
        details: { path },
      };
    },
  });

  const forget = defineTool({
    name: "delete_skill",
    label: "Delete a skill",
    description:
      "Delete one of this channel's own skills, when it has been superseded or turned out to be wrong. " +
      "Skills from the shared catalogue belong to the account and cannot be deleted here.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the skill to delete." }),
    }),
    execute: async (_id, params: { name: string }) => {
      const removed = deleteChannelSkill(ctx.channel, params.name);
      if (!removed) {
        const other = listSkills(ctx.channel).find(
          (s) => s.name === params.name.trim().toLowerCase() && s.origin !== "channel",
        );
        throw new Error(
          other?.origin === "shared"
            ? `\`${params.name}\` is a shared skill from the account catalogue, so this channel cannot delete it. An operator manages those.`
            : other?.origin === "builtin"
              ? `\`${params.name}\` ships with the harness and is available in every channel, so this channel cannot delete it. Saving a skill of the same name replaces it here.`
              : `This channel has no skill called \`${params.name}\`.`,
        );
      }
      await ctx.reload();
      return {
        content: [{ type: "text" as const, text: `Deleted the skill \`${params.name}\`.` }],
        details: { name: params.name },
      };
    },
  });

  const tools: ToolDefinition[] = [save, forget] as ToolDefinition[];

  // Read-write collections: a deliberate, rare grant. Only present when this
  // channel actually holds one, so an ordinary channel's tool list is unchanged.
  const rwCollections = (ctx.channel.skillCollections ?? []).filter((c) => c.mode === "rw");
  if (rwCollections.length > 0) {
    const names = rwCollections.map((c) => c.name);
    const saveToCollection = defineTool({
      name: "save_collection_skill",
      label: "Save a skill into a shared collection",
      description:
        "Write (or replace) a skill in a shared skill collection you hold read-write: " +
        `${names.map((n) => `\`${n}\``).join(", ")}. Every channel that holds the collection will follow it, ` +
        "so only save what is correct for all of them, and never include secrets or channel-specific detail. " +
        "Every write is logged with your channel. For a skill only this channel needs, use `save_skill`.",
      parameters: Type.Object({
        collection: Type.String({ description: `One of: ${names.join(", ")}.` }),
        name: Type.String({ description: "Skill identifier: lowercase letters, numbers and single hyphens." }),
        description: Type.String({ description: "What the skill does and when to use it." }),
        instructions: Type.String({ description: "The skill body, in Markdown." }),
      }),
      execute: async (_id, params: { collection: string; name: string; description: string; instructions: string }) => {
        const path = writeCollectionSkill(ctx.channel, params.collection, params);
        await ctx.reload();
        return {
          content: [
            {
              type: "text" as const,
              text: `Saved \`${params.name}\` in the \`${params.collection}\` collection. Other channels holding it pick it up on their next session.`,
            },
          ],
          details: { path },
        };
      },
    });
    const deleteFromCollection = defineTool({
      name: "delete_collection_skill",
      label: "Delete a skill from a shared collection",
      description:
        `Delete a skill from a shared collection you hold read-write (${names.join(", ")}). ` +
        "This removes it for every channel that holds the collection. The deletion is logged.",
      parameters: Type.Object({
        collection: Type.String({ description: `One of: ${names.join(", ")}.` }),
        name: Type.String({ description: "Name of the skill to delete." }),
      }),
      execute: async (_id, params: { collection: string; name: string }) => {
        const removed = deleteCollectionSkill(ctx.channel, params.collection, params.name);
        if (!removed) throw new Error(`The \`${params.collection}\` collection has no skill called \`${params.name}\`.`);
        await ctx.reload();
        return {
          content: [{ type: "text" as const, text: `Deleted \`${params.name}\` from the \`${params.collection}\` collection.` }],
          details: { collection: params.collection, name: params.name },
        };
      },
    });
    tools.push(saveToCollection, deleteFromCollection as ToolDefinition);
  }

  // The admin channel only: manage OTHER channels' own skills by channel id.
  if (ctx.channel.admin) {
    const target = Type.String({ description: "The other channel's Slack id (like C0123ABCD) or its name." });
    tools.push(
      defineTool({
        name: "admin_list_channel_skills",
        label: "List another channel's skills",
        description: "List the skills another channel wrote for itself (not its shared collections or built-ins). Admin channel only.",
        parameters: Type.Object({ channel: target }),
        execute: async (_id, params: { channel: string }) => {
          const skills = adminListChannelSkills(ctx.channel, params.channel);
          return {
            content: [
              {
                type: "text" as const,
                text: skills.length
                  ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
                  : "That channel has no skills of its own.",
              },
            ],
            details: { channel: params.channel, count: skills.length },
          };
        },
      }),
      defineTool({
        name: "admin_read_channel_skill",
        label: "Read another channel's skill",
        description: "Read the full SKILL.md of a skill another channel wrote for itself. Admin channel only.",
        parameters: Type.Object({ channel: target, name: Type.String({ description: "Skill name." }) }),
        execute: async (_id, params: { channel: string; name: string }) => ({
          content: [{ type: "text" as const, text: adminReadChannelSkill(ctx.channel, params.channel, params.name) }],
          details: { channel: params.channel, name: params.name },
        }),
      }),
      defineTool({
        name: "admin_save_channel_skill",
        label: "Write a skill into another channel",
        description:
          "Write (or replace) a skill in ANOTHER channel's own skills. That channel's agent will follow it from its next " +
          "session, so write it as if for that channel alone and never include secrets. Logged with your channel as the actor. Admin channel only.",
        parameters: Type.Object({
          channel: target,
          name: Type.String({ description: "Skill identifier: lowercase letters, numbers and single hyphens." }),
          description: Type.String({ description: "What the skill does and when to use it." }),
          instructions: Type.String({ description: "The skill body, in Markdown." }),
        }),
        execute: async (_id, params: { channel: string; name: string; description: string; instructions: string }) => {
          const path = adminWriteChannelSkill(ctx.channel, params.channel, params);
          return {
            content: [
              {
                type: "text" as const,
                text: `Saved \`${params.name}\` in channel ${params.channel}. It is loaded the next time that channel starts a session.`,
              },
            ],
            details: { path },
          };
        },
      }),
      defineTool({
        name: "admin_delete_channel_skill",
        label: "Delete a skill from another channel",
        description: "Delete a skill another channel wrote for itself. Logged. Admin channel only.",
        parameters: Type.Object({ channel: target, name: Type.String({ description: "Skill name." }) }),
        execute: async (_id, params: { channel: string; name: string }) => {
          const removed = adminDeleteChannelSkill(ctx.channel, params.channel, params.name);
          if (!removed) throw new Error(`Channel ${params.channel} has no skill called \`${params.name}\`.`);
          return {
            content: [{ type: "text" as const, text: `Deleted \`${params.name}\` from channel ${params.channel}.` }],
            details: { channel: params.channel, name: params.name },
          };
        },
      }),
    );
  }

  return tools;
}
