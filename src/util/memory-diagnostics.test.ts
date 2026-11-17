import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { descendantMemory, MemoryDiagnostics, startMemoryDiagnostics } from "./memory-diagnostics.ts";

test("numeric process-tree memory excludes the harness, collector and unrelated processes", () => {
  const table = "1 0 10\n 20 1 100\n21 20 30\n22 21 40\n23 20 2\n99 1 900\nnot numeric secrets\n";
  assert.deepEqual(descendantMemory(table, 20, 23), { count: 2, rssBytes: 70 * 1024 });
  assert.deepEqual(descendantMemory("20 21 100\n21 20 30\n", 20), { count: 1, rssBytes: 30 * 1024 });
  assert.deepEqual(descendantMemory("20 1 100", 20), { count: 0, rssBytes: 0 });
  assert.equal(descendantMemory(table, 999), undefined, "missing root is unknown, not a zero reading");
});

test("counts successful async starts cumulatively, running children separately, failures and sync exclusions", async () => {
  const diagnostics = new MemoryDiagnostics();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(child, "spawn");
    let sample = diagnostics.snapshot();
    assert.deepEqual(sample.asyncChildren, { started: 1, exited: 0, failedStarts: 0, running: 1 });
    if (["linux", "darwin"].includes(process.platform)) {
      assert.equal(sample.descendants.available, true);
      assert.ok("count" in sample.descendants && sample.descendants.count >= 1);
      assert.ok("rssBytes" in sample.descendants && sample.descendants.rssBytes > 0);
    }
    const closed = once(child, "close");
    child.kill();
    await closed;
    spawnSync(process.execPath, ["-e", "0"]);
    const failed = spawn("/nonexistent-harness-memory-test");
    failed.on("error", () => {});
    await new Promise<void>((resolve) => failed.once("close", () => resolve()));
    sample = diagnostics.snapshot();
    assert.deepEqual(sample.asyncChildren, { started: 1, exited: 1, failedStarts: 1, running: 0 });
    for (const value of Object.values(sample.harness)) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(sample.uptimeSeconds >= sample.observedSinceUptimeSeconds);
    const serialized = JSON.stringify(sample);
    assert.ok(!serialized.includes("nonexistent"));
    assert.ok(!serialized.includes("setInterval"));
    diagnostics.stop();
    const ignored = spawn(process.execPath, ["-e", "0"]);
    await once(ignored, "close");
    assert.equal(diagnostics.snapshot().asyncChildren.started, 1, "stop unsubscribes from global process events");
  } finally { child.kill(); diagnostics.stop(); }
});

test("stopping diagnostics detaches listeners from a still-running child", async () => {
  const diagnostics = new MemoryDiagnostics();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(child, "spawn");
    assert.equal(child.listenerCount("exit"), 1);
    diagnostics.stop();
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.listenerCount("error"), 0, "observation must not mask an unhandled process error");
  } finally {
    const closed = once(child, "close");
    child.kill();
    await closed;
    diagnostics.stop();
  }
});

test("the sampling timer is unref'ed and process observation does not swallow unhandled launch failures", () => {
  const moduleUrl = new URL("./memory-diagnostics.ts", import.meta.url).href;
  const script = `import { startMemoryDiagnostics } from ${JSON.stringify(moduleUrl)}; startMemoryDiagnostics("1", () => {});`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 3000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const unhandled = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    script + 'import { spawn } from "node:child_process"; spawn("/nonexistent-harness-memory-test");'], { timeout: 3000, encoding: "utf8" });
  assert.notEqual(unhandled.status, 0);
  assert.match(unhandled.stderr, /Unhandled 'error' event/);
});

test("disabled/invalid diagnostics do not start a timer; enabled diagnostics sample and stop", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const samples: ReturnType<MemoryDiagnostics["snapshot"]>[] = [];
  const warnings: string[] = [];
  for (const seconds of [undefined, "", "0", "-1", "1.5", "no", "3601", "Infinity"]) {
    startMemoryDiagnostics(seconds, (sample) => samples.push(sample), (message) => warnings.push(message))();
  }
  t.mock.timers.tick(60_000);
  assert.equal(samples.length, 0);
  assert.equal(warnings.length, 6);
  const stop = startMemoryDiagnostics("60", (sample) => samples.push(sample));
  try {
    assert.equal(samples.length, 1);
    t.mock.timers.tick(120_000);
    assert.equal(samples.length, 3);
    stop();
    t.mock.timers.tick(60_000);
    assert.equal(samples.length, 3);
  } finally { stop(); }
});
