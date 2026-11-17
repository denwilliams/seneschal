import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostTools, type ChannelPoster } from "./post-tools.ts";

function fixture(threadTs?: string) {
  const posts: Array<{ channelId: string; text: string; threadTs?: string }> = [];
  const poster: ChannelPoster = {
    async post(input) {
      posts.push(input);
      return { ts: "123.456", permalink: "https://slack/x" };
    },
  };
  const [tool] = createPostTools({
    poster,
    channelId: "C1",
    channelLabel: "#general",
    currentThreadTs: () => threadTs,
  });
  return { posts, tool: tool as any };
}

test("posts to the channel at top level by default", async () => {
  const { posts, tool } = fixture("999.111");
  await tool.execute("t1", { text: "Deploy finished." });

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channelId, "C1");
  assert.equal(posts[0]!.text, "Deploy finished.");
  assert.equal(posts[0]!.threadTs, undefined, "top-level unless asked otherwise");
});

test("can post inside the current thread when asked", async () => {
  const { posts, tool } = fixture("999.111");
  await tool.execute("t1", { text: "still working", in_thread: true });
  assert.equal(posts[0]!.threadTs, "999.111");
});

test("the model cannot choose the channel", async () => {
  const { tool } = fixture();
  const params = Object.keys(tool.parameters.properties);
  assert.ok(!params.includes("channel"), "no channel parameter");
  assert.ok(!params.includes("channelId"), "no channelId parameter");
  assert.deepEqual(params.sort(), ["in_thread", "text"]);
});

test("refuses an empty post rather than sending whitespace", async () => {
  const { posts, tool } = fixture();
  await assert.rejects(() => tool.execute("t1", { text: "   " }), /empty/i);
  assert.equal(posts.length, 0);
});

test("tells the agent not to repeat the content in its reply", async () => {
  const { tool } = fixture();
  const result = await tool.execute("t1", { text: "hello" });
  assert.match(result.content[0].text, /do not need to repeat/i);
});

test("in_thread with no current thread falls back to channel level", async () => {
  const { posts, tool } = fixture(undefined);
  await tool.execute("t1", { text: "hello", in_thread: true });
  assert.equal(posts[0]!.threadTs, undefined);
});

// --- post_to_channel: posting to other, explicitly configured channels ------

import { createCrossChannelPostTools, type CrossChannelPoster } from "./post-tools.ts";

function crossFixture(opts: {
  targets?: Array<{ channel: string; reason?: string }>;
  threadTs?: string;
} = {}) {
  const calls: Array<Parameters<CrossChannelPoster["postToChannel"]>[0]> = [];
  const poster: CrossChannelPoster = {
    async postToChannel(input) {
      calls.push(input);
      return { channelLabel: "#announcements", ts: "9.9", permalink: "https://slack/y" };
    },
  };
  const tools = createCrossChannelPostTools({
    poster,
    sourceChannelId: "C1",
    allowedTargets: opts.targets ?? [{ channel: "announcements", reason: "company news" }],
  });
  return { calls, tools, tool: tools[0] as any };
}

test("post_to_channel is withheld when no targets are configured", () => {
  const { tools } = crossFixture({ targets: [] });
  assert.equal(tools.length, 0);
});

test("post_to_channel hands the configured allowlist to the poster and posts at top level", async () => {
  const { calls, tool } = crossFixture();
  await tool.execute("t1", { channel: "announcements", text: "  Invoice received.  " });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sourceChannelId, "C1");
  assert.equal(calls[0]!.target, "announcements");
  assert.equal(calls[0]!.text, "Invoice received.");
  assert.deepEqual(calls[0]!.allowedTargets, [{ channel: "announcements", reason: "company news" }]);
});

test("post_to_channel lists the allowed targets and their reasons for the model", () => {
  const { tool } = crossFixture({
    targets: [{ channel: "announcements", reason: "company news" }, { channel: "C0123ABC" }],
  });
  assert.match(tool.description, /`announcements` \(company news\)/);
  assert.match(tool.description, /`C0123ABC`/);
});

test("post_to_channel takes only a target channel and text, never a source channel", () => {
  const { tool } = crossFixture();
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["channel", "text"]);
});

test("post_to_channel refuses an empty message or empty target without posting", async () => {
  const { calls, tool } = crossFixture();
  await assert.rejects(() => tool.execute("t1", { channel: "announcements", text: "   " }), /empty/i);
  await assert.rejects(() => tool.execute("t2", { channel: "  ", text: "hi" }), /channel/i);
  assert.equal(calls.length, 0);
});

test("post_to_channel reports where it posted and gives back the permalink", async () => {
  const { tool } = crossFixture();
  const result = await tool.execute("t1", { channel: "announcements", text: "hello" });
  assert.match(result.content[0].text, /#announcements/);
  assert.match(result.content[0].text, /https:\/\/slack\/y/);
  assert.equal(result.details.permalink, "https://slack/y");
});
