import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel, type ResolvedChannel } from "../workspace/resolve.ts";
import { narrowChannelForAgent } from "../workspace/subagents.ts";
import { buildThreadToolSet, verifySourceInThread, type CreateThreadSessionOptions } from "./session.ts";
import type { UserPoster } from "./post-as-tools.ts";

const withPostAs = {
  agentSets: { guards: { agents: { post_guard: { description: "Reviews posts.", tools: [] } } } },
  channels: { eng: { agentSet: "guards", tools: ["read"], share: { postAs: { user: "U01OWNER1", reviewer: "post_guard" } } } },
};
const withoutPostAs = { channels: { eng: { tools: ["read"] } } };

function channelFor(t: TestContext, input: unknown): ResolvedChannel {
  const dataDir = mkdtempSync(join(tmpdir(), "session-post-as-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = HarnessConfigSchema.parse(input);
  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, new ChannelRegistry(dataDir));
  assert.ok(channel);
  return channel;
}

type PostInput = Parameters<UserPoster["postAsUser"]>[0];

function recordingPoster() {
  const calls: PostInput[] = [];
  const poster: UserPoster = {
    postAsUser: async (input) => {
      calls.push(input);
      return { status: "sent", label: "#general" };
    },
  };
  return { poster, calls };
}

async function toolSet(t: TestContext, channel: ResolvedChannel, extra: Partial<CreateThreadSessionOptions> = {}) {
  const set = await buildThreadToolSet(
    {
      channel, threadKey: "100.1", threadTs: "100.1", harnessName: "Test", slackChannelLabel: "#eng", botUserId: "UBOT",
      modelRuntime: {} as never, runtimes: {} as never, initialUserId: "U1", ...extra,
    },
    { current: () => undefined, set: async () => undefined },
  );
  t.after(() => set.dispose());
  return set;
}

const names = (set: { tools: { name: string }[] }) => set.tools.map((tool) => tool.name);

test("post_as_user is offered only when the channel has postAs AND a user poster is wired", async (t) => {
  const { poster } = recordingPoster();
  const configured = channelFor(t, withPostAs);
  assert.ok(names(await toolSet(t, configured, { userPoster: poster })).includes("post_as_user"));
  assert.ok(!names(await toolSet(t, configured)).includes("post_as_user"), "no poster, no tool");
  assert.ok(!names(await toolSet(t, channelFor(t, withoutPostAs), { userPoster: poster })).includes("post_as_user"), "no postAs, no tool");
});

test("a subagent is never given post_as_user, and narrowing a channel for a subagent drops postAs", async (t) => {
  const { poster } = recordingPoster();
  const configured = channelFor(t, withPostAs);
  assert.ok(configured.postAs);
  assert.ok(!names(await toolSet(t, configured, { userPoster: poster, role: "subagent" })).includes("post_as_user"));
  const narrowed = narrowChannelForAgent(configured, {
    name: "coder", description: "Writes code.", model: "m", thinkingLevel: "medium", tools: [], connectors: [], timeoutSeconds: 60, requireApproval: false,
  } as never);
  assert.ok("postAs" in narrowed, "postAs is set explicitly, not just inherited by the spread");
  assert.equal(narrowed.postAs, undefined);
});

const store = (turns: { role: "user" | "assistant"; text: string }[]) => ({
  threadTurns: async (key: string) => (key === "100.1" ? turns : []),
});

test("verifySource: a quote of 12+ characters from a user turn of this thread is verified, whitespace and case aside", async () => {
  const s = store([{ role: "user", text: "Please   tell #general\nthat the Deploy is DONE, thanks" }]);
  assert.equal(await verifySourceInThread(s, "100.1", "tell #general that the deploy is done"), true);
});

test("verifySource: assistant-only text, absent text, short text, another thread, no store or an error are all unverified", async () => {
  const s = store([
    { role: "user", text: "hi there, can you help" },
    { role: "assistant", text: "I will tell #general the deploy is done" },
  ]);
  assert.equal(await verifySourceInThread(s, "100.1", "tell #general the deploy is done"), false, "assistant turns do not count");
  assert.equal(await verifySourceInThread(s, "100.1", "something nobody said at all"), false);
  assert.equal(await verifySourceInThread(s, "100.1", "can you help"), true, "exactly 12 characters is enough");
  assert.equal(await verifySourceInThread(s, "100.1", "you help"), false, "under 12 characters is too short to count");
  assert.equal(await verifySourceInThread(s, "200.2", "hi there, can you help"), false, "only the current thread");
  assert.equal(await verifySourceInThread(undefined, "100.1", "hi there, can you help"), false);
  assert.equal(await verifySourceInThread({ threadTurns: async () => { throw new Error("boom"); } }, "100.1", "hi there, can you help"), false);
});

test("the wired tool checks the source against the lazily-resolved store of this thread", async (t) => {
  const { poster, calls } = recordingPoster();
  let resolved: ReturnType<typeof store> | undefined;
  const set = await toolSet(t, channelFor(t, withPostAs), { userPoster: poster, threadStore: () => resolved });
  const tool = set.tools.find((x) => x.name === "post_as_user")! as unknown as { execute: (id: string, params: unknown) => Promise<unknown> };
  const params = { target: "#general", text: "The deploy is done.", source: 'Alice in #eng: "tell #general the deploy is done"', reason: "Alice asked." };

  await tool.execute("a", params);
  assert.equal(calls[0]!.sourceVerified, false, "no store yet");
  resolved = store([{ role: "user", text: "Tell #general the deploy is done please" }]);
  await tool.execute("b", params);
  assert.equal(calls[1]!.sourceVerified, true);
  assert.equal(calls[1]!.sourceChannelId, "C1");
  assert.equal(calls[1]!.sourceThreadTs, "100.1");
  assert.equal(calls[1]!.postAs.user, "U01OWNER1");
});
