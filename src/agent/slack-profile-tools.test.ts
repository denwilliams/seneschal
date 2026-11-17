import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { deflateSync } from "node:zlib";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { narrowChannelForAgent } from "../workspace/subagents.ts";
import { checkEdits } from "../config/edit-policy.ts";
import { buildThreadToolSet } from "./session.ts";
import { createSlackProfileTools, type SlackProfileClient } from "./slack-profile-tools.ts";

const identity = { user: "U01OWNER", team: "T01TEAM" };
const TOKEN = "xoxp-private-test-credential";
function fixture(t: TestContext, enabled = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "slack-profile-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = HarnessConfigSchema.parse({ channels: { profile: { tools: [], ...(enabled ? { slackProfile: identity } : {}) } } });
  const registry = new ChannelRegistry(dataDir);
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "profile", isDm: false }, registry).channel!;
  channel.env = { SLACK_USER_TOKEN_U01OWNER: TOKEN };
  const calls: { kind: string; value?: unknown }[] = [];
  const client: SlackProfileClient = {
    authTest: async () => { calls.push({ kind: "auth" }); return { ok: true, user_id: identity.user, team_id: identity.team }; },
    setStatus: async (profile) => { calls.push({ kind: "status", value: profile }); return { ok: true }; },
    setPhoto: async (image) => { calls.push({ kind: "photo", value: image }); return { ok: true }; },
  };
  const factory = (token: string) => { assert.equal(token, TOKEN); return client; };
  const tools = createSlackProfileTools({ channel, clientFactory: factory });
  const run = (name: string, params: unknown = {}) => tools.find((tool) => tool.name === name)!.execute("id", params as never, undefined, undefined, {} as never);
  const png = PNG.sync.write(new PNG({ width: 512, height: 512 }));
  writeFileSync(join(channel.paths.workspace, "photo.png"), png);
  return { dataDir, channel, config, registry, calls, client, tools, run, png };
}

test("profile tools require an explicit channel binding, never inherited or inferred from search/post-as", async (t) => {
  const f = fixture(t);
  const other = resolveChannel(f.config, f.dataDir, { id: "C2", name: "other", isDm: false }, f.registry).channel!;
  assert.equal(other.slackProfile, undefined);
  assert.deepEqual(createSlackProfileTools({ channel: other }), []);
  assert.deepEqual(fixture(t, false).tools, []);
  assert.throws(() => HarnessConfigSchema.parse({ defaults: { slackProfile: identity } }), /individual channels/);
  for (const binding of [{ user: "x", team: "T01TEAM" }, { user: "U01OWNER" }, { ...identity, token: TOKEN }, { ...identity, fields: ["email"] }]) {
    assert.throws(() => HarnessConfigSchema.parse({ channels: { x: { slackProfile: binding } } }));
  }
  const base = { channel: f.channel, threadKey: "100.1", harnessName: "Test", slackChannelLabel: "#profile", botUserId: "UBOT", modelRuntime: {} as never, runtimes: {} as never };
  const control = { current: () => undefined, set: async () => {} };
  const parent = await buildThreadToolSet(base, control); t.after(() => parent.dispose());
  assert.deepEqual(parent.tools.filter((tool) => /^(set_slack_status|clear_slack_status|set_slack_profile_photo)$/.test(tool.name)).map((tool) => tool.name).sort(), ["clear_slack_status", "set_slack_profile_photo", "set_slack_status"]);
  const child = await buildThreadToolSet({ ...base, role: "subagent" }, control); t.after(() => child.dispose());
  assert.equal(child.tools.some((tool) => tool.name === "set_slack_status"), false);
  assert.equal(narrowChannelForAgent(f.channel, { name: "reader", tools: [], connectors: [] } as never).slackProfile, undefined);
});

test("admin edits cannot self-grant or retarget profile writes, even in a whole-channel value", () => {
  for (const privileged of [false, true]) {
    for (const path of [["channels", "profile", "slackProfile"], ["channels", "profile", "slackProfile", "user"], ["channels", "profile"]]) {
      const problems = checkEdits([{ path, value: path.length === 2 ? { slackProfile: identity } : identity }], { before: {}, after: { channels: { profile: { slackProfile: identity } } }, protectedChannels: new Set(), privileged });
      assert.match(problems.join(" "), /Slack status and profile picture/);
    }
  }
});

test("set/no-expiration/clear send only the three status fields, without speaker identity", async (t) => {
  const f = fixture(t);
  const expiration = Math.floor(Date.now() / 1000) + 3600;
  const response = await f.run("set_slack_status", { text: "In a meeting", emoji: ":calendar:", expiration });
  await f.run("set_slack_status", { text: "Available", emoji: "" });
  await f.run("clear_slack_status");
  assert.deepEqual(f.calls, [
    { kind: "auth" }, { kind: "status", value: { status_text: "In a meeting", status_emoji: ":calendar:", status_expiration: expiration } },
    { kind: "auth" }, { kind: "status", value: { status_text: "Available", status_emoji: "", status_expiration: 0 } },
    { kind: "auth" }, { kind: "status", value: { status_text: "", status_emoji: "", status_expiration: 0 } },
  ]);
  assert.doesNotMatch(JSON.stringify(response), /xoxp|private-test/);
});

test("reject malformed values and arbitrary users/fields/credentials before calling Slack", async (t) => {
  const f = fixture(t);
  for (const params of [
    { text: "x".repeat(101), emoji: "" }, { text: "x\n", emoji: "" }, { text: 12, emoji: "" },
    { text: "x", emoji: "🗓" }, { text: "x", emoji: ":bad emoji:" }, { text: "x", emoji: "", user: "UOTHER" },
    { text: "x", emoji: "", profile: { email: "x@y.test" } }, { text: "x", emoji: "", token: TOKEN },
    ...[-1, 1, NaN, Infinity, 1.5, "9999999999", null].map((expiration) => ({ text: "x", emoji: "", expiration })),
  ]) await assert.rejects(() => f.run("set_slack_status", params));
  await assert.rejects(() => f.run("clear_slack_status", { user: "UOTHER" }));
  await assert.rejects(() => f.run("set_slack_profile_photo", { path: "photo.png", user: "UOTHER" }));
  assert.deepEqual(f.calls, []);
});

test("each operation checks the authorized user/workspace and rejects bot tokens or rotated mismatches", async (t) => {
  const f = fixture(t);
  for (const auth of [
    { user_id: "UOTHER", team_id: identity.team }, { user_id: identity.user, team_id: "TOTHER" },
    { user_id: identity.user, team_id: identity.team, bot_id: "B123" }, {},
  ]) {
    f.client.authTest = async () => ({ ok: true, ...auth });
    for (const [name, params] of [["set_slack_status", { text: "x", emoji: "" }], ["clear_slack_status", {}], ["set_slack_profile_photo", { path: "photo.png" }]] as const) {
      await assert.rejects(() => f.run(name, params), /identity mismatch/);
    }
  }
  assert.deepEqual(f.calls, []);
});

test("missing/corrupt authorization and Slack/network failures never return raw secrets", async (t) => {
  const f = fixture(t);
  f.channel.env = {};
  await assert.rejects(() => f.run("clear_slack_status"), /No Slack user authorization/);
  writeFileSync(join(f.channel.shared.root, "slack-user-tokens.json"), TOKEN);
  await assert.rejects(() => f.run("clear_slack_status"), (error: Error) => !error.message.includes(TOKEN) && /Could not read/.test(error.message));
  f.channel.env = { SLACK_USER_TOKEN_U01OWNER: TOKEN };
  for (const [error, pattern] of [["missing_scope", /users.profile:write/], ["token_revoked", /revoked/], ["no_permission", /permissions/], ["invalid_image", /PNG\/JPEG/], ["bad_image", /PNG\/JPEG/], ["ratelimited", /rate-limited/], [TOKEN, /API or network error/]] as const) {
    f.client.setStatus = async () => { throw { data: { error, token: TOKEN }, message: TOKEN }; };
    await assert.rejects(() => f.run("clear_slack_status"), (err: Error) => pattern.test(err.message) && !err.message.includes(TOKEN));
    f.client.setPhoto = async () => ({ ok: false, error });
    await assert.rejects(() => f.run("set_slack_profile_photo", { path: "photo.png" }), (err: Error) => pattern.test(err.message) && !err.message.includes(TOKEN));
  }
  f.client.authTest = async () => ({ ok: false, error: "missing_scope" });
  await assert.rejects(() => f.run("clear_slack_status"), /users.profile:write/);
  f.client.authTest = async () => { throw new Error(TOKEN); };
  await assert.rejects(() => f.run("clear_slack_status"), (err: Error) => /API or network error/.test(err.message) && !err.message.includes(TOKEN));
  assert.deepEqual(f.calls.filter((call) => call.kind !== "auth"), []);
});

test("uploads validated PNG/JPEG bytes from the workspace or this channel's original attachments", async (t) => {
  const f = fixture(t);
  mkdirSync(f.channel.paths.attachments, { recursive: true });
  writeFileSync(join(f.channel.paths.attachments, "attached.png"), f.png);
  const jpg = jpeg.encode({ width: 512, height: 512, data: Buffer.alloc(512 * 512 * 4, 255) }).data;
  writeFileSync(join(f.channel.paths.workspace, "photo.jpg"), jpg);
  for (const path of ["photo.png", "photo.jpg", join(f.channel.paths.attachments, "attached.png")]) await f.run("set_slack_profile_photo", { path });
  assert.deepEqual(f.calls.filter((call) => call.kind === "photo").map((call) => call.value), [f.png, jpg, f.png]);
});

test("photo validation rejects URL, host/channel escapes, symlinks, non-files, oversized and corrupt/mislabeled images", async (t) => {
  const f = fixture(t);
  const foreign = join(f.dataDir, "foreign"); mkdirSync(foreign);
  writeFileSync(join(foreign, "photo.png"), f.png);
  symlinkSync(join(foreign, "photo.png"), join(f.channel.paths.workspace, "escape.png"));
  symlinkSync(foreign, join(f.channel.paths.workspace, "escape-dir"));
  writeFileSync(join(f.channel.paths.workspace, "fake.png"), "not an image");
  writeFileSync(join(f.channel.paths.workspace, "wrong.jpg"), f.png);
  writeFileSync(join(f.channel.paths.workspace, "truncated.png"), f.png.subarray(0, 40));
  const corrupt = Buffer.from(f.png); corrupt[40] = corrupt[40]! ^ 255;
  writeFileSync(join(f.channel.paths.workspace, "corrupt.png"), corrupt);
  writeFileSync(join(f.channel.paths.workspace, "tiny.png"), PNG.sync.write(new PNG({ width: 2, height: 2 })));
  const huge = Buffer.from(f.png); huge.writeUInt32BE(100_000, 16);
  writeFileSync(join(f.channel.paths.workspace, "huge.png"), huge);
  writeFileSync(join(f.channel.paths.workspace, "big.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
  const duplicateHeader = Buffer.concat([f.png.subarray(0, 33), f.png.subarray(8)]);
  writeFileSync(join(f.channel.paths.workspace, "duplicate.png"), duplicateHeader);
  // Adam7 decode in pngjs uses unbounded inflate; ensure preflight rejects a compressed bomb first.
  const interlaced = Buffer.from(f.png.subarray(0, 33)); interlaced[28] = 1;
  const compressed = deflateSync(Buffer.alloc(16 * 1024 * 1024));
  const chunk = Buffer.alloc(compressed.length + 12); chunk.writeUInt32BE(compressed.length); chunk.write("IDAT", 4); compressed.copy(chunk, 8);
  writeFileSync(join(f.channel.paths.workspace, "bomb.png"), Buffer.concat([interlaced, chunk, f.png.subarray(f.png.length - 12)]));
  const validJpeg = jpeg.encode({ width: 512, height: 512, data: Buffer.alloc(512 * 512 * 4) }).data;
  writeFileSync(join(f.channel.paths.workspace, "truncated.jpg"), validJpeg.subarray(0, validJpeg.length - 2));
  for (const path of ["https://example.test/photo.png", "file:///etc/passwd", "../../foreign/photo.png", join(foreign, "photo.png"), "escape.png", "escape-dir/photo.png", ".", "missing.png", "fake.png", "wrong.jpg", "truncated.png", "corrupt.png", "huge.png", "big.png", "duplicate.png", "bomb.png", "truncated.jpg", "tiny.png"]) {
    await assert.rejects(() => f.run("set_slack_profile_photo", { path }), /local PNG|Cannot read|valid PNG/);
  }
  assert.deepEqual(f.calls, []);
});

test("default Slack adapter calls auth.test, self-only users.profile.set and buffer upload users.setPhoto", async (t) => {
  const f = fixture(t);
  const original = WebClient.prototype.apiCall;
  const calls: { method: string; args: unknown }[] = [];
  WebClient.prototype.apiCall = async function (method, args) {
    calls.push({ method, args });
    return { ok: true, user_id: identity.user, team_id: identity.team };
  };
  t.after(() => { WebClient.prototype.apiCall = original; });
  const tools = createSlackProfileTools({ channel: f.channel });
  await tools.find((tool) => tool.name === "clear_slack_status")!.execute("id", {}, undefined, undefined, {} as never);
  await tools.find((tool) => tool.name === "set_slack_profile_photo")!.execute("id", { path: "photo.png" }, undefined, undefined, {} as never);
  assert.deepEqual(calls.map((call) => call.method), ["auth.test", "users.profile.set", "auth.test", "users.setPhoto"]);
  assert.deepEqual(calls[1]!.args, { profile: { status_text: "", status_emoji: "", status_expiration: 0 } });
  assert.deepEqual(calls[3]!.args, { image: f.png });
});
