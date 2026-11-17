import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ctx, effects, openRaw } from "./fixtures/spike-job.ts";

/**
 * What pi-durable tasks actually do across restarts. The job design (docs/STATE_AND_JOBS_DESIGN.md) rests on these, so they
 * are pinned here: an upgrade that changes one fails this file instead of quietly changing how jobs recover.
 */

function dirFor(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "tasks-char-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const until = async (fn: () => boolean, what: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

test("a task runs its phases in order, each committing a checkpoint", async (t) => {
  const dir = dirFor(t);
  writeFileSync(join(dir, "release"), "");
  const f = await openRaw(dir);
  t.after(() => f.harness.close(ctx));
  const id = await f.start("one");
  f.harness.resume();
  await until(() => effects(dir).includes("approve-waiting"), "the approval phase");
  await f.decide("one", "approved");
  const settled = await f.harness.waitForTask(id, ctx);
  assert.equal(settled.state.outcome.status, "completed");
  assert.deepEqual(effects(dir), ["a", "b", "approve-waiting", "decided-approved", "c"]);
});

test("after a graceful restart a task continues at the phase it was in: committed phases do not run again, the interrupted one does", async (t) => {
  const dir = dirFor(t);
  const first = await openRaw(dir);
  const id = await first.start("two");
  first.harness.resume();
  await until(() => effects(dir).includes("b"), "phase b to start");
  await first.harness.close(ctx); // b has written its effect but has not committed its checkpoint
  writeFileSync(join(dir, "release"), "");
  const second = await openRaw(dir);
  t.after(() => second.harness.close(ctx));
  second.harness.resume();
  await until(() => effects(dir).includes("approve-waiting"), "the restarted task to reach approval");
  assert.deepEqual(effects(dir), ["a", "b", "b", "approve-waiting"], "a ran once; b REPLAYED because it never committed; nothing was lost");
  await second.decide("two", "approved");
  assert.equal((await second.harness.waitForTask(id, ctx)).state.outcome.status, "completed");
});

test("after a SIGKILL the task resumes the same way: the interrupted phase replays, earlier phases do not", async (t) => {
  const dir = dirFor(t);
  const child = fork(fileURLToPath(new URL("./fixtures/spike-child.ts", import.meta.url)), [dir, "three"], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = ""; child.stderr?.on("data", (d) => { errors += d; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await Promise.race([
    new Promise<void>((resolve) => child.on("message", (m: { ready?: string }) => { if (m.ready === "in-b") resolve(); })),
    once(child, "exit").then(([code]) => { throw new Error(`child exited ${code}: ${errors}`); }),
    new Promise<never>((_r, reject) => { const timer = setTimeout(() => reject(new Error(`child timed out: ${errors}`)), 15000); timer.unref(); }),
  ]);
  child.kill("SIGKILL"); await once(child, "exit");
  assert.deepEqual(effects(dir), ["a", "b"]);
  writeFileSync(join(dir, "release"), "");
  const after = await openRaw(dir);
  t.after(() => after.harness.close(ctx));
  after.harness.resume();
  await until(() => effects(dir).includes("approve-waiting"), "the task to reach approval after the crash");
  assert.deepEqual(effects(dir), ["a", "b", "b", "approve-waiting"]);
  await after.decide("three", "approved");
  assert.equal((await after.harness.waitForTask((await after.harness.inspect(ctx)).tasks[0]!.record.id as never, ctx)).state.outcome.status, "completed");
});

test("a task waiting on a person survives a restart and continues when the decision is written from outside", async (t) => {
  const dir = dirFor(t);
  writeFileSync(join(dir, "release"), "");
  const first = await openRaw(dir);
  const id = await first.start("four");
  first.harness.resume();
  await until(() => effects(dir).includes("approve-waiting"), "the approval phase");
  await first.harness.close(ctx);
  const second = await openRaw(dir);
  t.after(() => second.harness.close(ctx));
  second.harness.resume();
  await until(() => effects(dir).filter((e) => e === "approve-waiting").length === 2, "the approval to be re-entered after the restart");
  assert.ok(!effects(dir).some((e) => e.startsWith("decided")), "still waiting: nothing decided it");
  await second.decide("four", "approved");
  const settled = await second.harness.waitForTask(id, ctx);
  assert.equal(settled.state.outcome.status, "completed");
  assert.deepEqual(effects(dir).slice(-2), ["decided-approved", "c"]);
});

test("a decision made while the harness was down is found on restart without waiting", async (t) => {
  const dir = dirFor(t);
  writeFileSync(join(dir, "release"), "");
  const first = await openRaw(dir);
  const id = await first.start("five");
  first.harness.resume();
  await until(() => effects(dir).includes("approve-waiting"), "the approval phase");
  await first.decide("five", "approved"); // lands in the store...
  await first.harness.close(ctx);         // ...and the harness goes down around it
  const second = await openRaw(dir);
  t.after(() => second.harness.close(ctx));
  second.harness.resume();
  const settled = await second.harness.waitForTask(id, ctx);
  assert.equal(settled.state.outcome.status, "completed");
});

test("a declined approval ends the task through its own phase, as an aborted outcome", async (t) => {
  const dir = dirFor(t);
  writeFileSync(join(dir, "release"), "");
  const f = await openRaw(dir);
  t.after(() => f.harness.close(ctx));
  const id = await f.start("six");
  f.harness.resume();
  await until(() => effects(dir).includes("approve-waiting"), "the approval phase");
  await f.decide("six", "declined");
  const settled = await f.harness.waitForTask(id, ctx);
  assert.deepEqual([settled.state.outcome.status, settled.state.outcome.reason], ["aborted", "declined"]);
  assert.ok(!effects(dir).includes("c"));
});

test("aborting a task from outside runs its abort handler and ends it", async (t) => {
  const dir = dirFor(t);
  const f = await openRaw(dir);
  t.after(() => f.harness.close(ctx));
  const id = await f.start("seven");
  f.harness.resume();
  await until(() => effects(dir).includes("b"), "phase b");
  assert.equal(await f.harness.abortTask(id, ctx), "marked");
  const settled = await f.harness.waitForTask(id, ctx);
  assert.equal(settled.state.outcome.status, "aborted");
  assert.ok(effects(dir).includes("abort-handler"));
});

test("a live task is visible to inspection with its kind, so the harness can tell a job from a conversation's own work", async (t) => {
  const dir = dirFor(t);
  const f = await openRaw(dir);
  t.after(() => f.harness.close(ctx));
  await f.start("eight");
  f.harness.resume();
  await until(() => effects(dir).includes("b"), "phase b");
  const tasks = (await f.harness.inspect(ctx)).tasks;
  const job = tasks.find((task) => task.record.kind === "spike.job");
  assert.ok(job, `inspect lists the job (saw ${tasks.map((task) => task.record.kind).join(", ")})`);
  assert.equal(job!.record.conversationId, f.root.id, "owned by the conversation it was created in, so a recovery gate keyed on conversations would see it");
});
