import assert from "node:assert/strict";
import { test } from "node:test";
import { createTimeTools } from "./time-tools.ts";

function tool(timezone?: string) {
  const [currentTime] = createTimeTools(timezone);
  return {
    definition: currentTime!,
    read: async () => {
      const result = await currentTime!.execute("clock", {}, undefined, undefined, {} as never);
      const content = result.content[0]!;
      assert.equal(content.type, "text");
      if (content.type !== "text") throw new Error("Expected a text result");
      const parsed = JSON.parse(content.text);
      assert.deepEqual(result.details, parsed, "model-visible text and structured details agree");
      return parsed;
    },
  };
}

test("get_current_time reads the clock on every invocation, not when its tools were built", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T23:59:59.123Z") });
  const clock = tool();
  t.mock.timers.tick(500);
  assert.deepEqual(await clock.read(), {
    timestamp: "2026-01-01T23:59:59.623Z", localDate: "2026-01-01", localTime: "23:59:59.623", timezone: "UTC", utcOffset: "+00:00",
  });
  t.mock.timers.tick(500);
  assert.deepEqual(await clock.read(), {
    timestamp: "2026-01-02T00:00:00.123Z", localDate: "2026-01-02", localTime: "00:00:00.123", timezone: "UTC", utcOffset: "+00:00",
  });
  assert.equal(clock.definition.name, "get_current_time");
  assert.deepEqual(clock.definition.parameters, { type: "object", properties: {} });
});

for (const [timezone, timestamp, localDate, localTime, utcOffset] of [
  ["Australia/Sydney", "2026-01-01T13:00:00.000Z", "2026-01-02", "00:00:00.000", "+11:00"],
  ["America/Los_Angeles", "2026-01-02T00:30:00.000Z", "2026-01-01", "16:30:00.000", "-08:00"],
  ["Asia/Kathmandu", "2026-01-01T18:30:00.000Z", "2026-01-02", "00:15:00.000", "+05:45"],
]) {
  test(`local date and numeric offset at a UTC date boundary in ${timezone}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(timestamp!) });
    assert.deepEqual(await tool(timezone).read(), { timestamp, localDate, localTime, timezone, utcOffset });
  });
}

for (const [name, before, after, beforeLocal, afterLocal, beforeOffset, afterOffset] of [
  ["spring forward", "2026-03-08T06:59:59.999Z", "2026-03-08T07:00:00.000Z", "01:59:59.999", "03:00:00.000", "-05:00", "-04:00"],
  ["fall back", "2026-11-01T05:59:59.999Z", "2026-11-01T06:00:00.000Z", "01:59:59.999", "01:00:00.000", "-04:00", "-05:00"],
]) {
  test(`one long-lived tool follows the daylight-saving ${name}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(before!) });
    const clock = tool("America/New_York");
    const first = await clock.read();
    assert.equal(first.timestamp, before);
    assert.equal(first.localTime, beforeLocal);
    assert.equal(first.utcOffset, beforeOffset);
    t.mock.timers.tick(1);
    const second = await clock.read();
    assert.equal(second.timestamp, after);
    assert.equal(second.localTime, afterLocal);
    assert.equal(second.utcOffset, afterOffset);
    assert.equal(second.localDate, first.localDate);
  });
}

test("an invalid configured timezone is not silently reported as UTC", async () => {
  await assert.rejects(tool("Not/AZone").read(), RangeError);
});
