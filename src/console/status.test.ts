import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expectedLinkLabel, mergeChannelRecords, statusSnapshot } from "./status.ts";
import { TaskStatusStore } from "../tasks/store.ts";

test("status snapshot includes idle channels and separates active/history", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-status-"));
  try {
    const tasks = new TaskStatusStore(dir);
    const done = tasks.start({ channelId: "C1", channelName: "eng", summary: "done", kind: "code", links: [{ url: "https://github.com/denwilliams/seneschal/pull/84" }] });
    tasks.update(done.id, "closed_successfully");
    tasks.start({ channelId: "C2", channelName: "ops", summary: "waiting", kind: "scheduled" });
    const result = statusSnapshot({ tasks, channels: () => [
      { id: "C1", name: "eng", isDm: false, firstSeen: "a", lastSeen: "b" },
      { id: "C2", name: "ops", isDm: false, firstSeen: "a", lastSeen: "b" },
      { id: "C3", name: "idle", isDm: false, firstSeen: "a", lastSeen: "b" },
    ], configuredChannels: () => [] }) as any;
    assert.equal(result.channels.find((channel: any) => channel.id === "C3").state, "idle");
    assert.equal(result.channels.find((channel: any) => channel.id === "C2").state, "active");
    assert.equal(result.active.length, 1);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].links[0].label, "PR denwilliams/seneschal#84");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("status snapshot keeps at most historyLimit completed tasks, globally and per channel", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-status-"));
  try {
    const tasks = new TaskStatusStore(dir);
    for (let i = 0; i < 5; i++) {
      const task = tasks.start({ channelId: "C1", channelName: "eng", summary: `done ${i}`, kind: "code" });
      tasks.update(task.id, "closed_successfully");
    }
    const result = statusSnapshot({ tasks, channels: () => [{ id: "C1", name: "eng", isDm: false, firstSeen: "a", lastSeen: "b" }], configuredChannels: () => [] }, 2) as any;
    assert.equal(result.history.length, 2);
    assert.equal(result.channels[0].history.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("status snapshot lists configured channels not yet seen", () => {
  const merged = mergeChannelRecords([{ id: "C1", name: "eng", isDm: false, firstSeen: "a", lastSeen: "b" }], ["#eng", "#ops", "C9"]);
  assert.deepEqual([...merged.keys()], ["C1", "#ops", "C9"]);
  assert.equal(merged.get("#ops")!.name, "ops");
  assert.equal(merged.get("C9")!.name, undefined);
});

test("status gives expected task links short labels", () => {
  assert.equal(expectedLinkLabel("https://github.com/denwilliams/seneschal/pull/79"), "PR denwilliams/seneschal#79");
  assert.equal(expectedLinkLabel("https://github.com/denwilliams/seneschal/issues/12"), "Issue denwilliams/seneschal#12");
  assert.equal(expectedLinkLabel("https://github.com/denwilliams/seneschal/commit/1234567890abcdef"), "Commit denwilliams/seneschal@1234567");
  assert.equal(expectedLinkLabel("https://example.slack.com/archives/C0EXAMPLE01/p1789277444852039"), "Slack thread");
  assert.equal(expectedLinkLabel("https://example.test/report"), undefined);
});
