import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScheduleError,
  ScheduleStore,
  describeSchedule,
  missedCronRun,
  nextRunOf,
  type ScheduleLimits,
  type ScheduledTask,
  type UpdateScheduleInput,
} from "./schedules.ts";

const limits: ScheduleLimits = {
  maxPerChannel: 3,
  minIntervalMinutes: 5,
  defaultTimezone: "UTC",
};

function store() {
  return new ScheduleStore(mkdtempSync(join(tmpdir(), "sched-")));
}

const base = { channelId: "C1", prompt: "check the backups", createdBy: "U1" };

test("creates a recurring schedule and reports its next run", () => {
  const s = store();
  const task = s.create({ ...base, cron: "0 8 * * *" }, limits);

  assert.equal(task.cron, "0 8 * * *");
  assert.equal(task.timezone, "UTC");
  assert.equal(task.quiet, undefined, "schedules are visible by default");
  assert.ok(nextRunOf(task), "a valid cron must have a next run");
});

test("creates a one-shot schedule in the future", () => {
  const s = store();
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const task = s.create({ ...base, runAt }, limits);

  assert.equal(task.runAt, runAt);
  assert.ok(nextRunOf(task));
});

test("creates and describes a quiet schedule", () => {
  const s = store();
  const task = s.create({ ...base, cron: "0 8 * * *", quiet: true }, limits);

  assert.equal(task.quiet, true);
  assert.match(describeSchedule(task), /quiet/);
});

test("creates a recurring schedule that catches up missed runs", () => {
  const s = store();
  const task = s.create({ ...base, cron: "0 8 * * *", runIfMissed: true }, limits);

  assert.equal(task.runIfMissed, true);
  assert.match(describeSchedule(task), /catches up missed cron runs/);
});

test("rejects a one-shot in the past", () => {
  const s = store();
  assert.throws(
    () => s.create({ ...base, runAt: new Date(Date.now() - 60_000).toISOString() }, limits),
    ScheduleError,
  );
});

test("rejects missed-run catch-up for one-shots", () => {
  const s = store();
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  assert.throws(() => s.create({ ...base, runAt, runIfMissed: true }, limits), ScheduleError);
});

test("rejects an invalid cron expression", () => {
  const s = store();
  assert.throws(() => s.create({ ...base, cron: "every morning" }, limits), ScheduleError);
});

test("requires exactly one of cron or runAt", () => {
  const s = store();
  assert.throws(() => s.create({ ...base }, limits), ScheduleError);
  assert.throws(
    () =>
      s.create(
        { ...base, cron: "0 8 * * *", runAt: new Date(Date.now() + 60_000).toISOString() },
        limits,
      ),
    ScheduleError,
  );
});

test("refuses a schedule that would fire too often", () => {
  const s = store();
  // Every minute: the classic runaway an agent might reach for.
  assert.throws(() => s.create({ ...base, cron: "* * * * *" }, limits), ScheduleError);
});

test("enforces the per-channel cap", () => {
  const s = store();
  for (let i = 0; i < limits.maxPerChannel; i++) {
    s.create({ ...base, cron: `0 ${i} * * *` }, limits);
  }
  assert.throws(() => s.create({ ...base, cron: "0 9 * * *" }, limits), ScheduleError);
});

test("schedules are stored per channel and do not leak between them", () => {
  const s = store();
  s.create({ ...base, cron: "0 8 * * *" }, limits);

  assert.equal(s.list("C1").length, 1);
  assert.equal(s.list("C2").length, 0, "another channel must not see it");
});

test("schedules persist and are discoverable at startup", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-"));
  new ScheduleStore(dataDir).create({ ...base, cron: "0 8 * * *" }, limits);

  const afterRestart = new ScheduleStore(dataDir);
  assert.deepEqual(afterRestart.channelsWithSchedules(), ["C1"]);
  assert.equal(afterRestart.list("C1").length, 1);
});

test("keeps an append-only scheduled-run ledger with Slack output links", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-"));
  const s = new ScheduleStore(dataDir);
  s.appendRun({
    id: "run-1",
    channelId: "C1",
    taskId: "task-1",
    startedAt: "2026-08-01T08:00:00.000Z",
    endedAt: "2026-08-01T08:01:00.000Z",
    status: "completed",
    slackOutputUrl: "https://example.slack.com/archives/C1/p1",
  });
  s.appendRun({
    id: "run-2",
    channelId: "C1",
    taskId: "task-1",
    startedAt: "2026-08-02T08:00:00.000Z",
    endedAt: "2026-08-02T08:01:00.000Z",
    status: "failed",
    error: "model unavailable",
  });

  const afterRestart = new ScheduleStore(dataDir);
  assert.deepEqual(afterRestart.listRuns("C1"), [
    {
      id: "run-1",
      channelId: "C1",
      taskId: "task-1",
      startedAt: "2026-08-01T08:00:00.000Z",
      endedAt: "2026-08-01T08:01:00.000Z",
      status: "completed",
      slackOutputUrl: "https://example.slack.com/archives/C1/p1",
    },
    {
      id: "run-2",
      channelId: "C1",
      taskId: "task-1",
      startedAt: "2026-08-02T08:00:00.000Z",
      endedAt: "2026-08-02T08:01:00.000Z",
      status: "failed",
      error: "model unavailable",
    },
  ]);
});

test("stores the Slack thread for a check-back", () => {
  const s = store();
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const task = s.create(
    { ...base, runAt, thread: { threadKey: "1700.0001", threadTs: "1700.0001" } },
    limits,
  );

  assert.deepEqual(s.list("C1")[0]!.thread, {
    threadKey: "1700.0001",
    threadTs: "1700.0001",
  });
  assert.match(task.id, /.+/);
});

test("cancel removes a schedule and reports whether it existed", () => {
  const s = store();
  const task = s.create({ ...base, cron: "0 8 * * *" }, limits);

  assert.equal(s.cancel("C1", task.id), true);
  assert.equal(s.list("C1").length, 0);
  assert.equal(s.cancel("C1", task.id), false, "cancelling twice is not an error");
});

test("update can convert an existing schedule to quiet", () => {
  const s = store();
  const task = s.create({ ...base, cron: "0 8 * * *" }, limits);

  const updated = s.update("C1", task.id, { quiet: true }, limits);

  assert.equal(updated?.quiet, true);
  assert.equal(s.list("C1")[0]?.quiet, true);
});

test("a schedule honours its own timezone", () => {
  const s = store();
  const utc = s.create({ ...base, cron: "0 8 * * *", timezone: "UTC" }, limits);
  const syd = s.create(
    { ...base, cron: "0 8 * * *", timezone: "Australia/Sydney" },
    limits,
  );

  const a = nextRunOf(utc)!;
  const b = nextRunOf(syd)!;
  assert.notEqual(a.getTime(), b.getTime(), "8am differs between these zones");
});

const catchUpTask: ScheduledTask = {
  id: "catchup",
  channelId: "C1",
  prompt: "check the backups",
  cron: "0 8 * * *",
  timezone: "UTC",
  createdBy: "U1",
  createdAt: "2026-01-01T00:00:00.000Z",
  runCount: 0,
  runIfMissed: true,
};

test("missedCronRun returns the latest unobserved cron run", () => {
  const missed = missedCronRun(catchUpTask, new Date("2026-01-02T09:00:00.000Z"));

  assert.equal(missed?.toISOString(), "2026-01-02T08:00:00.000Z");
});

test("missedCronRun ignores schedules without opt-in or already observed runs", () => {
  assert.equal(
    missedCronRun(
      { ...catchUpTask, runIfMissed: undefined },
      new Date("2026-01-02T09:00:00.000Z"),
    ),
    null,
  );
  assert.equal(
    missedCronRun(
      { ...catchUpTask, lastRun: "2026-01-02T08:05:00.000Z" },
      new Date("2026-01-02T09:00:00.000Z"),
    ),
    null,
  );
});


test("prompt-only edits preserve identity, attribution, flags and run history at the channel cap", () => {
  const s = store();
  const cap = { ...limits, maxPerChannel: 1 };
  const task = s.create({ ...base, cron: "0 8 * * *", quiet: true, runIfMissed: true }, cap);
  s.updateRunState("C1", task.id, { lastRun: new Date().toISOString(), lastError: "previous error", runCount: 4 });
  const original = s.list("C1")[0]!;

  const updated = s.update("C1", task.id, { prompt: "  Check the new backups  " }, cap);

  assert.deepEqual(updated, { ...original, prompt: "Check the new backups" });
  assert.deepEqual(s.list("C1"), [updated]);
});

test("edits cron and timezone and explicitly switches timing modes without changing id", () => {
  const s = store();
  const task = s.create({ ...base, cron: "0 8 * * *", quiet: true, runIfMissed: true }, limits);
  const timezoneOnly = s.update("C1", task.id, { timezone: "Australia/Sydney" }, limits)!;
  assert.deepEqual(timezoneOnly, { ...task, timezone: "Australia/Sydney" });
  assert.notEqual(nextRunOf(timezoneOnly)?.getTime(), nextRunOf(task)?.getTime());
  const updated = s.update("C1", task.id, { cron: " 0 9 * * * ", timezone: "Australia/Sydney" }, limits)!;
  assert.deepEqual(updated, { ...task, cron: "0 9 * * *", timezone: "Australia/Sydney" });
  assert.notEqual(nextRunOf(updated)?.getTime(), nextRunOf(task)?.getTime());

  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const once = s.update("C1", task.id, { runAt, runIfMissed: false }, limits)!;
  assert.equal(once.id, task.id);
  assert.equal(once.cron, undefined);
  assert.equal(once.runAt, runAt);
  assert.equal(once.quiet, true);
  assert.equal(once.runIfMissed, false);
  assert.equal(once.timezone, "Australia/Sydney");

  const recurring = s.update("C1", task.id, { cron: "0 10 * * *", runIfMissed: true }, limits)!;
  assert.equal(recurring.id, task.id);
  assert.equal(recurring.cron, "0 10 * * *");
  assert.equal(recurring.runAt, undefined);
  assert.equal(recurring.runIfMissed, true);
});

test("one-shot timing edits use creation parsing; timezone-only edits preserve the absolute time", () => {
  const s = store();
  const task = s.create({ ...base, runAt: new Date(Date.now() + 3_600_000).toISOString() }, limits);
  const inputTime = new Date(Date.now() + 7_200_000).toISOString().replace("Z", "+00:00");
  const edited = s.update("C1", task.id, { runAt: inputTime }, limits)!;
  const created = s.create({ ...base, runAt: inputTime }, limits);
  assert.equal(edited.runAt, created.runAt);
  const zoned = s.update("C1", task.id, { timezone: "Australia/Sydney" }, limits)!;
  assert.equal(zoned.runAt, edited.runAt);
  assert.equal(nextRunOf(zoned)?.toISOString(), nextRunOf(edited)?.toISOString());
});

test("invalid partial edits leave the persistent task byte-for-byte unchanged", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-"));
  const s = new ScheduleStore(dataDir);
  const task = s.create({ ...base, cron: "0 8 * * *", quiet: true, runIfMissed: true }, limits);
  const file = join(dataDir, "channels", "C1", "schedules.json");
  const original = readFileSync(file, "utf8");
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const patches: UpdateScheduleInput[] = [
    { prompt: "  " },
    { cron: "nonsense" },
    { cron: "" },
    { cron: "* * * * *" },
    { cron: "0 9 * * *", runAt },
    { runAt: "not a timestamp", runIfMissed: false },
    { runAt: "", runIfMissed: false },
    { runAt: new Date(Date.now() - 60_000).toISOString(), runIfMissed: false },
    { timezone: "Not/AZone" },
    { timezone: "" },
    { runAt }, // Catch-up must be explicitly disabled, not silently discarded.
  ];
  for (const patch of patches) {
    assert.throws(() => s.update("C1", task.id, patch, limits), ScheduleError, JSON.stringify(patch));
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(s.list("C1"), [task]);
  }
});

test("thread targeting survives compatible edits and rejects recurring or quiet updates", () => {
  const s = store();
  const task = s.create({
    ...base,
    runAt: new Date(Date.now() + 3_600_000).toISOString(),
    thread: { threadKey: "1700.1", threadTs: "1700.1" },
  }, limits);
  const patch = { prompt: "Check CI", runAt: new Date(Date.now() + 7_200_000).toISOString(), timezone: "Australia/Sydney" };
  const updated = s.update("C1", task.id, patch, limits)!;
  assert.deepEqual(updated, { ...task, ...patch });
  for (const invalid of [{ cron: "0 8 * * *" }, { quiet: true }, { runIfMissed: true }]) {
    assert.throws(() => s.update("C1", task.id, invalid, limits), ScheduleError);
    assert.deepEqual(s.list("C1"), [updated]);
  }
});

test("updates stay channel-scoped and cannot patch identity or attribution", () => {
  const s = store();
  const task = s.create({ ...base, cron: "0 8 * * *" }, limits);
  assert.equal(s.update("C2", task.id, { prompt: "steal task" }, limits), undefined);
  assert.deepEqual(s.list("C2"), []);
  assert.deepEqual(s.list("C1"), [task]);
  const updated = s.update("C1", task.id, { prompt: "new prompt", id: "changed", channelId: "C2", createdBy: "U2" } as UpdateScheduleInput, limits);
  assert.deepEqual(updated, { ...task, prompt: "new prompt" });
});

test("edited schedules persist through a store restart", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sched-"));
  const s = new ScheduleStore(dataDir);
  const task = s.create({ ...base, cron: "0 8 * * *", quiet: true, runIfMissed: true }, limits);
  const updated = s.update("C1", task.id, { prompt: "Check new backups", cron: "0 10 * * *", timezone: "Australia/Sydney" }, limits)!;
  const once = s.create({
    ...base, runAt: new Date(Date.now() + 3_600_000).toISOString(),
    thread: { threadKey: "1700.1", threadTs: "1700.1" },
  }, limits);
  const editedOnce = s.update("C1", once.id, {
    runAt: new Date(Date.now() + 7_200_000).toISOString(), timezone: "Australia/Sydney",
  }, limits)!;
  const restarted = new ScheduleStore(dataDir);
  assert.deepEqual(restarted.list("C1"), [updated, editedOnce]);
  assert.deepEqual(restarted.channelsWithSchedules(), ["C1"]);
  assert.equal(nextRunOf(restarted.list("C1")[0]!)?.toISOString(), nextRunOf(updated)?.toISOString());
});

test("creation shares timezone, timestamp and thread compatibility validation with edits", () => {
  const s = store();
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const thread = { threadKey: "1700.1", threadTs: "1700.1" };
  for (const timing of [
    { cron: "0 8 * * *", timezone: "Not/AZone" },
    { runAt, timezone: "Not/AZone" },
    { runAt: "invalid" },
    { cron: "0 8 * * *", thread },
    { runAt, thread, quiet: true },
  ]) {
    assert.throws(() => s.create({ ...base, ...timing }, limits), ScheduleError);
    assert.deepEqual(s.list("C1"), []);
  }
});
