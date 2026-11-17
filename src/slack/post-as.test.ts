import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { WebClient } from "@slack/web-api";
import { PostAsService, userPostPayload, type PostAsServiceDeps } from "./post-as.ts";
import { PendingHeldPosts } from "./held-posts.ts";
import { RateLimiter } from "../agent/post-as-guard.ts";
import type { SlackUserTokenStore } from "../agent/slack-user-tokens.ts";
import type { ResolvedPostAs } from "../workspace/resolve.ts";
import type { ReviewInput, Verdict } from "../agent/post-as-reviewer.ts";

const TOKEN = "xoxp-secret-user-token-123";
const FOOTER = "Sent by Claude on behalf of <@U01OWNER>";

const postAs = {
  user: "U01OWNER",
  maxPerHour: 10,
  privateLinkHosts: [],
  reviewer: { name: "post_guard", model: "m", thinkingLevel: "off", instructions: "", timeoutSeconds: 30 },
} as ResolvedPostAs;

type Call = { client: "bot" | "user"; method: string; args: Record<string, unknown> };
type Impl = (args: Record<string, unknown>) => unknown;

function slackError(code: string, needed?: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code, ...(needed ? { needed } : {}) } });
}

const userDefaults: Record<string, Impl> = {
  "chat.postMessage": () => ({ ok: true, ts: "999.1" }),
  "chat.getPermalink": (a) => ({ ok: true, permalink: `https://x.slack.com/archives/${String(a.channel)}/p9991` }),
  "conversations.open": () => ({ ok: true, channel: { id: "D0PEER" } }),
  "conversations.list": () => ({ ok: true, channels: [{ id: "C0GENERAL", name: "general" }] }),
  "conversations.info": (a) =>
    a.channel === "D0PEER"
      ? { ok: true, channel: { id: "D0PEER", is_im: true, user: "U0PEER" } }
      : { ok: true, channel: { id: a.channel, name: "general", is_private: false, num_members: 40 } },
  "users.info": (a) =>
    a.user === "U0PEER"
      ? { ok: true, user: { id: "U0PEER", real_name: "John Smith", team_id: "T2" } }
      : { ok: true, user: { id: a.user, real_name: "Owner", team_id: "T1" } },
};
const botDefaults: Record<string, Impl> = {
  "chat.postMessage": () => ({ ok: true, ts: "100.1" }),
  "chat.update": () => ({ ok: true }),
};

function fakeClient(client: "bot" | "user", calls: Call[], impls: Record<string, Impl>): WebClient {
  const rec = (method: string) => async (args: Record<string, unknown>) => {
    calls.push({ client, method, args });
    const impl = impls[method];
    if (!impl) throw new Error(`unexpected ${client} call ${method}`);
    return impl(args);
  };
  return {
    chat: { postMessage: rec("chat.postMessage"), update: rec("chat.update"), getPermalink: rec("chat.getPermalink") },
    conversations: { open: rec("conversations.open"), list: rec("conversations.list"), info: rec("conversations.info") },
    users: { info: rec("users.info") },
  } as unknown as WebClient;
}

function setup(opts: {
  user?: Record<string, Impl>;
  bot?: Record<string, Impl>;
  token?: string | undefined;
  verdict?: Verdict | (() => Promise<Verdict>);
  now?: () => number;
  /** The Slack app's own user id, read when a post is sent. Omit to leave it unknown. */
  botUserId?: () => string;
  activity?: Pick<PostAsServiceDeps, "onHeld" | "onHeldConsumed">;
} = {}) {
  const calls: Call[] = [];
  const factoryArgs: string[] = [];
  const reviews: ReviewInput[] = [];
  const events: Parameters<NonNullable<PostAsServiceDeps["onEvent"]>>[0][] = [];
  const now = opts.now ?? (() => 1_000);
  const held = new PendingHeldPosts(now);
  const limiter = new RateLimiter(now);
  const token = "token" in opts ? opts.token : TOKEN;
  const deps: PostAsServiceDeps = {
    botClient: fakeClient("bot", calls, { ...botDefaults, ...opts.bot }),
    userClient: (t) => {
      factoryArgs.push(t);
      return fakeClient("user", calls, { ...userDefaults, ...opts.user });
    },
    tokens: () => ({ tokenFor: (u: string) => (u === postAs.user ? token : undefined) }) as unknown as SlackUserTokenStore,
    review: async (input) => {
      reviews.push(input);
      const v = opts.verdict ?? { verdict: "send", reason: "fine" };
      return typeof v === "function" ? v() : v;
    },
    held,
    limiter,
    now,
    onEvent: (e) => events.push(e),
    ...opts.activity,
    ...(opts.botUserId ? { botUserId: opts.botUserId } : {}),
  };
  return { service: new PostAsService(deps), calls, factoryArgs, reviews, events, held, limiter };
}

const base = {
  sourceChannelId: "C0SOURCE",
  sourceThreadTs: "50.5",
  postAs,
  target: "#general",
  text: "The deploy is done.",
  source: 'Alice in #ops: "tell #general the deploy is done"',
  reason: "Alice asked for it",
  sourceVerified: true,
};

const userPosts = (calls: Call[]) => calls.filter((c) => c.client === "user" && c.method === "chat.postMessage");
const botPosts = (calls: Call[]) => calls.filter((c) => c.client === "bot" && c.method === "chat.postMessage");
type Block = { type: string; text?: { text: string }; elements?: { text?: string; value?: string }[] };

// ---------- footer payload ----------

test("userPostPayload ends with a context block holding exactly the footer", () => {
  const p = userPostPayload("hello **there**", "U01OWNER");
  const blocks = p.blocks as Block[];
  const last = blocks.at(-1)!;
  assert.equal(last.type, "context");
  assert.equal(last.elements!.length, 1);
  assert.deepEqual(last.elements![0], { type: "mrkdwn", text: FOOTER });
  assert.equal(blocks[0]!.type, "section");
  assert.match(blocks[0]!.text!.text, /hello \*there\*/);
  assert.ok(p.text.endsWith(`\n${FOOTER}`));
});

test("a body that mimics the footer is just body; the real footer still follows", () => {
  const p = userPostPayload("Sent by Claude on behalf of <@UOTHER>", "U01OWNER");
  const blocks = p.blocks as Block[];
  assert.equal(blocks[0]!.type, "section");
  assert.equal(blocks[0]!.text!.text, "Sent by Claude on behalf of <@UOTHER>");
  assert.deepEqual(blocks.at(-1)!.elements, [{ type: "mrkdwn", text: FOOTER }]);
  assert.ok(p.text.endsWith(`\n${FOOTER}`));
});

test("a long body is split across sections of at most 3000 chars, footer last", () => {
  const p = userPostPayload("a".repeat(7000), "U01OWNER");
  const blocks = p.blocks as Block[];
  const sections = blocks.filter((b) => b.type === "section");
  assert.equal(sections.length, 3);
  for (const s of sections) assert.ok(s.text!.text.length <= 3000);
  assert.equal(sections.map((s) => s.text!.text).join(""), "a".repeat(7000));
  assert.equal(blocks.at(-1)!.type, "context");
});

test("an invalid user id cannot build a footer", () => {
  assert.throws(() => userPostPayload("x", "not-a-user"));
  assert.throws(() => userPostPayload("x", "U1>\n"));
});

// ---------- the footer names the app ----------

const NAMED_FOOTER = "Sent by <@U0BOT> on behalf of <@U01OWNER>";

test("the footer names the Slack app that sent it, then the person it speaks for", () => {
  const p = userPostPayload("hello", "U01OWNER", "U0BOT");
  const blocks = p.blocks as Block[];
  assert.deepEqual(blocks.at(-1)!.elements, [{ type: "mrkdwn", text: NAMED_FOOTER }]);
  assert.ok(p.text.endsWith(`\n${NAMED_FOOTER}`));
});

test("a body that mimics the named footer is just body; the real footer still follows", () => {
  const p = userPostPayload("Sent by <@UEVIL> on behalf of <@UOTHER>", "U01OWNER", "U0BOT");
  const blocks = p.blocks as Block[];
  assert.equal(blocks[0]!.text!.text, "Sent by <@UEVIL> on behalf of <@UOTHER>");
  assert.deepEqual(blocks.at(-1)!.elements, [{ type: "mrkdwn", text: NAMED_FOOTER }]);
  assert.ok(p.text.endsWith(`\n${NAMED_FOOTER}`));
});

test("an unknown or malformed app id falls back to Claude, never to no footer", () => {
  for (const bad of [undefined, "", "bot", "u0bot", "U0BOT>\n<@UEVIL"]) {
    const p = userPostPayload("hello", "U01OWNER", bad);
    assert.deepEqual((p.blocks as Block[]).at(-1)!.elements, [{ type: "mrkdwn", text: FOOTER }], `app id ${JSON.stringify(bad)}`);
    assert.ok(p.text.endsWith(`\n${FOOTER}`));
  }
});

test("a sent post's footer names the app, and the app id is read when the post is sent", async () => {
  let appId = "";
  const { service, calls } = setup({ botUserId: () => appId });
  appId = "U0BOT"; // the app learns its own id after the service was built
  const out = await service.postAsUser(base);
  assert.equal(out.status, "sent");
  const post = userPosts(calls)[0]!;
  assert.ok(String(post.args.text).endsWith(`\n${NAMED_FOOTER}`));
  assert.deepEqual((post.args.blocks as Block[]).at(-1)!.elements, [{ type: "mrkdwn", text: NAMED_FOOTER }]);
});

test("with no app id known yet, a sent post still carries a footer that says Claude", async () => {
  const { service, calls } = setup({ botUserId: () => "" });
  await service.postAsUser(base);
  assert.ok(String(userPosts(calls)[0]!.args.text).endsWith(`\n${FOOTER}`));
});

// ---------- happy path ----------

test("send: receipt first via bot, then one user post with the footer, then the receipt gets the permalink", async () => {
  const { service, calls, events } = setup();
  const out = await service.postAsUser(base);
  assert.equal(out.status, "sent");
  assert.equal(out.status === "sent" && out.label, "#general");
  assert.equal(out.status === "sent" && out.permalink, "https://x.slack.com/archives/C0GENERAL/p9991");

  const ups = userPosts(calls);
  assert.equal(ups.length, 1);
  assert.equal(ups[0]!.args.channel, "C0GENERAL");
  assert.ok(String(ups[0]!.args.text).endsWith(FOOTER));
  assert.deepEqual((ups[0]!.args.blocks as Block[]).at(-1)!.elements, [{ type: "mrkdwn", text: FOOTER }]);

  const receiptIdx = calls.findIndex((c) => c.client === "bot" && c.method === "chat.postMessage");
  const sendIdx = calls.indexOf(ups[0]!);
  assert.ok(receiptIdx >= 0 && receiptIdx < sendIdx, "receipt precedes the send");
  const receipt = calls[receiptIdx]!;
  assert.equal(receipt.args.channel, "C0SOURCE");
  assert.equal(receipt.args.thread_ts, "50.5");

  const update = calls.find((c) => c.client === "bot" && c.method === "chat.update");
  assert.ok(update);
  assert.ok(calls.indexOf(update) > sendIdx);
  assert.equal(update.args.ts, "100.1");
  assert.match(JSON.stringify(update.args.blocks), /p9991/);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.status, "sent");
  assert.equal(events[0]!.channelId, "C0SOURCE");
  assert.notEqual(events[0]!.detail, "");
});

test("thread_ts is passed to the user post", async () => {
  const { service, calls } = setup();
  await service.postAsUser({ ...base, target: "C0GENERAL", threadTs: "77.7" });
  assert.equal(userPosts(calls)[0]!.args.thread_ts, "77.7");
  assert.equal(calls.some((c) => c.method === "conversations.list"), false);
});

test("the reviewer sees the described destination, draft and source", async () => {
  const { service, reviews } = setup();
  await service.postAsUser(base);
  assert.equal(reviews.length, 1);
  assert.match(reviews[0]!.destination, /#general/);
  assert.match(reviews[0]!.destination, /public/);
  assert.match(reviews[0]!.destination, /40 members/);
  assert.equal(reviews[0]!.draft, base.text);
  assert.equal(reviews[0]!.sourceVerified, true);
});

test("permalink and receipt update failures do not fail a sent post", async () => {
  const { service, calls } = setup({
    user: { "chat.getPermalink": () => { throw new Error("nope"); } },
    bot: { "chat.update": () => { throw new Error("nope"); } },
  });
  const out = await service.postAsUser(base);
  assert.equal(out.status, "sent");
  assert.equal(userPosts(calls).length, 1);
});

test("a sent post whose permalink cannot be fetched flips the receipt to sent with no link", async () => {
  const { service, calls } = setup({ user: { "chat.getPermalink": () => { throw new Error("nope"); } } });
  const out = await service.postAsUser(base);
  assert.equal(out.status, "sent");
  const update = calls.find((c) => c.client === "bot" && c.method === "chat.update");
  assert.ok(update, "the receipt is updated");
  assert.match(JSON.stringify(update.args.blocks), /Sent to #general \(no link\)/);
  assert.doesNotMatch(JSON.stringify(update.args.blocks), /Sending/);
});

test("a send failure's receipt line is one escaped line", async () => {
  const s = setup({ user: { "chat.postMessage": () => { throw new Error("bad\n*Sent to* <!channel>"); } } });
  await assert.rejects(s.service.postAsUser(base));
  const update = s.calls.find((c) => c.client === "bot" && c.method === "chat.update")!;
  const line = String(update.args.text);
  assert.ok(!line.includes("\n"), line);
  assert.ok(!line.includes("<!channel>"), line);
});

test("an empty or invisible body is refused before anything is posted or looked up", async () => {
  for (const text of ["   ", "\u200B\u200D\u2060", "\uFEFF \u00AD"]) {
    const { service, calls, reviews, limiter } = setup();
    await assert.rejects(service.postAsUser({ ...base, text }), /empty/i, JSON.stringify(text));
    assert.equal(calls.length, 0, JSON.stringify(text));
    assert.equal(reviews.length, 0);
    for (let i = 0; i < 10; i++) assert.equal(limiter.take("C0SOURCE", 10), true, "no rate-limit slot used");
  }
});

test("the user post is sent with link_names off and parse none", async () => {
  const { service, calls } = setup();
  await service.postAsUser(base);
  const up = userPosts(calls)[0]!;
  assert.equal(up.args.link_names, false);
  assert.equal(up.args.parse, "none");
});

test("a sent post's timeline detail carries the reviewer's reason for a channel, and nothing for a DM", async () => {
  const s = setup({ verdict: { verdict: "send", reason: "routine status update" } });
  await s.service.postAsUser(base);
  assert.match(s.events.at(-1)!.detail, /The deploy is done\./);
  assert.match(s.events.at(-1)!.detail, /reviewer: routine status update/);
  await s.service.postAsUser({ ...base, target: "U0PEER" });
  assert.equal(s.events.at(-1)!.detail, "");
});

// ---------- refusals ----------

test("no token: throws, and no Slack call is made by any client", async () => {
  const { service, calls, factoryArgs, reviews } = setup({ token: undefined });
  await assert.rejects(service.postAsUser(base), /no Slack user token stored for <@U01OWNER>/);
  assert.equal(calls.length, 0);
  assert.equal(factoryArgs.length, 0);
  assert.equal(reviews.length, 0);
});

test("a target with a newline or control character is refused before anything else", async () => {
  for (const target of ["#general\n#other", "C0GEN\u0007", "gen\u007feral"]) {
    const { service, calls, limiter } = setup();
    await assert.rejects(service.postAsUser({ ...base, target }), Error);
    assert.equal(calls.length, 0);
    // the refusal did not consume a rate-limit slot
    for (let i = 0; i < 10; i++) assert.equal(limiter.take("C0SOURCE", 10), true);
  }
});

test("an unresolvable channel name is a refusal naming the target, not a hold", async () => {
  const { service, calls, held } = setup({ user: { "conversations.list": () => ({ ok: true, channels: [] }) } });
  await assert.rejects(service.postAsUser({ ...base, target: "#nowhere" }), /#nowhere/);
  assert.equal(userPosts(calls).length, 0);
  assert.equal(botPosts(calls).length, 0);
  void held;
});

test("conversations.list paginates up to 10 pages", async () => {
  let pages = 0;
  const { service } = setup({
    user: {
      "conversations.list": () => {
        pages++;
        return { ok: true, channels: [], response_metadata: { next_cursor: "more" } };
      },
    },
  });
  await assert.rejects(service.postAsUser({ ...base, target: "lost" }));
  assert.equal(pages, 10);
});

// ---------- holds ----------

async function assertHeld(s: ReturnType<typeof setup>, input = base, reasonRe?: RegExp) {
  const out = await s.service.postAsUser(input);
  assert.equal(out.status, "held");
  if (reasonRe) assert.match(out.status === "held" ? out.reason : "", reasonRe);
  assert.equal(userPosts(s.calls).length, 0, "nothing sent");
  const alerts = botPosts(s.calls);
  assert.equal(alerts.length, 1, "one alert");
  assert.equal(alerts[0]!.args.channel, "C0SOURCE");
  assert.match(JSON.stringify(alerts[0]!.args.blocks), /harness_post_unblock/);
  assert.equal(s.events.at(-1)!.status, "held");
  return out;
}

test("rate cap: the 11th call is held and the reviewer is not called for it", async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) assert.equal((await s.service.postAsUser(base)).status, "sent");
  assert.equal(s.reviews.length, 10);
  const before = s.calls.length;
  const out = await s.service.postAsUser(base);
  assert.equal(out.status, "held");
  assert.equal(s.reviews.length, 10);
  const after = s.calls.slice(before);
  assert.equal(after.filter((c) => c.client === "user").length, 0);
  assert.equal(after.filter((c) => c.client === "bot" && c.method === "chat.postMessage").length, 1);
});

for (const [name, text] of [
  ["a private link", "see <https://DOCS.google.com/d/1|notes>"],
  ["a secret", "key AKIAABCDEFGHIJKLMNOP"],
  ["a broadcast", "<!channel> deploy done"],
] as const) {
  test(`${name} is held without calling the reviewer`, async () => {
    const s = setup();
    await assertHeld(s, { ...base, text });
    assert.equal(s.reviews.length, 0);
  });
}

test("a hold verdict is held", async () => {
  const s = setup({ verdict: { verdict: "hold", reason: "shares a report" } });
  await assertHeld(s, base, /shares a report/);
});

test("a reviewer that throws is a hold", async () => {
  const s = setup({ verdict: () => Promise.reject(new Error("boom")) });
  await assertHeld(s, base, /reviewer/);
});

test("a destination that cannot be described is a hold, not a throw", async () => {
  const s = setup({ user: { "conversations.info": () => { throw slackError("channel_not_found"); } } });
  await assertHeld(s, { ...base, target: "C0GENERAL" }, /could not describe the destination/);
  assert.equal(s.reviews.length, 0);
});

test("a held item is stored and its alert carries only the id", async () => {
  const s = setup({ verdict: { verdict: "hold", reason: "unsure" } });
  await s.service.postAsUser(base);
  const blocks = botPosts(s.calls)[0]!.args.blocks as Block[];
  const actions = blocks.find((b) => b.type === "actions")!;
  const id = actions.elements![0]!.value!;
  const item = s.held.peek(id);
  assert.ok(item);
  assert.equal(item.targetChannelId, "C0GENERAL");
  assert.equal(item.postAsUser, "U01OWNER");
  assert.equal(item.text, base.text);
});

test("receipt post failure: throws and nothing is sent", async () => {
  const s = setup({ bot: { "chat.postMessage": () => { throw new Error("bot down"); } } });
  await assert.rejects(s.service.postAsUser(base));
  assert.equal(userPosts(s.calls).length, 0);
});

test("alert post failure: throws, nothing is sent and nothing stays pending", async () => {
  let id: string | undefined;
  const s = setup({
    verdict: { verdict: "hold", reason: "unsure" },
    bot: {
      "chat.postMessage": (a) => {
        const blocks = a.blocks as Block[];
        id = blocks.find((b) => b.type === "actions")?.elements?.[0]?.value;
        throw new Error("bot down");
      },
    },
  });
  await assert.rejects(s.service.postAsUser(base));
  assert.equal(userPosts(s.calls).length, 0);
  assert.ok(id);
  assert.equal(s.held.peek(id), undefined);
});

// ---------- DM targets ----------

test("a user-id target opens a DM with the user client and posts there", async () => {
  const s = setup();
  const out = await s.service.postAsUser({ ...base, target: "U0PEER" });
  assert.equal(out.status, "sent");
  const open = s.calls.find((c) => c.method === "conversations.open")!;
  assert.equal(open.client, "user");
  assert.equal(open.args.users, "U0PEER");
  assert.equal(userPosts(s.calls)[0]!.args.channel, "D0PEER");
  assert.match(s.reviews[0]!.destination, /DM with John Smith/);
  assert.match(s.reviews[0]!.destination, /external/);
  assert.equal(s.events[0]!.detail, "", "a DM records no words");
  assert.match(out.status === "sent" ? out.label : "", /John Smith/);
});

test("a guest DM peer is described as a guest", async () => {
  const s = setup({
    user: {
      "users.info": (a) => ({ ok: true, user: { id: a.user, real_name: "Gail", team_id: "T1", is_restricted: a.user === "U0PEER" } }),
    },
  });
  await s.service.postAsUser({ ...base, target: "U0PEER" });
  assert.match(s.reviews[0]!.destination, /guest/);
  assert.doesNotMatch(s.reviews[0]!.destination, /external/);
});

test("a held DM also records no words", async () => {
  const s = setup({ verdict: { verdict: "hold", reason: "unsure" } });
  await s.service.postAsUser({ ...base, target: "U0PEER" });
  assert.equal(s.events[0]!.status, "held");
  assert.equal(s.events[0]!.detail, "");
});

// ---------- error mapping ----------

test("missing_scope on the user post names chat:write", async () => {
  const s = setup({ user: { "chat.postMessage": () => { throw slackError("missing_scope"); } } });
  await assert.rejects(s.service.postAsUser(base), /chat:write/);
});

test("missing_scope on conversations.open names im:write", async () => {
  const s = setup({ user: { "conversations.open": () => { throw slackError("missing_scope", "im:write"); } } });
  await assert.rejects(s.service.postAsUser({ ...base, target: "U0PEER" }), /im:write/);
  assert.equal(userPosts(s.calls).length, 0);
});

test("missing_scope while describing is a hold naming the read scope", async () => {
  const s = setup({ user: { "conversations.info": () => { throw slackError("missing_scope", "channels:read"); } } });
  await assertHeld(s, { ...base, target: "C0GENERAL" }, /channels:read/);
});

test("an invalid token is reported without the token", async () => {
  const s = setup({ user: { "chat.postMessage": () => { throw slackError("token_revoked"); } } });
  await assert.rejects(s.service.postAsUser(base), (err: Error) => {
    assert.match(err.message, /Slack user token for <@U01OWNER> is not valid; re-authenticate it/);
    assert.doesNotMatch(err.message, /xoxp/);
    return true;
  });
});

test("the token never appears in any recorded call or event", async () => {
  const s = setup();
  await s.service.postAsUser(base);
  await s.service.postAsUser({ ...base, target: "U0PEER" });
  const s2 = setup({ verdict: { verdict: "hold", reason: "x" } });
  await s2.service.postAsUser(base);
  for (const x of [s, s2]) {
    assert.doesNotMatch(JSON.stringify(x.calls), new RegExp(TOKEN));
    assert.doesNotMatch(JSON.stringify(x.events), new RegExp(TOKEN));
    assert.ok(x.factoryArgs.every((a) => a === TOKEN));
  }
});

// ---------- unblock / dismiss ----------

async function heldOne(opts: Parameters<typeof setup>[0] = {}, input = base) {
  const s = setup({ verdict: { verdict: "hold", reason: "unsure" }, ...opts });
  await s.service.postAsUser(input);
  const blocks = botPosts(s.calls)[0]!.args.blocks as Block[];
  const id = blocks.find((b) => b.type === "actions")!.elements![0]!.value!;
  return { ...s, id };
}

test("unblock by the owner sends the original text with the footer, once; a second click finds nothing", async () => {
  const s = await heldOne();
  const before = s.calls.length;
  const r = await s.service.unblock(s.id, "U01OWNER");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.permalink, "https://x.slack.com/archives/C0GENERAL/p9991");
  const after = s.calls.slice(before);
  const ups = after.filter((c) => c.client === "user" && c.method === "chat.postMessage");
  assert.equal(ups.length, 1);
  assert.equal(ups[0]!.args.channel, "C0GENERAL");
  assert.equal(String(ups[0]!.args.text), `${base.text}\n${FOOTER}`);
  const receipt = after.find((c) => c.client === "bot" && c.method === "chat.postMessage")!;
  assert.ok(after.indexOf(receipt) < after.indexOf(ups[0]!), "receipt first");
  assert.match(JSON.stringify(receipt.args.blocks), /Unblocked by <@U01OWNER>/);
  assert.equal(s.events.at(-1)!.status, "unblocked");

  const again = await s.service.unblock(s.id, "U01OWNER");
  assert.equal(again.ok, false);
  assert.equal(userPosts(s.calls).length, 1);
});

test("two concurrent unblock clicks send once", async () => {
  const s = await heldOne();
  const [a, b] = await Promise.all([s.service.unblock(s.id, "U01OWNER"), s.service.unblock(s.id, "U01OWNER")]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(userPosts(s.calls).length, 1);
});

test("unblock by someone else is refused and the item stays", async () => {
  const s = await heldOne();
  const r = await s.service.unblock(s.id, "U0INTRUDER");
  assert.equal(r.ok, false);
  assert.ok(s.held.peek(s.id));
  assert.equal(userPosts(s.calls).length, 0);
  assert.equal((await s.service.unblock(s.id, "U01OWNER")).ok, true);
});

test("unblock of an expired or unknown id is refused", async () => {
  let now = 1_000;
  const s = await heldOne({ now: () => now });
  now += 31 * 60_000;
  assert.equal((await s.service.unblock(s.id, "U01OWNER")).ok, false);
  assert.equal((await s.service.unblock("nope", "U01OWNER")).ok, false);
  assert.equal(userPosts(s.calls).length, 0);
});

test("unblock of a cap hold is refused while the cap is still full, and the item stays", async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) await s.service.postAsUser(base);
  await s.service.postAsUser(base);
  const blocks = botPosts(s.calls).at(-1)!.args.blocks as Block[];
  const id = blocks.find((b) => b.type === "actions")!.elements![0]!.value!;
  const sent = userPosts(s.calls).length;
  const r = await s.service.unblock(id, "U01OWNER");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.message, /limit/i);
  assert.ok(s.held.peek(id));
  assert.equal(userPosts(s.calls).length, sent);
});

test("unblock of a cap hold sends once capacity is back, resolving the target then", async () => {
  let now = 1_000;
  const s = setup({ now: () => now });
  for (let i = 0; i < 10; i++) await s.service.postAsUser(base);
  now += 40 * 60_000;
  await s.service.postAsUser(base);
  const blocks = botPosts(s.calls).at(-1)!.args.blocks as Block[];
  const id = blocks.find((b) => b.type === "actions")!.elements![0]!.value!;
  assert.equal((await s.service.unblock(id, "U01OWNER")).ok, false);
  now += 21 * 60_000; // the first ten are now over an hour old; the hold is 21 minutes old
  const before = s.calls.length;
  const r = await s.service.unblock(id, "U01OWNER");
  assert.equal(r.ok, true);
  const after = s.calls.slice(before);
  assert.ok(after.some((c) => c.client === "user" && c.method === "conversations.list"));
  const ups = after.filter((c) => c.client === "user" && c.method === "chat.postMessage");
  assert.equal(ups.length, 1);
  assert.equal(ups[0]!.args.channel, "C0GENERAL");
  assert.ok(String(ups[0]!.args.text).endsWith(FOOTER));
});

async function capHold(target: string, text = base.text) {
  let now = 1_000;
  const s = setup({ now: () => now });
  for (let i = 0; i < 10; i++) await s.service.postAsUser(base);
  now += 40 * 60_000;
  const out = await s.service.postAsUser({ ...base, target, text });
  const blocks = botPosts(s.calls).at(-1)!.args.blocks as Block[];
  const id = blocks.find((b) => b.type === "actions")!.elements![0]!.value!;
  // the first ten fall out of the hour while the hold (21 minutes old) is still live
  return { ...s, out, id, blocks, later: () => { now += 21 * 60_000; } };
}

test("a cap hold still runs the link and secret checks, and the alert shows both reasons", async () => {
  const s = await capHold("#general", "see https://docs.google.com/d/1");
  assert.equal(s.out.status, "held");
  const reason = s.out.status === "held" ? s.out.reason : "";
  assert.match(reason, /limit of 10 posts an hour/);
  assert.match(reason, /private link \(docs\.google\.com\)/);
  assert.match(JSON.stringify(s.blocks), /private link/);
  assert.equal(s.reviews.length, 10, "the reviewer is still not called for a cap hold");
});

test("a cap hold on a channel id is stored as that id and unblocked there, with no name lookup", async () => {
  const s = await capHold("C0OTHER");
  assert.equal(s.held.peek(s.id)!.targetChannelId, "C0OTHER");
  s.later();
  const before = s.calls.length;
  assert.equal((await s.service.unblock(s.id, "U01OWNER")).ok, true);
  const after = s.calls.slice(before);
  assert.equal(after.some((c) => c.method === "conversations.list"), false);
  assert.equal(after.filter((c) => c.client === "user" && c.method === "chat.postMessage")[0]!.args.channel, "C0OTHER");
});

test("a cap hold on a user id opens the DM at unblock, with no name lookup", async () => {
  const s = await capHold("U0PEER");
  assert.equal(s.held.peek(s.id)!.targetChannelId, "U0PEER");
  s.later();
  const before = s.calls.length;
  assert.equal((await s.service.unblock(s.id, "U01OWNER")).ok, true);
  const after = s.calls.slice(before);
  assert.equal(after.some((c) => c.method === "conversations.list"), false);
  assert.ok(after.some((c) => c.method === "conversations.open"));
  assert.equal(after.filter((c) => c.client === "user" && c.method === "chat.postMessage")[0]!.args.channel, "D0PEER");
});

test("holds whose destination was never described record no draft words (group DMs and names included)", async () => {
  for (const target of ["G0MPIM", "#general", "C0OTHER", "U0PEER"]) {
    const s = await capHold(target);
    assert.equal(s.events.at(-1)!.status, "held");
    assert.equal(s.events.at(-1)!.detail, "", target);
  }
  const d = setup({ user: { "conversations.info": () => { throw slackError("channel_not_found"); } } });
  await d.service.postAsUser({ ...base, target: "G0MPIM" });
  assert.equal(d.events.at(-1)!.status, "held");
  assert.equal(d.events.at(-1)!.detail, "");
});

test("unblock of a non-cap hold does not take another rate-limit slot", async () => {
  const s = await heldOne();
  // 1 slot used by the held attempt; fill the remaining 9
  for (let i = 0; i < 9; i++) assert.equal(s.limiter.take("C0SOURCE", 10), true);
  assert.equal((await s.service.unblock(s.id, "U01OWNER")).ok, true);
});

test("unblock: a receipt that fails to post means nothing is sent", async () => {
  const state = { fail: false };
  const s = await heldOne({
    bot: {
      "chat.postMessage": () => {
        if (state.fail) throw new Error("bot down");
        return { ok: true, ts: "100.1" };
      },
    },
  });
  state.fail = true;
  const r = await s.service.unblock(s.id, "U01OWNER");
  assert.equal(r.ok, false);
  assert.equal(userPosts(s.calls).length, 0);
});

test("unblock: a send failure after take is reported, with the scope named", async () => {
  const s = await heldOne({ user: { "chat.postMessage": () => { throw slackError("missing_scope"); } } });
  const r = await s.service.unblock(s.id, "U01OWNER");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.message, /chat:write/);
});

test("dismiss: only the owner, and it removes the item", async () => {
  const s = await heldOne();
  assert.equal(s.service.dismiss(s.id, "U0INTRUDER").ok, false);
  assert.ok(s.held.peek(s.id));
  assert.equal(s.service.dismiss(s.id, "U01OWNER").ok, true);
  assert.equal(s.held.peek(s.id), undefined);
  assert.equal(s.events.at(-1)!.status, "dismissed");
  assert.equal((await s.service.unblock(s.id, "U01OWNER")).ok, false);
  assert.equal(s.service.dismiss(s.id, "U01OWNER").ok, false);
  assert.equal(userPosts(s.calls).length, 0);
});

// ---------- chokepoint ----------

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("chokepoint: the user client posts in exactly one place, and nothing else holding user tokens posts", () => {
  const srcRoot = join(import.meta.dirname, "..");
  const mine = join(import.meta.dirname, "post-as.ts");
  const body = readFileSync(mine, "utf-8");
  assert.equal(body.match(/userWeb\.chat\.postMessage\(/g)?.length, 1);
  assert.match(body, /async function sendAsUser\(/);
  assert.doesNotMatch(body, /export[^\n]*sendAsUser/);

  // The one user-token post sits inside sendAsUser: between its start and the next top-level closing brace.
  const start = body.indexOf("async function sendAsUser(");
  const end = body.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  const userPost = body.indexOf("userWeb.chat.postMessage(");
  assert.ok(userPost > start && userPost < end, "the user post is inside sendAsUser");

  // Every other .chat.postMessage( in this file is on the bot client.
  const all = [...body.matchAll(/([\w.]+)\.chat\.postMessage\(/g)];
  assert.ok(all.length >= 3, "the receipt and the alert post too");
  for (const m of all) {
    if (m.index === userPost) continue;
    assert.ok(m[1] === "bot" || m[1] === "this.deps.botClient", `unexpected poster: ${m[1]}`);
  }
  // No other spelling of a post (destructured, bracketed or aliased chat client) exists.
  assert.equal(body.match(/postMessage/g)?.length, all.length);

  const offenders = tsFiles(srcRoot)
    .filter((f) => f !== mine)
    .filter((f) => {
      const t = readFileSync(f, "utf-8");
      return t.includes("SlackUserTokenStore") && t.includes("chat.postMessage");
    })
    .map((f) => relative(srcRoot, f));
  assert.deepEqual(offenders, []);
});

test("held-post activity identifies only the source alert and settles only after an authorized consumption", async () => {
  const alerts: Parameters<NonNullable<PostAsServiceDeps["onHeld"]>>[0][] = [];
  const consumed: string[] = [];
  const f = setup({ verdict: { verdict: "hold", reason: "review needed" }, activity: { onHeld: (e) => alerts.push(e), onHeldConsumed: (channelId, id) => consumed.push(`${channelId}:${id}`) } });
  await f.service.postAsUser(base);
  assert.equal(alerts.length, 1);
  const alert = alerts[0]!;
  assert.deepEqual(Object.keys(alert).sort(), ["channelId", "expiresAt", "id", "ts"]);
  assert.equal(alert.ts, "100.1");
  assert.equal(alert.channelId, "C0SOURCE");
  assert.ok(alert.expiresAt > 1000);
  assert.equal(f.service.dismiss(alert.id, "UOTHER").ok, false);
  assert.equal(consumed.length, 0);
  assert.equal(f.service.dismiss(alert.id, postAs.user).ok, true);
  assert.deepEqual(consumed, [`C0SOURCE:${alert.id}`]);
  assert.equal(f.service.dismiss(alert.id, postAs.user).ok, false);
  assert.equal(consumed.length, 1);
});
