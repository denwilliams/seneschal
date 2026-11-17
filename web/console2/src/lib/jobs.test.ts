import { describe, expect, it } from "vitest";
import type { JobRunView } from "@api/api-types";
import { currentPhaseIndex, inputEntries, isLongSummary, phaseMeta, progressLabel, runDurationMs, runTone, shortSummary, RUN_STATUS_LABEL, SUMMARY_CUT } from "./jobs";

const run = (over: Partial<JobRunView> = {}): JobRunView => ({
  runId: "run_1", job: "release", status: "running", startedAt: "2026-10-20T10:00:00.000Z", by: { source: "agent" },
  phases: [{ name: "plan", kind: "exec", status: "done", exit: 0 }, { name: "deploy", kind: "exec", status: "running" }, { name: "note", kind: "state", status: "pending" }],
  ...over,
});

describe("status words and tones", () => {
  it("has a word for every status, and the decision one says so plainly", () => {
    expect(Object.values(RUN_STATUS_LABEL)).toEqual(["Running", "Needs a decision", "Completed", "Failed", "Aborted"]);
  });
  it("maps each status to a tone", () => {
    expect(["running", "needs_decision", "completed", "failed", "aborted"].map((s) => runTone(s as never))).toEqual(["info", "warn", "ok", "bad", "muted"]);
  });
});

describe("currentPhaseIndex", () => {
  it("finds the phase a run is at", () => expect(currentPhaseIndex(run({ currentPhase: "deploy" }))).toBe(1));
  it("is -1 when every phase is done or the run names none", () => {
    expect(currentPhaseIndex(run({ currentPhase: undefined }))).toBe(-1);
    expect(currentPhaseIndex(run({ currentPhase: "gone" }))).toBe(-1);
  });
});

describe("progressLabel", () => {
  it("counts done and skipped as passed", () => {
    expect(progressLabel(run().phases)).toBe("1 of 3 done");
    expect(progressLabel([{ status: "done" }, { status: "skipped" }, { status: "failed" }])).toBe("2 of 3 done");
    expect(progressLabel([])).toBe("0 of 0 done");
  });
});

describe("runDurationMs", () => {
  it("is the time a finished run took", () => expect(runDurationMs(run({ endedAt: "2026-10-20T10:00:42.500Z" }))).toBe(42_500));
  it("is undefined while running or when the times are nonsense", () => {
    expect(runDurationMs(run())).toBeUndefined();
    expect(runDurationMs(run({ endedAt: "not a date" }))).toBeUndefined();
    expect(runDurationMs(run({ endedAt: "2026-10-20T09:00:00.000Z" }))).toBeUndefined();
  });
});

describe("summaries", () => {
  it("leaves a short one alone and cuts a long one with an ellipsis", () => {
    expect(isLongSummary("exit 0")).toBe(false);
    const long = "x".repeat(SUMMARY_CUT + 40);
    expect(isLongSummary(long)).toBe(true);
    expect(shortSummary(long)).toHaveLength(SUMMARY_CUT);
    expect(shortSummary(long).endsWith("…")).toBe(true);
    expect(shortSummary("exit 0")).toBe("exit 0");
  });
});

describe("phaseMeta and inputEntries", () => {
  it("shows the kind, and the exit code when there is one", () => {
    expect(phaseMeta({ kind: "exec", exit: 2 })).toBe("exec · exit 2");
    expect(phaseMeta({ kind: "state" })).toBe("state");
    expect(phaseMeta({ kind: "exec", exit: 0 })).toBe("exec · exit 0");
  });
  it("sorts inputs, and gives none when they were withheld", () => {
    expect(inputEntries({ b: "2", a: "1" })).toEqual([["a", "1"], ["b", "2"]]);
    expect(inputEntries(undefined)).toEqual([]);
  });
});
