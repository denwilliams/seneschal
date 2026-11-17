import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionEnvironment, sandboxMode, sandboxStatus, toolExecution } from "./execution.ts";
import { buildTools } from "./tools.ts";
import { buildSession } from "./session.ts";
import type { ExecutionEnvironment, SandboxMode } from "./api-types.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { BACKEND_LABEL, MANAGED_LABEL, OWNER_LABEL, SANDBOX_VERSION } from "../agent/sandbox-lifecycle.ts";
import { containerNameFor } from "../agent/sandbox.ts";
import { INSTANCE_LABEL } from "../agent/sandbox-runtime.ts";
import { fixture } from "./fixture.ts";

const owner = "12345678-1234-1234-1234-123456789abc";
const channel = (mode: SandboxMode) => ({ sandbox: { mode, reuse: true } }) as ResolvedChannel;
const environment = (mode: SandboxMode): ExecutionEnvironment => ({ configuredMode: mode, toolMode: mode, source: "runtime", reuse: true });

for (const mode of ["docker", "macos-container", "kiri", "host"] as const) {
  test(`${mode}: only bash follows the channel sandbox, including mixed tool sets`, async (t) => {
    const f = fixture();
    t.after(async () => { await f.server.stop(); await rm(f.dataDir, { recursive: true, force: true }); });
    const resolved = f.source.resolve(f.source.channels()[0]!)!;
    resolved.sandbox = { ...resolved.sandbox, mode, reuse: true };
    const tools = buildTools(f.source, f.source.channels()[0]!, undefined);
    assert.equal(tools.execution?.configuredMode, mode);
    assert.equal(tools.tools.find((tool) => tool.name === "bash")?.execution?.location, mode === "host" ? "outside" : mode);
    for (const tool of tools.tools.filter((tool) => tool.name !== "bash")) assert.equal(tool.execution?.location, "outside");
    for (const name of ["read", "write", "edit", "find", "grep", "ls", "exec", "cli__git", "job_start", "run_subagent"]) {
      assert.equal(toolExecution({ name, group: "other" }, mode).location, "outside");
    }
    const session = await buildSession(f.source, f.source.channels()[0]!, undefined);
    assert.equal(session.execution?.status?.state, mode === "host" ? "not-applicable" : "unknown");
    assert.equal(session.execution?.source, "runtime");
    const closed = { ...f.source, runtime: () => undefined };
    assert.equal(buildTools(closed, f.source.channels()[0]!, undefined).execution?.source, "configuration");
  });
}

test("configuration is distinct from open-runtime wiring and unknown is preserved", () => {
  assert.deepEqual(executionEnvironment(channel("docker"), channel("host")), { configuredMode: "docker", toolMode: "host", source: "runtime" });
  assert.equal(executionEnvironment(undefined, undefined).toolMode, "unknown");
  assert.equal(sandboxMode("container"), "unknown");
  assert.equal(toolExecution({ name: "bash", group: "builtin" }, "unknown").location, "unknown");
  assert.match(toolExecution({ name: "git__log", group: "connector" }, "docker").detail, /remote.*unknown/);
});

for (const mode of ["docker", "macos-container", "kiri"] as const) {
  test(`${mode}: inspect running/stopped/absent; malformed, failed and foreign evidence stay unknown`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "console-execution-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "sandboxes", ...(mode === "docker" ? [] : [mode]));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "installation-id"), owner);
    const name = containerNameFor("C123", "123.456", mode);
    const labels = { [OWNER_LABEL]: owner, [BACKEND_LABEL]: mode, [MANAGED_LABEL]: SANDBOX_VERSION, [INSTANCE_LABEL]: owner };
    const raw = (running: boolean, owned = true) => JSON.stringify(mode !== "macos-container" ? [{ Id: mode === "kiri" ? "a".repeat(64) : "container-id", Config: { Labels: owned ? labels : {} }, State: { Running: running }, ExecIDs: null }]
      : [{ id: name, configuration: { id: name, creationDate: "2026-01-01", labels: owned ? labels : {} }, status: { state: running ? "running" : "stopped" } }]);
    for (const running of [true, false]) {
      const status = await sandboxStatus(dir, "C123", "123.456", environment(mode), async (backend, id) => {
        assert.equal(backend, mode); assert.equal(id, name); return raw(running);
      }, 1_000);
      assert.equal(status.state, running ? "running" : "stopped");
      assert.equal(status.checkedAt, "1970-01-01T00:00:01.000Z");
    }
    const absent = await sandboxStatus(dir, "C123", "123.456", environment(mode), async () => { throw new Error(mode !== "macos-container" ? "No such object: x" : "container not found: x"); });
    assert.equal(absent.state, "absent");
    for (const body of ["[]", "{}", "invalid", raw(true, false), mode !== "macos-container" ? '[{"Id":"x","Config":{},"State":{"Running":"yes"},"ExecIDs":null}]' : raw(true).replace('"running"', '"starting"')]) {
      assert.equal((await sandboxStatus(dir, "C123", "123.456", environment(mode), async () => body)).state, "unknown");
    }
    for (const error of ["permission denied SECRET", "daemon unavailable", "timeout", "command not found"]) {
      const status = await sandboxStatus(dir, "C123", "123.456", environment(mode), async () => { throw new Error(error); });
      assert.equal(status.state, "unknown"); assert.doesNotMatch(JSON.stringify(status), /SECRET/);
    }
    if (mode === "macos-container") {
      assert.equal((await sandboxStatus(dir, "C123", "123.456", environment(mode), async () => raw(true).replace(INSTANCE_LABEL, "missing-instance"))).state, "unknown");
    }
    await rm(join(root, "installation-id"));
    assert.equal((await sandboxStatus(dir, "C123", "123.456", environment(mode), async () => raw(true))).state, "unknown");
  });
}

test("never guess container identity from channel liveness, subagent/scheduled keys or per-command mode", async () => {
  const forbidden = async () => { assert.fail("should not inspect"); };
  for (const key of [undefined, "main", "sub-abc", "scheduled-task-1", "dream-123"]) {
    assert.equal((await sandboxStatus("/unused", "C123", key, environment("docker"), forbidden)).state, "unknown");
  }
  assert.equal((await sandboxStatus("/unused", "C123", "123.456", { ...environment("docker"), reuse: false }, forbidden)).state, "unknown");
  assert.equal((await sandboxStatus("/unused", "C123", "123.456", { ...environment("docker"), reuse: undefined }, forbidden)).state, "unknown");
  assert.equal((await sandboxStatus("/unused", "C123", "123.456", environment("host"), forbidden)).state, "not-applicable");
  assert.equal((await sandboxStatus("/unused", "C123", "123.456", environment("unknown"), forbidden)).state, "unknown");
});
