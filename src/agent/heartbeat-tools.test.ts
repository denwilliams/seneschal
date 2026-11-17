import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../slack/scheduler.ts";
import { ScheduleStore, nextRunOf } from "./schedules.ts";
import { createHeartbeatTools, heartbeatContext } from "./heartbeat-tools.ts";
import { runtimeTemplate } from "./session.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";

const limits = { maxPerChannel: 3, minIntervalMinutes: 5, defaultTimezone: "UTC" };
const jobs = (scheduler: Scheduler): Map<string, import("croner").Cron> => (scheduler as any).jobs;
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-"));
  const fired: string[] = [];
  const scheduler = new Scheduler(dir, limits, async (task) => { fired.push(task.prompt); return { status: "completed" }; });
  t.after(() => { scheduler.stop(); rmSync(dir, { recursive: true, force: true }); });
  const tools = (channelId: string) => createHeartbeatTools({ service: scheduler, channelId, currentUserId: () => "U1", defaultTimezone: "UTC" });
  const call = (channelId: string, name: string, params: any = {}) => (tools(channelId).find((tool) => tool.name === name)! as any).execute("call", params);
  return { dir, scheduler, fired, call };
}

test("heartbeats opt in explicitly, persist per channel and cannot target another channel", async (t) => {
  const { dir, scheduler, call } = setup(t);
  assert.match(heartbeatContext(scheduler, "C1"), /not configured/);
  await assert.rejects(() => call("C1", "update_heartbeat", { prompt: "watch John" }), /interval_minutes/);
  await call("C1", "update_heartbeat", { interval_minutes: 15, prompt: "watch John", channelId: "C2" });
  await call("C2", "update_heartbeat", { interval_minutes: 60, prompt: "watch backups" });
  assert.equal(scheduler.list("C1")[0]!.prompt, "watch John");
  assert.equal(scheduler.list("C2")[0]!.intervalMinutes, 60);
  assert.match(heartbeatContext(scheduler, "C1"), /every 15 minutes/);
  assert.deepEqual(new ScheduleStore(dir).list("C1"), scheduler.list("C1"));
  assert.equal((await call("C1", "read_heartbeat")).details.prompt, "watch John");
  const task = scheduler.list("C1")[0]!;
  assert.equal(task.quiet, true);
  assert.ok(Math.abs(nextRunOf(task)!.getTime() - Date.now() - 15 * 60_000) < 2000);
  assert.equal(task.cron, undefined);
  assert.equal(task.runAt, undefined);
  assert.throws(() => scheduler.update("C1", task.id, { quiet: false }), /quiet interval/);
  assert.throws(() => scheduler.update("C1", task.id, { timezone: "Invalid/Zone" }), /Invalid timezone/);
  assert.equal(jobs(scheduler).has(`C1:${task.id}`), true);
  assert.throws(() => scheduler.update("C1", task.id, { cron: "0 * * * *" }), /quiet interval/);
  assert.throws(() => scheduler.create({ channelId: "C1", createdBy: "U1", heartbeat: true, intervalMinutes: 15, prompt: "duplicate" }), /already has a heartbeat/);
  for (const interval_minutes of [0, -1, 1, Infinity, NaN, 525601]) {
    await assert.rejects(() => call("C1", "update_heartbeat", { interval_minutes }));
  }
  assert.equal(scheduler.list("C1")[0]!.intervalMinutes, 15);
});

test("prompt edits preserve other watches, reject stale writes and apply on later executions", async (t) => {
  const { scheduler, call, fired } = setup(t);
  await call("C1", "update_heartbeat", { interval_minutes: 15, prompt: "Watch backups." });
  const task = scheduler.list("C1")[0]!;
  const key = `C1:${task.id}`;
  await jobs(scheduler).get(key)!.trigger();
  await call("C1", "update_heartbeat", { prompt: "Watch backups. Watch John's email.", expected_prompt: "Watch backups." });
  await assert.rejects(() => call("C1", "update_heartbeat", { prompt: "Only John", expected_prompt: "Watch backups." }), /changed/);
  await assert.rejects(() => call("C1", "update_heartbeat", { prompt: "Only John" }), /changed/);
  await jobs(scheduler).get(key)!.trigger();
  await call("C1", "update_heartbeat", { prompt: "Watch backups.", expected_prompt: "Watch backups. Watch John's email." });
  await jobs(scheduler).get(key)!.trigger();
  assert.deepEqual(fired, ["Watch backups.", "Watch backups. Watch John's email.", "Watch backups."]);
  assert.equal(scheduler.list("C1")[0]!.runCount, 3);
  await call("C1", "update_heartbeat", { enabled: false });
  assert.equal(jobs(scheduler).has(key), false);
  assert.equal(scheduler.list("C1")[0]!.prompt, "Watch backups.");
  assert.equal(nextRunOf(scheduler.list("C1")[0]!), null);
  await call("C1", "update_heartbeat", { interval_minutes: 60, enabled: true });
  assert.ok(Math.abs(jobs(scheduler).get(key)!.nextRun()!.getTime() - Date.now() - 60 * 60_000) < 2000);
});

test("restart retains future intervals, skips missed ticks and retains paused prompts", async (t) => {
  const { dir, scheduler, call, fired } = setup(t);
  await call("C1", "update_heartbeat", { interval_minutes: 15 });
  await call("C2", "update_heartbeat", { interval_minutes: 60, enabled: false });
  const task = scheduler.list("C1")[0]!;
  const key = `C1:${task.id}`;
  scheduler.stop();
  const store = new ScheduleStore(dir);
  const restart = () => { const s = new Scheduler(dir, limits, async () => { fired.push("restart"); return { status: "completed" }; }); t.after(() => s.stop()); s.start(); return s; };
  const future = restart();
  assert.equal(jobs(future).get(key)!.nextRun()!.toISOString(), task.nextHeartbeatAt);
  assert.equal(jobs(future).size, 1);
  future.stop();
  store.updateRunState("C1", task.id, { nextHeartbeatAt: "2020-01-01T00:00:00.000Z" });
  const missed = restart();
  assert.ok(jobs(missed).get(key)!.nextRun()!.getTime() > Date.now());
  assert.ok(Math.abs(Date.parse(store.list("C1")[0]!.nextHeartbeatAt!) - Date.now() - 15 * 60_000) < 2000);
  assert.deepEqual(fired, []);
});

test("long-running heartbeats skip overlapping ticks and use edits after completion", async (t) => {
  const { dir, scheduler } = setup(t);
  scheduler.stop();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const prompts: string[] = [];
  const s = new Scheduler(dir, limits, async (task) => { prompts.push(task.prompt); await hold; return { status: "completed" }; });
  t.after(() => s.stop());
  const task = s.create({ channelId: "C1", createdBy: "U1", heartbeat: true, intervalMinutes: 15, prompt: "old" });
  const key = `C1:${task.id}`;
  const running = jobs(s).get(key)!.trigger();
  assert.deepEqual(prompts, ["old"]);
  s.update("C1", task.id, { prompt: "new", expectedPrompt: "old" });
  await jobs(s).get(key)!.trigger();
  assert.deepEqual(prompts, ["old"]);
  release(); await running;
  await jobs(s).get(key)!.trigger();
  assert.deepEqual(prompts, ["old", "new"]);
  assert.equal(s.list("C1")[0]!.prompt, "new");
});


test("assistant runtime context refreshes cadence and is withheld when heartbeat tools are absent", async (t) => {
  const { dir, scheduler, call } = setup(t);
  const config = HarnessConfigSchema.parse({ channels: { general: { schedules: true } } });
  const channel = resolveChannel(config, dir, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(dir)).channel!;
  const template = runtimeTemplate({ channel, schedules: scheduler, harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT" } as any, { tools: [] } as any);
  assert.match(template.instructions!, /read_heartbeat first/);
  const render = template.sections!.find((section) => section.key === "runtime")!.render;
  const input = { agent: { tools: [{ name: "read_heartbeat" }] } } as any;
  assert.match(String(await render(input, {} as any)), /heartbeat: not configured/);
  await call("C1", "update_heartbeat", { interval_minutes: 15 });
  assert.match(String(await render(input, {} as any)), /every 15 minutes/);
  await call("C1", "update_heartbeat", { interval_minutes: 60, enabled: false });
  assert.match(String(await render(input, {} as any)), /paused, every 60 minutes/);
  assert.doesNotMatch(String(await render({ agent: { tools: [] } } as any, {} as any)), /Channel heartbeat:/);
});
