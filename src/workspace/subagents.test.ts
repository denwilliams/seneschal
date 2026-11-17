import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessConfigSchema } from "../config/schema.ts";
import { narrowChannelForAgent } from "./subagents.ts";
import { workspaceFixture } from "./fixture.ts";

const connectors = {
  github: { transport: "stdio", command: "gh-mcp" },
  linear: { transport: "stdio", command: "linear-mcp" },
};

const agentSets = {
  software_engineering: {
    agents: {
      coder: { description: "Writes code.", tools: ["read", "write", "edit", "bash"], connectors: ["github"] },
      reviewer: { description: "Reviews code.", tools: ["read", "grep"], connectors: ["github", "linear"], model: "openai/gpt-5.4" },
      deployer: { description: "Deploys.", tools: ["bash"] },
    },
  },
};

function fixture(channel: object = {}, extra: object = {}) {
  return workspaceFixture({
    connectors,
    agentSets,
    channels: { eng: { tools: ["read", "write", "bash"], share: { connectors: ["github"] }, agentSet: "software_engineering", ...channel } },
    ...extra,
  });
}

test("a channel with no agent set has no subagents", () => {
  const f = workspaceFixture({ agentSets });
  const channel = f.resolve("C1", { name: "other" });
  assert.deepEqual(channel.agents, []);
  assert.equal(channel.agentSet, undefined);
});

test("subagent capability is the intersection of the set and what the channel holds", () => {
  const channel = fixture().resolve("C1", { name: "eng" });
  const byName = Object.fromEntries(channel.agents.map((agent) => [agent.name, agent]));
  // The channel has no `edit` and no `grep`: the set can ask, but cannot grant.
  assert.deepEqual(byName.coder!.tools, ["read", "write", "bash"]);
  assert.deepEqual(byName.reviewer!.tools, ["read"]);
  // The channel holds github but not linear.
  assert.deepEqual(byName.coder!.connectors, ["github"]);
  assert.deepEqual(byName.reviewer!.connectors, ["github"]);
  assert.deepEqual(byName.deployer!.connectors, []);
  assert.equal(channel.agentSet, "software_engineering");
});

test("a subagent's model defaults to the channel's and may be set by the role", () => {
  const channel = fixture({ model: "deepseek-v4-pro" }).resolve("C1", { name: "eng" });
  const byName = Object.fromEntries(channel.agents.map((agent) => [agent.name, agent]));
  assert.equal(byName.coder!.model, "deepseek-v4-pro");
  assert.equal(byName.reviewer!.model, "openai/gpt-5.4");
});

test("a channel can narrow a role but never widen it", () => {
  const narrowed = fixture({
    agentOverrides: { coder: { tools: ["read"] }, deployer: { enabled: false } },
  }).resolve("C1", { name: "eng" });
  assert.deepEqual(narrowed.agents.map((agent) => agent.name), ["coder", "reviewer"]);
  assert.deepEqual(narrowed.agents[0]!.tools, ["read"]);

  assert.throws(
    () => HarnessConfigSchema.parse({
      agentSets,
      channels: { eng: { agentSet: "software_engineering", agentOverrides: { reviewer: { tools: ["bash"] } } } },
    }),
    /only narrow/,
  );
  assert.throws(
    () => HarnessConfigSchema.parse({
      agentSets,
      channels: { eng: { agentSet: "software_engineering", agentOverrides: { coder: { connectors: ["linear"] } } } },
    }),
    /only narrow/,
  );
});

test("config validation rejects unknown sets, unknown agents and orphan overrides", () => {
  assert.throws(() => HarnessConfigSchema.parse({ channels: { eng: { agentSet: "nope" } } }), /no agentSets entry/);
  assert.throws(
    () => HarnessConfigSchema.parse({ agentSets, channels: { eng: { agentSet: "software_engineering", agentOverrides: { ghost: {} } } } }),
    /has no agent/,
  );
  assert.throws(() => HarnessConfigSchema.parse({ channels: { eng: { agentOverrides: { coder: {} } } } }), /needs an agentSet/);
  assert.throws(() => HarnessConfigSchema.parse({ agentSets: { Bad: { agents: { a: { description: "x" } } } } }), /lowercase/);
  assert.throws(() => HarnessConfigSchema.parse({ agentSets: { ok: { agents: {} } } }), /at least one agent/);
  assert.throws(
    () => HarnessConfigSchema.parse({ agentSets: { ok: { agents: { a: { description: "x", unknown: 1 } } } } }),
    /unrecognized|Unrecognized/i,
  );
});

test("one set can be assigned to several channels, each narrowed independently", () => {
  const f = workspaceFixture({
    connectors,
    agentSets,
    channels: {
      a: { tools: ["read", "bash"], share: { connectors: ["github", "linear"] }, agentSet: "software_engineering" },
      b: { tools: ["read"], agentSet: "software_engineering", agentOverrides: { coder: { enabled: false } } },
    },
  });
  const a = f.resolve("C1", { name: "a" });
  const b = f.resolve("C2", { name: "b" });
  assert.deepEqual(a.agents.find((agent) => agent.name === "reviewer")!.connectors, ["github", "linear"]);
  assert.deepEqual(b.agents.map((agent) => agent.name), ["reviewer", "deployer"]);
  assert.deepEqual(b.agents.find((agent) => agent.name === "deployer")!.tools, [], "no bash in b, so the deployer cannot have it");
});

test("the narrowed channel a subagent sees has no outward reach", () => {
  const channel = fixture({ admin: true }).resolve("C1", { name: "eng" });
  const coder = channel.agents.find((agent) => agent.name === "coder")!;
  const narrowed = narrowChannelForAgent(channel, coder);
  assert.deepEqual(narrowed.tools, coder.tools);
  assert.equal(narrowed.admin, false);
  assert.deepEqual(narrowed.agents, [], "no subagents of its own");
  assert.deepEqual(narrowed.delegation.targets, []);
  assert.equal(narrowed.library.canPublish, false);
  assert.equal(narrowed.documents.canAdd, false);
  assert.equal(narrowed.memory.canWriteShared, false);
  assert.deepEqual(narrowed.requestable, []);
  // Same workspace and memory file: the hive mind is the channel's, not the role's.
  assert.equal(narrowed.paths.workspace, channel.paths.workspace);
  assert.equal(narrowed.memory.channelFile, channel.memory.channelFile);
  assert.deepEqual(narrowed.connectors.map((connector) => connector.name), ["github"]);
});

test("GitHub token overrides select independent role identities without changing the parent", () => {
  const channel = fixture().resolve("C1", { name: "eng" });
  channel.env = Object.freeze({
    GH_TOKEN: "fixture-default", GH_TOKEN_CODER: "fixture-coder", GH_TOKEN_REVIEWER: "fixture-reviewer",
    GH_TOKEN_GITHUB_TRIAGE: "fixture-triage", GH_TOKEN_UNUSED_ROLE: "fixture-unused", OTHER_SETTING: "kept",
  });
  const original = { ...channel.env };
  const coder = channel.agents.find((agent) => agent.name === "coder")!;
  for (const [name, expected] of [
    ["coder", "fixture-coder"], ["reviewer", "fixture-reviewer"], ["github_triage", "fixture-triage"],
    ["github-triage", "fixture-triage"],
    ["cloudflare_deployer", "fixture-default"], ["librarian", "fixture-default"],
  ]) {
    const child = narrowChannelForAgent(channel, { ...coder, name: name! });
    assert.ok(child.env.GH_TOKEN === expected, "the selected role gets its override, or the default");
    assert.ok(!Object.keys(child.env).some((key) => key.startsWith("GH_TOKEN_")), "no override variables reach any role");
    assert.equal(child.env.OTHER_SETTING, "kept");
    assert.notEqual(child.env, channel.env);
  }
  assert.ok(JSON.stringify(channel.env) === JSON.stringify(original), "parent credentials remain unchanged");
});

test("unset and empty GitHub overrides preserve existing fallback behavior", () => {
  const channel = fixture().resolve("C1", { name: "eng" });
  const coder = channel.agents.find((agent) => agent.name === "coder")!;
  const environments: Record<string, string>[] = [
    { GH_TOKEN: "fixture-default" },
    { GH_TOKEN: "fixture-default", GH_TOKEN_CODER: "" },
    { GH_TOKEN: "", GH_TOKEN_CODER: "" },
    {},
    { GH_TOKEN_CODER: "" },
    { GH_TOKEN_CODER: "fixture-coder" },
    { GH_TOKEN_REVIEWER: "fixture-reviewer" },
  ];
  for (const env of environments) {
    channel.env = env;
    const before = JSON.stringify(env);
    const child = narrowChannelForAgent(channel, coder);
    const expected = channel.env.GH_TOKEN_CODER || channel.env.GH_TOKEN;
    assert.ok(child.env.GH_TOKEN === expected, "fallback includes an absent or empty default");
    assert.ok(!Object.keys(child.env).some((key) => key.startsWith("GH_TOKEN_")));
    assert.ok(JSON.stringify(env) === before, "the original environment is not mutated");
  }
});

test("the post_as_user reviewer role is not offered as a subagent", () => {
  const f = workspaceFixture({
    agentSets: { guards: { agents: { helper: { description: "Helps." }, post_guard: { description: "Reviews.", tools: [], instructions: "Be strict.", timeoutSeconds: 30, thinkingLevel: "low" } } } },
    channels: { inbox: { model: "m1", agentSet: "guards", share: { postAs: { user: "U123ABC", reviewer: "post_guard", rules: "no pricing", privateLinkHosts: ["wiki.example.com"] } } } },
  });
  const channel = f.resolve("C1", { name: "inbox" });
  assert.deepEqual(channel.agents.map((a) => a.name), ["helper"]);
  assert.deepEqual(channel.postAs, {
    user: "U123ABC", maxPerHour: 10, rules: "no pricing", privateLinkHosts: ["wiki.example.com"],
    reviewer: { name: "post_guard", model: "m1", thinkingLevel: "low", instructions: "Be strict.", timeoutSeconds: 30 },
  });
});

test("postAs is read from the channel entry only", () => {
  const f = workspaceFixture({ channels: { inbox: {}, other: { agentSet: undefined } } });
  assert.equal(f.resolve("C1", { name: "inbox" }).postAs, undefined);
});
