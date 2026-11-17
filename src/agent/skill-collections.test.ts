import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  adminDeleteChannelSkill,
  adminListChannelSkills,
  adminReadChannelSkill,
  adminWriteChannelSkill,
  createSkillTools,
  deleteChannelSkill,
  deleteCollectionSkill,
  groupSkillsByCollection,
  listSkills,
  loadAvailableSkills,
  writeChannelSkill,
  writeCollectionSkill,
  BUILTIN_SKILLS_DIR,
} from "./skills.ts";
import { checkPath } from "./jail.ts";
import { workspaceFixture } from "../workspace/fixture.ts";
import {
  findLegacyFlatSkills,
  migrateFlatSkills,
  resetLegacyWarnings,
  validateCollectionName,
} from "../workspace/collections.ts";

const skill = (name: string, description = `${name}. Use when needed.`) => ({
  name,
  description,
  instructions: `Steps for ${name}.`,
});

const jailOf = (c: ReturnType<ReturnType<typeof workspaceFixture>["resolve"]>) => ({
  readRoots: c.jail.readRoots,
  writeRoots: c.jail.writeRoots,
  cwd: c.paths.workspace,
});

const toolNames = (c: ReturnType<ReturnType<typeof workspaceFixture>["resolve"]>) =>
  createSkillTools({ channel: c, reload: async () => {} }).map((t) => t.name);

// ---- Row 1: per-channel skills, channel agent or admin agent ---------------

test("row 1: a channel writes, lists and deletes only its own skills; names cannot address elsewhere", () => {
  const f = workspaceFixture({ channels: { C1: {}, C2: {} } });
  const a = f.resolve("C1");
  const b = f.resolve("C2");

  writeChannelSkill(a, skill("alpha"));
  assert.deepEqual(listSkills(a).filter((s) => s.origin === "channel").map((s) => s.name), ["alpha"]);
  assert.deepEqual(listSkills(b).filter((s) => s.origin === "channel"), [], "C2 must not see C1's skill");

  for (const bad of ["../../C2/skills/x", "/etc/x", "a/b", "..", ".", "x\0y", ""]) {
    assert.throws(() => writeChannelSkill(a, skill(bad)), /./, `name ${JSON.stringify(bad)} must be refused`);
    assert.throws(() => deleteChannelSkill(a, bad));
  }
  assert.deepEqual(readdirSync(b.paths.skills), [], "nothing leaked into C2");

  assert.equal(deleteChannelSkill(a, "alpha"), true);
  assert.equal(deleteChannelSkill(a, "alpha"), false);
});

test("row 1: a symlinked skill directory is never written through", () => {
  const f = workspaceFixture({ channels: { C1: {}, C2: {} } });
  const a = f.resolve("C1");
  const b = f.resolve("C2");
  symlinkSync(b.paths.skills, join(a.paths.skills, "evil"));
  assert.throws(() => writeChannelSkill(a, skill("evil")), /symlink/);
  assert.deepEqual(readdirSync(b.paths.skills), []);
  assert.throws(() => deleteChannelSkill(a, "evil"), /symlink/);
});

test("row 1: the admin channel manages another channel's skills; everyone else is refused", () => {
  const f = workspaceFixture({ channels: { C1ADMIN: { admin: true }, C2: {}, C3: {} } });
  const admin = f.resolve("C1ADMIN");
  const b = f.resolve("C2");
  const c = f.resolve("C3");
  assert.equal(admin.admin, true);
  assert.equal(b.admin, false);

  // Tools exist only on the admin channel.
  assert.ok(toolNames(admin).includes("admin_save_channel_skill"));
  assert.ok(!toolNames(b).includes("admin_save_channel_skill"));
  assert.ok(!toolNames(b).some((n) => n.startsWith("admin_")));

  // Round-trips through the frontmatter even with a colon in the description.
  adminWriteChannelSkill(admin, "C2", skill("deploy", "Deploy steps. Use when: asked to ship."));
  const loaded = listSkills(f.resolve("C2")).find((s) => s.name === "deploy");
  assert.equal(loaded?.origin, "channel", "loaded by B's next resolve");
  assert.match(loaded!.description, /Use when: asked to ship/);
  assert.deepEqual(adminListChannelSkills(admin, "C2").map((s) => s.name), ["deploy"]);
  assert.match(adminReadChannelSkill(admin, "C2", "deploy"), /Steps for deploy/);
  assert.deepEqual(listSkills(c).filter((s) => s.origin === "channel"), [], "C3 unaffected");

  // Non-admin attempts, through the same functions the tools call.
  assert.throws(() => adminWriteChannelSkill(b, "C3", skill("pwn")), /Only the admin channel/);
  assert.throws(() => adminDeleteChannelSkill(b, "C2", "deploy"), /Only the admin channel/);
  assert.throws(() => adminListChannelSkills(b, "C3"), /Only the admin channel/);
  assert.throws(() => adminReadChannelSkill(b, "C2", "deploy"), /Only the admin channel/);
  assert.ok(existsSync(join(b.paths.skills, "deploy", "SKILL.md")), "refused delete left the skill");

  // Unknown / malformed channel ids.
  for (const bad of ["C9NEVERSEEN", "../C2", "/etc", "C2/../C3", "", "nonexistent-name"]) {
    assert.throws(() => adminWriteChannelSkill(admin, bad, skill("x")), /./, `target ${JSON.stringify(bad)}`);
  }

  // Provenance names the actor, target and hash.
  assert.equal(adminDeleteChannelSkill(admin, "C2", "deploy"), true);
  const log = readFileSync(f.shared.skillWriteLog, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => [r.kind, r.action, r.actor, r.target, r.skill]), [
    ["channel-skill", "write", "C1ADMIN", "C2", "deploy"],
    ["channel-skill", "delete", "C1ADMIN", "C2", "deploy"],
  ]);
  assert.match(log[0].sha256, /^[a-f0-9]{64}$/);
});

test("row 1: a channel's own skill shadows a collection skill and a built-in of the same name", () => {
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: ["tools"] } } } });
  f.addCollectionSkill("tools", "pdf", "Shared PDF skill.");
  f.addCollectionSkill("tools", "writing-skills", "Shadow of the built-in.");
  const c = f.resolve("C1");
  assert.equal(listSkills(c).find((s) => s.name === "pdf")?.origin, "shared");
  // collection beats built-in
  assert.equal(listSkills(c).find((s) => s.name === "writing-skills")?.origin, "shared");
  writeChannelSkill(c, { name: "pdf", description: "Channel PDF skill.", instructions: "mine" });
  writeChannelSkill(c, { name: "writing-skills", description: "Channel version.", instructions: "mine" });
  assert.equal(listSkills(c).find((s) => s.name === "pdf")?.origin, "channel");
  assert.equal(listSkills(c).find((s) => s.name === "writing-skills")?.origin, "channel");
});

// ---- Rows 2 & 3: global book, collections ---------------------------------

test("rows 2-3: skills load from within a collection, only when the collection is assigned", () => {
  const f = workspaceFixture({
    channels: { C1: { share: { skillCollections: ["software-development"] } }, C2: {}, C3: { share: { skillCollections: ["life-admin"] } } },
  });
  f.addCollectionSkill("software-development", "code-review");
  f.addCollectionSkill("life-admin", "taxes");
  const c1 = f.resolve("C1");
  const c2 = f.resolve("C2");
  const c3 = f.resolve("C3");

  assert.deepEqual(listSkills(c1).filter((s) => s.origin === "shared").map((s) => [s.name, s.collection]), [["code-review", "software-development"]]);
  assert.deepEqual(listSkills(c3).filter((s) => s.origin === "shared").map((s) => [s.name, s.collection]), [["taxes", "life-admin"]]);
  assert.deepEqual(listSkills(c2).filter((s) => s.origin === "shared"), []);

  // Unassigned collections are invisible everywhere: paths, jail, mounts.
  const unassigned = join(f.shared.skills, "life-admin");
  assert.ok(!c1.skillPaths.includes(unassigned));
  assert.ok(!c1.jail.readRoots.includes(unassigned));
  assert.ok(!c1.containerMounts.some((m) => m.hostPath === unassigned || m.containerPath === "/skills/life-admin"));
  assert.equal(checkPath(jailOf(c1), join(unassigned, "taxes", "SKILL.md"), "read").allowed, false);
  assert.equal(checkPath(jailOf(c1), f.shared.skills, "read").allowed, false, "the whole catalogue is not a read root");

  // Listing groups by collection.
  const groups = groupSkillsByCollection(listSkills(c1));
  assert.deepEqual(Object.keys(groups).sort(), ["builtin", "software-development"]);
});

test("row 3: a collection name collision resolves deterministically in config order", () => {
  const order = (names: string[]) => {
    const f = workspaceFixture({ channels: { C1: { share: { skillCollections: names } } } });
    f.addCollectionSkill("alpha", "dup", "From alpha.");
    f.addCollectionSkill("beta", "dup", "From beta.");
    return listSkills(f.resolve("C1")).find((s) => s.name === "dup")!.collection;
  };
  assert.equal(order(["alpha", "beta"]), "alpha");
  assert.equal(order(["beta", "alpha"]), "beta");
});

test("rows 2-3: a malformed global skill is skipped without breaking its neighbours", () => {
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: ["tools"] } } } });
  f.addCollectionSkill("tools", "good");
  const bad = join(f.shared.skills, "tools", "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "SKILL.md"), "---\nname: bad\ndescription: [unterminated\n---\nbody");
  const none = join(f.shared.skills, "tools", "nodesc");
  mkdirSync(none, { recursive: true });
  writeFileSync(join(none, "SKILL.md"), "---\nname: nodesc\n---\nbody");
  const names = loadAvailableSkills(f.resolve("C1")).map((s) => s.name);
  assert.ok(names.includes("good"));
  assert.ok(!names.includes("bad") && !names.includes("nodesc"));
});

test("row 3: invalid collection names are rejected and a missing collection is skipped, never created", () => {
  for (const bad of ["../x", "a/b", "Up", "", "channel", "builtin", ".h", "a--b"]) {
    assert.throws(() => validateCollectionName(bad), /./, bad);
  }
  assert.equal(validateCollectionName("software-development"), "software-development");
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: [{ name: "typo", mode: "rw" }] } } } });
  const c = f.resolve("C1");
  assert.deepEqual(c.skillCollections, []);
  assert.equal(existsSync(join(f.shared.skills, "typo")), false, "a typo must not conjure a writable collection");
});

test("row 3: the flat legacy layout is rejected with an error, and migrate-skills moves it into a collection", () => {
  resetLegacyWarnings();
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: ["default"] } } } });
  // legacy: shared/skills/<name>/SKILL.md
  const legacy = join(f.shared.skills, "pdf");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "SKILL.md"), '---\nname: pdf\ndescription: "Old flat skill."\n---\nbody');
  assert.deepEqual(findLegacyFlatSkills(f.shared.skills), ["pdf"]);

  // Not loaded, even though "default" is assigned (and does not exist yet).
  assert.ok(!listSkills(f.resolve("C1")).some((s) => s.name === "pdf"));
  // Naming the legacy dir as a collection is refused too: it is a skill, not a collection.
  f.reconfigure({ channels: { C1: { share: { skillCollections: ["pdf"] } } } });
  assert.deepEqual(f.resolve("C1").skillCollections, []);

  assert.deepEqual(migrateFlatSkills(f.shared.skills), ["pdf"]);
  assert.ok(existsSync(join(f.shared.skills, "default", "pdf", "SKILL.md")));
  assert.equal(existsSync(legacy), false);
  assert.deepEqual(findLegacyFlatSkills(f.shared.skills), []);
  f.reconfigure({ channels: { C1: { share: { skillCollections: ["default"] } } } });
  assert.equal(listSkills(f.resolve("C1")).find((s) => s.name === "pdf")?.collection, "default");
  assert.deepEqual(migrateFlatSkills(f.shared.skills), [], "idempotent");
});

test("row 3: migration never overwrites and moves nothing when a destination exists", () => {
  const f = workspaceFixture({});
  f.resolve("C1");
  for (const name of ["one", "two"]) {
    mkdirSync(join(f.shared.skills, name), { recursive: true });
    writeFileSync(join(f.shared.skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
  }
  mkdirSync(join(f.shared.skills, "default", "two"), { recursive: true });
  assert.throws(() => migrateFlatSkills(f.shared.skills), /already exists/);
  assert.ok(existsSync(join(f.shared.skills, "one", "SKILL.md")), "nothing moved");
  assert.ok(existsSync(join(f.shared.skills, "two", "SKILL.md")));
});

test("row 3: a skill named like its own collection migrates cleanly", () => {
  const f = workspaceFixture({});
  f.resolve("C1");
  mkdirSync(join(f.shared.skills, "default"), { recursive: true });
  writeFileSync(join(f.shared.skills, "default", "SKILL.md"), "---\nname: default\ndescription: d\n---\n");
  assert.deepEqual(migrateFlatSkills(f.shared.skills), ["default"]);
  assert.ok(existsSync(join(f.shared.skills, "default", "default", "SKILL.md")));
});

// ---- Row 4: collection assignment, ro / rw --------------------------------

test("row 4: read-only is the default and every write path refuses it", () => {
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: ["tools", { name: "docs", mode: "ro" }] } } } });
  f.addCollectionSkill("tools", "existing");
  f.addCollectionSkill("docs", "existing-doc");
  const c = f.resolve("C1");
  assert.deepEqual(c.skillCollections.map((x) => [x.name, x.mode]), [["tools", "ro"], ["docs", "ro"]]);

  // tool path: no collection write tools at all, and the functions refuse
  assert.ok(!toolNames(c).includes("save_collection_skill"));
  assert.throws(() => writeCollectionSkill(c, "tools", skill("x")), /read-only/);
  assert.throws(() => deleteCollectionSkill(c, "tools", "existing"), /read-only/);
  assert.ok(existsSync(join(f.shared.skills, "tools", "existing", "SKILL.md")));
  assert.equal(existsSync(f.shared.skillWriteLog), false, "refused writes are not logged as writes");

  // file tools (host jail): readable, not writable, including through a workspace symlink
  const skillFile = join(f.shared.skills, "tools", "existing", "SKILL.md");
  assert.equal(checkPath(jailOf(c), skillFile, "read").allowed, true);
  assert.equal(checkPath(jailOf(c), skillFile, "write").allowed, false);
  assert.equal(checkPath(jailOf(c), join(f.shared.skills, "tools", "new", "SKILL.md"), "write").allowed, false);
  symlinkSync(join(f.shared.skills, "tools"), join(c.paths.workspace, "link"));
  assert.equal(checkPath(jailOf(c), join(c.paths.workspace, "link", "existing", "SKILL.md"), "write").allowed, false);
  assert.equal(checkPath(jailOf(c), join(c.paths.workspace, "link", "x", "SKILL.md"), "write").allowed, false);

  // container mount: read-only
  for (const m of c.containerMounts.filter((x) => x.kind === "collection")) assert.equal(m.readOnly, true);
});

test("row 4: a read-write channel writes only collections assigned rw, and every write is logged", () => {
  const f = workspaceFixture({
    channels: {
      C1: { share: { skillCollections: [{ name: "shared-rw", mode: "rw" }, "shared-ro"] } },
      C2: { share: { skillCollections: ["shared-rw"] } },
    },
  });
  f.addCollectionSkill("shared-rw", "seed");
  f.addCollectionSkill("shared-ro", "ro-seed");
  f.addCollectionSkill("unassigned", "secret");
  const c1 = f.resolve("C1");
  assert.ok(toolNames(c1).includes("save_collection_skill"));
  assert.ok(toolNames(c1).includes("delete_collection_skill"));
  assert.ok(!toolNames(f.resolve("C2")).includes("save_collection_skill"), "ro holder gets no write tool");

  const written = writeCollectionSkill(c1, "shared-rw", skill("new-skill"));
  assert.equal(written, join(f.shared.skills, "shared-rw", "new-skill", "SKILL.md"));
  assert.throws(() => writeCollectionSkill(c1, "shared-ro", skill("x")), /read-only/);
  assert.throws(() => writeCollectionSkill(c1, "unassigned", skill("x")), /no skill collection/);
  assert.throws(() => writeCollectionSkill(c1, "../C1", skill("x")), /no skill collection/);
  assert.throws(() => writeCollectionSkill(c1, "shared-rw", skill("../escape")));
  assert.equal(existsSync(join(f.shared.skills, "unassigned", "x")), false);

  // The other channel sees the edit on its next load, and cannot change it.
  const c2 = f.resolve("C2");
  assert.ok(listSkills(c2).some((s) => s.name === "new-skill" && s.collection === "shared-rw"));
  assert.throws(() => writeCollectionSkill(c2, "shared-rw", skill("x")), /read-only/);

  assert.equal(deleteCollectionSkill(c1, "shared-rw", "new-skill"), true);
  assert.ok(!listSkills(f.resolve("C2")).some((s) => s.name === "new-skill"));

  const log = readFileSync(f.shared.skillWriteLog, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((r) => [r.kind, r.action, r.actor, r.target, r.skill]), [
    ["collection-skill", "write", "C1", "shared-rw", "new-skill"],
    ["collection-skill", "delete", "C1", "shared-rw", "new-skill"],
  ]);
});

test("row 4: concurrent writers (separate processes) never leave a torn SKILL.md", async () => {
  const f = workspaceFixture({
    channels: {
      C1: { share: { skillCollections: [{ name: "team", mode: "rw" }] } },
      C2: { share: { skillCollections: [{ name: "team", mode: "rw" }] } },
    },
  });
  f.addCollectionSkill("team", "seed");
  const teamDir = join(f.shared.skills, "team");
  const file = join(teamDir, "contested", "SKILL.md");
  const skillsModule = new URL("./skills.ts", import.meta.url).href;
  const script = `
    const { writeSkillAt } = await import(${JSON.stringify(skillsModule)});
    const id = process.argv[1];
    for (let i = 0; i < 150; i++) {
      writeSkillAt(${JSON.stringify(teamDir)}, { name: "contested", description: "contested.", instructions: "writer-" + id + "-v" + i + " " + "x".repeat(200000) });
    }
  `;
  const writers = [0, 1, 2].map(
    (id) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, String(id)], { stdio: "ignore" });
        child.on("close", resolve);
      }),
  );
  const valid = (text: string) =>
    /^---\nname: contested\ndescription: "contested\."\n---\n\nwriter-\d-v\d+ x{200000}\n$/.test(text);
  let torn = 0;
  let reads = 0;
  let done = false;
  Promise.all(writers).then(() => { done = true; });
  while (!done) {
    if (existsSync(file)) {
      reads++;
      if (!valid(readFileSync(file, "utf-8"))) torn++;
    }
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await Promise.all(writers), [0, 0, 0], "writers exited cleanly");
  assert.ok(reads > 0, "the reader overlapped with the writers");
  assert.equal(torn, 0, "a reader must never observe a partial file");
  assert.ok(valid(readFileSync(file, "utf-8")));
  assert.deepEqual(readdirSync(join(teamDir, "contested")), ["SKILL.md"], "no temp files left behind");
});

test("row 4: a symlink planted in a collection cannot pull another channel's files into a prompt", () => {
  const f = workspaceFixture({
    channels: { C1: { share: { skillCollections: ["team"] } }, C2: {} },
  });
  const victim = f.resolve("C2");
  writeChannelSkill(victim, skill("private-procedure"));
  f.addCollectionSkill("team", "fine");
  symlinkSync(join(victim.paths.skills, "private-procedure"), join(f.shared.skills, "team", "planted"));
  const names = loadAvailableSkills(f.resolve("C1")).map((s) => s.name);
  assert.ok(names.includes("fine"));
  assert.ok(!names.includes("private-procedure"), "escaping symlinked skill must not load");
});

test("row 4: mode and assignment changes take effect on the next resolve (hot reload)", () => {
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: [{ name: "team", mode: "rw" }] } } } });
  f.addCollectionSkill("team", "seed");
  assert.equal(f.resolve("C1").skillCollections[0]?.mode, "rw");
  f.reconfigure({ channels: { C1: { share: { skillCollections: ["team"] } } } });
  const demoted = f.resolve("C1");
  assert.equal(demoted.skillCollections[0]?.mode, "ro");
  assert.throws(() => writeCollectionSkill(demoted, "team", skill("x")), /read-only/);
  assert.equal(demoted.containerMounts.find((m) => m.kind === "collection")?.readOnly, true);
  f.reconfigure({ channels: { C1: {} } });
  const revoked = f.resolve("C1");
  assert.deepEqual(revoked.skillCollections, []);
  assert.ok(!listSkills(revoked).some((s) => s.name === "seed"));
  assert.ok(!revoked.jail.readRoots.includes(join(f.shared.skills, "team")));
});

test("the built-in skills directory is still last and never a write root", () => {
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: ["team"] } } } });
  f.addCollectionSkill("team", "seed");
  const c = f.resolve("C1");
  assert.equal(c.skillPaths[0], c.paths.skills);
  assert.equal(c.skillPaths[1], join(f.shared.skills, "team"));
  assert.equal(c.skillPaths[2], BUILTIN_SKILLS_DIR);
  assert.ok(!c.jail.writeRoots.includes(BUILTIN_SKILLS_DIR));
  assert.ok(!c.jail.writeRoots.includes(join(f.shared.skills, "team")));
});
