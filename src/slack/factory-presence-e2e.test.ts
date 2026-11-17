import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { ChannelRuntimes } from "../agent/channel-runtime.ts";
import { isSubagentRunKey } from "../agent/durable/channel-store.ts";
import { recoverChannel } from "../agent/recovery.ts";
import { buildThreadToolSet, createThreadSession } from "../agent/session.ts";
import { headlessParent } from "../agent/subagent-task.ts";
import { ChannelTimelineLog } from "../agent/timeline.ts";
import { createFactoryRunService } from "../factory/workflow/service.ts";
import { fixture, HEAD, reply, until } from "../factory/workflow/test-support.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { decideFactoryRunClick } from "./factory-clicks.ts";
import { FactoryPresence, type PresenceChannel } from "./factory-presence.ts";
import { buttonValue } from "./factory-render.ts";
import { FakeSlack } from "./factory-test-support.ts";

/**
 * A run as the people in Slack see it, through the real engine: the status post appears when the agent starts the run, is edited as
 * the run moves, the thread hears the moments that matter, the buttons answer the merge gate, and a person who may not decide is
 * refused. Slack is a recording fake; the model is scripted by role.
 */

const systemText = (context: TranscriptContext): string =>
  (context.messages.filter((m) => m.role === "system") as unknown as { content: string; sections?: Record<string, string> }[]).flatMap((m) => [m.content, ...Object.values(m.sections ?? {})]).join("\n");
const textOf = (message: TranscriptContext["messages"][number]): string =>
  typeof message.content === "string" ? message.content : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

function router(review: string, toolResults: string[]): FauxResponseFactory {
  return (context) => {
    const role = /You are `(github_triage|coder|reviewer|cloudflare_deployer)`/.exec(systemText(context))?.[1];
    if (role) return fauxAssistantMessage(role === "github_triage" ? reply.triage() : role === "coder" ? reply.implement() : role === "reviewer" ? review : reply.deploy());
    const last = context.messages.at(-1)!;
    if (last.role === "toolResult") { toolResults.push(textOf(last)); return fauxAssistantMessage("Done."); }
    if (/work (on )?issue/i.test(textOf(last))) return fauxAssistantMessage(fauxToolCall("start_factory_run", { issue: "acme/app#7" }, { id: "t1" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("ok");
  };
}

async function start(t: TestContext, options: Parameters<typeof fixture>[1], review: string) {
  const f = fixture(t, options);
  const modelRuntime = await f.ready;
  const slack = new FakeSlack();
  const toolResults: string[] = [];
  const timeline = new ChannelTimelineLog(f.channel.paths.root);
  const channel = f.channel as unknown as ResolvedChannel & PresenceChannel;
  let runtimes: ChannelRuntimes;
  const presence = new FactoryPresence({ slack, store: (id) => runtimes.peek(id)?.store, minEditMs: 20 });
  runtimes = new ChannelRuntimes({
    modelRuntime,
    factoryGitHub: () => f.github,
    onFactoryRunChange: (c, run) => presence.notify(c as unknown as PresenceChannel, run),
    subagentHost: {
      parent: (c, runId) => headlessParent(c, runId, { harnessName: "Test", botUserId: "UBOT", timeline }),
      buildToolSet: (runOpts) => buildThreadToolSet(runOpts, { current: () => undefined, set: async () => { throw new Error("A subagent cannot switch models."); } }),
    },
    gate: async (runtime) => { await recoverChannel(runtime, { isEphemeral: (key) => isSubagentRunKey(key), speakerAllowed: () => true, bind: async () => { throw new Error("nothing here is live"); } }); },
  });
  const session = await createThreadSession({
    channel: f.channel, threadKey: "1700000000.000100", harnessName: "Test", slackChannelLabel: "#factory", botUserId: "UBOT",
    modelRuntime, runtimes, initialUserId: "U1", timeline, factoryGitHub: () => f.github,
    factoryAnnounce: (runId) => presence.ensurePost(channel, runId),
  });
  f.toRelease.push(async () => { await presence.flush(); await session.dispose(); await runtimes.closeAll(); });
  f.faux.setResponses(Array.from({ length: 60 }, () => router(review, toolResults)));
  const store = () => runtimes.peek(f.channel.ref.id)!.store;
  const ephemerals: { user: string; text: string }[] = [];
  const clickCurrent = async (button: string, user: string) => {
    const run = (await store().listFactoryRuns(1))[0]!;
    return decideFactoryRunClick({
      client: { chat: { postEphemeral: async (a: { user: string; text: string }) => { ephemerals.push({ user: a.user, text: a.text }); return {}; } } } as never,
      presence, channelFor: async () => channel,
      serviceFor: (c, who, threadTs) => createFactoryRunService({ channel: c, store: () => store(), github: () => undefined, threadKey: threadTs, currentUserId: () => who, source: "operator" }),
    }, { actions: [{ action_id: `harness_factory_${button}`, value: buttonValue(run) }], user: { id: user }, channel: { id: "C1" }, message: { ts: run.slack.ts } });
  };
  const say = (text: string, userId: string) => session.session.prompt(text, { requestId: `r-${Math.random().toString(36).slice(2)}`, userId });
  const run = (status: string[], wait?: string) => until(async () => {
    const found = (await store().listFactoryRuns(5))[0];
    return found && status.includes(found.status) && (wait === undefined || found.wait.kind === wait) ? found : undefined;
  }, `a run to be ${status.join(" or ")}${wait ? ` waiting on ${wait}` : ""}`, 20_000);
  /** Slack has drawn: the presence's own work is done. */
  const settled = async (what: string, ok: () => boolean) => { await until(async () => { await presence.flush(); return ok() ? true : undefined; }, what, 10_000); };
  return { f, slack, toolResults, say, run, settled, clickCurrent, ephemerals, presence, store, channel };
}

const hasButtons = (call: { blocks?: unknown[] }) => (call.blocks as { type: string }[] | undefined)?.some((b) => b.type === "actions") === true;
const topLevel = (e: Awaited<ReturnType<typeof start>>) => e.slack.posts().filter((p) => !p.threadTs);

test("a run from the agent's tool to a button: one status post, edited as it goes, a thread that hears what matters, and the merge decided by an approver's click", async (t) => {
  const e = await start(t, { merge: { approvers: ["UAPPROVER"], autoMergeMaxRisk: 2 } }, reply.review("APPROVED", 3));
  await e.say("please work issue 7 in acme/app", "U1");
  assert.match(e.toolResults[0]!, /Started a workflow run fr_[0-9a-f]{10}.*status post.*https:\/\/example\.slack\.com\/archives\/C1\/p1800000000000001/s, "the agent is given the link to the post");
  await e.run(["waiting"], "merge");
  await e.settled("the waiting state to be drawn", () => e.slack.replies().some((c) => /is waiting/.test(c.text ?? "")));

  assert.equal(topLevel(e).length, 1, "one status post for the run");
  const ts = (await e.store().listFactoryRuns(1))[0]!.slack.ts;
  assert.ok(e.slack.updates().length >= 1 && e.slack.updates().every((u) => u.ts === ts), "every later change was an edit of that post");
  const said = e.slack.replies().map((c) => c.text);
  assert.deepEqual(said.map((text) => text!.replace(/fr_[0-9a-f]{10}/, "RUN")), ["Workflow run RUN: triage finished", "Workflow run RUN: implement finished", "Workflow run RUN: review finished", "Workflow run RUN is waiting"], "the stages that finished, then the wait");
  assert.ok(e.slack.replies().every((c) => c.threadTs === ts), "all in the run's thread");
  assert.match(JSON.stringify(e.slack.replies().at(-1)!.blocks), /<@UAPPROVER>/, "the wait names who can answer");
  const latest = e.slack.updates().at(-1)!;
  assert.ok(hasButtons(latest), "Approve and Decline are on the post while it waits");
  assert.match(JSON.stringify(latest.blocks), /✅ triage → ✅ implement → ✅ review → 🔄 merge → ⬜ deploy/);
  assert.match(JSON.stringify(latest.blocks), /Risk[^"]*\\n3/);

  // A stranger presses Approve: refused privately, nothing decided.
  await e.clickCurrent("approve", "USTRANGER");
  assert.match(e.ephemerals.at(-1)!.text, /not one of the people who may approve/);
  assert.equal(e.f.github.merges.length, 0);
  assert.equal((await e.run(["waiting"], "merge")).status, "waiting");

  // The approver presses it: the run merges at the reviewed commit and the post says so.
  await e.clickCurrent("approve", "UAPPROVER");
  const done = await e.run(["completed"]);
  assert.deepEqual(e.f.github.merges.map((m) => m.expectedHead), [HEAD]);
  assert.equal(done.gate.by, "UAPPROVER");
  await e.settled("the end to be drawn", () => /Completed/.test(JSON.stringify(e.slack.updates().at(-1)?.blocks ?? "")) && e.slack.replies().some((c) => /completed/.test(c.text ?? "")));
  const final = e.slack.updates().at(-1)!;
  assert.match(JSON.stringify(final.blocks), /Merge: approved by <@UAPPROVER>/);
  assert.ok(!hasButtons(final), "no buttons once it is over");
  assert.equal(topLevel(e).length, 1, "still one status post");
  const keys = (await e.store().listFactoryRuns(1))[0]!.slack.events;
  assert.equal(new Set(keys).size, keys.length, "nothing said twice");
  assert.equal(e.slack.replies().length, keys.length, "and everything recorded as said was said once");
});

test("under the risk limit the run merges by itself: the post never carries a button and says the merge was automatic", async (t) => {
  const e = await start(t, { merge: { approvers: ["UAPPROVER"], autoMergeMaxRisk: 3 } }, reply.review("APPROVED", 2));
  await e.say("please work issue 7 in acme/app", "U1");
  const done = await e.run(["completed"]);
  assert.equal(done.gate.by, "auto");
  await e.settled("the end to be drawn", () => /Completed/.test(JSON.stringify(e.slack.updates().at(-1)?.blocks ?? "")));
  assert.ok(![...e.slack.posts(), ...e.slack.updates()].some(hasButtons), "no one was ever asked");
  assert.match(JSON.stringify(e.slack.updates().at(-1)!.blocks), /Merge: automatic/);
});

test("a person's reply in the run's thread reaches the agent with the run named; the thread is one the app already treats as active", async (t) => {
  const e = await start(t, { merge: { approvers: ["UAPPROVER"], autoMergeMaxRisk: 0 } }, reply.review("APPROVED", 3));
  await e.say("please work issue 7 in acme/app", "U1");
  await e.run(["waiting"], "merge");
  const ts = (await e.store().listFactoryRuns(1))[0]!.slack.ts;
  const context = (await e.presence.contextForThread(e.channel, ts))!;
  assert.match(context, /status thread of workflow run fr_/);
  assert.match(context, /"waitingOn":"merge"/);
  // In that thread the run id can be left out of a tool call: the service finds the run from the thread.
  const service = createFactoryRunService({ channel: e.channel, store: () => e.store(), github: () => undefined, threadKey: ts, currentUserId: () => "UAPPROVER" });
  assert.equal((await service.check())[0]!.slack.ts, ts);
  await service.approve();
  assert.equal((await e.run(["completed"])).gate.by, "UAPPROVER");
});
