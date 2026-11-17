import assert from "node:assert/strict";
import { test } from "node:test";
import { canApprove, finalRisk, globToRegExp, mergeDecision, resolveMergeRules, type ChecksFacts, type PrFacts, type ResolvedMergeRules } from "./merge.ts";

const HEAD = "a".repeat(40);
const pr = (extra: Partial<PrFacts> = {}): PrFacts => ({ state: "open", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: HEAD, changedFiles: ["src/a.ts"], additions: 10, deletions: 2, ...extra });
const green: ChecksFacts = { required: 2, failing: 0, pending: 0 };
const rules = (extra: Partial<ResolvedMergeRules> = {}): ResolvedMergeRules => ({ approvers: undefined, autoMergeMaxRisk: 2, method: "squash", sensitivePaths: [], largeDiffLines: 800, deployEnvironment: "staging", ...extra });
const decide = (over: { modelRisk?: number; pr?: PrFacts; checks?: ChecksFacts; rules?: ResolvedMergeRules; reviewedHead?: string } = {}) =>
  mergeDecision({ modelRisk: 2, pr: pr(), checks: green, rules: rules(), reviewedHead: HEAD, ...over });

test("the rules default to the safe side: nothing automatic, squash, staging, the channel decides who approves", () => {
  const none = resolveMergeRules(undefined, "acme/app");
  assert.deepEqual(none, { approvers: undefined, autoMergeMaxRisk: 0, method: "squash", sensitivePaths: [], largeDiffLines: 800, deployEnvironment: "staging" });
  assert.equal(decide({ rules: none }).action, "wait", "with the defaults even a trivial, green change waits for a person");
});

test("a repository's rules go over the factory's, field by field, matching its name without case", () => {
  const factory = {
    merge: { approvers: ["U1AAAA"], autoMergeMaxRisk: 3, method: "merge" as const, sensitivePaths: ["infra/**"] },
    repositoryRules: { "Acme/API": { autoMergeMaxRisk: 1, sensitivePaths: [] } },
  };
  assert.deepEqual(resolveMergeRules(factory, "acme/web"), { approvers: ["U1AAAA"], autoMergeMaxRisk: 3, method: "merge", sensitivePaths: ["infra/**"], largeDiffLines: 800, deployEnvironment: "staging" });
  const api = resolveMergeRules(factory, "acme/api");
  assert.deepEqual([api.autoMergeMaxRisk, api.method, api.approvers, api.sensitivePaths], [1, "merge", ["U1AAAA"], []]);
});

test("who may approve: the factory's list, else the channel's allowed users, else anyone who can speak there", () => {
  assert.equal(canApprove("U1", { approvers: ["U1", "U2"] }, ["U3"]), true);
  assert.equal(canApprove("U3", { approvers: ["U1", "U2"] }, ["U3"]), false, "the factory's list replaces the channel's, it does not add to it");
  assert.equal(canApprove("U3", { approvers: undefined }, ["U3"]), true);
  assert.equal(canApprove("U4", { approvers: undefined }, ["U3"]), false);
  assert.equal(canApprove("U4", { approvers: undefined }, undefined), true);
  assert.equal(canApprove("", { approvers: undefined }, undefined), false, "no user is nobody");
  assert.equal(canApprove("U1", { approvers: [] }, ["U1"]), false, "an empty list is nobody, not everybody");
});

test("globs: * within a folder, ** across, anchored, and nothing else is special", () => {
  const match = (glob: string, path: string) => globToRegExp(glob).test(path);
  assert.ok(match("infra/**", "infra/main.tf") && match("infra/**", "infra/a/b/c.tf"));
  assert.ok(!match("infra/**", "src/infra/main.tf"));
  assert.ok(match("**/migrations/**", "db/migrations/001.sql") && match("**/migrations/**", "migrations/001.sql"));
  assert.ok(match("*.md", "README.md") && !match("*.md", "docs/README.md"));
  assert.ok(match(".github/**", ".github/workflows/ci.yml"));
  assert.ok(match("src/?.ts", "src/a.ts") && !match("src/?.ts", "src/ab.ts"));
  assert.ok(match("a.b", "a.b") && !match("a.b", "aXb"), "a dot is a dot");
  assert.ok(!match("src/a", "src/a.ts"), "anchored at the end");
});

test("risk: the reviewer's score is only ever raised, by sensitive paths and by size", () => {
  const r = rules({ sensitivePaths: ["infra/**", "**/migrations/**"], largeDiffLines: 100 });
  assert.deepEqual(finalRisk(2, pr(), r), { final: 2, floors: [] });
  const sensitive = finalRisk(1, pr({ changedFiles: ["src/a.ts", "infra/x.tf", "db/migrations/1.sql"] }), r);
  assert.equal(sensitive.final, 4);
  assert.match(sensitive.floors[0]!, /touches sensitive paths \(infra\/x\.tf, db\/migrations\/1\.sql\)/);
  assert.equal(finalRisk(5, pr({ changedFiles: ["infra/x.tf"] }), r).final, 5, "a floor never lowers a score");
  const big = finalRisk(1, pr({ additions: 90, deletions: 11 }), r);
  assert.deepEqual([big.final, big.floors.length], [3, 1]);
  assert.match(big.floors[0]!, /changes 101 lines, over this repository's 100/);
  assert.equal(finalRisk(1, pr({ additions: 90, deletions: 10 }), r).final, 1, "at the limit is not over it");
  assert.equal(finalRisk(4, pr({ additions: 500 }), r).final, 4);
  assert.equal(finalRisk(1, pr({ changedFiles: Array.from({ length: 9 }, (_, i) => `infra/${i}.tf`) }), r).floors[0], "touches sensitive paths (infra/0.tf, infra/1.tf, infra/2.tf, and 6 more)");
  for (const unscored of [-1, 0, 6, 2.5, NaN]) assert.equal(finalRisk(unscored, pr(), rules()).final, 5, `${unscored} counts as unscored`);
});

test("mergeDecision: it merges by itself only when EVERY rule allows it", () => {
  assert.equal(decide().action, "auto", "risk 2 at a limit of 2, checks green, the reviewed head");
  assert.equal(decide({ modelRisk: 1 }).action, "auto");
  const auto = decide();
  assert.deepEqual(auto.action === "auto" && auto.risk, { final: 2, floors: [] });
});

test("mergeDecision: each rule on its own sends it to a person, with the reason", () => {
  const waits = (over: Parameters<typeof decide>[0], reason: RegExp) => {
    const d = decide(over);
    assert.equal(d.action, "wait", JSON.stringify(over));
    assert.ok(d.action === "wait" && d.reasons.some((r) => reason.test(r)), `${reason}: ${JSON.stringify(d)}`);
  };
  waits({ modelRisk: 3 }, /risk 3 is above this repository's automatic limit of 2/);
  waits({ modelRisk: -1 }, /risk 5 is above/);
  waits({ rules: rules({ autoMergeMaxRisk: 0 }) }, /automatic merging is off/);
  waits({ checks: { required: 0, failing: 0, pending: 0 } }, /no required checks/);
  waits({ checks: { required: 3, failing: 1, pending: 0 } }, /1 required check is failing/);
  waits({ checks: { required: 3, failing: 2, pending: 0 } }, /2 required checks are failing/);
  waits({ checks: { required: 3, failing: 0, pending: 1 } }, /1 required check is still running/);
  waits({ pr: pr({ changedFiles: ["infra/a.tf"] }), rules: rules({ sensitivePaths: ["infra/**"] }) }, /risk 4 is above/);
  waits({ pr: pr({ additions: 900 }) }, /risk 3 is above/);
  // The floors explain a score; they are listed with the reasons.
  const sensitive = decide({ pr: pr({ changedFiles: ["infra/a.tf"] }), rules: rules({ sensitivePaths: ["infra/**"] }) });
  assert.equal(sensitive.action, "wait");
  if (sensitive.action === "wait") {
    assert.ok(sensitive.reasons.some((r) => /the change touches sensitive paths/.test(r)));
    assert.equal(sensitive.risk.final, 4);
  }
  // A floor that does not push it over the limit is not a reason to wait.
  const fine = decide({ pr: pr({ additions: 900 }), rules: rules({ autoMergeMaxRisk: 3 }), modelRisk: 1 });
  assert.equal(fine.action, "auto");
  assert.deepEqual(fine.action === "auto" && fine.risk, { final: 3, floors: ["changes 902 lines, over this repository's 800"] });
});

test("mergeDecision: the pull request must still be at the commit that was reviewed", () => {
  const moved = decide({ pr: pr({ headSha: "b".repeat(40) }) });
  assert.equal(moved.action, "rereview");
  assert.match(moved.action === "rereview" ? moved.reason : "", /head is bbbbbbb, not the aaaaaaa that was reviewed/);
  assert.equal(decide({ reviewedHead: "" }).action, "rereview", "no recorded review head is no review");
  // A moved head wins over everything else, a risky change included: it goes back to review before anyone is asked.
  assert.equal(decide({ pr: pr({ headSha: "b".repeat(40) }), modelRisk: 5 }).action, "rereview");
});

test("mergeDecision: a limit of 4 is the most that can merge by itself; a 5 never does", () => {
  assert.equal(decide({ modelRisk: 4, rules: rules({ autoMergeMaxRisk: 4 }) }).action, "auto");
  assert.equal(decide({ modelRisk: 5, rules: rules({ autoMergeMaxRisk: 4 }) }).action, "wait");
  assert.equal(decide({ modelRisk: 5, rules: rules({ autoMergeMaxRisk: 99 }) }).action, "auto", "(the schema refuses a limit above 4; the function itself trusts what it is given)");
});
