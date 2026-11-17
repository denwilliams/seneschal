import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRuntimes, allowedModelRefs } from "./channel-runtime.ts";
import { createThreadSession, type ThreadSession } from "./session.ts";
import { createSubagentRunner, parseReport } from "./subagents.ts";
import { GrantStore, subagentCapability } from "./grants.ts";
import type { TimelineEvent, TimelineInput, TimelineSink } from "./timeline.ts";
import type { SubagentProgress } from "./subagent-tools.ts";
import { approvalCapabilities } from "../workspace/subagents.ts";
import { formatReport } from "./subagent-tools.ts";
import { agentFooter, footerEnv, footerMarker } from "../factory/workflow/footer.ts";

const agentSets = {
  software_engineering: {
    agents: {
      coder: {
        description: "Writes the change and opens a PR.",
        instructions: "You write code. Keep changes small.",
        tools: ["read", "write"],
        model: "fixture/other",
      },
      slow: { description: "Takes too long.", tools: ["read"], timeoutSeconds: 1 },
      deployer: {
        description: "Deploys an approved change.",
        tools: ["read"],
        requireApproval: true,
      },
    },
  },
};

async function fixture(t: TestContext, channelConfig: object = {}, onSubagentMessage?: (info: { agent: string; runKey: string; message: unknown }) => void, timeline?: TimelineSink) {
  const dataDir = mkdtempSync(join(tmpdir(), "subagents-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({
    agentSets,
    channels: {
      eng: { model: "fixture/model", tools: ["read", "write"], agentSet: "software_engineering", ...channelConfig },
    },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const session: ThreadSession = await createThreadSession({
    channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#eng", botUserId: "UBOT",
    modelRuntime, runtimes, initialUserId: "U1",
    ...(onSubagentMessage ? { onSubagentMessage: onSubagentMessage as never } : {}),
    ...(timeline ? { timeline } : {}),
  });
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); rmSync(dataDir, { recursive: true, force: true }); });
  const prompt = (text: string, requestId: string) => session.session.prompt(text, { requestId, userId: "U1" });
  return { faux, session, channel, modelRuntime, prompt };
}

/** Pi carries the system prompt and the offered tools in the transcript's system messages. */
const systemMessages = (context: TranscriptContext) =>
  context.messages.filter((m) => m.role === "system") as unknown as { content: string; sections: Record<string, string>; toolsAdded?: { name: string }[] }[];
const toolNames = (context: TranscriptContext): string[] =>
  [...new Set(systemMessages(context).flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name)))].sort();
const systemPrompt = (context: TranscriptContext): string =>
  systemMessages(context).flatMap((m) => [m.content, ...Object.values(m.sections ?? {})]).join("\n\n");
const userText = (context: TranscriptContext): string[] =>
  context.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(""));

test("run_subagent hands a job to a role with its own context, tools, model and prompt, and returns its report", async (t) => {
  const f = await fixture(t);
  let parentFirst: TranscriptContext | undefined;
  let child: TranscriptContext | undefined;
  let childModel: string | undefined;
  let parentSecond: TranscriptContext | undefined;
  const responses: FauxResponseFactory[] = [
    (context) => { parentFirst = context; return fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "Fix the login bug in issue #7", context: "Use small commits" }, { id: "call-1" }), { stopReason: "toolUse" }); },
    (context, _options, _state, model) => { child = context; childModel = model.id; return fauxAssistantMessage("STATUS: done\nNEXT: reviewer\nOpened PR #12 for issue #7."); },
    (context) => { parentSecond = context; return fauxAssistantMessage("The coder opened PR 12."); },
  ];
  f.faux.setResponses(responses);

  await f.prompt("SECRET-PARENT-CONTEXT please fix the login bug", "r1");

  assert.equal(f.session.session.getLastAssistantText(), "The coder opened PR 12.");
  assert.equal(f.faux.state.callCount, 3);

  // The channel agent is offered the delegation tool and is told about its team.
  assert.ok(toolNames(parentFirst!).includes("run_subagent"));
  assert.match(systemPrompt(parentFirst!), /## Subagents[\s\S]*`coder`: Writes the change and opens a PR\./);

  // The subagent ran on its role's model, not the channel's.
  assert.equal(childModel, "other");
  // Its context is its own: the brief, and nothing the channel agent said or saw.
  const seen = userText(child!).join("\n");
  assert.match(seen, /# Task\n\nFix the login bug in issue #7/);
  assert.match(seen, /# Context from the assistant\n\nUse small commits/);
  assert.doesNotMatch(seen, /SECRET-PARENT-CONTEXT/);
  assert.equal(child!.messages.filter((m) => m.role === "assistant").length, 0);
  // Its tools are the role's (`read` brings PDF extraction with it), plus output saving, the clock, read-only memory and read-only channel state: no
  // delegation, no memory or state writes, no skill writing, no posting, no model switching.
  assert.deepEqual(toolNames(child!), ["extract_local_pdf", "get_current_time", "list_read", "read", "recall", "save_tool_output", "state_read", "write"]);
  // Its prompt is the role's, with the report contract.
  assert.match(systemPrompt(child!), /You are `coder`, a subagent of Test/);
  assert.match(systemPrompt(child!), /You write code\. Keep changes small\./);
  assert.match(systemPrompt(child!), /STATUS: done \| blocked \| needs_input \| failed/);
  // It is asked to narrate briefly, because what it says alongside a tool call is shown to people watching the thread.
  assert.match(systemPrompt(child!), /anything you say alongside a tool call is shown to them as a short update/);
  assert.doesNotMatch(systemPrompt(child!), /## Subagents/);

  // The channel agent got the report as the tool result, with the suggestion as advice.
  const result = parentSecond!.messages.find((m) => m.role === "toolResult");
  assert.ok(result);
  const resultText = JSON.stringify(result);
  assert.match(resultText, /Subagent `coder` finished with status done; it suggests `reviewer` acts next/);
  assert.match(resultText, /Opened PR #12 for issue #7\./);
});

test("a subagent can save its own results but cannot dispatch a parent-only tool", async (t) => {
  const f = await fixture(t, { tools: ["read"] });
  let afterDenied: TranscriptContext | undefined;
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "Export a clock reading" }, { id: "run-coder" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("save_tool_output", { tool: "state_update", arguments: {}, path: "forbidden.json" }, { id: "save-forbidden" }), { stopReason: "toolUse" }),
    (context) => {
      afterDenied = context;
      return fauxAssistantMessage(fauxToolCall("save_tool_output", { tool: "get_current_time", arguments: {}, path: "clock.json" }, { id: "save-clock" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("STATUS: done\nSaved clock.json"),
    fauxAssistantMessage("Clock saved"),
  ]);
  await f.prompt("Run the coder", "export-role");
  const denied = afterDenied!.messages.find((m) => m.role === "toolResult" && m.toolName === "save_tool_output");
  assert.ok(denied && denied.role === "toolResult" && denied.isError);
  assert.match(JSON.stringify(denied), /not available in this conversation/);
  assert.ok(!existsSync(join(f.channel.paths.workspace, "forbidden.json")));
  const clock = JSON.parse(readFileSync(join(f.channel.paths.workspace, "clock.json"), "utf8"));
  assert.equal(clock.tool, "get_current_time");
  assert.equal(clock.toolSucceeded, true);
});

test("a subagent run is its own conversation and is not listed as a Slack thread", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "do it" }, { id: "c1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("STATUS: done\nfinished"),
    fauxAssistantMessage("ok"),
  ]);
  await f.prompt("go", "r1");
  const threads = await f.session.store.listThreads();
  assert.deepEqual(threads.map((thread) => thread.threadKey), ["1.1"]);
  const inspection = await f.session.store.inspect();
  const keys = new Set<string>();
  for (const { route } of await f.session.store.liveRoutes()) keys.add(route.threadKey);
  assert.equal(keys.size, 0, "nothing is left running once the run has finished");
  assert.ok(inspection);
});

test("an unknown subagent is refused without starting a run", async (t) => {
  const f = await fixture(t);
  let after: TranscriptContext | undefined;
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "ghost", task: "do it" }, { id: "c1" }), { stopReason: "toolUse" }),
    (context) => { after = context; return fauxAssistantMessage("no such agent"); },
  ]);
  await f.prompt("go", "r1");
  assert.equal(f.faux.state.callCount, 2, "no model call for a subagent");
  assert.match(JSON.stringify(after!.messages.find((m) => m.role === "toolResult")), /There is no subagent named \\"ghost\\"/);
});

test("a channel without an agent set is not offered run_subagent", async (t) => {
  const f = await fixture(t, { agentSet: undefined });
  let first: TranscriptContext | undefined;
  f.faux.setResponses([(context) => { first = context; return fauxAssistantMessage("hi"); }]);
  await f.prompt("hello", "r1");
  assert.ok(!toolNames(first!).includes("run_subagent"));
  assert.doesNotMatch(systemPrompt(first!), /## Subagents/);
});

test("a subagent's model is on the channel's allowlist even when the channel's own list leaves it out", async (t) => {
  const f = await fixture(t, { models: ["fixture/model"] });
  const refs = allowedModelRefs(f.channel, f.modelRuntime);
  assert.ok(refs.includes("fixture/model"));
  assert.ok(refs.includes("fixture/other"));
});

test("reports are parsed leniently: a missing header is a finished job, an unknown status is not trusted", () => {
  assert.deepEqual(parseReport("coder", "k", "STATUS: blocked\nNEXT: none\nNo repo access."), {
    agent: "coder", status: "blocked", summary: "No repo access.", runKey: "k",
  });
  const withNext = parseReport("triage", "k", "STATUS: done\nNEXT: coder\nIssue 7 is ready.");
  assert.equal(withNext.next, "coder");
  assert.equal(parseReport("coder", "k", "Just some prose.").status, "done");
  assert.equal(parseReport("coder", "k", "STATUS: great\nstuff").status, "done");
  assert.match(formatReport(withNext), /suggests `coder` acts next/);
  assert.doesNotMatch(formatReport(parseReport("coder", "k", "STATUS: done\nNEXT: none\nfine")), /suggests/);
});

test("a subagent's model calls are reported so their spend can be accounted, separately from the channel's", async (t) => {
  const seen: { agent: string; runKey: string; role: string }[] = [];
  const f = await fixture(t, {}, ({ agent, runKey, message }) => seen.push({ agent, runKey, role: (message as { role: string }).role }));
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "do it" }, { id: "c1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("STATUS: done\nfinished"),
    fauxAssistantMessage("ok"),
  ]);
  await f.prompt("go", "r1");
  assert.equal(seen.length, 1, "one model call by the subagent; the channel agent's own calls are not included");
  assert.equal(seen[0]!.agent, "coder");
  assert.equal(seen[0]!.role, "assistant");
  assert.match(seen[0]!.runKey, /^sub-/);
});

test("a role that requires approval does not run until a person has approved it, then runs, then stops when the grant expires", async (t) => {
  const f = await fixture(t);
  const store = new GrantStore(f.channel.paths.root.replace(/\/channels\/[^/]+$/, ""));
  const call = (id: string) => fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "deployer", task: "deploy abc123 to staging" }, { id }), { stopReason: "toolUse" });
  let denied: TranscriptContext | undefined;
  f.faux.setResponses([
    call("c1"),
    (context) => { denied = context; return fauxAssistantMessage("I have asked for approval."); },
  ]);
  await f.prompt("deploy it", "r1");
  assert.equal(f.faux.state.callCount, 2, "no subagent model call without approval");
  const refusal = JSON.stringify(denied!.messages.find((m) => m.role === "toolResult"));
  assert.match(refusal, /only runs with a person's approval/);
  assert.match(refusal, /request_access with capability \\"subagent:deployer\\"/);

  // A person approves in Slack: the grant lands in the channel's grant file. The same session sees it at once.
  store.grant(f.channel.ref.id, { capability: subagentCapability("deployer"), grantedBy: "U9", grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  f.faux.setResponses([
    call("c2"),
    fauxAssistantMessage("STATUS: done\nDeployed abc123 to staging."),
    fauxAssistantMessage("Deployed."),
  ]);
  await f.prompt("approved, go", "r2");
  assert.equal(f.session.session.getLastAssistantText(), "Deployed.");

  // The grant expires on its own, and the role is closed again.
  store.grant(f.channel.ref.id, { capability: subagentCapability("deployer"), grantedBy: "U9", grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  let again: TranscriptContext | undefined;
  f.faux.setResponses([call("c3"), (context) => { again = context; return fauxAssistantMessage("Need approval again."); }]);
  await f.prompt("deploy again", "r3");
  assert.match(JSON.stringify(again!.messages.find((m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "c3")), /only runs with a person's approval/);
});

test("an approval-gated role is requestable without being listed in permissions.grantable, unless the channel switched it off", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.channel.requestable.filter((c) => c.startsWith("subagent:")), ["subagent:deployer"]);
  assert.deepEqual(approvalCapabilities(HarnessConfigSchema.parse({ agentSets, channels: { eng: { agentSet: "software_engineering" } } }),
    HarnessConfigSchema.parse({ agentSets, channels: { eng: { agentSet: "software_engineering" } } }).channels.eng), ["subagent:deployer"]);
  const disabled = HarnessConfigSchema.parse({ agentSets, channels: { eng: { agentSet: "software_engineering", agentOverrides: { deployer: { enabled: false } } } } });
  assert.deepEqual(approvalCapabilities(disabled, disabled.channels.eng), [], "a role the channel switched off cannot be requested");
});

test("a subagent run reuses its thread's sandbox container instead of starting one of its own", async (t) => {
  const f = await fixture(t);
  const runtimes = new ChannelRuntimes({ modelRuntime: f.modelRuntime });
  t.after(async () => { await runtimes.closeAll(); });
  let captured: { threadKey: string; sandboxThreadKey?: string } | undefined;
  const runner = createSubagentRunner({
    parent: { channel: f.channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#eng", botUserId: "UBOT" },
    runtime: { channel: f.channel, store: { registeredToolNames: () => [], setThreadProfile: () => undefined, clearThreadProfile: () => undefined, openSubagentRun: async () => { throw new Error("stop here"); } } as never, bindings: {} as never, disposers: [], jobs: { version: 0 } },
    runtimes,
    modelRuntime: f.modelRuntime,
    buildToolSet: async (opts) => {
      captured = { threadKey: opts.threadKey, ...(opts.sandboxThreadKey ? { sandboxThreadKey: opts.sandboxThreadKey } : {}) };
      return { tools: [], jail: {} as never, speaker: { id: "" }, setTaskTracker: () => undefined, dispose: async () => undefined };
    },
  });
  await assert.rejects(runner.run({ agent: "coder", task: "x", userId: "U1" }), /stop here/);
  assert.match(captured!.threadKey, /^sub-/);
  assert.equal(captured!.sandboxThreadKey, "1.1", "the run's bash uses the parent thread's container");
});

test("a role in a factory channel runs with the footer in its environment, a workflow stage's naming its run and stage; other channels get none", async (t) => {
  // This fixture starts outside a factory, even when the test worker does not.
  for (const key of ["HARNESS_AGENT_FOOTER", "HARNESS_AGENT_FOOTER_MARKER"]) {
    const inherited = process.env[key];
    t.after(() => {
      if (inherited === undefined) delete process.env[key];
      else process.env[key] = inherited;
    });
    delete process.env[key];
  }
  const envOf = async (channelConfig: object, request: { env?: Record<string, string> } = {}) => {
    const f = await fixture(t, channelConfig);
    const runtimes = new ChannelRuntimes({ modelRuntime: f.modelRuntime });
    t.after(async () => { await runtimes.closeAll(); });
    let env: Record<string, string> | undefined;
    const runner = createSubagentRunner({
      parent: { channel: f.channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#eng", botUserId: "UBOT" },
      runtime: { channel: f.channel, store: { registeredToolNames: () => [], setThreadProfile: () => undefined, clearThreadProfile: () => undefined, openSubagentRun: async () => { throw new Error("stop here"); } } as never, bindings: {} as never, disposers: [], jobs: { version: 0 } },
      runtimes,
      modelRuntime: f.modelRuntime,
      buildToolSet: async (opts) => {
        env = opts.channel.env;
        return { tools: [], jail: {} as never, speaker: { id: "" }, setTaskTracker: () => undefined, dispose: async () => undefined };
      },
    });
    await assert.rejects(runner.run({ agent: "coder", task: "x", userId: "U1", ...request }), /stop here/);
    return env!;
  };
  const factory = { factory: { name: "F", repositories: ["acme/app"] } };
  const role = await envOf(factory);
  assert.equal(role.HARNESS_AGENT_FOOTER, agentFooter({ role: "coder" }));
  assert.equal(role.HARNESS_AGENT_FOOTER_MARKER, footerMarker({ role: "coder" }));
  const stage = await envOf(factory, { env: footerEnv({ role: "coder", stage: "implement", runId: "run42" }) });
  assert.equal(stage.HARNESS_AGENT_FOOTER, agentFooter({ role: "coder", stage: "implement", runId: "run42" }));
  assert.equal(stage.HARNESS_CHANNEL_ID, "C1", "the rest of the channel's environment is carried over");
  const plain = await envOf({});
  assert.equal(plain.HARNESS_AGENT_FOOTER, undefined, "a channel that is not a factory is left as it was");
  assert.equal(plain.HARNESS_AGENT_FOOTER_MARKER, undefined);
});

test("the runner selects the role token after layering run env and withholds other role overrides", async (t) => {
  const f = await fixture(t, { factory: { name: "F", repositories: ["acme/app"] } });
  f.channel.env = Object.freeze({
    GH_TOKEN: "fixture-default", GH_TOKEN_CODER: "fixture-coder", GH_TOKEN_REVIEWER: "fixture-reviewer",
  });
  const parentEnv = JSON.stringify(f.channel.env);
  let captured: Record<string, string> | undefined;
  const runner = createSubagentRunner({
    parent: { channel: f.channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#eng", botUserId: "UBOT" },
    runtime: { channel: f.channel, store: { clearThreadProfile: () => undefined } as never } as never,
    runtimes: {} as never,
    modelRuntime: f.modelRuntime,
    buildToolSet: async (opts) => {
      captured = opts.channel.env;
      throw new Error("stop after environment capture");
    },
  });
  await assert.rejects(runner.run({
    agent: "coder", task: "x", userId: "U1",
    env: { ...footerEnv({ role: "coder", stage: "implement", runId: "run42" }), GH_TOKEN_REVIEWER: "fixture-run-reviewer" },
  }), /stop after environment capture/);
  assert.ok(captured?.GH_TOKEN === "fixture-coder", "the coder override reaches the tool builder");
  assert.ok(!Object.keys(captured!).some((key) => key.startsWith("GH_TOKEN_")), "run env cannot reintroduce role overrides");
  assert.equal(captured!.HARNESS_AGENT_FOOTER, agentFooter({ role: "coder", stage: "implement", runId: "run42" }));
  assert.ok(JSON.stringify(f.channel.env) === parentEnv, "the orchestration identity is unchanged");
});

test("a run is recorded as a branch: it forks when it starts, notes each tool call, and merges with its report", async (t) => {
  const events: TimelineInput[] = [];
  const f = await fixture(t, {}, undefined, { record: (event) => events.push(event) });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "fix #7 using token https://user:secret@example.com/x" }, { id: "c1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "/definitely/not/there" }, { id: "t1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("STATUS: done\nNEXT: reviewer\nPR #12 opened."),
    fauxAssistantMessage("ok"),
  ]);
  await f.prompt("go", "r1");

  const run = events.filter((e) => e.runKey);
  assert.deepEqual(run.map((e) => e.kind), ["run.start", "tool", "run.end"]);
  assert.ok(run.every((e) => e.actor === "coder" && /^sub-/.test(e.runKey!) && e.runKey === run[0]!.runKey));
  assert.equal(run[0]!.model, "fixture/other");
  assert.equal(run[0]!.userId, "U1");
  assert.match(run[0]!.detail!, /fix #7/);
  assert.doesNotMatch(run[0]!.detail!, /secret/, "credentials in a URL never reach the timeline");
  assert.equal(run[1]!.title, "read");
  assert.equal(run[1]!.status, "error");
  const end = run[2]!;
  assert.equal(end.status, "done");
  assert.equal(end.next, "reviewer");
  assert.equal(end.steps, 1);
  assert.equal(typeof end.durationMs, "number");
  assert.match(end.detail!, /PR #12 opened/);
});

test("a run that is cut off by its time limit closes its branch as failed, with the reason", async (t) => {
  const events: TimelineInput[] = [];
  const f = await fixture(t, {}, undefined, { record: (event) => events.push(event) });
  let toolResult: TranscriptContext | undefined;
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "slow", task: "take forever" }, { id: "c1" }), { stopReason: "toolUse" }),
    async () => { await new Promise((resolve) => setTimeout(resolve, 2500)); return fauxAssistantMessage("STATUS: done\ntoo late"); },
    (context) => { toolResult = context; return fauxAssistantMessage("it timed out"); },
  ]);
  await f.prompt("go", "r1");
  const end = events.find((e) => e.kind === "run.end")!;
  assert.equal(end.status, "failed");
  assert.match(end.detail!, /timed out/);
  assert.equal(end.actor, "slow");
  assert.match(JSON.stringify(toolResult!.messages.find((m) => m.role === "toolResult")), /timed out before it finished/);
});

test("a running subagent reports what it was handed, what it says along the way, and how it ended", async (t) => {
  const f = await fixture(t);
  const seen: SubagentProgress[] = [];
  f.session.setSubagentProgress((update) => seen.push(update));
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "Add a provider to the CLI" }, { id: "c1" }), { stopReason: "toolUse" }),
    // Commentary alongside a tool call is progress; the closing message is the report, not an update.
    fauxAssistantMessage([fauxText("Looking at how providers are registered first."), fauxToolCall("read", { path: "/nowhere" }, { id: "t1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("STATUS: done\nNEXT: reviewer\nAdded the provider."),
    fauxAssistantMessage("Done."),
  ]);
  await f.prompt("go", "r1");

  assert.deepEqual(seen.map((u) => u.kind), ["started", "update", "finished"]);
  const [started, update, finished] = seen as [Extract<SubagentProgress, { kind: "started" }>, Extract<SubagentProgress, { kind: "update" }>, Extract<SubagentProgress, { kind: "finished" }>];
  assert.equal(started.agent, "coder");
  assert.equal(started.task, "Add a provider to the CLI");
  assert.equal(update.text, "Looking at how providers are registered first.");
  assert.equal(finished.status, "done");
  assert.equal(finished.next, "reviewer");
  assert.equal(finished.steps, 1);
  assert.ok(finished.durationMs >= 0);
  assert.ok([started, update, finished].every((u) => u.runKey === started.runKey && /^sub-/.test(u.runKey)), "one run, one branch");
  assert.ok(!seen.some((u) => u.kind === "update" && /Added the provider/.test(u.text)), "the report itself is not posted as progress");
});

test("progress is only reported to the turn that is running, and a failing sink cannot fail the run", async (t) => {
  const f = await fixture(t);
  const responses = () => f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "coder", task: "do it" }, { id: "c1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("STATUS: done\nfinished"),
    fauxAssistantMessage("ok"),
  ]);
  // No one watching (a quiet scheduled run): the run is the same, and nothing is reported.
  responses();
  await f.prompt("first", "r1");
  assert.equal(f.session.session.getLastAssistantText(), "ok");

  // A sink that throws on every call.
  f.session.setSubagentProgress(() => { throw new Error("slack is down"); });
  responses();
  await f.prompt("second", "r2");
  assert.equal(f.session.session.getLastAssistantText(), "ok", "the run, and the turn, finished normally");

  // Cleared at the end of a turn, so a later turn does not report into an earlier one's thread.
  const seen: SubagentProgress[] = [];
  f.session.setSubagentProgress((u) => seen.push(u));
  f.session.setSubagentProgress(undefined);
  responses();
  await f.prompt("third", "r3");
  assert.equal(seen.length, 0);
});
