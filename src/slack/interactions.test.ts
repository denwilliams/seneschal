import { test } from "node:test";
import assert from "node:assert/strict";
import { cannedResponseActionId } from "../agent/interactive-tools.ts";
import {
  buildInteractiveResponseBlocks,
  decodeInteractiveResponsePayload,
  encodeInteractiveResponsePayload,
  interactiveResponsePrompt,
} from "./interactions.ts";

const payload = {
  version: 1 as const,
  channelId: "C1",
  threadTs: "123.456",
  question: "Deploy now?",
  response: "yes" as const,
};

test("builds fixed response buttons with a route bound to the source thread", () => {
  const blocks: any[] = buildInteractiveResponseBlocks({
    channelId: "C1",
    threadTs: "123.456",
    question: "Deploy now?",
    responses: ["yes", "no"],
  });
  const buttons = blocks[1].elements;

  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].action_id, cannedResponseActionId("yes"));
  assert.deepEqual(decodeInteractiveResponsePayload(buttons[0].value), payload);
  assert.equal(buttons[1].action_id, cannedResponseActionId("no"));
});

test("accepts a button value at Slack's 2,000-character boundary", () => {
  // `continue` has the longest permitted response value, so it exercises the
  // largest v1 payload for a given question.
  const emptyValue = encodeInteractiveResponsePayload({ ...payload, question: "", response: "continue" });
  const question = "x".repeat(2_000 - emptyValue.length);
  const blocks: any[] = buildInteractiveResponseBlocks({
    channelId: "C1",
    threadTs: "123.456",
    question,
    responses: ["continue"],
  });

  assert.equal(blocks[1].elements[0].value.length, 2_000);
  assert.equal(Buffer.byteLength(blocks[1].elements[0].value, "utf8"), 2_000);
});

test("refuses final button values over Slack's 2,000-character limit, including escaped input", () => {
  const emptyValue = encodeInteractiveResponsePayload({ ...payload, question: "", response: "continue" });
  const tooLongQuestion = "x".repeat(2_001 - emptyValue.length);
  assert.throws(
    () => buildInteractiveResponseBlocks({
      channelId: "C1",
      threadTs: "123.456",
      question: tooLongQuestion,
      responses: ["continue"],
    }),
    /2,000-character button value limit/,
  );

  // JSON escaping doubles every backslash, so this crosses the final payload
  // limit even though the source question itself is well below 2,000 chars.
  const escapedQuestion = "\\".repeat(1_000);
  assert.ok(escapedQuestion.length < 2_000);
  assert.ok(encodeInteractiveResponsePayload({ ...payload, question: escapedQuestion }).length > 2_000);
  assert.throws(
    () => buildInteractiveResponseBlocks({
      channelId: "C1",
      threadTs: "123.456",
      question: escapedQuestion,
      responses: ["yes"],
    }),
    /2,000-character button value limit/,
  );
});

test("rejects malformed, custom, and oversized response payloads", () => {
  assert.equal(decodeInteractiveResponsePayload("not json"), undefined);
  assert.equal(
    decodeInteractiveResponsePayload(JSON.stringify({ ...payload, response: "run-script" })),
    undefined,
  );
  assert.equal(
    decodeInteractiveResponsePayload(JSON.stringify({ ...payload, question: "x".repeat(2_501) })),
    undefined,
  );
});

test("frames a button click as a structured fixed user response", () => {
  const prompt = interactiveResponsePrompt({ userId: "U1", response: "yes", question: "Deploy now?" });
  assert.match(prompt, /Structured user response/);
  assert.match(prompt, /"type":"canned_response"/);
  assert.match(prompt, /"response":"yes"/);
  assert.match(prompt, /"userId":"U1"/);
});

test("payload encoding round-trips", () => {
  assert.deepEqual(decodeInteractiveResponsePayload(encodeInteractiveResponsePayload(payload)), payload);
});
