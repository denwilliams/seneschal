import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { HarnessConfigSchema } from "../config/schema.ts";
import { REPO_ROOT } from "../config/load.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { createThreadSession } from "./session.ts";
import { listSkills } from "./skills.ts";
import { ChannelTimelineLog } from "./timeline.ts";
import { layoutGraph, summarize } from "../console2/timeline-graph.ts";

/**
 * The software factory proof of concept, from the real example config: the shipped agent set and its shipped
 * skills, driven through a real channel store with a scripted model.
 */

function exampleAgentSet() {
  const example = parse(readFileSync(join(REPO_ROOT, "config", "harness.example.yaml"), "utf8"));
  return example.agentSets as Record<string, unknown>;
}

async function fixture(t: TestContext, extra: { connectors?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "factory-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  // The example's roles name `openai/...` only through the channel default; pin every role to the fixture model here.
  const set = JSON.parse(JSON.stringify(exampleAgentSet())) as { software_factory: { agents: Record<string, { model?: string }> } };
  for (const agent of Object.values(set.software_factory.agents)) agent.model = "fixture/model";
  const config = HarnessConfigSchema.parse({
    agentSets: set,
    ...(extra.connectors === false ? {} : {
      connectors: {
        github: { transport: "stdio", command: "gh-mcp" },
      },
    }),
    channels: {
      factory: {
        model: "fixture/model",
        agentSet: "software_factory",
        tools: ["read", "write", "edit", "ls", "find", "grep", "bash"],
        factory: { name: "Acme", repositories: ["acme/app"] },
        share: { connectors: extra.connectors === false ? [] : ["github"] },
      },
    },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "factory", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  return { dataDir, faux, modelRuntime, channel, config };
}

const systemMessages = (context: TranscriptContext) =>
  context.messages.filter((m) => m.role === "system") as unknown as { content: string; sections: Record<string, string>; toolsAdded?: { name: string }[] }[];
const toolNames = (context: TranscriptContext) =>
  [...new Set(systemMessages(context).flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name)))].sort();
const systemPrompt = (context: TranscriptContext) =>
  systemMessages(context).flatMap((m) => [m.content, ...Object.values(m.sections ?? {})]).join("\n\n");

test("the software factory set resolves to four roles, each narrowed to what the channel has", async (t) => {
  const f = await fixture(t);
  t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
  const roles = Object.fromEntries(f.channel.agents.map((agent) => [agent.name, agent]));
  assert.deepEqual(Object.keys(roles).sort(), ["cloudflare_deployer", "coder", "github_triage", "reviewer"]);
  assert.deepEqual(roles.github_triage!.tools, ["read", "bash"]);
  assert.deepEqual(roles.github_triage!.connectors, ["github"]);
  assert.deepEqual(roles.reviewer!.tools, ["read", "ls", "find", "grep", "bash"], "a reviewer cannot write or edit");
  assert.ok(!roles.reviewer!.tools.includes("write"));
  // The deployer works through wrangler in a shell, not a connector: there is nothing for the channel to supply but credentials.
  assert.deepEqual(roles.cloudflare_deployer!.connectors, []);
  assert.deepEqual(roles.cloudflare_deployer!.tools, ["read", "bash"]);
  assert.equal(roles.cloudflare_deployer!.requireApproval, true);
  assert.deepEqual(roles.coder!.connectors, ["github"]);
});

test("a channel without the connectors drops them from the roles instead of failing", async (t) => {
  const f = await fixture(t, { connectors: false });
  t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
  for (const agent of f.channel.agents) assert.deepEqual(agent.connectors, [], agent.name);
});

test("the factory's shipped skills reach the channel and are readable by its roles", async (t) => {
  const f = await fixture(t);
  t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
  const names = listSkills(f.channel).map((skill) => skill.name);
  for (const name of ["factory-pipeline", "factory-handoffs", "github-issue-triage", "cloudflare-deploy"]) {
    assert.ok(names.includes(name), `${name} is available`);
    const skill = listSkills(f.channel).find((s) => s.name === name)!;
    assert.equal(skill.origin, "builtin", `${name} is the harness's own, reviewed in git`);
    assert.ok(f.channel.jail.readRoots.some((root) => skill.path.startsWith(root)), `${name} is inside the read jail`);
    assert.ok(!f.channel.jail.writeRoots.some((root) => skill.path.startsWith(root)), `${name} is not writable`);
  }
  // A channel that does not use the set does not get its skills.
  const other = resolveChannel(f.config, f.dataDir, { id: "C2", name: "random", isDm: false }, new ChannelRegistry(f.dataDir)).channel!;
  assert.ok(!listSkills(other).some((skill) => skill.name === "factory-pipeline"));
});

test("an issue goes triage, build, review, a changes-requested loop, approval, and the user hears once", async (t) => {
  // No connectors: the roles here work through `bash` and the `gh` CLI, and a fake connector command only adds noise.
  const f = await fixture(t, { connectors: false });
  const runtimes = new ChannelRuntimes({ modelRuntime: f.modelRuntime });
  const session = await createThreadSession({
    channel: f.channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#factory", botUserId: "UBOT",
    modelRuntime: f.modelRuntime, runtimes, initialUserId: "U1",
    timeline: new ChannelTimelineLog(f.channel.paths.root),
  });
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); rmSync(f.dataDir, { recursive: true, force: true }); });

  const seen: Record<string, TranscriptContext[]> = { triage: [], coder: [], reviewer: [] };
  let parent: TranscriptContext | undefined;
  const run = (agent: string, task: string, id: string) =>
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent, task }, { id }), { stopReason: "toolUse" });
  const child = (bucket: string, reply: string): FauxResponseFactory => (context) => {
    seen[bucket]!.push(context);
    return fauxAssistantMessage(reply);
  };
  f.faux.setResponses([
    (context) => { parent = context; return run("github_triage", "Triage status:triage issues in acme/app.", "t1"); },
    child("triage", "STATUS: done\nNEXT: coder\n#7 — ready — status:ready, type:bug, priority:p1 — reproducible with steps.\nREADY: 7"),
    run("coder", "Implement acme/app#7 (login fails on empty password).", "c1"),
    child("coder", "STATUS: done\nNEXT: reviewer\nBranch fix/7, PR #12 https://github.com/acme/app/pull/12. Tests: npm test, 41 passed."),
    run("reviewer", "Review PR #12 for issue #7.", "r1"),
    child("reviewer", "STATUS: done\nNEXT: coder\nVERDICT: CHANGES_REQUESTED\n- blocker: src/login.ts:44 trims the password."),
    run("coder", "Round 2 on PR #12. Reviewer found: src/login.ts:44 trims the password.", "c2"),
    child("coder", "STATUS: done\nNEXT: reviewer\nFixed in 3f2a9c1. npm test: 42 passed."),
    run("reviewer", "Re-review PR #12.", "r2"),
    child("reviewer", "STATUS: done\nNEXT: none\nVERDICT: APPROVED\nTests: npm test 42 passed."),
    fauxAssistantMessage("PR #12 fixes #7 and is approved: https://github.com/acme/app/pull/12. Ready for you to merge."),
  ]);

  await session.session.prompt("please work through the new issues in acme/app", { requestId: "r-factory", userId: "U1" });

  assert.equal(session.session.getLastAssistantText(), "PR #12 fixes #7 and is approved: https://github.com/acme/app/pull/12. Ready for you to merge.");
  assert.equal(f.faux.state.callCount, 11);
  assert.equal(seen.triage!.length, 1);
  assert.equal(seen.coder!.length, 2);
  assert.equal(seen.reviewer!.length, 2);

  // The lead is told about all four roles and has the pipeline skill; it can run subagents and nothing outward-facing is missing.
  assert.match(systemPrompt(parent!), /`github_triage`[\s\S]*`coder`[\s\S]*`reviewer`[\s\S]*`cloudflare_deployer`/);
  assert.match(systemPrompt(parent!), /factory-pipeline/);
  // The lead is told to start a workflow run and relay decisions, never to merge, and has the tools for it.
  assert.match(systemPrompt(parent!), /### Workflow runs[\s\S]*`start_factory_run`[\s\S]*You never merge a pull request/);
  assert.match(systemPrompt(parent!), /A failed stage is recoverable[\s\S]*`retry` the same stage[\s\S]*`restart_from` an earlier stage[\s\S]*Never start a new run for an issue whose run is waiting/);
  assert.doesNotMatch(systemPrompt(parent!), /`failed` is something that broke and needs a person/, "a failed stage no longer ends the run");
  assert.match(systemPrompt(parent!), /only when they have told you to in this conversation/);
  for (const tool of ["start_factory_run", "check_factory_run", "factory_approve", "factory_decline", "factory_more_rounds", "factory_decide", "factory_abort"]) assert.ok(toolNames(parent!).includes(tool), `the lead has ${tool}`);
  const pipeline = readFileSync(join(REPO_ROOT, "agent-set-skills", "software_factory", "factory-pipeline", "SKILL.md"), "utf8");
  assert.match(pipeline, /`start_factory_run`[\s\S]*Never merge\.[\s\S]*Relay decisions, never make them/);
  assert.match(pipeline, /## When there is no run \(the tools are not offered\)/);
  assert.ok(toolNames(parent!).includes("run_subagent"));

  // Each role saw its own tools, and only those (plus output saving, the clock, read-only memory and read-only channel state and lists).
  assert.deepEqual(toolNames(seen.triage![0]!), ["bash", "extract_local_pdf", "get_current_time", "list_read", "read", "recall", "save_tool_output", "state_read"]);
  assert.deepEqual(toolNames(seen.reviewer![0]!), ["bash", "extract_local_pdf", "find", "get_current_time", "grep", "list_read", "ls", "read", "recall", "save_tool_output", "state_read"]);
  assert.ok(toolNames(seen.coder![0]!).includes("write") && toolNames(seen.coder![0]!).includes("edit"));
  for (const role of Object.values(seen)) for (const context of role) {
    const tools = toolNames(context);
    for (const forbidden of ["run_subagent", "remember", "forget", "state_update", "list_update", "save_skill", "post_message", "switch_model", "transfer_to_channel", "start_factory_run", "create_factory_issue", "check_factory_run", "factory_approve", "factory_decline", "factory_more_rounds", "factory_decide", "factory_abort", "check_factory_intake", "factory_intake_release"]) {
      assert.ok(!tools.includes(forbidden), `a subagent must not have ${forbidden}`);
    }
  }

  // Roles read the same channel skills (the shipped handoff contract included) and carry their own instructions.
  assert.match(systemPrompt(seen.triage![0]!), /factory-handoffs/);
  assert.match(systemPrompt(seen.triage![0]!), /You triage GitHub issues/);
  assert.match(systemPrompt(seen.reviewer![0]!), /Do not change the code\s+you are reviewing/);
  assert.doesNotMatch(systemPrompt(seen.reviewer![0]!), /You triage GitHub issues/);

  // Everything the team did is on the channel's timeline as a branch per run, each merging back with its report.
  const events = new ChannelTimelineLog(f.channel.paths.root).read();
  const layout = layoutGraph(events);
  const forks = layout.rows.filter((row) => row.shape === "fork").map((row) => row.event.actor);
  const merges = layout.rows.filter((row) => row.shape === "merge").map((row) => [row.event.actor, row.event.status, row.event.next ?? null]);
  assert.deepEqual(forks, ["github_triage", "coder", "reviewer", "coder", "reviewer"]);
  assert.deepEqual(merges, [["github_triage", "done", "coder"], ["coder", "done", "reviewer"], ["reviewer", "done", "coder"], ["coder", "done", "reviewer"], ["reviewer", "done", null]]);
  assert.equal(layout.lanes, 1, "the runs happened one after another, so they share a lane");
  assert.equal(summarize(events).runs, 5);
  assert.match(layout.rows.map((row) => row.event.detail ?? "").join("\n"), /VERDICT: CHANGES_REQUESTED|src\/login\.ts:44 trims the password/);

  // The second coder round starts from its brief alone: it did not inherit round one's context.
  const round2 = JSON.stringify(seen.coder![1]!.messages.filter((m) => m.role !== "system"));
  assert.match(round2, /Round 2 on PR #12/);
  assert.doesNotMatch(round2, /Implement acme\/app#7/);
});
