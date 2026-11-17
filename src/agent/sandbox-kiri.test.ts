import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { createThreadSession } from "./session.ts";
import { HarnessConfigSchema, SandboxSchema, SandboxOverrideSchema } from "../config/schema.ts";
import { workspaceFixture } from "../workspace/fixture.ts";
import { kiriRuntime, dockerRuntime, type DockerCall } from "./sandbox-runtime.ts";
import { inspectKiriImage, kiriUnavailableReason } from "./sandbox-kiri.ts";
import { BACKEND_LABEL, OWNER_LABEL, SandboxLifecycle } from "./sandbox-lifecycle.ts";
import { buildCreateArgs, buildExecArgs, containerNameFor, createContainerBashOperations, describeSandbox,
  ensureChannelImage, isContainerMode, startSandboxCleanup, stopAllSandboxes } from "./sandbox.ts";

// Source-derived contracts, NOT captured host output. Provenance: Kiri v0.2.1
// b249eccc2ed708ce10d7feeb82b6c0869b112443, daemon/api.rs, ops.rs, docker.rs,
// kiri-image/src/archive.rs. See docs/kiri-sandbox.md.
const version = { Components: [{ Name: "Engine", Version: "27.5.1" }, { Name: "Kiri", Version: "0.2.1" }] };
const info = (labels: Record<string, string> = {}, running = true) => ({ Id: "a".repeat(64), Config: { Labels: labels }, State: { Running: running } });
const top = "UID  PID  PPID  C  STIME  TTY  TIME  CMD\nroot  900  1  0  09:00  ?  00:00:00  sleep infinity\n";
const values = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);
const digest = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;

function tree(t: TestContext) {
  const data = mkdtempSync(join(tmpdir(), "sandbox-kiri-")), workspace = join(data, "channels/C1/workspace");
  mkdirSync(workspace, { recursive: true });
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const config = SandboxSchema.parse({ mode: "kiri" });
  return { data, workspace, opts: { config, workspace, dataDir: data, dockerDataDir: data, channelId: "C1", threadKey: "123.456",
    env: { TOKEN: "private-value", SLACK_BOT_TOKEN: "never-forward" } } };
}

test("Kiri full/override configuration is explicit and keeps Docker defaults", (t) => {
  const f = tree(t);
  assert.equal(SandboxSchema.parse({}).mode, "host");
  assert.deepEqual(SandboxOverrideSchema.parse({ mode: "kiri" }), { mode: "kiri" });
  assert.throws(() => SandboxSchema.parse({ mode: "krii" }));
  assert.equal(isContainerMode("kiri"), true);
  assert.match(describeSandbox(f.opts.config), /^kiri /);
  const docker = { ...f.opts, config: { ...f.opts.config, mode: "docker" as const } };
  assert.deepEqual(buildCreateArgs(f.opts, "same"), buildCreateArgs(docker, "same"));
  assert.deepEqual(buildExecArgs(f.opts, "same", "true"), buildExecArgs(docker, "same", "true"));
  const args = buildCreateArgs(f.opts, "same");
  assert.ok(args.includes("no-new-privileges:true") && args.includes("ALL") && args.includes("--pids-limit"));
  assert.match(values(args, "--mount")[0]!, /dst=\/workspace,bind-propagation=rprivate/);
  assert.ok(!buildExecArgs(f.opts, "same", "true").join(" ").includes("private-value"));
  assert.ok(!buildExecArgs(f.opts, "same", "true").includes("SLACK_BOT_TOKEN"));
  assert.throws(() => buildCreateArgs({ ...f.opts, workspace: tmpdir() }, "n"), /not below/);
  assert.notEqual(containerNameFor("C1", "t", "kiri"), containerNameFor("C1", "t"));
  assert.notEqual(containerNameFor("C1", "a-b", "kiri"), containerNameFor("C1-a", "b", "kiri"));
});

test("Kiri verifies the server component, not Docker's compatibility version, and explains missing prerequisites", () => {
  assert.equal(kiriUnavailableReason((args) => {
    assert.deepEqual(args, ["version", "--format", "{{json .Server}}"]); return JSON.stringify(version);
  }), undefined);
  for (const raw of ["invalid", "{}", "null", JSON.stringify({ Components: [{ Name: "Engine", Version: "27.5.1" }] }),
    ...["0.2.0", "0.1.99", "0.2.1-dev", "garbage"].map((Version) => JSON.stringify({ Components: [{ Name: "Kiri", Version }] }))]) {
    assert.match(kiriUnavailableReason(() => raw)!, /Kiri.*0.2.1/);
  }
  for (const error of ["spawnSync kiri ENOENT", "Kiri isn't running", "no docker CLI found", "ETIMEDOUT"]) {
    assert.match(kiriUnavailableReason(() => { throw new Error(error); })!, /harness PATH.*setup.*kiri daemon.*no Docker-context or host fallback/);
  }
});

test("Kiri accepts source-derived omitted ExecIDs without treating them as an empty list; Docker stays strict", () => {
  const call = () => JSON.stringify([info()]);
  const inspected = kiriRuntime(call).inspect("name")!;
  assert.equal(inspected.ExecIDs, undefined);
  assert.equal(kiriRuntime(call).conservativeRecovery, true);
  assert.throws(() => dockerRuntime(call).inspect("name"), /Invalid Docker/);
  for (const ExecIDs of [null, [], ["pending"]]) {
    assert.deepEqual(kiriRuntime(() => JSON.stringify([{ ...info(), ExecIDs }])).inspect("name")!.ExecIDs, ExecIDs);
  }
  const malformed: unknown[] = [[], [info(), info()], {}, null, [null], [{ ...info(), Id: "" }], [{ ...info(), Id: "--option" }], [{ ...info(), Config: [] }],
    [{ ...info(), Config: { Labels: [] } }], [{ ...info(), Config: { Labels: { owner: 1 } } }], [{ ...info(), State: { Running: "true" } }],
    [{ ...info(), ExecIDs: "missing" }], [{ ...info(), ExecIDs: [1] }]];
  for (const raw of malformed) assert.throws(() => kiriRuntime(() => JSON.stringify(raw)).inspect("n"), /Invalid Kiri/);
  assert.throws(() => kiriRuntime(() => "bad JSON").inspect("n"));
  assert.equal(kiriRuntime(() => { throw new Error("No such container: n"); }).inspect("n"), undefined);
  assert.throws(() => kiriRuntime(() => { throw new Error("service unavailable"); }).inspect("n"), /service unavailable/);
});

test("Kiri fixed process table is parsed separately; malformed, background and pending activity fail closed", () => {
  const runtime = kiriRuntime((args) => { assert.deepEqual(args, ["top", info().Id]); return top; });
  assert.equal(runtime.quiescent(info()), true);
  assert.equal(runtime.quiescent({ ...info(), ExecIDs: ["pending"] }), false);
  for (const table of ["", "PID\n900", top + "root  901  900  0  09:00  ?  00:00:00  server\n", top.split("\n")[0]!, top.replace("900", "bad")]) {
    assert.equal(kiriRuntime(() => table).quiescent(info()), false);
  }
  assert.throws(() => kiriRuntime(() => { throw new Error("top unavailable"); }).quiescent(info()), /unavailable/);
});

test("Kiri image config comes from digest-verified save, restoring missing Labels/Volumes safeguards", () => {
  const raw = JSON.stringify({ config: { Labels: { "harness.dockerfile-sha": "expected" } } }), id = digest(raw);
  const call: DockerCall = (args) => { assert.deepEqual(args, ["image", "inspect", "image"]); return JSON.stringify([{ Id: id, Config: {} }]); };
  assert.deepEqual(inspectKiriImage("image", call, (requested) => { assert.equal(requested, id); return raw; }), { id, labels: { "harness.dockerfile-sha": "expected" } });
  for (const config of [{ Volumes: { "/repos": {} } }, { Volumes: [] }, { Labels: [] }]) {
    const raw = JSON.stringify({ config }), id = digest(raw);
    assert.throws(() => inspectKiriImage("image", () => JSON.stringify([{ Id: id }]), () => raw), /VOLUME|Invalid Kiri image config/);
  }
  const id2 = `sha256:${"b".repeat(64)}`;
  assert.throws(() => inspectKiriImage("image", () => JSON.stringify([{ Id: id2 }]), () => raw), /digest mismatch/);
  assert.throws(() => inspectKiriImage("image", () => JSON.stringify([{ Id: "bad" }]), () => raw), /identity/);
});

function lifecycleFixture(t: TestContext) {
  const f = tree(t); let present = false, running = false, table = top, time = 1000, labels: Record<string, string> = {};
  const name = containerNameFor("C1", "123.456", "kiri"), calls: string[][] = [];
  const call: DockerCall = (args) => {
    calls.push(args);
    switch (args[0]) {
      case "inspect": if (!present) throw new Error("No such container: " + name); return JSON.stringify([info(labels, running)]);
      case "top": return table;
      case "start": running = true; return "";
      case "stop": running = false; return "";
      case "rm": assert.equal(running, false); present = false; return "";
      default: throw new Error(`Unexpected Kiri command ${args}`);
    }
  };
  const manager = new SandboxLifecycle(f.data, () => assert.fail("no Docker"), () => time, kiriRuntime(call));
  const create = (ls: Record<string, string>) => { labels = ls; present = running = true; };
  const ensure = (fp = "v1") => manager.withLease(name, async () => manager.ensure(name, fp, 10, create));
  return { ...f, name, manager, call, calls, ensure, labels: () => labels, present: () => present, running: () => running,
    advance: () => { time += 20_000; }, table: (v: string) => { table = v; } };
}

test("Kiri lifecycle reuses, starts, cancels, removes and namespaces owned state", async (t) => {
  const f = lifecycleFixture(t); await f.ensure(); f.manager.finish(f.name);
  assert.equal(f.labels()[BACKEND_LABEL], "kiri"); assert.equal(f.manager.root, join(f.data, "sandboxes/kiri"));
  await f.ensure(); f.manager.finish(f.name); assert.ok(!f.calls.some((a) => a[0] === "rm"));
  f.manager.cancel(f.name); assert.equal(f.running(), false); await f.ensure(); assert.equal(f.running(), true);
  f.manager.finish(f.name); f.advance(); await f.manager.sweep(); assert.equal(f.present(), false);
  assert.ok(f.calls.some((a) => a.join(" ") === `stop --time 0 ${info().Id}`));
});

test("Kiri unknown process output and foreign ownership never permit cleanup/adoption", async (t) => {
  const f = lifecycleFixture(t); await f.ensure(); f.table("unexpected"); f.manager.finish(f.name); f.advance(); await f.manager.sweep();
  assert.equal(f.present(), true); await assert.rejects(f.ensure("v2"), /active processes/);
  f.labels()[OWNER_LABEL] = "foreign";
  await assert.rejects(f.ensure(), /another installation/); assert.throws(() => f.manager.cancel(f.name), /unowned/);
});

for (const interrupted of [true, false]) test(`Kiri protects ${interrupted ? "crash-interrupted" : "lost-client"} pending execs across successful later commands`, async (t) => {
  const f = lifecycleFixture(t); await f.ensure(); if (!interrupted) f.manager.finish(f.name, true);
  const restart = new SandboxLifecycle(f.data, () => assert.fail(), Date.now, kiriRuntime(f.call));
  f.advance(); await restart.sweep(); assert.equal(f.present(), true);
  await assert.rejects(f.ensure("v2"), /active processes/);
  await f.ensure(); f.manager.finish(f.name); f.advance(); await f.manager.sweep(); assert.equal(f.present(), true);
  f.manager.cancel(f.name); await f.ensure("v2"); f.manager.finish(f.name); f.advance(); await f.manager.sweep(); assert.equal(f.present(), false);
});

test("Kiri background completion starts a fresh idle clock", async (t) => {
  const f = lifecycleFixture(t); await f.ensure(); f.table(top + "root 901 900 0 09:00 ? 00:00:00 service\n"); f.manager.finish(f.name);
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), true);
  f.table(top); await f.manager.sweep(); assert.equal(f.present(), true);
  f.advance(); await f.manager.sweep(); assert.equal(f.present(), false);
});

function adapterFixture(t: TestContext, reuse = true) {
  const f = tree(t); let present = false, running = false, labels: Record<string, string> = {};
  let rawConfig = JSON.stringify({ config: { Labels: { fixture: f.data } } });
  const calls: string[][] = [];
  t.mock.method(SandboxLifecycle.prototype, "start", () => {});
  t.mock.method(childProcess, "execFileSync", (exe: string, args: string[], options: { env?: Record<string, string> }) => {
    if (exe === "tar") { assert.equal(args[2], `blobs/sha256/${digest(rawConfig).slice(7)}`); return rawConfig; }
    assert.equal(exe, "kiri", "never Docker/context or host bash"); calls.push(args);
    switch (args[0]) {
      case "version": return JSON.stringify(version);
      case "image": if (args[1] === "save") { assert.equal(args[2], "--output"); return ""; }
        return JSON.stringify([{ Id: digest(rawConfig), Config: {} }]);
      case "build": rawConfig = JSON.stringify({ config: { Labels: { "harness.dockerfile-sha": values(args, "--label")[0]!.split("=")[1] } } }); return "";
      case "inspect": if (!present) throw new Error("No such container: x"); return JSON.stringify([info(labels, running)]);
      case "run": labels = Object.fromEntries(values(args, "--label").map((v) => v.split("="))); present = running = true;
        assert.ok(!args.includes("TOKEN") && !args.includes("SLACK_BOT_TOKEN"), "idle container must not persist channel secrets"); return "";
      case "exec": assert.ok(args.at(-1)!.includes("/repos")); return args.at(-1)!.includes("stat -c") ? "0" : "";
      case "top": return top;
      case "stop": running = false; return "";
      case "start": running = true; return "";
      case "rm": assert.equal(running, false); present = false; return "";
      default: throw new Error(`Unexpected CLI ${args}`);
    }
  });
  let autoComplete = false;
  const children: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter })[] = [];
  t.mock.method(childProcess, "spawn", (exe: string, args: string[], options: { env: Record<string, string> }) => {
    assert.equal(exe, "kiri"); assert.equal(args[0], "exec"); assert.equal(options.env.TOKEN, "private-value");
    assert.ok(!args.join(" ").includes("private-value")); assert.ok(!args.includes("SLACK_BOT_TOKEN"));
    const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => { queueMicrotask(() => c.emit("close", null)); return true; } });
    children.push(c);
    if (autoComplete) setImmediate(() => { c.stdout.emit("data", Buffer.from("kiri-fixture-ok\n")); c.emit("close", 0); });
    return c;
  });
  syncBuiltinESMExports(); startSandboxCleanup(f.data);
  t.after(() => { stopAllSandboxes(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const operations = createContainerBashOperations({ ...f.opts, config: { ...f.opts.config, reuse } });
  return { ...f, calls, children, operations, autoComplete: () => { autoComplete = true; }, present: () => present, running: () => running };
}

for (const reuse of [true, false]) test(`Kiri real adapter dispatch and descendant cancellation (reuse=${reuse})`, async (t) => {
  const f = adapterFixture(t, reuse), signal = new AbortController();
  let output = "";
  const result = f.operations.exec("sleep 600 & wait", f.workspace, { signal: signal.signal, onData: (d) => { output += d.toString(); } });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.children.length, 1, output); signal.abort();
  assert.deepEqual(await result, { exitCode: 137 }); assert.equal(f.running(), false); assert.equal(f.present(), reuse);
  assert.equal(f.calls.some((c) => c[0] === "rm"), !reuse);
});

test("Kiri successful commands reuse prepared container; builds use workspace and OCI labels", async (t) => {
  const f = adapterFixture(t);
  const file = join(f.data, "channels/C1/Dockerfile"); writeFileSync(file, "FROM debian:bookworm-slim\n");
  assert.equal(ensureChannelImage(file, f.workspace, "test-image", "kiri"), true);
  assert.equal(ensureChannelImage(file, f.workspace, "test-image", "kiri"), false);
  assert.equal(f.calls.find((c) => c[0] === "build")!.at(-1), f.workspace);
  for (let i = 0; i < 2; i++) {
    let output = "";
    const result = f.operations.exec("true", f.workspace, { onData: (d) => { output += d.toString(); } });
    await new Promise((r) => setImmediate(r));
    assert.ok(f.children[i], output); f.children[i]!.emit("close", 0);
    assert.deepEqual(await result, { exitCode: 0 });
  }
  assert.equal(f.calls.filter((c) => c[0] === "run").length, 1);
  assert.equal(f.calls.filter((c) => c[0] === "exec" && c.includes("--user")).length, 2, "trusted /repos preparation only once");
  const record = JSON.parse(readFileSync(join(f.data, "sandboxes/kiri", `${containerNameFor("C1", "123.456", "kiri")}.json`), "utf8"));
  assert.equal(record.uncertain, false); assert.equal(record.active, false);
});

test("Kiri unavailable runtime fails before dispatch with actionable error and no fallback", async (t) => {
  const f = tree(t); let output = "";
  t.mock.method(childProcess, "execFileSync", (exe: string) => { assert.equal(exe, "kiri"); throw new Error("ENOENT"); });
  t.mock.method(childProcess, "spawn", () => assert.fail("must not dispatch"));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await createContainerBashOperations(f.opts).exec("true", f.workspace, { onData: (d) => { output += d.toString(); } });
  assert.equal(result.exitCode, 127); assert.match(output, /harness PATH.*kiri daemon/); assert.match(output, /no host fallback/);
});

test("Kiri channel Dockerfiles and workspace isolation use the shared main/subagent container path", () => {
  const f = workspaceFixture({ channels: { C1: { sandbox: { mode: "kiri" } } } });
  try {
    const c = f.resolve("C1"); writeFileSync(join(c.paths.root, "Dockerfile"), "FROM debian:bookworm-slim\n");
    const resolved = f.resolve("C1"); assert.equal(resolved.sandbox.mode, "kiri");
    assert.equal(resolved.channelDockerfile, join(c.paths.root, "Dockerfile"));
    assert.equal(resolved.sandbox.image, "harness-channel-c1:latest");
  } finally { rmSync(f.dataDir, { recursive: true, force: true }); }
});


test("main-agent and factory-role subagent bash both dispatch through Kiri and reuse the parent thread", async (t) => {
  const f = adapterFixture(t); f.autoComplete();
  const priorDataDir = process.env.HARNESS_DOCKER_DATA_DIR;
  process.env.HARNESS_DOCKER_DATA_DIR = f.data;
  t.after(() => { if (priorDataDir === undefined) delete process.env.HARNESS_DOCKER_DATA_DIR; else process.env.HARNESS_DOCKER_DATA_DIR = priorDataDir; });
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(f.data, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({
    agentSets: { factory: { agents: { coder: { description: "Implement a ready issue", tools: ["bash"], model: "fixture/model" } } } },
    channels: { eng: { model: "fixture/model", tools: ["bash"], agentSet: "factory", sandbox: { mode: "kiri" } } },
  });
  const channel = resolveChannel(config, f.data, { id: "C1", name: "eng", isDm: false }, new ChannelRegistry(f.data)).channel!;
  channel.env = { ...channel.env, ...f.opts.env };
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const session = await createThreadSession({ channel, threadKey: "123.456", harnessName: "Test", slackChannelLabel: "#eng", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1" });
  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo main" }, { id: "main-bash" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "Test the configured shell" }, { id: "delegate" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo factory" }, { id: "factory-bash" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("STATUS: done\nNEXT: reviewer\nKiri fixture execution completed."),
      fauxAssistantMessage("Both shells completed."),
    ]);
    await session.session.prompt("Exercise main and factory shells", { requestId: "kiri-routing", userId: "U1" });
    assert.equal(session.session.getLastAssistantText(), "Both shells completed.");
    assert.equal(f.children.length, 2, "both actual BashOperations routes dispatch");
    assert.equal(f.calls.filter((c) => c[0] === "run").length, 1, "factory subagent reuses parent container");
    assert.equal(faux.state.callCount, 5);
  } finally { await session.dispose(); await runtimes.closeAll(); }
});


test("Kiri failed stop confirmation never permits removal", async (t) => {
  const f = lifecycleFixture(t); await f.ensure();
  const runtime = kiriRuntime((args) => args[0] === "stop" ? "" : f.call(args));
  const manager = new SandboxLifecycle(f.data, () => assert.fail(), Date.now, runtime);
  assert.throws(() => manager.discard(f.name), /still running/);
  assert.equal(f.present(), true); assert.ok(!f.calls.some((args) => args[0] === "rm"));
});

for (const failure of ["nonzero", "spawn-error"] as const) test(`Kiri ${failure} exec persists conservative uncertainty`, async (t) => {
  const f = adapterFixture(t);
  const result = f.operations.exec("false", f.workspace, { onData: () => {} });
  assert.equal(f.children.length, 1);
  if (failure === "spawn-error") f.children[0]!.emit("error", new Error("CLI unavailable"));
  else f.children[0]!.emit("close", 1);
  assert.equal((await result).exitCode, failure === "spawn-error" ? 127 : 1);
  const record = JSON.parse(readFileSync(join(f.data, "sandboxes/kiri", `${containerNameFor("C1", "123.456", "kiri")}.json`), "utf8"));
  assert.equal(record.uncertain, true); assert.equal(record.active, true);
});
