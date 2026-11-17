import assert from "node:assert/strict";
import { test } from "node:test";
import type { FactoryRunData } from "../factory/workflow/docs.ts";
import { buttonsFor, buttonValue, mentionApprovers, parseButtonValue, replyEvents, stageLine, statusBlocks } from "./factory-render.ts";
import { aRun, finished } from "./factory-test-support.ts";

const NOW = 1_700_000_000_000 + 12 * 60_000;
const ctx = { now: NOW, approvers: ["U123", "W456"] as readonly string[] };
const everything = (value: unknown): string => JSON.stringify(value);
const stage = (run: FactoryRunData, name: string) => run.stages.find((s) => s.name === name)!;

/** A run in review, round 2, with triage and implement done. */
function inReview(): FactoryRunData {
  const run = aRun();
  finished(run, "triage", "READY", "Reproducible: ready to build.", { at: 1_700_000_010_000 });
  finished(run, "implement", "done", "Opened PR #12.", { at: 1_700_000_020_000 });
  stage(run, "review").status = "in_progress";
  stage(run, "review").entries = 2;
  run.pr = { number: 12, url: "https://github.com/acme/app/pull/12", reviewedHead: "", mergeCommit: "" };
  return run;
}

test("the stage line draws every stage's status and the review round", () => {
  assert.equal(stageLine(inReview().stages), "✅ triage → ✅ implement → 🔄 review (round 2) → ⬜ merge → ⬜ deploy");
  const run = inReview();
  stage(run, "deploy").status = "skipped";
  stage(run, "merge").status = "failed";
  assert.match(stageLine(run.stages), /❌ merge → ⏭️ deploy$/);
});

test("the status post: the issue, the stages, status, risk, the pull request, elapsed time and cost", () => {
  const run = inReview();
  run.risk = { model: 3, scored: true, reason: "", final: 4, floors: ["touches infra/"] };
  const { text, blocks } = statusBlocks(run, ctx);
  assert.equal((blocks[0] as { text: { text: string } }).text.text, "acme/app#7 Login fails on an empty password");
  const all = everything(blocks);
  assert.match(all, /Running \(review\)/);
  assert.match(all, /3 → 4/);
  assert.match(all, /<https:\/\/github\.com\/acme\/app\/pull\/12\|#12>/);
  assert.match(all, /12 min · \$0\.50/);
  assert.equal(text, "Workflow run fr_aaaa1111 for acme/app#7: running");
});

test("hostile issue titles and reports cannot mention, link or format: they only ever sit in plain-text fields", () => {
  const nasty = "<!channel> <!here> <@U999> <https://evil.example|click> *bold* `code` &amp; \n@everyone";
  const run = inReview();
  run.issueTitle = nasty;
  run.reason = nasty;
  run.status = "waiting";
  run.wait = { kind: "merge", since: 5 };
  finished(run, "review", "APPROVED", nasty, { at: 1_700_000_030_000 });
  const post = statusBlocks(run, ctx);
  const replies = replyEvents(run, ctx);
  for (const view of [post.blocks, ...replies.map((r) => r.blocks)]) {
    for (const block of view as { type: string; text?: { type: string; text: string }; elements?: { text?: string }[]; fields?: { text: string }[] }[]) {
      // Whatever came from outside is in a header or a plain_text block; mrkdwn holds only the harness's own words.
      const mrkdwn = [block.text?.type === "mrkdwn" ? block.text.text : "", ...(block.fields ?? []).map((f) => f.text), ...(block.elements ?? []).map((e) => e.text ?? "")].join("\n");
      assert.doesNotMatch(mrkdwn, /evil\.example|<!channel>|<!here>|<@U999>|@everyone|click/, "untrusted text reached mrkdwn");
    }
  }
  for (const reply of replies) assert.doesNotMatch(reply.text, /evil|channel|here|U999|everyone/, "nor the notification text");
  assert.doesNotMatch(post.text, /evil|channel|U999/);
  // And it is bounded.
  run.issueTitle = "x".repeat(5000);
  run.reason = "y".repeat(5000);
  const long = statusBlocks(run, ctx).blocks as { text?: { text: string } }[];
  assert.ok(long[0]!.text!.text.length <= 150);
  assert.ok(long.every((b) => (b.text?.text.length ?? 0) <= 300));
});

test("links are github.com only: anything else is text, not a link", () => {
  const run = inReview();
  run.pr.url = "https://evil.example/pull/12";
  run.issueUrl = "javascript:alert(1)";
  const all = everything(statusBlocks(run, ctx).blocks);
  assert.doesNotMatch(all, /evil\.example\/pull|javascript:/);
  assert.match(all, /#12/);
});

test("buttons: merge approval offers Request changes, deploy does not, and round limits keep their own actions", () => {
  const run = inReview();
  assert.deepEqual(buttonsFor(run), []);
  run.status = "waiting";
  run.current = "merge";
  run.wait = { kind: "merge", since: 9 };
  assert.deepEqual(buttonsFor(run), ["approve", "request_changes", "decline"]);
  run.wait = { kind: "deploy", since: 9 };
  assert.deepEqual(buttonsFor(run), ["approve", "decline"]);
  run.wait = { kind: "rounds", since: 9 };
  assert.deepEqual(buttonsFor(run), ["more_rounds", "stop"]);
  run.wait = { kind: "decide", since: 9 };
  assert.deepEqual(buttonsFor(run), []);
  run.status = "completed";
  assert.deepEqual(buttonsFor(run), []);
});

test("a button carries the run, the kind of wait and when it began: never a commit", () => {
  const run = inReview();
  run.status = "waiting";
  run.current = "merge";
  run.wait = { kind: "merge", since: 1234 };
  run.pr.reviewedHead = "a".repeat(40);
  const value = buttonValue(run);
  assert.equal(value, "fr_aaaa1111|merge|1234");
  assert.doesNotMatch(value, /aaaaaaaa/);
  assert.deepEqual(parseButtonValue(value), { runId: "fr_aaaa1111", kind: "merge", since: 1234 });
  const actions = statusBlocks(run, ctx).blocks.find((b) => b.type === "actions") as { elements: { action_id: string; value: string }[] };
  assert.deepEqual(actions.elements.map((e) => e.action_id), ["harness_factory_approve", "harness_factory_request_changes", "harness_factory_decline"]);
  for (const bad of ["", "fr_aaaa1111", "x|merge|1", "fr_aaaa1111|merge|-1", "fr_aaaa1111|merge|1|2", "fr_zz|merge|1"]) assert.equal(parseButtonValue(bad), undefined, bad);
});

test("who is named: real Slack user ids only", () => {
  assert.equal(mentionApprovers(["U123", "not an id", "<!channel>", "W456"]), "<@U123> <@W456>");
  assert.equal(mentionApprovers(undefined), "someone who may approve");
  assert.equal(mentionApprovers([]), "someone who may approve");
});

test("a decision made by a button shows who, in place of the buttons, until the run moves on", () => {
  const run = inReview();
  run.status = "waiting";
  run.wait = { kind: "merge", since: 77 };
  run.slack.decision = { kind: "approve", since: 77, by: "U123", at: 1 };
  const decided = statusBlocks(run, ctx).blocks;
  assert.ok(!decided.some((b) => b.type === "actions"));
  assert.match(everything(decided), /Approved by <@U123>/);
  run.wait = { kind: "merge", since: 99 }; // a later wait: the old decision no longer applies
  assert.ok(statusBlocks(run, ctx).blocks.some((b) => b.type === "actions"));
});

test("the gate's outcome is shown: automatic, or by whom", () => {
  const run = inReview();
  run.gate = { decided: true, by: "auto", head: "", at: 1 };
  assert.match(everything(statusBlocks(run, ctx).blocks), /Merge: automatic/);
  run.gate = { decided: true, by: "U123", head: "", at: 1 };
  assert.match(everything(statusBlocks(run, ctx).blocks), /Merge: approved by <@U123>/);
});

test("replies are the moments that matter and nothing else, oldest first", () => {
  const run = aRun();
  finished(run, "triage", "READY", "Ready.", { at: 1_700_000_010_000 });
  finished(run, "implement", "done", "Opened PR #12.", { at: 1_700_000_020_000 });
  assert.deepEqual(replyEvents(run, ctx).map((e) => e.key), ["a:triage:0:1", "a:implement:0:1"], "stages that finished; not the one in progress");
  // A reviewer asking for changes is a loop back, with its findings.
  finished(run, "review", "CHANGES_REQUESTED", "Blocker in login.ts.", { report: "VERDICT: CHANGES_REQUESTED\n- blocker: src/login.ts:44 trims the password", at: 1_700_000_030_000 });
  const events = replyEvents(run, ctx);
  assert.deepEqual(events.map((e) => e.key), ["a:triage:0:1", "a:implement:0:1", "a:review:0:1"]);
  const loop = events[2]!;
  assert.match(everything(loop.blocks), /asked for changes: back to \*implement\*/);
  assert.match(everything(loop.blocks), /src\/login\.ts:44 trims the password/);
  // Waiting names who can answer, by id.
  run.status = "waiting";
  run.wait = { kind: "merge", since: 40 };
  const waiting = replyEvents(run, ctx).at(-1)!;
  assert.equal(waiting.key, "w:merge:40");
  assert.match(everything(waiting.blocks), /<@U123> <@W456>/);
  assert.match(waiting.text, /waiting/);
  assert.doesNotMatch(waiting.text, /U123/, "the notification text itself mentions nobody");
  // Needs a decision.
  run.status = "needs_decision";
  run.wait = { kind: "decide", since: 50 };
  assert.equal(replyEvents(run, ctx).at(-1)!.key, "d:50");
  // The end.
  run.status = "completed";
  run.wait = { kind: "", since: 0 };
  run.pr = { number: 12, url: "https://github.com/acme/app/pull/12", reviewedHead: "", mergeCommit: "b".repeat(40) };
  const end = replyEvents(run, ctx).at(-1)!;
  assert.equal(end.key, "e:completed");
  assert.match(everything(end.blocks), /Pull request #12.*was merged/);
  for (const status of ["rejected", "failed", "aborted"] as const) {
    run.status = status;
    assert.equal(replyEvents(run, ctx).at(-1)!.key, `e:${status}`);
  }
});

test("merge conflicts are a return to implementation, not a successful merge; evidence stays private in DMs", () => {
  const run = aRun();
  finished(run, "merge", "conflicts", "Confirmed PR merge conflicts.", { report: "mergeable=CONFLICTING, mergeStateStatus=DIRTY; target base release at abc123", at: 1_700_000_030_000 });
  const event = replyEvents(run, ctx)[0]!;
  assert.match(everything(event.blocks), /found conflicts: return to \*implement\* for resolution/);
  assert.match(everything(event.blocks), /target base release at abc123/);
  assert.doesNotMatch(everything(event.blocks), /Merge: approved|was merged/);
  const quiet = replyEvents(run, { ...ctx, dm: true })[0]!;
  assert.match(everything(quiet.blocks), /found conflicts/);
  assert.doesNotMatch(everything(quiet.blocks), /abc123|target base release/);
});

test("a stage that had to be asked again is one reply, not two; a failed attempt is never a reply of its own", () => {
  const run = aRun();
  const triage = stage(run, "triage");
  triage.attempts.push(
    { entry: 1, role: "github_triage", runKey: "a", status: "done", verdict: "", summary: "no verdict", report: "", reask: false, startedAt: 1, endedAt: 2, durationMs: 1, costUsd: 0, steps: 1 },
    { entry: 1, role: "github_triage", runKey: "b", status: "done", verdict: "READY", summary: "ready", report: "", reask: true, startedAt: 3, endedAt: 4, durationMs: 1, costUsd: 0, steps: 1 },
  );
  assert.deepEqual(replyEvents(run, ctx).map((e) => e.key), ["a:triage:1:1"]);
  stage(run, "implement").attempts.push({ entry: 1, role: "coder", runKey: "c", status: "failed", verdict: "", summary: "timed out", report: "", reask: false, startedAt: 5, endedAt: 6, durationMs: 1, costUsd: 0, steps: 1 });
  assert.deepEqual(replyEvents(run, ctx).map((e) => e.key), ["a:triage:1:1"], "a failure is told once, by the reply about the run needing a decision, so a retry later cannot tell it again");
  stage(run, "implement").attempts.push({ entry: 2, role: "coder", runKey: "d", status: "interrupted", verdict: "", summary: "", report: "", reask: false, startedAt: 7, endedAt: 8, durationMs: 1, costUsd: 0, steps: 1 });
  assert.equal(replyEvents(run, ctx).filter((e) => e.key.startsWith("a:implement")).length, 0, "an interrupted attempt is not a finished stage");
});

test("keys are stable: the same run says the same things however often it is asked", () => {
  const run = inReview();
  assert.deepEqual(replyEvents(run, ctx), replyEvents(structuredClone(run), ctx));
});

test("a direct message shows the shape of a run, not what was said", () => {
  const run = inReview();
  run.reason = "mentions the secret plan";
  run.status = "waiting";
  run.wait = { kind: "merge", since: 3 };
  finished(run, "review", "CHANGES_REQUESTED", "secret findings in the code", { report: "secret findings in the code" });
  const dmCtx = { ...ctx, dm: true };
  const everyone = everything([statusBlocks(run, dmCtx), replyEvents(run, dmCtx)]);
  assert.doesNotMatch(everyone, /secret|Login fails/);
  assert.match(everyone, /acme\/app#7/);
});

/** A run parked on implement after two attempts, the second of which failed. */
function failedAtImplement(): FactoryRunData {
  const run = aRun();
  finished(run, "triage", "READY", "Reproducible: ready to build.", { at: 1_700_000_010_000 });
  const implement = stage(run, "implement");
  implement.status = "failed";
  implement.entries = 1;
  const attempt = (n: number, status: "failed" | "done", summary: string) => ({ entry: 1, role: "coder", runKey: `k${n}`, status, verdict: "", summary, report: "", reask: false, startedAt: n * 10, endedAt: n * 10 + 5, durationMs: 5, costUsd: 0.1, steps: 2 });
  implement.attempts.push(attempt(1, "failed", "timed out"), attempt(2, "failed", "npm test: 3 failures"));
  run.current = "implement";
  run.status = "needs_decision";
  run.wait = { kind: "failed", since: 1_700_000_050_000 };
  run.reason = 'stage "implement" failed: npm test: 3 failures';
  return run;
}

test("a failed stage: the status post says the stage failed and which attempt, and offers Retry and Abort", () => {
  const run = failedAtImplement();
  const { blocks } = statusBlocks(run, ctx);
  const all = everything(blocks);
  assert.match(all, /Stage failed: \*implement\* \(attempt 2\), needs a person/);
  assert.doesNotMatch(all, /interrupted/, "not the interrupted wording");
  assert.match(all, /npm test: 3 failures/, "the reason, in plain text");
  assert.deepEqual(buttonsFor(run), ["retry", "abort"]);
  const actions = blocks.find((block) => block.type === "actions") as { elements: { action_id: string; text: { text: string }; value: string; style?: string }[] };
  assert.deepEqual(actions.elements.map((e) => [e.action_id, e.text.text, e.style]), [["harness_factory_retry", "Retry", "primary"], ["harness_factory_abort", "Abort", "danger"]]);
  assert.deepEqual(parseButtonValue(actions.elements[0]!.value), { runId: "fr_aaaa1111", kind: "failed", since: 1_700_000_050_000 });
  assert.match(all, /Fix the cause first.*then Retry.*skip an optional stage or go back to an earlier one/);
  assert.equal(statusBlocks({ ...run, stages: run.stages.map((s) => ({ ...s })) }, ctx).text, "Workflow run fr_aaaa1111 for acme/app#7: needs decision");
});

test("a stage a restart interrupted offers the same two buttons, in its own words", () => {
  const run = failedAtImplement();
  run.wait = { kind: "decide", since: 9 };
  assert.deepEqual(buttonsFor(run), ["retry", "abort"]);
  assert.match(everything(statusBlocks(run, ctx).blocks), /Needs a decision: a stage was interrupted/);
  assert.match(everything(replyEvents(run, ctx).at(-1)!.blocks), /press Retry or Abort, or say skip/);
  run.wait = { kind: "info", since: 9 };
  assert.deepEqual(buttonsFor(run), [], "no buttons for a wait a decision does not answer");
});

test("a failed stage is ONE reply: what failed, the choices that apply, who decides; and a retry later does not tell it again", () => {
  const run = failedAtImplement();
  const replies = replyEvents(run, ctx);
  assert.deepEqual(replies.map((e) => e.key), ["a:triage:0:1", `d:1700000050000`]);
  const text = everything(replies.at(-1)!.blocks);
  assert.match(text, /❌ \*implement\* failed \(attempt 2\), and the run is waiting, not over/);
  assert.match(text, /<@U123> <@W456> can press Retry/);
  assert.match(text, /\*retry\* it, \*restart from\* `triage`, or \*abort\* the run/);
  assert.doesNotMatch(text, /\*skip\* it/, "implement cannot be skipped");
  assert.match(text, /npm test: 3 failures/);
  // The deploy can be skipped.
  const deploy = failedAtImplement();
  deploy.current = "deploy";
  assert.match(everything(replyEvents(deploy, ctx).at(-1)!.blocks), /\*retry\* it, \*skip\* it, \*restart from\*/);

  // Retried and running: the old failures are not told as replies.
  const retried = structuredClone(run);
  retried.status = "running"; retried.wait = { kind: "", since: 0 }; retried.reason = "";
  stage(retried, "implement").status = "in_progress";
  assert.deepEqual(replyEvents(retried, ctx).map((e) => e.key), ["a:triage:0:1"]);
  // Failing again is a new wait, so a new reply.
  const again = structuredClone(run);
  again.wait = { kind: "failed", since: 1_700_000_090_000 };
  assert.ok(replyEvents(again, ctx).some((e) => e.key === "d:1700000090000"));
});

test("a failed stage in a direct message shows the shape, not the reason; and hostile text stays out of mrkdwn", () => {
  const nasty = "<!channel> <@U999> <https://evil.example|click> *bold*";
  const run = failedAtImplement();
  run.reason = nasty;
  run.issueTitle = nasty;
  stage(run, "implement").attempts.at(-1)!.summary = nasty;
  const dm = everything([statusBlocks(run, { ...ctx, dm: true }), replyEvents(run, { ...ctx, dm: true })]);
  assert.doesNotMatch(dm, /channel|evil|U999|click|bold/);
  assert.match(dm, /implement\* failed/);
  for (const view of [statusBlocks(run, ctx).blocks, ...replyEvents(run, ctx).map((r) => r.blocks)]) {
    for (const block of view as { type: string; text?: { type: string; text: string }; elements?: { text?: string }[]; fields?: { text: string }[] }[]) {
      const mrkdwn = [block.text?.type === "mrkdwn" ? block.text.text : "", ...(block.fields ?? []).map((f) => f.text), ...(block.elements ?? []).map((e) => e.text ?? "")].join("\n");
      assert.doesNotMatch(mrkdwn, /evil\.example|<!channel>|<@U999>|click/, "untrusted text reached mrkdwn");
    }
  }
});
