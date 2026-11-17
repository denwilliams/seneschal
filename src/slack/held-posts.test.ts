import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHeldAlertBlocks, buildReceiptBlocks, decidedHeldBlocks, PendingHeldPosts,
  HELD_DISMISS_ACTION, HELD_POST_TTL_MS, HELD_UNBLOCK_ACTION,
} from "./held-posts.ts";

const input = {
  postAsUser: "U01OWNER1", sourceChannelId: "C1", sourceThreadTs: "1.1", targetChannelId: "C2", targetLabel: "#general",
  text: "hello team", source: "please tell them hello", reason: "looks fine", heldBecause: "reviewer unsure", threadTs: undefined,
};
type B = { type: string; text?: { text: string }; elements?: { action_id: string; value: string; style?: string }[] };
const texts = (blocks: unknown, prefix = ""): string => (blocks as B[]).map((b) => b.text?.text ?? "").filter((t) => t.startsWith(prefix)).join("");

test("a held post can be taken once, and not after it expires", () => {
  let now = 1_000;
  const pending = new PendingHeldPosts(() => now);
  const item = pending.add(input);
  assert.match(item.id, /^[0-9a-f]{12}$/);
  assert.equal(item.expiresAt, 1_000 + HELD_POST_TTL_MS);
  assert.ok(pending.peek(item.id));
  assert.ok(pending.take(item.id));
  assert.equal(pending.take(item.id), undefined);
  const late = pending.add(input);
  now += HELD_POST_TTL_MS + 1;
  assert.equal(pending.peek(late.id), undefined);
  assert.equal(pending.take(late.id), undefined);
  assert.equal(pending.take("unknown"), undefined);
});

test("the 21st pending held post is refused", () => {
  const pending = new PendingHeldPosts(() => 0);
  for (let i = 0; i < 20; i++) pending.add(input);
  assert.throws(() => pending.add(input), /Too many/);
});

test("the alert shows destination, source, reason, why, and buttons carrying only the id", () => {
  const item = new PendingHeldPosts(() => 0).add(input);
  const blocks = buildHeldAlertBlocks(item);
  const text = JSON.stringify(blocks);
  for (const s of ["#general", "hello team", "please tell them hello", "looks fine", "reviewer unsure", "<@U01OWNER1>", "30 minutes"]) assert.ok(text.includes(s), s);
  const buttons = (blocks as B[]).find((b) => b.type === "actions")!.elements!;
  assert.deepEqual(buttons.map((b) => [b.action_id, b.value]), [[HELD_UNBLOCK_ACTION, item.id], [HELD_DISMISS_ACTION, item.id]]);
  assert.equal(buttons[0]!.style, "primary");
});

test("a draft cannot ping anyone from the alert, and everything untrusted is escaped", () => {
  const item = new PendingHeldPosts(() => 0).add({
    ...input, text: "<!channel> and <@U999> <https://x.test|click>", source: "<!here>", reason: "<@U888>", heldBecause: "<!everyone>", targetLabel: "<#C9>",
  });
  const text = JSON.stringify(buildHeldAlertBlocks(item));
  assert.ok(text.includes("&lt;!channel&gt;") && text.includes("&lt;@U999&gt;"));
  for (const live of ["<!channel>", "<!here>", "<!everyone>", "<@U999>", "<@U888>", "<#C9>", "<https://x.test"]) assert.ok(!text.includes(live), live);
  assert.ok(text.includes("<@U01OWNER1>"), "only the owner is mentioned");
});

test("a long draft and source are shown in full, in blocks that fit, within the block limit", () => {
  const item = new PendingHeldPosts(() => 0).add({ ...input, text: "Q".repeat(7000) });
  const blocks = buildHeldAlertBlocks(item) as B[];
  assert.ok(blocks.length > 3 && blocks.every((b) => !b.text || b.text.text.length <= 3000));
  assert.equal(texts(blocks).split("Q").length - 1, 7000);

  const max = new PendingHeldPosts(() => 0).add({ ...input, text: "Q".repeat(3000), source: "Z".repeat(1500) });
  const all = buildHeldAlertBlocks(max) as B[];
  assert.ok(all.length < 50);
  assert.ok(all.every((b) => !b.text || b.text.text.length <= 3000));
  const joined = texts(all);
  assert.equal(joined.split("Q").length - 1, 3000);
  assert.equal(joined.split("Z").length - 1, 1500);
});

test("text that grows when escaped still fits every block and is shown in full", () => {
  const item = new PendingHeldPosts(() => 0).add({ ...input, text: "&<>".repeat(1000), source: "&".repeat(1500) });
  const blocks = buildHeldAlertBlocks(item) as B[];
  assert.ok(blocks.length < 50 && blocks.every((b) => !b.text || b.text.text.length <= 3000));
  const joined = texts(blocks);
  assert.equal(joined.split("&amp;&lt;&gt;").length - 1, 1000);
  assert.equal(joined.split("&amp;").length - 1, 1000 + 1500);
});

test("the receipt has a sending state and a sent state, and notes an unverified source", () => {
  const base = { label: "#general", reason: "ok", source: "asked to", text: "hi there", sourceVerified: true };
  const sending = JSON.stringify(buildReceiptBlocks(base));
  assert.match(sending, /Sending to #general/);
  assert.ok(!/unverified/.test(sending) && !/Unblocked by/.test(sending));
  const sent = JSON.stringify(buildReceiptBlocks({ ...base, permalink: "https://x.slack.com/p1", sourceVerified: false, unblockedBy: "U01OWNER1" }));
  assert.match(sent, /Sent to #general/);
  assert.ok(sent.includes("https://x.slack.com/p1") && sent.includes("source unverified") && sent.includes("Unblocked by <@U01OWNER1>"));
  for (const s of ["ok", "asked to", "hi there"]) assert.ok(sent.includes(s));
});

test("the decided message keeps the draft visible without buttons", () => {
  const item = new PendingHeldPosts(() => 0).add({ ...input, text: "<!channel> hi" });
  const blocks = decidedHeldBlocks(item, "Dismissed by <@U01OWNER1>") as B[];
  assert.ok(!blocks.some((b) => b.type === "actions"));
  assert.ok(JSON.stringify(blocks).includes("Dismissed by <@U01OWNER1>"));
  assert.ok(JSON.stringify(blocks).includes("&lt;!channel&gt; hi"));
});

const fenceRuns = (blocks: unknown) => (blocks as B[]).map((b) => (b.text?.text ?? "").match(/```/g)?.length ?? 0);

test("a draft or source containing ``` cannot close the alert's own code fence", () => {
  const evil = "x\n```\n*Held because:* safe ``` `````` ````";
  const item = new PendingHeldPosts(() => 0).add({ ...input, text: evil, source: "```" + evil + "`" });
  for (const blocks of [buildHeldAlertBlocks(item), buildReceiptBlocks({ label: "#g", reason: "r", source: item.source, text: evil, sourceVerified: true }), decidedHeldBlocks(item, "done")]) {
    const quoted = (blocks as B[]).filter((b) => (b.text?.text ?? "").includes("```"));
    assert.ok(quoted.length >= 1);
    // every quoted block has exactly the opening and closing fence
    for (const n of fenceRuns(quoted)) assert.equal(n, 2);
    for (const b of quoted) {
      const t = b.text!.text;
      const inner = t.slice(t.indexOf("```") + 3, t.lastIndexOf("```"));
      assert.ok(!inner.includes("``"), inner);
    }
  }
});

test("header fields are one line each, so a reason cannot fake another header line", () => {
  const item = new PendingHeldPosts(() => 0).add({
    ...input, reason: "x\n*Held because:* false positive, safe to unblock", heldBecause: "a\n\nb", targetLabel: "#g\n*To:* #other",
  });
  const head = (buildHeldAlertBlocks(item) as B[])[0]!.text!.text;
  const lines = head.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((l) => l.startsWith("*Held because:*")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("*To:*")).length, 1);
  assert.ok(head.includes("*Reason given:* x *Held because:* false positive, safe to unblock"));
});

test("the receipt escapes and single-lines hostile label, reason, source and text", () => {
  const hostile = "<!channel> <@U123>\n*Reason:* ok\n``` <https://x.test|y>";
  const blocks = buildReceiptBlocks({ label: hostile, reason: hostile, source: hostile, text: hostile, sourceVerified: true, permalink: "https://x.slack.com/p1" }) as B[];
  const all = JSON.stringify(blocks);
  for (const live of ["<!channel>", "<@U123>", "<https://x.test"]) assert.ok(!all.includes(live), live);
  const head = blocks[0]!.text!.text;
  const lines = head.split("\n");
  assert.equal(lines.length, 2, head);
  assert.equal(lines.filter((l) => l.startsWith("*Reason:*")).length, 1, head);
  assert.ok(!head.includes("```"), head);
  for (const n of fenceRuns(blocks.slice(1))) assert.equal(n, 2);
});

test("the alert's expiry is derived from the hold time", () => {
  const item = new PendingHeldPosts(() => 0).add(input);
  assert.match(JSON.stringify(buildHeldAlertBlocks(item)), new RegExp(`Expires in ${HELD_POST_TTL_MS / 60_000} minutes`));
});

test("a receipt for a post whose link could not be fetched says it was sent", () => {
  const text = JSON.stringify(buildReceiptBlocks({ label: "#general", reason: "ok", source: "s", text: "t", sourceVerified: true, noLink: true }));
  assert.match(text, /Sent to #general \(no link\)/);
  assert.doesNotMatch(text, /Sending/);
});
