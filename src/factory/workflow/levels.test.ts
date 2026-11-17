import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FACTORY } from "../../config/edit-policy.ts";
import { FactorySchema, HarnessConfigSchema } from "../../config/schema.ts";
import {
  AUTONOMY_LEVELS, AUTONOMY_PRESETS, autonomyWarnings, DEFAULT_AUTONOMY, describeAutonomy, effectiveAutonomy,
} from "./autonomy.ts";
import { SOFTWARE_FACTORY_WORKFLOW } from "./definition.ts";
import { mergeDecision, resolveMergeRules, type PrFacts } from "./merge.ts";
import { channelWorkflow } from "./service.ts";
import { briefOf, fixture, openProcess, reach, REPO, reply, respond, stageOf, startRun } from "./test-support.ts";
import { factoryAuditFile } from "./service.ts";
import { statusBlocks } from "../../slack/factory-render.ts";
import { emptyFactoryRun } from "./docs.ts";

/** Autonomy levels: one word that sets a coherent risk appetite (docs/FACTORY_WORKFLOW_DESIGN.md section 24). */

const OTHER = "acme/api";
const parseFactory = (extra: Record<string, unknown>) => FactorySchema.safeParse({ name: "F", repositories: [REPO, OTHER], ...extra });
const factoryOf = (extra: Record<string, unknown>) => {
  const parsed = parseFactory(extra);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  return parsed.data;
};
const knobs = (extra: Record<string, unknown>, repo = REPO) => {
  const e = effectiveAutonomy(factoryOf(extra), repo);
  return [e.level, e.knobs.autoMergeMaxRisk.value, e.knobs.assumeAfterHours.value, e.knobs.reviewRounds.value, e.knobs.autoRetries.value];
};

// ── the setting ──────────────────────────────────────────────────────────────────────────────────────────────

test("autonomy is one of three levels; anything else, or a level where a merge rule belongs, is refused", () => {
  for (const level of AUTONOMY_LEVELS) assert.ok(parseFactory({ autonomy: level }).success, level);
  assert.equal(parseFactory({ autonomy: "reckless" }).success, false);
  assert.equal(parseFactory({ autonomy: "" }).success, false);
  assert.equal(parseFactory({ merge: { autonomy: "autonomous" } }).success, false, "a level is not a merge rule");
  assert.ok(parseFactory({ repositoryRules: { [OTHER]: { autonomy: "cautious" } } }).success);
  assert.equal(parseFactory({ repositoryRules: { [OTHER]: { autonomy: "yolo" } } }).success, false);
  assert.equal(parseFactory({ repositoryRules: { [OTHER]: { autonomy: "cautious", typo: 1 } } }).success, false, "unknown keys are still refused");
  assert.equal(parseFactory({ autoRetries: 4 }).success, false);
  assert.equal(parseFactory({ autoRetries: -1 }).success, false);
  assert.equal(parseFactory({ autoRetries: 1.5 }).success, false);
  assert.ok(parseFactory({ autoRetries: 3 }).success);
});

test("a factory with no level behaves as it did before levels existed", () => {
  assert.equal(DEFAULT_AUTONOMY, "cautious");
  assert.deepEqual(knobs({}), ["cautious", 0, 0, 3, 0], "nothing merges by itself, triage waits, three rounds, no automatic retry");
  assert.equal(resolveMergeRules(undefined, REPO).autoMergeMaxRisk, 0);
  assert.equal(effectiveAutonomy(undefined, REPO).levelFrom, "default");
});

// ── resolution ───────────────────────────────────────────────────────────────────────────────────────────────

test("each level sets its numbers", () => {
  assert.deepEqual(knobs({ autonomy: "cautious" }), ["cautious", 0, 0, 3, 0]);
  assert.deepEqual(knobs({ autonomy: "balanced" }), ["balanced", 2, 24, 4, 0]);
  assert.deepEqual(knobs({ autonomy: "autonomous" }), ["autonomous", 3, 4, 5, 1]);
  assert.deepEqual(AUTONOMY_PRESETS.cautious, { autoMergeMaxRisk: 0, assumeAfterHours: 0, reviewRounds: 3, autoRetries: 0 });
});

test("explicit settings beat the level, in whichever layer they are", () => {
  assert.deepEqual(knobs({ autonomy: "autonomous", merge: { autoMergeMaxRisk: 1 } }), ["autonomous", 1, 4, 5, 1]);
  assert.deepEqual(knobs({ autonomy: "autonomous", reviewRounds: 2 }), ["autonomous", 3, 4, 2, 1]);
  assert.deepEqual(knobs({ autonomy: "autonomous", intake: { enabled: true, assumeAfterHours: 0 } }), ["autonomous", 3, 0, 5, 1], "0 is a setting too: never assume");
  assert.deepEqual(knobs({ autonomy: "autonomous", autoRetries: 0 }), ["autonomous", 3, 4, 5, 0]);
  assert.deepEqual(knobs({ autonomy: "cautious", merge: { autoMergeMaxRisk: 2 } }), ["cautious", 2, 0, 3, 0]);
  const e = effectiveAutonomy(factoryOf({ autonomy: "balanced", reviewRounds: 6 }), REPO);
  assert.deepEqual([e.knobs.reviewRounds.source, e.knobs.autoMergeMaxRisk.source], ["explicit", "level"]);
});

test("a repository's own level and its own merge number beat the factory's", () => {
  const rules = { [OTHER]: { autonomy: "cautious" } };
  assert.deepEqual(knobs({ autonomy: "autonomous", repositoryRules: rules }, OTHER), ["cautious", 0, 0, 3, 0]);
  assert.deepEqual(knobs({ autonomy: "autonomous", repositoryRules: rules }, REPO), ["autonomous", 3, 4, 5, 1], "other repositories keep the factory's");
  assert.deepEqual(knobs({ autonomy: "cautious", repositoryRules: { [OTHER]: { autonomy: "autonomous" } } }, OTHER), ["autonomous", 3, 4, 5, 1]);
  assert.deepEqual(knobs({ autonomy: "autonomous", repositoryRules: { [OTHER]: { autoMergeMaxRisk: 1 } } }, OTHER), ["autonomous", 1, 4, 5, 1], "a repository's own number");
  assert.deepEqual(knobs({ autonomy: "cautious", repositoryRules: { [OTHER]: { autonomy: "balanced", autoMergeMaxRisk: 4 } } }, OTHER), ["balanced", 4, 24, 4, 0]);
  assert.equal(effectiveAutonomy(factoryOf({ autonomy: "balanced", repositoryRules: { [OTHER]: { autonomy: "cautious" } } }), OTHER).levelFrom, "repository");
  assert.equal(effectiveAutonomy(factoryOf({ autonomy: "balanced" }), OTHER).levelFrom, "factory");
  assert.equal(effectiveAutonomy(factoryOf({ autonomy: "balanced", repositoryRules: { [OTHER.toUpperCase()]: { autonomy: "cautious" } } }), OTHER).level, "cautious", "repository names match without case");
});

test("the merge rules a repository gets are the level's, with the explicit number winning", () => {
  assert.equal(resolveMergeRules(factoryOf({ autonomy: "balanced" }), REPO).autoMergeMaxRisk, 2);
  assert.equal(resolveMergeRules(factoryOf({ autonomy: "autonomous" }), REPO).autoMergeMaxRisk, 3);
  assert.equal(resolveMergeRules(factoryOf({ autonomy: "autonomous", merge: { autoMergeMaxRisk: 1 } }), REPO).autoMergeMaxRisk, 1);
  assert.equal(resolveMergeRules(factoryOf({ autonomy: "autonomous", repositoryRules: { [OTHER]: { autonomy: "cautious" } } }), OTHER).autoMergeMaxRisk, 0);
  assert.equal(resolveMergeRules(factoryOf({ autonomy: "autonomous", merge: { approvers: ["U123"] } }), REPO).approvers?.[0], "U123", "a level does not touch who approves");
});

test("the review rounds a run is started with are its repository's", () => {
  const rounds = (extra: Record<string, unknown>, repo: string) => channelWorkflow({ factory: factoryOf(extra) }, repo).stages.find((s) => s.name === "review")!.maxEntries;
  assert.equal(rounds({}, REPO), 3);
  assert.equal(rounds({ autonomy: "balanced" }, REPO), 4);
  assert.equal(rounds({ autonomy: "autonomous", repositoryRules: { [OTHER]: { autonomy: "cautious" } } }, OTHER), 3);
  assert.equal(rounds({ autonomy: "autonomous", reviewRounds: 2 }, REPO), 2);
});

// ── what no level can change ─────────────────────────────────────────────────────────────────────────────────

const pr = (overrides: Partial<PrFacts> = {}): PrFacts => ({ state: "open", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: "abc1234", changedFiles: ["src/a.ts"], additions: 10, deletions: 2, ...overrides });
const decide = (level: (typeof AUTONOMY_LEVELS)[number], input: { risk?: number; pr?: PrFacts; checks?: { required: number; failing: number; pending: number }; head?: string; sensitivePaths?: string[] }) =>
  mergeDecision({
    modelRisk: input.risk ?? 1, pr: input.pr ?? pr(), checks: input.checks ?? { required: 1, failing: 0, pending: 0 }, reviewedHead: input.head ?? "abc1234",
    rules: resolveMergeRules(factoryOf({ autonomy: level, ...(input.sensitivePaths ? { merge: { sensitivePaths: input.sensitivePaths } } : {}) }), REPO),
  });

test("no level lets a pull request merge without a green required check, or one that changed since the review", () => {
  for (const level of AUTONOMY_LEVELS) {
    assert.equal(decide(level, { checks: { required: 0, failing: 0, pending: 0 } }).action, "wait", `${level}: no required checks`);
    assert.equal(decide(level, { checks: { required: 2, failing: 1, pending: 0 } }).action, "wait", `${level}: a failing check`);
    assert.equal(decide(level, { checks: { required: 2, failing: 0, pending: 1 } }).action, "wait", `${level}: a running check`);
    assert.equal(decide(level, { head: "def5678" }).action, "rereview", `${level}: the head moved`);
    assert.equal(decide(level, { head: "" }).action, "rereview", `${level}: no recorded review`);
    assert.equal(decide(level, { risk: Number.NaN }).action, "wait", `${level}: a missing score is the highest risk`);
    assert.equal(decide(level, { risk: 5 }).action, "wait", `${level}: risk 5 is never automatic`);
  }
});

test("sensitive paths and big diffs still raise the score at every level", () => {
  const touching = pr({ changedFiles: ["infra/db.tf"] });
  const big = pr({ additions: 700, deletions: 400 });
  for (const level of AUTONOMY_LEVELS) {
    const sensitive = decide(level, { risk: 1, pr: touching, sensitivePaths: ["infra/**"] });
    assert.equal(sensitive.action, "wait", `${level}: sensitive path`);
    assert.ok(sensitive.action === "wait" && sensitive.risk.final >= 4);
    const large = decide(level, { risk: 1, pr: big });
    assert.ok((large.action === "auto" || large.action === "wait") && large.risk.final >= 3, `${level}: a big diff is at least risk 3`);
  }
  assert.equal(decide("autonomous", { risk: 3 }).action, "auto");
  assert.equal(decide("autonomous", { risk: 4 }).action, "wait", "autonomous stops at 3");
  assert.equal(decide("balanced", { risk: 3 }).action, "wait");
  assert.equal(decide("balanced", { risk: 2 }).action, "auto");
  assert.equal(decide("cautious", { risk: 1 }).action, "wait", "cautious never merges by itself");
});

test("no preset reaches the ceiling the schema allows, and the gates have no setting a level could move", () => {
  for (const level of AUTONOMY_LEVELS) assert.ok(AUTONOMY_PRESETS[level].autoMergeMaxRisk <= 3);
  const merge = Object.keys(FactorySchema.shape.merge.unwrap().shape);
  for (const key of ["requiredChecks", "allowWithoutChecks", "matchHead", "trustedAuthors"]) assert.ok(!merge.includes(key), `${key} is not a setting`);
});

test("the admin agent's config tools cannot set a level or the automatic retries", () => {
  for (const key of ["autonomy", "autoRetries", "reviewRounds", "merge", "repositoryRules", "intake"]) {
    const rule = FACTORY[key];
    assert.ok(rule && typeof rule === "object" && "deny" in rule, `${key} is operator-only`);
  }
  const schemaKeys = Object.keys(FactorySchema.shape);
  assert.deepEqual(schemaKeys.filter((k) => !(k in FACTORY)), [], "every factory setting has a rule");
});

// ── what people see ──────────────────────────────────────────────────────────────────────────────────────────

test("the level is told in one line, the same words everywhere", () => {
  const line = (extra: Record<string, unknown>) => describeAutonomy(effectiveAutonomy(factoryOf(extra), REPO));
  assert.equal(line({}), "cautious · a person merges · asks and waits · 3 review rounds");
  assert.equal(line({ autonomy: "balanced" }), "balanced · auto-merge at risk ≤2 · assumes after 24h · 4 review rounds");
  assert.equal(line({ autonomy: "autonomous" }), "autonomous · auto-merge at risk ≤3 · assumes after 4h · 5 review rounds · retries a failed stage 1×");
});

test("the status post says what the factory may do without a person", () => {
  const run = { ...emptyFactoryRun("fr_aaaa1111"), repo: REPO, issue: 7, issueTitle: "t", issueUrl: "https://github.com/acme/app/issues/7" };
  const view = statusBlocks(run, { now: 1, approvers: undefined, autonomy: "balanced · auto-merge at risk ≤2" });
  assert.match(JSON.stringify(view.blocks), /Autonomy: balanced · auto-merge at risk ≤2/);
  assert.ok(!/Autonomy:/.test(JSON.stringify(statusBlocks(run, { now: 1, approvers: undefined }).blocks)), "nothing to say, nothing said");
});

test("settings that quietly beat a stricter level are called out when the config loads", () => {
  const repos = [REPO, OTHER];
  assert.deepEqual(autonomyWarnings(factoryOf({ autonomy: "balanced" }), repos), []);
  const strict = factoryOf({ autonomy: "autonomous", merge: { autoMergeMaxRisk: 3 }, reviewRounds: 5, repositoryRules: { [OTHER]: { autonomy: "cautious" } } });
  const warnings = autonomyWarnings(strict, repos);
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings.join("\n"), /acme\/api: autonomy "cautious" would set autoMergeMaxRisk to 0, but an explicit autoMergeMaxRisk of 3 applies/);
  assert.match(warnings.join("\n"), /reviewRounds to 3, but an explicit reviewRounds of 5 applies/);
  const never = autonomyWarnings(factoryOf({ autonomy: "balanced", intake: { enabled: true, needsInfoDays: 0.5 } }), repos);
  assert.match(never.join("\n"), /goes on with assumptions after 24h|go on with assumptions after 24h/);
});

// ── the engine ───────────────────────────────────────────────────────────────────────────────────────────────

const audit = (f: ReturnType<typeof fixture>) => {
  try {
    return readFileSync(factoryAuditFile(f.channel), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; stage?: string; attempt?: number; of?: number });
  } catch { return []; } // nothing was audited yet
};

test("autonomous: a stage whose role failed is tried again by the engine, once, and the run goes on", async (t) => {
  const f = fixture(t, { factory: { autonomy: "autonomous" } });
  const p = await openProcess(f);
  const briefs: string[] = [];
  f.faux.setResponses([
    respond(reply.triage("READY")),
    respond("STATUS: failed\nNEXT: none\nnpm test: the sandbox ran out of memory"),
    respond(reply.implement(), (c) => briefs.push(briefOf(c))),
    respond(reply.review("APPROVED", 2)),
  ]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["completed"]);
  assert.deepEqual(stageOf(run, "implement").attempts.map((a) => a.status), ["failed", "done"]);
  assert.equal(stageOf(run, "implement").entries, 1, "a retry is not a new round");
  assert.deepEqual(audit(f).filter((e) => e.event === "auto_retry").map((e) => [e.stage, e.attempt, e.of]), [["implement", 1, 1]]);
  assert.equal(briefs.length, 1);
  assert.equal(f.github.merges.length, 1, "risk 2 is at or under autonomous's 3, with a required check green");
});

test("autonomous: the second failure is a person's to decide: the retries are bounded", async (t) => {
  const f = fixture(t, { factory: { autonomy: "autonomous" } });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("READY")), respond("STATUS: failed\nNEXT: none\nfirst"), respond("STATUS: failed\nNEXT: none\nsecond")]);
  const { runId } = await startRun(p);
  const run = await reach(p, runId, ["needs_decision"], "failed");
  assert.deepEqual(stageOf(run, "implement").attempts.map((a) => a.status), ["failed", "failed"]);
  assert.equal(audit(f).filter((e) => e.event === "auto_retry").length, 1);
  await p.store.abortFactoryRun(runId, "test over");
});

test("balanced and cautious: a failed stage waits for a person straight away", async (t) => {
  for (const level of ["balanced", "cautious"] as const) {
    const f = fixture(t, { factory: { autonomy: level } });
    const p = await openProcess(f);
    f.faux.setResponses([respond(reply.triage("READY")), respond("STATUS: failed\nNEXT: none\nboom")]);
    const { runId } = await startRun(p);
    const run = await reach(p, runId, ["needs_decision"], "failed");
    assert.deepEqual(stageOf(run, "implement").attempts.map((a) => a.status), ["failed"], level);
    assert.equal(audit(f).filter((e) => e.event === "auto_retry").length, 0, level);
    await p.store.abortFactoryRun(runId, "test over");
  }
});

test("autonomous: what is not plainly a failure is not retried: the coder's own blocked waits for a person", async (t) => {
  const f = fixture(t, { factory: { autonomy: "autonomous" } });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("READY")), respond("STATUS: blocked\nNEXT: none\nThe issue contradicts itself.")]);
  const { runId } = await startRun(p);
  await reach(p, runId, ["needs_decision"], "failed");
  assert.equal(audit(f).filter((e) => e.event === "auto_retry").length, 0);
  await p.store.abortFactoryRun(runId, "test over");
});

test("only a stage that is safe to run again is retried by the engine: the deploy is not", () => {
  for (const stage of SOFTWARE_FACTORY_WORKFLOW.stages.filter((s) => s.kind === "agent")) {
    const safe = stage.replaySafe || stage.resumable === true;
    assert.equal(safe, stage.name !== "deploy", `${stage.name}`);
  }
});

test("a run is started with its repository's review rounds, and keeps them", async (t) => {
  const f = fixture(t, { repositories: [REPO, OTHER], factory: { autonomy: "balanced", repositoryRules: { [OTHER]: { autonomy: "autonomous" } } } });
  const p = await openProcess(f);
  f.faux.setResponses([respond(reply.triage("NEEDS_INFO")), respond(reply.triage("NEEDS_INFO"))]);
  const a = await startRun(p, { repo: REPO, issue: 1, definition: channelWorkflow(f.channel, REPO) });
  const b = await startRun(p, { repo: OTHER, issue: 2, definition: channelWorkflow(f.channel, OTHER) });
  const roundsOf = async (id: string) => JSON.parse((await p.store.factoryRun(id))!.definition).stages.find((s: { name: string }) => s.name === "review").maxEntries;
  assert.deepEqual([await roundsOf(a.runId), await roundsOf(b.runId)], [4, 5]);
  await p.store.abortFactoryRun(a.runId, "test over");
  await p.store.abortFactoryRun(b.runId, "test over");
});

test("the harness config accepts the example's levels end to end", () => {
  const config = HarnessConfigSchema.parse({ channels: { eng: { factory: { name: "F", repositories: [REPO], autonomy: "balanced", repositoryRules: { [REPO]: { autonomy: "cautious" } } } } } });
  assert.equal(config.channels.eng!.factory!.autonomy, "balanced");
});
