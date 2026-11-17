import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedPaths } from "../workspace/paths.ts";
import { NotificationInbox, renderNotifications } from "./notifications.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-notifications-"));
  const shared = sharedPaths(root);
  const inbox = new NotificationInbox(shared);
  const limits = { maxPending: 5, maxMessageChars: 200 };
  return { root, shared, inbox, limits };
}

test("notifications are submitted and collected once", () => {
  const { inbox, limits } = setup();

  const first = inbox.submit(
    {
      sourceChannelId: "C-OPS",
      sourceChannelLabel: "#ops",
      userId: "U1",
      title: "Backups",
      message: "Nightly backup completed successfully.",
    },
    limits,
  );
  const second = inbox.submit(
    {
      sourceChannelId: "C-HOME",
      sourceChannelLabel: "#home",
      userId: "U2",
      message: "Bins go out tonight.",
    },
    limits,
  );

  assert.deepEqual(
    inbox.pending().map((item) => item.id),
    [first.id, second.id],
  );

  const collected = inbox.collect({ channelId: "C-ADMIN" });
  assert.deepEqual(
    collected.map((item) => item.id),
    [first.id, second.id],
  );
  assert.deepEqual(inbox.pending(), []);
  assert.deepEqual(inbox.collect({ channelId: "C-ADMIN" }), []);
});

test("collection can take a bounded batch and leaves the rest pending", () => {
  const { inbox, limits } = setup();
  const ids = ["one", "two", "three"].map((message) =>
    inbox.submit(
      { sourceChannelId: "C", sourceChannelLabel: "#c", message },
      limits,
    ).id,
  );

  assert.deepEqual(
    inbox.collect({ channelId: "C-ADMIN", max: 2 }).map((item) => item.id),
    ids.slice(0, 2),
  );
  assert.deepEqual(
    inbox.pending().map((item) => item.id),
    ids.slice(2),
  );
});

test("submission rejects empty, oversized, and over-capacity messages", () => {
  const { inbox, limits } = setup();

  assert.throws(
    () => inbox.submit({ sourceChannelId: "C", sourceChannelLabel: "#c", message: "   " }, limits),
    /needs a message/,
  );
  assert.throws(
    () => inbox.submit({ sourceChannelId: "C", sourceChannelLabel: "#c", message: "x".repeat(201) }, limits),
    /limit is 200/,
  );

  for (let i = 0; i < limits.maxPending; i++) {
    inbox.submit({ sourceChannelId: "C", sourceChannelLabel: "#c", message: `item ${i}` }, limits);
  }
  assert.throws(
    () => inbox.submit({ sourceChannelId: "C", sourceChannelLabel: "#c", message: "too many" }, limits),
    /already has 5 pending/,
  );
});

test("a corrupt jsonl line does not lose the rest of the inbox", () => {
  const { inbox, shared, limits } = setup();
  const first = inbox.submit({ sourceChannelId: "C", sourceChannelLabel: "#c", message: "before" }, limits);
  appendFileSync(shared.notificationsLog, "{not json\n");
  const second = inbox.submit({ sourceChannelId: "C", sourceChannelLabel: "#c", message: "after" }, limits);

  assert.deepEqual(
    inbox.pending().map((item) => item.id),
    [first.id, second.id],
  );
});

test("rendered notifications include channel, user, title, and body", () => {
  const text = renderNotifications([
    {
      id: "abc123",
      at: "2026-08-25T09:00:00.000Z",
      sourceChannelId: "C-OPS",
      sourceChannelLabel: "#ops",
      userId: "U1",
      title: "Backups",
      message: "All good.",
    },
  ]);

  assert.match(text, /`abc123` #ops from <@U1>/);
  assert.match(text, /\*Backups\*/);
  assert.match(text, /All good/);
});
