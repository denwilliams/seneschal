import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { narrowChannelForAgent } from "./subagents.ts";
import { workspaceFixture } from "./fixture.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";

function wikiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-cfg-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), "# Wiki\n");
  return dir;
}

const rejects = (input: unknown, expected: RegExp) => {
  const result = HarnessConfigSchema.safeParse(input);
  assert.equal(result.success, false, "config should be rejected");
  if (!result.success) assert.match(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"), expected);
};

test("knowledge bases are declared once and linked by name", () => {
  const parsed = HarnessConfigSchema.parse({
    knowledgeBases: { handbook: { path: "/srv/wiki" } },
    channels: { eng: { share: { knowledgeBases: ["handbook"] } } },
  });
  assert.deepEqual(parsed.knowledgeBases.handbook, { path: "/srv/wiki", index: "index.md" });
  assert.deepEqual(parsed.channels.eng?.share.knowledgeBases, ["handbook"]);
  assert.deepEqual(HarnessConfigSchema.parse({}).knowledgeBases, {});
  assert.deepEqual(HarnessConfigSchema.parse({}).defaults.share.knowledgeBases, []);
});

test("a link to an undeclared knowledge base, a duplicate link or an odd name is refused", () => {
  rejects({ channels: { eng: { share: { knowledgeBases: ["nope"] } } } }, /no knowledgeBases entry named "nope"/);
  rejects(
    { knowledgeBases: { a: { path: "/x" } }, channels: { eng: { share: { knowledgeBases: ["a", "a"] } } } },
    /linked more than once/,
  );
  rejects({ knowledgeBases: { "Bad Name": { path: "/x" } } }, /Bad Name/);
  rejects({ knowledgeBases: { a: { path: "/x", writable: true } } }, /./);
  rejects({ knowledgeBases: { a: {} } }, /./);
});

test("an agent set may not define a role called librarian", () => {
  rejects({ agentSets: { s: { agents: { librarian: { description: "mine" } } } } }, /built-in knowledge base subagent/);
});

test("a linked channel gets its knowledge bases and the librarian, with no agent set", () => {
  const f = workspaceFixture({
    knowledgeBases: { handbook: { path: wikiDir(), description: "How we work" }, ghost: { path: "/definitely/not/here" } },
    librarian: { model: "openai/gpt-5.4-mini", timeoutSeconds: 120 },
    channels: { eng: { share: { knowledgeBases: ["handbook", "ghost"] } } },
  });
  const channel = f.resolve("C1", { name: "eng" });
  // A folder that is missing is skipped, not fatal.
  assert.deepEqual(channel.knowledgeBases.map((kb) => kb.name), ["handbook"]);
  assert.equal(channel.knowledgeBases[0]!.description, "How we work");
  const librarian = channel.agents.find((agent) => agent.name === "librarian")!;
  assert.equal(librarian.model, "openai/gpt-5.4-mini");
  assert.equal(librarian.timeoutSeconds, 120);
  assert.deepEqual(librarian.tools, []);
  assert.deepEqual(librarian.connectors, []);
  assert.equal(librarian.requireApproval, false);
  // The wiki is reachable only through the tools, never by pointing a file tool at it.
  assert.ok(!channel.jail.readRoots.some((root) => root.includes("kb-cfg-")));
});

test("the librarian defaults to the channel's model and sits beside the agent set's roles", () => {
  const f = workspaceFixture({
    knowledgeBases: { handbook: { path: wikiDir() } },
    agentSets: { s: { agents: { coder: { description: "Writes code." } } } },
    channels: { eng: { model: "openai/gpt-5.4", agentSet: "s", share: { knowledgeBases: ["handbook"] } } },
  });
  const channel = f.resolve("C1", { name: "eng" });
  assert.deepEqual(channel.agents.map((agent) => agent.name), ["coder", "librarian"]);
  assert.equal(channel.agents[1]!.model, "openai/gpt-5.4");
});

test("a channel that is not linked has no knowledge bases and no librarian", () => {
  const f = workspaceFixture({
    knowledgeBases: { handbook: { path: wikiDir() } },
    channels: { eng: { share: { knowledgeBases: ["handbook"] } }, other: {} },
  });
  const other = f.resolve("C2", { name: "other" });
  assert.deepEqual(other.knowledgeBases, []);
  assert.deepEqual(other.agents, []);
});

test("only the librarian keeps the knowledge bases when a channel is narrowed for a role", () => {
  const f = workspaceFixture({
    knowledgeBases: { handbook: { path: wikiDir() } },
    agentSets: { s: { agents: { coder: { description: "Writes code." } } } },
    channels: { eng: { agentSet: "s", share: { knowledgeBases: ["handbook"] } } },
  });
  const channel = f.resolve("C1", { name: "eng" });
  const coder = narrowChannelForAgent(channel, channel.agents.find((a) => a.name === "coder")!);
  const librarian = narrowChannelForAgent(channel, channel.agents.find((a) => a.name === "librarian")!);
  assert.deepEqual(coder.knowledgeBases, []);
  assert.deepEqual(librarian.knowledgeBases.map((kb) => kb.name), ["handbook"]);
  // The librarian still cannot reach outward: no subagents of its own, no library, no posting.
  assert.deepEqual(librarian.agents, []);
  assert.equal(librarian.documents.canAdd, false);
});

test("the prompt explains the knowledge bases, and the librarian only when there is one", () => {
  const f = workspaceFixture({
    knowledgeBases: { handbook: { path: wikiDir(), description: "How we work" } },
    channels: { eng: { share: { knowledgeBases: ["handbook"] } }, other: {} },
  });
  const prompt = buildSystemPrompt(f.resolve("C1", { name: "eng" }), { harnessName: "H", slackChannelLabel: "#eng", botUserId: "UBOT" });
  assert.match(prompt, /## Knowledge bases/);
  assert.match(prompt, /`handbook` — How we work/);
  assert.match(prompt, /ask the librarian with `run_subagent`/);
  assert.doesNotMatch(buildSystemPrompt(f.resolve("C2", { name: "other" }), { harnessName: "H", slackChannelLabel: "#other", botUserId: "UBOT" }), /## Knowledge bases/);
});
