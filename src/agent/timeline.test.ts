import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelTimelineLog, excerpt, timelineForChannel } from "./timeline.ts";

const root = () => mkdtempSync(join(tmpdir(), "timeline-"));

test("events are appended in order with a short id, and read back oldest first", () => {
  const dir = root();
  const log = new ChannelTimelineLog(dir);
  log.record({ kind: "turn.start", actor: "channel", title: "Request", at: "2026-10-18T10:00:02.000Z" });
  log.record({ kind: "tool", actor: "coder", runKey: "sub-a", title: "bash", status: "ok", at: "2026-10-18T10:00:01.000Z" });
  const events = log.read();
  assert.deepEqual(events.map((e) => e.kind), ["tool", "turn.start"], "sorted by time, not by when they were written");
  assert.match(events[0]!.id, /^[0-9a-f]{7}$/);
  assert.notEqual(events[0]!.id, events[1]!.id);
  assert.equal(log.read(1).length, 1, "the newest `limit`");
  assert.equal(log.read(1)[0]!.kind, "turn.start");
});

test("excerpts are one bounded line, and a direct message keeps the shape of what happened but none of the words", () => {
  const dir = root();
  new ChannelTimelineLog(dir).record({ kind: "turn.start", actor: "channel", title: "Request", detail: `line one\n\n  line   two ${"x".repeat(600)}` });
  const kept = new ChannelTimelineLog(dir).read()[0]!;
  assert.equal(kept.detail!.length, 280);
  assert.match(kept.detail!, /^line one line two x+…$/);

  const dm = root();
  const dmLog = new ChannelTimelineLog(dm, { redactText: true });
  dmLog.record({ kind: "run.start", actor: "coder", runKey: "sub-a", title: "coder started", detail: "my private task" });
  const redacted = dmLog.read()[0]!;
  assert.equal(redacted.detail, undefined);
  assert.equal(redacted.title, "coder started");
  assert.doesNotMatch(readFileSync(join(dm, "timeline.jsonl"), "utf8"), /private/);
  assert.equal(excerpt("   "), undefined);
});

test("a torn last line after a crash does not hide the rest", () => {
  const dir = root();
  const log = new ChannelTimelineLog(dir);
  log.record({ kind: "turn.start", actor: "channel", title: "ok" });
  appendFileSync(join(dir, "timeline.jsonl"), '{"id":"abc1234","at":"2026-10-18T1');
  assert.equal(log.read().length, 1);
});

test("a full log is rotated rather than growing forever, and the older half is still read", () => {
  const dir = root();
  const log = new ChannelTimelineLog(dir);
  writeFileSync(join(dir, "timeline.jsonl"), `${JSON.stringify({ id: "0000001", at: "2026-10-18T09:00:00.000Z", kind: "turn.start", actor: "channel", title: "old" })}\n${"\n".repeat(5 * 1024 * 1024)}`);
  log.record({ kind: "turn.start", actor: "channel", title: "new", at: "2026-10-18T10:00:00.000Z" });
  assert.ok(existsSync(join(dir, "timeline.1.jsonl")));
  assert.deepEqual(log.read().map((e) => e.title), ["old", "new"]);
});

test("recording can never fail a turn", () => {
  const dir = root();
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  assert.doesNotThrow(() => new ChannelTimelineLog(join(blocker, "inside")).record({ kind: "turn.start", actor: "channel", title: "x" }));
  assert.doesNotThrow(() => timelineForChannel({ ref: { isDm: false } }).record({ kind: "turn.start", actor: "channel", title: "x" }));
});
