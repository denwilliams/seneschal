import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedbackTools } from "./feedback-tools.ts";
import { FeedbackLog } from "./feedback.ts";
import { ensureSharedDirs, sharedPaths } from "../workspace/paths.ts";

function channel(root: string, id: string, name: string, isReviewer: boolean): any {
  return {
    ref: { id, name, isDm: false },
    shared: sharedPaths(root),
    feedback: { isReviewer },
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-feedback-tools-"));
  ensureSharedDirs(root);
  return { root, log: new FeedbackLog(sharedPaths(root)) };
}

test("only the feedback reviewer gets the resolve tool", () => {
  const { root } = setup();

  const ordinary = createFeedbackTools({
    channel: channel(root, "C2", "work", false),
    currentUserId: () => "U1",
  }).map((t) => t.name);
  const reviewer = createFeedbackTools({
    channel: channel(root, "C1", "admin", true),
    currentUserId: () => "U1",
  }).map((t) => t.name);

  assert.deepEqual(ordinary, ["report_limitation"]);
  assert.deepEqual(reviewer, ["report_limitation", "resolve_feedback"]);
});

test("resolve_feedback closes an item and notifies reporting channels", async () => {
  const { root, log } = setup();
  const filed = log.report({
    channelId: "C2",
    channelLabel: "#work",
    kind: "tool",
    summary: "Cannot inspect old Slack attachments on demand.",
  });

  const notified: { channelId: string; text: string }[] = [];
  const tools = createFeedbackTools({
    channel: channel(root, "C1", "admin", true),
    currentUserId: () => "Uadmin",
    resolution: {
      announceResolved: true,
      notify: async (channelId, text) => {
        notified.push({ channelId, text });
      },
    },
  });
  const resolve = tools.find((t) => t.name === "resolve_feedback") as any;

  const result = await resolve.execute("call1", { id: filed.entry.id, note: "Fixed in #123" });

  assert.match(result.content[0].text, /Closed/);
  assert.equal(result.details.resolved, true);
  assert.equal(log.find(filed.entry.id)?.status, "resolved");
  assert.equal(log.find(filed.entry.id)?.resolvedBy, "Uadmin");
  assert.equal(notified.length, 1);
  assert.equal(notified[0]!.channelId, "C2");
  assert.match(notified[0]!.text, /Fixed in #123/);
  assert.match(readFileSync(sharedPaths(root).feedbackFile, "utf-8"), /Fixed in #123/);
});

test("resolve_feedback reports an unknown id without changing the log", async () => {
  const { root, log } = setup();
  const resolve = createFeedbackTools({
    channel: channel(root, "C1", "admin", true),
    currentUserId: () => "Uadmin",
  }).find((t) => t.name === "resolve_feedback") as any;

  const result = await resolve.execute("call1", { id: "deadbeef1234" });

  assert.match(result.content[0].text, /No feedback/);
  assert.equal(result.details.resolved, false);
  assert.equal(log.entries().length, 0);
});
