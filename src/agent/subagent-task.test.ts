import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { HarnessConfigSchema } from "../config/schema.ts";
import { REPO_ROOT } from "../config/load.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel, type ResolvedChannel } from "../workspace/resolve.ts";
import { ChannelRuntimes, type ChannelRuntime } from "./channel-runtime.ts";
import { isSubagentRunKey } from "./durable/channel-store.ts";
import { recoverChannel, type RecoveryOutcome } from "./recovery.ts";
import { buildThreadToolSet, runtimeTemplate, type CreateThreadSessionOptions, type ThreadToolSet } from "./session.ts";
import { headlessParent, stageRun, startSubagentStage, type StageRunData } from "./subagent-task.ts";
import { ChannelTimelineLog } from "./timeline.ts";

/**
 * The software factory workflow needs a subagent to be run by a durable task, with no live turn above it. These tests pin the
 * mechanism (docs/FACTORY_WORKFLOW_DESIGN.md, "the risk to settle first") with the shipped factory roles and a scripted model.
 */

function exampleAgentSet() {
  const example = parse(readFileSync(join(REPO_ROOT, "config", "harness.example.yaml"), "utf8"));
  return example.agentSets as Record<string, unknown>;
}

function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "subagent-task-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const set = JSON.parse(JSON.stringify(exampleAgentSet())) as { software_factory: { agents: Record<string, { model?: string }> } };
  for (const agent of Object.values(set.software_factory.agents)) agent.model = "fixture/model";
  const config = HarnessConfigSchema.parse({
    agentSets: set,
    channels: { factory: { model: "fixture/model", agentSet: "software_factory", tools: ["read", "write", "edit", "ls", "find", "grep", "bash"] } },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "factory", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const toRelease: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const release of toRelease.reverse()) await release().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, faux, channel, toRelease, modelRuntime: undefined as unknown as ModelRuntime, ready: ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false }).then((runtime) => { runtime.registerNativeProvider(faux.provider); return runtime; }) };
}

/**
 * A process's worth of runtime: the channel's store is opened the way a session or startup recovery opens it (a template is
 * built to register the tool schemas), with a task host that runs subagents under a synthetic parent. `recover` is the gate.
 */
async function openProcess(f: ReturnType<typeof fixture>, t: TestContext, recovered?: (outcome: RecoveryOutcome) => void) {
  const modelRuntime = await f.ready;
  const probe = (runtimes: ChannelRuntimes): CreateThreadSessionOptions => ({
    channel: f.channel, threadKey: "channel-runtime", harnessName: "Test", slackChannelLabel: "#factory", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1",
  });
  const control = { current: () => undefined, set: async () => { throw new Error("no session"); } };
  const timeline = new ChannelTimelineLog(f.channel.paths.root);
  const runtimes: ChannelRuntimes = new ChannelRuntimes({
    modelRuntime,
    subagentHost: {
      parent: (channel: ResolvedChannel, runId: string) => headlessParent(channel, runId, { harnessName: "Test", botUserId: "UBOT", timeline }),
      buildToolSet: (runOpts) => buildThreadToolSet(runOpts, { current: () => undefined, set: async () => { throw new Error("A subagent cannot switch models."); } }),
    },
    gate: async (runtime) => {
      const outcome = await recoverChannel(runtime, {
        isEphemeral: (key) => isSubagentRunKey(key), speakerAllowed: () => true,
        bind: async () => { throw new Error("nothing here is a live conversation"); },
      });
      recovered?.(outcome);
    },
  });
  let toolSet: ThreadToolSet | undefined;
  const lease = await runtimes.acquire(f.channel, async () => {
    toolSet = await buildThreadToolSet(probe(runtimes), control);
    return runtimeTemplate(probe(runtimes), toolSet);
  });
  await toolSet?.dispose().catch(() => undefined);
  const runtime: ChannelRuntime = lease.runtime;
  lease.release();
  const closed = async () => { await runtimes.closeAll(); };
  f.toRelease.push(closed);
  t.diagnostic(`opened ${f.channel.ref.id}`);
  return { runtimes, runtime, store: runtime.store, close: closed, timeline };
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const reach = (store: Parameters<typeof stageRun>[0], runId: string, ...statuses: StageRunData["status"][]) =>
  until(async () => { const run = await stageRun(store, runId); return run && statuses.includes(run.status) ? run : undefined; }, `stage ${runId} to be ${statuses.join(" or ")}`);

const systemMessages = (context: TranscriptContext) =>
  context.messages.filter((m) => m.role === "system") as unknown as { content: string; sections: Record<string, string>; toolsAdded?: { name: string }[] }[];
const toolNames = (context: TranscriptContext) =>
  [...new Set(systemMessages(context).flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name)))].sort();
const userText = (context: TranscriptContext) =>
  context.messages.filter((m) => m.role === "user").flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))));

/** A scripted model turn that waits (until released or its request is aborted) before it answers. */
function held(reply: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const factory: FauxResponseFactory = async (_context, options) => {
    entered();
    await Promise.race([gate, new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    return fauxAssistantMessage(reply);
  };
  return { factory, release, reached };
}

test("a task runs a subagent with no live turn: its own tools, a report read back from the store, and a place on the timeline and in the tree", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f, t);
  let child: TranscriptContext | undefined;
  f.faux.setResponses([(context) => { child = context; return fauxAssistantMessage("STATUS: done\nNEXT: reviewer\nBranch fix/7, PR #12 https://github.com/acme/app/pull/12."); }]);

  const { runId } = await startSubagentStage(p.store, { agent: "coder", brief: "Implement acme/app#7", userId: "U1", replaySafe: false });
  const run = await reach(p.store, runId, "done", "failed");

  assert.deepEqual([run.status, run.reportStatus, run.reportNext, run.attempts], ["done", "done", "reviewer", 1]);
  assert.match(run.reportSummary, /PR #12/);
  assert.match(run.runKey, /^sub-/);
  assert.equal(f.faux.state.callCount, 1);

  // The role was briefed with the task and nothing else, and has its own tools: write and edit are the coder's, and nothing that
  // reaches a person or starts more work is there, with no turn to ask for it.
  assert.match(userText(child!).join("\n"), /# Task\n\nImplement acme\/app#7/);
  const tools = toolNames(child!);
  for (const wanted of ["write", "edit", "recall", "state_read"]) assert.ok(tools.includes(wanted), `the coder has ${wanted}`);
  for (const forbidden of ["run_subagent", "remember", "forget", "state_update", "save_skill", "post_message", "post_to_channel", "post_as_user", "switch_model", "transfer_to_channel", "schedule_task", "run_job", "job_decide", "upload_file", "start_factory_run", "create_factory_issue", "check_factory_run", "factory_approve", "factory_decline", "factory_more_rounds", "factory_decide", "factory_abort", "check_factory_intake", "factory_intake_release"]) {
    assert.ok(!tools.includes(forbidden), `a stage's subagent must not have ${forbidden}`);
  }
  assert.match(userText(child!).join("\n"), /^(?!.*SECRET)/s);

  // It is recorded where the console looks: the timeline (under the synthetic parent) and the conversation tree.
  const events = p.timeline.read().filter((e) => e.runKey === run.runKey);
  assert.deepEqual(events.map((e) => [e.kind, e.actor]), [["run.start", "coder"], ["run.end", "coder"]]);
  assert.equal(events[0]!.threadKey, `sub-parent-${runId}`);
  assert.equal(events[1]!.status, "done");
  assert.equal(events[1]!.next, "reviewer");
  assert.ok((await p.store.consoleRoutes()).some((route) => route.threadKey === run.runKey), "the run is a conversation in the tree");
  assert.deepEqual(await p.store.liveRoutes(), [], "and nothing is left running");
});

test("while a stage runs, only the subagent's own conversation is live: the task does not make the channel's main conversation busy", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f, t);
  const slow = held("STATUS: done\nNEXT: none\nDone.");
  f.faux.setResponses([slow.factory]);
  const { runId } = await startSubagentStage(p.store, { agent: "reviewer", brief: "Review #12", userId: "U1", replaySafe: true });
  await slow.reached;
  const run = await reach(p.store, runId, "started");
  assert.deepEqual((await p.store.liveRoutes()).map((entry) => entry.route.threadKey), [run.runKey]);
  slow.release();
  await reach(p.store, runId, "done");
});

test("a failed report fails the stage, and a role that does not exist fails it without hanging", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f, t);
  f.faux.setResponses([() => fauxAssistantMessage("STATUS: failed\nNEXT: none\nnpm test: 3 failures.")]);
  const failed = await reach(p.store, (await startSubagentStage(p.store, { agent: "coder", brief: "x", userId: "U1", replaySafe: false })).runId, "failed");
  assert.deepEqual([failed.reportStatus, failed.reportSummary], ["failed", "npm test: 3 failures."]);

  const missing = await reach(p.store, (await startSubagentStage(p.store, { agent: "nobody", brief: "x", userId: "U1", replaySafe: false })).runId, "failed");
  assert.match(missing.reason, /There is no subagent named "nobody"/);
  assert.equal(missing.reportStatus, "");
});

test("a run that exceeds its role's timeout is a failed report, not a hang", async (t) => {
  const f = fixture(t);
  const p = await openProcess(f, t);
  (f.channel.agents.find((agent) => agent.name === "reviewer") as { timeoutSeconds: number }).timeoutSeconds = 1;
  const never = held("never sent");
  f.faux.setResponses([never.factory]);
  const run = await reach(p.store, (await startSubagentStage(p.store, { agent: "reviewer", brief: "Review #12", userId: "U1", replaySafe: true })).runId, "failed");
  assert.equal(run.reportStatus, "failed");
  assert.match(run.reportSummary, /timed out/);
  never.release();
  const events = p.timeline.read().filter((e) => e.runKey === run.runKey);
  assert.equal(events.at(-1)!.status, "failed");
});

/** A store that is closed while a stage's model call is in flight, then opened again as a restarted process would. */
async function restartMidStage(f: ReturnType<typeof fixture>, t: TestContext, replaySafe: boolean, afterRestart: FauxResponseFactory[] = []) {
  const first = await openProcess(f, t);
  const cut = held("STATUS: done\nNEXT: none\nthis answer is never seen");
  f.faux.setResponses([cut.factory, ...afterRestart]);
  const { runId } = await startSubagentStage(first.store, { agent: replaySafe ? "reviewer" : "coder", brief: "Do the thing", userId: "U1", replaySafe });
  await cut.reached;
  const before = await reach(first.store, runId, "started");
  await first.close();
  cut.release();
  let outcome: RecoveryOutcome | undefined;
  const second = await openProcess(f, t, (o) => { outcome = o; });
  return { runId, before, second, outcome: () => outcome! };
}

test("a restart mid-stage: the task finds `started`, names the interrupted run, and does not repeat a role that may have acted", async (t) => {
  const f = fixture(t);
  const { runId, before, second, outcome } = await restartMidStage(f, t, false);
  const run = await reach(second.store, runId, "interrupted");
  assert.deepEqual([run.attempts, run.interruptedRunKeys], [1, [before.runKey]]);
  assert.match(run.reason, new RegExp(before.runKey));
  assert.equal(run.reportStatus, "", "no report was invented");
  assert.equal(f.faux.state.callCount, 1, "the role was not run again");
  // The gate abandoned the cut-off conversation and did not pause the channel over it.
  assert.deepEqual(outcome().blocked, []);
  assert.deepEqual(outcome().abandoned, [before.runKey]);
  assert.equal(outcome().resumed, true);
  assert.deepEqual(await second.store.liveRoutes(), []);
});

test("a restart mid-stage in a read-only role: the task runs it again under a new key and keeps the cut-off one on record", async (t) => {
  const f = fixture(t);
  const { runId, before, second } = await restartMidStage(f, t, true, [() => fauxAssistantMessage("STATUS: done\nNEXT: none\nVERDICT: APPROVED")]);
  const run = await reach(second.store, runId, "done");
  assert.equal(run.attempts, 2);
  assert.deepEqual(run.interruptedRunKeys, [before.runKey]);
  assert.notEqual(run.runKey, before.runKey);
  assert.match(run.reportSummary, /VERDICT: APPROVED/);
  assert.equal(f.faux.state.callCount, 2);
});
