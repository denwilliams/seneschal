import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduledPrompt, quietScheduledPrompt } from "./scheduled-prompts.ts";

const modes = [
  ["visible", (prompt: string, timezone: string) => scheduledPrompt(prompt, timezone)],
  ["existing-thread", (prompt: string, timezone: string) => scheduledPrompt(prompt, timezone, true)],
  ["quiet", quietScheduledPrompt],
] as const;

for (const [mode, render] of modes) {
  test(`${mode} schedules get fresh execution context on every date`, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:30:00.123Z") });
    const prompt = "Report today's appointments and check tomorrow.";
    const first = render(prompt, "America/Los_Angeles");
    assert.ok(first.includes("Execution timestamp (UTC): 2026-01-01T00:30:00.123Z"));
    assert.ok(first.includes("Local date/time: 2025-12-31T16:30:00-08:00 [America/Los_Angeles]"));
    assert.ok(first.includes("Task timezone: America/Los_Angeles (UTC-08:00)"));
    assert.ok(first.includes("Resolve relative dates such as today/tomorrow from this execution time in this timezone"));
    assert.match(first, /not from task creation time, old thread timestamps, or stale context/);
    assert.ok(first.endsWith(`Task:\n${prompt}`));

    t.mock.timers.setTime(new Date("2026-01-02T00:30:00.123Z").getTime());
    const second = render(prompt, "America/Los_Angeles");
    assert.ok(second.includes("Execution timestamp (UTC): 2026-01-02T00:30:00.123Z"));
    assert.ok(second.includes("Local date/time: 2026-01-01T16:30:00-08:00 [America/Los_Angeles]"));
    assert.doesNotMatch(second, /2025-12-31|2026-01-01T00:30:00/);
  });

  test(`${mode} context handles UTC/local boundaries, fractional offsets, and DST transitions`, (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const cases = [
      ["UTC", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00+00:00"],
      ["Australia/Sydney", "2026-01-01T15:30:00Z", "2026-01-02T02:30:00+11:00"],
      ["Asia/Kathmandu", "2026-01-01T20:30:00Z", "2026-01-02T02:15:00+05:45"],
      ["Australia/Adelaide", "2026-06-01T00:00:00Z", "2026-06-01T09:30:00+09:30"],
      ["Australia/Sydney", "2026-04-04T15:59:59Z", "2026-04-05T02:59:59+11:00"],
      ["Australia/Sydney", "2026-04-04T16:00:00Z", "2026-04-05T02:00:00+10:00"],
      ["Australia/Sydney", "2026-10-03T15:59:59Z", "2026-10-04T01:59:59+10:00"],
      ["Australia/Sydney", "2026-10-03T16:00:00Z", "2026-10-04T03:00:00+11:00"],
      ["America/New_York", "2026-03-08T06:59:59Z", "2026-03-08T01:59:59-05:00"],
      ["America/New_York", "2026-03-08T07:00:00Z", "2026-03-08T03:00:00-04:00"],
      ["America/New_York", "2026-11-01T05:59:59Z", "2026-11-01T01:59:59-04:00"],
      ["America/New_York", "2026-11-01T06:00:00Z", "2026-11-01T01:00:00-05:00"],
    ] as const;
    for (const [timezone, utc, local] of cases) {
      t.mock.timers.setTime(new Date(utc).getTime());
      const framed = render("Report today.", timezone);
      assert.ok(framed.includes(`Execution timestamp (UTC): ${new Date(utc).toISOString()}`), utc);
      assert.ok(framed.includes(`Local date/time: ${local} [${timezone}]`), `${timezone}: ${utc}`);
    }
  });
}

test("temporal grounding is identical without changing each delivery mode's guidance", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const visible = scheduledPrompt("check", "UTC");
  const inThread = scheduledPrompt("check", "UTC", true);
  const quiet = quietScheduledPrompt("check", "UTC");
  assert.match(visible, /call \x60post_message\x60/);
  assert.match(inThread, /Resume the conversation in this thread/);
  assert.match(quiet, /your normal reply will not be shown in Slack/);
  for (const prompt of [visible, inThread, quiet]) {
    assert.equal(prompt.split("## Current scheduled execution").length - 1, 1);
    assert.equal(prompt.slice(prompt.indexOf("## Current scheduled execution")),
      visible.slice(visible.indexOf("## Current scheduled execution")));
  }
});
