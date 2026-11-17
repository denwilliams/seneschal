/** Fresh per prompt, after any queue wait or session startup; never task metadata. */
function scheduledExecutionContext(timezone: string): string {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const offset = parts.timeZoneName!.replace("GMT", "") || "+00:00";
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  return [
    "## Current scheduled execution",
    `Execution timestamp (UTC): ${now.toISOString()}`,
    `Local date/time: ${local} [${timezone}]`,
    `Task timezone: ${timezone} (UTC${offset})`,
    "Resolve relative dates such as today/tomorrow from this execution time in this timezone,",
    "not from task creation time, old thread timestamps, or stale context.",
  ].join("\n");
}

/**
 * Framing for a scheduled run.
 *
 * Nobody asked a question: the task fired on a timer, and whatever the agent
 * writes is posted straight into the channel. Without saying so, the agent
 * treats "post a joke" as an action it must perform with some tool it does not
 * have, and reports on having done it instead of just doing it.
 */
export function scheduledPrompt(prompt: string, timezone: string, inThread = false): string {
  if (inThread) {
    return [
      "This is a scheduled follow-up firing now in an existing Slack thread.",
      "Resume the conversation in this thread; people expect the result here,",
      "not as a new channel post.",
      "",
      "Reply with what changed or what you found. If the thing is still pending",
      "and the user asked you to keep watching, you may schedule another one-shot",
      "follow-up with `in_thread: true`.",
      "",
      scheduledExecutionContext(timezone),
      "",
      "Task:",
      prompt,
    ].join("\n");
  }

  return [
    "This is a scheduled task firing now. No one asked you anything and no one",
    "is waiting on a reply.",
    "",
    "If the task is to publish something to the channel, call `post_message`",
    "with the finished content — that is what people will see — and then keep",
    "your reply to a short line, or nothing at all.",
    "",
    "Otherwise your reply is the result. Either way: produce what the task asks",
    "for, with no preamble and no summary of your own bookkeeping.",
    "",
    scheduledExecutionContext(timezone),
    "",
    "Task:",
    prompt,
  ].join("\n");
}

export function quietScheduledPrompt(prompt: string, timezone: string, heartbeatMinutes?: number): string {
  return [
    ...(heartbeatMinutes !== undefined ? [`This is this channel’s heartbeat, running every ${heartbeatMinutes} minutes. Maintain ongoing watches with read_heartbeat/update_heartbeat. Notify only for actionable findings; never post a routine completion.`] : []),
    "This is a quiet scheduled task firing now. No one asked you anything and",
    "your normal reply will not be shown in Slack.",
    "",
    "Only call `post_message` or `upload_file` if the task's condition says",
    "something should be visible now. If nothing should be visible, finish",
    "silently without publishing anything.",
    "",
    "Do not rely on your final assistant reply for anything people need to see;",
    "it will be discarded. Produce no preamble and no summary of your own",
    "bookkeeping.",
    "",
    scheduledExecutionContext(timezone),
    "",
    "Task:",
    prompt,
  ].join("\n");
}
