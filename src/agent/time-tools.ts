import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Read-only clock access, independent of scheduling permissions or shell access. */
export function createTimeTools(timezone = "UTC"): ToolDefinition[] {
  const currentTime = defineTool({
    name: "get_current_time",
    label: "Get current time",
    description:
      "Read the current clock now, not the time this conversation or scheduled task was created. " +
      "Use when interpreting today/tomorrow, relative dates, or setting schedules. " +
      `Returns a UTC ISO-8601 timestamp, localDate (YYYY-MM-DD), localTime (HH:mm:ss.SSS), timezone (${timezone}), ` +
      "and utcOffset (signed HH:mm). The timezone is the harness schedules.timezone setting (UTC by default), not a task-specific timezone.",
    parameters: Type.Object({}),
    execute: async () => {
      // Take one reading so every field describes the same instant, even at midnight or a DST boundary.
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        calendar: "iso8601",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hourCycle: "h23",
        timeZoneName: "longOffset",
      }).formatToParts(now);
      const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)!.value;
      const offset = part("timeZoneName");
      const result = {
        timestamp: now.toISOString(),
        localDate: `${part("year")}-${part("month")}-${part("day")}`,
        localTime: `${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")}`,
        timezone,
        utcOffset: offset === "GMT" ? "+00:00" : offset.replace(/^GMT/, ""),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
  return [currentTime];
}
