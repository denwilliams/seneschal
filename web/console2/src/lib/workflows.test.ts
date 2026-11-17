import { describe, expect, it } from "vitest";
import {
  attemptTitle, describeMergeRule, effectiveRisk, elapsedMs, INTAKE_STATUS_HINT, INTAKE_STATUS_LABEL, intakeCountsLine, issueRef, labelsText, pipLabel, riskLabel, riskTone, runTone, STAGE_STATUS_LABEL,
  recoveryChoices, recoveryHeadline, safeWorkItemUrl, runStatusLabel, subagentHref, updatesLabel, updateTrustLabel, verdictLabel, waitingLine,
} from "./workflows";

describe("workflow helpers", () => {
  it("renders Jira keys and permits ticket links only on the pinned Cloud site", () => {
    const workItem = { tracker: "jira" as const, site: "example.atlassian.net", key: "HAR-123", url: "https://example.atlassian.net/browse/HAR-123" };
    expect(issueRef({ repo: "acme/web", issue: 10001, workItem })).toBe("HAR-123");
    expect(issueRef({ repo: "acme/web", issue: 7 })).toBe("acme/web#7");
    expect(safeWorkItemUrl({ issueUrl: workItem.url, workItem })).toBe(workItem.url);
    for (const issueUrl of ["javascript:alert(1)", "https://evil.test/browse/HAR-123", "https://user:password@example.atlassian.net/browse/HAR-123", "http://example.atlassian.net/browse/HAR-123", "https://example.atlassian.net/browse/OTHER-1"]) expect(safeWorkItemUrl({ issueUrl, workItem })).toBeUndefined();
  });
  it("tells a run's state in words, and does not draw a rejection as an error", () => {
    expect(runTone("running")).toBe("info");
    expect(runTone("waiting")).toBe("warn");
    expect(runTone("needs_decision")).toBe("warn");
    expect(runTone("completed")).toBe("ok");
    expect(runTone("failed")).toBe("bad");
    expect(runTone("rejected")).toBe("muted");
    expect(runTone("aborted")).toBe("muted");
  });
  it("names a stage pip by stage and status so colour is never the only signal", () => {
    expect(pipLabel({ name: "review", status: "in_progress" })).toBe("review: in progress");
    expect(Object.values(STAGE_STATUS_LABEL)).toHaveLength(5);
  });
  it("says what a parked run waits for and that the console cannot act", () => {
    for (const kind of ["merge", "deploy", "rounds", "decide"] as const) expect(waitingLine(kind)).toMatch(/read-only/);
    expect(waitingLine("merge")).toMatch(/approve or decline the merge/);
    expect(waitingLine("rounds")).toMatch(/out of rounds/);
    expect(waitingLine("decide")).toMatch(/retry, skip or abort/);
  });
  it("labels risk, showing when the gate raised the score", () => {
    expect(riskLabel({ scored: false })).toBe("Not scored");
    expect(riskLabel({ scored: true, model: 3, final: 3 })).toBe("Risk 3");
    expect(riskLabel({ scored: true, model: 3, final: 4 })).toBe("Risk 3 → 4");
    expect(riskLabel({ scored: true, model: 2 })).toBe("Risk 2");
    expect(effectiveRisk({ scored: true, model: 3, final: 4 })).toBe(4);
    expect(effectiveRisk({ scored: true, model: 3 })).toBe(3);
    expect(effectiveRisk({ scored: false })).toBeUndefined();
    expect([riskTone(1), riskTone(2), riskTone(3), riskTone(4), riskTone(5), riskTone(undefined)]).toEqual(["ok", "ok", "warn", "bad", "bad", "muted"]);
  });
  it("describes the merge rule and who may approve as a count", () => {
    expect(describeMergeRule({ autoMergeMaxRisk: 0, method: "squash", approvers: { source: "channel" } })).toBe("never merges by itself, squash; anyone in the channel may approve");
    expect(describeMergeRule({ autoMergeMaxRisk: 2, method: "rebase", approvers: { source: "factory", count: 1 } })).toBe("may merge automatically at risk 2 or lower only when required checks and all other gates pass, rebase; 1 approver (set on the factory)");
    expect(describeMergeRule({ autoMergeMaxRisk: 2, method: "merge", approvers: { source: "channel", count: 3 } })).toMatch(/3 approvers \(the channel's allowed users\)/);
  });
  it("measures a run to its end, or to now while it is live", () => {
    const start = "2026-01-01T00:00:00.000Z";
    expect(elapsedMs({ startedAt: start, endedAt: "2026-01-01T00:01:00.000Z" }, Date.parse(start) + 999_999)).toBe(60_000);
    expect(elapsedMs({ startedAt: start }, Date.parse(start) + 5000)).toBe(5000);
    expect(elapsedMs({ startedAt: start }, Date.parse(start) - 5000)).toBe(0);
    expect(elapsedMs({ startedAt: "nonsense" }, 1)).toBeUndefined();
  });
  it("builds the issue reference, the sub-agent link and the attempt title", () => {
    expect(issueRef({ repo: "acme/web", issue: 7 })).toBe("acme/web#7");
    expect(subagentHref("C1", "sub-abc")).toBe("#/c/C1/t/sub-abc");
    expect(subagentHref("C 1", "sub/x")).toBe("#/c/C%201/t/sub%2Fx");
    expect(attemptTitle(1, 1)).toBe("Attempt");
    expect(attemptTitle(2, 3)).toBe("Attempt 2 of 3");
  });
});

describe("intake and updates", () => {
  it("says what a run waiting for information is waiting for, and that a trusted answer carries it on", () => {
    expect(waitingLine("info")).toMatch(/trusted|owner, member or collaborator/);
    expect(waitingLine("info")).toMatch(/stale/);
  });

  it("counts a run's updates and says how many are not trusted", () => {
    expect(updatesLabel({ trusted: 0, untrusted: 0 })).toBeUndefined();
    expect(updatesLabel({ trusted: 1, untrusted: 0 })).toBe("1 update");
    expect(updatesLabel({ trusted: 2, untrusted: 1 })).toBe("3 updates (1 not trusted)");
  });

  it("marks an untrusted update as one no role saw, in words", () => {
    expect(updateTrustLabel({ trusted: true })).toMatch(/a role saw this/);
    expect(updateTrustLabel({ trusted: false })).toMatch(/no role saw this/);
  });

  it("writes the intake counts in the order people act on them, leaving out zeroes", () => {
    expect(intakeCountsLine({ open: 6, held: 2, queued: 1, closed: 12, ignored: 0 })).toBe("2 held · 1 queued · 6 mapped · 12 closed");
    expect(intakeCountsLine({})).toBe("nothing mapped yet");
  });

  it("explains every intake state", () => {
    for (const status of ["open", "queued", "held", "ignored", "closed"] as const) {
      expect(INTAKE_STATUS_LABEL[status].length).toBeGreaterThan(0);
      expect(INTAKE_STATUS_HINT[status].length).toBeGreaterThan(0);
    }
    expect(INTAKE_STATUS_HINT.held).toMatch(/go label/);
  });
});

describe("the factory's labels, in words", () => {
  const at = "2026-01-01T00:00:00.000Z";
  it("says all there, what was created, or why it could not be checked", () => {
    expect(labelsText({ status: "ok", checkedAt: at, created: [] })).toBe("Labels: all there.");
    expect(labelsText({ status: "created", checkedAt: at, created: ["status:triage", "factory:go"] })).toBe("Labels: created status:triage, factory:go.");
    expect(labelsText({ status: "failed", checkedAt: at, created: [], error: "HTTP 403: Resource not accessible" })).toBe("Labels could not be checked: HTTP 403: Resource not accessible.");
    expect(labelsText({ status: "failed", checkedAt: at, created: [] })).toBe("Labels could not be checked.");
  });
});

describe("a failed stage", () => {
  const parked = { stage: "implement", attempt: 2, ended: false, answers: ["retry", "restart_from", "abort"] as const, restartFrom: ["triage"] };
  it("is a run that needs a person, in its own words, and not an ended one", () => {
    expect(runStatusLabel({ status: "needs_decision", waiting: { kind: "failed" } })).toBe("Stage failed");
    expect(runStatusLabel({ status: "needs_decision", waiting: { kind: "decide" } })).toBe("Needs a decision");
    expect(runStatusLabel({ status: "failed" })).toBe("Failed");
    expect(runStatusLabel({ kind: "task", status: "running" })).toBe("Active — see activity");
    expect(runStatusLabel({ status: "waiting", waiting: { kind: "merge" } })).toBe("Waiting for a person");
    expect(waitingLine("failed")).toMatch(/waiting, not over/);
    expect(waitingLine("failed")).toMatch(/keeps its pull request, risk and history/);
    expect(waitingLine("failed")).toMatch(/read-only/);
  });
  it("names the stage and the attempt, and says when the run has ended", () => {
    expect(recoveryHeadline(parked)).toBe("implement failed · attempt 2");
    expect(recoveryHeadline({ stage: "review", attempt: 1, ended: true })).toBe("review failed · attempt 1 · run ended");
  });
  it("lists only the answers that apply, with what each does", () => {
    const choices = recoveryChoices({ ...parked, answers: [...parked.answers] });
    expect(choices.map((c) => c.answer)).toEqual(["retry", "restart_from", "abort"]);
    expect(choices[0]!.text).toMatch(/implement again as attempt 3.*Nothing the run knows is cleared/);
    expect(choices[1]!.text).toMatch(/Goes back to triage/);
    const ended = recoveryChoices({ stage: "review", attempt: 1, ended: true, answers: ["retry"], restartFrom: [] });
    expect(ended).toHaveLength(1);
    expect(ended[0]!.text).toMatch(/Carries the run on from review, as attempt 2, on the same record/);
    expect(recoveryChoices({ stage: "deploy", attempt: 1, ended: false, answers: ["retry", "skip", "abort"], restartFrom: [] }).map((c) => c.label)).toEqual(["Retry", "Skip", "Abort"]);
  });
});

describe("waitingLine with console actions on", () => {
  it("does not promise decision buttons when only Abort is available", () => {
    expect(waitingLine("merge", ["abort"])).toMatch(/require Slack approver verification/);
    expect(waitingLine("merge", ["abort"])).not.toMatch(/Use Approve merge/);
    expect(waitingLine("merge", ["approve", "decline", "abort"])).toMatch(/Use Approve merge or Decline merge below/);
    expect(waitingLine("deploy", ["abort"])).toMatch(/in Slack, not in this console/);
  });
  it("distinguishes review approval from merge authorization", () => {
    expect(verdictLabel({ name: "review", role: "reviewer" }, "approved")).toBe("Review approved");
    expect(verdictLabel({ name: "merge" }, "merged")).toBe("merged");
    expect(waitingLine("merge", ["approve", "decline"])).toMatch(/Review approval is not merge authorization/);
  });
});
