import test from "node:test";
import assert from "node:assert/strict";
import {
  reactionPrompt,
  reactionTargetsBot,
  reactionTurn,
  type SlackReactionEvent,
} from "./reactions.ts";

test("builds a turn for a message reaction", () => {
  const event: SlackReactionEvent = {
    type: "reaction_added",
    user: "U1",
    reaction: "thumbsup",
    item_user: "U2",
    item: { type: "message", channel: "C1", ts: "100.000" },
  };

  assert.deepEqual(reactionTurn(event), {
    kind: "added",
    channelId: "C1",
    userId: "U1",
    reaction: "thumbsup",
    itemTs: "100.000",
    threadTs: "100.000",
    itemUserId: "U2",
  });
});

test("uses the reacted message thread when Slack returns one", () => {
  const event: SlackReactionEvent = {
    type: "reaction_removed",
    user: "U1",
    reaction: "eyes",
    item_user: "UBOT",
    item: { type: "message", channel: "C1", ts: "101.000" },
  };

  const turn = reactionTurn(event, { user: "UBOT", text: "Done", thread_ts: "100.000" });

  assert.equal(turn?.kind, "removed");
  assert.equal(turn?.threadTs, "100.000");
  assert.equal(turn?.targetText, "Done");
});

test("ignores reaction events that are not message items", () => {
  assert.equal(
    reactionTurn({
      type: "reaction_added",
      user: "U1",
      reaction: "thumbsup",
      item: { type: "file", channel: "C1", ts: "100.000" },
    }),
    undefined,
  );
});

test("recognises reactions aimed at this bot", () => {
  const event: SlackReactionEvent = {
    type: "reaction_added",
    user: "U1",
    reaction: "wave",
    item_user: "UBOT",
    item: { type: "message", channel: "C1", ts: "100.000" },
  };

  assert.equal(reactionTargetsBot(event, undefined, "UBOT"), true);
  assert.equal(reactionTargetsBot({ ...event, item_user: "U2" }, { user: "UBOT" }, "UBOT"), true);
  assert.equal(reactionTargetsBot({ ...event, item_user: "U2" }, { user: "U2" }, "UBOT"), false);
});

test("renders reaction as an explicit event prompt", () => {
  const text = reactionPrompt({
    kind: "added",
    channelId: "C1",
    userId: "U1",
    reaction: "heart",
    itemTs: "100.000",
    threadTs: "100.000",
    itemUserId: "U2",
    targetText: "thanks for the help",
  });

  assert.match(text, /<@U1> added :heart:/);
  assert.match(text, /message from <@U2>/);
  assert.match(text, /thanks for the help/);
});
