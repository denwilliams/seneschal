import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { channelPaths, sharedPaths } from "../workspace/paths.ts";
import { HELD_DISMISS_ACTION, HELD_UNBLOCK_ACTION } from "./held-posts.ts";
import { createUserClient, type PostAsService, type PostAsServiceDeps } from "./post-as.ts";
import type { ResolvedPostAs } from "../workspace/resolve.ts";
import { logger } from "../util/log.ts";

/** The real hold -> click -> send path on the app's own methods, with Slack replaced by recorders. */

const OWNER = "U01OWNER1";
const SOURCE = "C0SOURCE";

function configWith(postAs: boolean): HarnessConfig {
  return HarnessConfigSchema.parse({
    agentSets: { guards: { agents: { post_guard: { description: "Reviews posts.", tools: [] } } } },
    channels: { inbox: { agentSet: "guards", tools: ["read"], ...(postAs ? { share: { postAs: { user: OWNER, reviewer: "post_guard" } } } : {}) } },
  });
}

type Call = { client: "bot" | "user" | "click"; method: string; args: Record<string, any> };

function recorder(client: Call["client"], calls: Call[], impls: Record<string, (a: Record<string, any>) => unknown>) {
  const rec = (method: string) => async (args: Record<string, any>) => {
    calls.push({ client, method, args });
    return impls[method]?.(args) ?? { ok: true };
  };
  return {
    chat: { postMessage: rec("chat.postMessage"), update: rec("chat.update"), getPermalink: rec("chat.getPermalink"), postEphemeral: rec("chat.postEphemeral") },
    conversations: { open: rec("conversations.open"), list: rec("conversations.list"), info: rec("conversations.info") },
    users: { info: rec("users.info") },
  } as unknown as WebClient;
}

function setup(opts: { token?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "post-as-flow-"));
  mkdirSync(sharedPaths(dataDir).root, { recursive: true });
  if (opts.token !== false) {
    writeFileSync(join(sharedPaths(dataDir).root, "slack-user-tokens.json"), JSON.stringify({ users: { [OWNER]: "xoxp-flow-token" } }));
  }
  const registry = new ChannelRegistry(dataDir);
  registry.record({ id: SOURCE, name: "inbox", isDm: false });
  const calls: Call[] = [];
  const userTokens: string[] = [];
  const bot = recorder("bot", calls, { "chat.postMessage": () => ({ ok: true, ts: "100.1" }) });
  const user = recorder("user", calls, {
    "chat.postMessage": () => ({ ok: true, ts: "999.1" }),
    "chat.getPermalink": () => ({ ok: true, permalink: "https://x.slack.com/archives/C0GENERAL/p9991" }),
    "conversations.open": () => ({ ok: true, channel: { id: "D0PEER" } }),
    "conversations.list": () => ({ ok: true, channels: [{ id: "C0GENERAL", name: "general" }] }),
    "conversations.info": (a) => a.channel === "D0PEER"
      ? { ok: true, channel: { id: "D0PEER", is_im: true, user: "U0PEER" } }
      : { ok: true, channel: { id: a.channel, name: "general", is_private: false, num_members: 40 } },
    "users.info": (a) => ({ ok: true, user: { id: a.user, real_name: a.user === "U0PEER" ? "John Smith" : "Owner", team_id: "T1" } }),
  });
  const click = recorder("click", calls, {});
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    // botUserId is set by the app at start; the footer must name it, read when a post is sent.
    config: configWith(true), opts: { dataDir, modelRuntime: {} }, registry, app: { client: bot }, botUserId: "U0BOT",
  }) as unknown as {
    config: HarnessConfig;
    postAs: PostAsService;
    createPostAsService(overrides?: Partial<PostAsServiceDeps>): PostAsService;
    decideHeldPost(client: unknown, body: unknown): Promise<void>;
  };
  harness.postAs = harness.createPostAsService({
    userClient: (token) => { userTokens.push(token); return user; },
    review: async () => ({ verdict: "hold", reason: "needs a human look" }),
  });
  const postAs = (): ResolvedPostAs => ({
    user: OWNER, maxPerHour: 10, privateLinkHosts: [],
    reviewer: { name: "post_guard", model: "m", thinkingLevel: "off", instructions: "", timeoutSeconds: 30 },
  });
  const holdOne = async (target = "#general") => {
    const before = calls.length;
    const outcome = await harness.postAs.postAsUser({
      sourceChannelId: SOURCE, sourceThreadTs: "50.5", postAs: postAs(), target, text: "The deploy is done.",
      source: 'Alice in #inbox: "tell #general the deploy is done"', reason: "Alice asked.", sourceVerified: true,
    });
    assert.equal(outcome.status, "held");
    const alert = calls.slice(before).find((c) => c.client === "bot" && c.method === "chat.postMessage")!;
    const actions = alert.args.blocks.find((b: { type: string }) => b.type === "actions");
    return actions.elements[0].value as string;
  };
  const press = (id: string, clicker: string, action = HELD_UNBLOCK_ACTION) =>
    harness.decideHeldPost(click, { actions: [{ action_id: action, value: id }], user: { id: clicker }, channel: { id: SOURCE }, message: { ts: "100.1" } });
  const userSends = () => calls.filter((c) => c.client === "user" && c.method === "chat.postMessage");
  const ephemerals = () => calls.filter((c) => c.client === "click" && c.method === "chat.postEphemeral");
  const updates = () => calls.filter((c) => c.client === "click" && c.method === "chat.update");
  const timeline = () => {
    const file = join(channelPaths(dataDir, SOURCE).root, "timeline.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  return { harness, calls, userTokens, holdOne, press, userSends, ephemerals, updates, timeline, click };
}

const recorderFor = (s: ReturnType<typeof setup>) => s.click;

test("the owner's Unblock sends exactly once, with the stored user token, and updates the alert", async () => {
  const s = setup();
  const id = await s.holdOne();
  assert.equal(s.userSends().length, 0, "held, so nothing sent yet");

  await s.press(id, OWNER);
  assert.equal(s.userSends().length, 1);
  assert.equal(s.userSends()[0]!.args.channel, "C0GENERAL");
  assert.match(s.userSends()[0]!.args.text, /Sent by <@U0BOT> on behalf of <@U01OWNER1>$/);
  assert.ok(s.userTokens.every((token) => token === "xoxp-flow-token"), "the token comes from the channel's user-token store");
  assert.equal(s.updates().length, 1);
  assert.equal(s.updates()[0]!.args.channel, SOURCE);
  assert.equal(s.updates()[0]!.args.ts, "100.1");
  assert.match(JSON.stringify(s.updates()[0]!.args.blocks), /Unblocked by <@U01OWNER1> and sent/);
  assert.match(JSON.stringify(s.updates()[0]!.args.blocks), /The deploy is done\./, "the draft stays visible");

  await s.press(id, OWNER);
  assert.equal(s.userSends().length, 1, "a second click cannot send it again");
  assert.match(s.ephemerals().at(-1)!.args.text, /expired or was already decided/);
});

test("someone else's click is refused with an ephemeral, and nothing is sent or updated", async () => {
  const s = setup();
  const id = await s.holdOne();
  await s.press(id, "U01STRANGER");
  assert.equal(s.userSends().length, 0);
  assert.equal(s.updates().length, 0);
  assert.equal(s.ephemerals().length, 1);
  assert.equal(s.ephemerals()[0]!.args.user, "U01STRANGER");
  assert.match(s.ephemerals()[0]!.args.text, /Only <@U01OWNER1> can unblock/);

  await s.press(id, "U01STRANGER", HELD_DISMISS_ACTION);
  assert.match(s.ephemerals().at(-1)!.args.text, /Only <@U01OWNER1> can dismiss/);
  await s.press(id, OWNER);
  assert.equal(s.userSends().length, 1, "the refusals left it in place for the owner");
});

test("an unknown or expired id gets the same expired ephemeral as config approvals", async () => {
  const s = setup();
  await s.press("deadbeef0000", OWNER);
  assert.equal(s.ephemerals().length, 1);
  assert.equal(s.ephemerals()[0]!.args.user, OWNER);
  assert.equal(s.ephemerals()[0]!.args.channel, SOURCE);
  assert.match(s.ephemerals()[0]!.args.text, /That request has expired or was already decided/);
  assert.equal(s.userSends().length, 0);
});

test("a click on an unknown id with the alert's ts takes the buttons off the stale alert", async () => {
  const s = setup();
  await s.harness.decideHeldPost(recorderFor(s), {
    actions: [{ action_id: HELD_UNBLOCK_ACTION, value: "deadbeef0000" }], user: { id: OWNER }, channel: { id: SOURCE },
    message: { ts: "100.1", blocks: [{ type: "section" }, { type: "actions", elements: [{ action_id: HELD_UNBLOCK_ACTION }] }] },
  });
  assert.equal(s.updates().length, 1);
  assert.equal(s.updates()[0]!.args.channel, SOURCE);
  assert.equal(s.updates()[0]!.args.ts, "100.1");
  assert.ok(!s.updates()[0]!.args.blocks.some((b: { type: string }) => b.type === "actions"));
  assert.match(JSON.stringify(s.updates()[0]!.args.blocks), /expired or was already decided/);
  assert.equal(s.ephemerals().length, 1);
  assert.equal(s.userSends().length, 0);
});

test("a click on an alert that was already redrawn (no buttons left) is not redrawn again", async () => {
  const s = setup();
  await s.harness.decideHeldPost(recorderFor(s), {
    actions: [{ action_id: HELD_UNBLOCK_ACTION, value: "deadbeef0000" }], user: { id: OWNER }, channel: { id: SOURCE },
    message: { ts: "100.1", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Unblocked by <@U01OWNER1> and sent." } }] },
  });
  assert.equal(s.updates().length, 0);
});

test("a click with no message logs a warning, never throws, and still sends", async () => {
  const s = setup();
  const id = await s.holdOne();
  const warned: string[] = [];
  const original = logger.warn;
  logger.warn = (message: string) => { warned.push(message); };
  try {
    await s.harness.decideHeldPost(recorderFor(s), { actions: [{ action_id: HELD_UNBLOCK_ACTION, value: id }], user: { id: OWNER }, channel: { id: SOURCE } });
  } finally {
    logger.warn = original;
  }
  assert.equal(s.userSends().length, 1);
  assert.equal(s.updates().length, 0, "no update without a ts");
  assert.ok(warned.some((w) => /held-post alert/.test(w)), JSON.stringify(warned));
});

test("a click with no body.channel still reaches the clicker through the source channel", async () => {
  const s = setup();
  const id = await s.holdOne();
  await s.harness.decideHeldPost(recorderFor(s), { actions: [{ action_id: HELD_UNBLOCK_ACTION, value: id }], user: { id: "U01STRANGER" }, message: { ts: "100.1" } });
  assert.equal(s.ephemerals().length, 1);
  assert.equal(s.ephemerals()[0]!.args.channel, SOURCE);
  await s.harness.decideHeldPost(recorderFor(s), { actions: [{ action_id: HELD_UNBLOCK_ACTION, value: id }], user: { id: OWNER }, message: { ts: "100.1" } });
  assert.equal(s.userSends().length, 1);
  assert.equal(s.updates().at(-1)!.args.channel, SOURCE);
});

test("an unknown id with no body.channel uses the container's channel", async () => {
  const s = setup();
  await s.harness.decideHeldPost(recorderFor(s), { actions: [{ action_id: HELD_UNBLOCK_ACTION, value: "deadbeef0000" }], user: { id: OWNER }, container: { channel_id: SOURCE } });
  assert.equal(s.ephemerals().length, 1);
  assert.equal(s.ephemerals()[0]!.args.channel, SOURCE);
});

test("if postAs was removed from the config by click time, the click is refused and nothing is sent", async () => {
  const s = setup();
  const id = await s.holdOne();
  s.harness.config = configWith(false);
  await s.press(id, OWNER);
  assert.equal(s.userSends().length, 0);
  assert.equal(s.updates().length, 0);
  assert.match(s.ephemerals()[0]!.args.text, /post-as is no longer configured for <@U01OWNER1>/);
});

test("Dismiss updates the alert as dropped, and nothing is ever sent", async () => {
  const s = setup();
  const id = await s.holdOne();
  await s.press(id, OWNER, HELD_DISMISS_ACTION);
  assert.equal(s.userSends().length, 0);
  assert.equal(s.updates().length, 1);
  assert.match(JSON.stringify(s.updates()[0]!.args.blocks), /Dismissed by <@U01OWNER1>/);
  await s.press(id, OWNER);
  assert.equal(s.userSends().length, 0, "a dismissed post cannot be unblocked afterwards");
});

test("held and unblocked posts are recorded on the source channel's timeline; a DM's carries no draft text", async () => {
  const s = setup();
  const channelId = await s.holdOne();
  await s.press(channelId, OWNER);
  const dmId = await s.holdOne("U0PEER");
  await s.press(dmId, OWNER, HELD_DISMISS_ACTION);

  const posts = s.timeline().filter((e) => e.kind === "post");
  assert.deepEqual(posts.map((e) => e.status), ["blocked", "ok", "blocked", "done"]);
  assert.ok(posts.every((e) => e.actor === "channel" && e.userId === OWNER));
  assert.match(posts[0].title, /Held a post as <@U01OWNER1> to #general/);
  assert.match(posts[0].detail, /The deploy is done/);
  assert.match(posts[1].title, /Unblocked and posted/);
  assert.match(posts[2].title, /DM with John Smith/);
  assert.equal(posts[2].detail, undefined, "no draft text for a DM");
  assert.equal(posts[3].detail, undefined);
});

test("a sent post is recorded as ok", async () => {
  const s = setup();
  s.harness.postAs = s.harness.createPostAsService({
    userClient: () => recorder("user", s.calls, {
      "chat.postMessage": () => ({ ok: true, ts: "999.1" }),
      "conversations.list": () => ({ ok: true, channels: [{ id: "C0GENERAL", name: "general" }] }),
      "conversations.info": () => ({ ok: true, channel: { id: "C0GENERAL", name: "general" } }),
    }),
    review: async () => ({ verdict: "send", reason: "fine" }),
  });
  const outcome = await s.harness.postAs.postAsUser({
    sourceChannelId: SOURCE, postAs: { user: OWNER, maxPerHour: 10, privateLinkHosts: [], reviewer: { name: "g", model: "m", thinkingLevel: "off", instructions: "", timeoutSeconds: 30 } },
    target: "C0GENERAL", text: "Hello all.", source: "Alice", reason: "asked", sourceVerified: false,
  });
  assert.equal(outcome.status, "sent");
  const posts = s.timeline().filter((e) => e.kind === "post");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].status, "ok");
  assert.match(posts[0].title, /Posted as <@U01OWNER1> to #general/);
});

test("createUserClient never retries: a retried post after a lost response would post twice as the person", () => {
  const client = createUserClient("xoxp-abc") as unknown as { token?: string; retryConfig?: { retries?: number } };
  assert.equal(client.token, "xoxp-abc");
  assert.equal(client.retryConfig?.retries, 0);
});

test("app.ts never names the user-token store (the chokepoint test forbids it beside chat.postMessage)", () => {
  const app = readFileSync(join(import.meta.dirname, "app.ts"), "utf8");
  assert.doesNotMatch(app, /SlackUserTokenStore/);
});
