import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { workspaceFixture } from "./fixture.ts";
import type { ResolvedChannel } from "./resolve.ts";
import { checkPath } from "../agent/jail.ts";
import { channelPathEnv, buildCreateArgs } from "../agent/sandbox.ts";
import { SandboxSchema } from "../config/schema.ts";
import { createExecTools } from "../agent/exec-tools.ts";
import {
  adminWriteChannelSkill,
  containerPathAliases,
  createSkillTools,
  deleteChannelSkill,
  listSkills,
  loadAvailableSkills,
  writeChannelSkill,
  writeCollectionSkill,
} from "../agent/skills.ts";

/**
 * Isolation invariants for Workstream B items 1-8, one parametrized suite:
 * a channel can never read or write another channel's skills, bin, memory or
 * workspace through ANY of these mechanisms (host here; the container half is
 * in src/agent/skills-bin.live.test.ts, which runs the same probes against a
 * real container).
 *
 * Each case is an attack launched by the attacker channel A against victim B.
 * After every attack the victim's whole directory must be byte-identical, and
 * the attack must have failed (threw, was denied, or found nothing).
 */

const MARK = "VICTIM-SECRET-MARKER";

function digest(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      h.update(p.slice(root.length) + (st.isDirectory() ? "/" : `:${st.size}:`));
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex");
}

function world() {
  const f = workspaceFixture({
    cliTools: { pooltool: { command: "/bin/echo", allowArgs: [["**"]] } },
    channels: {
      CATK: { tools: ["bash", "exec"], sandbox: { mode: "docker" }, share: { skillCollections: ["ro-coll", { name: "rw-coll", mode: "rw" }] } },
      CVIC: { tools: ["bash", "exec"], exec: { shared: ["pooltool"] }, share: { skillCollections: ["victim-coll"] } },
      CADM: { admin: true },
    },
  });
  for (const c of ["ro-coll", "rw-coll", "victim-coll", "unassigned-coll"]) f.addCollectionSkill(c, `${c}-skill`);
  const a = f.resolve("CATK");
  const b = f.resolve("CVIC");
  // victim data: skill, bin tool, memory, workspace file
  writeChannelSkill(b, { name: "victim-skill", description: "Victim.", instructions: MARK });
  writeFileSync(join(b.paths.bin, "victim-tool"), `#!/bin/sh\necho ${MARK}\n`);
  chmodSync(join(b.paths.bin, "victim-tool"), 0o755);
  writeFileSync(b.paths.memoryFile, `# memory\n${MARK}\n`);
  writeFileSync(join(b.paths.workspace, "notes.txt"), MARK);
  const jail = (c: ResolvedChannel) => ({
    readRoots: c.jail.readRoots,
    writeRoots: c.jail.writeRoots,
    cwd: c.paths.workspace,
    pathAliases: containerPathAliases(c),
  });
  return { f, a, b, jail };
}

type W = ReturnType<typeof world>;
interface Attack {
  mechanism: string;
  /** Launch the attack; resolve normally if it was (correctly) blocked, throw to signal a breach. */
  run: (w: W) => void | Promise<void>;
}

const denied = (w: W, target: string, mode: "read" | "write") =>
  assert.equal(checkPath(w.jail(w.a), target, mode).allowed, false, `${mode} ${target}`);

const attacks: Attack[] = [
  // ---- 1. per-channel skills
  { mechanism: "1 skills: file tool read of the victim's skills", run: (w) => denied(w, join(w.b.paths.skills, "victim-skill", "SKILL.md"), "read") },
  { mechanism: "1 skills: file tool write into the victim's skills", run: (w) => denied(w, join(w.b.paths.skills, "pwn", "SKILL.md"), "write") },
  {
    mechanism: "1 skills: save/delete_skill with a traversal name",
    run: (w) => {
      for (const n of ["../../CVIC/skills/victim-skill", "../CVIC/skills/x", "/etc/x"]) {
        assert.throws(() => writeChannelSkill(w.a, { name: n, description: "d", instructions: "i" }));
        assert.throws(() => deleteChannelSkill(w.a, n));
      }
    },
  },
  {
    mechanism: "1 skills: admin tools as a non-admin channel",
    run: (w) => {
      assert.ok(!createSkillTools({ channel: w.a, reload: async () => {} }).some((t) => t.name.startsWith("admin_")));
      assert.throws(() => adminWriteChannelSkill(w.a, "CVIC", { name: "pwn", description: "d", instructions: "i" }), /Only the admin/);
    },
  },
  {
    mechanism: "1 skills: symlink from own skills dir to the victim's",
    run: (w) => {
      symlinkSync(w.b.paths.skills, join(w.a.paths.skills, "link"));
      denied(w, join(w.a.paths.skills, "link", "victim-skill", "SKILL.md"), "read");
      assert.throws(() => writeChannelSkill(w.a, { name: "link", description: "d", instructions: "i" }), /symlink/);
    },
  },
  // ---- 2/3. collections
  {
    mechanism: "2-3 collections: unassigned collection is invisible and unwritable",
    run: (w) => {
      const dir = join(w.f.shared.skills, "unassigned-coll");
      denied(w, join(dir, "unassigned-coll-skill", "SKILL.md"), "read");
      denied(w, join(dir, "x", "SKILL.md"), "write");
      assert.throws(() => writeCollectionSkill(w.a, "unassigned-coll", { name: "x", description: "d", instructions: "i" }));
      assert.ok(!listSkills(w.a).some((s) => s.name === "unassigned-coll-skill"));
      // another channel's assigned collection is no more reachable
      assert.ok(!listSkills(w.a).some((s) => s.name === "victim-coll-skill"));
      assert.throws(() => writeCollectionSkill(w.a, "victim-coll", { name: "x", description: "d", instructions: "i" }));
    },
  },
  {
    mechanism: "3 collections: ro collection unwritable by tool, jail and symlink",
    run: (w) => {
      const dir = join(w.f.shared.skills, "ro-coll");
      assert.throws(() => writeCollectionSkill(w.a, "ro-coll", { name: "x", description: "d", instructions: "i" }), /read-only/);
      denied(w, join(dir, "ro-coll-skill", "SKILL.md"), "write");
      symlinkSync(dir, join(w.a.paths.workspace, "ro-link"));
      denied(w, join(w.a.paths.workspace, "ro-link", "ro-coll-skill", "SKILL.md"), "write");
    },
  },
  {
    mechanism: "3 collections: a symlink planted in a rw collection cannot surface the victim's skills",
    run: (w) => {
      symlinkSync(join(w.b.paths.skills, "victim-skill"), join(w.f.shared.skills, "rw-coll", "planted"));
      assert.ok(!loadAvailableSkills(w.a).some((s) => s.name === "victim-skill"));
      assert.ok(!loadAvailableSkills(w.a).some((s) => readFileSync(s.filePath, "utf-8").includes(MARK)));
    },
  },
  // ---- 5. skills in the container
  {
    mechanism: "5 container: mount plan holds only this channel's own paths",
    run: (w) => {
      const specs = buildCreateArgs(
        { config: SandboxSchema.parse({ mode: "docker" }), workspace: w.a.paths.workspace, dataDir: w.f.dataDir, dockerDataDir: w.f.dataDir, env: {}, channelId: "CATK", threadKey: "1.1", mounts: w.a.containerMounts },
        "n",
      ).filter((_, i, all) => all[i - 1] === "--mount");
      const joined = specs.join("\n");
      for (const forbidden of [w.b.paths.root, join(w.f.shared.skills, "unassigned-coll"), join(w.f.shared.skills, "victim-coll"), w.f.shared.bin, w.f.shared.memory, w.f.shared.library]) {
        assert.ok(!joined.includes(forbidden), `mount plan must not include ${forbidden}`);
      }
      // the only writable mounts: workspace and the explicitly rw collection
      const writable = specs.filter((s) => !s.includes(",readonly")).map((s) => /dst=([^,]+)/.exec(s)![1]);
      assert.deepEqual(writable, ["/workspace", "/skills/rw-coll"]);
    },
  },
  // ---- 6. per-channel bin
  {
    mechanism: "6 bin: the victim's bin is not on PATH and its tools do not resolve",
    run: async (w) => {
      assert.ok(!channelPathEnv(w.a).PATH!.includes("CVIC"));
      const bash = createBashToolDefinition(w.a.paths.workspace, { spawnHook: (ctx) => ({ ...ctx, env: channelPathEnv(w.a) }) });
      let out = "";
      try {
        const res = await (bash as any).execute("t", { command: "victim-tool; echo code=$?" }, undefined, undefined, undefined);
        out = res.content.map((p: any) => p.text).join("");
      } catch (e) {
        out = String(e);
      }
      assert.ok(!out.includes(MARK), "victim tool must not run");
      denied(w, join(w.b.paths.bin, "victim-tool"), "read");
      denied(w, join(w.b.paths.bin, "victim-tool"), "write");
    },
  },
  // ---- 7. global bin
  {
    mechanism: "7 global bin: not writable through the jail, mounted read-only",
    run: (w) => {
      denied(w, join(w.f.shared.globalBin, "tool"), "write");
      assert.equal(w.a.containerMounts.find((m) => m.kind === "global-bin")?.readOnly, true);
      assert.ok(!w.a.jail.writeRoots.includes(w.f.shared.globalBin));
    },
  },
  // ---- 8. CLI pool
  {
    mechanism: "8 cli pool: a channel that did not name a pool tool cannot run it",
    run: (w) => {
      assert.ok(w.b.exec.commands.pooltool, "the victim opted in");
      assert.equal(w.a.exec.commands.pooltool, undefined);
      assert.ok(!createExecTools({ config: w.a.exec, cwd: w.a.paths.workspace, binDir: w.a.paths.bin, env: w.a.env }).some((t) => t.name === "cli__pooltool"));
    },
  },
  // ---- memory and workspace, through every one of the above mechanisms' file paths
  {
    mechanism: "memory/workspace: direct file access and alias spellings are denied",
    run: (w) => {
      for (const p of [w.b.paths.memoryFile, join(w.b.paths.workspace, "notes.txt"), join(w.b.paths.bin, "victim-tool"), w.b.paths.root]) {
        denied(w, p, "read");
        denied(w, p, "write");
      }
      for (const p of ["/skills/channel/../../CVIC/memory/MEMORY.md", "/skills/channel/../../CVIC/workspace/notes.txt", "/skills/../CVIC", "/global/bin/../../channels/CVIC"]) {
        denied(w, p, "read");
      }
      assert.deepEqual(w.a.memory.foreignFiles, []);
      assert.ok(!w.a.jail.readRoots.some((r) => r.includes("CVIC")));
    },
  },
  {
    mechanism: "memory/workspace: workspace symlink to the victim is refused",
    run: (w) => {
      symlinkSync(w.b.paths.workspace, join(w.a.paths.workspace, "to-victim"));
      denied(w, join(w.a.paths.workspace, "to-victim", "notes.txt"), "read");
      denied(w, join(w.a.paths.workspace, "to-victim", "notes.txt"), "write");
    },
  },
];

for (const attack of attacks) {
  test(`isolation invariant: ${attack.mechanism}`, async () => {
    const w = world();
    const before = digest(w.b.paths.root);
    await attack.run(w);
    assert.equal(digest(w.b.paths.root), before, "the victim channel's files must be untouched");
    assert.ok(existsSync(join(w.b.paths.skills, "victim-skill", "SKILL.md")));
  });
}

test("isolation invariant: every row of items 1-8 has at least one case", () => {
  const text = attacks.map((a) => a.mechanism).join("\n");
  for (const marker of ["1 skills", "2-3 collections", "3 collections", "5 container", "6 bin", "7 global bin", "8 cli pool", "memory/workspace"]) {
    assert.ok(text.includes(marker), `no isolation case for ${marker}`);
  }
  // Row 4 (assignment) is exercised by every collection case; rows 5-7 also run against a real container
  // in src/agent/skills-bin.live.test.ts.
});
