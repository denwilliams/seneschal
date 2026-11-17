import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSteps, type TaskWorkflow } from "../tasks/workflow.ts";
import { TaskWorkflowPresence, taskWorkflowStatus } from "./task-workflow-presence.ts";

function fixture() {
  let workflow: TaskWorkflow = { id: "workflow_1", channelId: "C1", parentThreadKey: "1700000000.000100", parentTaskId: "task", revision: 1, status: "active", index: 0,
    steps: validateSteps(["Find <@U1>", "Draft", "Verify"].map((name) => ({ name, directive: "Do it", gates: ["checked"] }))), history: [] };
  const posts: any[] = [], updates: any[] = [], permalinks: { channel: string; ts: string }[] = [];
  const timers = new Set<() => void>();
  let fail: unknown = false;
  const delays: number[] = [];
  const store = { taskWorkflow: async () => structuredClone(workflow), listTaskWorkflows: async () => [structuredClone(workflow)], setTaskWorkflowSlack: async (_id: string, ts: string, location?: "channel" | "thread") => { workflow.slack = { ts, location }; } };
  const deps = { store: () => store, schedule: (fn: () => void, ms: number) => { delays.push(ms); timers.add(fn); return () => { timers.delete(fn); }; }, slack: {
    post: async (args: unknown) => { if (fail) throw fail === true ? new Error("Slack unavailable") : fail; posts.push(args); return { ts: `1700000001.00000${posts.length}` }; },
    update: async (args: unknown) => { if (fail) throw fail === true ? new Error("Slack unavailable") : fail; updates.push(args); },
    permalink: async (args: { channel: string; ts: string }) => { permalinks.push(args); return `https://example.slack.com/archives/${args.channel}/p${args.ts.replace(".", "")}`; },
  } };
  return { deps, workflow, posts, updates, permalinks, timers, delays, setFail: (value: unknown) => { fail = value; } };
}

test("Slack task status is ordered, bounded and uses plain text, with no private DM stage names", () => {
  const f = fixture();
  const view = taskWorkflowStatus(f.workflow);
  assert.match(view.text, /active/);
  assert.match(JSON.stringify(view.blocks), /Not started/);
  assert.ok(!JSON.stringify(view.blocks).includes('"mrkdwn"'));
  assert.ok(!JSON.stringify(taskWorkflowStatus(f.workflow, true)).includes("<@U1>"));
});

for (const [status, label] of Object.entries({
  ready: "⏳ Not started / ready",
  working: "🔄 Working",
  submitted: "👀 Submitted — awaiting parent review",
  return_requested: "👀 Return requested — awaiting parent review",
  approved: "✅ Approved",
})) {
  test(`task status emoji matches ${status} in the summary and step blocks, including DMs`, () => {
    const f = fixture();
    f.workflow.steps[0]!.status = status as TaskWorkflow["steps"][number]["status"];
    const before = structuredClone(f.workflow);
    for (const direct of [false, true]) {
      const view = taskWorkflowStatus(f.workflow, direct);
      assert.ok(view.text.includes(`active — ${label}`));
      assert.deepEqual(view.blocks[0], { type: "section", text: { type: "plain_text", text: view.text } });
      assert.deepEqual(view.blocks[1], { type: "section", text: { type: "plain_text", text: `1. ${direct ? "Stage 1" : "Find <@U1>"} — ${label}` } });
      assert.ok(JSON.stringify(view.blocks[2]).includes("⏳ Not started / ready"));
    }
    assert.deepEqual(f.workflow, before, "rendering never changes execution state");
  });
}

for (const [status, label] of [["completed", "✅ completed"], ["aborted", "🛑 aborted"]] as const) {
  test(`terminal workflow status ${status} takes precedence over the last step`, () => {
    const f = fixture(); f.workflow.status = status;
    f.workflow.index = status === "completed" ? f.workflow.steps.length : 0;
    const current = Math.min(f.workflow.index, f.workflow.steps.length - 1);
    f.workflow.steps[current]!.status = "working";
    f.workflow.steps[current]!.diagnostic = { at: 1, interrupted: true, detail: "private diagnostic" };
    for (const direct of [false, true]) {
      const view = taskWorkflowStatus(f.workflow, direct);
      assert.ok(view.text.includes(`· ${label} · Last step`));
      assert.doesNotMatch(view.text, /active|Working|interrupted/);
      assert.ok(JSON.stringify(view.blocks).includes("⚠️ Working — interrupted"), "step status remains explicit rather than inheriting the terminal workflow state");
      assert.ok(!JSON.stringify(view).includes("private diagnostic"));
    }
  });
}

test("blocked and interrupted emoji use explicit metadata only for the matching step state", () => {
  const f = fixture();
  const step = f.workflow.steps[0]!;
  step.dispatchDependency = "private dependency";
  step.diagnostic = { at: 1, interrupted: true, detail: "private diagnostic" };
  for (const [status, label] of [
    ["ready", "🚧 Not started / ready — blocked on external dependency"],
    ["working", "⚠️ Working — interrupted"],
    ["submitted", "👀 Submitted — awaiting parent review"],
    ["return_requested", "👀 Return requested — awaiting parent review"],
    ["approved", "✅ Approved"],
  ] as const) {
    step.status = status;
    const before = structuredClone(f.workflow);
    for (const direct of [false, true]) {
      const view = taskWorkflowStatus(f.workflow, direct);
      assert.ok(view.text.includes(`active — ${label}`));
      assert.ok(JSON.stringify(view.blocks[1]).includes(label));
      assert.doesNotMatch(JSON.stringify(view), /private dependency|private diagnostic/);
    }
    assert.deepEqual(f.workflow, before);
  }
  step.status = "working"; step.diagnostic.interrupted = false;
  assert.ok(taskWorkflowStatus(f.workflow).text.includes("🔄 Working"), "a diagnostic alone is not proof of interruption");
});

test("one persisted channel card follows working, submission, return, rework, approval and completion; repeated changes coalesce", async () => {
  const f = fixture(); const p = new TaskWorkflowPresence(f.deps);
  const update = async () => { f.workflow.revision++; p.notify("C1", f.workflow); p.notify("C1", f.workflow); await p.flush(); };
  await update(); assert.equal(f.posts.length, 1); assert.equal(f.posts[0].threadTs, undefined);
  assert.deepEqual(f.workflow.slack, { ts: "1700000001.000001", location: "channel" });
  assert.match(f.posts[0].text, /active — ⏳ Not started \/ ready/);
  f.workflow.steps[0]!.dispatchDependency = "external dependency"; await update();
  assert.match(f.updates.at(-1).text, /active — 🚧 Not started \/ ready — blocked on external dependency/);
  delete f.workflow.steps[0]!.dispatchDependency;
  assert.ok(JSON.stringify(f.posts[0].blocks).includes("https://example.slack.com/archives/C1/p1700000000000100|Open owning task conversation"));
  assert.deepEqual(f.permalinks, [{ channel: "C1", ts: f.workflow.parentThreadKey }]);
  f.workflow.steps[0]!.status = "working"; await update();
  assert.match(f.updates.at(-1).text, /active — 🔄 Working/);
  f.workflow.steps[0]!.diagnostic = { at: 1, interrupted: true, detail: "attempt stopped" }; await update();
  assert.match(f.updates.at(-1).text, /active — ⚠️ Working — interrupted/);
  delete f.workflow.steps[0]!.diagnostic; await update();
  assert.match(f.updates.at(-1).text, /active — 🔄 Working/);
  f.workflow.steps[0]!.status = "submitted"; await update();
  assert.match(f.updates.at(-1).text, /active — 👀 Submitted — awaiting parent review/);
  f.workflow.steps[0]!.status = "approved"; f.workflow.index = 1; await update();
  assert.match(f.updates.at(-1).text, /Current step 2\/3: Draft/);
  assert.match(f.updates.at(-1).text, /active — ⏳ Not started \/ ready/);
  assert.ok(JSON.stringify(f.updates.at(-1).blocks[1]).includes("✅ Approved"));
  f.workflow.steps[1]!.status = "return_requested"; await update();
  assert.match(f.updates.at(-1).text, /active — 👀 Return requested — awaiting parent review/);
  f.workflow.steps[1]!.status = "ready"; await update();
  f.workflow.steps.forEach((s) => { s.status = "approved"; }); f.workflow.status = "completed"; f.workflow.index = 3; await update();
  assert.equal(f.posts.length, 1); assert.match(f.updates.at(-1).text, /✅ completed/);
  const count = f.updates.length; p.notify("C1", f.workflow); await p.flush(); assert.equal(f.updates.length, count);
  const restarted = new TaskWorkflowPresence(f.deps); await restarted.catchUp("C1"); await restarted.flush();
  assert.equal(f.posts.length, 1, "restart edits the persisted post rather than creating another");
  assert.ok(f.updates.every((update) => update.ts === f.workflow.slack?.ts));
});

test("Slack failures don't affect workflow state, retry is bounded, and another channel cannot announce the run", async () => {
  const f = fixture(); const p = new TaskWorkflowPresence(f.deps); f.setFail(true);
  p.notify("C2", f.workflow); await p.flush(); assert.equal(f.timers.size, 0);
  p.notify("C1", f.workflow); await p.flush();
  assert.equal(f.workflow.status, "active"); assert.equal(f.workflow.revision, 1); assert.equal(f.timers.size, 1);
  f.setFail(false); await p.flush(); assert.equal(f.posts.length, 1);
  f.workflow.status = "aborted"; p.notify("C1", f.workflow); await p.flush(); assert.match(f.updates.at(-1).text, /🛑 aborted/);
});

test("deleted posts are replaced on retry and persisted; rate limits cannot be bypassed by urgent changes", async () => {
  const f = fixture(); const p = new TaskWorkflowPresence(f.deps);
  p.notify("C1", f.workflow); await p.flush();
  f.setFail({ data: { error: "message_not_found" } }); f.workflow.revision++;
  p.notify("C1", f.workflow); await p.flush(); assert.equal(f.workflow.slack?.ts, "");
  f.setFail(false); await p.flush(); assert.equal(f.posts.length, 2); assert.ok(f.workflow.slack?.ts);
  f.setFail({ retryAfter: 60 }); f.workflow.revision++;
  p.notify("C1", f.workflow); await p.flush(); assert.equal(f.delays.at(-1), 60_000);
  f.workflow.status = "aborted"; p.notify("C1", f.workflow);
  assert.ok(f.delays.at(-1)! > 59_000, "terminal changes still respect Slack's retry-after");
  f.setFail(false); await p.flush(); assert.match(f.updates.at(-1).text, /aborted/);
});

for (const status of ["active", "completed", "aborted"] as const) {
  test("legacy threaded " + status + " cards migrate once and remain canonical after repeated restart reconciliation", async () => {
    const f = fixture();
    f.workflow.status = status;
    f.workflow.slack = { ts: "1700000000.000200" };
    const before = structuredClone(f.workflow);
    const p = new TaskWorkflowPresence(f.deps);
    await p.catchUp("C1"); await p.catchUp("C1"); await p.flush();
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0].threadTs, undefined, "the old reply-only path becomes a channel card");
    assert.equal(f.updates[0].ts, before.slack!.ts);
    assert.match(f.updates[0].text, /moved to the channel/);
    assert.deepEqual(f.workflow, { ...before, slack: { ts: "1700000001.000001", location: "channel" } });
    for (let i = 0; i < 2; i++) {
      const restarted = new TaskWorkflowPresence(f.deps);
      await restarted.catchUp("C1"); await restarted.catchUp("C1"); await restarted.flush();
    }
    assert.equal(f.posts.length, 1);
    assert.ok(f.updates.slice(1).every((update) => update.ts === f.workflow.slack!.ts));
  });
}

test("failure retiring the legacy reply does not lose the persisted canonical card", async () => {
  const f = fixture(); f.workflow.slack = { ts: "1700000000.000200", location: "thread" };
  const update = f.deps.slack.update;
  f.deps.slack.update = async (args: unknown) => {
    if ((args as { ts: string }).ts === "1700000000.000200") throw new Error("old reply gone");
    await update(args);
  };
  const p = new TaskWorkflowPresence(f.deps); await p.catchUp("C1"); await p.flush();
  const restarted = new TaskWorkflowPresence(f.deps); await restarted.catchUp("C1"); await restarted.flush();
  assert.equal(f.posts.length, 1);
  assert.equal(f.workflow.slack?.location, "channel");
  assert.equal(f.updates.at(-1).ts, f.workflow.slack!.ts);
});

test("legacy main-conversation cards are reused; new main-conversation cards are top-level", async () => {
  const f = fixture(); f.workflow.parentThreadKey = "main";
  f.workflow.slack = { ts: "1700000000.000200" };
  const p = new TaskWorkflowPresence(f.deps); await p.catchUp("C1"); await p.flush();
  assert.equal(f.posts.length, 0);
  assert.equal(f.updates[0].ts, "1700000000.000200");
  f.workflow.slack = undefined; f.workflow.revision++;
  p.notify("C1", f.workflow); await p.flush();
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].threadTs, undefined);
  assert.equal(f.permalinks.length, 0, "non-Slack conversation keys are never passed to Slack");
});

test("DM cards stay in the owning thread, redact workflow details and reuse legacy replies", async () => {
  const f = fixture(); f.workflow.channelId = "D1";
  f.workflow.steps[0]!.output = "private result"; f.workflow.steps[0]!.feedback = "private feedback";
  f.workflow.steps[0]!.directive = "private directive"; f.workflow.steps[0]!.gates = ["private gate"];
  const p = new TaskWorkflowPresence(f.deps); p.notify("D1", f.workflow, true); await p.flush();
  assert.equal(f.posts[0].channel, "D1"); assert.equal(f.posts[0].threadTs, f.workflow.parentThreadKey);
  assert.doesNotMatch(JSON.stringify(f.posts), /Find|private/);
  assert.match(JSON.stringify(f.posts), /Stage 1/);
  assert.deepEqual(f.permalinks, [{ channel: "D1", ts: f.workflow.parentThreadKey }]);
  f.workflow.slack = { ts: "1700000000.000200" };
  const restarted = new TaskWorkflowPresence(f.deps); await restarted.catchUp("D1", true); await restarted.flush();
  assert.equal(f.posts.length, 1, "no channel migration or second reply in DMs");
  assert.equal(f.updates.at(-1).ts, "1700000000.000200");
  assert.doesNotMatch(JSON.stringify(f.updates), /Find|private/);
});

test("catch-up never announces another channel's workflows or backfills untracked terminal runs", async () => {
  const f = fixture(); const p = new TaskWorkflowPresence(f.deps);
  await p.catchUp("C2"); await p.flush();
  assert.equal(f.posts.length, 0); assert.equal(f.updates.length, 0); assert.equal(f.permalinks.length, 0);
  for (const status of ["completed", "aborted"] as const) {
    f.workflow.status = status; await p.catchUp("C1"); await p.flush();
  }
  assert.equal(f.posts.length, 0);
});

test("a permalink outage does not hide the card and a later change repairs the owning-conversation link", async () => {
  const f = fixture(); const permalink = f.deps.slack.permalink;
  f.deps.slack.permalink = async () => { throw new Error("Slack permalink unavailable"); };
  const p = new TaskWorkflowPresence(f.deps); p.notify("C1", f.workflow); await p.flush();
  assert.equal(f.posts.length, 1);
  assert.ok(JSON.stringify(f.posts[0].blocks).includes("slack://channel?id=C1&message=1700000000.000100"));
  f.deps.slack.permalink = permalink;
  p.notify("C1", f.workflow); await p.flush();
  assert.equal(f.posts.length, 1); assert.ok(JSON.stringify(f.updates[0].blocks).includes("https://example.slack.com/archives/C1/"));
});
