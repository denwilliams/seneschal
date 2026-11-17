import assert from "node:assert/strict";
import { test } from "node:test";
import { hashWorkflow, SOFTWARE_FACTORY_WORKFLOW } from "../factory/workflow/definition.ts";
import { aRun, finished } from "./factory-test-support.ts";
import { buttonsFor, replyEvents, statusBlocks } from "./factory-render.ts";

test("legacy pinned merge waits offer Request changes without changing the pin; deploy waits never do", () => {
  const definition = structuredClone(SOFTWARE_FACTORY_WORKFLOW);
  definition.version = 3;
  delete definition.stages.find((s) => s.name === "merge")!.on.changes_requested;
  const run = aRun({ current: "merge", status: "waiting", wait: { kind: "merge", since: 42 }, definition: JSON.stringify(definition), hash: hashWorkflow(definition) });
  assert.deepEqual(buttonsFor(run), ["approve", "request_changes", "decline"]);
  const card = statusBlocks(run, { now: 100, approvers: ["U123"] });
  assert.match(JSON.stringify(card.blocks), /Request changes/);
  run.wait.kind = "deploy";
  assert.deepEqual(buttonsFor(run), ["approve", "decline"]);
});

test("return-for-changes reply names the transition, keeps feedback plain, and does not expose it in DMs", () => {
  const feedback = "Human feedback <!channel> <https://hostile.example|click> *bold*";
  const run = finished(aRun({ current: "implement" }), "merge", "changes_requested", "Changes requested", { report: feedback });
  const events = replyEvents(run, { approvers: ["U123"] });
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events[0]!.blocks), /human reviewer requested changes/);
  assert.match(JSON.stringify(events[0]!.blocks), /fresh independent review/);
  const block = events[0]!.blocks[1] as { text: { type: string; text: string } };
  assert.equal(block.text.type, "plain_text");
  assert.equal(block.text.text, feedback);
  assert.doesNotMatch(JSON.stringify(replyEvents(run, { approvers: [], dm: true })), /hostile|Human feedback/);
});
