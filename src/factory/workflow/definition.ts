import { createHash } from "node:crypto";
import { FactoryDeploySchema, type FactoryDeployConfig } from "../../config/schema.ts";

/**
 * A workflow as data: stages, and where each stage's verdict leads. The software factory's is `SOFTWARE_FACTORY_WORKFLOW`,
 * hard coded; a channel cannot define its own yet, but everything the engine does it does through this shape, so a custom
 * workflow later needs a loader and `validateWorkflow`, not a rewrite. See docs/FACTORY_WORKFLOW_DESIGN.md.
 */

/** How a run ends, as an arrow's target: `complete` is the one success, `reject` a decision not to proceed, `fail` a breakage. */
export type WorkflowEnd = "complete" | "reject" | "fail";
export const WORKFLOW_ENDS: readonly WorkflowEnd[] = ["complete", "reject", "fail"];

/**
 * An arrow's target that is neither a stage nor an end: park the run until a trusted update arrives on its issue, then run the
 * same stage again. Bounded by people (each re-entry needs a new update) and by `factory.intake.needsInfoDays`, so it is not a loop
 * the validator has to guard.
 */
export const WAIT_FOR_INFO = "wait_for_info";

/** `agent`: a sub-agent. `gate`: the merge decision. `actions`: native read-only deployment observation. */
export type StageKind = "agent" | "gate" | "actions";

export interface Stage {
  /** A lower-case identifier, unique in the workflow. */
  name: string;
  kind: StageKind;
  /** Pinned read-only deploy monitor configuration; never inferred from issue text. */
  actions?: Extract<FactoryDeployConfig, { mode: "github-actions" }>;
  /** The sub-agent for an agent stage. A gate has none. */
  role?: string;
  /** Where each verdict leads: another stage's name, or an end. A verdict with no arrow fails the stage. */
  on: Record<string, string>;
  /**
   * A loop guard, on the stage that sends the run back. When this stage has run this many times and its verdict would send the
   * run back to an earlier stage again, the run waits for a person (who may allow another round) instead of looping.
   */
  maxEntries?: number;
  /** Skipped, not failed, when no sub-agent for its role is assigned to the channel. Needs a `skipped` arrow. */
  optional?: boolean;
  /** Its report must name the pull request it opened, which the later stages are about. */
  producesPr?: boolean;
  /** Its report carries a `RISK: 1-5` for the change, which the merge gate weighs. */
  scoresRisk?: boolean;
  /**
   * May the engine run it again by itself when a restart cut it off? True for a role that only reads. A role that writes (the
   * coder may already have pushed a branch) is not repeated until a person says so.
   */
  replaySafe: boolean;
  /**
   * A role that writes but can be told to look at what an earlier, cut-off attempt left and carry on (the coder: its branch and pull
   * request are findable). When a restart cuts it off the engine runs it again by itself, up to `MAX_AUTO_RESUMES` times, with a
   * brief that says so, instead of asking a person. Only meaningful with `replaySafe: false`.
   */
  resumable?: boolean;
}

/** How many times in a row a cut-off `resumable` stage is run again without asking a person. */
export const MAX_AUTO_RESUMES = 2;

export interface WorkflowDefinition {
  name: string;
  /** Bumped whenever the shape changes, so a run can be told apart from the code that made it. */
  version: number;
  /** The first stage. */
  start: string;
  stages: Stage[];
}

/** The review loop's guard when the channel does not say: three rounds of coder and reviewer, then a person is asked. */
export const DEFAULT_REVIEW_ROUNDS = 3;

export const SOFTWARE_FACTORY_WORKFLOW: WorkflowDefinition = {
  name: "software-factory",
  version: 5,
  start: "triage",
  stages: [
    { name: "triage", kind: "agent", role: "github_triage", replaySafe: true, on: { ready: "implement", needs_info: WAIT_FOR_INFO, reject: "reject" } },
    { name: "implement", kind: "agent", role: "coder", replaySafe: false, resumable: true, producesPr: true, on: { done: "review", blocked: "fail" } },
    { name: "review", kind: "agent", role: "reviewer", replaySafe: true, scoresRisk: true, maxEntries: 3, on: { approved: "merge", changes_requested: "implement" } },
    { name: "merge", kind: "gate", replaySafe: true, on: { merged: "deploy", declined: "reject", head_changed: "review", conflicts: "implement", changes_requested: "implement" } },
    { name: "deploy", kind: "agent", role: "cloudflare_deployer", optional: true, replaySafe: false, on: { done: "complete", declined: "complete", skipped: "complete" } },
  ],
};

/** The shipped workflow with review rounds and the mutually exclusive deploy implementation applied. */
export function softwareFactoryWorkflow(options: { reviewRounds?: number; deploy?: FactoryDeployConfig } = {}): WorkflowDefinition {
  const rounds = options.reviewRounds ?? DEFAULT_REVIEW_ROUNDS;
  if (rounds === DEFAULT_REVIEW_ROUNDS && options.deploy?.mode !== "github-actions") return SOFTWARE_FACTORY_WORKFLOW;
  return { ...SOFTWARE_FACTORY_WORKFLOW, version: options.deploy?.mode === "github-actions" ? 6 : SOFTWARE_FACTORY_WORKFLOW.version, stages: SOFTWARE_FACTORY_WORKFLOW.stages.map((stage) => {
    if (stage.name === "review") return { ...stage, maxEntries: rounds };
    if (stage.name === "deploy" && options.deploy?.mode === "github-actions") return {
      name: "deploy", kind: "actions", actions: options.deploy, optional: true, replaySafe: true,
      on: { done: "complete", skipped: "complete" },
    };
    return stage;
  }) };
}

/**
 * A human's explicit return for changes uses the pinned review-to-implement route, also for pre-v5 runs. This is a manual
 * control (like restart_from), not an automatic conflict arrow or a rewrite of the run's pinned definition. Never offer it
 * unless the pinned workflow already requires independent review after implementation.
 */
export function humanChangesStage(definition: WorkflowDefinition, gate: Stage): Stage | undefined {
  const review = definition.stages.find((stage) => stage.scoresRisk);
  const implement = definition.stages.find((stage) => stage.name === "implement");
  if (gate.kind !== "gate" || review?.on.changes_requested !== "implement" || implement?.on.done !== review.name) return undefined;
  if (gate.on.changes_requested && gate.on.changes_requested !== "implement") return undefined;
  return { ...gate, on: { ...gate.on, changes_requested: "implement" } };
}

const NAME = /^[a-z][a-z0-9_]*$/;

/** What is wrong with a definition, or an empty list. Everything the engine relies on is checked here, not at run time. */
export function validateWorkflow(definition: WorkflowDefinition): string[] {
  const problems: string[] = [];
  const stages = definition.stages;
  if (stages.length === 0) return ["a workflow needs at least one stage"];
  const names = new Set<string>();
  for (const stage of stages) {
    if (!NAME.test(stage.name)) problems.push(`stage "${stage.name}": a name is lower-case letters, digits and underscores, starting with a letter`);
    if (names.has(stage.name)) problems.push(`stage "${stage.name}" is used twice`);
    names.add(stage.name);
    if ((WORKFLOW_ENDS as readonly string[]).includes(stage.name)) problems.push(`stage "${stage.name}": ${WORKFLOW_ENDS.join(", ")} are ends, not stage names`);
  }
  if (!names.has(definition.start)) problems.push(`the start stage "${definition.start}" is not a stage`);

  for (const stage of stages) {
    const where = `stage "${stage.name}"`;
    if (stage.kind === "agent" && !stage.role) problems.push(`${where}: an agent stage needs a role`);
    if (stage.kind === "gate" && stage.role) problems.push(`${where}: a gate has no role`);
    if (stage.kind === "actions" && (stage.role || !FactoryDeploySchema.safeParse(stage.actions).success || stage.actions?.mode !== "github-actions")) problems.push(`${where}: an Actions stage needs valid monitor settings and no role`);
    if (Object.keys(stage.on).length === 0) problems.push(`${where}: it needs at least one arrow`);
    for (const [verdict, target] of Object.entries(stage.on)) {
      if (!NAME.test(verdict)) problems.push(`${where}: verdict "${verdict}" is not a lower-case identifier`);
      if (!names.has(target) && !(WORKFLOW_ENDS as readonly string[]).includes(target) && target !== WAIT_FOR_INFO) problems.push(`${where}: verdict "${verdict}" leads to "${target}", which is neither a stage nor an end`);
    }
    if (Object.values(stage.on).includes(WAIT_FOR_INFO) && stage.kind !== "agent") problems.push(`${where}: only an agent stage can wait for information`);
    if (stage.optional && !("skipped" in stage.on)) problems.push(`${where}: an optional stage needs a "skipped" arrow`);
    if (stage.maxEntries !== undefined && (!Number.isInteger(stage.maxEntries) || stage.maxEntries < 1)) problems.push(`${where}: maxEntries is a whole number of at least 1`);
  }

  // Every stage must be reachable from the start, and some path must reach `complete`.
  const reached = new Set<string>();
  const walk = (name: string) => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const target of Object.values(stages.find((stage) => stage.name === name)?.on ?? {})) if (names.has(target)) walk(target);
  };
  if (names.has(definition.start)) walk(definition.start);
  for (const stage of stages) if (!reached.has(stage.name)) problems.push(`stage "${stage.name}" can never be reached from "${definition.start}"`);
  if (!stages.some((stage) => reached.has(stage.name) && Object.values(stage.on).includes("complete"))) problems.push(`no stage leads to "complete"`);

  // A loop is only allowed if something in it can stop it: take away the guarded stages and nothing may still cycle.
  const guarded = new Set(stages.filter((stage) => stage.maxEntries !== undefined).map((stage) => stage.name));
  const state = new Map<string, "visiting" | "done">();
  const cyclic = (name: string): string | undefined => {
    if (guarded.has(name)) return undefined;
    if (state.get(name) === "done") return undefined;
    if (state.get(name) === "visiting") return name;
    state.set(name, "visiting");
    for (const target of Object.values(stages.find((stage) => stage.name === name)?.on ?? {})) {
      if (!names.has(target)) continue;
      const found = cyclic(target);
      if (found) return found;
    }
    state.set(name, "done");
    return undefined;
  };
  for (const stage of stages) {
    const found = cyclic(stage.name);
    if (found) { problems.push(`stage "${found}" is in a loop with no stage that has a maxEntries guard`); break; }
  }
  return problems;
}

/**
 * The workflow a run was started with, from the run's own record: undefined when it is unreadable, invalid, or does not match the
 * hash it was pinned with. A run never takes the shipped workflow's current shape, only what it started with.
 */
export function pinnedWorkflow(run: { definition: string; hash: string }): WorkflowDefinition | undefined {
  try {
    const parsed = JSON.parse(run.definition) as WorkflowDefinition;
    return validateWorkflow(parsed).length === 0 && hashWorkflow(parsed) === run.hash ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A stage's index, or -1. */
export const stageIndex = (definition: WorkflowDefinition, name: string): number => definition.stages.findIndex((stage) => stage.name === name);

/** A stable fingerprint: the same definition always hashes the same, whatever its key order. */
export function hashWorkflow(definition: WorkflowDefinition): string {
  return createHash("sha256").update(canonical(definition)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
