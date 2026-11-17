import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxSchema } from "../config/schema.ts";
import {
  buildCreateArgs,
  buildExecArgs,
  buildImageArgs,
  buildRunArgs,
  channelImageTag,
  containerCwd,
  containerEnvironment,
  describeSandbox,
  dockerfileFingerprint,
  dockerWorkspaceMountSource,
  withBinOnPath,
} from "./sandbox.ts";

const config = SandboxSchema.parse({ mode: "docker" });

const base = {
  config,
  workspace: "/data/channels/C1/workspace",
  dataDir: "/data",
  // Explicit daemon mapping keeps argument-only tests portable inside Docker.
  dockerDataDir: "/data",
  env: { GH_TOKEN: "super-secret", PATH: "/usr/bin", SLACK_BOT_TOKEN: "xoxb-secret" },
  channelId: "C1",
  threadKey: "123.456",
};

function args() {
  return buildCreateArgs(base, "harness-C1");
}

test("bind-mounts only the channel's own workspace, read-write", () => {
  const mounts = args().filter((a, i, all) => all[i - 1] === "--mount");
  assert.deepEqual(mounts, [
    "type=bind,src=/data/channels/C1/workspace,dst=/workspace,bind-propagation=rprivate",
  ]);
  assert.ok(!mounts[0]?.includes("readonly"), "the workspace must remain writable");
});

test("translates a harness-container workspace to the Docker daemon's host path", () => {
  assert.equal(
    dockerWorkspaceMountSource(
      "/app/data/channels/C1/workspace",
      "/app/data",
      "/srv/harness/data",
      true,
    ),
    "/srv/harness/data/channels/C1/workspace",
  );
});

test("refuses an ambiguous service-container path without a host data mapping", () => {
  assert.throws(
    () => dockerWorkspaceMountSource("/app/data/channels/C1/workspace", "/app/data", undefined, true),
    /HARNESS_DOCKER_DATA_DIR is required/,
  );
  assert.throws(
    () => dockerWorkspaceMountSource("/app/data/channels/C1/workspace", "/app/data", "data", true),
    /must be an absolute host path/,
  );
});

test("no other channel, the data dir, or the repo is reachable", () => {
  const joined = args().join(" ");
  // The only host path present is this channel's workspace.
  const paths = args().filter((a) => a.includes("src=/data/channels/C1/workspace"));
  assert.equal(paths.length, 1);
  assert.ok(!joined.includes("/data/channels/C2"));
  assert.ok(!joined.includes("auth.json"));
});

test("secrets are passed by name, never by value", () => {
  const all = buildExecArgs(base, "n", "env");
  const joined = all.join(" ");

  assert.ok(all.includes("GH_TOKEN"), "the variable is forwarded");
  assert.ok(
    !joined.includes("super-secret"),
    "the value must never appear in argv, where ps could read it",
  );
});

test("harness credentials are not forwarded into the sandbox", () => {
  const all = args();
  assert.ok(!all.includes("SLACK_BOT_TOKEN"), "the bot token is not the channel's business");
  assert.ok(!all.includes("PATH"), "host PATH would be wrong inside the container");
});

test("network is off by default", () => {
  const all = args();
  assert.equal(all[all.indexOf("--network") + 1], "none");
});

test("network can be opened deliberately", () => {
  const online = SandboxSchema.parse({ mode: "docker", network: "bridge" });
  const all = buildCreateArgs(
    { config: online, workspace: "/w", dataDir: "/", dockerDataDir: "/", env: {}, channelId: "C1", threadKey: "123.456" },
    "n",
  );
  assert.equal(all[all.indexOf("--network") + 1], "bridge");
});

test("resource limits are applied", () => {
  const all = args();
  assert.equal(all[all.indexOf("--memory") + 1], "512m");
  assert.equal(all[all.indexOf("--cpus") + 1], "1");
  assert.equal(all[all.indexOf("--pids-limit") + 1], "256");
  assert.ok(!all.includes("--read-only"));
  assert.ok(all.includes("--cap-drop"));
  assert.equal(all[all.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(all.includes("no-new-privileges:true"));
  assert.ok(all.includes("--detach"), "the channel container is long-lived");
});

test("the command is passed as one argument, not concatenated into the shell", () => {
  const all = buildExecArgs(base, "harness-C1", "gh pr list");
  assert.ok(all[all.length - 1]?.endsWith("gh pr list"));
  assert.equal(all[all.length - 2], "-lc");
});

test("workspace facts point at the mounted paths inside reusable and one-shot containers", () => {
  const translated = containerEnvironment({
    HARNESS_CHANNEL_ROOT: "/data/channels/C1",
    HARNESS_CHANNEL_WORKSPACE: "/data/channels/C1/workspace",
    HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS: "/data/channels/C1/workspace/attachments",
    HARNESS_CHANNEL_ARTIFACTS: "/data/channels/C1/workspace/artifacts",
  });
  assert.equal(translated.HARNESS_CHANNEL_ARTIFACTS, "/workspace/artifacts");
  assert.equal(translated.HARNESS_CHANNEL_WORKSPACE, "/workspace");
  assert.equal(translated.HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS, "/workspace/attachments");

  for (const args of [
    buildExecArgs(base, "harness-C1", "env"),
    buildRunArgs(base, "harness-C1", "env"),
  ]) {
    assert.ok(args.includes("HARNESS_CHANNEL_ARTIFACTS"));
    assert.ok(args.includes("HARNESS_CHANNEL_WORKSPACE"));
    assert.ok(!args.includes("HARNESS_CHANNEL_ROOT"));
  }
});

test("the workspace's bin is first on PATH inside the container", () => {
  // The host PATH is meaningless in the container and the image supplies its
  // own, so the prepend happens in the shell rather than through --env.
  for (const all of [
    buildExecArgs(base, "harness-C1", "deploy"),
    buildRunArgs(base, "harness-C1", "deploy"),
  ]) {
    const command = all[all.length - 1] ?? "";
    assert.match(command, /^export PATH="\/workspace\/bin:\/global\/bin:\$PATH"\n/);
    assert.ok(command.endsWith("deploy"), "the command itself is untouched");
  }
});

test("the export runs after the login shell's profile, not before it", () => {
  // `bash -lc` sources /etc/profile, which sets PATH. An --env PATH would be
  // overwritten by it; a line in the command body is not.
  const all = buildExecArgs(base, "harness-C1", "deploy");
  assert.ok(!all.includes("PATH"), "PATH is still not forwarded from the host");
  assert.equal(all[all.length - 2], "-lc");
});

test("bin goes ahead of the inherited PATH on the host, not behind it", () => {
  const env = withBinOnPath({ PATH: "/usr/bin:/bin" }, "/data/channels/C1/workspace/bin");
  assert.equal(env.PATH, "/data/channels/C1/workspace/bin:/usr/bin:/bin");
});

test("a channel with no PATH at all still gets its bin", () => {
  assert.equal(withBinOnPath({}, "/w/bin").PATH, "/w/bin");
});

test("commands exec into the channel's own container", () => {
  const all = buildExecArgs(base, "harness-C1", "ls");
  assert.equal(all[0], "exec");
  assert.ok(all.includes("harness-C1"));
});

test("exec forwards secrets by name only", () => {
  const all = buildExecArgs(base, "harness-C1", "ls");
  assert.ok(all.includes("GH_TOKEN"));
  assert.ok(!all.join(" ").includes("super-secret"));
  assert.ok(!all.includes("SLACK_BOT_TOKEN"));
});

test("describeSandbox is honest about host mode", () => {
  const host = SandboxSchema.parse({});
  assert.match(describeSandbox(host), /no isolation/);
  assert.match(describeSandbox(config), /docker/);
});

test("cwd tracking maps host paths into the container", () => {
  const ws = "/data/channels/C1/workspace";
  assert.equal(containerCwd(ws, undefined), "/workspace");
  assert.equal(containerCwd(ws, ws), "/workspace");
  assert.equal(containerCwd(ws, `${ws}/project/src`), "/workspace/project/src");
});

test("a cwd outside the workspace falls back to the mounted root", () => {
  const ws = "/data/channels/C1/workspace";
  // Nothing outside the workspace is mounted, so pointing --workdir there
  // would fail rather than silently escaping.
  assert.equal(containerCwd(ws, "/data/channels/C2/workspace"), "/workspace");
  assert.equal(containerCwd(ws, "/etc"), "/workspace");
});

test("the workdir argument reflects the tracked cwd", () => {
  const all = buildExecArgs({ config, workspace: "/w", dataDir: "/", env: {}, channelId: "C1", threadKey: "123.456" }, "n", "ls", "/w/sub");
  assert.equal(all[all.indexOf("--workdir") + 1], "/workspace/sub");
});

// --- A channel's own Dockerfile -------------------------------------------

test("the derived image tag is a legal docker reference", () => {
  // Slack ids are uppercase and image references may not be.
  const tag = channelImageTag("C01AB2CD3");
  assert.equal(tag, "harness-channel-c01ab2cd3:latest");
  assert.match(tag, /^[a-z0-9._/-]+:[a-zA-Z0-9._-]+$/);
});

test("channels get different tags, and DM ids stay legal", () => {
  assert.notEqual(channelImageTag("C1"), channelImageTag("C2"));
  // A slash would turn the tag into a registry path pointing somewhere else.
  assert.equal(channelImageTag("D04/../etc"), "harness-channel-d04_.._etc:latest");
});

test("the build context is the workspace, so the env file cannot be COPYed in", () => {
  const args = buildImageArgs(
    "/data/channels/C1/Dockerfile",
    "/data/channels/C1/workspace",
    "harness-channel-c1:latest",
    "abc123",
  );
  assert.equal(args.at(-1), "/data/channels/C1/workspace");
  assert.ok(!args.join(" ").includes("/data/channels/C1 "), "the channel root is not the context");
});

test("the image records which Dockerfile built it", () => {
  const args = buildImageArgs("/d/Dockerfile", "/d/workspace", "t:latest", "deadbeef");
  const label = args[args.indexOf("--label") + 1];
  assert.equal(label, "harness.dockerfile-sha=deadbeef");
});

test("a changed Dockerfile fingerprints differently", () => {
  const a = dockerfileFingerprint("FROM debian:bookworm-slim\n");
  const b = dockerfileFingerprint("FROM debian:bookworm-slim\nRUN apt-get update\n");
  assert.notEqual(a, b);
  assert.equal(a, dockerfileFingerprint("FROM debian:bookworm-slim\n"), "and stably otherwise");
});

test("container identity is thread-specific, safe and collision-resistant", async () => {
  const { containerNameFor } = await import("./sandbox.ts");
  assert.equal(containerNameFor("C1", "123.456"), "harness-C1-123.456");
  assert.notEqual(containerNameFor("C1", "a/b"), containerNameFor("C1", "a_b"));
  assert.notEqual(containerNameFor("C1-a", "b"), containerNameFor("C1", "a-b"));
  const lossy = containerNameFor("C1", "a/b").slice("harness-C1-".length);
  assert.notEqual(containerNameFor("C1", "a/b"), containerNameFor("C1", lossy));
  assert.notEqual(containerNameFor("C1", "t1"), containerNameFor("C1", "t2"));
  assert.notEqual(containerNameFor("C1", "x".repeat(81)), containerNameFor("C1", "x".repeat(82)));
  assert.throws(() => containerNameFor("C1", ""), /stable/);
  // DM roots, delegated Slack threads, and scheduled task IDs use explicit keys.
  for (const key of ["123.456", "scheduled-task-123", "dream"]) {
    assert.match(containerNameFor("D1", key), /^harness-D1-/);
  }
});

test("writable container layer is default, explicit read-only root uses no repository volumes", () => {
  assert.equal(config.readOnlyRoot, false);
  assert.equal(config.idleSeconds, 86_400);
  assert.throws(() => SandboxSchema.parse({ idleSeconds: 0 }));
  const readonly = buildCreateArgs({ ...base, config: { ...config, readOnlyRoot: true } }, "n");
  assert.ok(readonly.includes("--read-only"));
  assert.ok(readonly.includes("/repos:rw,mode=1777,size=256m"));
  assert.equal(readonly.filter((a) => a === "--mount").length, 1);
  assert.ok(!readonly.includes("--volume"));
  assert.ok(!args().includes("GH_TOKEN"), "idle containers do not retain channel credentials");
});


test("Pi timeout overrides use seconds and invalid/overflowing timers fail closed", async () => {
  const { sandboxTimeoutMs } = await import("./sandbox.ts");
  assert.equal(sandboxTimeoutMs(120), 120_000);
  assert.equal(sandboxTimeoutMs(120, 2), 2_000);
  assert.equal(sandboxTimeoutMs(120, 0.5), 500);
  for (const value of [0, -1, NaN, Infinity, 2_147_484]) assert.throws(() => sandboxTimeoutMs(120, value), /timeout/);
});
