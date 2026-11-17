import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../slack/scheduler.ts";
import { createScheduleTools, type ScheduleService } from "./schedule-tools.ts";
import type { ScheduledTask, UpdateScheduleInput } from "./schedules.ts";

function fixture() {
  const created: Parameters<ScheduleService["create"]>[0][] = [];
  const service: ScheduleService = {
    create(input) {
      created.push(input);
      return {
        id: "task1",
        channelId: input.channelId,
        prompt: input.prompt,
        ...(input.cron ? { cron: input.cron } : {}),
        ...(input.runAt ? { runAt: input.runAt } : {}),
        timezone: input.timezone ?? "UTC",
        ...(input.thread ? { thread: input.thread } : {}),
        createdBy: input.createdBy,
        ...(input.quiet ? { quiet: true } : {}),
        ...(input.runIfMissed ? { runIfMissed: true } : {}),
        createdAt: new Date().toISOString(),
        runCount: 0,
      } satisfies ScheduledTask;
    },
    update() {
      return undefined;
    },
    list() {
      return [];
    },
    cancel() {
      return false;
    },
  };
  const [tool] = createScheduleTools({
    service,
    channelId: "C1",
    currentUserId: () => "U1",
    defaultTimezone: "UTC",
    currentThread: () => ({ threadKey: "1700.0001", threadTs: "1700.0001" }),
  });
  return { created, tool: tool as any };
}

test("can schedule a one-shot follow-up in the current thread", async () => {
  const { created, tool } = fixture();
  const runAt = new Date(Date.now() + 3_600_000).toISOString();

  const result = await tool.execute("t1", {
    prompt: "Check whether CI is green and report back.",
    runAt,
    in_thread: true,
  });

  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.thread, { threadKey: "1700.0001", threadTs: "1700.0001" });
  assert.equal(created[0]!.channelId, "C1", "the model cannot choose the channel");
  assert.match(result.content[0].text, /in this thread/i);
  assert.equal(result.details.threadTs, "1700.0001");
});

test("can opt a cron schedule into missed-run catch-up", async () => {
  const { created, tool } = fixture();

  const result = await tool.execute("t1", {
    prompt: "Check whether the backup ran and report back.",
    cron: "0 8 * * *",
    run_if_missed: true,
  });

  assert.equal(created[0]!.runIfMissed, true);
  assert.equal(result.details.runIfMissed, true);
  assert.match(result.content[0].text, /missed-run catch-up/);
});

test("rejects missed-run catch-up for one-shots", async () => {
  const { created, tool } = fixture();
  const runAt = new Date(Date.now() + 3_600_000).toISOString();

  await assert.rejects(
    () => tool.execute("t1", { prompt: "Check CI", runAt, run_if_missed: true }),
    /recurring cron/,
  );
  assert.equal(created.length, 0);
});

test("in-thread schedules are one-shot check-backs", async () => {
  const { created, tool } = fixture();

  await assert.rejects(
    () => tool.execute("t1", { prompt: "Check CI", cron: "0 8 * * *", in_thread: true }),
    /runAt/,
  );
  assert.equal(created.length, 0);
});

test("the schedule tool exposes thread choice but not channel choice", () => {
  const { tool } = fixture();
  const params = Object.keys(tool.parameters.properties);

  assert.ok(params.includes("in_thread"));
  assert.ok(!params.includes("channel"));
  assert.ok(!params.includes("channelId"));
});

test("can update missed-run catch-up", async () => {
  const patches: UpdateScheduleInput[] = [];
  const service: ScheduleService = {
    create() {
      throw new Error("unexpected create");
    },
    update(_channelId, id, patch) {
      patches.push(patch);
      return {
        id,
        channelId: "C1",
        prompt: "Check backups",
        cron: "0 8 * * *",
        timezone: "UTC",
        createdBy: "U1",
        createdAt: new Date().toISOString(),
        runCount: 0,
        runIfMissed: patch.runIfMissed,
      } satisfies ScheduledTask;
    },
    list() {
      return [];
    },
    cancel() {
      return false;
    },
  };
  const [, , tool] = createScheduleTools({
    service,
    channelId: "C1",
    currentUserId: () => "U1",
    defaultTimezone: "UTC",
  });

  const result = await (tool as any).execute("t1", { id: "task1", run_if_missed: true });

  assert.deepEqual(patches, [{ runIfMissed: true }]);
  assert.equal(result.details.runIfMissed, true);
});


function editableFixture(t: { after(fn: () => void): void }) {
  const service = new Scheduler(mkdtempSync(join(tmpdir(), "sched-tools-")), {
    maxPerChannel: 3, minIntervalMinutes: 5, defaultTimezone: "UTC",
  }, async () => ({ status: "completed" }));
  t.after(() => service.stop());
  const task = service.create({ channelId: "C1", prompt: "Check backups", cron: "0 8 * * *", createdBy: "U1", quiet: true, runIfMissed: true });
  const tools = createScheduleTools({ service, channelId: "C1", currentUserId: () => "U2", defaultTimezone: "UTC" });
  return { service, task, tool: tools[2] as any };
}

test("update tool exposes all editable settings but no channel, attribution or thread selector", (t) => {
  const { tool } = editableFixture(t);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["id", "prompt", "cron", "runAt", "timezone", "quiet", "run_if_missed"].sort());
  assert.deepEqual(tool.parameters.required, ["id"]);
});

test("prompt-only tool edits return the updated schedule and next run", async (t) => {
  const { service, task, tool } = editableFixture(t);
  const result = await tool.execute("t1", { id: task.id, prompt: "Check new backups" });
  assert.deepEqual(service.list("C1"), [{ ...task, prompt: "Check new backups" }]);
  assert.equal(result.details.prompt, "Check new backups");
  assert.equal(result.details.cron, task.cron);
  assert.equal(result.details.timezone, task.timezone);
  assert.ok(result.details.next);
  assert.match(result.content[0].text, /Check new backups/);
  assert.match(result.content[0].text, /next /);
});

test("tool edits timing and timezone and preserves explicit false flags", async (t) => {
  const { task, tool } = editableFixture(t);
  const recurring = await tool.execute("t1", { id: task.id, cron: "0 9 * * *", timezone: "Australia/Sydney" });
  assert.equal(recurring.details.cron, "0 9 * * *");
  assert.equal(recurring.details.timezone, "Australia/Sydney");
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const once = await tool.execute("t2", { id: task.id, runAt, run_if_missed: false, quiet: false });
  assert.equal(once.details.id, task.id);
  assert.equal(once.details.runAt, runAt);
  assert.equal(once.details.cron, undefined);
  assert.equal(once.details.runIfMissed, false);
  assert.equal(once.details.quiet, false);
  assert.ok(once.details.next);
  assert.match(once.content[0].text, /once at/);
});

test("tool rejects empty and invalid edits without changing the original task", async (t) => {
  const { service, task, tool } = editableFixture(t);
  await assert.rejects(() => tool.execute("t1", { id: task.id }), /Provide at least one/);
  await assert.rejects(() => tool.execute("t2", { id: task.id, prompt: "" }), /needs a prompt/);
  await assert.rejects(() => tool.execute("t3", { id: task.id, cron: "0 9 * * *", runAt: "invalid" }), /not both/);
  await assert.rejects(() => tool.execute("t4", { id: task.id, runAt: "invalid", run_if_missed: false }), /timestamp/);
  assert.deepEqual(service.list("C1"), [task]);
});

test("tool cannot edit a task in another channel even with an extra channel argument", async (t) => {
  const { service, task, tool } = editableFixture(t);
  const foreign = service.create({ channelId: "C2", prompt: "Private task", cron: "0 8 * * *", createdBy: "U3" });
  await assert.rejects(() => tool.execute("t1", { id: foreign.id, prompt: "overwrite", channelId: "C2" }), /No scheduled task .* in this channel/);
  assert.deepEqual(service.list("C2"), [foreign]);
  assert.deepEqual(service.list("C1"), [task]);
});
