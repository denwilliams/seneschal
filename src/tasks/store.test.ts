import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { linksIn, redactTaskUrls, substantiveToolKind, TaskRunTracker, TaskStatusStore } from "./store.ts";

test("slide deck generation is tracked as file work", () => {
  assert.equal(substantiveToolKind("create_slide_deck"), "file");
});

test("task status survives a store reload and retains per-channel history", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-tasks-"));
  try {
    const store = new TaskStatusStore(dir);
    const task = store.start({ channelId: "C1", channelName: "engineering", summary: "Review PR", kind: "review" });
    store.update(task.id, "blocked", "Waiting for CI");
    const reloaded = new TaskStatusStore(dir);
    const restored = reloaded.forChannel("C1")[0]!;
    assert.deepEqual(restored, { ...task, status: "blocked", detail: "Waiting for CI", updatedAt: restored.updatedAt });
    assert.equal(restored.finishedAt, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interactive work is lazy while scheduled work and failures are recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-tasks-"));
  try {
    const store = new TaskStatusStore(dir);
    const chat = new TaskRunTracker(store, { channelId: "C1", summary: "hello" });
    chat.finish("completed");
    assert.equal(store.all().length, 0);
    const work = new TaskRunTracker(store, { channelId: "C1", summary: "download report" });
    work.onToolStart("download_url"); work.finish("completed");
    assert.equal(store.all()[0]!.kind, "file");
    assert.equal(store.all()[0]!.status, "closed_successfully");
    const review = new TaskRunTracker(store, { channelId: "C1", summary: "review change", kind: "review" });
    review.setStatus("waiting", "Waiting for maintainer approval");
    assert.equal(store.forChannel("C1").find((task) => task.id === review.current()!.id)?.status, "waiting");
    const resumed = new TaskRunTracker(store, { channelId: "C1", threadKey: "thread-1", summary: "wait", kind: "review" });
    resumed.setStatus("waiting", "CI");
    assert.equal(store.hasWaiting("C1", "thread-1"), true);
    const resumedAgain = new TaskRunTracker(store, { channelId: "C1", threadKey: "thread-1", summary: "retry", kind: "review" });
    assert.equal(resumedAgain.start().id, resumed.current()!.id);
    assert.equal(store.hasWaiting("C1", "thread-1"), false);
    const scheduled = new TaskRunTracker(store, { channelId: "C2", summary: "nightly check", kind: "scheduled" });
    scheduled.start("scheduled"); scheduled.finish("failed", "connection refused");
    assert.equal(store.forChannel("C2")[0]!.status, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("task links are retained, de-duplicated, and safely limited to http URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-tasks-"));
  try {
    const store = new TaskStatusStore(dir);
    const task = store.start({ channelId: "C1", summary: "PR", kind: "code" });
    store.addLinks(task.id, [
      { url: "https://github.com/denwilliams/seneschal/pull/84", label: "PR #84" },
      { url: "HTTPS://github.com/denwilliams/seneschal/pull/85?token=secret", label: "See https://user:secret@example.test/report" },
      { url: "https://user:secret@example.test/report" },
      { url: "javascript:alert(1)" },
    ]);
    assert.deepEqual(store.get(task.id)?.links, [
      { url: "https://github.com/denwilliams/seneschal/pull/84", label: "PR #84" },
      { url: "https://github.com/denwilliams/seneschal/pull/85", label: "See [private URL omitted]" },
    ]);
    assert.deepEqual(linksIn("Review HTTPS://example.test/pr/1?token=secret and https://example.test/pr/1."), [{ url: "https://example.test/pr/1" }]);
    assert.equal(redactTaskUrls("Open https://user:secret@example.test/r?token=abc"), "Open [private URL omitted]");
    assert.equal(redactTaskUrls("Open https://example.test/r?token=abc"), "Open https://example.test/r");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("in-progress records become abandoned after an interrupted process", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-tasks-"));
  try {
    const store = new TaskStatusStore(dir);
    const task = store.start({ channelId: "C1", summary: "long job", kind: "agent" });
    assert.equal(store.abandonInProgress(), 1);
    assert.equal(store.get(task.id)?.status, "abandoned");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
