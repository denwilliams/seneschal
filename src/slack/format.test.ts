import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, stripMention, toMrkdwn } from "./format.ts";

test("converts markdown emphasis to Slack mrkdwn", () => {
  assert.equal(toMrkdwn("**bold**"), "*bold*");
  assert.equal(toMrkdwn("__italic__"), "_italic_");
});

test("converts headings to bold lines", () => {
  assert.equal(toMrkdwn("## Results"), "*Results*");
});

test("converts markdown links", () => {
  assert.equal(toMrkdwn("see [docs](https://example.com)"), "see <https://example.com|docs>");
});

test("leaves code fences untouched", () => {
  const input = "before\n```js\nconst a = **not bold**;\n```\nafter";
  const out = toMrkdwn(input);
  assert.ok(out.includes("const a = **not bold**;"), "code content must not be rewritten");
});

test("chunks long text without exceeding the limit", () => {
  const para = "x".repeat(500);
  const text = Array.from({ length: 20 }, () => para).join("\n\n");
  const parts = chunk(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1100, `chunk too long: ${p.length}`);
});

test("reopens code fences across chunk boundaries", () => {
  const code = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const parts = chunk("```\n" + code + "\n```", 300);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    const fences = (p.match(/```/g) ?? []).length;
    assert.equal(fences % 2, 0, "each chunk must have balanced fences");
  }
});

test("strips the bot mention", () => {
  assert.equal(stripMention("<@U123> hello there", "U123"), "hello there");
});
