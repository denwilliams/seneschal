import type { OperatorConfig } from "../config/operator.ts";
import { buildThreadToolSet } from "../agent/session.ts";
import { headlessParent, type SubagentHost } from "../agent/subagent-task.ts";
import type { SubagentParent } from "../agent/subagents.ts";
import { timelineForChannel } from "../agent/timeline.ts";
import { createLabels, ghRunner } from "../factory/workflow/github.ts";
import type { IntakeRepoData } from "../factory/workflow/intake-docs.ts";
import { factoryLabels, wantsLabels, type FactoryLabels, type LabelKeeper, type LabelsOutcome } from "../factory/workflow/labels.ts";
import { workflowProblem } from "../factory/workflow/service.ts";
import type { FactoryRunData } from "../factory/workflow/docs.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { logger } from "../util/log.ts";

/**
 * What the app hands the channel runtimes so a software factory workflow run can work with no turn above it. Kept out of the app
 * class so the same code is what the tests run.
 */

/** The roles of a run are started under a parent made from the run, with the channel's own timeline; `onSubagentMessage` is the spend accounting. */
export function appSubagentHost(app: {
  harnessName(): string;
  botUserId(): string;
  defaultTimezone(): string;
  configuratorConfig?(): OperatorConfig;
  onSubagentMessage: (channel: ResolvedChannel) => SubagentParent["onSubagentMessage"];
}): SubagentHost {
  return {
    parent: (channel, runId) => ({
      ...headlessParent(channel, runId, {
        harnessName: app.harnessName(), botUserId: app.botUserId(), defaultTimezone: app.defaultTimezone(), timeline: timelineForChannel(channel),
        onViolation: (m) => logger.warn(`[jail] ${channel.ref.id}: ${m}`),
        onSubagentMessage: app.onSubagentMessage(channel),
      }),
      ...(app.configuratorConfig ? { configuratorConfig: app.configuratorConfig() } : {}),
    }),
    buildToolSet: (runOpts) => buildThreadToolSet(runOpts, { current: () => undefined, set: async () => { throw new Error("A subagent cannot switch models."); } }),
  };
}

/** Why a live run may not carry on after a restart under today's configuration, or undefined: the recovery gate's question. */
export function factoryRunProblem(channel: ResolvedChannel): (run: FactoryRunData) => string | undefined {
  return (run) =>
    workflowProblem(channel) ??
    (channel.factory?.repositories.some((repo) => repo.toLowerCase() === run.repo.toLowerCase()) ? undefined : `${run.repo} is no longer one of this factory's repositories`);
}

/**
 * Make sure a factory channel's GitHub labels exist (labels.ts), if it files issues or watches for them and its workflow can run.
 * A channel that no longer wants them is forgotten, so turning it back on checks again. Best effort: nothing here throws, and the
 * outcome is also kept in the channel's intake record, where the console reads it.
 */
export async function ensureChannelLabels(
  keeper: LabelKeeper, channel: ResolvedChannel,
  options: { api?: FactoryLabels; store?: { mutateFactoryIntake?(repo: string, change: (data: IntakeRepoData) => void): Promise<void> }; force?: boolean; changed?: () => void } = {},
): Promise<LabelsOutcome[]> {
  const factory = channel.factory;
  if (!factory || !wantsLabels(factory) || workflowProblem(channel)) {
    keeper.forget(channel.ref.id);
    return [];
  }
  try {
    return await keeper.ensure({
      channelId: channel.ref.id, repositories: factory.repositories, labels: factoryLabels(factory),
      api: options.api ?? createLabels(ghRunner(channel.env)), ...(options.force ? { force: true } : {}),
      record: async (outcome) => {
        await options.store?.mutateFactoryIntake?.(outcome.repo, (data) => { data.labels = { checkedAt: outcome.checkedAt, created: outcome.created, error: outcome.error }; });
        options.changed?.();
      },
    });
  } catch (error) {
    logger.warn(`factory labels for ${channel.ref.id}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
