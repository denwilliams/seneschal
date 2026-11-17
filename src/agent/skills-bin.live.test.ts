import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxSchema } from "../config/schema.ts";
import {
  containerNameFor,
  createDockerBashOperations,
  dockerAvailable,
  sandboxImageExists,
  startSandboxCleanup,
  stopAllSandboxes,
  type DockerSandboxOptions,
} from "./sandbox.ts";
import { presentSkills, writeChannelSkill, loadAvailableSkills } from "./skills.ts";
import { workspaceFixture } from "../workspace/fixture.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * Docker-gated live tests for Workstream B rows 5-7: skills, the per-channel
 * bin and the global bin INSIDE a real container.
 *
 * Run (needs a Docker daemon and an image with bash + sleep):
 *   HARNESS_SANDBOX_TEST_IMAGE=seneschal-sandbox:latest \
 *     node --experimental-strip-types --test src/agent/skills-bin.live.test.ts
 * They self-skip when Docker or the image is unavailable, like the other
 * *.live.test.ts files.
 */

const image = process.env.HARNESS_SANDBOX_TEST_IMAGE ?? "seneschal-sandbox:latest";
const live = dockerAvailable() && sandboxImageExists(image);

function make(config: unknown) {
  const f = workspaceFixture(config);
  const containers: string[] = [];
  // The image runs as an unprivileged uid; widen what the container user must write.
  const open = (path: string) => chmodSync(path, 0o777);

  const run = async (channel: ResolvedChannel, command: string, over: Partial<DockerSandboxOptions> = {}, threadKey = "live.1") => {
    startSandboxCleanup(f.dataDir);
    containers.push(containerNameFor(channel.ref.id, threadKey));
    const opts: DockerSandboxOptions = {
      config: SandboxSchema.parse({ mode: "docker", image, idleSeconds: 60 }),
      workspace: channel.paths.workspace,
      dataDir: f.dataDir,
      dockerDataDir: f.dataDir,
      env: {},
      channelId: channel.ref.id,
      threadKey,
      mounts: channel.containerMounts,
      ...over,
    };
    let output = "";
    const result = await createDockerBashOperations(opts).exec(command, channel.paths.workspace, {
      onData: (d) => {
        output += d.toString();
      },
    });
    return { code: result.exitCode, output };
  };

  const cleanup = () => {
    stopAllSandboxes();
    for (const name of containers) {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
    rmSync(f.dataDir, { recursive: true, force: true });
  };
  return { f, run, open, cleanup };
}

test("row 5: channel skills and assigned collections are in the container at the documented paths", { skip: !live }, async () => {
  const t = make({
    channels: {
      C1LIVE: { tools: ["bash"], sandbox: { mode: "docker", image }, share: { skillCollections: ["ro-coll", { name: "rw-coll", mode: "rw" }] } },
      C2LIVE: { share: { skillCollections: ["other-coll"] } },
    },
  });
  try {
    // Collections exist before the channels resolve (a missing one is skipped).
    const ro = t.f.addCollectionSkill("ro-coll", "shared-ro");
    const rw = t.f.addCollectionSkill("rw-coll", "shared-rw");
    t.f.addCollectionSkill("other-coll", "not-yours");
    t.f.addCollectionSkill("unassigned-coll", "nobody");
    const c1 = t.f.resolve("C1LIVE");
    const c2 = t.f.resolve("C2LIVE");
    t.open(c1.paths.workspace);
    writeChannelSkill(c1, { name: "mine", description: "My skill.", instructions: "do the thing" });
    writeFileSync(join(c1.paths.skills, "mine", "helper.sh"), "#!/bin/sh\necho helper-ran\n", { mode: 0o755 });
    writeChannelSkill(c2, { name: "secret-other", description: "Other channel.", instructions: "private" });
    t.open(rw);
    t.open(join(t.f.shared.skills, "rw-coll"));

    // Readable at the documented fixed path, sibling scripts included.
    let r = await t.run(c1, "cat /skills/channel/mine/SKILL.md && sh /skills/channel/mine/helper.sh");
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /do the thing/);
    assert.match(r.output, /helper-ran/);

    // The path shown to the agent equals the in-container path.
    const shown = presentSkills(c1, loadAvailableSkills(c1)).filter((s) => !s.filePath.startsWith("/Users") || true);
    const mine = shown.find((s) => s.name === "mine")!;
    assert.equal(mine.filePath, "/skills/channel/mine/SKILL.md");
    const sharedRo = shown.find((s) => s.name === "shared-ro")!;
    assert.equal(sharedRo.filePath, "/skills/ro-coll/shared-ro/SKILL.md");
    for (const p of [mine.filePath, sharedRo.filePath, shown.find((s) => s.name === "shared-rw")!.filePath]) {
      r = await t.run(c1, `test -s ${p} && echo present`);
      assert.match(r.output, /present/, `${p} must exist in the container`);
    }

    // Exactly this channel's mounts: nothing of C2's, no unassigned collection.
    r = await t.run(c1, "ls /skills | sort | tr '\\n' ' '");
    assert.equal(r.output.trim(), "channel ro-coll rw-coll");
    r = await t.run(c1, "find / -xdev \\( -name secret-other -o -name not-yours -o -name nobody \\) 2>/dev/null | wc -l");
    assert.equal(r.output.trim(), "0");

    // RO mounts reject writes with EROFS; channel skills too.
    for (const cmd of [
      "echo x > /skills/ro-coll/shared-ro/SKILL.md",
      "touch /skills/ro-coll/new-file",
      "rm -rf /skills/ro-coll/shared-ro",
      "ln -s /workspace /skills/ro-coll/planted",
      "echo x > /skills/channel/mine/SKILL.md",
      "mount -o remount,rw /skills/ro-coll",
    ]) {
      r = await t.run(c1, cmd);
      assert.notEqual(r.code, 0, `${cmd} must fail`);
    }
    r = await t.run(c1, "echo x > /skills/ro-coll/shared-ro/SKILL.md");
    assert.match(r.output, /Read-only file system/i);
    assert.match(readFileSync(join(ro, "SKILL.md"), "utf-8"), /body of shared-ro/, "host file untouched");
    assert.equal(existsSync(join(ro, "..", "planted")), false);

    // RW mount accepts writes and they appear on the host.
    r = await t.run(c1, "echo from-container > /skills/rw-coll/shared-rw/note.txt");
    assert.equal(r.code, 0, r.output);
    assert.equal(readFileSync(join(rw, "note.txt"), "utf-8").trim(), "from-container");

    // Identical on a fresh and a reused container: same thread, same mounts.
    const before = await t.run(c1, "ls /skills | sort | tr '\\n' ' '", {}, "reuse.1");
    const after = await t.run(c1, "ls /skills | sort | tr '\\n' ' '", {}, "reuse.1");
    assert.equal(before.output, after.output);
    const name = containerNameFor("C1LIVE", "reuse.1");
    const mounts = JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0].Mounts as {
      Destination: string;
      RW: boolean;
    }[];
    const rwByDest = Object.fromEntries(mounts.map((m) => [m.Destination, m.RW]));
    assert.deepEqual(rwByDest, {
      "/workspace": true,
      "/skills/channel": false,
      "/skills/ro-coll": false,
      "/skills/rw-coll": true,
      "/global/bin": false,
    });

    // Config reload: rw -> ro recycles the reused container instead of keeping the old mount.
    t.f.reconfigure({
      channels: {
        C1LIVE: { tools: ["bash"], sandbox: { mode: "docker", image }, share: { skillCollections: ["ro-coll", "rw-coll"] } },
      },
    });
    const demoted = t.f.resolve("C1LIVE");
    r = await t.run(demoted, "echo again > /skills/rw-coll/shared-rw/note.txt", {}, "reuse.1");
    assert.notEqual(r.code, 0, "a demoted collection must no longer be writable in a reused container");
    assert.match(r.output, /Read-only file system/i);
    t.f.reconfigure({ channels: { C1LIVE: { tools: ["bash"], sandbox: { mode: "docker", image } } } });
    r = await t.run(t.f.resolve("C1LIVE"), "ls /skills | sort | tr '\\n' ' '", {}, "reuse.1");
    assert.equal(r.output.trim(), "channel", "a revoked collection is no longer mounted");
  } finally {
    t.cleanup();
  }
});

test("rows 6-7: per-channel bin and the global bin work by bare name, in order, and stay read-only", { skip: !live }, async () => {
  const t = make({
    channels: {
      C1BIN: { tools: ["bash"], sandbox: { mode: "docker", image } },
      C2BIN: { tools: ["bash"], sandbox: { mode: "docker", image } },
    },
  });
  try {
    const c1 = t.f.resolve("C1BIN");
    const c2 = t.f.resolve("C2BIN");
    t.open(c1.paths.workspace);
    t.open(c1.paths.bin);
    t.open(c2.paths.workspace);

    const script = (path: string, body: string, mode = 0o755) => {
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode });
      chmodSync(path, mode);
    };
    // Global bin: no channel config involved at all.
    script(join(t.f.shared.globalBin, "global-only"), "echo global-only-ran");
    script(join(t.f.shared.globalBin, "both"), "echo both-from-global");
    // Per-channel bin, same name as a global tool: the channel wins.
    script(join(c1.paths.bin, "both"), "echo both-from-channel");
    script(join(c1.paths.bin, "chan-only"), "echo chan-only-ran");
    script(join(c1.paths.bin, "not-executable"), "echo nope", 0o644);
    script(join(c2.paths.bin, "c2-secret-tool"), "echo c2-tool");

    let r = await t.run(c1, "global-only; both; chan-only");
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(r.output.trim().split("\n"), ["global-only-ran", "both-from-channel", "chan-only-ran"]);
    // PATH order: channel bin, global bin, then system.
    r = await t.run(c1, "echo $PATH | cut -d: -f1,2");
    assert.equal(r.output.trim(), "/workspace/bin:/global/bin");

    // Every channel gets the global tool; nobody gets another channel's bin.
    r = await t.run(c2, "global-only; both; c2-secret-tool; chan-only 2>&1; echo code=$?");
    assert.match(r.output, /global-only-ran/);
    assert.match(r.output, /both-from-global/, "channel 2 has no override so it gets the global one");
    r = await t.run(c1, "c2-secret-tool 2>&1; echo code=$?");
    assert.match(r.output, /not found/i);
    assert.match(r.output, /code=127/);
    r = await t.run(c1, "ls /workspace/../ 2>&1 | grep -c C2BIN; true");
    assert.equal(r.output.trim().split("\n").pop(), "0");

    // Absent tool: ordinary command-not-found, not a crash.
    r = await t.run(c1, "definitely-not-a-tool 2>&1; echo code=$?");
    assert.match(r.output, /not found/i);
    assert.match(r.output, /code=127/);

    // Non-executable file: a clear error.
    r = await t.run(c1, "not-executable 2>&1; echo code=$?");
    assert.match(r.output, /Permission denied|not found/i);
    assert.doesNotMatch(r.output, /code=0/);
    // ...and the executable bit survives the bind mount for the good one (above) after reuse.
    r = await t.run(c1, "chan-only && global-only");
    assert.equal(r.code, 0, r.output);

    // The global bin is read-only from every channel: modify, delete, create, chmod.
    for (const cmd of [
      "echo hacked > /global/bin/global-only",
      "rm -f /global/bin/global-only",
      "touch /global/bin/new-tool",
      "chmod 777 /global/bin/global-only",
      "mv /global/bin/both /global/bin/both2",
    ]) {
      r = await t.run(c1, `${cmd} 2>&1`);
      assert.notEqual(r.code, 0, `${cmd} must fail`);
      assert.match(r.output, /Read-only file system|Operation not permitted/i, cmd);
    }
    assert.equal(readFileSync(join(t.f.shared.globalBin, "global-only"), "utf-8").includes("global-only-ran"), true);
    assert.equal(existsSync(join(t.f.shared.globalBin, "new-tool")), false);
    // One-shot containers (reuse: false) get the same.
    r = await t.run(c1, "global-only", { config: SandboxSchema.parse({ mode: "docker", image, reuse: false }) }, "oneshot.1");
    assert.match(r.output, /global-only-ran/);
  } finally {
    t.cleanup();
  }
});

test("isolation invariants in a real container: nothing of another channel or an unassigned collection is visible", { skip: !live }, async () => {
  const MARK = "VICTIM-SECRET-MARKER-LIVE";
  const t = make({
    channels: {
      CATK: { tools: ["bash"], sandbox: { mode: "docker", image }, share: { skillCollections: ["mine"] } },
      CVIC: { tools: ["bash"], share: { skillCollections: ["victim-coll"] } },
    },
  });
  try {
    t.f.addCollectionSkill("mine", "mine-skill");
    t.f.addCollectionSkill("victim-coll", "victim-coll-skill", MARK);
    t.f.addCollectionSkill("unassigned-coll", "unassigned-skill", MARK);
    const a = t.f.resolve("CATK");
    const b = t.f.resolve("CVIC");
    t.open(a.paths.workspace);
    // Positive control: the probe below really does find a marker the channel can see.
    writeFileSync(join(a.paths.workspace, "own.txt"), MARK);
    writeChannelSkill(b, { name: "victim-skill", description: MARK, instructions: MARK });
    writeFileSync(join(b.paths.workspace, "notes.txt"), MARK);
    writeFileSync(join(b.paths.memoryFile), MARK);
    writeFileSync(join(b.paths.bin, "victim-tool"), `#!/bin/sh\necho ${MARK}\n`, { mode: 0o755 });
    writeFileSync(join(t.f.shared.memory, "MEMORY.md"), MARK);

    const r = await t.run(
      a,
      `grep -rl ${MARK} / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | wc -l; ` +
        `victim-tool 2>&1 | grep -c ${MARK}; ls /workspace/.. /skills | tr '\\n' ' '`,
    );
    const [leaks, runs, listing] = r.output.trim().split("\n");
    assert.equal(leaks, "1", `only the channel's own marker file may be visible (found ${leaks}): ${r.output}`);
    assert.equal(runs, "0", "another channel's bin tool must not run");
    assert.doesNotMatch(listing ?? "", /CVIC|victim|unassigned/);
  } finally {
    t.cleanup();
  }
});
