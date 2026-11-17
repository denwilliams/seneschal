import { pinnedWorkflow, stageIndex } from "./definition.ts";
import type { FactoryRunData } from "./docs.ts";

/**
 * What a run that is not moving is waiting for, and every way a person can move it, in plain words. One place, so the agent's
 * `check_factory_run`, the Slack status post and the README say the same thing, and a run is never stuck without saying how to get it
 * going. Nothing here is untrusted text: it is the harness's own wording, chosen from the run's status and what it waits on.
 */
export interface StuckGuide {
  /** What the run is waiting for, in a sentence. */
  waitingFor: string;
  /** Ways to get it going, most direct first. */
  ways: string[];
}

export function stuckGuide(run: Pick<FactoryRunData, "status" | "wait" | "current" | "stages" | "definition" | "hash" | "reason">): StuckGuide | undefined {
  const kind = run.wait.kind;
  if (run.status === "waiting") {
    switch (kind) {
      case "info":
        return {
          waitingFor: "an answer to triage's question on the issue",
          ways: [
            "Reply in the run's Slack thread: the harness puts your answer on the issue (marked as the agent's) and triage runs again.",
            "Or comment on the issue on GitHub. A comment from an owner, member or collaborator is picked up on the next poll, even from the account the harness uses.",
            "If an answer is already on the issue and the run has not noticed, ask the agent to use `factory_recheck_issue`.",
            "If nobody answers, the run goes on with stated assumptions after `factory.intake.assumeAfterHours` (when set), or is rejected as stale after `factory.intake.needsInfoDays`.",
          ],
        };
      case "merge":
        return {
          waitingFor: "a person to approve the merge (the rules did not let it merge by itself: see the reason)",
          ways: [
            "Press Approve in the run's Slack post, or say approve in its thread.",
            "Or merge the pull request yourself on GitHub: the run notices it was merged and carries on.",
            "To decline instead, press Decline, or close the pull request.",
            "To stop this recurring: set `factory.merge.autoMergeMaxRisk`, and make sure the branch has a required check (branch protection), which automatic merging needs.",
          ],
        };
      case "deploy":
        return {
          waitingFor: "a person to approve the deploy",
          ways: ["Press Approve in the run's Slack post, or say approve in its thread (Decline skips the deploy).", "To never deploy from this channel, disable the role: `agentOverrides: { cloudflare_deployer: { enabled: false } }`."],
        };
      case "rounds":
        return {
          waitingFor: "a person to say whether review may have another round",
          ways: ["Press One more round (the coder takes the reviewer's findings again), or Stop in the run's Slack post, or say so in its thread.", "To allow more rounds by default, raise `factory.reviewRounds`."],
        };
      default:
        return undefined;
    }
  }
  if (run.status === "needs_decision") {
    if (kind === "failed") {
      const definition = pinnedWorkflow(run);
      const stage = definition?.stages.find((candidate) => candidate.name === run.current);
      const earlier = definition ? definition.stages.slice(0, stageIndex(definition, run.current)).map((candidate) => candidate.name) : [];
      return {
        waitingFor: `a person to say what to do about the "${run.current}" stage, which failed`,
        ways: [
          "Fix the cause (the reason says what: a token, a label, the role's setup or skills, more detail on the issue), then press Retry in the run's Slack post or say retry in its thread. Retry keeps the pull request, the risk score and the history.",
          ...(stage?.optional ? [`Skip it (the ${run.current} stage is optional) to go on without it.`] : []),
          ...(earlier.length ? [`Or restart from an earlier stage (${earlier.join(", ")}) if the problem is upstream.`] : []),
          "Or abort the run.",
        ],
      };
    }
    return {
      waitingFor: `a person to say what to do about the "${run.current}" stage, which a restart interrupted`,
      ways: ["Look at the issue and the pull request first (was a branch pushed? a PR opened?), then press Retry or Abort in the run's Slack post, or say retry, skip or abort in its thread."],
    };
  }
  if (run.status === "failed") {
    return {
      waitingFor: "nothing: the run ended failed",
      ways: ["Say retry (`factory_decide`) to carry it on from the stage it failed at, on the same record, once the cause is fixed and the issue is still open."],
    };
  }
  if (run.status === "rejected") {
    return { waitingFor: "nothing: the run ended rejected", ways: ["If that was wrong, add the go label (`factory:go`) to the issue or ask the agent to `start_factory_run` for it again."] };
  }
  return undefined;
}

/** The guide as one short paragraph, for a message. */
export const stuckText = (guide: StuckGuide): string => `Waiting for ${guide.waitingFor}. To get it going: ${guide.ways.join(" ")}`;
