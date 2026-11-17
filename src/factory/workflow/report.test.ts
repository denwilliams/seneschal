import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentReport } from "../../agent/subagent-tools.ts";
import { SOFTWARE_FACTORY_WORKFLOW, type Stage } from "./definition.ts";
import { parseRisk, pullRequestIn, readStageReport, UNSCORED_RISK } from "./report.ts";

const stage = (name: string) => SOFTWARE_FACTORY_WORKFLOW.stages.find((s) => s.name === name) as Stage;
const run = { repo: "acme/app", issue: 7 };
const report = (summary: string, status: SubagentReport["status"] = "done"): SubagentReport => ({ agent: "x", status, summary, runKey: "sub-1" });

test("risk: a whole number from 1 to 5, and anything else is the riskiest", () => {
  assert.deepEqual(parseRisk("RISK: 2\nRISK_REASON: small and tested"), { score: 2, reason: "small and tested", scored: true });
  assert.deepEqual(parseRisk("  risk: 5"), { score: 5, reason: "", scored: true });
  for (const bad of ["", "RISK: 0", "RISK: 6", "RISK: 2.5", "RISK: low", "RISK:", "risky"]) {
    const read = parseRisk(bad);
    assert.deepEqual([read.score, read.scored], [UNSCORED_RISK, false], JSON.stringify(bad));
  }
  assert.equal(parseRisk(`RISK: 3\nRISK_REASON: ${"x".repeat(1000)}`).reason.length, 300, "the reason is bounded");
});

test("a pull request URL only counts if it is in the run's repository", () => {
  assert.deepEqual(pullRequestIn("see https://github.com/acme/app/pull/12 now", "acme/app"), { number: 12, url: "https://github.com/acme/app/pull/12" });
  assert.deepEqual(pullRequestIn("https://github.com/ACME/App/pull/12", "acme/app")?.number, 12, "repository names compare without case");
  assert.equal(pullRequestIn("https://github.com/evil/app/pull/1", "acme/app"), undefined, "another repository's pull request is not the run's");
  assert.deepEqual(pullRequestIn("https://github.com/evil/app/pull/1 and https://github.com/acme/app/pull/3", "acme/app")?.number, 3);
  assert.equal(pullRequestIn("https://github.com/acme/app/issues/12", "acme/app"), undefined);
});

test("triage: the VERDICT line, or else what the issue's own line and the READY list say", () => {
  const verdict = (text: string) => { const r = readStageReport(stage("triage"), report(text), run); return r.kind === "verdict" ? r.verdict : r; };
  assert.equal(verdict("VERDICT: READY"), "ready");
  assert.equal(verdict("VERDICT: needs-info"), "needs_info");
  assert.equal(verdict("VERDICT: NEEDS INFO"), "needs_info");
  assert.equal(verdict("VERDICT: REJECT"), "reject");
  assert.equal(verdict("Triaged.\n#7 — ready — status:ready\nREADY: 7 (p1)"), "ready", "the existing contract still works for one issue");
  assert.equal(verdict("- #7 — needs-info — asked the author for steps"), "needs_info");
  assert.equal(verdict("- #7 — duplicate of #3"), "reject");
  assert.equal(verdict("- #7 — wontfix"), "reject");
  assert.equal(readStageReport(stage("triage"), report("READY: 17, 70"), run).kind, "unreadable");
  const none = readStageReport(stage("triage"), report("I looked at it."), run);
  assert.equal(none.kind, "unreadable");
  assert.match((none as { problem: string }).problem, /VERDICT:.*READY, NEEDS_INFO, REJECT/);
  const odd = readStageReport(stage("triage"), report("VERDICT: MAYBE"), run);
  assert.match((odd as { problem: string }).problem, /it said MAYBE/);
});

test("implement: done with the repository's pull request URL, and blocked, needs_input and failed", () => {
  const ok = readStageReport(stage("implement"), report("PR https://github.com/acme/app/pull/12. Tests pass."), run);
  assert.deepEqual(ok, { kind: "verdict", verdict: "done", pr: { number: 12, url: "https://github.com/acme/app/pull/12" } });
  const noPr = readStageReport(stage("implement"), report("Done, I think."), run);
  assert.equal(noPr.kind, "unreadable");
  assert.match((noPr as { problem: string }).problem, /URL of the pull request you opened in acme\/app/);
  assert.equal(readStageReport(stage("implement"), report("a PR in the wrong repo https://github.com/evil/app/pull/1"), run).kind, "unreadable");
  assert.deepEqual(readStageReport(stage("implement"), report("no access to the repo", "blocked"), run), { kind: "verdict", verdict: "blocked" });
  assert.deepEqual(readStageReport(stage("implement"), report("which branch?", "needs_input"), run), { kind: "verdict", verdict: "blocked" });
  assert.deepEqual(readStageReport(stage("implement"), report("npm test: 3 failures", "failed"), run), { kind: "failed", reason: "npm test: 3 failures" });
});

test("review: a verdict and a risk; an unscored approval counts as the riskiest, it is not a failure", () => {
  const approved = readStageReport(stage("review"), report("VERDICT: APPROVED\nRISK: 2\nRISK_REASON: contained"), run);
  assert.deepEqual(approved, { kind: "verdict", verdict: "approved", risk: { score: 2, reason: "contained", scored: true } });
  const changes = readStageReport(stage("review"), report("VERDICT: CHANGES_REQUESTED\n- blocker: src/login.ts:44\nRISK: 3"), run);
  assert.equal(changes.kind === "verdict" && changes.verdict, "changes_requested");
  // An approval with no score is asked for once more; asked again and still without one, it stands as the riskiest, not as a failure.
  const asked = readStageReport(stage("review"), report("VERDICT: APPROVED"), run);
  assert.equal(asked.kind, "unreadable");
  const unscored = readStageReport(stage("review"), report("VERDICT: APPROVED"), { ...run, reask: true });
  assert.deepEqual(unscored, { kind: "verdict", verdict: "approved", risk: { score: 5, reason: "", scored: false } });
  assert.equal(readStageReport(stage("review"), report("VERDICT: CHANGES_REQUESTED\n- nit: x"), run).kind, "verdict", "a score is only chased for an approval, which is what it decides");
  assert.equal(readStageReport(stage("review"), report("Looks fine to me."), run).kind, "unreadable");
  assert.equal(readStageReport(stage("review"), report("could not run the tests", "blocked"), run).kind, "failed", "review has no blocked arrow: a blocked reviewer fails the stage");
});

test("deploy: done is enough, and `blocked` fails it", () => {
  assert.deepEqual(readStageReport(stage("deploy"), report("Deployed."), run), { kind: "verdict", verdict: "done" });
  assert.equal(readStageReport(stage("deploy"), report("no token", "blocked"), run).kind, "failed");
});
