import type { SubagentReport } from "../../agent/subagent-tools.ts";
import type { Stage } from "./definition.ts";

/**
 * Turning a role's report into what the engine acts on. The contract is the one the roles already follow
 * (agent-set-skills/software_factory/factory-handoffs): `STATUS:` and `NEXT:` lead (the runner parses those), then the stage's
 * own lines: `VERDICT:` for triage and review, `RISK:` and `RISK_REASON:` for review, and the pull request's URL from the coder.
 * `NEXT:` is advice and is never what moves a run; the verdict and the workflow's arrows are.
 */

/** A change nobody scored, or scored outside 1 to 5, is the riskiest it can be. */
export const UNSCORED_RISK = 5;

export type StageReading =
  /** The stage finished and said which way to go. */
  | { kind: "verdict"; verdict: string; risk?: { score: number; reason: string; scored: boolean }; pr?: { number: number; url: string } }
  /** The role said it failed, or the run did. The stage fails and so does the run. */
  | { kind: "failed"; reason: string }
  /** The report is missing something the stage needs. Worth one more ask; then it fails the stage. */
  | { kind: "unreadable"; problem: string };

const token = (text: string): string => text.trim().toLowerCase().replace(/[\s-]+/g, "_");

function verdictLine(text: string): string | undefined {
  const found = /^\s*VERDICT:\s*([A-Za-z][A-Za-z_ -]*)/im.exec(text)?.[1];
  return found ? token(found) : undefined;
}

/** Triage reports one line per issue and a `READY:` list. For a run about one issue, those say which way it goes. */
function triageVerdict(text: string, issue: number): string | undefined {
  const ready = /^\s*READY:\s*(.+)$/im.exec(text)?.[1];
  if (ready && new RegExp(`(^|[^0-9])#?${issue}([^0-9]|$)`).test(ready)) return "ready";
  const line = new RegExp(`^\\s*[-*]?\\s*#${issue}\\b.*$`, "im").exec(text)?.[0]?.toLowerCase();
  if (!line) return undefined;
  if (/\bneeds[- ]info\b/.test(line)) return "needs_info";
  if (/\b(duplicate|wontfix|won't fix|defer)\b/.test(line)) return "reject";
  if (/\bready\b/.test(line)) return "ready";
  return undefined;
}

export function parseRisk(text: string): { score: number; reason: string; scored: boolean } {
  const raw = /^\s*RISK:\s*(\S+)/im.exec(text)?.[1];
  const score = raw === undefined ? NaN : Number(raw);
  const reason = /^\s*RISK_REASON:\s*(.+)$/im.exec(text)?.[1]?.trim().slice(0, 300) ?? "";
  return Number.isInteger(score) && score >= 1 && score <= 5 ? { score, reason, scored: true } : { score: UNSCORED_RISK, reason, scored: false };
}

/** The first pull request URL in `text` that belongs to `repo`. A URL for any other repository is not the run's pull request. */
export function pullRequestIn(text: string, repo: string): { number: number; url: string } | undefined {
  const pattern = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\b/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1]!.toLowerCase() === repo.toLowerCase()) return { number: Number(match[2]), url: `https://github.com/${match[1]}/pull/${match[2]}` };
  }
  return undefined;
}

export function readStageReport(stage: Stage, report: SubagentReport, run: { repo: string; issue: number; /** This report is the second ask, after the first one was missing something. */ reask?: boolean }): StageReading {
  if (report.status === "failed") return { kind: "failed", reason: report.summary };
  const verdicts = Object.keys(stage.on);
  const missing = (what: string): StageReading => ({ kind: "unreadable", problem: what });

  let verdict: string | undefined;
  if (report.status === "blocked" || report.status === "needs_input") {
    // Triage that cannot go on without an answer is asking for information, which the workflow waits for: not a failure.
    if (verdicts.includes("blocked")) verdict = "blocked";
    else if (verdicts.includes("needs_info")) verdict = "needs_info";
    else return { kind: "failed", reason: `the ${stage.role ?? stage.name} role reported ${report.status.replace("_", " ")}: ${report.summary}` };
  } else {
    verdict = verdictLine(report.summary) ?? (stage.name === "triage" ? triageVerdict(report.summary, run.issue) : undefined);
    if (verdict === undefined && verdicts.includes("done")) verdict = "done";
    if (verdict === undefined) return missing(`a \`VERDICT:\` line naming one of: ${verdicts.map((v) => v.toUpperCase()).join(", ")}`);
    if (!verdicts.includes(verdict)) return missing(`a \`VERDICT:\` that is one of ${verdicts.map((v) => v.toUpperCase()).join(", ")} (it said ${verdict.toUpperCase()})`);
  }

  const pr = stage.producesPr ? pullRequestIn(report.summary, run.repo) : undefined;
  if (stage.producesPr && verdict === "done" && !pr) return missing(`the URL of the pull request you opened in ${run.repo}`);
  const risk = stage.scoresRisk && verdict !== "blocked" ? parseRisk(report.summary) : undefined;
  // A score is asked for once more before it is taken as missing: an unscored change counts as the riskiest and waits for a person,
  // which is what a forgotten line must not cost when the reviewer would give one if asked. Still missing, it stands as unscored.
  if (risk && !risk.scored && !run.reask && verdict === "approved") return missing("a `RISK: <1-5>` line (and `RISK_REASON:`); add them to your report");
  return { kind: "verdict", verdict, ...(risk ? { risk } : {}), ...(pr ? { pr } : {}) };
}
