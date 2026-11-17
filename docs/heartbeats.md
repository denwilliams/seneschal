# Channel heartbeats

Heartbeats are opt-in monitoring loops, not time-of-day reminders. They reuse the
scheduler, per-channel `schedules.json`, run ledger and quiet agent runner. Ordinary
cron schedules and one-shot check-backs are unchanged.

## Assistant-facing behavior

With scheduling enabled for a channel, `read_heartbeat` reads its saved prompt,
interval, enabled state and next due time. `update_heartbeat` creates or edits it.
No channel identifier is accepted: the tools are bound to the current channel.
A runtime context section refreshes the current cadence on every model request.

For “keep an eye out for an email from John”:

1. Read the current heartbeat.
2. Add a standalone watch specifying what to check and when to notify. Preserve
   every unrelated watch. The same process changes/removes only the requested watch.
3. Save with `prompt` and `expected_prompt` (the exact old prompt). A concurrent
   edit fails rather than overwriting another conversation's watches: read again
   and merge the intended edit.
4. On initial configuration, explicitly choose `interval_minutes`, for example
   15 for an active channel or 60 for a less important channel. There is no default
   enabled heartbeat, and no need to pick a time of day.

Omitted fields remain unchanged. `enabled: false` pauses the loop and retains its
prompt; `enabled: true` resumes it. Interval changes and resume start a fresh interval.
Use the **exact prompt** `nothing to do` (case-insensitive, ignoring outer whitespace)
for a no-work loop: it records a successful scheduler execution without starting a
model session. Other short prompts do **not** avoid full context/tool token costs.

## Configuration and scheduling semantics

The existing channel `schedules` permission gates both tools and executions. The
operator's top-level `schedules.minIntervalMinutes` and `maxPerChannel` limits also
apply (one heartbeat counts as one schedule). There can be only one heartbeat per
channel. Intervals must be positive, finite and at most one year (525600 minutes).
Timers have one-second precision; the persisted due time reflects that precision.

Future due times persist across restart. Missed ticks during downtime are skipped,
with the next check one interval after restart; there is no replay/catch-up backlog.
The next tick is persisted before execution. A slow run skips ticks that occur
while it is running instead of queueing or overlapping. The scheduler is a
single-process owner, like ordinary scheduled tasks; multiple harness processes
must not share a schedule directory. A crashed in-flight run is not replayed.
Prompt edits do not reset cadence. Every execution reads the latest saved prompt.
Pausing/cancelling prevents future runs but does not abort one already in progress.

Heartbeats **always** use the quiet runner: no scheduled announcement, streaming
reply or routine completion is posted. Normal final replies are discarded.
Explicit `post_message`/`upload_file` notifications are available when warranted.
All tools, connector credentials, posting permissions, safety checks and isolation
are the channel's existing ones; monitoring grants no new access.

## Actual recurring usage

In the web console select a channel (or its main conversation), then **Session →
Usage (whole channel) → Usage by activity**. **Heartbeats** shows calls, all token
buckets (including cached context), and reported cost separately from conversations,
other scheduled tasks and dreams. Delegated subagent model calls initiated by a
heartbeat are included in its attribution. Missing prices are marked as a lower
bound. Thread-selected usage remains scoped to that thread.

The append-only shared usage log labels new heartbeat calls `heartbeat` and new
scheduled calls `scheduled`. Historical records are not reclassified. No-work ticks
make no model call and thus add no token record; run counts/history remain in the
schedule ledger. Usage is observed from model responses, not estimated from prompt
length. Auxiliary services retain their own accounting categories (for example a
post guard invoked by an explicit notification).

To roll back, pause configured heartbeats before reverting the code. Back up
`schedules.json` and usage logs with the normal channel data; older versions cannot
execute interval heartbeat definitions. Do not convert them to cron automatically.
