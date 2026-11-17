import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleError, ScheduleStore, nextRunOf, type ScheduledTask, type ScheduleLimits } from "../agent/schedules.ts";
import { Scheduler } from "./scheduler.ts";

const limits: ScheduleLimits = {
  maxPerChannel: 3,
  minIntervalMinutes: 5,
  defaultTimezone: "UTC",
};

const base = { channelId: "C1", prompt: "check the backups", createdBy: "U1" };

test("startup runs one missed cron execution when opted in", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const store = new ScheduleStore(dataDir);
  const task = store.create({ ...base, cron: "0 8 * * *", runIfMissed: true }, limits);
  store.updateRunState(base.channelId, task.id, { lastRun: "2020-01-01T00:00:00.000Z" });

  let resolveRun!: () => void;
  const ran = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  const scheduler = new Scheduler(dataDir, limits, async () => {
    resolveRun();
    return { status: "completed" as const };
  });

  scheduler.start();
  await Promise.race([
    ran,
    new Promise((_, reject) => setTimeout(() => reject(new Error("missed run did not fire")), 500)),
  ]);
  scheduler.stop();

  assert.equal(store.list(base.channelId)[0]?.runCount, 1);
});

test("startup does not run missed cron executions without opt-in", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const store = new ScheduleStore(dataDir);
  const task = store.create({ ...base, cron: "0 8 * * *" }, limits);
  store.updateRunState(base.channelId, task.id, { lastRun: "2020-01-01T00:00:00.000Z" });
  const runs: string[] = [];
  const scheduler = new Scheduler(dataDir, limits, async (scheduled) => {
    runs.push(scheduled.id);
    return { status: "completed" as const };
  });

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  scheduler.stop();

  assert.deepEqual(runs, []);
});

test("records successful scheduled outcomes with timing and Slack output", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const store = new ScheduleStore(dataDir);
  const task = store.create({ ...base, cron: "0 8 * * *" }, limits);
  const scheduler = new Scheduler(dataDir, limits, async () => ({
    status: "completed" as const,
    slackOutputUrl: "https://example.slack.com/archives/C1/p123",
  }));

  await (scheduler as any).fire(task);

  const [run] = store.listRuns(base.channelId);
  assert.equal(run?.taskId, task.id);
  assert.equal(run?.status, "completed");
  assert.ok(run?.startedAt);
  assert.ok(run?.endedAt);
  assert.equal(run?.slackOutputUrl, "https://example.slack.com/archives/C1/p123");
  assert.equal(store.list(base.channelId)[0]?.lastError, undefined);
  assert.equal(store.list(base.channelId)[0]?.runCount, 1);
});

test("treats an agent-declared failure as a failed run and preserves lastError", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const store = new ScheduleStore(dataDir);
  const task = store.create({ ...base, cron: "0 8 * * *" }, limits);
  const scheduler = new Scheduler(dataDir, limits, async () => ({
    status: "failed" as const,
    error: "model unavailable",
    slackOutputUrl: "https://example.slack.com/archives/C1/p123",
  }));

  await (scheduler as any).fire(task);

  const [run] = store.listRuns(base.channelId);
  assert.equal(run?.status, "failed");
  assert.equal(run?.error, "model unavailable");
  assert.equal(run?.slackOutputUrl, "https://example.slack.com/archives/C1/p123");
  assert.equal(store.list(base.channelId)[0]?.lastError, "model unavailable");
  assert.equal(store.list(base.channelId)[0]?.runCount, 0);
});


// Observe real Cron jobs and trigger their callbacks without sleeping until a wall-clock run.
function liveJobs(scheduler: Scheduler): Map<string, import("croner").Cron> {
  return (scheduler as any).jobs;
}

test("invalid edits preserve the original live timer and its runnable instructions", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const fired: ScheduledTask[] = [];
  const scheduler = new Scheduler(dataDir, limits, async (task) => {
    fired.push(task);
    return { status: "completed" };
  });
  t.after(() => scheduler.stop());
  const task = scheduler.create({ ...base, cron: "0 8 * * *", quiet: true, runIfMissed: true });
  const originalJob = liveJobs(scheduler).get("C1:" + task.id)!;
  const file = join(dataDir, "channels", "C1", "schedules.json");
  const original = readFileSync(file, "utf8");
  for (const patch of [
    { prompt: "" }, { cron: "invalid" }, { cron: "* * * * *" },
    { timezone: "Not/AZone" }, { runAt: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    assert.throws(() => scheduler.update("C1", task.id, patch), ScheduleError);
    assert.equal(liveJobs(scheduler).get("C1:" + task.id), originalJob);
    assert.equal(originalJob.isRunning(), true);
    assert.equal(readFileSync(file, "utf8"), original);
  }
  assert.equal(scheduler.update("C2", task.id, { prompt: "steal task" }), undefined);
  assert.equal(liveJobs(scheduler).get("C1:" + task.id), originalJob);
  assert.deepEqual(scheduler.list("C2"), []);
  await originalJob.trigger();
  assert.deepEqual(fired, [task]);
});

test("a persistence failure leaves the original task and live timer untouched", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const scheduler = new Scheduler(dataDir, limits, async () => ({ status: "completed" }));
  t.after(() => scheduler.stop());
  const task = scheduler.create({ ...base, cron: "0 8 * * *" });
  const originalJob = liveJobs(scheduler).get("C1:" + task.id)!;
  const file = join(dataDir, "channels", "C1", "schedules.json");
  const original = readFileSync(file, "utf8");
  mkdirSync(file + ".tmp"); // Force the atomic write to fail before rename.
  assert.throws(() => scheduler.update("C1", task.id, { prompt: "replacement" }));
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(liveJobs(scheduler).get("C1:" + task.id), originalJob);
  assert.equal(originalJob.isRunning(), true);
});

test("successful edits replace the timer, fire edited instructions and survive scheduler restart", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const fired: ScheduledTask[] = [];
  const run = async (task: ScheduledTask) => { fired.push(task); return { status: "completed" as const }; };
  const scheduler = new Scheduler(dataDir, limits, run);
  t.after(() => scheduler.stop());
  const task = scheduler.create({ ...base, cron: "0 8 * * *", quiet: true });
  const key = "C1:" + task.id;
  const originalJob = liveJobs(scheduler).get(key)!;
  const updated = scheduler.update("C1", task.id, {
    prompt: "Check the new backups", cron: "0 10 * * *", timezone: "Australia/Sydney",
  })!;
  const editedJob = liveJobs(scheduler).get(key)!;
  assert.notEqual(editedJob, originalJob);
  assert.equal(originalJob.isRunning(), false);
  assert.equal(editedJob.isRunning(), true);
  assert.equal(editedJob.nextRun()?.toISOString(), nextRunOf(updated)?.toISOString());
  await editedJob.trigger();
  assert.deepEqual(fired, [updated]);
  const saved = scheduler.list("C1")[0]!;
  scheduler.stop();

  const restarted = new Scheduler(dataDir, limits, run);
  t.after(() => restarted.stop());
  restarted.start();
  assert.deepEqual(restarted.list("C1"), [saved]);
  const restoredJob = liveJobs(restarted).get(key)!;
  assert.equal(restoredJob.nextRun()?.toISOString(), nextRunOf(saved)?.toISOString());
  await restoredJob.trigger();
  assert.deepEqual(fired[1], saved);
});

test("switching timing modes re-arms the same task and one-shots still complete normally", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  const fired: ScheduledTask[] = [];
  const scheduler = new Scheduler(dataDir, limits, async (task) => { fired.push(task); return { status: "completed" }; });
  t.after(() => scheduler.stop());
  const task = scheduler.create({ ...base, cron: "0 8 * * *", runIfMissed: true });
  const key = "C1:" + task.id;
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const once = scheduler.update("C1", task.id, { runAt, runIfMissed: false })!;
  assert.equal(liveJobs(scheduler).get(key)!.nextRun()?.toISOString(), nextRunOf(once)?.toISOString());
  const recurring = scheduler.update("C1", task.id, { cron: "0 9 * * *" })!;
  assert.equal(recurring.runAt, undefined);
  assert.equal(liveJobs(scheduler).get(key)!.nextRun()?.toISOString(), nextRunOf(recurring)?.toISOString());
  scheduler.update("C1", task.id, { runAt });
  await liveJobs(scheduler).get(key)!.trigger();
  assert.deepEqual(fired, [once]);
  assert.deepEqual(scheduler.list("C1"), []);
  assert.equal(liveJobs(scheduler).has(key), false);
  assert.equal(new ScheduleStore(dataDir).listRuns("C1")[0]?.status, "completed");
});

test("an in-flight one-shot does not delete its edited replacement on completion", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-live-"));
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const scheduler = new Scheduler(dataDir, limits, async () => { await wait; return { status: "completed" }; });
  t.after(() => scheduler.stop());
  const task = scheduler.create({ ...base, runAt: new Date(Date.now() + 3_600_000).toISOString() });
  const key = "C1:" + task.id;
  const running = liveJobs(scheduler).get(key)!.trigger();
  const updated = scheduler.update("C1", task.id, { runAt: new Date(Date.now() + 7_200_000).toISOString() })!;
  finish();
  await running;
  assert.equal(scheduler.list("C1")[0]?.runAt, updated.runAt);
  assert.equal(scheduler.list("C1")[0]?.runCount, 1);
  assert.equal(liveJobs(scheduler).get(key)!.isRunning(), true);
});
