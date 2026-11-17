import { test } from "node:test";
import assert from "node:assert/strict";
import { consoleOAuthFixture } from "../agent/consoleConnectorOAuth-fixture.ts";
import { runCommand, type CommandContext } from "./commands.ts";

function context(f: ReturnType<typeof consoleOAuthFixture>, privateReplies: string[]): CommandContext {
  // Commands under test need only these channel fields; no agent/model or live Slack involved.
  return { channel: { ref: { id: f.target.channelId }, paths: { root: f.target.channelRoot }, connectors: [
    { name: f.target.connectorName, origin: "account", config: { transport: "http", url: f.target.connectorUrl, oauth: f.target.oauth } },
  ] }, threadKey: f.target.threadTs, userId: f.target.userId, connectorOAuth: f.manager,
  privateReply: async (text: string) => { privateReplies.push(text); } } as unknown as CommandContext;
}

test("connect command delivers capability privately only, binds Slack origin, and preserves manual/localhost routing", async (t) => {
  const f = consoleOAuthFixture(t);
  const privateReplies: string[] = [];
  const ctx = context(f, privateReplies);
  const reply = await runCommand("!connector-auth connect calendar", ctx);
  assert.match(reply, /private connect link was sent/);
  assert.doesNotMatch(reply, /https:|#[A-Za-z0-9_-]{43}|synthetic/);
  assert.equal(privateReplies.length, 1);
  const link = privateReplies[0]!.match(/<(https:[^|]+)\|/)?.[1]; assert.ok(link);
  assert.match(privateReplies[0]!, /shared with this channel/);
  await f.manager.claim(new URL(link).hash.slice(1));
  assert.equal(f.pairings[0]!.target.userId, ctx.userId);
  assert.equal(f.pairings[0]!.target.channelId, f.target.channelId);
  assert.equal(f.pairings[0]!.target.threadTs, ctx.threadKey);

  assert.match(await runCommand("!connector-auth start calendar", ctx), /opted in to the console callback/);
  assert.match(await runCommand("!connector-auth complete calendar invalid", ctx), /must not be pasted/);

  ctx.connectorOAuth = undefined;
  assert.match(await runCommand("!connector-auth connect calendar", ctx), /not configured/);
  const connector = ctx.channel.connectors[0]!;
  assert.equal(connector.config.transport, "http");
  if (connector.config.transport === "http") {
    connector.config.oauth!.redirectUrl = "http://localhost:37645/oauth/callback";
    connector.config.oauth!.consoleCallback = undefined;
  }
  ctx.connectorOAuth = f.manager;
  assert.match(await runCommand("!connector-auth connect calendar", ctx), /not opted in/);
  assert.match(await runCommand("!connector-auth complete calendar invalid", ctx), /invalid, already used/);
  assert.match(await runCommand("!connector-auth connect calendar extra", ctx), /Usage:/);
  assert.match(await runCommand("!connector-auth connect missing", ctx), /not enabled/);
  assert.equal(privateReplies.length, 1);
});

test("failed private delivery cancels only its own unclaimed flight and never echoes underlying errors", async (t) => {
  const f = consoleOAuthFixture(t);
  const ctx = context(f, []);
  ctx.privateReply = async () => { throw new Error("synthetic-code-token-secret"); };
  const reply = await runCommand("!connector-auth connect calendar", ctx);
  assert.match(reply, /Could not start/);
  assert.doesNotMatch(reply, /synthetic-code-token-secret/);
  assert.match(f.notices[0]!.message, /delivery failed/);
  assert.ok(f.manager.start(f.target), "failed delivery releases its scope immediately");
});
