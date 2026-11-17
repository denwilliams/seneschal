import type { FactoryConfig } from "../../config/schema.ts";

/**
 * How much of its own judgement a factory is trusted with: one word that sets a coherent set of the factory's other knobs, so the
 * common choices ("check everything", "let it get on with it") need no knowledge of them. A pure function of the config and nothing
 * else; the engine, the merge gate and every place that shows the level read it from here.
 *
 * The level only moves the knobs below. It never touches the gates: a pull request still merges only when the reviewer approved it,
 * every required check is green and its head has not moved since the review (`--match-head-commit`); a change touching a sensitive
 * path or a big diff is still scored up; a repository with no required check still needs a person; only trusted authors start a run;
 * a comment can never approve or merge; deploys still wait for an approver. Those have no setting here, so no level can loosen them.
 */

export const AUTONOMY_LEVELS = ["cautious", "balanced", "autonomous"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** What a factory with no `autonomy` runs at: today's behaviour, so an existing config does not change on upgrade. */
export const DEFAULT_AUTONOMY: AutonomyLevel = "cautious";

/** The knobs a level sets. */
export interface AutonomyKnobs {
  /** Merge by itself at or under this risk (`factory.merge.autoMergeMaxRisk`). 0: a person merges everything. */
  autoMergeMaxRisk: number;
  /** Hours with no answer before triage is told to go on with stated assumptions (`factory.intake.assumeAfterHours`). 0: wait for a person. */
  assumeAfterHours: number;
  /** Times review may send the work back before a person is asked (`factory.reviewRounds`). */
  reviewRounds: number;
  /** Times a stage that failed (timed out, or its report was unusable) is tried again by the engine before a person is asked (`factory.autoRetries`). */
  autoRetries: number;
}

export const AUTONOMY_PRESETS: Record<AutonomyLevel, AutonomyKnobs> = {
  cautious: { autoMergeMaxRisk: 0, assumeAfterHours: 0, reviewRounds: 3, autoRetries: 0 },
  balanced: { autoMergeMaxRisk: 2, assumeAfterHours: 24, reviewRounds: 4, autoRetries: 0 },
  autonomous: { autoMergeMaxRisk: 3, assumeAfterHours: 4, reviewRounds: 5, autoRetries: 1 },
};

export type KnobName = keyof AutonomyKnobs;
export const KNOB_NAMES: readonly KnobName[] = ["autoMergeMaxRisk", "assumeAfterHours", "reviewRounds", "autoRetries"];

/** Where a value came from: set in the config, or what the level gives. */
export type KnobSource = "explicit" | "level";

export interface EffectiveAutonomy {
  level: AutonomyLevel;
  /** Where the level came from: this repository's rule, the factory's setting, or the default. */
  levelFrom: "repository" | "factory" | "default";
  knobs: { [K in KnobName]: { value: number; source: KnobSource } };
}

type AutonomyInput = Partial<Pick<FactoryConfig, "autonomy" | "repositoryRules" | "merge" | "intake" | "reviewRounds" | "autoRetries">> | undefined;

const repositoryRule = (factory: AutonomyInput, repo: string) =>
  Object.entries(factory?.repositoryRules ?? {}).find(([name]) => name.toLowerCase() === repo.toLowerCase())?.[1];

/**
 * The level this repository runs at and each knob's value, with where it came from. Explicit settings beat the level, whichever layer
 * they are in (a repository's own `autoMergeMaxRisk`, then the factory's); among levels the repository's beats the factory's.
 * Everything unset is the default level's.
 */
export function effectiveAutonomy(factory: AutonomyInput, repo: string): EffectiveAutonomy {
  const own = repositoryRule(factory, repo);
  const level = own?.autonomy ?? factory?.autonomy ?? DEFAULT_AUTONOMY;
  const levelFrom = own?.autonomy ? "repository" : factory?.autonomy ? "factory" : "default";
  const preset = AUTONOMY_PRESETS[level];
  const explicit: Record<KnobName, number | undefined> = {
    autoMergeMaxRisk: own?.autoMergeMaxRisk ?? factory?.merge?.autoMergeMaxRisk,
    assumeAfterHours: factory?.intake?.assumeAfterHours,
    reviewRounds: factory?.reviewRounds,
    autoRetries: factory?.autoRetries,
  };
  const knob = (name: KnobName) => (explicit[name] !== undefined ? { value: explicit[name]!, source: "explicit" as const } : { value: preset[name], source: "level" as const });
  return { level, levelFrom, knobs: { autoMergeMaxRisk: knob("autoMergeMaxRisk"), assumeAfterHours: knob("assumeAfterHours"), reviewRounds: knob("reviewRounds"), autoRetries: knob("autoRetries") } };
}

/** The short account people read: "balanced · auto-merge at risk 2 or under · assumes after 24h · 4 review rounds". */
export function describeAutonomy(effective: EffectiveAutonomy): string {
  const { knobs } = effective;
  const parts: string[] = [effective.level];
  parts.push(knobs.autoMergeMaxRisk.value === 0 ? "a person merges" : `auto-merge at risk ≤${knobs.autoMergeMaxRisk.value}`);
  parts.push(knobs.assumeAfterHours.value === 0 ? "asks and waits" : `assumes after ${knobs.assumeAfterHours.value}h`);
  parts.push(`${knobs.reviewRounds.value} review rounds`);
  if (knobs.autoRetries.value > 0) parts.push(`retries a failed stage ${knobs.autoRetries.value}×`);
  return parts.join(" · ");
}

/**
 * Settings that quietly beat a stricter level: a repository set to a more careful level than the factory keeps a looser explicit
 * value (explicit settings always beat a level). Said when the config loads, so it is not a surprise at a merge.
 */
export function autonomyWarnings(factory: AutonomyInput, repositories: readonly string[]): string[] {
  const out: string[] = [];
  // A wait that ends before the assumption can happen: the run goes stale first and the level's promise is never kept.
  const needsInfoHours = (factory?.intake?.needsInfoDays ?? 14) * 24;
  for (const repo of repositories) {
    const hours = effectiveAutonomy(factory, repo).knobs.assumeAfterHours.value;
    if (hours > 0 && hours >= needsInfoHours) out.push(`${repo}: it should go on with assumptions after ${hours}h, but a run waiting for an answer is rejected as stale after ${needsInfoHours}h (intake.needsInfoDays), so it never gets there. Raise needsInfoDays or lower assumeAfterHours.`);
  }
  for (const repo of Object.keys(factory?.repositoryRules ?? {})) {
    const own = repositoryRule(factory, repo);
    if (!own?.autonomy) continue;
    const effective = effectiveAutonomy(factory, repo);
    const wanted = AUTONOMY_PRESETS[own.autonomy];
    for (const name of KNOB_NAMES) {
      const knob = effective.knobs[name];
      if (knob.source !== "explicit") continue;
      // More autonomy is a higher number, except the assume window, where a shorter one (and 0 meaning never) is the stricter end.
      const rank = (n: KnobName, v: number) => (n === "assumeAfterHours" ? (v === 0 ? 0 : 1 / v) : v);
      const looser = rank(name, knob.value) > rank(name, wanted[name]);
      if (looser) out.push(`${repo}: autonomy "${own.autonomy}" would set ${name} to ${wanted[name]}, but an explicit ${name} of ${knob.value} applies (explicit settings beat a level). Remove the explicit setting to let the level decide.`);
    }
  }
  return out;
}
