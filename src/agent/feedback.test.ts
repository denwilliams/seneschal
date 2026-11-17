import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DigestState, FeedbackError, FeedbackLog, buildDigest, describeFeedback } from "./feedback.ts";
import { ensureSharedDirs, sharedPaths } from "../workspace/paths.ts";

/**
 * What matters here is what makes the file worth reviewing: the same wall hit
 * twice must be one item with a count rather than two near-identical entries,
 * the count of *channels* must be honest because it is what decides priority,
 * and closing something must not be able to hide it if it happens again.
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-feedback-"));
  ensureSharedDirs(root);
  return { root, shared: sharedPaths(root), log: new FeedbackLog(sharedPaths(root)) };
}

const ops = { channelId: "C1", channelLabel: "#ops" };
const home = { channelId: "C2", channelLabel: "#home" };

test("a report is filed with the channel that hit it", () => {
  const { log } = setup();

  const result = log.report({
    ...ops,
    kind: "tool",
    summary: "Cannot read PDFs that people paste into the channel.",
    detail: "Someone linked a datasheet and fetch_url refused it by content type.",
  });

  assert.equal(result.repeat, false);
  assert.equal(result.entry.reports, 1);
  assert.deepEqual(
    result.entry.channels.map((c) => c.label),
    ["#ops"],
  );
  assert.equal(result.otherChannels, 0);
  assert.equal(log.open().length, 1);
});

test("the same limitation reported again counts up instead of piling up", () => {
  const { log } = setup();

  log.report({ ...ops, kind: "tool", summary: "Cannot read PDFs that people paste." });
  const second = log.report({
    ...home,
    kind: "tool",
    summary: "cannot read pdfs that people paste",
  });

  assert.equal(second.repeat, true, "case and punctuation do not make a different limitation");
  assert.equal(second.entry.reports, 2);
  assert.equal(log.entries().length, 1, "a second entry would bury the signal, not add to it");
  assert.equal(second.otherChannels, 1, "the channel filing it is not one of the others");
  assert.deepEqual(
    second.entry.channels.map((c) => c.label),
    ["#ops", "#home"],
  );
});

test("one channel reporting twice is not two channels", () => {
  const { log } = setup();

  log.report({ ...ops, kind: "data", summary: "I cannot search Slack for an older thread." });
  const again = log.report({
    ...ops,
    kind: "data",
    summary: "I cannot search Slack for an older thread.",
  });

  assert.equal(again.entry.reports, 2);
  assert.equal(again.entry.channels.length, 1);
  assert.equal(again.otherChannels, 0);
});

test("a channel only ever sees what it reported itself", () => {
  const { log } = setup();

  log.report({ ...ops, kind: "permission", summary: "No shell in this channel, so no charts." });
  log.report({ ...home, kind: "knowledge", summary: "Nobody wrote down which valve is which." });

  assert.deepEqual(
    log.forChannel("C2").map((e) => e.summary),
    ["Nobody wrote down which valve is which."],
  );
});

test("resolving closes an item, and reporting it again reopens it", () => {
  const { log } = setup();

  const filed = log.report({ ...ops, kind: "tool", summary: "Cannot render an image without bash." });
  const closed = log.resolve(filed.entry.id, "U123", "Added a rasteriser");

  assert.equal(closed?.status, "resolved");
  assert.equal(closed?.resolution, "Added a rasteriser");
  assert.equal(log.open().length, 0);

  const again = log.report({ ...home, kind: "tool", summary: "Cannot render an image without bash." });

  assert.equal(again.reopened, true, "hitting it again is the proof it was not fixed");
  assert.equal(again.entry.status, "open");
  assert.equal(again.entry.reports, 2);
});

test("resolving something that was never reported changes nothing", () => {
  const { log } = setup();

  assert.equal(log.resolve("deadbeef1234", "U123"), undefined);
});

test("a summary too short to act on is refused", () => {
  const { log } = setup();

  assert.throws(() => log.report({ ...ops, kind: "harness", summary: "broken" }), FeedbackError);
  assert.equal(log.entries().length, 0);
});

test("the review file is regenerated with the worst item first", () => {
  const { log, shared } = setup();

  log.report({ ...ops, kind: "knowledge", summary: "The heating schedule is not written down anywhere." });
  log.report({ ...ops, kind: "tool", summary: "Cannot read PDFs that people paste." });
  log.report({ ...home, kind: "tool", summary: "Cannot read PDFs that people paste." });

  const rendered = readFileSync(shared.feedbackFile, "utf-8");
  assert.match(rendered, /2 open, 0 resolved/);
  assert.ok(
    rendered.indexOf("Cannot read PDFs") < rendered.indexOf("heating schedule"),
    "the thing two channels hit belongs above the thing one channel hit",
  );
  assert.match(rendered, /Reported 2× from #ops, #home/);
  assert.match(rendered, /edits here are overwritten/i);
});

test("resolved items are kept in the review file rather than vanishing", () => {
  const { log, shared } = setup();

  const filed = log.report({ ...ops, kind: "data", summary: "I cannot see messages posted after this turn." });
  log.resolve(filed.entry.id, "U9", "Out of scope for now");

  const rendered = readFileSync(shared.feedbackFile, "utf-8");
  assert.match(rendered, /## Resolved/);
  assert.match(rendered, /Out of scope for now/);
  assert.match(rendered, /0 open, 1 resolved/);
});

test("a truncated last line costs one record, not the log", () => {
  const { log, shared } = setup();

  log.report({ ...ops, kind: "tool", summary: "Cannot read PDFs that people paste." });
  writeFileSync(shared.feedbackLog, `${readFileSync(shared.feedbackLog, "utf-8")}{"type":"rep`);

  assert.equal(log.entries().length, 1);
});

test("nothing filed yet reads as nothing filed", () => {
  const { log } = setup();

  assert.deepEqual(log.entries(), []);
  assert.deepEqual(log.open(), []);
  assert.equal(log.find("whatever"), undefined);
});

/**
 * The digest is the half that makes any of this improve anything: reports in a
 * file change nothing until somebody is told. So what matters is that it says
 * what *moved*, and that it stays silent when nothing did — a weekly message
 * that is sometimes empty is one people stop opening.
 */

const HOUR = 3_600_000;

test("changes are measured against a moment, not against the whole file", () => {
  const { log } = setup();
  const earlier = new Date(Date.now() - 2 * HOUR);

  log.report({ ...ops, kind: "tool", summary: "Cannot read PDFs that people paste." }, earlier);
  const mark = new Date(Date.now() - HOUR).toISOString();
  log.report({ ...home, kind: "tool", summary: "Cannot read PDFs that people paste." });
  log.report({ ...home, kind: "data", summary: "I cannot search Slack for an older thread." });

  const changes = log.changesSince(mark);

  assert.deepEqual(
    changes.created.map((e) => e.kind),
    ["data"],
    "the PDF item was already known at the mark",
  );
  assert.equal(changes.climbing.length, 1);
  assert.equal(changes.climbing[0]!.added, 1);
  assert.equal(changes.open.length, 2, "open is the standing picture, not the delta");
});

test("an item closed and then hit again shows up as reopened, not as new", () => {
  const { log } = setup();
  const earlier = new Date(Date.now() - 2 * HOUR);

  const filed = log.report(
    { ...ops, kind: "tool", summary: "Cannot render an image without bash." },
    earlier,
  );
  log.resolve(filed.entry.id, "U1", undefined, earlier);
  const mark = new Date(Date.now() - HOUR).toISOString();
  log.report({ ...home, kind: "tool", summary: "Cannot render an image without bash." });

  const changes = log.changesSince(mark);

  assert.equal(changes.created.length, 0);
  assert.equal(changes.reopened.length, 1);
  assert.equal(changes.reopened[0]!.id, filed.entry.id);
});

test("something filed and closed between digests reads as closed, not as new", () => {
  const { log } = setup();
  const mark = new Date(Date.now() - HOUR).toISOString();

  const filed = log.report({ ...ops, kind: "knowledge", summary: "Nobody wrote down which valve is which." });
  log.resolve(filed.entry.id, "U1", "Added to shared knowledge");

  const changes = log.changesSince(mark);

  assert.equal(changes.created.length, 0, "it needs nothing doing, so it is not on the to-do list");
  assert.deepEqual(
    changes.resolved.map((e) => e.id),
    [filed.entry.id],
  );
  assert.match(buildDigest(log, { since: mark })!, /1 closed/);
});

test("nothing new means no digest at all", () => {
  const { log } = setup();

  assert.equal(buildDigest(log), undefined, "an empty log has nothing to say");

  const earlier = new Date(Date.now() - 2 * HOUR);
  log.report({ ...ops, kind: "tool", summary: "Cannot read PDFs that people paste." }, earlier);
  const mark = new Date(Date.now() - HOUR).toISOString();

  assert.equal(
    buildDigest(log, { since: mark }),
    undefined,
    "a quiet week is silence, not an empty message",
  );
});

test("the digest leads with what came back after being called fixed", () => {
  const { log } = setup();
  const earlier = new Date(Date.now() - 2 * HOUR);

  const filed = log.report(
    { ...ops, kind: "tool", summary: "Cannot render an image without bash." },
    earlier,
  );
  log.resolve(filed.entry.id, "U1", undefined, earlier);
  const mark = new Date(Date.now() - HOUR).toISOString();
  log.report({ ...home, kind: "tool", summary: "Cannot render an image without bash." });
  log.report({ ...ops, kind: "knowledge", summary: "Nobody wrote down which valve is which." });

  const digest = buildDigest(log, { since: mark })!;

  assert.match(digest, /1 new, 1 back open/);
  assert.ok(
    digest.indexOf("Back open") < digest.indexOf("*New*"),
    "a fix that did not hold is the one thing that cannot wait for next week",
  );
  assert.match(digest, /Open, most reported first\* \(2 in total\)/);
  assert.equal(
    digest.match(/e36ff3cb|Cannot render an image/g)?.filter((m) => m === "Cannot render an image")
      .length,
    2,
    "once as news, once in the standing list — never twice as news",
  );
  assert.match(digest, /!feedback resolve/);
});

test("the digest names the channels, because the count is what decides priority", () => {
  const { log } = setup();

  log.report({ ...ops, kind: "tool", summary: "Cannot read PDFs that people paste." });
  log.report({ ...home, kind: "tool", summary: "Cannot read PDFs that people paste." });

  const digest = buildDigest(log)!;

  assert.match(digest, /2× from #ops, #home/);
});

test("the digest remembers how far it got, and survives never having run", () => {
  const { log } = setup();
  const state = new DigestState(log);

  assert.equal(state.read().lastDigestAt, undefined);

  state.record("2026-08-09T09:00:00.000Z");

  assert.equal(new DigestState(log).read().lastDigestAt, "2026-08-09T09:00:00.000Z");
});

test("a listed item names its id, so it can be closed", () => {
  const { log } = setup();

  const filed = log.report({ ...ops, kind: "tool", summary: "Cannot read PDFs that people paste." });

  assert.match(describeFeedback(filed.entry), new RegExp(filed.entry.id));
});
