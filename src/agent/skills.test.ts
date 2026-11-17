import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_SKILLS_DIR,
  createSkillTools,
  deleteChannelSkill,
  listSkills,
  validateSkillName,
  writeChannelSkill,
} from "./skills.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * Skills are the agent's own procedural memory, so the things worth pinning
 * down are: a skill it writes is actually loadable by pi (frontmatter that
 * parses, a description that survives a colon), and it can only ever write
 * into its own channel.
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-skills-"));
  const channelSkills = join(root, "channel", "skills");
  const sharedSkills = join(root, "shared", "skills");
  mkdirSync(channelSkills, { recursive: true });
  mkdirSync(sharedSkills, { recursive: true });

  const channel = {
    paths: { skills: channelSkills },
    skillPaths: [channelSkills],
  } as unknown as ResolvedChannel;

  const addShared = (name: string, description: string) => {
    const dir = join(sharedSkills, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
    (channel as any).skillPaths = [channelSkills, dir];
  };

  return { root, channel, channelSkills, sharedSkills, addShared };
}

test("a saved skill is written where pi can load it", () => {
  const { channel } = setup();

  writeChannelSkill(channel, {
    name: "weekly-report",
    description: "Produce the Friday rollup. Use when asked for the weekly report.",
    instructions: "1. Read the open threads\n2. Summarise per project",
  });

  const found = listSkills(channel);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.name, "weekly-report");
  assert.equal(found[0]!.origin, "channel");
  assert.match(found[0]!.description, /Friday rollup/);
});

test("a description containing a colon still parses", () => {
  const { channel } = setup();

  // Unquoted, "Use when: ..." breaks the YAML and pi drops the skill entirely,
  // because a skill with no description is not loaded at all.
  writeChannelSkill(channel, {
    name: "heating",
    description: "How the heating works. Use when: someone asks why a room is cold.",
    instructions: "The upstairs valve lies.",
  });

  const found = listSkills(channel);
  assert.equal(found.length, 1, "a colon in the description must not lose the skill");
  assert.match(found[0]!.description, /why a room is cold/);
});

test("saving over a name replaces the skill rather than adding a second", () => {
  const { channel } = setup();
  const input = { name: "standup", description: "The standup format.", instructions: "v1" };

  writeChannelSkill(channel, input);
  const path = writeChannelSkill(channel, { ...input, instructions: "v2, now with links" });

  assert.equal(listSkills(channel).length, 1);
  assert.match(readFileSync(path, "utf-8"), /v2, now with links/);
});

test("skill names are held to the standard", () => {
  assert.equal(validateSkillName("Weekly-Report"), "weekly-report", "case is normalised");
  for (const bad of ["", "-leading", "trailing-", "double--hyphen", "has space", "under_score"]) {
    assert.throws(() => validateSkillName(bad), /valid skill name|needs a name/i, `accepted "${bad}"`);
  }
  assert.throws(() => validateSkillName("a".repeat(65)), /at most 64/);
});

test("a skill with no description is refused, since pi would not load it", () => {
  const { channel } = setup();

  assert.throws(
    () => writeChannelSkill(channel, { name: "x", description: "   ", instructions: "do it" }),
    /needs a description/i,
  );
  assert.throws(
    () => writeChannelSkill(channel, { name: "x", description: "fine", instructions: "  " }),
    /needs instructions/i,
  );
});

test("shared skills are listed but belong to the account", () => {
  const { channel, addShared } = setup();
  addShared("code-review", "Review a diff the way this account likes.");

  const found = listSkills(channel);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.origin, "shared");

  assert.equal(deleteChannelSkill(channel, "code-review"), false, "not this channel's to delete");
  assert.ok(existsSync(join(channel.skillPaths[1]!, "SKILL.md")), "the shared copy is untouched");
});

test("a channel's own skill shadows a shared one of the same name", () => {
  const { channel, addShared } = setup();
  addShared("code-review", "The account version.");
  writeChannelSkill(channel, {
    name: "code-review",
    description: "The version this channel actually wants.",
    instructions: "Check the migration first.",
  });

  const found = listSkills(channel);
  assert.equal(found.length, 1, "one name, one skill — pi keeps the first found");
  assert.equal(found[0]!.origin, "channel");
  assert.match(found[0]!.description, /actually wants/);
});

test("deleting removes the skill and reports when there was none", () => {
  const { channel } = setup();
  writeChannelSkill(channel, { name: "temp", description: "d", instructions: "i" });

  assert.equal(deleteChannelSkill(channel, "temp"), true);
  assert.equal(listSkills(channel).length, 0);
  assert.equal(deleteChannelSkill(channel, "temp"), false);
});

test("the save tool reloads, so a new skill is live for the next turn", async () => {
  const { channel } = setup();
  let reloads = 0;
  const [save] = createSkillTools({ channel, reload: async () => void reloads++ }) as any[];

  const result = await save.execute("id", {
    name: "weekly-report",
    description: "The Friday rollup.",
    instructions: "steps",
  });

  assert.equal(reloads, 1, "without a reload the skill is invisible until the session is evicted");
  assert.match(result.content[0].text, /Saved the skill/);
});

test("the save tool says when it is updating rather than creating", async () => {
  const { channel } = setup();
  const [save] = createSkillTools({ channel, reload: async () => {} }) as any[];
  const params = { name: "standup", description: "The format.", instructions: "steps" };

  await save.execute("id", params);
  const second = await save.execute("id", { ...params, instructions: "better steps" });

  assert.match(second.content[0].text, /Updated the skill/);
});

test("the skills shipped with the harness load, and are the harness's own", () => {
  // The failure this guards against is silent: a description that breaks the
  // YAML costs the skill its place in the prompt, and nothing says so. Every
  // channel gets these, so a broken one is broken everywhere at once.
  const { channel } = setup();
  (channel as any).skillPaths = [channel.paths.skills, BUILTIN_SKILLS_DIR];

  const found = listSkills(channel);
  assert.ok(found.length > 0, "the built-in skills must actually parse");
  for (const skill of found) {
    assert.equal(skill.origin, "builtin");
    assert.ok(skill.description.trim().length > 0);
  }

  const writing = found.find((s) => s.name === "writing-skills");
  assert.ok(writing, "the skill-writing skill is the point of shipping any");
  assert.match(writing.description, /save_skill|publish_skill/, "it has to fire before a save");
});

test("a built-in skill cannot be deleted, only replaced", async () => {
  const { channel } = setup();
  (channel as any).skillPaths = [channel.paths.skills, BUILTIN_SKILLS_DIR];
  const [save, remove] = createSkillTools({ channel, reload: async () => {} }) as any[];

  await assert.rejects(
    () => remove.execute("id", { name: "writing-skills" }),
    /ships with the harness/i,
  );

  const result = await save.execute("id", {
    name: "writing-skills",
    description: "How this channel wants skills written.",
    instructions: "Ours, not the harness's.",
  });
  assert.match(result.content[0].text, /built-in skill/i, "shadowing is said out loud");
});

test("the delete tool explains why a shared skill cannot be deleted", async () => {
  const { channel, addShared } = setup();
  addShared("code-review", "The account version.");
  const [, remove] = createSkillTools({ channel, reload: async () => {} }) as any[];

  await assert.rejects(() => remove.execute("id", { name: "code-review" }), /shared skill/i);
  await assert.rejects(() => remove.execute("id", { name: "nothing" }), /no skill called/i);
});
