import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { FactorySchema, SandboxSchema } from "../config/schema.ts";
import { FACTORY } from "../config/edit-policy.ts";
import { buildExecArgs, buildRunArgs, channelPathEnv, containerEnvironment } from "../agent/sandbox.ts";
import { workspaceFixture } from "./fixture.ts";
import { narrowChannelForAgent } from "./subagents.ts";

const author = { name: "Factory Automation", email: "automation@example.com" };
const other = { name: "Other Factory", email: "other@example.com" };
const factory = (commitAuthor?: unknown) => ({ name: "Test", repositories: ["example/project"], ...(commitAuthor === undefined ? {} : { commitAuthor }) });
const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const inherited = { GIT_AUTHOR_NAME: "Inherited", GIT_AUTHOR_EMAIL: "inherited@example.com", GIT_COMMITTER_NAME: "Inherited Committer", GIT_COMMITTER_EMAIL: "committer@example.com", EMAIL: "fallback@example.com" };

function world(t: TestContext) {
  const f = workspaceFixture({
    agentSets: { engineering: { agents: {
      coder: { description: "Implements", tools: ["bash"] },
      reviewer: { description: "Reviews", tools: ["bash"] },
    } } },
    channels: Object.fromEntries(Object.entries({ A: factory(author), B: factory(other), C: factory(), D: undefined }).map(([id, factory]) =>
      [id, { agentSet: "engineering", tools: ["bash"], ...(factory ? { factory } : {}) }])),
  });
  t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
  return f;
}

test("commitAuthor requires a valid explicit name and email, and is operator-only", () => {
  assert.deepEqual(FactorySchema.parse(factory({ ...author, name: "  Factory Automation  " })).commitAuthor, author);
  assert.equal(FactorySchema.parse(factory()).commitAuthor, undefined);
  for (const invalid of [null, {}, { name: author.name }, { email: author.email },
    { ...author, extra: true }, { ...author, email: "not-email" }, { ...author, email: "x@example.com\n" },
    { ...author, email: "x".repeat(250) + "@example.com" },
    ...["", "   ", "x".repeat(201), "Name <email>", "a\nb", "a\x00b", "a\x7fb"].map(name => ({ ...author, name })),
  ]) assert.equal(FactorySchema.safeParse(factory(invalid)).success, false, JSON.stringify(invalid));
  assert.equal(typeof FACTORY.commitAuthor, "object");
  assert.ok("deny" in (FACTORY.commitAuthor as object));
});

test("identity is isolated per factory and coder; unset leaves inherited identity alone", t => {
  const f = world(t);
  for (const [id, expected] of [["A", author], ["B", other], ["C", undefined], ["D", undefined]] as const) {
    const parent = f.resolve(id);
    parent.env = Object.freeze({ PATH: process.env.PATH!, ...inherited });
    const before = JSON.stringify(parent.env);
    for (const role of ["coder", "reviewer"]) {
      const child = narrowChannelForAgent(parent, parent.agents.find(a => a.name === role)!);
      const configured = role === "coder" ? expected : undefined;
      assert.equal(child.env.GIT_AUTHOR_EMAIL, configured?.email ?? inherited.GIT_AUTHOR_EMAIL);
      assert.equal(child.env.GIT_AUTHOR_NAME, configured?.name ?? inherited.GIT_AUTHOR_NAME);
      assert.equal(child.env.GIT_COMMITTER_EMAIL, configured?.email ?? inherited.GIT_COMMITTER_EMAIL);
      assert.equal(child.env.GIT_COMMITTER_NAME, configured?.name ?? inherited.GIT_COMMITTER_NAME);
    }
    assert.equal(JSON.stringify(parent.env), before);
  }
  const unset = f.resolve("C");
  unset.env = {};
  assert.deepEqual(narrowChannelForAgent(unset, unset.agents[0]!).env, {}, "no invented identity when unset");
});

test("host bash commits use configured metadata despite conflicting env, global and repo config", async t => {
  const f = world(t);
  const global = join(f.dataDir, "gitconfig");
  const config = '[user]\n name = Global User\n email = global@example.com\n';
  writeFileSync(global, config);
  const parent = f.resolve("A");
  parent.env = Object.freeze({ PATH: process.env.PATH!, HOME: f.dataDir, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", ...inherited });
  const cwd = parent.paths.workspace;
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd, env: parent.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(["init"]);
  for (const key of ["user.name", "author.name", "committer.name"]) git(["config", key, "Local User"]);
  for (const key of ["user.email", "author.email", "committer.email"]) git(["config", key, "local@example.com"]);
  const repoConfig = readFileSync(join(cwd, ".git/config"), "utf8");
  // A fresh narrowing for each attempt models implementation, retry and rework.
  for (let attempt = 0; attempt < 3; attempt++) {
    const child = narrowChannelForAgent(parent, parent.agents[0]!);
    const tool = createBashToolDefinition(cwd, {
      exposeSessionEnvironment: false,
      spawnHook: ctx => ({ ...ctx, env: channelPathEnv(child) }),
    });
    const result = await tool.execute("commit", { command: `git commit --allow-empty -m attempt-${attempt}` }, undefined, undefined, undefined as never);
    assert.doesNotMatch(JSON.stringify(result.content), /fatal:/);
    assert.equal(git(["log", "-1", "--format=%an|%ae|%cn|%ce"]), `${author.name}|${author.email}|${author.name}|${author.email}`);
  }
  assert.equal(git(["rev-list", "--count", "HEAD"]), "3");
  assert.equal(readFileSync(global, "utf8"), config);
  assert.equal(readFileSync(join(cwd, ".git/config"), "utf8"), repoConfig);
});

test("unset identity uses existing Git defaults and fails rather than inventing a missing identity", t => {
  const f = world(t);
  const parent = f.resolve("C");
  parent.env = { PATH: process.env.PATH!, HOME: f.dataDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...inherited };
  const child = narrowChannelForAgent(parent, parent.agents[0]!);
  const git = (args: string[], env = child.env) => spawnSync("git", args, { cwd: child.paths.workspace, env, encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);
  assert.equal(git(["commit", "--allow-empty", "-m", "inherited"]).status, 0);
  assert.equal(git(["log", "-1", "--format=%an|%ae|%cn|%ce"]).stdout.trim(),
    `${inherited.GIT_AUTHOR_NAME}|${inherited.GIT_AUTHOR_EMAIL}|${inherited.GIT_COMMITTER_NAME}|${inherited.GIT_COMMITTER_EMAIL}`);
  parent.env = { PATH: process.env.PATH!, HOME: f.dataDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };
  const empty = narrowChannelForAgent(parent, parent.agents[0]!).env;
  assert.notEqual(git(["commit", "--allow-empty", "-m", "missing"], empty).status, 0);
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "1");
});

test("all sandbox backends forward identity on each reusable exec and throwaway run", t => {
  const f = world(t);
  const parent = f.resolve("A");
  parent.env = inherited;
  const child = narrowChannelForAgent(parent, parent.agents[0]!);
  for (const mode of ["docker", "macos-container", "kiri"] as const) {
    const opts = { config: SandboxSchema.parse({ mode, pidsLimit: null, readOnlyRoot: true }), workspace: child.paths.workspace,
      dataDir: f.dataDir, dockerDataDir: f.dataDir, env: child.env, channelId: "A", threadKey: "thread" };
    const env = containerEnvironment(child.env);
    for (const args of [buildExecArgs(opts, "shared", "git commit"), buildRunArgs(opts, "once", "git commit")]) {
      for (const key of keys) {
        assert.ok(args.some((arg, i) => arg === "--env" && args[i + 1] === key), `${mode}: ${key}`);
        assert.equal(env[key], key.endsWith("EMAIL") ? author.email : author.name);
      }
      assert.ok(!args.includes(author.email), "values are forwarded through process env, not command arguments");
    }
  }
});
