import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { checkPath } from "./jail.ts";
import { containerPathAliases, loadAvailableSkills, presentSkills, writeChannelSkill } from "./skills.ts";
import { workspaceFixture } from "../workspace/fixture.ts";

// Row 5, the part that needs no Docker: the path the agent is shown is the
// in-container path, and the file tools understand that same path.

function docker() {
  const f = workspaceFixture({
    channels: {
      C1: { tools: ["bash"], sandbox: { mode: "docker" }, share: { skillCollections: ["team"] } },
      C2: { tools: ["bash"] },
    },
  });
  f.addCollectionSkill("team", "shared-one");
  f.addCollectionSkill("hidden", "not-assigned");
  const c1 = f.resolve("C1");
  const c2 = f.resolve("C2");
  writeChannelSkill(c1, { name: "mine", description: "Mine.", instructions: "x" });
  writeChannelSkill(c2, { name: "theirs", description: "Theirs.", instructions: "x" });
  return { f, c1, c2 };
}

test("docker mode shows in-container skill locations; host mode keeps host paths", () => {
  const { f, c1 } = docker();
  const shown = presentSkills(c1, loadAvailableSkills(c1));
  const by = (n: string) => shown.find((s) => s.name === n)!;
  assert.equal(by("mine").filePath, "/skills/channel/mine/SKILL.md");
  assert.equal(by("mine").baseDir, "/skills/channel/mine");
  assert.equal(by("shared-one").filePath, "/skills/team/shared-one/SKILL.md");

  const host = f.resolve("C2");
  const hostShown = presentSkills(host, loadAvailableSkills(host));
  assert.equal(hostShown.find((s) => s.name === "theirs")!.filePath, join(host.paths.skills, "theirs", "SKILL.md"));
});

test("the container path is readable by file tools, and is a spelling, not a permission", () => {
  const { f, c1, c2 } = docker();
  assert.deepEqual(
    containerPathAliases(c1).map((a) => a.from),
    ["/skills/channel", "/skills/team", "/global/bin"],
  );
  const jail = { readRoots: c1.jail.readRoots, writeRoots: c1.jail.writeRoots, cwd: c1.paths.workspace, pathAliases: containerPathAliases(c1) };
  const ok = checkPath(jail, "/skills/channel/mine/SKILL.md", "read");
  assert.equal(ok.allowed, true);
  assert.equal(ok.resolved, realpathSync(join(c1.paths.skills, "mine", "SKILL.md")));
  assert.equal(checkPath(jail, "/skills/team/shared-one/SKILL.md", "read").allowed, true);
  assert.equal(checkPath(jail, "/global/bin", "read").allowed, true);

  // never writable, whichever spelling is used
  assert.equal(checkPath(jail, "/skills/channel/mine/SKILL.md", "write").allowed, false);
  assert.equal(checkPath(jail, "/skills/team/shared-one/SKILL.md", "write").allowed, false);
  assert.equal(checkPath(jail, "/global/bin/x", "write").allowed, false);

  // not an escape hatch: traversal, unassigned collections, other channels
  for (const p of [
    "/skills/channel/../../../C2/skills/theirs/SKILL.md",
    "/skills/channel/../hidden/not-assigned/SKILL.md",
    "/skills/hidden/not-assigned/SKILL.md",
    "/skills/other/x",
    "/skills",
    "/skills/../etc/passwd",
  ]) {
    assert.equal(checkPath(jail, p, "read").allowed, false, p);
  }
  // a symlink inside the channel's skills dir pointing at another channel is still refused
  symlinkSync(c2.paths.skills, join(c1.paths.skills, "link-to-c2"));
  assert.equal(checkPath(jail, "/skills/channel/link-to-c2/theirs/SKILL.md", "read").allowed, false);
  void f;
});

test("host mode registers no aliases", () => {
  const { f } = docker();
  assert.deepEqual(containerPathAliases(f.resolve("C2")), []);
});
