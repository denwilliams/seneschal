import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledgeBase } from "./knowledge-base.ts";
import { createKnowledgeTools } from "./knowledge-tools.ts";

function base(name: string, files: Record<string, string>, description?: string) {
  const dir = mkdtempSync(join(tmpdir(), `kb-${name}-`));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return openKnowledgeBase(name, { path: dir, index: "index.md", ...(description ? { description } : {}) }, "/", "test")!;
}

const run = async (tools: ReturnType<typeof createKnowledgeTools>, name: string, params: object) => {
  const tool = tools.find((t) => t.name === name)!;
  const result = await tool.execute("id", params as never, undefined as never, undefined as never, undefined as never);
  return (result.content[0] as { text: string }).text;
};

const one = () => createKnowledgeTools({ channel: { knowledgeBases: [base("wiki", { "index.md": "# Home\n[[Deploys]]\n", "ops/Deploys.md": "Deploy on Tuesdays.\n" }, "Team handbook")] } });

test("a channel with no knowledge base gets no tools", () => {
  assert.deepEqual(createKnowledgeTools({ channel: { knowledgeBases: [] } }), []);
});

test("the tools are read-only and name the knowledge bases they cover", () => {
  const tools = one();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["kb_ls", "kb_read", "kb_search"]);
  assert.match(tools[0]!.description, /Team handbook/);
});

test("kb_read with no path opens the index and lists where to go next", async () => {
  const text = await run(one(), "kb_read", {});
  assert.match(text, /wiki:index\.md/);
  assert.match(text, /# Home/);
  assert.match(text, /- ops\/Deploys\.md/);
});

test("kb_read says more follows and how to continue", async () => {
  const text = await run(one(), "kb_read", { path: "index.md", limit: 5 });
  assert.match(text, /call kb_read again with offset 5/);
});

test("a refused path is an error the model can read, not a crash", async () => {
  await assert.rejects(run(one(), "kb_read", { path: "../../etc/passwd" }), /outside/);
  await assert.rejects(run(one(), "kb_ls", { path: "/etc" }), /relative/);
});

test("a knowledge base without its index says so and points at the other tools", async () => {
  const tools = createKnowledgeTools({ channel: { knowledgeBases: [base("bare", { "page.md": "x\n" })] } });
  await assert.rejects(run(tools, "kb_read", {}), /no index page.*kb_ls/);
});

test("kb_ls and kb_search work against the sole knowledge base without naming it", async () => {
  const tools = one();
  assert.match(await run(tools, "kb_ls", {}), /ops\//);
  const found = await run(tools, "kb_search", { query: "tuesdays" });
  assert.match(found, /wiki:ops\/Deploys\.md/);
  assert.match(await run(tools, "kb_search", { query: "zzzz" }), /Nothing in "wiki" matches/);
});

test("with several knowledge bases, reading must name one and search covers all", async () => {
  const tools = createKnowledgeTools({
    channel: {
      knowledgeBases: [base("eng", { "index.md": "# Eng\n", "a.md": "kubernetes notes\n" }), base("hr", { "index.md": "# HR\n", "b.md": "kubernetes training budget\n" })],
    },
  });
  await assert.rejects(run(tools, "kb_read", {}), /Say which knowledge base. Available: eng, hr/);
  await assert.rejects(run(tools, "kb_read", { kb: "finance" }), /no knowledge base named "finance"/);
  assert.match(await run(tools, "kb_read", { kb: "hr" }), /hr:index\.md/);
  const found = await run(tools, "kb_search", { query: "kubernetes" });
  assert.match(found, /eng:a\.md/);
  assert.match(found, /hr:b\.md/);
  assert.doesNotMatch(await run(tools, "kb_search", { query: "kubernetes", kb: "eng" }), /hr:b\.md/);
  await assert.rejects(run(tools, "kb_search", { query: "x", path: "docs" }), /needs `kb`/);
});

test("kb_ls recursive lists the whole tree beneath a path, with paths relative to it", async () => {
  const tools = createKnowledgeTools({
    channel: { knowledgeBases: [base("wiki", { "index.md": "x", "a/one.md": "1", "a/b/two.md": "2", "c/three.md": "3", ".git/config": "no" })] },
  });
  const top = await run(tools, "kb_ls", { recursive: true });
  assert.match(top, /\na\/\na\/b\/\na\/b\/two\.md/);
  assert.match(top, /c\/three\.md/);
  assert.doesNotMatch(top, /\.git/);
  const sub = await run(tools, "kb_ls", { path: "a", recursive: true });
  assert.match(sub, /wiki:a \(recursive\)/);
  assert.match(sub, /\nb\/two\.md/);
  assert.doesNotMatch(sub, /three/);
  assert.doesNotMatch(await run(tools, "kb_ls", {}), /two\.md/);
});
