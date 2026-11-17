import { pinnedWorkflow } from "../factory/workflow/definition.ts";
import { isTerminalRun, type FactoryRunData } from "../factory/workflow/docs.ts";
import { stuckGuide } from "../factory/workflow/unstick.ts";
import type { WorkflowActionName, WorkflowGuidance, WorkflowRecovery } from "./api-types.ts";

/**
 * Why a live run is not moving and how to carry it on, for the run's page. The words are `stuckGuide`'s (the same ones
 * `check_factory_run`, the status post and the README give); what this adds is which of them the console can do itself, when the
 * operator turned console actions on. Merge decisions require run-scoped verification with a Slack approver.
 */

export interface GuidanceOptions {
  /** The console may act (`webConsole.actions`). */
  actions: boolean;
  /** Issue intake is on for the channel: reading the issue's comments again needs it. */
  intake: boolean;
  mergeVerification?: WorkflowGuidance["mergeVerification"];
}

const ASK_AGENT = "Ask the channel's agent (check_factory_run shows where it is)";

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

export function guidanceFor(run: FactoryRunData, recovery: WorkflowRecovery | undefined, options: GuidanceOptions): WorkflowGuidance | undefined {
  const live = !isTerminalRun(run.status);
  if (!live && !(run.status === "failed" && recovery)) return undefined;
  const can = (...names: WorkflowActionName[]): { actions?: WorkflowActionName[] } => (options.actions ? { actions: names } : {});
  const stage = run.current;
  const guide = stuckGuide(run);
  const summary = guide ? (guide.waitingFor.startsWith("nothing") ? sentence(guide.waitingFor) : `Waiting for ${guide.waitingFor}.`) : undefined;
  const elsewhere = guide?.ways ?? [];

  if (run.status === "failed" && recovery) {
    return { summary: summary ?? `The run ended failed at ${stage}.`, elsewhere, ...can("retry") };
  }
  if (run.status === "running") {
    return { summary: `Running: ${stage}. Nothing is needed from you.`, elsewhere: [`${ASK_AGENT} to stop it.`], ...can("abort") };
  }
  switch (run.wait.kind) {
    case "info":
      return { summary: summary ?? "Waiting for an answer.", elsewhere, ...can("answer", ...(options.intake ? ["recheck" as const] : []), "abort") };
    case "merge": {
      const mergeVerification = options.mergeVerification ?? { state: "unavailable" as const };
      return { summary: "Waiting for a person to authorize the merge. Review approval is not merge authorization.", elsewhere,
        ...(options.actions ? { mergeVerification } : {}),
        ...can(...(mergeVerification.state === "verified" ? ["approve", "decline"] as const : mergeVerification.state === "unverified" ? ["verify_approver"] as const : []), "abort"),
      };
    }
    case "deploy":
    case "rounds":
      // Approving, declining and allowing rounds are decisions for the approvers, in Slack. The console can only stop the run.
      return { summary: summary ?? "Waiting for a person.", elsewhere, ...can("abort") };
    case "decide": {
      const optional = pinnedWorkflow(run)?.stages.find((candidate) => candidate.name === stage)?.optional === true;
      return { summary: summary ?? `${stage} was interrupted by a restart.`, elsewhere, ...can("retry", ...(optional ? ["skip" as const] : []), "abort") };
    }
    case "failed": {
      const answers = recovery?.answers ?? ["retry", "abort"];
      return {
        summary: summary ?? `${stage} failed.`, elsewhere, ...can(...answers),
        ...(options.actions && answers.includes("restart_from") ? { restartFrom: recovery?.restartFrom ?? [] } : {}),
      };
    }
    default:
      return { summary: summary ?? `Waiting (${run.status.replace("_", " ")}).`, elsewhere: elsewhere.length ? elsewhere : [ASK_AGENT], ...can("abort") };
  }
}
