import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SandboxSchema } from "../config/schema.ts";
import {
  buildCreateArgs,
  buildExecArgs,
  buildRunArgs,
  extraMountArgs,
  withBinOnPath,
  type DockerSandboxOptions,
} from "./sandbox.ts";
import { sandboxFingerprint } from "./sandbox-lifecycle.ts";
import { workspaceFixture } from "../workspace/fixture.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

// Row 5 (skills in the container) and row 7 (global bin in the container),
// argument level. The Docker-gated live tests prove the kernel honours these.

function optsFor(f: ReturnType<typeof workspaceFixture>, c: ResolvedChannel, over: Partial<DockerSandboxOptions> = {}): DockerSandboxOptions {
  return {
    config: SandboxSchema.parse({ mode: "docker" }),
    workspace: c.paths.workspace,
    dataDir: f.dataDir,
    dockerDataDir: f.dataDir,
    env: {},
    channelId: c.ref.id,
    threadKey: "1.1",
    mounts: c.containerMounts,
    ...over,
  };
}

const mountSpecs = (args: string[]) => args.filter((_, i, all) => all[i - 1] === "--mount");

test("a channel container mounts only its own skills, assigned collections and the global bin", () => {
  const f = workspaceFixture({
    channels: {
      C1: { share: { skillCollections: ["ro-coll", { name: "rw-coll", mode: "rw" }] } },
      C2: { share: { skillCollections: ["other"] } },
    },
  });
  for (const c of ["ro-coll", "rw-coll", "other", "unassigned"]) f.addCollectionSkill(c, "s");
  const c1 = f.resolve("C1");
  const c2 = f.resolve("C2");
  const specs = mountSpecs(buildCreateArgs(optsFor(f, c1), "harness-C1"));
  assert.deepEqual(specs, [
    `type=bind,src=${c1.paths.workspace},dst=/workspace,bind-propagation=rprivate`,
    `type=bind,src=${c1.paths.skills},dst=/skills/channel,bind-propagation=rprivate,readonly`,
    `type=bind,src=${join(f.shared.skills, "ro-coll")},dst=/skills/ro-coll,bind-propagation=rprivate,readonly`,
    `type=bind,src=${join(f.shared.skills, "rw-coll")},dst=/skills/rw-coll,bind-propagation=rprivate`,
    `type=bind,src=${f.shared.globalBin},dst=/global/bin,bind-propagation=rprivate,readonly`,
  ]);
  const joined = specs.join("\n");
  assert.ok(!joined.includes(c2.paths.root), "no other channel's directory is mounted");
  assert.ok(!joined.includes("/other") && !joined.includes("unassigned"), "unassigned collections are absent");
  assert.ok(!joined.includes(f.shared.bin), "the agent-published shared/bin is never mounted");
  assert.ok(!joined.includes(c1.paths.memory) && !joined.includes(c1.paths.agentDir));
  // one-shot containers get the same mounts
  assert.deepEqual(mountSpecs(buildRunArgs(optsFor(f, c1), "n", "true")), specs);
});

test("mounts are translated to the Docker daemon's data directory", () => {
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: ["team"] } } } });
  f.addCollectionSkill("team", "s");
  const c = f.resolve("C1");
  const specs = mountSpecs(buildCreateArgs(optsFor(f, c, { dockerDataDir: "/srv/harness/data" }), "n"));
  assert.ok(specs.includes("type=bind,src=/srv/harness/data/channels/C1/skills,dst=/skills/channel,bind-propagation=rprivate,readonly"));
  assert.ok(specs.includes("type=bind,src=/srv/harness/data/shared/skills/team,dst=/skills/team,bind-propagation=rprivate,readonly"));
  assert.ok(specs.includes("type=bind,src=/srv/harness/data/shared/global-bin,dst=/global/bin,bind-propagation=rprivate,readonly"));
});

test("a mount source outside the data directory, or an unsafe destination, is refused", () => {
  const f = workspaceFixture({ channels: { C1: {} } });
  const c = f.resolve("C1");
  const bad = (mounts: DockerSandboxOptions["mounts"], re: RegExp) =>
    assert.throws(() => extraMountArgs(optsFor(f, c, { mounts })), re);
  bad([{ hostPath: "/etc", containerPath: "/skills/x", readOnly: true }], /not below data directory/);
  bad([{ hostPath: join(f.dataDir, "..", "elsewhere"), containerPath: "/skills/x", readOnly: true }], /not below data directory/);
  bad([{ hostPath: f.dataDir, containerPath: "/skills/x", readOnly: true }], /not below data directory/);
  bad([{ hostPath: c.paths.skills, containerPath: "skills/relative", readOnly: true }], /invalid container mount path/);
  bad([{ hostPath: c.paths.skills, containerPath: "/skills/../etc", readOnly: true }], /invalid container mount path/);
  bad([{ hostPath: c.paths.skills, containerPath: "/skills/a,readonly=false", readOnly: true }], /invalid container mount path/);
  bad([{ hostPath: c.paths.skills, containerPath: "/workspace/skills", readOnly: true }], /inside \/workspace/);
  bad([{ hostPath: c.paths.skills, containerPath: "/workspace", readOnly: true }], /inside \/workspace|duplicated/);
  bad(
    [
      { hostPath: c.paths.skills, containerPath: "/skills/a", readOnly: true },
      { hostPath: c.paths.memory, containerPath: "/skills/a", readOnly: true },
    ],
    /duplicated/,
  );
});

test("changing a collection's mode or assignment changes the container fingerprint, so containers are recycled", () => {
  const f = workspaceFixture({ channels: { C1: { share: { skillCollections: [{ name: "team", mode: "rw" }] } } } });
  f.addCollectionSkill("team", "s");
  const fp = (c: ResolvedChannel) =>
    sandboxFingerprint({ version: 2, imageId: "sha256:x", args: buildCreateArgs(optsFor(f, c), "n") });
  const rw = fp(f.resolve("C1"));
  assert.equal(fp(f.resolve("C1")), rw, "stable for identical config");
  f.reconfigure({ channels: { C1: { share: { skillCollections: ["team"] } } } });
  const ro = fp(f.resolve("C1"));
  assert.notEqual(ro, rw, "rw -> ro must recreate the container");
  f.reconfigure({ channels: { C1: {} } });
  assert.notEqual(fp(f.resolve("C1")), ro, "revoking the collection must recreate the container");
});

test("PATH order is channel bin, then global bin, then system — host and container", () => {
  const f = workspaceFixture({ channels: { C1: {} } });
  const c = f.resolve("C1");
  assert.equal(withBinOnPath({ PATH: "/usr/bin" }, c.paths.bin, c.globalBin).PATH, `${c.paths.bin}:${c.globalBin}:/usr/bin`);
  assert.equal(withBinOnPath({}, c.paths.bin, c.globalBin).PATH, `${c.paths.bin}:${c.globalBin}`);
  assert.equal(withBinOnPath({ PATH: "/usr/bin" }, c.paths.bin).PATH, `${c.paths.bin}:/usr/bin`, "global bin is optional for callers that predate it");
  const cmd = buildExecArgs(optsFor(f, c), "n", "mytool").at(-1)!;
  assert.equal(cmd, 'export PATH="/workspace/bin:/global/bin:$PATH"\nmytool');
  assert.equal(buildRunArgs(optsFor(f, c), "n", "mytool").at(-1), cmd);
});

test("without resolver mounts the container is exactly the workspace (back-compat)", () => {
  const f = workspaceFixture({ channels: { C1: {} } });
  const c = f.resolve("C1");
  assert.deepEqual(mountSpecs(buildCreateArgs(optsFor(f, c, { mounts: [] }), "n")).length, 1);
});
