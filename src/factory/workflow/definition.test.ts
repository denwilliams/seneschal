import assert from "node:assert/strict";
import { test } from "node:test";
import { hashWorkflow, SOFTWARE_FACTORY_WORKFLOW, validateWorkflow, type Stage, type WorkflowDefinition } from "./definition.ts";

const stage = (name: string, on: Record<string, string>, extra: Partial<Stage> = {}): Stage => ({ name, kind: "agent", role: `${name}_role`, replaySafe: true, on, ...extra });
const workflow = (stages: Stage[], start = stages[0]?.name ?? ""): WorkflowDefinition => ({ name: "w", version: 1, start, stages });
const problems = (def: WorkflowDefinition) => validateWorkflow(def);

test("the software factory workflow is well formed", () => {
  assert.deepEqual(validateWorkflow(SOFTWARE_FACTORY_WORKFLOW), []);
  assert.deepEqual(SOFTWARE_FACTORY_WORKFLOW.stages.map((s) => s.name), ["triage", "implement", "review", "merge", "deploy"]);
  const byName = Object.fromEntries(SOFTWARE_FACTORY_WORKFLOW.stages.map((s) => [s.name, s]));
  // The reads-only roles may be run again by themselves after a restart; the one that writes may not.
  assert.deepEqual(["triage", "implement", "review", "merge", "deploy"].map((n) => byName[n]!.replaySafe), [true, false, true, true, false]);
  assert.equal(byName.review!.maxEntries, 3);
  assert.equal(byName.deploy!.optional, true);
  assert.equal(byName.merge!.kind, "gate");
  assert.equal(byName.merge!.role, undefined);
});

test("a small valid workflow, and the ways a definition is wrong", () => {
  assert.deepEqual(problems(workflow([stage("a", { done: "complete" })])), []);
  assert.match(problems(workflow([]))[0]!, /at least one stage/);
  assert.ok(problems(workflow([stage("A b", { done: "complete" })])).some((p) => /lower-case/.test(p)));
  assert.ok(problems(workflow([stage("a", { done: "complete" }), stage("a", { done: "complete" })])).some((p) => /used twice/.test(p)));
  assert.ok(problems(workflow([stage("complete", { done: "complete" })])).some((p) => /are ends, not stage names/.test(p)));
  assert.ok(problems(workflow([stage("a", { done: "complete" })], "nope")).some((p) => /start stage "nope"/.test(p)));
  assert.ok(problems(workflow([stage("a", { done: "b" })])).some((p) => /leads to "b", which is neither a stage nor an end/.test(p)));
  assert.ok(problems(workflow([stage("a", {})])).some((p) => /at least one arrow/.test(p)));
  assert.ok(problems(workflow([{ ...stage("a", { done: "complete" }), role: undefined }])).some((p) => /needs a role/.test(p)));
  assert.ok(problems(workflow([{ ...stage("a", { done: "complete" }), kind: "gate" }])).some((p) => /gate has no role/.test(p)));
  assert.ok(problems(workflow([stage("a", { done: "complete" }, { maxEntries: 0 })])).some((p) => /maxEntries/.test(p)));
  assert.ok(problems(workflow([stage("a", { done: "complete" }, { optional: true })])).some((p) => /needs a "skipped" arrow/.test(p)));
  assert.ok(problems(workflow([stage("a", { "Not Ok": "complete" })])).some((p) => /not a lower-case identifier/.test(p)));
});

test("every stage must be reachable, and some path must complete", () => {
  assert.ok(problems(workflow([stage("a", { done: "complete" }), stage("island", { done: "complete" })])).some((p) => /"island" can never be reached/.test(p)));
  assert.ok(problems(workflow([stage("a", { done: "reject", other: "fail" })])).some((p) => /no stage leads to "complete"/.test(p)));
});

test("a loop needs a guard: a cycle with no maxEntries stage is refused, and one with it is fine", () => {
  const loop = (guard: Partial<Stage>) => workflow([
    stage("build", { done: "check" }),
    stage("check", { ok: "complete", again: "build" }, guard),
  ]);
  assert.ok(problems(loop({})).some((p) => /in a loop with no stage that has a maxEntries guard/.test(p)));
  assert.deepEqual(problems(loop({ maxEntries: 2 })), []);
  // The merge gate's loop back to review runs through review's guard, which is why the real workflow validates.
  const noGuard = structuredClone(SOFTWARE_FACTORY_WORKFLOW);
  delete noGuard.stages.find((s) => s.name === "review")!.maxEntries;
  assert.ok(problems(noGuard).some((p) => /loop/.test(p)));
});

test("the hash is stable across key order and changes with any difference", () => {
  const reordered: WorkflowDefinition = JSON.parse(JSON.stringify(SOFTWARE_FACTORY_WORKFLOW, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  assert.equal(hashWorkflow(reordered), hashWorkflow(SOFTWARE_FACTORY_WORKFLOW));
  const changed = structuredClone(SOFTWARE_FACTORY_WORKFLOW);
  changed.stages[2]!.maxEntries = 4;
  assert.notEqual(hashWorkflow(changed), hashWorkflow(SOFTWARE_FACTORY_WORKFLOW));
  assert.match(hashWorkflow(SOFTWARE_FACTORY_WORKFLOW), /^[0-9a-f]{64}$/);
});

test("an arrow to wait_for_info is allowed on an agent stage and is not a loop the validator must guard; on a gate it is refused", () => {
  assert.deepEqual(problems(workflow([stage("triage", { needs_info: "wait_for_info", ready: "complete" })])), []);
  const onGate = workflow([stage("a", { go: "g" }), { name: "g", kind: "gate", replaySafe: true, on: { needs_info: "wait_for_info", merged: "complete" } }]);
  assert.ok(problems(onGate).some((p) => /only an agent stage can wait for information/.test(p)));
  assert.equal(SOFTWARE_FACTORY_WORKFLOW.stages[0]!.on.needs_info, "wait_for_info");
  assert.equal(SOFTWARE_FACTORY_WORKFLOW.version, 5, "the shape changed, so the version did");
  assert.equal(SOFTWARE_FACTORY_WORKFLOW.stages.find((s) => s.name === "merge")!.on.changes_requested, "implement");
});
