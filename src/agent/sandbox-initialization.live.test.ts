import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { SandboxSchema } from "../config/schema.ts";
import { buildCreateArgs, repositoryStorageScript, containerNameFor, createDockerBashOperations, dockerAvailable, sandboxImageExists, startSandboxCleanup, stopAllSandboxes } from "./sandbox.ts";

const image = process.env.HARNESS_SANDBOX_TEST_IMAGE ?? "seneschal-sandbox:latest";
const liveDocker = dockerAvailable() && sandboxImageExists(image);
if (process.env.HARNESS_REQUIRE_DOCKER_TESTS === "1" && !liveDocker) {
  throw new Error(`Required live Docker initialization tests need Docker and image ${image}`);
}

function fixture(suffix: string) {
  const root = mkdtempSync(join(tmpdir(), "sandbox-initialization-"));
  const dataDir = join(root, "data");
  const workspace = join(dataDir, "channels/C1/workspace");
  mkdirSync(workspace, { recursive: true }); chmodSync(workspace, 0o777);
  writeFileSync(join(workspace, "durable"), "keep");
  const tag = `harness-sandbox-initialization-test:${process.pid}-${suffix}`;
  const opts = { config: SandboxSchema.parse({ mode: "docker", image: tag }), workspace, dataDir,
    dockerDataDir: dataDir, env: {}, channelId: `Cinit${process.pid}`, threadKey: `${Date.now()}.${suffix}` };
  const name = containerNameFor(opts.channelId, opts.threadKey);
  const build = (setup: string, imageConfig = "") => execFileSync("docker", ["build", "-t", tag, "-"],
    { input: `FROM ${image}\nUSER root\nRUN ${setup}\nUSER sandbox\n${imageConfig}\n`, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
  const inspect = () => JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
  const run = async (command: string) => {
    startSandboxCleanup(dataDir);
    let output = "";
    const result = await createDockerBashOperations(opts).exec(command, workspace, { onData: (d) => { output += d; } });
    return { ...result, output };
  };
  const close = () => {
    stopAllSandboxes();
    try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch { /* gone */ }
    try { execFileSync("docker", ["image", "rm", tag], { stdio: "ignore" }); } catch { /* not built */ }
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dataDir, workspace, opts, name, build, inspect, run, close };
}

for (const phase of ["creation", "preparation"]) {
  test(`SIGKILL after Docker ${phase} cannot adopt an uncommitted initialization on restart`, { skip: !liveDocker }, async () => {
    const f = fixture(`crash-${phase}`);
    try {
      f.build("chmod 0755 /repos");
      const docker = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "docker")).find(existsSync);
      assert.ok(docker);
      const wrappers = join(f.root, "wrappers"); mkdirSync(wrappers);
      writeFileSync(join(wrappers, "docker"), `#!/bin/sh\n${JSON.stringify(docker)} "$@"\nstatus=$?\nif [ "$status" = 0 ]; then
    ${phase === "creation" ? '[ "$1" != run ] || kill -KILL "$PPID"' : 'case "$*" in *"chmod 1777 /repos"*) kill -KILL "$PPID" ;; esac'}
  fi\nexit "$status"\n`);
      chmodSync(join(wrappers, "docker"), 0o755);
      const script = `import {createDockerBashOperations} from ${JSON.stringify(new URL("./sandbox.ts", import.meta.url).href)}; const opts=${JSON.stringify(f.opts)}; await createDockerBashOperations(opts).exec("echo dispatched > /workspace/agent-ran", opts.workspace, {onData:d=>process.stdout.write(d)});`;
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
        { env: { ...process.env, PATH: `${wrappers}${delimiter}${process.env.PATH}` }, timeout: 30_000, encoding: "utf8" });
      assert.equal(child.signal, "SIGKILL", child.stdout + child.stderr);
      const partialId = f.inspect().Id;
      assert.equal(existsSync(join(f.workspace, "agent-ran")), false);
      const resumed = await f.run("echo recovered > /repos/recovered");
      assert.equal(resumed.exitCode, 0, resumed.output);
      assert.notEqual(f.inspect().Id, partialId, "incomplete creation is replaced before any agent dispatch");
      assert.equal(readFileSync(join(f.workspace, "durable"), "utf8"), "keep");
    } finally { f.close(); }
  });
}

test("an image /repos symlink cannot redirect clones or privileged chmod to the host workspace", { skip: !liveDocker }, async () => {
  const f = fixture("symlink");
  try {
    f.build("rmdir /repos && ln -s /workspace /repos");
    const result = await f.run("echo leaked > /repos/repo-file");
    assert.equal(result.exitCode, 127, result.output);
    assert.match(result.output, /repos.*(symlink|container-local|directory)/s);
    assert.equal(existsSync(join(f.workspace, "repo-file")), false);
    assert.equal(statSync(f.workspace).mode & 0o7777, 0o777, "trusted initialization never chmods the host bind");
    assert.equal(readFileSync(join(f.workspace, "durable"), "utf8"), "keep");
  } finally { f.close(); }
});


for (const [suffix, setup] of [
  ["indirect-symlink", "rmdir /repos && ln -s /workspace /redirect && ln -s /redirect /repos"],
  ["non-directory", "rmdir /repos && echo not-a-directory > /repos"],
  ["workspace-alias", "rmdir /workspace && ln -s /repos /workspace"],
]) {
  test(`custom image ${suffix} never dispatches into redirected repository storage`, { skip: !liveDocker }, async () => {
    const f = fixture(suffix!);
    try {
      f.build(setup!);
      const result = await f.run("echo leaked > /repos/repo-file");
      assert.equal(result.exitCode, 127, result.output);
      assert.equal(existsSync(join(f.workspace, "repo-file")), false);
      assert.equal(statSync(f.workspace).mode & 0o7777, 0o777);
      assert.equal(readFileSync(join(f.workspace, "durable"), "utf8"), "keep");
    } finally { f.close(); }
  });
}

test("an absent image /repos is prepared once, but reused container tampering is never repaired as root", { skip: !liveDocker }, async () => {
  const f = fixture("missing");
  try {
    f.build("rmdir /repos");
    let result = await f.run("echo ready > /repos/state");
    assert.equal(result.exitCode, 0, result.output);
    const id = f.inspect().Id;
    const record = JSON.parse(readFileSync(join(f.dataDir, "sandboxes", `${f.name}.json`), "utf8"));
    assert.equal(record.readyContainerId, id);
    // Out-of-band mutation models what a configured root user could have done
    // in a previous turn; do it only while no exec or GC is active.
    execFileSync("docker", ["exec", "--user", "0", f.name, "sh", "-c", "mv /repos /original-repos && ln -s /workspace /repos"], { stdio: "pipe" });
    result = await f.run("echo leaked > /repos/repo-file");
    assert.equal(result.exitCode, 127, result.output);
    assert.match(result.output, /repos.*(symlink|container-local|directory)/s);
    assert.equal(f.inspect().Id, id, "reuse validation refuses without root repair or destructive recreation");
    assert.equal(existsSync(join(f.workspace, "repo-file")), false);
    assert.equal(statSync(f.workspace).mode & 0o7777, 0o777);
    // Once the operator restores it, preserve existing clone state.
    execFileSync("docker", ["exec", "--user", "0", f.name, "sh", "-c", "rm /repos && mv /original-repos /repos"], { stdio: "pipe" });
    result = await f.run("cat /repos/state");
    assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /ready/);
    assert.equal(f.inspect().Id, id);
  } finally { f.close(); }
});


test("real reproducer: cap-drop ALL root cannot chmod a non-root-owned image /repos", { skip: !liveDocker }, () => {
  const f = fixture("root-negative-control");
  try {
    f.build("chown sandbox:sandbox /repos && chmod 0755 /repos");
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--user", "0", "--entrypoint", "/bin/sh", f.opts.config.image,
      "-c", "chmod 1777 /repos"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Operation not permitted/);
  } finally { f.close(); }
});

for (const [suffix, setup] of [
  ["root-owned", "chmod 0755 /repos && echo image-seed > /repos/seed"],
  ["user-owned", "echo image-seed > /repos/seed && chown sandbox:sandbox /repos && chmod 0755 /repos"],
  ["private-user-owned", "echo image-seed > /repos/seed && chown sandbox:sandbox /repos && chmod 0700 /repos"],
  ["unknown-uid-owned", "echo image-seed > /repos/seed && chown 2345:2345 /repos && chmod 0700 /repos"],
  ["absent", "rmdir /repos"],
]) {
  test(`fresh ${suffix} /repos works without capabilities; reuse preserves state and permissions`, { skip: !liveDocker }, async () => {
    const f = fixture(suffix!);
    try {
      f.build(setup!);
      const result = await f.run(`test "$(id -u)" = 1000 && test "$(stat -c '%a' /repos)" = 1777 &&
        grep -E '^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):' /proc/self/status && echo clone-state > /repos/state`);
      assert.equal(result.exitCode, 0, result.output);
      for (const cap of ["Inh", "Prm", "Eff", "Bnd", "Amb"]) assert.match(result.output, new RegExp(`Cap${cap}:\\s+0+`));
      assert.match(result.output, /NoNewPrivs:\s+1/);
      const id = f.inspect().Id;
      assert.deepEqual(f.inspect().HostConfig.CapDrop, ["ALL"]);
      assert.ok(f.inspect().HostConfig.SecurityOpt.includes("no-new-privileges:true"));
      // Out-of-band owner mutation shows reused exec never repeats chmod.
      const owner = execFileSync("docker", ["exec", "--user", "0", f.name, "stat", "-c", "%u", "/repos"], { encoding: "utf8" }).trim();
      execFileSync("docker", ["exec", "--user", owner, f.name, "chmod", "1773", "/repos"]);
      const resumed = await f.run(`test "$(stat -c '%a' /repos)" = 1773 && cat /repos/state`);
      assert.equal(resumed.exitCode, 0, resumed.output);
      assert.match(resumed.output, /clone-state/);
      assert.equal(f.inspect().Id, id);
      if (suffix !== "absent") {
        const seed = await f.run("cat /repos/seed");
        assert.equal(seed.exitCode, 0, seed.output); assert.match(seed.output, /image-seed/);
      }
    } finally { f.close(); }
  });
}

for (const destination of ["/repos", "/repos/child"]) {
  test(`bootstrap refuses a bind mount at ${destination} before owner discovery/chmod`, { skip: !liveDocker }, () => {
    const f = fixture(destination === "/repos" ? "mount" : "submount");
    try {
      f.build("chmod 1777 /repos");
      const target = join(f.root, "redirect"); mkdirSync(target); chmodSync(target, 0o755);
      const args = buildCreateArgs(f.opts, f.name);
      args.splice(args.indexOf(f.opts.config.image), 0, "--mount", `type=bind,src=${target},dst=${destination}`);
      execFileSync("docker", args, { stdio: "pipe" });
      for (const operation of ["prepare", "chmod"] as const) {
        const result = spawnSync("docker", ["exec", "--user", "0", f.name, "/bin/sh", "-c", repositoryStorageScript(false, operation)], { encoding: "utf8" });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /durable mount redirects are forbidden/);
        assert.equal(result.stdout, "", "no owner emitted on rejected path");
        assert.equal(statSync(target).mode & 0o7777, 0o755);
      }
    } finally { f.close(); }
  });
}

test("non-root-owned image /repos with read-only-root uses tmpfs without owner setup", { skip: !liveDocker }, async () => {
  const f = fixture("user-owned-readonly");
  try {
    f.build("chown sandbox:sandbox /repos && chmod 0700 /repos");
    f.opts.config.readOnlyRoot = true;
    let result = await f.run(`test "$(id -u)" = 1000 && test "$(stat -c '%a' /repos)" = 1777 && echo volatile > /repos/state`);
    assert.equal(result.exitCode, 0, result.output);
    const id = f.inspect().Id;
    result = await f.run("cat /repos/state");
    assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /volatile/);
    assert.equal(f.inspect().Id, id);
    assert.equal(f.inspect().HostConfig.ReadonlyRootfs, true);
    assert.equal(f.inspect().HostConfig.Tmpfs["/repos"], "rw,mode=1777,size=256m");
  } finally { f.close(); }
});


test("fresh bootstrap never resolves setup tools from an image PATH pointing at workspace/bin", { skip: !liveDocker }, async () => {
  const f = fixture("workspace-path");
  try {
    f.build("chown sandbox:sandbox /repos && chmod 0755 /repos", "ENV PATH=/workspace/bin:/usr/bin:/bin");
    mkdirSync(join(f.workspace, "bin"));
    for (const tool of ["stat", "chmod", "mkdir"]) {
      const path = join(f.workspace, "bin", tool);
      writeFileSync(path, '#!/bin/sh\necho setup-poison > /workspace/poisoned\nexit 1\n');
      chmodSync(path, 0o755);
    }
    const result = await f.run("echo safe-agent > /repos/state");
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(existsSync(join(f.workspace, "poisoned")), false);
  } finally { f.close(); }
});
