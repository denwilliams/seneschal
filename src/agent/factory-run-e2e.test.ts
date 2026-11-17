import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { isSubagentRunKey } from "./durable/channel-store.ts";
import { recoverChannel } from "./recovery.ts";
import { buildThreadToolSet, createThreadSession } from "./session.ts";
import { headlessParent } from "./subagent-task.ts";
import { ChannelTimelineLog } from "./timeline.ts";
import { fixture, HEAD, REPO, reply, until, type Fixture } from "../factory/workflow/test-support.ts";

/**
 * The software factory through the tool layer: a person asks the channel agent to work an issue, the agent starts a workflow run
 * with its tool, the engine walks the stages with the shipped roles on a scripted model, and a person's decisions reach the run
 * through the agent's tools, checked against who is speaking. The model is scripted by ROLE, not by order, because the agent and
 * the stages run at the same time.
 */

const systemText = (context: TranscriptContext): string =>
  (context.messages.filter((m) => m.role === "system") as unknown as { content: string; sections?: Record<string, string> }[])
    .flatMap((m) => [m.content, ...Object.values(m.sections ?? {})]).join("\n");
const textOf = (message: TranscriptContext["messages"][number]): string =>
  typeof message.content === "string" ? message.content
    : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

interface Script {
  review: string;
  /** What the channel agent said about each tool result it got, in order. */
  toolResults: string[];
  roleCalls: Record<string, number>;
}

/** One model for everyone: it decides who is asking by what the conversation says, and answers as that role. */
function router(script: Script): FauxResponseFactory {
  return (context) => {
    const system = systemText(context);
    const role = /You are `(github_triage|coder|reviewer|cloudflare_deployer)`/.exec(system)?.[1];
    if (role) {
      script.roleCalls[role] = (script.roleCalls[role] ?? 0) + 1;
      return fauxAssistantMessage(role === "github_triage" ? reply.triage() : role === "coder" ? reply.implement() : role === "reviewer" ? script.review : reply.deploy());
    }
    // The channel agent. It does what the last message asks, and says what the tool answered.
    const last = context.messages.at(-1)!;
    const runId = /fr_[0-9a-f]{10}/.exec(context.messages.map(textOf).join("\n"))?.[0];
    if (last.role === "toolResult") {
      script.toolResults.push(textOf(last));
      return fauxAssistantMessage("Done.");
    }
    const ask = textOf(last);
    if (/work (on )?issue/i.test(ask)) return fauxAssistantMessage(fauxToolCall("start_factory_run", { issue: "acme/app#7" }, { id: "t1" }), { stopReason: "toolUse" });
    if (/approve/i.test(ask)) return fauxAssistantMessage(fauxToolCall("factory_approve", { runId: runId ?? "" }, { id: "t2" }), { stopReason: "toolUse" });
    if (/how is it going/i.test(ask)) return fauxAssistantMessage(fauxToolCall("check_factory_run", { runId: runId ?? "" }, { id: "t3" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("ok");
  };
}

async function lead(t: TestContext, options: Parameters<typeof fixture>[1], review: string) {
  const f: Fixture = fixture(t, options);
  const modelRuntime = await f.ready;
  const script: Script = { review, toolResults: [], roleCalls: {} };
  const timeline = new ChannelTimelineLog(f.channel.paths.root);
  const runtimes: ChannelRuntimes = new ChannelRuntimes({
    modelRuntime,
    factoryGitHub: () => f.github,
    subagentHost: {
      parent: (channel, runId) => headlessParent(channel, runId, { harnessName: "Test", botUserId: "UBOT", timeline }),
      buildToolSet: (runOpts) => buildThreadToolSet(runOpts, { current: () => undefined, set: async () => { throw new Error("A subagent cannot switch models."); } }),
    },
    gate: async (runtime) => {
      await recoverChannel(runtime, { isEphemeral: (key) => isSubagentRunKey(key), speakerAllowed: () => true, bind: async () => { throw new Error("nothing here is a live conversation"); } });
    },
  });
  const session = await createThreadSession({
    channel: f.channel, threadKey: "1700000000.000100", harnessName: "Test", slackChannelLabel: "#factory", botUserId: "UBOT",
    modelRuntime, runtimes, initialUserId: "U1", timeline, factoryGitHub: () => f.github,
  });
  f.toRelease.push(async () => { await session.dispose(); await runtimes.closeAll(); });
  f.faux.setResponses(Array.from({ length: 60 }, () => router(script)));
  const say = (text: string, userId: string) => session.session.prompt(text, { requestId: `r-${Math.random().toString(36).slice(2)}`, userId });
  const run = async (status: string[], wait?: string) => {
    const store = runtimes.peek(f.channel.ref.id)!.store;
    return until(async () => {
      const found = (await store.listFactoryRuns(5))[0];
      return found && status.includes(found.status) && (wait === undefined || found.wait.kind === wait) ? found : undefined;
    }, `a run to be ${status.join(" or ")}${wait ? ` waiting on ${wait}` : ""}`, 20_000);
  };
  const audit = () => readFileSync(join(f.channel.shared.audit, "factory-runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { f, script, session, say, run, audit };
}

test("a person asks for an issue to be worked: the run reaches the merge gate, a non-approver is refused, an approver approves, and it merges at the reviewed commit", async (t) => {
  // Risk 3 against a limit of 2: a person has to approve.
  const e = await lead(t, { merge: { approvers: ["UAPPROVER"], autoMergeMaxRisk: 2 } }, reply.review("APPROVED", 3));
  await e.say("please work issue 7 in acme/app", "U1");
  assert.match(e.script.toolResults[0]!, /Started a workflow run fr_[0-9a-f]{10} for acme\/app#7/);

  const waiting = await e.run(["waiting"], "merge");
  assert.deepEqual(waiting.stages.map((s) => [s.name, s.status]), [["triage", "success"], ["implement", "success"], ["review", "success"], ["merge", "in_progress"], ["deploy", "not_started"]]);
  assert.deepEqual([waiting.risk.model, waiting.risk.final], [3, 3]);
  assert.equal(waiting.pr.reviewedHead, HEAD);
  assert.deepEqual(waiting.by, { source: "agent", threadKey: "1700000000.000100", userId: "U1" });
  assert.deepEqual(e.script.roleCalls, { github_triage: 1, coder: 1, reviewer: 1 });
  assert.equal(e.f.github.merges.length, 0, "nothing merges by itself above the limit");

  // Asked how it is going, the agent reads the run through its tool.
  await e.say("how is it going?", "U1");
  const described = JSON.parse(e.script.toolResults.at(-1)!) as { status: string; waitingOn: string; risk: { reviewer: number } };
  assert.deepEqual([described.status, described.waitingOn, described.risk.reviewer], ["waiting", "merge", 3]);

  // Someone who is not an approver asks it to approve. The agent calls the tool; the harness refuses on who is speaking.
  await e.say("please approve it", "UINTRUDER");
  assert.match(e.script.toolResults.at(-1)!, /<@UINTRUDER> is not one of the people who may approve/);
  assert.equal(e.f.github.merges.length, 0);
  assert.equal((await e.run(["waiting"], "merge")).status, "waiting", "still waiting, and no decision was written");

  // An approver does.
  await e.say("please approve it", "UAPPROVER");
  assert.match(e.script.toolResults.at(-1)!, /Approval recorded for run fr_/);
  const done = await e.run(["completed"]);
  assert.deepEqual(e.f.github.merges, [{ repo: REPO, number: 12, method: "squash", expectedHead: HEAD }], "merged once, at the commit the reviewer looked at, with the factory's method");
  assert.deepEqual([done.gate.by, done.gate.head], ["UAPPROVER", HEAD]);
  assert.deepEqual(done.stages.map((s) => s.status), ["success", "success", "success", "success", "skipped"], "no deployer is assigned, so deploy is skipped");

  const events = e.audit().map((line) => [line.event, line.userId ?? line.by]);
  assert.deepEqual(events, [["start", "U1"], ["approve", "UAPPROVER"], ["merge", "UAPPROVER"]]);
  const merge = e.audit().at(-1)!;
  assert.deepEqual([merge.pr, merge.method, merge.head], [12, "squash", HEAD]);
  assert.deepEqual(merge.risk, { model: 3, final: 3, floors: [] });
});

test("under the factory's risk limit, with a required check green, the run merges by itself and says so in the audit", async (t) => {
  const e = await lead(t, { merge: { approvers: ["UAPPROVER"], autoMergeMaxRisk: 3 } }, reply.review("APPROVED", 2));
  await e.say("please work issue 7 in acme/app", "U1");
  const done = await e.run(["completed"]);
  assert.deepEqual([done.gate.by, done.risk.final], ["auto", 2]);
  assert.equal(e.f.github.merges.length, 1);
  assert.deepEqual(e.audit().map((line) => line.event), ["start", "auto_merge"]);
  assert.equal(e.audit().at(-1)!.by, "auto");
});

test("a repository with no required checks is never merged by the run, whatever the risk and the limit", async (t) => {
  const e = await lead(t, { merge: { approvers: ["UAPPROVER"], autoMergeMaxRisk: 4 } }, reply.review("APPROVED", 1));
  e.f.github.checks = { required: 0, failing: 0, pending: 0 };
  await e.say("please work issue 7 in acme/app", "U1");
  const waiting = await e.run(["waiting"], "merge");
  assert.match(waiting.reason, /required check/i);
  assert.equal(e.f.github.merges.length, 0);
});

test("the tools refuse an issue outside the factory and one that is already running, and the agent is told why", async (t) => {
  const e = await lead(t, { merge: { approvers: ["UAPPROVER"], autoMergeMaxRisk: 0 } }, reply.review("APPROVED", 3));
  await e.say("please work issue 7 in acme/app", "U1");
  await e.run(["waiting"], "merge");
  await e.say("please work issue 7 in acme/app", "U1");
  assert.match(e.script.toolResults.at(-1)!, /already has a live run \(fr_[0-9a-f]{10}, waiting\)/);
  assert.equal((await e.run(["waiting"], "merge")).issue, 7);
});
