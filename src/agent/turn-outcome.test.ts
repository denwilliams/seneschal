import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTurnOutcome } from "./turn-outcome.ts";

test("a resolved prompt with an error assistant message is still a failure", () => {
  const outcome = new AgentTurnOutcome();
  outcome.observe({ role: "assistant", stopReason: "error", errorMessage: "404: Route unavailable" });
  assert.throws(() => outcome.assertCompleted(), /404: Route unavailable/);
});

test("a successful retry replaces an earlier provider error", () => {
  const outcome = new AgentTurnOutcome();
  outcome.observe({ role: "assistant", stopReason: "error", errorMessage: "503: Retry later" });
  outcome.observe({ role: "toolResult" });
  assert.throws(() => outcome.assertCompleted(), /503/);
  outcome.observe({ role: "assistant", stopReason: "stop" });
  assert.doesNotThrow(() => outcome.assertCompleted());
});

test("aborted and detail-free errors have useful fallback notices", () => {
  for (const stopReason of ["aborted", "error"]) {
    const outcome = new AgentTurnOutcome();
    outcome.observe({ role: "assistant", stopReason });
    assert.throws(() => outcome.assertCompleted(), stopReason === "aborted" ? /aborted/ : /without details/);
  }
});

test("empty successful output and a new turn do not inherit a previous failure", () => {
  const failed = new AgentTurnOutcome();
  failed.observe({ role: "assistant", stopReason: "error" });
  const next = new AgentTurnOutcome();
  assert.doesNotThrow(() => next.assertCompleted());
  next.observe({ role: "assistant", stopReason: "stop" });
  assert.doesNotThrow(() => next.assertCompleted());
});
