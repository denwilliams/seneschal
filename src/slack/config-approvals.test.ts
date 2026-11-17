import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigApprovalBlocks, PendingConfigChanges, summariseChanges, CONFIG_APPROVAL_TTL_MS } from "./config-approvals.ts";

const input = { edits: [{ path: ["channels", "x", "sandbox"], value: {} }], reason: "migrate", summary: ["a"], approvers: ["U01ADMIN1"], channelId: "C1", threadTs: "1.1", requestedBy: "U01ADMIN1" };

test("a pending change can be decided once, and not after it expires", () => {
  let now = 1_000;
  const pending = new PendingConfigChanges(() => now);
  const item = pending.add(input);
  assert.ok(pending.peek(item.id));
  assert.ok(pending.take(item.id));
  assert.equal(pending.take(item.id), undefined, "a second click finds nothing");
  const late = pending.add(input);
  now += CONFIG_APPROVAL_TTL_MS + 1;
  assert.equal(pending.peek(late.id), undefined);
  assert.equal(pending.take(late.id), undefined);
  assert.equal(pending.take("unknown"), undefined);
});

test("too many waiting requests are refused", () => {
  const pending = new PendingConfigChanges(() => 0);
  for (let i = 0; i < 20; i++) pending.add(input);
  assert.throws(() => pending.add(input), /Too many/);
});

test("the approver sees every change in full, escaped, and a change too big to show is refused", () => {
  const item = new PendingConfigChanges(() => 0).add({ ...input, reason: "<!channel> go", summary: summariseChanges([{ path: "channels.x.sandbox", before: undefined, after: { mode: "docker" } }]) });
  const text = JSON.stringify(buildConfigApprovalBlocks(item));
  assert.match(text, /\(not set\)/);
  assert.match(text, /\{\\"mode\\":\\"docker\\"\}/);
  assert.ok(!text.includes("<!channel>"), "model-written text cannot ping the channel");
  assert.throws(() => summariseChanges([{ path: "p", before: "x".repeat(16_000), after: 1 }]), /too large to show in full/);
});

test("only what differs is shown, and a long value is split across blocks rather than cut", () => {
  const big = { instructions: "y".repeat(5000), mode: "a", keep: { deep: "z".repeat(5000) } };
  const lines = summariseChanges([{ path: "channels.x.sandbox", before: big, after: { ...big, mode: "b" } }]);
  assert.equal(lines.length, 1, "the two big unchanged values are left out");
  assert.match(lines[0]!, /channels\.x\.sandbox\.mode/);
  const item = new PendingConfigChanges(() => 0).add({ ...input, summary: summariseChanges([{ path: "p", before: undefined, after: "q".repeat(7000) }]) });
  const blocks = buildConfigApprovalBlocks(item) as { text?: { text: string } }[];
  assert.ok(blocks.every((b) => !b.text || b.text.text.length <= 3000), "every block fits Slack's limit");
  assert.equal(blocks.map((b) => b.text?.text ?? "").filter((t) => t.startsWith("```")).join("").split("q").length - 1, 7000, "all of the value is shown");
});
