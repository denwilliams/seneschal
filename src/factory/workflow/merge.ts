import type { FactoryConfig, FactoryMergeRules } from "../../config/schema.ts";
import { effectiveAutonomy } from "./autonomy.ts";
import { UNSCORED_RISK } from "./report.ts";

/**
 * The merge gate's rules, as pure functions. Whether a change merges by itself is decided here and nowhere else, from facts
 * GitHub reports and the factory's config. A model's score is an input that can only be raised: the reviewer's judgement of its
 * own review is not what lets code into the default branch.
 */

export const DEFAULT_LARGE_DIFF_LINES = 800;
/** A change touching a sensitive path is at least this risky. */
export const SENSITIVE_PATH_FLOOR = 4;
/** A change larger than `largeDiffLines` is at least this risky. */
export const LARGE_DIFF_FLOOR = 3;

export interface ResolvedMergeRules {
  /** Undefined: the channel's allowed users decide. */
  approvers: string[] | undefined;
  /** 0 never merges automatically. */
  autoMergeMaxRisk: number;
  method: "squash" | "merge" | "rebase";
  sensitivePaths: string[];
  largeDiffLines: number;
  deployEnvironment: "staging" | "production";
}

/** The repository's own rules over the factory's, over the factory's autonomy level, over the safe defaults. Nothing set means nothing merges by itself. */
export function resolveMergeRules(factory: Pick<FactoryConfig, "merge" | "repositoryRules" | "autonomy"> | undefined, repo: string): ResolvedMergeRules {
  const own = Object.entries(factory?.repositoryRules ?? {}).find(([name]) => name.toLowerCase() === repo.toLowerCase())?.[1];
  const layer = (key: keyof FactoryMergeRules) => own?.[key] ?? factory?.merge?.[key];
  return {
    approvers: layer("approvers") as string[] | undefined,
    // The repository's own number, else the factory's, else what the level gives (0 for a factory with no level: nothing merges by itself).
    autoMergeMaxRisk: effectiveAutonomy(factory, repo).knobs.autoMergeMaxRisk.value,
    method: (layer("method") as ResolvedMergeRules["method"] | undefined) ?? "squash",
    sensitivePaths: (layer("sensitivePaths") as string[] | undefined) ?? [],
    largeDiffLines: (layer("largeDiffLines") as number | undefined) ?? DEFAULT_LARGE_DIFF_LINES,
    deployEnvironment: (layer("deployEnvironment") as ResolvedMergeRules["deployEnvironment"] | undefined) ?? "staging",
  };
}

/**
 * May this user approve or decline? The factory's `approvers`, else the channel's `allowUsers`. A channel with neither is open
 * to everyone who can speak in it, so everyone who got this far may.
 */
export function canApprove(userId: string, rules: Pick<ResolvedMergeRules, "approvers">, channelAllowUsers: readonly string[] | undefined): boolean {
  if (!userId) return false;
  const list = rules.approvers ?? channelAllowUsers;
  return list === undefined ? true : list.includes(userId);
}

/** `*` matches within a folder, `**` across folders, `?` one character. Anchored: the pattern must match the whole path. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export interface PrFacts {
  state: "open" | "merged" | "closed";
  /** The commit at the tip of the pull request's branch. */
  headSha: string;
  /** GitHub's raw mergeability, not a model's interpretation of a CLI error. */
  mergeable: string;
  mergeStateStatus: string;
  headRefName?: string;
  baseRefName?: string;
  baseSha?: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  /** The merge commit, once merged. */
  mergeCommit?: string;
}

/** Only explicit GitHub conflict facts establish a conflict; UNKNOWN never does. */
export function prMergeability(pr: Pick<PrFacts, "mergeable" | "mergeStateStatus">): "conflicting" | "unknown" | "mergeable" {
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflicting";
  return pr.mergeable === "MERGEABLE" ? "mergeable" : "unknown";
}

/** GitHub does not enumerate conflicting paths: changedFiles is NOT conflict evidence. */
export function conflictEvidence(pr: PrFacts): string {
  return `Confirmed PR merge conflicts: mergeable=${pr.mergeable}, mergeStateStatus=${pr.mergeStateStatus}; branch ${pr.headRefName || "(read from PR)"} at ${pr.headSha}; target base ${pr.baseRefName || "(read from PR)"} at ${pr.baseSha || "unknown"}. Conflicting paths are not supplied by GitHub; inspect local Git evidence.`;
}

export interface ChecksFacts {
  /** Checks GitHub counts as required for this branch. */
  required: number;
  failing: number;
  pending: number;
}

/** The reviewer's score raised by whatever the facts say, and why. Missing or out of range is the unscored 5. */
export function finalRisk(modelRisk: number, pr: Pick<PrFacts, "changedFiles" | "additions" | "deletions">, rules: Pick<ResolvedMergeRules, "sensitivePaths" | "largeDiffLines">): { final: number; floors: string[] } {
  let final = Number.isInteger(modelRisk) && modelRisk >= 1 && modelRisk <= 5 ? modelRisk : UNSCORED_RISK;
  const floors: string[] = [];
  const patterns = rules.sensitivePaths.map(globToRegExp);
  const touched = pr.changedFiles.filter((file) => patterns.some((pattern) => pattern.test(file)));
  if (touched.length > 0) {
    if (final < SENSITIVE_PATH_FLOOR) final = SENSITIVE_PATH_FLOOR;
    floors.push(`touches sensitive paths (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? `, and ${touched.length - 3} more` : ""})`);
  }
  const lines = pr.additions + pr.deletions;
  if (lines > rules.largeDiffLines) {
    if (final < LARGE_DIFF_FLOOR) final = LARGE_DIFF_FLOOR;
    floors.push(`changes ${lines} lines, over this repository's ${rules.largeDiffLines}`);
  }
  return { final, floors };
}

export type MergeDecision =
  /** Merge now: every rule allows it without a person. */
  | { action: "auto"; risk: { final: number; floors: string[] } }
  /** A person decides. `reasons` says why the rules did not. */
  | { action: "wait"; reasons: string[]; risk: { final: number; floors: string[] } }
  /** The pull request moved on since it was reviewed. It goes back to review. */
  | { action: "rereview"; reason: string }
  | { action: "conflicts"; reason: string }
  | { action: "unresolved"; reason: string };

export function mergeDecision(input: {
  /** What the reviewer scored; -1 or anything outside 1 to 5 counts as unscored. */
  modelRisk: number;
  pr: PrFacts;
  checks: ChecksFacts;
  rules: ResolvedMergeRules;
  /** The head commit when review began. */
  reviewedHead: string;
}): MergeDecision {
  const { pr, checks, rules } = input;
  if (prMergeability(pr) === "conflicting") return { action: "conflicts", reason: conflictEvidence(pr) };
  if (prMergeability(pr) === "unknown") return { action: "unresolved", reason: "GitHub mergeability is still unknown after bounded refresh; not a confirmed conflict or permission to merge" };
  if (!input.reviewedHead || pr.headSha !== input.reviewedHead) {
    return { action: "rereview", reason: `the pull request's head is ${pr.headSha.slice(0, 7) || "unknown"}, not the ${input.reviewedHead.slice(0, 7) || "unrecorded"} that was reviewed` };
  }
  const risk = finalRisk(input.modelRisk, pr, rules);
  const blockers: string[] = [];
  if (rules.autoMergeMaxRisk === 0) blockers.push("automatic merging is off for this repository");
  else if (risk.final > rules.autoMergeMaxRisk) blockers.push(`risk ${risk.final} is above this repository's automatic limit of ${rules.autoMergeMaxRisk}`);
  if (checks.required === 0) blockers.push("GitHub reports no required checks for this branch");
  if (checks.failing > 0) blockers.push(`${checks.failing} required check${checks.failing === 1 ? " is" : "s are"} failing`);
  if (checks.pending > 0) blockers.push(`${checks.pending} required check${checks.pending === 1 ? " is" : "s are"} still running`);
  if (blockers.length === 0) return { action: "auto", risk };
  // The floors are why the score is what it is; they are shown with the reasons, not as reasons of their own.
  return { action: "wait", reasons: [...blockers, ...risk.floors.map((floor) => `the change ${floor}`)], risk };
}
