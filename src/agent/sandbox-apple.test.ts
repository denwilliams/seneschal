import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { SandboxSchema, SandboxOverrideSchema } from "../config/schema.ts";
import { workspaceFixture } from "../workspace/fixture.ts";
import { presentSkills, containerPathAliases } from "./skills.ts";
import { buildCreateArgs, buildExecArgs, buildRunArgs, containerNameFor, createContainerBashOperations,
  describeSandbox, dockerfileFingerprint, ensureChannelImage, startSandboxCleanup, stopAllSandboxes } from "./sandbox.ts";
import { appleAvailable, appleConfigProblem, appleHostProblem, inspectAppleImage, pinAppleImage } from "./sandbox-apple.ts";
import { appleRuntime, INSTANCE_LABEL, type DockerCall } from "./sandbox-runtime.ts";
import { BACKEND_LABEL, CONFIG_LABEL, OWNER_LABEL, SandboxLifecycle } from "./sandbox-lifecycle.ts";

const config = SandboxSchema.parse({ mode: "macos-container", readOnlyRoot: true, pidsLimit: null });
const digest = `sha256:${"a".repeat(64)}`;
function imageInfo(labels: Record<string, string> = {}, env: string[] = []) {
  return [{ configuration: { name: "docker.io/library/sandbox:latest", descriptor: { digest } },
    variants: [{ platform: { os: "linux", architecture: "arm64" }, config: { config: { Labels: labels, Env: env } } }] }];
}
function tree(t: TestContext) {
  const data = mkdtempSync(join(tmpdir(), "sandbox-apple-"));
  const workspace = join(data, "channels/C1/workspace");
  const skills = join(data, "channels/C1/skills");
  mkdirSync(workspace, { recursive: true }); mkdirSync(skills, { recursive: true });
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const opts = { config, workspace, dataDir: data, dockerDataDir: "/must-not-be-used", channelId: "C1", threadKey: "123.456",
    env: { TOKEN: "private-value", SLACK_BOT_TOKEN: "never-forward" },
    mounts: [{ hostPath: skills, containerPath: "/skills/channel", readOnly: true }] };
  return { data, workspace, skills, opts };
}
const values = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);

test("Apple is opt-in; Docker/host defaults and full/override schema agree", () => {
  assert.equal(SandboxSchema.parse({}).mode, "host");
  assert.equal(SandboxSchema.parse({ mode: "docker" }).pidsLimit, 256);
  assert.equal(SandboxSchema.parse({ mode: "docker" }).readOnlyRoot, false);
  assert.deepEqual(SandboxOverrideSchema.parse({ mode: "macos-container", pidsLimit: null }), { mode: "macos-container", pidsLimit: null });
  assert.equal(appleConfigProblem(config), undefined);
  assert.match(appleConfigProblem(SandboxSchema.parse({ mode: "macos-container" }))!, /pidsLimit: null/);
  assert.match(appleConfigProblem({ ...config, readOnlyRoot: false })!, /readOnlyRoot: true/);
  assert.match(appleConfigProblem({ ...config, cpus: 0.5 })!, /whole number/);
  assert.match(appleConfigProblem(config, { LD_PRELOAD: "/workspace/evil.so" })!, /LD_\*/);
  assert.match(describeSandbox(config), /Apple container.*no PID limit.*lost on stop/);
});

test("native platform and client/server versions are checked, not just CLI existence", () => {
  assert.equal(appleHostProblem("darwin", "arm64", "25.0.0", false), undefined);
  for (const [platform, arch, release, docker] of [["linux", "arm64", "6.1", false], ["darwin", "x64", "25.0", false],
    ["darwin", "arm64", "24.0", false], ["darwin", "arm64", "25.0", true]] as const) {
    assert.match(appleHostProblem(platform, arch, release, docker)!, /native Apple Silicon/);
  }
  const status = (version: string, server = version, running = "running"): DockerCall => (args) => {
    assert.deepEqual(args, ["system", "status", "--format", "json"]);
    return JSON.stringify({ status: running, client: { version }, server: { version: server } });
  };
  assert.equal(appleAvailable(status("1.6.1")), true);
  assert.equal(appleAvailable(status("1.7.0")), true);
  for (const call of [status("1.6.0"), status("1.6.1", "1.5.0"), status("2.0.0"), status("1.6.1", "1.6.1", "not running"),
    (() => { throw new Error("daemon unavailable"); }) as DockerCall]) assert.equal(appleAvailable(call), false);
});

test("Apple create/run use native network, mount, resource and immutable security launcher semantics", (t) => {
  const f = tree(t);
  const args = buildCreateArgs(f.opts, "harness-apple-test", { managed: "yes" });
  assert.deepEqual(values(args, "--network"), ["none"]);
  assert.deepEqual(values(args, "--platform"), ["linux/arm64"]);
  assert.deepEqual(values(args, "--mount"), [
    `type=bind,src=${resolve(f.workspace)},dst=/workspace`,
    `type=bind,src=${resolve(f.skills)},dst=/skills/channel,readonly`,
  ]);
  assert.deepEqual(values(args, "--label"), ["managed=yes"]);
  assert.deepEqual(values(args, "--tmpfs"), ["/tmp:size=64m,mode=1777", "/repos:size=256m,mode=1777"]);
  assert.deepEqual(values(args, "--cap-drop"), ["ALL"]);
  assert.ok(args.includes("--read-only"));
  assert.ok(!args.includes("--pids-limit") && !args.includes("--security-opt"));
  assert.deepEqual(values(args, "--entrypoint"), ["/usr/bin/setpriv"]);
  assert.deepEqual(args.slice(-5), ["--no-new-privs", "--", "/bin/sh", "-c", "exec sleep infinity"]);
  assert.ok(!args.join(" ").includes("private-value"));
  const run = buildRunArgs({ ...f.opts, config: { ...config, network: "bridge", user: "1000:1000" } }, "n", "true");
  assert.deepEqual(values(run, "--network"), ["default"]);
  assert.deepEqual(values(run, "--user"), ["1000:1000"]);
  assert.deepEqual(values(run, "--mount"), values(args, "--mount"));
  assert.deepEqual(run.slice(-5, -1), ["--no-new-privs", "--", "bash", "-lc"]);
  assert.ok(!run.join(" ").includes("private-value") && !run.includes("SLACK_BOT_TOKEN"));
  const exec = buildExecArgs(f.opts, "n", "echo ok", join(f.workspace, "sub"));
  assert.deepEqual(values(exec, "--workdir"), ["/workspace/sub"]);
  assert.ok(exec.includes("TOKEN") && !exec.includes("SLACK_BOT_TOKEN"));
  assert.deepEqual(exec.slice(-6, -1), ["/usr/bin/setpriv", "--no-new-privs", "--", "bash", "-lc"]);
  assert.throws(() => buildCreateArgs({ ...f.opts, config: { ...config, pidsLimit: 256 } }, "n"), /pidsLimit/);
});

test("Apple mounts cannot escape the data directory or inject mount options", (t) => {
  const f = tree(t);
  const alias = join(f.data, "escape"); symlinkSync(tmpdir(), alias);
  for (const source of [alias, tmpdir(), f.data]) {
    assert.throws(() => buildCreateArgs({ ...f.opts, mounts: [{ hostPath: source, containerPath: "/skills/x", readOnly: true }] }, "n"), /not below/);
  }
  assert.throws(() => buildCreateArgs({ ...f.opts, mounts: [{ hostPath: f.skills, containerPath: "/workspace/skills", readOnly: true }] }, "n"), /inside \/workspace/);
  const comma = join(f.workspace, "comma,readonly"); mkdirSync(comma);
  assert.throws(() => buildCreateArgs({ ...f.opts, workspace: comma }, "n"), /comma/);
});

test("Apple names respect 63-character limit and keep stable channel/thread tuple identities", () => {
  const name = containerNameFor("C1", "x".repeat(1000), "macos-container");
  assert.ok(name.length <= 63);
  assert.equal(name, containerNameFor("C1", "x".repeat(1000), "macos-container"));
  assert.notEqual(name, containerNameFor("C2", "x".repeat(1000), "macos-container"));
  assert.notEqual(containerNameFor("C1", "t", "macos-container"), containerNameFor("C1", "t"));
  assert.throws(() => containerNameFor("C1", "", "macos-container"), /stable/);
});

test("Apple image inspection pins the native digest, ignores unrelated labels, rejects unsafe image env", () => {
  const result = inspectAppleImage("sandbox:latest", () => JSON.stringify(imageInfo({ fingerprint: "wanted" })));
  assert.equal(result.reference, `docker.io/library/sandbox@${digest}`);
  assert.deepEqual(result.labels, { fingerprint: "wanted" });
  assert.throws(() => inspectAppleImage("x", () => JSON.stringify(imageInfo({}, ["LD_PRELOAD=/workspace/evil"]))), /LD_\*/);
  assert.throws(() => inspectAppleImage("x", () => "[]"), /Invalid Apple image/);
  const wrong = imageInfo(); wrong[0]!.variants[0]!.platform.architecture = "amd64";
  assert.throws(() => inspectAppleImage("x", () => JSON.stringify(wrong)), /linux\/arm64/);
});

test("Apple digest aliases are registered locally and verified against retag races", () => {
  let alias = false; const calls: string[][] = [];
  const call: DockerCall = (args) => {
    calls.push(args);
    if (args[1] === "tag") { alias = true; return ""; }
    if (args[2]?.includes("@") && !alias) throw new Error("image not found: alias");
    return JSON.stringify(imageInfo());
  };
  assert.equal(pinAppleImage("sandbox:latest", call), `docker.io/library/sandbox@${digest}`);
  assert.ok(calls.some((args) => args[1] === "tag" && args[2] === "sandbox:latest"));
  const racing: DockerCall = (args) => {
    const info = imageInfo();
    if (args[2]?.includes("@")) info[0]!.configuration.descriptor.digest = `sha256:${"b".repeat(64)}`;
    return JSON.stringify(info);
  };
  assert.throws(() => pinAppleImage("sandbox:latest", racing), /digest alias does not match/);
});

test("unsupported Apple protections fail before any runtime or host dispatch", async (t) => {
  const f = tree(t); let output = "";
  t.mock.method(childProcess, "execFileSync", () => assert.fail("must fail before CLI invocation"));
  t.mock.method(childProcess, "spawn", () => assert.fail("must never fall back to host/Docker"));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const operations = createContainerBashOperations({ ...f.opts, config: { ...config, pidsLimit: 256 } });
  assert.deepEqual(await operations.exec("true", f.workspace, { onData: (d) => { output += d.toString(); } }), { exitCode: 127 });
  assert.match(output, /pidsLimit: null/); assert.match(output, /no host fallback/);
});

test("Apple Dockerfile builds retain workspace-only context, labels and change-based rebuilds", (t) => {
  const f = tree(t), file = join(f.data, "channels/C1/Dockerfile");
  const text = "FROM debian:bookworm-slim\n"; writeFileSync(file, text);
  let labels = { "harness.dockerfile-sha": dockerfileFingerprint(text) };
  const calls: string[][] = [];
  t.mock.method(childProcess, "execFileSync", (exe: string, args: string[]) => {
    assert.equal(exe, "container"); calls.push(args);
    if (args[0] === "image") return JSON.stringify(imageInfo(labels));
    assert.equal(args[0], "build");
    labels = { "harness.dockerfile-sha": args[args.indexOf("--label") + 1]!.split("=")[1]! }; return "";
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(ensureChannelImage(file, f.workspace, "sandbox", "macos-container"), false);
  writeFileSync(file, text + "RUN true\n");
  assert.equal(ensureChannelImage(file, f.workspace, "sandbox", "macos-container"), true);
  const args = calls.find((args) => args[0] === "build")!;
  assert.equal(args.at(-1), f.workspace); assert.notEqual(args.at(-1), join(f.data, "channels/C1"));
  assert.deepEqual(values(args, "--file"), [file]);
  assert.deepEqual(values(args, "--platform"), ["linux/arm64"]);
  assert.equal(ensureChannelImage(file, f.workspace, "sandbox", "macos-container"), false);
});

function runtimeFixture(t: TestContext) {
  const f = tree(t); let present = false, running = false, count: number | undefined = 1, date = "2026-10-27T00:00:00Z", time = 1000;
  let labels: Record<string, string> = {}; const calls: string[][] = [];
  const name = containerNameFor("C1", "123.456", "macos-container");
  const call: DockerCall = (args) => {
    calls.push(args);
    switch (args[0]) {
      case "inspect": if (!present) throw new Error("container not found: " + name);
        return JSON.stringify([{ id: name, configuration: { id: name, creationDate: date, labels }, status: { state: running ? "running" : "stopped" } }]);
      case "stats": return JSON.stringify([{ id: name, numProcesses: count }]);
      case "start": running = true; return name;
      case "stop": running = false; return name;
      case "delete": assert.equal(running, false); present = false; return name;
      default: throw new Error(`Unexpected Apple call: ${args}`);
    }
  };
  const manager = new SandboxLifecycle(f.data, () => assert.fail("must not use Docker"), () => time, appleRuntime(call));
  const create = (ls: Record<string, string>) => { labels = ls; present = true; running = true; };
  const ensure = (fp = "v1") => manager.withLease(name, async () => manager.ensure(name, fp, 10, create));
  return { ...f, manager, name, call, create, ensure, calls, labels: () => labels,
    advance: () => { time += 20_000; }, count: (n?: number) => { count = n; },
    date: () => { date = "2026-10-27T01:00:00Z"; }, present: () => present, running: () => running };
}

test("Apple runtime lifecycle reuses prepared containers, protects background work, cancels whole VM and expires idle", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); f.manager.finish(f.name);
  await f.ensure(); assert.equal(f.calls.filter((a) => a[0] === "delete").length, 0);
  f.count(2); f.manager.finish(f.name); f.advance(); await f.manager.sweep(); assert.equal(f.present(), true);
  f.manager.cancel(f.name); assert.equal(f.running(), false); f.manager.finish(f.name);
  await f.ensure(); assert.equal(f.running(), true); f.count(1); f.manager.finish(f.name);
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), false);
  assert.ok(f.calls.some((a) => a.join(" ") === `stop --time 0 ${f.name}`));
  assert.ok(f.calls.some((a) => a[0] === "delete"));
  assert.ok(!f.calls.some((a) => ["top", "rm"].includes(a[0]!)));
});

test("Apple completed background processes eventually become eligible for idle cleanup", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); f.count(2); f.manager.finish(f.name);
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), true);
  f.count(1); await f.manager.sweep(); assert.equal(f.present(), true, "new idle clock after background completion");
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), false);
});

test("Apple unsuccessful exec uncertainty persists until the container is stopped", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); f.manager.finish(f.name, true);
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), true);
  await assert.rejects(f.ensure("v2"), /active processes/);
  f.manager.cancel(f.name); await f.ensure("v2"); f.manager.finish(f.name);
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), false);
});

test("Apple lifecycle namespaces records, leases, labels and cleanup separately from Docker", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); f.manager.finish(f.name);
  assert.equal(f.labels()[BACKEND_LABEL], "macos-container");
  const record = JSON.parse(readFileSync(join(f.manager.root, `${f.name}.json`), "utf8"));
  assert.equal(record.backend, "macos-container");
  const docker = new SandboxLifecycle(f.data, () => assert.fail("Docker must never inspect Apple records"));
  assert.notEqual(f.manager.root, docker.root); await docker.sweep();
  const restart = new SandboxLifecycle(f.data, () => assert.fail(), Date.now, appleRuntime(f.call));
  await restart.withLease(f.name, async () => restart.ensure(f.name, "v1", 10, () => assert.fail("must reuse across restart")));
  f.manager.finish(f.name);
});

test("Apple restart uncertainty survives later commands and requires confirmed stop before replacement/cleanup", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); // simulate lost harness before finish
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), true);
  await assert.rejects(f.ensure("v2"), /active processes/);
  await f.ensure(); f.manager.finish(f.name); f.advance(); await f.manager.sweep();
  assert.equal(f.present(), true, "successful later command cannot prove no old pending exec exists");
  f.manager.cancel(f.name); await f.ensure("v2"); f.manager.finish(f.name);
  assert.equal(f.labels()[CONFIG_LABEL], "v2");
});

test("Apple unknown stats and ownership collisions never permit deletion", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); f.count(); f.manager.finish(f.name); f.advance();
  await f.manager.sweep(); assert.equal(f.present(), true);
  f.labels()[OWNER_LABEL] = "foreign";
  await assert.rejects(f.ensure(), /another installation/);
  assert.throws(() => f.manager.cancel(f.name), /unowned/);
  const runtime = appleRuntime(() => { throw new Error("service unavailable"); });
  assert.throws(() => runtime.inspect(f.name), /service unavailable/);
  assert.throws(() => appleRuntime(() => "[]").inspect(f.name), /Invalid Apple/);
});

test("Apple creation date prevents adoption of a different same-name container with copied labels", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); f.manager.finish(f.name); f.date();
  let recreated = false;
  await f.manager.withLease(f.name, async () => f.manager.ensure(f.name, "v1", 10, (labels) => { recreated = true; f.create(labels); }));
  assert.equal(recreated, true); assert.ok(f.calls.some((a) => a[0] === "delete"));
});

test("Apple per-creation nonce prevents same-second name replacement from inheriting readiness", async (t) => {
  const f = runtimeFixture(t); await f.ensure(); f.manager.finish(f.name);
  f.labels()[INSTANCE_LABEL] = "00000000-0000-0000-0000-000000000000";
  await f.ensure();
  assert.ok(f.calls.some((a) => a[0] === "delete"));
  assert.notEqual(f.labels()[INSTANCE_LABEL], "00000000-0000-0000-0000-000000000000");
});

test("Apple channel Dockerfiles, skill locations and jail aliases use current container workspace lifecycle", () => {
  const f = workspaceFixture({ channels: { C1: { sandbox: { mode: "macos-container", readOnlyRoot: true, pidsLimit: null }, share: { skillCollections: ["team"] } } } });
  try {
    f.addCollectionSkill("team", "skill"); const first = f.resolve("C1");
    writeFileSync(join(first.paths.root, "Dockerfile"), "FROM debian:bookworm-slim\n");
    const c = f.resolve("C1"); assert.equal(c.channelDockerfile, join(c.paths.root, "Dockerfile"));
    assert.equal(c.sandbox.image, "harness-channel-c1:latest");
    const base = join(f.shared.skills, "team/skill");
    assert.equal(presentSkills(c, [{ filePath: join(base, "SKILL.md"), baseDir: base }])[0]!.filePath, "/skills/team/skill/SKILL.md");
    assert.ok(containerPathAliases(c).some((a) => a.from === "/skills/team"));
  } finally { rmSync(f.dataDir, { recursive: true, force: true }); }
});

// Real adapter path with a fake Apple CLI, including its host prerequisites.
function adapterFixture(t: TestContext, reuse: boolean) {
  const f = tree(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { value: "darwin" }); Object.defineProperty(process, "arch", { value: "arm64" });
  const exists = fs.existsSync;
  t.mock.method(fs, "existsSync", (p: fs.PathLike) => String(p) === "/.dockerenv" ? false : exists(p));
  t.mock.method(os, "release", () => "25.0.0");
  t.mock.method(SandboxLifecycle.prototype, "start", () => {});
  let running = false, present = false, labels: Record<string, string> = {}, name = "";
  const calls: { exe: string; args: string[] }[] = [];
  t.mock.method(childProcess, "execFileSync", (exe: string, args: string[]) => {
    assert.equal(exe, "container", "must never call Docker or host bash"); calls.push({ exe, args });
    switch (args[0]) {
      case "system": return JSON.stringify({ status: "running", client: { version: "1.6.1" }, server: { version: "1.6.1" } });
      case "image": return JSON.stringify(imageInfo());
      case "inspect": if (!present) throw new Error("container not found: " + name);
        return JSON.stringify([{ id: name, configuration: { id: name, creationDate: "today", labels }, status: { state: running ? "running" : "stopped" } }]);
      case "run": name = args[args.indexOf("--name") + 1]!; assert.ok(name.length <= 63);
        labels = Object.fromEntries(values(args, "--label").map((v) => v.split("="))); present = running = true; return name;
      case "exec": assert.ok(args.includes("/usr/bin/setpriv")); assert.match(args.at(-1)!, /\/proc\/self\/status[\s\S]*\/repos/); return "";
      case "stats": return JSON.stringify([{ id: name, numProcesses: 1 }]);
      case "stop": running = false; return name;
      case "start": running = true; return name;
      case "delete": assert.equal(running, false); present = false; return name;
      default: throw new Error(`Unexpected CLI ${args}`);
    }
  });
  const children: ReturnType<typeof child>[] = [];
  function child() {
    const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: () => { queueMicrotask(() => c.emit("close", null)); return true; } });
    return c;
  }
  const spawn = t.mock.method(childProcess, "spawn", (exe: string, args: string[], options: { env: Record<string, string> }) => {
    assert.equal(exe, "container"); assert.equal(options.env.TOKEN, "private-value");
    assert.ok(!args.join(" ").includes("private-value")); assert.ok(args.includes("/usr/bin/setpriv"));
    const c = child(); children.push(c); return c;
  });
  syncBuiltinESMExports(); startSandboxCleanup(f.data);
  t.after(() => {
    stopAllSandboxes(); t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", arch);
  });
  const operations = createContainerBashOperations({ ...f.opts, config: { ...config, reuse } });
  return { ...f, operations, calls, children, spawn, present: () => present, running: () => running };
}

for (const reuse of [true, false]) {
  test(`Apple adapter selects container exec and cancels all descendants (reuse=${reuse})`, async (t) => {
    const f = adapterFixture(t, reuse); const signal = new AbortController();
    const result = f.operations.exec("sleep forever", f.workspace, { signal: signal.signal, onData: () => {} });
    assert.equal(f.spawn.mock.callCount(), 1); signal.abort();
    assert.deepEqual(await result, { exitCode: 137 });
    assert.equal(f.running(), false); assert.equal(f.present(), reuse);
    assert.ok(f.calls.some((c) => c.args[0] === "stop"));
    assert.equal(f.calls.some((c) => c.args[0] === "delete"), !reuse);
  });
}

test("Apple adapter reuses successful thread commands and honours per-command timeout seconds", async (t) => {
  const f = adapterFixture(t, true);
  const first = f.operations.exec("true", f.workspace, { onData: () => {} }); f.children[0]!.emit("close", 0);
  assert.deepEqual(await first, { exitCode: 0 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const second = f.operations.exec("sleep forever", f.workspace, { timeout: 30, onData: () => {} });
  assert.equal(f.calls.filter((c) => c.args[0] === "run").length, 1);
  t.mock.timers.tick(29_999); assert.equal(f.running(), true);
  t.mock.timers.tick(1); assert.deepEqual(await second, { exitCode: 137 }); assert.equal(f.running(), false);
});
