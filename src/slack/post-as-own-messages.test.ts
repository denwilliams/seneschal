import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp } from "./app.ts";
import { carriesPostAsFooter, userPostPayload } from "./post-as.ts";

const OWNER = "U01OWNER1";
const BOT = "U0BOT";

/** What Slack delivers for a message this harness posted as the owner: the owner is the author. */
function ownPost(botUserId?: string, extra: Record<string, unknown> = {}) {
  const p = userPostPayload("Can you look at the Q3 numbers?", OWNER, botUserId);
  return { user: OWNER, channel: "C0GENERAL", ts: "100.1", text: p.text, blocks: p.blocks, ...extra };
}

test("a message the harness posted as a person is recognised by its footer, named or not", () => {
  assert.equal(carriesPostAsFooter(ownPost(BOT)), true);
  assert.equal(carriesPostAsFooter(ownPost(undefined)), true, "the Claude fallback footer counts too");
  assert.equal(carriesPostAsFooter({ text: ownPost(BOT).text }), true, "text alone is enough");
  assert.equal(carriesPostAsFooter({ blocks: ownPost(BOT).blocks }), true, "blocks alone are enough");
});

test("ordinary messages are not mistaken for our own posts", () => {
  assert.equal(carriesPostAsFooter({ text: "testing" }), false);
  assert.equal(carriesPostAsFooter({ text: "" }), false);
  assert.equal(carriesPostAsFooter({}), false);
  assert.equal(carriesPostAsFooter({ text: "Sent by Bob on behalf of <@U01OWNER1>" }), false, "only the app or Claude can be the sender");
  assert.equal(carriesPostAsFooter({ text: `Sent by <@${BOT}> on behalf of <@${OWNER}> and more words` }), false, "the footer is the whole last line");
  assert.equal(carriesPostAsFooter({ text: `Sent by <@${BOT}> on behalf of <@${OWNER}>\nbut this comes after` }), false, "the footer is last");
  assert.equal(carriesPostAsFooter({ text: "hello", blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }] }), false);
});

/** A HarnessApp whose Slack listeners are captured instead of registered, with `handle` recorded. */
function appWithCapturedListeners() {
  const message: ((args: { message: unknown; client: unknown }) => Promise<void>)[] = [];
  const mention: ((args: { event: unknown; client: unknown }) => Promise<void>)[] = [];
  const noop = () => undefined;
  const slackApp = new Proxy({}, {
    get: (_t, prop) => (...args: unknown[]) => {
      if (prop === "message") message.push(args[0] as never);
      else if (prop === "event" && args[0] === "app_mention") mention.push(args[1] as never);
      else noop();
    },
  });
  const handled: Record<string, unknown>[] = [];
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    app: slackApp,
    botUserId: BOT,
    opts: { dataDir: mkdtempSync(join(tmpdir(), "post-as-own-")) },
    handle: async (_client: unknown, input: Record<string, unknown>) => { handled.push(input); },
    respondsToRootMessages: async () => true,
  }) as unknown as { wire(): void };
  harness.wire();
  return { message: message[0]!, mention: mention[0]!, handled };
}

test("a DM-style message from the owner is handled, but one that is our own post is not", async () => {
  const { message, handled } = appWithCapturedListeners();
  await message({ client: {}, message: { user: OWNER, channel: "D0BOT", channel_type: "im", ts: "1.1", text: "testing" } });
  assert.equal(handled.length, 1, "a real message from the owner reaches the agent");

  await message({ client: {}, message: { ...ownPost(BOT), channel: "D0BOT", channel_type: "im" } });
  await message({ client: {}, message: { ...ownPost(undefined), channel: "C0GENERAL", ts: "2.2" } });
  assert.equal(handled.length, 1, "our own posts never reach an agent as if the owner had said them");
});

test("an @mention that is our own post is not handled either", async () => {
  const { mention, handled } = appWithCapturedListeners();
  const p = userPostPayload(`<@${BOT}> please approve my access request`, OWNER, BOT);
  await mention({ client: {}, event: { channel: "C0GENERAL", user: OWNER, ts: "3.3", text: p.text, blocks: p.blocks } });
  assert.equal(handled.length, 0, "a post-as message that mentions the bot is not an instruction from the owner");

  await mention({ client: {}, event: { channel: "C0GENERAL", user: OWNER, ts: "4.4", text: `<@${BOT}> hello` } });
  assert.equal(handled.length, 1, "a real mention still works");
});
