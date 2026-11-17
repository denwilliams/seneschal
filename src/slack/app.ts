import { TurnSteering, steeringText } from "../agent/steering.ts";
import { isSubagentRunKey } from "../agent/durable/channel-store.ts";
import { approvalCapabilities } from "../workspace/subagents.ts";
import { ConsoleMergeApprovals, CONSOLE_MERGE_VERIFY_ACTION } from "../factory/workflow/console-approvals.ts";
import { canApprove, resolveMergeRules } from "../factory/workflow/merge.ts";
import { ConsoleConnectorOAuth, CONSOLE_OAUTH_ACTION, type ConsoleOAuthTarget, type BrowserOAuthTarget } from "../agent/consoleConnectorOAuth.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import pkg from "@slack/bolt";
const { App } = pkg;
import type { WebClient } from "@slack/web-api";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { DelegationTargetConfig, HarnessConfig, PermissionsConfig } from "../config/schema.ts";
import { keychainRiskWarning } from "../config/keychain-policy.ts";
import { openBaoRiskWarning } from "../config/openbao-policy.ts";
import { loadConfig, REPO_ROOT } from "../config/load.ts";
import { initializeOpenBao } from "../config/openbao.ts";
import { validateKeychainHost } from "../config/keychain.ts";
import { resolveChannel, type ResolvedChannel } from "../workspace/resolve.ts";
import { findChannel, type ConsoleSource } from "../console2/data.ts";
import type { StatusSource } from "../console/status.ts";
import { webServerPlan } from "../artifacts/server.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { hasLegacyTranscript, isThreadActive, markThreadActive, threadSessionDir } from "../workspace/paths.ts";
import {
  SessionPool,
  createThreadSession,
  bindRecoveredThread,
  withChannelRuntime,
  type CreateThreadSessionOptions,
} from "../agent/session.ts";
import { ChannelRuntimes, channelStoreDir, type ChannelRuntime } from "../agent/channel-runtime.ts";
import { recoverChannel, type RecoveryOutcome } from "../agent/recovery.ts";
import { storeTranscriptSource } from "../agent/transcripts.ts";
import { deliverRecoveredRequest, reconcileDeliveries, storeLedger } from "./delivery.ts";
import { assistantText, type TurnEvent } from "../agent/turn-events.ts";
import { Scheduler, type ScheduledTaskRunResult } from "./scheduler.ts";
import { scheduledPrompt, quietScheduledPrompt } from "./scheduled-prompts.ts";
import { Dreamer } from "./dreamer.ts";
import { FeedbackDigester } from "./digest.ts";
import { ChannelTopicUsageIndicator } from "./topic-usage.ts";
import { postStartupNotice } from "./startup.ts";
import { DigestState, FeedbackLog, buildDigest } from "../agent/feedback.ts";
import { channelPaths, sharedPaths } from "../workspace/paths.ts";
import { escapeSlack, SubagentProgressPoster } from "./subagent-progress.ts";
import { ConfigEditError, editConfig, readConfig, type ConfigEdit } from "../config/edit.ts";
import { CapabilityRequests } from "../config/capability-requests.ts";
import { capabilityBlocks, CAPABILITY_APPROVE, CAPABILITY_DENY, decideCapabilityRequest } from "./capability-requests.ts";
import { buildConfigApprovalBlocks, CONFIG_APPROVE_ACTION, CONFIG_DENY_ACTION, decidedConfigBlocks, PendingConfigChanges, summariseChanges } from "./config-approvals.ts";
import type { AdminConfigService } from "../agent/admin-config-tools.ts";
import { carriesPostAsFooter, createUserClient, PostAsService, type PostAsServiceDeps } from "./post-as.ts";
import { HELD_DISMISS_ACTION, HELD_UNBLOCK_ACTION, PendingHeldPosts } from "./held-posts.ts";
import { decideHeldPost } from "./post-as-clicks.ts";
import { RateLimiter } from "../agent/post-as-guard.ts";
import { reviewDraft } from "../agent/post-as-reviewer.ts";
import { userTokensFor } from "../agent/slack-user-tokens.ts";
import { closeInterruptedRuns, timelineFor, timelineForChannel } from "../agent/timeline.ts";
import { ChannelActivityLog, recordPresenceActivity } from "../agent/activity.ts";
import {
  appendDreamLog,
  collectDreamContext,
  describeOutcome,
  dreamPrompt,
  keepDreamTranscript,
  recordDream,
  recordDreamFailure,
  worthDreaming,
  DREAM_THREAD_KEY,
  type DreamLogEntry,
  type DreamSettings,
} from "../agent/dream.ts";
import { MemoryFile } from "../agent/memory-store.ts";
import { RecentConversationList, summarizeRecentConversation } from "../agent/recent-conversations.ts";
import type { ScheduledTask } from "../agent/schedules.ts";
import type { ChannelPoster, CrossChannelPoster } from "../agent/post-tools.ts";
import {
  cannedResponseActionId,
  INTERACTIVE_RESPONSE_ACTION_PREFIX,
  type CannedResponse,
  type InteractiveResponseService,
} from "../agent/interactive-tools.ts";
import type { FileUploader } from "../agent/file-tools.ts";
import type { ChannelDelegator, DelegationResult } from "../agent/delegation-tools.ts";
import type { PermissionService } from "../agent/permission-tools.ts";
import { GrantStore, describeCapability, type Capability } from "../agent/grants.ts";
import {
  APPROVE_ACTION,
  DENY_ACTION,
  buildApprovalBlocks,
  decidedBlocks,
  decodePayload,
} from "./approvals.ts";
import {
  answeredInteractiveResponseBlocks,
  buildInteractiveResponseBlocks,
  decodeInteractiveResponsePayload,
  interactiveResponsePrompt,
} from "./interactions.ts";
import { checkRequirements, describeMissing } from "../config/requirements.ts";
import { SlackResponseStream } from "./stream.ts";
import { isCommand, runCommand, type ConfigReloadResult } from "./commands.ts";
import { stripMention, toMrkdwn } from "./format.ts";
import { collectFiles, modelAcceptsImages, type ImageAttachment, type SlackFile } from "./files.ts";
import { fetchBackfill, UserDirectory } from "./history.ts";
import {
  reactionPrompt,
  reactionReadPrompt,
  reactionRequestId,
  reactionTargetsBot,
  reactionTurn,
  type ReactionMessage,
  type SlackReactionEvent,
} from "./reactions.ts";
import { startSandboxCleanup, stopAllSandboxes } from "../agent/sandbox.ts";
import { listModels, resolveModel } from "../agent/model.ts";
import { UsageLog, type UsageSource } from "../agent/usage.ts";
import { ScheduleStore } from "../agent/schedules.ts";
import { channelsToOpen, shouldReopenFailedStore } from "./store-lifecycle.ts";
import { jobProblem } from "../jobs/policy.ts";
import { createFactoryBackend, scopedFactoryStore } from "../factory/workflow/backend.ts";
import type { OperatorConfig } from "../config/operator.ts";
import { appSubagentHost, ensureChannelLabels, factoryRunProblem } from "./factory-wiring.ts";
import { TaskWorkflowPresence } from "./task-workflow-presence.ts";
import { FactoryPresence } from "./factory-presence.ts";
import { decideFactoryRunClick, FACTORY_CHANGES_VIEW, submitFactoryRunChanges } from "./factory-clicks.ts";
import { FACTORY_ACTION_PREFIX } from "./factory-render.ts";
import { appendFactoryAudit, createFactoryRunService, workflowProblem } from "../factory/workflow/service.ts";
import { isTerminalRun } from "../factory/workflow/docs.ts";
import { IntakeLoop } from "../factory/workflow/intake-loop.ts";
import { pollIntake, type IntakeOutcome } from "../factory/workflow/intake.ts";
import { isLabelMissingError, LabelKeeper } from "../factory/workflow/labels.ts";
import type { Console2Actions, Console2Source } from "../console2/source.ts";
import { AgentTurnOutcome } from "../agent/turn-outcome.ts";
import { redactTaskUrls, substantivePromptKind, TaskRunTracker, TaskStatusStore } from "../tasks/store.ts";
import { logger } from "../util/log.ts";

const SEND_TO_ASSISTANT_SHORTCUT = "send_to_assistant";
const SEND_TO_ASSISTANT_VIEW = "send_to_assistant_view";
const SEND_TO_ASSISTANT_TARGET_BLOCK = "target_channel";
const SEND_TO_ASSISTANT_TARGET_ACTION = "target";
const SEND_TO_ASSISTANT_PROMPT_BLOCK = "prompt";
const SEND_TO_ASSISTANT_PROMPT_ACTION = "text";
const SEND_TO_ASSISTANT_FILES_BLOCK = "include_files";
const SEND_TO_ASSISTANT_FILES_ACTION = "value";
const SEND_TO_ASSISTANT_FILES_VALUE = "include";
const MAX_MODAL_PROMPT_CHARS = 2900;
const SEND_TO_ASSISTANT_REQUEST_TTL_MS = 30 * 60_000;
const MAX_DELEGATION_TASK_SUMMARY_CHARS = 280;
const MAX_DELEGATION_RESULT_CHARS = 12_000;

export function shouldRenderNoResponseForAgentError(err: unknown, modelRef?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const haystack = `${modelRef ?? ""}\n${message}`.toLowerCase();
  if (!/(?:^|[\s/])openai-codex(?:[\s/]|$)|codex/.test(haystack)) return false;

  const lower = message.toLowerCase();
  // Context/token-size failures are actionable prompt problems, not subscription
  // exhaustion, even though they often say "limit exceeded".
  if (/(context|token).{0,40}(length|window|limit)|maximum context/.test(lower)) return false;

  return (
    /(?:usage|quota|insufficient_quota|too many requests|rate[_ -]?limit|429)/i.test(message) ||
    /(?:reached|hit|exceeded|exhausted|out of).{0,80}(?:limit|usage)/i.test(message) ||
    /(?:limit|usage).{0,80}(?:reached|hit|exceeded|exhausted)/i.test(message)
  );
}

export interface SendToAssistantSource {
  channelId: string;
  channelName?: string;
  messageTs: string;
  messageText: string;
  messageUserId?: string;
  files?: SlackFile[];
}

export function shortcutAllowedByDefault(
  defaultAllowUsers: readonly string[] | undefined,
  userId: string,
): boolean {
  return !defaultAllowUsers || defaultAllowUsers.includes(userId);
}

export function modalOriginalMessagePreview(text: string, hasFiles = false): string {
  const preview = text.trim() || (hasFiles ? "_No message text; attachments are selected below._" : "_No message text._");
  if (preview.length <= MAX_MODAL_PROMPT_CHARS) return preview;
  return `${preview.slice(0, MAX_MODAL_PROMPT_CHARS - 1)}…`;
}

export function sendToAssistantTargetRef(
  selectedConversation: string | undefined,
  defaultChannel: string | undefined,
): { ref: string; fromDefault: boolean } | undefined {
  const selected = selectedConversation?.trim();
  if (selected) return { ref: selected, fromDefault: false };

  const fallback = defaultChannel?.trim();
  return fallback ? { ref: fallback, fromDefault: true } : undefined;
}

export const THREAD_MENTION_PROMPT = "Please read the thread up to here and weigh in.";

export function promptForIncomingMessage(input: {
  text: string;
  botUserId: string;
  threadTs?: string;
  files?: readonly unknown[];
}): string {
  const prompt = stripMention(input.text, input.botUserId);
  if (prompt) return prompt;

  const mentionOnlyThread =
    input.threadTs !== undefined &&
    input.text.includes(`<@${input.botUserId}>`) &&
    (input.files?.length ?? 0) === 0;

  return mentionOnlyThread ? THREAD_MENTION_PROMPT : "";
}

export function buildSendToAssistantPrompt(input: {
  submittedBy: string;
  instructions: string;
  source: SendToAssistantSource;
  sourcePermalink?: string;
  includeFiles: boolean;
}): string {
  const sourceLabel = input.source.channelName
    ? `#${input.source.channelName}`
    : `<#${input.source.channelId}>`;
  const files = input.source.files?.length ?? 0;
  return [
    "A Slack message from another channel was sent to this assistant for processing.",
    `Submitted by: <@${input.submittedBy}>`,
    input.source.messageUserId ? `Original author: <@${input.source.messageUserId}>` : undefined,
    input.sourcePermalink
      ? `Original message: ${input.sourcePermalink}`
      : `Original message: ${sourceLabel} at ${input.source.messageTs}`,
    files > 0
      ? `Original attachments: ${files} file(s)${input.includeFiles ? " included with this turn" : " not included"}.`
      : undefined,
    "",
    "Original message text (copied unchanged):",
    input.source.messageText || "(no message text)",
    "",
    "Additional instructions:",
    input.instructions.trim() || "(none)",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}


function delegationTaskSummary(task: string): string {
  const normalized = task.trim().replace(/\s+/g, " ");
  const codePoints = Array.from(normalized);
  if (codePoints.length <= MAX_DELEGATION_TASK_SUMMARY_CHARS) return normalized;
  return `${codePoints.slice(0, MAX_DELEGATION_TASK_SUMMARY_CHARS - 1).join("").trimEnd()}…`;
}

export function buildDelegationNotification(input: {
  targetChannelLabel: string;
  sourceChannelLabel: string;
  sourceThreadPermalink?: string;
  task: string;
  context?: string;
  requestedBy: string;
}): string {
  return [
    `:arrow_forward: *Task transferred to ${input.targetChannelLabel}*.`,
    `*Summary:* ${delegationTaskSummary(input.task)}`,
    `From ${input.sourceChannelLabel} by <@${input.requestedBy}>.`,
    input.context?.trim() ? `*Context:* ${input.context.trim()}` : undefined,
    input.sourceThreadPermalink ? `Source: ${input.sourceThreadPermalink}` : undefined,
    "Discuss it in this thread.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function buildDelegationPrompt(input: {
  requestedBy: string;
  sourceChannelLabel: string;
  sourceThreadPermalink?: string;
  task: string;
  context?: string;
}): string {
  return [
    "A task was transferred to this channel assistant because this channel is expected to have the right tools, connectors, memory, or context.",
    `Requested by: <@${input.requestedBy}>`,
    input.sourceThreadPermalink
      ? `Source thread: ${input.sourceThreadPermalink}`
      : `Source channel: ${input.sourceChannelLabel}`,
    "",
    "Do the work here in this thread. When this initial task completes, its result or failure will be posted automatically to the source thread.",
    "",
    "Task:",
    input.task.trim(),
    input.context?.trim() ? "" : undefined,
    input.context?.trim() ? "Context copied from the source conversation:" : undefined,
    input.context?.trim() || undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export interface DelegationCompletion {
  status: "completed" | "failed";
  targetChannelLabel: string;
  targetPermalink?: string;
  text?: string;
  postedDirectly?: boolean;
  /** The task completed, but Slack could not render its final target reply. */
  deliveryError?: string;
  error?: string;
}

function limitDelegationResult(text: string): string {
  if (text.length <= MAX_DELEGATION_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_DELEGATION_RESULT_CHARS - 1)}…`;
}

/** Format the only cross-channel write delegation permits: its own outcome. */
export function formatDelegationCompletion(completion: DelegationCompletion): string {
  const target = completion.targetPermalink
    ? `<${completion.targetPermalink}|${completion.targetChannelLabel}>`
    : completion.targetChannelLabel;

  if (completion.status === "failed") {
    return [
      `:warning: *Delegated task failed in ${target}.*`,
      completion.error ? `Error: ${limitDelegationResult(completion.error)}` : undefined,
      "See the delegated thread for details.",
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  const deliveryNotice = completion.deliveryError
    ? [
        `:warning: The task completed, but Slack could not publish the target assistant's final reply in ${target}.`,
        `Delivery error: ${limitDelegationResult(completion.deliveryError)}`,
      ]
    : [];

  if (!completion.text?.trim()) {
    return [
      `:white_check_mark: *Delegated task completed in ${target}.*` +
        (completion.postedDirectly
          ? " The assistant published its deliverable directly in the delegated channel."
          : completion.deliveryError
            ? ""
            : " See the delegated thread for details."),
      ...deliveryNotice,
    ].join("\n");
  }

  return [
    `:white_check_mark: *Delegated task completed in ${target}.*`,
    ...deliveryNotice,
    "Result:",
    limitDelegationResult(completion.text.trim()),
  ].join("\n");
}

export interface DelegationCompletionRoute extends DelegationCompletion {
  sourceChannelId: string;
  sourceThreadTs: string;
  sourceUserId: string;
}

/**
 * Frame a delegated outcome as an internal turn, rather than waiting for the
 * bot-authored Slack callback to re-enter through the public message handler.
 */
export function buildDelegationCompletionPrompt(completion: DelegationCompletion): string {
  return [
    "A delegated task has reported its outcome in this thread.",
    "Treat this as a continuation of the current task: assess the outcome and take any appropriate next step without waiting for another mention.",
    "",
    "[Harness notification — delegated task outcome]",
    formatDelegationCompletion(completion),
  ].join("\n");
}

/** Post a delegated turn outcome only to the source thread that started it. */
export async function routeDelegationCompletion(
  poster: Pick<ChannelPoster, "post">,
  input: DelegationCompletionRoute,
): Promise<{ ts: string; permalink?: string }> {
  return poster.post({
    channelId: input.sourceChannelId,
    threadTs: input.sourceThreadTs,
    text: formatDelegationCompletion(input),
  });
}

/**
 * Report exactly one outcome for the delegated initial run. Follow-up turns
 * are separate runs and are intentionally not passed to this function.
 */
export async function reportDelegatedRun(
  run: Promise<DelegatedRunResult>,
  route: Omit<DelegationCompletionRoute, "status" | "text" | "postedDirectly" | "deliveryError" | "error">,
  report: (completion: DelegationCompletionRoute) => Promise<void>,
): Promise<void> {
  let result: DelegatedRunResult;
  try {
    result = await run;
  } catch (err) {
    result = { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  await report({ ...route, ...result });
}

export interface HarnessAppOptions {
  config: HarnessConfig;
  dataDir: string;
  botToken: string;
  appToken: string;
  /** One credential store for the whole harness; see agent/credentials.ts. */
  modelRuntime: ModelRuntime;
  /** Absolute path to the YAML file this process booted from. */
  configPath: string;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return Boolean(message && (message as { role?: string }).role === "assistant" && (message as AssistantMessage).usage);
}

function recordUsage(input: {
  channel: ResolvedChannel;
  threadKey?: string;
  source: UsageSource;
  message: AssistantMessage;
}): void {
  try {
    new UsageLog(input.channel.shared).appendAssistantMessage({
      channelId: input.channel.ref.id,
      channelName: input.channel.ref.name,
      threadKey: input.threadKey,
      source: input.source,
      message: input.message,
    });
  } catch (err) {
    logger.warn(
      `usage: failed to record ${input.source} call for ${input.channel.ref.id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Keep agent-facing artifact URLs aligned with the server bound at startup. */
export function preserveActiveArtifactConfig(active: HarnessConfig, loaded: HarnessConfig): HarnessConfig {
  return { ...loaded, webConsole: active.webConsole };
}

export function configReloadWarnings(
  previous: HarnessConfig,
  next: HarnessConfig,
  activeDataDir: string,
  loadedDataDir: string,
): string[] {
  const warnings: string[] = [openBaoRiskWarning(next), keychainRiskWarning(next)].filter((warning): warning is string => Boolean(warning));
  if (activeDataDir !== loadedDataDir) {
    warnings.push(`dataDir changed to ${loadedDataDir}; this process keeps using ${activeDataDir} until restart.`);
  }
  if (previous.authPath !== next.authPath) {
    warnings.push("authPath changed; restart to move the credential store.");
  }
  if (!isDeepStrictEqual(previous.modelProviders, next.modelProviders)) {
    warnings.push("modelProviders changed; restart to register provider additions/removals.");
  }
  if (!isDeepStrictEqual(previous.schedules, next.schedules)) {
    warnings.push("top-level schedules settings changed; restart to rebuild existing schedule timers/limits.");
  }
  if (!isDeepStrictEqual(previous.channelTopicUsage, next.channelTopicUsage)) {
    warnings.push("channel topic usage settings changed; restart to rebuild its timer.");
  }
  if (!isDeepStrictEqual(previous.webConsole, next.webConsole)) {
    warnings.push("web console settings changed; restart to rebind the web server.");
  }
  if (!isDeepStrictEqual(previous.dreams, next.dreams)) {
    warnings.push("top-level dreams settings changed; restart to rebuild overnight timers.");
  }
  if (!isDeepStrictEqual(previous.backups, next.backups)) {
    warnings.push("backups settings changed; restart to rebuild the backup timer.");
  }
  const previousFeedbackTimer = {
    digestChannel: previous.feedback.digestChannel,
    cron: previous.feedback.cron,
    timezone: previous.feedback.timezone,
  };
  const nextFeedbackTimer = {
    digestChannel: next.feedback.digestChannel,
    cron: next.feedback.cron,
    timezone: next.feedback.timezone,
  };
  if (!isDeepStrictEqual(previousFeedbackTimer, nextFeedbackTimer)) {
    warnings.push("feedback digest timer settings changed; restart to rebuild the digest timer.");
  }
  return warnings;
}

/** Decide whether a Slack `message` event should become an agent turn. */
export function shouldHandleMessageEvent(input: {
  isDm: boolean;
  inActiveThread: boolean;
  isRootMessage: boolean;
  mentionsBot: boolean;
  respondToRootMessages: boolean;
}): boolean {
  if (input.isDm) return true;
  // app_mention handles explicit channel mentions. Returning false here avoids
  // running the same turn twice when a channel also listens to every root post.
  if (input.mentionsBot) return false;
  if (input.inActiveThread) return true;
  return input.isRootMessage && input.respondToRootMessages;
}

/**
 * The config that would make a capability permanent.
 *
 * A grant lives in `data/`, which means it is invisible in review and vanishes
 * if the directory is cleared. If something is genuinely always-on it belongs
 * in the config, so the approval says exactly which line to add.
 */
function configHintFor(capability: Capability): string {
  switch (capability) {
    case "network":
      return "sandbox:\n  network: bridge";
    case "web":
      return "tools: [read, write, edit, ls, find, grep, web]";
    case "bash":
      return "tools: [read, write, edit, ls, find, grep, bash]";
    case "memoryWrite":
      return "share:\n  memoryWrite: true";
    case "skillPublish":
      return "share:\n  libraryPublish: true";
    default:
      if (capability.startsWith("subagent:")) {
        return `# to run ${capability.slice("subagent:".length)} without asking, set requireApproval: false on it in agentSets`;
      }
      return capability.startsWith("connector:")
        ? `share:\n  connectors: [${capability.slice("connector:".length)}]`
        : `# enable ${capability} in this channel's config`;
  }
}

type ActiveSlackTurn = { requestId: string; userId: string; threadKey: string; inbox: TurnSteering; run: Promise<AgentRunResult> };

interface IncomingMessage {
  arrivalRecorded?: boolean;
  steeringTarget?: ActiveSlackTurn;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  channelType?: string;
  files?: SlackFile[];
}

export interface DelegatedRunResult {
  status: "completed" | "failed";
  text?: string;
  postedDirectly?: boolean;
  /** The model finished, but Slack failed while rendering the final reply. */
  deliveryError?: string;
  error?: string;
}

type AgentRunResult = DelegatedRunResult;

/** Convert the agent's explicit outcome into the scheduler's durable outcome. */
export function shouldResumeWaitingTask(
  tasks: Pick<TaskStatusStore, "hasWaiting">,
  channelId: string,
  threadKey: string,
): boolean {
  return tasks.hasWaiting(channelId, threadKey);
}

export function scheduledRunResult(
  result: Pick<AgentRunResult, "status" | "error">,
  slackOutputUrl?: string,
): ScheduledTaskRunResult {
  if (result.status !== "completed") {
    return {
      status: "failed",
      error: result.error || "Scheduled agent run did not complete.",
      ...(slackOutputUrl ? { slackOutputUrl } : {}),
    };
  }
  return { status: "completed", ...(slackOutputUrl ? { slackOutputUrl } : {}) };
}

interface AgentReplyRenderer {
  close(finalText?: string): Promise<void>;
  discard(): Promise<void>;
}

/**
 * Rendering is a delivery concern, not task execution. A completed target
 * task can still return its result to the source if Slack rejects its final
 * target-thread reply.
 */
export async function finishAgentReply(
  renderer: AgentReplyRenderer,
  final: string | undefined,
  postedDirectly: boolean,
): Promise<{ deliveryError?: string }> {
  try {
    if (postedDirectly && !final?.trim()) {
      await renderer.discard();
    } else {
      await renderer.close(final);
    }
    return {};
  } catch (err) {
    return { deliveryError: err instanceof Error ? err.message : String(err) };
  }
}

/** Preserve the agent failure if Slack cannot render its no-response notice. */
export async function finishNoResponseAgentFailure(
  renderer: AgentReplyRenderer,
  error: string,
): Promise<DelegatedRunResult> {
  const delivery = await finishAgentReply(renderer, "", false);
  return { status: "failed", error, ...delivery };
}

export class HarnessApp implements ChannelPoster, CrossChannelPoster, FileUploader, ChannelDelegator, PermissionService, InteractiveResponseService {
  private readonly app: InstanceType<typeof App>;
  private readonly pool = new SessionPool();
  /** One Durable store per channel, shared by every thread session in it. */
  private readonly runtimes: ChannelRuntimes;
  private console2Stores?: { usage: UsageLog; schedules: ScheduleStore };
  /** When each channel store last failed, so one that keeps failing is not reopened in a loop. */
  private readonly storeFailures = new Map<string, number>();
  /** Requests whose answer a restart-recovery is delivering right now; a redelivered event for one must not also reply. */
  private readonly resumedRequests = new Set<string>();
  readonly connectorOAuth?: ConsoleConnectorOAuth;
  private readonly registry: ChannelRegistry;
  private readonly taskStore: TaskStatusStore;
  private readonly channelNames = new Map<string, string>();
  /** Channel name -> id for `postTo` targets found by listing channels. */
  private readonly postTargetIds = new Map<string, string>();
  private botUserId = "";
  private readonly opts: HarnessAppOptions;
  private config: HarnessConfig;
  private readonly scheduler: Scheduler;
  private readonly dreamer: Dreamer;
  private readonly dreamSettings: DreamSettings;
  private readonly digester: FeedbackDigester;
  private readonly topicUsageIndicator: ChannelTopicUsageIndicator;
  private readonly grants: GrantStore;
  /** Slack user ids to names, for rendering history. Shared across channels:
   *  a display name is workspace-wide and is not a channel's secret. */
  private readonly users: UserDirectory;
  /** Where an in-flight turn is happening, so a request lands in that thread. */
  private readonly pendingThread = new Map<string, string>();
  private readonly pendingUser = new Map<string, string>();
  /** Config changes the admin agent has asked for and a person has yet to approve. */
  private readonly configApprovals = new PendingConfigChanges();
  private capabilityRequestService?: CapabilityRequests;
  /** Posting as a person (post_as_user): one service, one held-post store and one rate limiter for the process. */
  readonly postAs: PostAsService;
  /** Each workflow run's status post and thread in Slack. */
  private readonly factoryPresence: FactoryPresence;
  private readonly taskWorkflowPresence: TaskWorkflowPresence;
  private readonly consoleMergeApprovals: ConsoleMergeApprovals;
  /** One poll loop per factory channel with issue intake on: new issues get runs, changed issues send updates to theirs. */
  private readonly intakeLoop: IntakeLoop;
  /** Keeps each factory's GitHub labels in existence: at startup, after a reload, and when something fails on a missing one. */
  private readonly factoryLabels = new LabelKeeper({ now: () => Date.now(), audit: (channelId, event, fields) => { const channel = this.channelNow(channelId); if (channel) appendFactoryAudit(channel, event, fields); } });
  /** Per conversation, serialize whole responses; incoming Slack follow-ups can steer the owner. */
  private readonly turnQueue = new Map<string, Promise<AgentRunResult>>();
  private turnSteering = new Map<string, ActiveSlackTurn>();
  /** Message shortcut payloads are too large for modal metadata, so keep them briefly in memory. */
  private readonly sendToAssistantRequests = new Map<
    string,
    { userId: string; source: SendToAssistantSource; createdAt: number }
  >();
  private reactionReadWarned = false;
  /** Debounced background updates for the prompt's recent-conversations list. */
  private readonly recentConversationTimers = new Map<string, NodeJS.Timeout>();
  /** Locally claim a clicked component before replacing its buttons. */
  private readonly claimedInteractiveResponses = new Set<string>();

  constructor(opts: HarnessAppOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.runtimes = new ChannelRuntimes({
      modelRuntime: opts.modelRuntime,
      // What a background task (a software factory workflow run) needs to run a subagent with no turn above it: the same roles,
      // tools and accounting as a subagent a live turn starts, under a parent made from the run.
      subagentHost: appSubagentHost({
        harnessName: () => this.config.name, botUserId: () => this.botUserId, defaultTimezone: () => this.config.schedules.timezone,
        configuratorConfig: () => this.configuratorConfig(),
        onSubagentMessage: (channel) => ({ runKey, message }) => recordUsage({ channel, threadKey: runKey, source: "subagent", message }),
      }),
      onTaskWorkflowChange: (channel, workflow) => this.taskWorkflowPresence?.notify(channel.ref.id, workflow, channel.ref.isDm),
      onFactoryRunChange: (channel, run) => {
        this.factoryPresence?.notify(channel, run);
        // A finished run frees a slot: look for an issue that was queued for one.
        if (isTerminalRun(run.status)) this.intakeLoop?.pollNow(channel.ref.id);
      },
      gate: async (runtime) => { await this.recoverInterruptedWork(runtime); },
      onFailed: (channelId) => this.reopenFailedStore(channelId),
    });
    this.registry = new ChannelRegistry(opts.dataDir);
    this.taskStore = new TaskStatusStore(opts.dataDir);
    this.grants = new GrantStore(opts.dataDir);
    this.scheduler = new Scheduler(
      opts.dataDir,
      {
        maxPerChannel: opts.config.schedules.maxPerChannel,
        minIntervalMinutes: opts.config.schedules.minIntervalMinutes,
        defaultTimezone: opts.config.schedules.timezone,
      },
      (task) => this.runScheduledTask(task),
    );
    this.dreamSettings = {
      enabled: opts.config.dreams.enabled,
      cron: opts.config.dreams.cron,
      // Dreams inherit the schedules timezone unless told otherwise: both
      // answer the same question — what "overnight" means where this harness
      // lives — and two settings for one answer is one too many.
      timezone: opts.config.dreams.timezone ?? opts.config.schedules.timezone,
      forgetAfterDays: opts.config.dreams.forgetAfterDays,
      maxConversations: opts.config.dreams.maxConversations,
      keepTranscripts: opts.config.dreams.keepTranscripts,
      announce: opts.config.dreams.announce,
    };
    this.dreamer = new Dreamer(this.dreamSettings, this.registry, (id) => this.runDream(id));
    this.digester = new FeedbackDigester(
      {
        channel: opts.config.feedback.digestChannel,
        cron: opts.config.feedback.cron,
        // Same reasoning as dreams: "when is it quiet here" is one question,
        // and it should not have three answers.
        timezone: opts.config.feedback.timezone ?? opts.config.schedules.timezone,
      },
      async () => {
        await this.postFeedbackDigest();
      },
    );
    this.topicUsageIndicator = new ChannelTopicUsageIndicator(
      {
        enabled: opts.config.channelTopicUsage.enabled,
        channel: opts.config.channelTopicUsage.channel,
        timezone: opts.config.schedules.timezone,
      },
      {
        log: new UsageLog(sharedPaths(opts.dataDir)),
        resolveChannel: (configured) => this.registry.resolveId(configured),
        botUserId: () => this.botUserId,
        getChannel: async (channelId) => {
          const channel = (
            await this.app.client.conversations.info({ channel: channelId })
          ).channel as {
            topic?: { value?: string; creator?: string };
            is_channel?: boolean;
            is_private?: boolean;
          } | undefined;
          const topic = channel?.topic;
          // Require Slack to positively identify a public channel. This keeps
          // the feature on channels:write.topic and refuses private/unknown
          // conversation types rather than requesting groups:write.topic.
          const isPrivate = !(channel?.is_channel === true && channel.is_private === false);
          return {
            topic: { value: topic?.value ?? "", ...(topic?.creator ? { creator: topic.creator } : {}) },
            isPrivate,
          };
        },
        setTopic: async (channelId, topic) => {
          await this.app.client.conversations.setTopic({ channel: channelId, topic });
        },
      },
    );
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
      logLevel: (process.env.SLACK_LOG_LEVEL as any) ?? undefined,
    });
    this.factoryPresence = new FactoryPresence({
      store: (channelId) => this.runtimes.peek(channelId)?.store,
      slack: {
        // Nothing in a run's post may notify or unfurl by itself: the text is the harness's own and Slack is told not to parse it.
        post: async ({ channel, threadTs, text, blocks, interaction }) => {
          const sent = await this.app.client.chat.postMessage({
            channel, ...(threadTs ? { thread_ts: threadTs } : {}), text, blocks: blocks as any, unfurl_links: false, unfurl_media: false, link_names: false, parse: "none",
          });
          if (!sent.ts) throw new Error("Slack did not return a timestamp for the post");
          const log = this.activityOf(channel);
          if (log) recordPresenceActivity(log, { ts: String(sent.ts), text, interaction });
          return { ts: String(sent.ts) };
        },
        update: async ({ channel, ts, text, blocks, interaction }) => {
          const log = this.activityOf(channel);
          if (log) recordPresenceActivity(log, { ts, text, interaction });
          await this.app.client.chat.update({ channel, ts, text, blocks: blocks as any, link_names: false, parse: "none" });
        },
        permalink: async ({ channel, ts }) => (await this.app.client.chat.getPermalink({ channel, message_ts: ts })).permalink,
      },
    });
    this.taskWorkflowPresence = new TaskWorkflowPresence({
      store: (channelId) => this.runtimes.peek(channelId)?.store,
      slack: {
        post: async ({ channel, threadTs, text, blocks }) => {
          const sent = await this.app.client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text, blocks: blocks as any, unfurl_links: false, unfurl_media: false, link_names: false, parse: "none" });
          if (!sent.ts) throw new Error("Slack did not return a timestamp");
          const log = this.activityOf(channel);
          if (log) recordPresenceActivity(log, { ts: String(sent.ts), text });
          return { ts: String(sent.ts) };
        },
        update: async ({ channel, ts, text, blocks }) => {
          await this.app.client.chat.update({ channel, ts, text, blocks: blocks as any, link_names: false, parse: "none" });
          const log = this.activityOf(channel);
          if (log) recordPresenceActivity(log, { ts, text });
        },
        permalink: async ({ channel, ts }) => (await this.app.client.chat.getPermalink({ channel, message_ts: ts })).permalink,
      },
    });
    this.consoleMergeApprovals = new ConsoleMergeApprovals({
      run: async (channelId, runId) => this.runtimes.peek(channelId)?.store.factoryRun(runId),
      allowed: (channelId, run, userId) => {
        const channel = this.channelNow(channelId);
        return !!channel?.factory && channel.factory.repositories.includes(run.repo) && this.config.webConsole.actions && canApprove(userId, resolveMergeRules(channel.factory, run.repo), channel.allowUsers);
      },
      post: async ({ id, challenge, channelId, run }) => {
        const text = `Verify YOUR browser for merge decisions on ${run.repo}#${run.issue}, run ${run.runId}, reviewed commit ${run.pr.reviewedHead.slice(0, 12)}. Challenge: ${challenge}. Confirm ONLY if your own console displays this exact challenge. This does not approve the merge: return to the console to Approve or Decline. Verification expires in 10 minutes and applies only to this wait and reviewed commit.`;
        const sent = await this.app.client.chat.postMessage({ channel: channelId, ...(run.slack.ts ? { thread_ts: run.slack.ts } : {}), text, unfurl_links: false, unfurl_media: false,
          blocks: [
            { type: "section", text: { type: "plain_text", text } },
            { type: "actions", elements: [{ type: "button", action_id: CONSOLE_MERGE_VERIFY_ACTION, text: { type: "plain_text", text: "Verify my matching browser" }, value: id }] },
          ],
        });
        if (sent.ts) this.activityOf(channelId)?.record({ key: `verify:${id}`, sourceTs: sent.ts, kind: "prompt", title: "Browser verification requested", interaction: "pending", ephemeral: true, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      },
    });
    this.intakeLoop = new IntakeLoop({ targets: () => this.intakeTargets(), poll: (channelId) => this.pollFactoryIntake(channelId) });
    if (opts.config.webConsole.oauth) {
      this.connectorOAuth = new ConsoleConnectorOAuth(opts.config.webConsole.oauth, {
        allowed: (target) => this.consoleOAuthAllowed(target),
        browserTarget: (channelId, connectorName) => this.consoleOAuthBrowserTarget(channelId, connectorName),
        webPairing: async ({ id, phrase, target }) => {
          const text = `A browser requested connection of \`${target.connectorName}\` in this channel. Browser pairing challenge: *${phrase}*. Approve ONLY if YOUR browser displays this exact challenge for the connector you requested. The allowed Slack user who approves becomes the authorizing user; credentials are shared with this channel. Console/proxy login does not authorize consent.`;
          const sent = await this.app.client.chat.postMessage({ channel: target.channelId, text, unfurl_links: false, unfurl_media: false,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text } },
              { type: "actions", elements: [
                { type: "button", action_id: `${CONSOLE_OAUTH_ACTION}_approve`, text: { type: "plain_text", text: "Approve my matching browser" }, value: id },
                { type: "button", action_id: `${CONSOLE_OAUTH_ACTION}_deny`, text: { type: "plain_text", text: "Cancel" }, value: id },
              ] },
            ] });
          if (!sent.ts) throw new Error("Slack browser pairing delivery failed.");
          this.activityOf(target.channelId)?.record({ key: `oauth:${id}`, sourceTs: sent.ts, kind: "prompt", title: "Connector browser pairing requested", interaction: "pending", ephemeral: true, expiresAt: new Date(Date.now() + opts.config.webConsole.oauth!.ttlSeconds * 1000).toISOString() });
          return sent.ts;
        },
        notify: async (target, message) => {
          await this.app.client.chat.postMessage({ channel: target.channelId, thread_ts: target.threadTs,
            text: `${target.userId ? `<@${target.userId}> ` : ""}\`${target.connectorName}\` authorization: ${message}`, unfurl_links: false, unfurl_media: false });
        },
        pairing: async ({ id, phrase, target }) => {
          const text = `Connect \`${target.connectorName}\` in this channel. Browser pairing challenge: *${phrase}*. Approve ONLY if your browser displays this exact challenge for the connector you requested. This authorizes a channel-shared credential; proxy/console login is not your Slack identity.`;
          await this.app.client.chat.postEphemeral({ channel: target.channelId, thread_ts: target.threadTs, user: target.userId, text,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text } },
              { type: "actions", elements: [
                { type: "button", action_id: `${CONSOLE_OAUTH_ACTION}_approve`, text: { type: "plain_text", text: "Approve my matching browser" }, value: id },
                { type: "button", action_id: `${CONSOLE_OAUTH_ACTION}_deny`, text: { type: "plain_text", text: "Cancel" }, value: id },
              ] },
            ] });
        },
      });
    }
    this.users = new UserDirectory(this.app.client);
    this.postAs = this.createPostAsService();
    this.wire();
  }

  private consoleOAuthBrowserTarget(channelId: string, connectorName: string): BrowserOAuthTarget | undefined {
    try {
      const source = this.consoleSource();
      const record = findChannel(source, channelId);
      const channel = record ? source.resolve(record) : undefined;
      const connector = channel?.connectors.find((entry) => entry.name === connectorName);
      if (!channel || connector?.config.transport !== "http" || !connector.config.oauth?.consoleCallback
        || connector.config.oauth.tokenFile || connector.config.oauth.redirectUrl !== this.connectorOAuth?.callbackUrl) return undefined;
      return { channelId, connectorName, channelRoot: channel.paths.root, connectorUrl: connector.config.url, oauth: connector.config.oauth };
    } catch { return undefined; }
  }

  private consoleOAuthAllowed(target: ConsoleOAuthTarget): boolean {
    try {
      const { channel } = resolveChannel(this.config, this.opts.dataDir, { id: target.channelId,
        name: this.registry.nameFor(target.channelId), isDm: target.channelId.startsWith("D") }, this.registry);
      if (!target.userId || !channel || (channel.allowUsers && !channel.allowUsers.includes(target.userId))) return false;
      const connector = channel.connectors.find((entry) => entry.name === target.connectorName);
      return connector?.config.transport === "http" && connector.config.url === target.connectorUrl
        && channel.paths.root === target.channelRoot && isDeepStrictEqual(connector.config.oauth, target.oauth);
    } catch { return false; }
  }

  /** Read-only source for the web server's `/api/status`. */
  statusSource(): StatusSource {
    return {
      tasks: this.taskStore,
      channels: () => this.registry.all(),
      configuredChannels: () => Object.keys(this.config.channels),
    };
  }

  /** Read-only source for the web console served beside artifacts. */
  consoleSource(): ConsoleSource {
    return {
      baseUrl: webServerPlan(this.config).baseUrl ?? "http://localhost/",
      dataDir: this.opts.dataDir,
      config: () => this.config,
      tasks: this.taskStore,
      channels: () => this.registry.all(),
      resolve: (channel) => resolveChannel(this.config, this.opts.dataDir, { id: channel.id, ...(channel.name ? { name: channel.name } : {}), isDm: channel.isDm }, this.registry).channel,
    };
  }

  /**
   * Read-only source for webConsole2. It shares the original console's data and adds the durable stores that are already
   * open in this process; it never opens one.
   */
  console2Source(): Console2Source {
    // Built once: the console reads usage through a short-lived cache keyed by this object, and polls every few seconds.
    this.console2Stores ??= { usage: new UsageLog(sharedPaths(this.opts.dataDir)), schedules: new ScheduleStore(this.opts.dataDir) };
    return {
      ...this.consoleSource(),
      runtime: (channelId) => this.runtimes.peek(channelId),
      schedules: this.console2Stores.schedules,
      usage: this.console2Stores.usage,
      contextWindow: (model) => {
        try { return (resolveModel(model, this.opts.modelRuntime) as { contextWindow?: number }).contextWindow; } catch { return undefined; }
      },
      actions: this.console2Actions(),
      admin: { configPath: this.opts.configPath, dataDir: this.opts.dataDir, reload: () => this.reloadConfig() },
    };
  }

  /**
   * What the web console may do to factory runs, if the operator lets it (`webConsole.actions`; the web server decides). The same
   * service the agent's tools use. Merge decisions additionally need run-scoped Slack verification; no direct merge is exposed.
   */
  private console2Actions(): Console2Actions {
    return {
      inspectTaskWorkflow: async (channelId, workflow) => {
        const channel = this.channelNow(channelId);
        const runtime = this.runtimes.peek(channelId);
        if (!channel || !runtime) throw new Error("Channel unavailable.");
        await runtime.store.assertRunnable();
        const current = await runtime.store.taskWorkflow(workflow.id);
        if (!current || current.status !== "active" || current.revision !== workflow.revision) throw new Error("Workflow changed before inspection request.");
        const threadKey = workflow.parentThreadKey;
        const prompt = "Console bump: inspect task workflow " + workflow.id + ". First call check_task_workflow for current state. Resume only appropriate safe activity. Do not duplicate a running attempt or automatically retry interrupted or potentially side-effecting work. A bump is not permission to retry; explain blockers or ask the person before repeating external effects. If stopped, do not continue it.";
        void this.runAgent(this.app.client, channel, threadKey, /^\d+\.\d+$/.test(threadKey) ? threadKey : "",
          { channelId, userId: this.botUserId, text: "", ts: threadKey }, prompt,
          { requestId: "task-bump:" + workflow.id + ":" + workflow.revision })
          .catch((error) => logger.warn("task workflow inspection failed: " + error));
      },
      mergeApprovals: this.consoleMergeApprovals,
      service: (channelId, remote, identity) => {
        const channel = this.channelNow(channelId);
        if (!channel?.factory) return undefined;
        return createFactoryRunService({
          channel, store: () => this.runtimes.peek(channelId)?.store, github: () => this.factoryBackend(channel),
          threadKey: "", currentUserId: () => identity?.userId ?? "", source: "operator", actor: { kind: "console", remote, ...(identity ? { mergeIdentity: identity } : {}) },
          announce: (runId) => this.factoryPresence.ensurePost(channel, runId),
          intake: { kick: () => this.intakeLoop.pollNow(channelId) },
        });
      },
      pollNow: (channelId) => {
        const channel = this.channelNow(channelId);
        if (!channel?.factory?.intake?.enabled || workflowProblem(channel)) return false;
        this.intakeLoop.pollNow(channelId);
        return true;
      },
      audit: (channelId, event, fields) => {
        const channel = this.channelNow(channelId);
        if (channel) appendFactoryAudit(channel, event, fields);
      },
    };
  }

  async reloadConfig(): Promise<ConfigReloadResult> {
    let loaded: ReturnType<typeof loadConfig>;
    try {
      loaded = loadConfig(this.opts.configPath);
      validateKeychainHost(loaded.config, this.opts.dataDir);
      await initializeOpenBao(loaded.config, { forbiddenRoots: [this.opts.dataDir, REPO_ROOT] });
    } catch (err) {
      return {
        applied: false,
        configPath: this.opts.configPath,
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const warnings = configReloadWarnings(this.config, loaded.config, this.opts.dataDir, loaded.dataDir);
    if (this.config.openbao || loaded.config.openbao) warnings.push("OpenBao channel imports refreshed; main-process Slack/model credentials require a restart to change.");
    if (this.config.keychain || loaded.config.keychain) warnings.push("Keychain lookup cache resets for the new config; main-process Slack/model clients require a restart to change credentials.");
    // The static server is constructed at startup and cannot be safely
    // reconfigured under live requests. Keep prompt/env URL guidance on its
    // active configuration too, rather than advertising routes that require a
    // restart before they exist (or hiding an endpoint still serving files).
    this.config = preserveActiveArtifactConfig(this.config, loaded.config);

    // Session leases cover only executing turns (including async startup), not
    // queued follow-ups. Idle sessions detach immediately; each old active
    // session retires after its own turn, before its queued successor starts.
    const invalidation = this.pool.invalidate();
    if (invalidation.activeTurns > 0) {
      warnings.push(
        `${invalidation.activeTurns} active turn(s) will finish on the previous config; their sessions will be rebuilt afterwards.`,
      );
    }
    await invalidation.disposed;
    // A store registers the channel's tool schemas and model allowlist when it opens, so every
    // channel's store is retired too. Each closes once its own turns finish and is then reopened on
    // the new config, so channels stay live. Not awaited here: a reload must not wait on a long turn.
    void this.reopenChannelStores()
      .catch((err) => logger.warn(`could not reopen channel stores: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { void this.intakeLoop?.reconcile(); void this.reconcileFactoryLabels(); void this.catchUpFactoryPresence(); });

    logger.info(`reloaded config from ${loaded.configPath}`);
    for (const warning of warnings) logger.warn(`config reload: ${warning}`);
    return { applied: true, configPath: loaded.configPath, warnings };
  }

  /**
   * A message we posted ourselves as a person (`post_as_user`) is authored by that person, so it looks like them typing.
   * It is output, never input: never let it start a turn, in this channel or any other.
   */
  private ignoreOwnPostAsMessage(event: { text?: unknown; blocks?: unknown; channel?: string; ts?: string }): boolean {
    if (!carriesPostAsFooter(event)) return false;
    logger.info(`ignored a post_as_user message (our own post, not an instruction): channel=${event.channel} ts=${event.ts}`);
    return true;
  }

  private wire(): void {
    // Explicit mentions in a channel.
    this.app.event("app_mention", async ({ event, client }) => {
      const e = event as unknown as {
        channel: string;
        user: string;
        text?: string;
        blocks?: unknown;
        ts: string;
        thread_ts?: string;
        files?: SlackFile[];
      };
      if (this.ignoreOwnPostAsMessage(e)) return;
      await this.handle(client, {
        channelId: e.channel,
        userId: e.user,
        text: e.text ?? "",
        ts: e.ts,
        ...(e.thread_ts ? { threadTs: e.thread_ts } : {}),
        ...(e.files ? { files: e.files } : {}),
      });
    });

    // DMs, and follow-up replies in threads the bot is already part of.
    this.app.message(async ({ message, client }) => {
      const m = message as any;
      // A message carrying an attachment has subtype "file_share". Dropping
      // every subtype silently discarded any image posted as a thread reply.
      if (m.bot_id) return;
      if (m.subtype && m.subtype !== "file_share") return;
      if (!m.user || m.user === this.botUserId) return;
      if (this.ignoreOwnPostAsMessage(m)) return;

      // The thread's session directory is the record of participation, so this
      // survives restarts without any separate bookkeeping.
      const isDm = m.channel_type === "im";
      const inActiveThread =
        m.thread_ts !== undefined &&
        isThreadActive(this.opts.dataDir, m.channel, m.thread_ts);
      const mentionsBot = typeof m.text === "string" && m.text.includes(`<@${this.botUserId}>`);
      const isRootMessage = m.thread_ts === undefined;
      const respondToRootMessages =
        !isDm && !inActiveThread && isRootMessage && !mentionsBot
          ? await this.respondsToRootMessages(client, m.channel)
          : false;

      // DMs always reach the agent. In channels, plain thread replies only
      // reach it once the thread is active; plain root messages need an
      // explicit per-channel opt-in. app_mention handles tagged messages.
      if (
        !shouldHandleMessageEvent({
          isDm,
          inActiveThread,
          isRootMessage,
          mentionsBot,
          respondToRootMessages,
        })
      ) {
        return;
      }

      await this.handle(client, {
        channelId: m.channel,
        userId: m.user,
        text: m.text ?? "",
        ts: m.ts,
        ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
        ...(m.files ? { files: m.files as SlackFile[] } : {}),
        channelType: m.channel_type,
      });
    });

    // Message shortcut: send any Slack message to a chosen channel assistant.
    this.app.shortcut(SEND_TO_ASSISTANT_SHORTCUT, async ({ shortcut, ack, client }) => {
      await ack();
      await this.openSendToAssistantModal(client, shortcut as any);
    });

    this.app.view(SEND_TO_ASSISTANT_VIEW, async ({ ack, body, view, client }) => {
      const metadata = this.decodeSendToAssistantMetadata(view.private_metadata);
      const request = metadata?.id ? this.sendToAssistantRequests.get(metadata.id) : undefined;
      if (!request) {
        await ack({
          response_action: "errors",
          errors: {
            [SEND_TO_ASSISTANT_PROMPT_BLOCK]:
              "This shortcut request has expired. Open ‘Send to assistant’ again.",
          },
        });
        return;
      }

      const userId = (body as any)?.user?.id ?? request.userId;
      if (!shortcutAllowedByDefault(this.config.defaults.allowUsers, userId)) {
        await ack({
          response_action: "errors",
          errors: { [SEND_TO_ASSISTANT_PROMPT_BLOCK]: "You are not allowed to use this assistant." },
        });
        return;
      }

      const values = (view.state?.values ?? {}) as any;
      const selectedConversation =
        values[SEND_TO_ASSISTANT_TARGET_BLOCK]?.[SEND_TO_ASSISTANT_TARGET_ACTION]
          ?.selected_conversation as string | undefined;
      const chosenTarget = sendToAssistantTargetRef(
        selectedConversation,
        this.config.shortcuts.sendToAssistant.defaultChannel,
      );
      if (!chosenTarget) {
        await ack({
          response_action: "errors",
          errors: { [SEND_TO_ASSISTANT_TARGET_BLOCK]: "Choose the channel whose assistant should process this." },
        });
        return;
      }

      const targetChannelId = this.registry.resolveId(chosenTarget.ref);
      if (!targetChannelId) {
        const label = chosenTarget.fromDefault ? `Default assistant channel \`${chosenTarget.ref}\`` : "That channel";
        await ack({
          response_action: "errors",
          errors: {
            [SEND_TO_ASSISTANT_TARGET_BLOCK]: `${label} is not known to the harness yet. Use a Slack channel ID or choose a channel from the list.`,
          },
        });
        return;
      }

      const target = await this.resolveShortcutTarget(client, targetChannelId, userId);
      if (target.error || !target.channel) {
        await ack({
          response_action: "errors",
          errors: { [SEND_TO_ASSISTANT_TARGET_BLOCK]: target.error ?? "That channel is not available." },
        });
        return;
      }

      const instructions =
        values[SEND_TO_ASSISTANT_PROMPT_BLOCK]?.[SEND_TO_ASSISTANT_PROMPT_ACTION]?.value ?? "";
      const selectedFiles =
        values[SEND_TO_ASSISTANT_FILES_BLOCK]?.[SEND_TO_ASSISTANT_FILES_ACTION]
          ?.selected_options ?? [];
      const includeFiles = selectedFiles.some((option: any) => option.value === SEND_TO_ASSISTANT_FILES_VALUE);

      this.sendToAssistantRequests.delete(metadata!.id);
      await ack();

      this.runSendToAssistant(
        client,
        target.channel,
        request.source,
        userId,
        instructions,
        includeFiles,
      ).catch(async (err) => {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error("send-to-assistant failed", err);
        await this.notifyShortcutFailure(
          client,
          userId,
          request.source,
          `Could not send that message to the selected assistant channel: ${detail}`,
        );
      });
    });

    // Reactions are feedback in existing conversations, or an opt-in request
    // to read a post. Keep Slack's event identity for durable redelivery handling.
    this.app.event("reaction_added", async ({ event, client, body }) => {
      await this.handleReaction(client, event as unknown as SlackReactionEvent, body.event_id);
    });
    this.app.event("reaction_removed", async ({ event, client, body }) => {
      await this.handleReaction(client, event as unknown as SlackReactionEvent, body.event_id);
    });

    // Approve buttons carry the duration in the action id.
    this.app.action(new RegExp(`^${APPROVE_ACTION}_\\d+$`), async ({ ack, body, client }) => {
      await ack();
      await this.decide(client, body as any, true);
    });
    this.app.action(DENY_ACTION, async ({ ack, body, client }) => {
      await ack();
      await this.decide(client, body as any, false);
    });

    this.app.action(new RegExp(`^(${CAPABILITY_APPROVE}|${CAPABILITY_DENY})$`), async ({ ack, body, client }) => {
      await ack();
      await decideCapabilityRequest(this.capabilityService(), client, body);
    });

    this.app.action(new RegExp(`^(${CONFIG_APPROVE_ACTION}|${CONFIG_DENY_ACTION})$`), async ({ ack, body, client }) => {
      await ack();
      await this.decideConfigChange(client, body as any);
    });

    this.app.action(new RegExp(`^${FACTORY_ACTION_PREFIX}_(approve|decline|request_changes|more_rounds|stop|retry|abort)$`), async ({ ack, body, client }) => {
      await ack();
      await this.decideFactoryRun(client, body as any);
    });

    this.app.view(FACTORY_CHANGES_VIEW, async ({ ack, body, view, client }) => {
      const feedback = view.state.values.feedback?.text?.value?.trim() ?? "";
      if (!feedback || feedback.length > 3000) {
        await ack({ response_action: "errors", errors: { feedback: "Supply actionable feedback (1–3000 characters)." } });
        return;
      }
      await ack();
      await this.decideFactoryRun(client, body, true);
    });

    this.app.action(new RegExp(`^(${HELD_UNBLOCK_ACTION}|${HELD_DISMISS_ACTION})$`), async ({ ack, body, client }) => {
      await ack();
      await this.decideHeldPost(client, body as any);
    });

    this.app.action(new RegExp(`^${INTERACTIVE_RESPONSE_ACTION_PREFIX}_(yes|no|continue|stop|cancel)$`), async ({ ack, body, client }) => {
      await ack();
      await this.handleInteractiveResponse(client, body as any);
    });

    this.app.action(CONSOLE_MERGE_VERIFY_ACTION, async ({ ack, body, client }) => {
      await ack();
      const click = body as any;
      const channel = click.channel?.id ?? "";
      const user = click.user?.id ?? "";
      const ok = await this.consoleMergeApprovals.confirm(click.actions?.[0]?.value ?? "", user, channel);
      if (ok) this.activityOf(channel)?.resolve(click.message?.ts);
      if (channel && user) await client.chat.postEphemeral({ channel, user,
        text: ok ? "Browser verified. This did not approve the merge. Return to your console to approve or decline." : "Verification refused: this challenge expired, was already used, changed, or you are not a current approver.",
      });
    });

    this.app.action(new RegExp(`^${CONSOLE_OAUTH_ACTION}_(approve|deny)$`), async ({ ack, body }) => {
      await ack();
      // Socket Mode supplies the authenticated Slack clicker, not any console/proxy header.
      // Contain errors locally: Bolt's generic logger must never receive OAuth data.
      try {
        const actionBody = body as any;
        const action = actionBody.actions?.[0];
        const decided = this.connectorOAuth?.decide(action?.value ?? "", actionBody.user?.id ?? "", actionBody.channel?.id ?? "",
          action?.action_id === `${CONSOLE_OAUTH_ACTION}_approve`);
        if (decided) this.activityOf(actionBody.channel?.id ?? "")?.resolve(actionBody.message?.ts);
      } catch { /* A stale/invalid button has no side effects. */ }
    });

    this.app.error(async (error) => {
      logger.error("bolt error", error);
    });
  }

  private purgeExpiredSendToAssistantRequests(): void {
    const cutoff = Date.now() - SEND_TO_ASSISTANT_REQUEST_TTL_MS;
    for (const [id, request] of this.sendToAssistantRequests.entries()) {
      if (request.createdAt < cutoff) this.sendToAssistantRequests.delete(id);
    }
  }

  private decodeSendToAssistantMetadata(raw: string | undefined): { id: string } | undefined {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown };
      return typeof parsed.id === "string" ? { id: parsed.id } : undefined;
    } catch {
      return undefined;
    }
  }

  private async openSendToAssistantModal(client: WebClient, shortcut: any): Promise<void> {
    const userId = shortcut?.user?.id ?? "";
    const triggerId = shortcut?.trigger_id ?? "";
    if (!triggerId) return;

    if (!shortcutAllowedByDefault(this.config.defaults.allowUsers, userId)) {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Send to assistant" },
          close: { type: "plain_text", text: "Close" },
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "You are not allowed to use this shortcut. Ask the harness admin to add you to `defaults.allowUsers`.",
              },
            },
          ],
        },
      });
      return;
    }

    const message = shortcut?.message ?? {};
    const files = (message.files ?? []) as SlackFile[];
    const source: SendToAssistantSource = {
      channelId: shortcut?.channel?.id ?? message.channel ?? "",
      ...(shortcut?.channel?.name ? { channelName: shortcut.channel.name } : {}),
      messageTs: message.ts ?? "",
      messageText: message.text ?? "",
      ...(message.user ? { messageUserId: message.user } : {}),
      ...(files.length > 0 ? { files } : {}),
    };

    this.purgeExpiredSendToAssistantRequests();
    const id = randomUUID();
    this.sendToAssistantRequests.set(id, { userId, source, createdAt: Date.now() });

    const defaultTargetRef = this.config.shortcuts.sendToAssistant.defaultChannel.trim();
    const defaultTargetId = defaultTargetRef ? this.registry.resolveId(defaultTargetRef) : undefined;
    const targetElement: any = {
      type: "conversations_select",
      action_id: SEND_TO_ASSISTANT_TARGET_ACTION,
      placeholder: {
        type: "plain_text",
        text: defaultTargetRef ? `Default: ${defaultTargetRef}` : "Choose an assistant channel",
      },
      filter: { include: ["public", "private"], exclude_bot_users: true },
    };
    if (defaultTargetId) targetElement.initial_conversation = defaultTargetId;

    const blocks: any[] = [
      {
        type: "input",
        block_id: SEND_TO_ASSISTANT_TARGET_BLOCK,
        ...(defaultTargetRef ? { optional: true } : {}),
        label: { type: "plain_text", text: defaultTargetRef ? "Process in channel (optional)" : "Process in channel" },
        element: targetElement,
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Original message (copied unchanged)*\n${modalOriginalMessagePreview(source.messageText, files.length > 0)}`,
        },
      },
      {
        type: "input",
        block_id: SEND_TO_ASSISTANT_PROMPT_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Extra instructions (optional)" },
        element: {
          type: "plain_text_input",
          action_id: SEND_TO_ASSISTANT_PROMPT_ACTION,
          multiline: true,
          placeholder: { type: "plain_text", text: "Why are you sending this?" },
        },
      },
    ];

    if (files.length > 0) {
      blocks.push({
        type: "input",
        block_id: SEND_TO_ASSISTANT_FILES_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Attachments" },
        element: {
          type: "checkboxes",
          action_id: SEND_TO_ASSISTANT_FILES_ACTION,
          options: [
            {
              text: { type: "plain_text", text: `Include ${files.length} attached file(s), including images` },
              value: SEND_TO_ASSISTANT_FILES_VALUE,
            },
          ],
          initial_options: [
            {
              text: { type: "plain_text", text: `Include ${files.length} attached file(s), including images` },
              value: SEND_TO_ASSISTANT_FILES_VALUE,
            },
          ],
        },
      });
    }

    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: SEND_TO_ASSISTANT_VIEW,
        private_metadata: JSON.stringify({ id }),
        title: { type: "plain_text", text: "Send to assistant" },
        submit: { type: "plain_text", text: "Send" },
        close: { type: "plain_text", text: "Cancel" },
        blocks,
      },
    });
  }

  private async resolveShortcutTarget(
    client: WebClient,
    targetChannelId: string,
    userId: string,
  ): Promise<{ channel?: ResolvedChannel; error?: string }> {
    const isDm = targetChannelId.startsWith("D");
    let name: string | undefined;
    if (!isDm) name = await this.channelName(client, targetChannelId);

    const { channel, rejected } = resolveChannel(
      this.config,
      this.opts.dataDir,
      { id: targetChannelId, ...(name ? { name } : {}), isDm },
      this.registry,
    );
    if (rejected || !channel) return { error: rejected ?? "That channel is not configured." };
    if (channel.allowUsers && !channel.allowUsers.includes(userId)) {
      return { error: "You are not allowed to use the assistant in that channel." };
    }
    return { channel };
  }

  private async notifyShortcutFailure(
    client: WebClient,
    userId: string,
    source: SendToAssistantSource,
    text: string,
  ): Promise<void> {
    if (source.channelId) {
      try {
        await client.chat.postEphemeral({ channel: source.channelId, user: userId, text });
        return;
      } catch {
        // The shortcut can come from a channel the bot is not in, so fall back to a DM.
      }
    }
    try {
      const opened = await client.conversations.open({ users: userId });
      const channel = (opened.channel as any)?.id as string | undefined;
      if (channel) await client.chat.postMessage({ channel, text });
    } catch (err) {
      logger.warn("could not notify user about send-to-assistant failure", err);
    }
  }

  private async runSendToAssistant(
    client: WebClient,
    target: ResolvedChannel,
    source: SendToAssistantSource,
    userId: string,
    instructions: string,
    includeFiles: boolean,
  ): Promise<void> {
    const requirements = checkRequirements(target.requires, target.env);
    if (!requirements.ok && requirements.onMissing === "fail") {
      await this.notifyShortcutFailure(
        client,
        userId,
        source,
        `:warning: The selected assistant channel is missing required tooling:\n${describeMissing(requirements)}`,
      );
      return;
    }
    if (!requirements.ok) {
      logger.warn(
        `channel ${target.ref.id} missing requirements (warn mode):\n${describeMissing(requirements)}`,
      );
    }

    let permalink: string | undefined;
    if (source.channelId && source.messageTs) {
      try {
        const link = await client.chat.getPermalink({
          channel: source.channelId,
          message_ts: source.messageTs,
        });
        permalink = link.permalink as string | undefined;
      } catch {
        // The source channel may not be visible to the bot; the copied text/files are still useful.
      }
    }

    const seed = await client.chat.postMessage({
      channel: target.ref.id,
      text: [
        `:arrow_forward: <@${userId}> sent a Slack message to this assistant.`,
        permalink ? `Original: ${permalink}` : undefined,
        (source.files?.length ?? 0) > 0
          ? `Attachments: ${source.files!.length} file(s)${includeFiles ? " included" : " not included"}.`
          : undefined,
        "Discuss it in this thread.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    const threadTs = seed.ts as string | undefined;
    if (!threadTs) throw new Error("Slack did not return a timestamp for the target thread.");

    // A shortcut-created thread is now a normal assistant conversation in the target channel.
    markThreadActive(target.paths.sessions, threadTs);
    if (target.dreamsEnabled) this.dreamer.register(target.ref.id);

    const prompt = buildSendToAssistantPrompt({
      submittedBy: userId,
      instructions,
      source,
      ...(permalink ? { sourcePermalink: permalink } : {}),
      includeFiles,
    });

    await this.runAgent(client, target, threadTs, threadTs, {
      channelId: target.ref.id,
      userId,
      text: instructions.trim() || source.messageText || "Slack message sent to assistant.",
      ts: threadTs,
      ...(includeFiles && source.files?.length ? { files: source.files } : {}),
    }, prompt);
  }

  /** Best-effort lookup of the reacted-to message.
   *
   * The event itself does not reliably include `thread_ts`, so reactions on
   * replies would otherwise start a new conversation under the reply timestamp.
   * If this call fails, top-level reactions still work via the event's item ts.
   */
  private async reactionMessage(
    client: WebClient,
    channelId: string,
    ts: string,
  ): Promise<ReactionMessage | undefined> {
    try {
      const res = await client.reactions.get({ channel: channelId, timestamp: ts });
      return (res as { message?: ReactionMessage }).message;
    } catch (err: any) {
      const detail = err?.data?.error ?? (err instanceof Error ? err.message : String(err));
      if (!this.reactionReadWarned) {
        this.reactionReadWarned = true;
        logger.warn(
          `could not read reacted message (${detail}); reactions on thread replies may not resume the right thread. ` +
            "Check the reactions:read scope and reinstall the Slack app.",
        );
      }
      return undefined;
    }
  }

  private async handleReaction(client: WebClient, event: SlackReactionEvent, eventId?: string): Promise<void> {
    if (!this.botUserId || event.user === this.botUserId) return;
    const initial = reactionTurn(event);
    if (!initial) return;
    const isDm = initial.channelId.startsWith("D");
    const readRequest = this.config.reactionTriggers.enabled && initial.kind === "added" &&
      initial.reaction === this.config.reactionTriggers.emoji;

    if (readRequest) {
      // Resolve and authorize before fetching source content. Unlike ordinary
      // mentions, the opt-in trigger never expands into unconfigured channels.
      const name = isDm ? undefined : await this.channelName(client, initial.channelId);
      const { channel, rejected } = resolveChannel(this.config, this.opts.dataDir,
        { id: initial.channelId, ...(name ? { name } : {}), isDm }, this.registry);
      if (rejected || !channel || (!isDm && !channel.configKey)) return;
      if (channel.allowUsers && !channel.allowUsers.includes(initial.userId)) return;
      // Slack reaction events contain a user ID, but no reliable bot flag.
      // Fail closed if we cannot establish a human actor; never use user tokens.
      try {
        const { user } = await client.users.info({ user: initial.userId });
        if (!user || user.id !== initial.userId || user.is_bot !== false || user.is_app_user || user.deleted) return;
      } catch {
        return;
      }
    }

    const target = await this.reactionMessage(client, initial.channelId, initial.itemTs);
    // Feedback can retain its old timestamp-only fallback. An invitation to
    // read must actually read the exact post and know its parent thread.
    if (readRequest && (!target || target.ts !== initial.itemTs || !target.text?.trim())) return;
    const turn = reactionTurn(event, target)!;
    const inActiveThread = isThreadActive(this.opts.dataDir, turn.channelId, turn.threadTs);
    const onBotMessage = reactionTargetsBot(event, target, this.botUserId);
    if (!readRequest && !isDm && !inActiveThread && !onBotMessage) return;

    await this.handle(client, {
      channelId: turn.channelId,
      userId: turn.userId,
      text: readRequest ? reactionReadPrompt(turn) : reactionPrompt(turn),
      ts: turn.itemTs,
      threadTs: turn.threadTs,
      ...(isDm ? { channelType: "im" } : {}),
    }, reactionRequestId(event, eventId));
  }

  /**
   * Handle an approve/deny click.
   *
   * The capability and channel come from the button payload, not from anything
   * the clicker can retype, and the approver list is checked here rather than
   * only being described in the message — otherwise it would be advisory.
   */
  private async decide(client: WebClient, body: any, approve: boolean): Promise<void> {
    const action = body?.actions?.[0];
    const payload = decodePayload(action?.value ?? "");
    const clicker: string = body?.user?.id ?? "";
    if (!payload) return;

    const permissions = this.permissionsFor(payload.channelId);
    if (permissions.approvers.length > 0 && !permissions.approvers.includes(clicker)) {
      await client.chat.postEphemeral({
        channel: payload.channelId,
        user: clicker,
        text: `Only ${permissions.approvers.map((u) => `<@${u}>`).join(", ")} can approve this.`,
      });
      return;
    }
    // A capability removed from the config after the message was posted must
    // not still be grantable by clicking an old button.
    if (!permissions.grantable.includes(payload.capability)) {
      await client.chat.postEphemeral({
        channel: payload.channelId,
        user: clicker,
        text: `\`${payload.capability}\` is no longer grantable in this channel.`,
      });
      return;
    }

    const minutes = Number(String(action.action_id).split("_").pop());
    if (minutes === 0 && !permissions.allowPermanent) {
      await client.chat.postEphemeral({
        channel: payload.channelId,
        user: clicker,
        text:
          "Permanent grants are not enabled here. Set `permissions.allowPermanent: true`, " +
          "or better, put the capability in the channel's config where it can be reviewed.",
      });
      return;
    }
    const capped =
      minutes !== 0 && permissions.maxMinutes > 0 && minutes > permissions.maxMinutes
        ? permissions.maxMinutes
        : minutes;

    let detail = "";
    if (approve) {
      const expiresAt =
        capped === 0 ? null : new Date(Date.now() + capped * 60_000).toISOString();
      this.grants.grant(payload.channelId, {
        capability: payload.capability,
        grantedBy: clicker,
        grantedAt: new Date().toISOString(),
        expiresAt,
        ...(payload.requestedBy ? { reason: `requested during <@${payload.requestedBy}>'s turn` } : {}),
      });
      detail =
        capped === 0
          ? `until revoked — consider making this permanent in the config instead:\n\`\`\`\n${configHintFor(payload.capability)}\n\`\`\``
          : `for ${capped} minutes`;
      logger.info(
        `grant: ${payload.capability} in ${payload.channelId} by ${clicker} (${detail})`,
      );
      // The channel config changes shape, so drop live sessions to pick it up.
      await this.pool.disposeChannel(payload.channelId);
      // A granted capability adds tools, which the store must register: retire it. Not awaited — it closes once the
      // sessions using it (including a turn still running) have finished with it.
      void this.runtimes.invalidate(payload.channelId).catch((err) => logger.warn(`could not retire store for ${payload.channelId}: ${err instanceof Error ? err.message : String(err)}`));
    }

    this.activityOf(payload.channelId)?.resolve(body?.message?.ts);
    this.timelineOf(payload.channelId, payload.channelId.startsWith("D")).record({
      kind: "approval.decided", actor: "channel", ...(payload.threadTs ? { threadKey: payload.threadTs } : {}), userId: clicker,
      title: `${approve ? "Approved" : "Denied"}: ${describeCapability(payload.capability)}`, status: approve ? "granted" : "denied",
      detail: approve ? detail.split("\n")[0] ?? "" : "",
    });
    try {
      await client.chat.update({
        channel: payload.channelId,
        ts: body.message.ts,
        text: approve ? "Approved" : "Denied",
        blocks: decidedBlocks(payload.capability, approve ? "approved" : "denied", clicker, detail),
      });
    } catch (err) {
      logger.debug("could not update the approval message", err);
    }

    if (approve && payload.threadTs) {
      await this.resumeAfterGrant(client, payload.channelId, payload.threadTs, payload.capability);
    }
  }

  /** Nudge the waiting conversation now that the capability exists. */
  private async resumeAfterGrant(
    client: WebClient,
    channelId: string,
    threadTs: string,
    capability: Capability,
  ): Promise<void> {
    const { channel } = await this.resolveBackgroundChannel(channelId);
    if (!channel) return;

    await this.runAgent(
      client,
      channel,
      threadTs,
      threadTs,
      { channelId, userId: this.botUserId, text: "", ts: threadTs },
      `${describeCapability(capability)} has just been approved. Continue what you were doing, without asking again.`,
    );
  }

  /**
   * ChannelPoster: how the agent publishes to its own channel. The channel id
   * comes from the session, never from the model, so a post cannot be aimed at
   * another channel.
   */
  async post(input: {
    channelId: string;
    text: string;
    threadTs?: string;
  }): Promise<{ ts: string; permalink?: string }> {
    const res = await this.app.client.chat.postMessage({
      channel: input.channelId,
      text: toMrkdwn(input.text),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
    const ts = res.ts as string;
    this.activityOf(input.channelId)?.record({ key: `post:${ts}`, kind: "message", sourceTs: ts, title: "Message posted", text: input.text });

    let permalink: string | undefined;
    try {
      const link = await this.app.client.chat.getPermalink({
        channel: input.channelId,
        message_ts: ts,
      });
      permalink = link.permalink as string | undefined;
    } catch {
      // Permalinks are a convenience; not worth failing the post over.
    }
    return { ts, ...(permalink ? { permalink } : {}) };
  }

  /**
   * CrossChannelPoster: publish to a *different* channel, but only one this
   * source channel was configured to reach (`share.postTo`). The allowlist is
   * checked here as well as in the tool, and the target is resolved from the
   * trusted config entry that matched, never from the model's own string, so a
   * lookalike name or id cannot steer the post somewhere else.
   */
  async postToChannel(input: {
    sourceChannelId: string;
    allowedTargets: DelegationTargetConfig[];
    target: string;
    text: string;
  }): Promise<{ channelLabel: string; ts: string; permalink?: string }> {
    const allowed = input.allowedTargets.find((t) => this.sameDelegationTarget(input.target, t.channel));
    if (!allowed) {
      throw new Error(
        `This channel is only configured to post to: ${input.allowedTargets.map((t) => t.channel).join(", ") || "(none)"}.`,
      );
    }

    const targetId = await this.resolvePostTargetId(allowed.channel);
    if (!targetId) {
      throw new Error(
        `I could not find Slack channel ${allowed.channel}. Use its Slack channel ID in \`share.postTo\`.`,
      );
    }
    if (targetId === input.sourceChannelId) {
      throw new Error("That is this channel: use `post_message` to post here.");
    }
    if (targetId.startsWith("D")) {
      throw new Error("Posting to direct messages is not supported.");
    }

    let ts: string;
    try {
      const res = await this.app.client.chat.postMessage({
        channel: targetId,
        text: toMrkdwn(input.text),
      });
      ts = res.ts as string;
    } catch (err) {
      const code = (err as { data?: { error?: string } })?.data?.error;
      if (code === "not_in_channel") {
        throw new Error(
          `The bot is not a member of ${allowed.channel}. Invite it there, or add the \`chat:write.public\` scope to the Slack app so it can post to public channels it has not joined.`,
        );
      }
      if (code === "channel_not_found") {
        throw new Error(`Slack could not find channel ${allowed.channel}. Check the ID in \`share.postTo\`.`);
      }
      throw err;
    }

    let permalink: string | undefined;
    try {
      const link = await this.app.client.chat.getPermalink({ channel: targetId, message_ts: ts });
      permalink = link.permalink as string | undefined;
    } catch {
      // Permalinks are a convenience; not worth failing the post over.
    }

    this.activityOf(targetId)?.record({ key: `post:${ts}`, kind: "message", sourceTs: ts, title: "Message posted", text: input.text });
    const name = await this.channelName(this.app.client, targetId);
    const channelLabel = name ? `#${name}` : allowed.channel;
    logger.info(`cross-channel post: ${input.sourceChannelId} -> ${targetId} (${channelLabel})`);
    return { channelLabel, ts, ...(permalink ? { permalink } : {}) };
  }

  /**
   * Turn a configured `postTo` entry into a channel id. IDs and names the
   * registry has learned resolve immediately; a bot that has never been in the
   * channel falls back to listing channels, since it has no event to learn from.
   */
  private async resolvePostTargetId(configured: string): Promise<string | undefined> {
    const known = this.registry.resolveId(configured);
    if (known) return known;

    const bare = configured.trim().replace(/^#/, "");
    const cached = this.postTargetIds.get(bare);
    if (cached) return cached;

    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.app.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      const match = (res.channels ?? []).find((c) => c.name === bare && c.id);
      if (match?.id) {
        this.postTargetIds.set(bare, match.id);
        return match.id;
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return undefined;
  }

  /** Post the fixed-response controls for the current channel/thread only. */
  async present(input: {
    channelId: string;
    threadTs: string;
    question: string;
    responses: CannedResponse[];
  }): Promise<{ ts: string; permalink?: string }> {
    const res = await this.app.client.chat.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: `${input.question}\n\nOptions: ${input.responses.map((r) => r[0]!.toUpperCase() + r.slice(1)).join(", ")}`,
      blocks: buildInteractiveResponseBlocks(input),
    });
    const ts = res.ts as string;
    this.activityOf(input.channelId)?.record({ key: `prompt:${ts}`, kind: "prompt", sourceTs: ts, title: "Response requested", text: input.question, interaction: "pending" });
    let permalink: string | undefined;
    try {
      const link = await this.app.client.chat.getPermalink({ channel: input.channelId, message_ts: ts });
      permalink = link.permalink as string | undefined;
    } catch {
      // A missing permalink does not stop the conversation from waiting for a click.
    }
    return { ts, ...(permalink ? { permalink } : {}) };
  }

  /** Validate a clicked canned response, then resume only its original thread. */
  private async handleInteractiveResponse(client: WebClient, body: any): Promise<void> {
    const action = body?.actions?.[0];
    const payload = decodeInteractiveResponsePayload(action?.value ?? "");
    const clicker = body?.user?.id as string | undefined;
    const channelId = body?.channel?.id as string | undefined;
    const messageTs = body?.message?.ts as string | undefined;
    const messageThreadTs = (body?.message?.thread_ts ?? messageTs) as string | undefined;
    if (!payload || !clicker || !channelId || !messageTs || !messageThreadTs) return;

    // The Slack action's signed value must agree with the actual message that
    // contained it. Never let a component route a turn to a different channel
    // or thread, and bind its response to the fixed action id too.
    if (
      payload.channelId !== channelId ||
      payload.threadTs !== messageThreadTs ||
      action?.action_id !== cannedResponseActionId(payload.response)
    ) {
      logger.warn("ignored malformed interactive response action");
      return;
    }

    const isDm = channelId.startsWith("D");
    const name = isDm ? undefined : await this.channelName(client, channelId);
    const { channel, rejected } = resolveChannel(
      this.config,
      this.opts.dataDir,
      { id: channelId, ...(name ? { name } : {}), isDm },
      this.registry,
    );
    if (rejected || !channel || !channel.interactiveComponents.enabled) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: clicker,
        text: "Interactive responses are not enabled for this assistant channel.",
      });
      return;
    }
    if (channel.allowUsers && !channel.allowUsers.includes(clicker)) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: clicker,
        text: "You are not allowed to respond to this assistant.",
      });
      return;
    }

    const claim = `${channelId}:${messageTs}`;
    if (this.claimedInteractiveResponses.has(claim)) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: clicker,
        text: "That response has already been selected.",
      });
      return;
    }
    this.claimedInteractiveResponses.add(claim);
    this.activityOf(channelId)?.resolve(messageTs);

    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `${payload.question}\n\nAnswered: ${payload.response}`,
        blocks: answeredInteractiveResponseBlocks({
          question: payload.question,
          response: payload.response,
          userId: clicker,
        }),
      });
    } catch (err) {
      // A failure here is not a reason to discard the answer: the action was
      // valid and Slack has acknowledged it. The in-memory claim still avoids
      // processing an ordinary repeated click in this process.
      logger.warn("could not replace interactive response buttons", err);
    }

    await this.handle(client, {
      channelId,
      userId: clicker,
      text: interactiveResponsePrompt({
        userId: clicker,
        response: payload.response,
        question: payload.question,
      }),
      ts: messageTs,
      threadTs: payload.threadTs,
      ...(isDm ? { channelType: "im" } : {}),
    });
  }

  /**
   * FileUploader: publish a file the agent produced.
   *
   * The path arrives already checked against the channel's jail — see
   * `agent/file-tools.ts`, which is where that has to happen, since only the
   * tool knows which channel it is running for. This method does the Slack
   * half and nothing else.
   */
  async upload(input: {
    channelId: string;
    path: string;
    filename: string;
    title?: string;
    comment?: string;
    altText?: string;
    threadTs?: string;
  }): Promise<{ permalink?: string }> {
    // Read it ourselves rather than handing Slack a path: the bytes are what
    // gets uploaded either way, and this keeps file access on our side of the
    // boundary where the jail check already happened.
    const file = await readFile(input.path);

    const target = {
      channel_id: input.channelId,
      file,
      filename: input.filename,
      ...(input.title ? { title: input.title } : {}),
      ...(input.comment ? { initial_comment: toMrkdwn(input.comment) } : {}),
      ...(input.altText ? { alt_text: input.altText } : {}),
    };

    // Split rather than spread a maybe-undefined thread_ts: "in a thread" and
    // "at channel level" are two different argument shapes to Slack, and an
    // optional key satisfies neither.
    const res = await this.app.client.files.uploadV2(
      input.threadTs ? { ...target, thread_ts: input.threadTs } : target,
    );

    // uploadV2 nests its result differently depending on how it batched the
    // upload, and a permalink is a convenience rather than the point.
    const files = (res as { files?: { files?: { id?: string; permalink?: string }[] }[] }).files ?? [];
    const uploaded = files[0]?.files?.[0];
    const permalink = uploaded?.permalink;
    this.activityOf(input.channelId)?.record({ key: `file:${uploaded?.id ?? permalink ?? randomUUID()}`, kind: "message",
      title: input.title ? `File published: ${input.title}` : "File published", text: input.comment ?? input.title ?? input.filename,
      sourceTs: input.threadTs, fileUrl: permalink });
    return permalink ? { permalink } : {};
  }

  private sameDelegationTarget(a: string, b: string): boolean {
    const bare = (value: string) => value.trim().replace(/^#/, "");
    const aa = bare(a);
    const bb = bare(b);
    if (aa === bb) return true;

    const aId = this.registry.resolveId(aa);
    const bId = this.registry.resolveId(bb);
    return Boolean(aId && bId && aId === bId);
  }

  private delegationAllowed(target: string, allowedTargets: readonly DelegationTargetConfig[]): boolean {
    return allowedTargets.some((allowed) => this.sameDelegationTarget(target, allowed.channel));
  }

  /**
   * ChannelDelegator: create a normal assistant thread in another configured
   * channel. The source channel supplies the allowlist; this method resolves it
   * against the registry/Slack and starts the target turn. Only the resulting
   * completion status and answer are posted to the originating source thread.
   */
  async transfer(input: {
    sourceChannelId: string;
    sourceChannelLabel: string;
    sourceThreadTs?: string;
    allowedTargets: DelegationTargetConfig[];
    target: string;
    task: string;
    context?: string;
    requestedBy: string;
  }): Promise<DelegationResult> {
    // A callback must remain in the originating thread. Headless quiet tasks
    // deliberately have no thread and therefore cannot delegate.
    const sourceThreadTs = input.sourceThreadTs;
    if (!sourceThreadTs) {
      throw new Error("Delegation is unavailable without a source thread.");
    }
    if (!this.delegationAllowed(input.target, input.allowedTargets)) {
      throw new Error(
        `This channel is only configured to transfer to: ${input.allowedTargets.map((t) => t.channel).join(", ") || "(none)"}.`,
      );
    }

    const targetId = this.registry.resolveId(input.target);
    if (!targetId) {
      throw new Error(
        `I do not know Slack channel ${input.target}. Use a Slack channel ID, or talk to that channel once so the harness learns its name.`,
      );
    }

    const isDm = targetId.startsWith("D");
    const name = isDm ? undefined : await this.channelName(this.app.client, targetId);
    const { channel: target, rejected } = resolveChannel(
      this.config,
      this.opts.dataDir,
      { id: targetId, ...(name ? { name } : {}), isDm },
      this.registry,
    );
    if (rejected || !target) throw new Error(rejected ?? `Target channel ${input.target} is not configured.`);

    if (target.allowUsers && !target.allowUsers.includes(input.requestedBy)) {
      throw new Error("The requesting user is not allowed to use the assistant in the target channel.");
    }

    const requirements = checkRequirements(target.requires, target.env);
    if (!requirements.ok && requirements.onMissing === "fail") {
      throw new Error(`The target assistant channel is missing required tooling:\n${describeMissing(requirements)}`);
    }
    if (!requirements.ok) {
      logger.warn(
        `delegation target ${target.ref.id} missing requirements (warn mode):\n${describeMissing(requirements)}`,
      );
    }

    let sourcePermalink: string | undefined;
    if (input.sourceThreadTs) {
      try {
        const link = await this.app.client.chat.getPermalink({
          channel: input.sourceChannelId,
          message_ts: input.sourceThreadTs,
        });
        sourcePermalink = link.permalink as string | undefined;
      } catch {
        // The target prompt can still carry the source channel label.
      }
    }

    const targetLabel = target.ref.name ? `#${target.ref.name}` : `<#${target.ref.id}>`;
    const seed = await this.app.client.chat.postMessage({
      channel: target.ref.id,
      text: toMrkdwn(
        buildDelegationNotification({
          targetChannelLabel: targetLabel,
          sourceChannelLabel: input.sourceChannelLabel,
          ...(sourcePermalink ? { sourceThreadPermalink: sourcePermalink } : {}),
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
          requestedBy: input.requestedBy,
        }),
      ),
    });
    const threadTs = seed.ts as string | undefined;
    if (!threadTs) throw new Error("Slack did not return a timestamp for the delegated thread.");

    let targetPermalink: string | undefined;
    try {
      const link = await this.app.client.chat.getPermalink({
        channel: target.ref.id,
        message_ts: threadTs,
      });
      targetPermalink = link.permalink as string | undefined;
    } catch {
      // A link is useful but not required to run the target assistant.
    }

    markThreadActive(target.paths.sessions, threadTs);
    if (target.dreamsEnabled) this.dreamer.register(target.ref.id);

    const prompt = buildDelegationPrompt({
      requestedBy: input.requestedBy,
      sourceChannelLabel: input.sourceChannelLabel,
      ...(sourcePermalink ? { sourceThreadPermalink: sourcePermalink } : {}),
      task: input.task,
      ...(input.context ? { context: input.context } : {}),
    });

    void reportDelegatedRun(
      this.runAgent(
        this.app.client,
        target,
        threadTs,
        threadTs,
        {
          channelId: target.ref.id,
          userId: input.requestedBy,
          text: input.task,
          ts: threadTs,
        },
        prompt,
      ),
      {
        sourceChannelId: input.sourceChannelId,
        sourceThreadTs,
        sourceUserId: input.requestedBy,
        targetChannelLabel: targetLabel,
        ...(targetPermalink ? { targetPermalink } : {}),
      },
      async (completion) => this.postDelegationCompletion(completion),
    ).catch((err) => {
      // postDelegationCompletion already handles Slack failures; retain this
      // last-resort log for an unexpected callback implementation failure.
      logger.error(`could not report delegated agent run in ${target.ref.id}`, err);
    });

    return { targetChannelLabel: targetLabel, threadTs, ...(targetPermalink ? { permalink: targetPermalink } : {}) };
  }

  private async postDelegationCompletion(input: DelegationCompletionRoute): Promise<void> {
    try {
      const callback = await routeDelegationCompletion(this, input);
      const { channel: source, rejected } = await this.resolveBackgroundChannel(input.sourceChannelId);
      if (rejected || !source) {
        logger.warn(
          `could not resume delegated task completion in ${input.sourceChannelId}/${input.sourceThreadTs}: ` +
            `${rejected ?? "source channel unavailable"}`,
        );
        return;
      }

      // Slack does not send the app an actionable message event for its own
      // post: the normal listener deliberately drops bot_id messages. Resume
      // the source thread directly, while runAgent's per-thread queue ensures
      // a fast target completion waits for the source transfer turn to finish.
      await this.runAgent(
        this.app.client,
        source,
        input.sourceThreadTs,
        input.sourceThreadTs,
        {
          channelId: input.sourceChannelId,
          userId: input.sourceUserId,
          text: formatDelegationCompletion(input),
          ts: callback.ts,
        },
        buildDelegationCompletionPrompt(input),
      );
    } catch (err) {
      logger.warn(
        `could not post or resume delegated task completion in ${input.sourceChannelId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- PermissionService ---------------------------------------------------

  private permissionsFor(channelId: string): PermissionsConfig {
    // Same lookup order as resolveChannel: id, then the name — from the cache
    // or, for a process that has not seen this channel yet, the registry.
    const name = this.channelNames.get(channelId) ?? this.registry.nameFor(channelId);
    const entry =
      this.config.channels[channelId] ??
      (name ? this.config.channels[name] ?? this.config.channels[`#${name}`] : undefined);
    // Merge rather than replace, matching resolveChannel. Roles the channel's agent set says need approval are
    // grantable too: the set is the operator's own config.
    const merged = { ...this.config.defaults.permissions, ...(entry?.permissions ?? {}) };
    const approvals = approvalCapabilities(this.config, entry);
    return approvals.length > 0 ? { ...merged, grantable: [...new Set([...merged.grantable, ...approvals])] } : merged;
  }

  grantable(channelId: string): Capability[] {
    return this.permissionsFor(channelId).grantable as Capability[];
  }

  active(channelId: string) {
    return this.grants.active(channelId);
  }

  /** Post the approve/deny message. Resolves once posted, not once decided. */
  async request(input: {
    channelId: string;
    capability: Capability;
    reason: string;
    minutes?: number;
  }): Promise<void> {
    const permissions = this.permissionsFor(input.channelId);
    const cap = permissions.maxMinutes;
    const offered = permissions.durations
      // A permanent grant is a separate decision from the length cap, so it
      // needs its own opt-in rather than slipping through as "0 <= anything".
      .filter((m) => (m === 0 ? permissions.allowPermanent : cap === 0 || m <= cap))
      // A request for a specific duration puts it first, if it is allowed.
      .sort((a, b) => (a === input.minutes ? -1 : b === input.minutes ? 1 : 0));

    const threadTs = this.pendingThread.get(input.channelId) ?? "";
    this.timelineOf(input.channelId, input.channelId.startsWith("D")).record({
      kind: "approval.requested", actor: "channel", ...(threadTs ? { threadKey: threadTs } : {}),
      userId: this.pendingUser.get(input.channelId) ?? this.botUserId,
      title: `Asked for approval: ${describeCapability(input.capability)}`, detail: redactTaskUrls(input.reason),
    });
    const sent = await this.app.client.chat.postMessage({
      channel: input.channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `Permission request: ${describeCapability(input.capability)}`,
      blocks: buildApprovalBlocks({
        capability: input.capability,
        channelId: input.channelId,
        reason: input.reason,
        requestedBy: this.pendingUser.get(input.channelId) ?? this.botUserId,
        threadTs,
        durations: offered.length > 0 ? offered : [60],
        approvers: permissions.approvers,
      }),
    });
    if (sent.ts) this.activityOf(input.channelId)?.record({ key: `approval:${sent.ts}`, sourceTs: sent.ts, kind: "approval", title: `Approval: ${describeCapability(input.capability)}`, text: input.reason, interaction: "pending" });
  }

  private async respondsToRootMessages(client: WebClient, channelId: string): Promise<boolean> {
    const name = await this.channelName(client, channelId);
    const entry =
      this.config.channels[channelId] ??
      (name ? this.config.channels[name] ?? this.config.channels[`#${name}`] : undefined);
    return entry?.respondToRootMessages === true;
  }

  private async channelName(client: WebClient, channelId: string): Promise<string | undefined> {
    // The in-memory cache is only as old as the process; the registry outlives
    // a restart, and a config entry keyed by name is missed without one.
    const known = this.channelNames.get(channelId) ?? this.registry.nameFor(channelId);
    if (known) {
      this.channelNames.set(channelId, known);
      return known;
    }
    try {
      const info = await client.conversations.info({ channel: channelId });
      const name = (info.channel as any)?.name as string | undefined;
      if (name) this.channelNames.set(channelId, name);
      return name;
    } catch {
      // Private channels the bot can see but not introspect: fall back to ID.
      return undefined;
    }
  }

  /**
   * Resolve a channel for work nobody is in the room for: a scheduled task, the
   * overnight pass, a turn resumed after a grant.
   *
   * These run with no Slack event to read a channel name off, so the name is
   * looked up the same way the interactive path does — cache, then the
   * registry, then Slack — before resolving. Skipping that is how a scheduled
   * run ends up with the account defaults instead of its channel's tools and
   * secrets.
   */
  private async resolveBackgroundChannel(channelId: string) {
    const isDm = channelId.startsWith("D");
    const name = isDm ? undefined : await this.channelName(this.app.client, channelId);
    return resolveChannel(
      this.config,
      this.opts.dataDir,
      { id: channelId, ...(name ? { name } : {}), isDm },
      this.registry,
    );
  }

  /**
   * Read what was already said, for a conversation that is starting now.
   *
   * Which history to read follows from how the conversation started, because
   * the three cases carry different implications:
   *
   * - **Tagged into a thread.** The discussion above the mention is what the
   *   mention is about, so reading it is the point.
   * - **A DM.** Nobody threads a DM, so the channel *is* the conversation.
   * - **A new top-level mention in a channel.** Being mentioned once is not an
   *   invitation to read the room, so this stays off unless the config says
   *   otherwise.
   *
   * Only ever the channel the message arrived in: this cannot be pointed at
   * another channel's history.
   */
  private async readHistory(
    client: WebClient,
    channel: ResolvedChannel,
    msg: IncomingMessage,
    generous = false,
  ): Promise<string | undefined> {
    const isDm = msg.channelType === "im" || msg.channelId.startsWith("D");
    const inThread = msg.threadTs !== undefined;
    const limit = inThread
      ? channel.context.threadBackfill
      : isDm
        ? channel.context.dmBackfill
        : channel.context.channelBackfill;
    if (limit <= 0) return undefined;

    return await fetchBackfill({
      client,
      users: this.users,
      channelId: msg.channelId,
      botUserId: this.botUserId,
      limit,
      excludeTs: msg.ts,
      ...(inThread ? { threadTs: msg.threadTs } : {}),
      ...(generous ? { generous } : {}),
    });
  }

  private async handle(client: WebClient, msg: IncomingMessage, requestId?: string): Promise<void> {
    // Capture arrival BEFORE asynchronous channel/history/workflow lookups. A slow lookup
    // must not turn pre-response input into an apparent reaction after completion.
    const arrivalKey = (msg.channelType === "im" || msg.channelId.startsWith("D")) && !msg.threadTs
      ? "dm" : msg.threadTs ?? msg.ts;
    msg.steeringTarget = this.turnSteering?.get(msg.channelId + ":" + arrivalKey);
    msg.arrivalRecorded = true;
    if (msg.files?.length) {
      logger.debug(
        `message in ${msg.channelId} has ${msg.files.length} attachment(s): ` +
          msg.files.map((f) => f.mimetype ?? f.filetype ?? "?").join(", "),
      );
    }
    const isDm = msg.channelType === "im" || msg.channelId.startsWith("D");
    const name = isDm ? undefined : await this.channelName(client, msg.channelId);

    const { channel, rejected } = resolveChannel(
      this.config,
      this.opts.dataDir,
      { id: msg.channelId, ...(name ? { name } : {}), isDm },
      this.registry,
    );

    if (rejected || !channel) {
      logger.info(`ignoring message in ${msg.channelId}: ${rejected}`);
      return;
    }

    if (channel.allowUsers && !channel.allowUsers.includes(msg.userId)) {
      logger.info(`user ${msg.userId} not allowed in ${msg.channelId}`);
      return;
    }

    // A channel first spoken to today should still consolidate tonight; the
    // dreamer only saw the channels the registry knew about at startup.
    if (channel.dreamsEnabled) this.dreamer.register(channel.ref.id);

    const threadTs = msg.threadTs ?? msg.ts;
    const threadKey = threadTs;
    // Synthetic reaction prompts already frame their source as quoted data;
    // stripping mentions here would silently edit the post being read.
    const prompt = requestId?.startsWith("slack-reaction:") ? msg.text : promptForIncomingMessage({
      text: msg.text,
      botUserId: this.botUserId,
      ...(msg.threadTs ? { threadTs: msg.threadTs } : {}),
      ...(msg.files ? { files: msg.files } : {}),
    });

    // Join the thread so plain replies keep reaching the agent, even for a
    // bang-command that never starts an agent session.
    markThreadActive(channel.paths.sessions, threadKey);

    if (!prompt && (msg.files?.length ?? 0) === 0) return;

    if (isCommand(prompt)) {
      const reply = await runCommand(prompt, {
        channel,
        threadKey,
        pool: this.pool,
        runtimes: this.runtimes,
        withRuntime: (fn) => withChannelRuntime(this.baseSessionOptions(channel, this.config), fn),
        recover: () => withChannelRuntime(this.baseSessionOptions(channel, this.config), (runtime) => this.recoverInterruptedWork(runtime)),
        harnessName: this.config.name,
        botUserId: this.botUserId,
        dataDir: this.opts.dataDir,
        modelRuntime: this.opts.modelRuntime,
        userId: msg.userId,
        connectorOAuth: this.connectorOAuth,
        privateReply: async (text) => {
          await client.chat.postEphemeral({ channel: msg.channelId, thread_ts: threadTs, user: msg.userId, text });
        },
        feedback: {
          announceResolved: this.config.feedback.announceResolved,
          notify: async (channelId, text) => {
            await this.post({ channelId, text });
          },
          digest: () => this.postFeedbackDigest(),
        },
        reloadConfig: () => this.reloadConfig(),
        defaultTimezone: this.config.schedules.timezone,
        ...(channel.dreamsEnabled
          ? {
              dream: {
                run: () => this.runDream(channel.ref.id),
                forgetAfterDays: this.dreamSettings.forgetAfterDays,
              },
            }
          : {}),
      });
      await client.chat.postMessage({
        channel: msg.channelId,
        thread_ts: threadTs,
        text: reply,
      });
      return;
    }

    // Requirements are checked per channel: a channel that needs `gh` should
    // say so up front rather than failing mid-task.
    const requirements = checkRequirements(channel.requires, channel.env);
    if (!requirements.ok && requirements.onMissing === "fail") {
      await client.chat.postMessage({
        channel: msg.channelId,
        thread_ts: threadTs,
        text:
          `:warning: This channel is missing required tooling, so I can't run here:\n` +
          `${describeMissing(requirements)}\n\nInstall it on the host (or in the container) and try again.`,
      });
      return;
    }
    if (!requirements.ok) {
      logger.warn(
        `channel ${channel.ref.id} missing requirements (warn mode):\n${describeMissing(requirements)}`,
      );
    }

    // A message in a workflow run's status thread is told which run it is and where the run stands.
    const runContext = msg.threadTs && channel.factory ? await this.factoryPresence.contextForThread(channel, msg.threadTs) : undefined;
    // Reactions carry their own event identity, not the source message's ID.
    await this.runAgent(client, channel, threadKey, threadTs, msg, runContext ? `${runContext}\n\n${prompt}` : prompt, { requestId: requestId ?? `slack:${channel.ref.id}:${msg.ts}` });
  }

  private scheduleRecentConversationSummary(channel: ResolvedChannel, threadKey: string): void {
    const settings = channel.recentConversations;
    if (!settings.enabled) return;

    const key = `${channel.ref.id}:${threadKey}`;
    const existing = this.recentConversationTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.recentConversationTimers.delete(key);
      void this.updateRecentConversationSummary(channel.ref.id, threadKey);
    }, settings.debounceSeconds * 1000);
    timer.unref?.();
    this.recentConversationTimers.set(key, timer);
  }

  private async updateRecentConversationSummary(channelId: string, threadKey: string): Promise<void> {
    const { channel, rejected } = await this.resolveBackgroundChannel(channelId);
    if (rejected || !channel || !channel.recentConversations.enabled) return;

    try {
      // The summary reads the thread from its channel's store; a channel with no store has no threads.
      const runtime = this.runtimes.peek(channelId);
      if (!runtime) return;
      const entry = await summarizeRecentConversation({
        channel,
        source: storeTranscriptSource(runtime.store),
        threadKey,
        modelRuntime: this.opts.modelRuntime,
        model: channel.recentConversations.model,
        maxTranscriptChars: channel.recentConversations.maxTranscriptChars,
        onUsage: (message) => recordUsage({ channel, threadKey, source: "recent-conversation", message }),
      });
      if (!entry) return;
      new RecentConversationList(channel.paths.recentConversationsFile).upsert(
        entry,
        channel.recentConversations.maxThreads,
      );
      // New threads fork from the channel's main conversation, so a digest there is how they learn
      // what the channel has been doing without re-reading Slack. Running threads keep the list above.
      await runtime.store.appendMainContext("slack.thread.digest", `[recent thread ${threadKey}] ${entry.summary}`);
      logger.debug(`recent conversation summarised: ${channelId}/${threadKey}`);
    } catch (err) {
      logger.warn(
        `recent conversation summary failed for ${channelId}/${threadKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async runAgent(
    client: WebClient,
    channel: ResolvedChannel,
    threadKey: string,
    threadTs: string,
    msg: IncomingMessage,
    prompt: string,
    options?: { scheduled?: Pick<ScheduledTask, "timezone">; scheduledThread?: boolean; taskTracker?: TaskRunTracker; requestId?: string; steering?: TurnSteering },
  ): Promise<AgentRunResult> {
    const queueKey = `${channel.ref.id}:${threadKey}`;
    // Only real incoming Slack messages steer; internal jobs/delegations still enter via FIFO.
    const interactive = options?.requestId?.startsWith("slack:") && !options.scheduled;
    this.turnSteering ??= new Map();
    // Alias unthreaded DM arrivals only while active. Idle messages keep their existing
    // thread/session identity and delivery destination.
    const dmAlias = (msg.channelType === "im" || msg.channelId.startsWith("D")) && !msg.threadTs ? msg.channelId + ":dm" : undefined;
    const active = msg.arrivalRecorded ? msg.steeringTarget : this.turnSteering.get(dmAlias ?? queueKey);
    if (interactive && active) {
      if (active.requestId === options!.requestId) return active.run;
      // A single turn has one tool principal. Cross-author input must run later as
      // its own speaker, never borrow the active owner's approvals or credentials.
      const accepted = active.userId === msg.userId && await active.inbox.offer({
        requestId: options!.requestId!, userId: msg.userId, messageTs: msg.ts,
        prepare: async () => {
          const resolved = resolveChannel(this.config, this.opts.dataDir, channel.ref, this.registry);
          const current = resolved.channel;
          if (!current || resolved.rejected || (current.allowUsers && !current.allowUsers.includes(msg.userId))) {
            throw new Error("Steering speaker/channel is no longer allowed.");
          }
          const { images, notes } = await collectFiles(msg.files, this.opts.botToken, {
            paths: current.paths, userId: msg.userId, canFile: current.documents.canAdd,
          });
          const model = await this.pool.get(channel.ref.id, active.threadKey)?.session.model();
          const canSeeImages = modelAcceptsImages(model);
          if (images.length && !canSeeImages) notes.push("Images were attached but the current model cannot see them. Tell the author or switch to an allowed vision-capable model.");
          return { text: notes.length ? prompt + "\n\n[" + notes.join(" ") + "]" : prompt,
            ...(canSeeImages && images.length ? { images } : {}) };
        },
      });
      if (accepted) return active.run;
      // Cross-author input, a closed watcher, or unavailable admission uses its own
      // queued turn. Preserve arrival before the response, including final rendering.
      prompt = steeringText(msg.userId, msg.ts, prompt);
    }
    const inbox = new TurnSteering();
    options = { ...options, requestId: options?.requestId ?? `internal:${randomUUID()}`, steering: inbox };
    const previous = this.turnQueue.get(queueKey);
    const publishOwner = () => {
      this.turnSteering.set(queueKey, owner);
      if (dmAlias) this.turnSteering.set(dmAlias, owner);
    };
    const run = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async (): Promise<AgentRunResult> => {
        // The FIFO tail is not the active steering target. Publish queued work only
        // when it actually starts; the first owner is also published synchronously below.
        publishOwner();
        // Never start a queued turn with the config captured when it arrived.
        // Resolve synchronously with the snapshot used by session construction;
        // acquire its lease before the first await (e.g. Slack/connector setup).
        const turnConfig = this.config;
        const resolved = resolveChannel(turnConfig, this.opts.dataDir, channel.ref, this.registry);
        const currentChannel = resolved.channel;
        let error = resolved.rejected;
        if (currentChannel?.allowUsers && msg.userId !== this.botUserId && !currentChannel.allowUsers.includes(msg.userId)) {
          error = `User ${msg.userId} is no longer allowed in ${msg.channelId}.`;
        }
        if (options?.scheduled && currentChannel && !currentChannel.schedulesEnabled) {
          error = "Scheduling is disabled in this channel.";
        }
        if (error || !currentChannel) {
          options?.taskTracker?.finish("failed", error ?? "Channel unavailable.");
          return { status: "failed", error: error ?? "Channel unavailable." };
        }
        channel = currentChannel;
        this.pool.beginTurn(channel.ref.id, threadKey);
        try {
          return await this.runAgentTurn(client, channel, threadKey, threadTs, msg, prompt, options, turnConfig);
        } finally {
          await this.pool.endTurn(channel.ref.id, threadKey);
        }
      });

    this.turnQueue.set(queueKey, run);
    const owner = { requestId: options.requestId!, userId: msg.userId, threadKey, inbox, run };
    if (!previous) publishOwner();
    try {
      return await run;
    } finally {
      inbox.close();
      if (this.turnSteering.get(queueKey)?.inbox === inbox) this.turnSteering.delete(queueKey);
      if (dmAlias && this.turnSteering.get(dmAlias)?.inbox === inbox) this.turnSteering.delete(dmAlias);
      if (this.turnQueue.get(queueKey) === run) this.turnQueue.delete(queueKey);
      this.scheduleRecentConversationSummary(channel, threadKey);
    }
  }

  /**
   * What every session in a channel is built from. A normal live turn adds its thread and speaker
   * on top; startup recovery and commands use it as-is. It is also the `template` for restricted runs.
   */
  private baseSessionOptions(channel: ResolvedChannel, turnConfig: HarnessConfig): Omit<CreateThreadSessionOptions, "threadKey"> {
    return {
      channel,
      harnessName: turnConfig.name,
      slackChannelLabel: channel.ref.name ? `#${channel.ref.name}` : "a direct message",
      botUserId: this.botUserId,
      modelRuntime: this.opts.modelRuntime,
      runtimes: this.runtimes,
      ...(channel.schedulesEnabled ? { schedules: this.scheduler } : {}),
      factoryGitHub: () => this.factoryBackend(channel),
      factoryAnnounce: (runId) => this.factoryPresence.ensurePost(channel, runId),
      factoryIntakeKick: () => this.intakeLoop.pollNow(channel.ref.id),
      factoryEnsureLabels: async () => { await this.ensureFactoryLabels(channel.ref.id, true); },
      poster: this,
      crossPoster: this,
      userPoster: this.postAs,
      ...(channel.interactiveComponents.enabled ? { interactiveResponses: this } : {}),
      uploader: this,
      delegator: this,
      permissions: this,
      capabilityRequests: this.capabilityService(),
      feedbackResolution: {
        announceResolved: turnConfig.feedback.announceResolved,
        notify: async (channelId, text) => {
          await this.post({ channelId, text });
        },
      },
      defaultTimezone: turnConfig.schedules.timezone,
      onViolation: (m) => logger.warn(`[jail] ${channel.ref.id}: ${m}`),
      onSubagentMessage: ({ runKey, message }) => recordUsage({ channel, threadKey: runKey, source: "subagent", message }),
      timeline: timelineForChannel(channel),
      ...(channel.admin ? { adminConfig: this.adminConfigService() } : {}),
      ...(channel.agents.some((agent) => agent.configuration) ? { configuratorConfig: this.configuratorConfig() } : {}),
    };
  }

  /** No caller-selected destination or approver list: persisted admin configuration is rechecked on every transition. */
  private capabilityService(): CapabilityRequests {
    return this.capabilityRequestService ??= new CapabilityRequests({
      operator: this.configuratorConfig(),
      resolveId: (key) => this.resolvePostTargetId(key),
      isHuman: async (id) => {
        if (!/^[UW][A-Z0-9]+$/.test(id) || id === this.botUserId) return false;
        const { user } = await this.app.client.users.info({ user: id });
        return !!user && user.id === id && user.is_bot === false && !user.deleted && !user.is_app_user;
      },
      post: async (item) => {
        const sent = await this.app.client.chat.postMessage({ channel: item.adminId, text: `Capability request ${item.id}: ${item.state}`, blocks: capabilityBlocks(item) });
        if (!sent.ts) throw new Error("Slack did not confirm the admin request message.");
        return sent.ts;
      },
      notify: async (item, outcome) => {
        if (item.messageTs) await this.app.client.chat.update({ channel: item.adminId, ts: item.messageTs, text: `Capability request ${item.id}: ${item.state}`, blocks: capabilityBlocks(item, outcome) });
        await this.app.client.chat.postMessage({ channel: item.actor.channelId, text: escapeSlack(`Capability request ${item.id} (${item.kind}/${item.name}): ${item.state}. ${outcome}`), parse: "none", unfurl_links: false, unfurl_media: false });
      },
    });
  }

  /** Host-only configuration hooks; the subagent runner binds the scope and actor. */
  private configuratorConfig(): OperatorConfig {
    return { configPath: this.opts.configPath, dataDir: this.opts.dataDir, reload: () => this.reloadConfig() };
  }

  /**
   * What the admin channel's agent uses to read and change harness.yaml. The rules (what may change, what stays on the host) live
   * in the config module; this supplies the file, the data directory, a check that a model named in an edit exists, and the reload.
   */
  adminConfigService(): AdminConfigService {
    const request = (edits: ConfigEdit[], actor: { channelId: string; channelKey?: string; userId: string }, extra: { privileged?: boolean; dryRun?: boolean } = {}) => editConfig({
      configPath: this.opts.configPath,
      edits,
      actor,
      dataDir: this.opts.dataDir,
      validate: (applied) => this.checkModelsExist(applied),
      ...extra,
      reload: async () => {
        const result = await this.reloadConfig();
        return { applied: result.applied, ...(result.error ? { error: result.error } : {}), warnings: result.warnings };
      },
    });
    return {
      read: (path) => readConfig(this.opts.configPath, path),
      edit: ({ edits, actor }) => request(edits, actor),
      propose: async ({ edits, reason, actor, approvers }) => {
        // Only a change that is refused WITHOUT the approval is worth asking about; one that needs none is just made.
        const plain = await request(edits, actor, { dryRun: true }).then(() => true, (error: unknown) => {
          if (error instanceof ConfigEditError) return false;
          throw error;
        });
        if (plain) throw new ConfigEditError("That needs no approval; make it with admin_config_edit.");
        // If it is refused even with approval, say so now rather than after somebody has clicked.
        const preview = await request(edits, actor, { privileged: true, dryRun: true });
        let summary: string[];
        try { summary = summariseChanges(preview.changes); }
        catch (error) { throw new ConfigEditError(error instanceof Error ? error.message : String(error)); }
        let item;
        try {
          item = this.configApprovals.add({
            edits, reason, summary, approvers,
            channelId: actor.channelId,
            ...(actor.channelKey ? { channelKey: actor.channelKey } : {}),
            threadTs: this.pendingThread.get(actor.channelId) ?? "",
            requestedBy: actor.userId,
          });
        } catch (error) { throw new ConfigEditError(error instanceof Error ? error.message : String(error)); }
        const sent = await this.app.client.chat.postMessage({
          channel: actor.channelId,
          ...(item.threadTs ? { thread_ts: item.threadTs } : {}),
          text: "Harness config change needs approval",
          blocks: buildConfigApprovalBlocks(item),
        });
        if (sent.ts) this.activityOf(actor.channelId)?.record({ key: `config:${item.id}`, sourceTs: sent.ts, kind: "approval", title: "Config change needs approval", interaction: "pending", ephemeral: true, expiresAt: new Date(item.expiresAt).toISOString() });
        this.timelineOf(actor.channelId, actor.channelId.startsWith("D")).record({
          kind: "approval.requested", actor: "channel", ...(item.threadTs ? { threadKey: item.threadTs } : {}), userId: actor.userId,
          title: "Asked for approval: harness config change", detail: item.summary.map((l) => l.split("\n")[0]).join(", "),
        });
        return { id: item.id, changes: preview.changes };
      },
    };
  }

  /** An approve or deny click on a pending config change. Only the approvers named when it was requested can decide it. */
  private async decideConfigChange(client: WebClient, body: any): Promise<void> {
    const action = body?.actions?.[0];
    const id = String(action?.value ?? "");
    const clicker: string = body?.user?.id ?? "";
    const approve = action?.action_id === CONFIG_APPROVE_ACTION;
    const pending = this.configApprovals.peek(id);
    if (!pending) {
      await client.chat.postEphemeral({ channel: body?.channel?.id ?? "", user: clicker, text: "That request has expired or was already decided. Ask again if it is still needed." }).catch(() => undefined);
      return;
    }
    if (!pending.approvers.includes(clicker)) {
      await client.chat.postEphemeral({ channel: pending.channelId, user: clicker, text: `Only ${pending.approvers.map((u) => `<@${u}>`).join(", ")} can approve this.` });
      return;
    }
    this.configApprovals.take(id);
    this.activityOf(pending.channelId)?.resolve(body?.message?.ts);

    let text: string;
    let applied = false;
    if (!approve) {
      text = `:no_entry: Config change denied by <@${clicker}>.`;
    } else {
      try {
        // The whole policy runs again against the file as it is now: an approval covers these edits, not whatever the file has become.
        const result = await editConfig({
          configPath: this.opts.configPath,
          edits: pending.edits,
          actor: { channelId: pending.channelId, ...(pending.channelKey ? { channelKey: pending.channelKey } : {}), userId: clicker },
          dataDir: this.opts.dataDir,
          privileged: true,
          validate: (applied) => this.checkModelsExist(applied),
          reload: async () => {
            const reloaded = await this.reloadConfig();
            return { applied: reloaded.applied, ...(reloaded.error ? { error: reloaded.error } : {}), warnings: reloaded.warnings };
          },
        });
        applied = true;
        text = `:white_check_mark: Config change approved by <@${clicker}> and applied (backup: \`${result.backup}\`).`;
        logger.info(`config change ${id} approved by ${clicker}: ${result.changes.map((c) => c.path).join(", ")}`);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        text = `:warning: Approved by <@${clicker}>, but not applied: ${escapeSlack(why)}`;
        logger.warn(`config change ${id} approved by ${clicker} but not applied: ${why}`);
      }
    }
    this.timelineOf(pending.channelId, pending.channelId.startsWith("D")).record({
      kind: "approval.decided", actor: "channel", ...(pending.threadTs ? { threadKey: pending.threadTs } : {}), userId: clicker,
      title: `${approve ? (applied ? "Approved" : "Approved, not applied") : "Denied"}: harness config change`, status: approve ? "granted" : "denied",
      detail: "",
    });
    try {
      await client.chat.update({ channel: pending.channelId, ts: body.message.ts, text: "Harness config change decided", blocks: decidedConfigBlocks(pending, text) });
    } catch (err) {
      logger.debug("could not update the config approval message", err);
    }
  }

  /** Unblock or Dismiss on a held post_as_user alert. The rules live in post-as-clicks.ts and the service. */
  /** A click on a workflow run's status post. See factory-clicks.ts. */
  private async decideFactoryRun(client: WebClient, body: any, submission = false): Promise<void> {
    await (submission ? submitFactoryRunChanges : decideFactoryRunClick)({
      client,
      presence: this.factoryPresence,
      channelFor: async (channelId) => {
        const isDm = channelId.startsWith("D");
        const name = isDm ? undefined : await this.channelName(client, channelId);
        const { channel } = resolveChannel(this.config, this.opts.dataDir, { id: channelId, ...(name ? { name } : {}), isDm }, this.registry);
        return channel?.factory ? channel : undefined;
      },
      serviceFor: (channel, clicker, threadTs) => createFactoryRunService({
        channel, store: () => this.runtimes.peek(channel.ref.id)?.store, github: () => undefined, threadKey: threadTs, currentUserId: () => clicker, source: "operator",
      }),
    }, body);
  }

  private async decideHeldPost(client: WebClient, body: any): Promise<void> {
    await decideHeldPost({ client, service: this.postAs, postAsFor: (channelId) => this.channelNow(channelId)?.postAs }, body);
  }

  /** The channel as the config says it is right now, resolved without calling Slack. */
  private channelNow(channelId: string): ResolvedChannel | undefined {
    const isDm = channelId.startsWith("D");
    const name = isDm ? undefined : this.registry.nameFor(channelId);
    return resolveChannel(this.config, this.opts.dataDir, { id: channelId, ...(name ? { name } : {}), isDm }, this.registry).channel;
  }

  /** The post_as_user service. Overrides are for tests; production posts as a person only through createUserClient. */
  private createPostAsService(overrides: Partial<PostAsServiceDeps> = {}): PostAsService {
    const statusOf = { sent: "ok", held: "blocked", unblocked: "ok", dismissed: "done" } as const;
    return new PostAsService({
      botClient: this.app.client,
      userClient: createUserClient,
      // The footer names this app. Read at send time: the id is only known once the app has started.
      botUserId: () => this.botUserId,
      tokens: (channelId) => {
        const channel = this.channelNow(channelId);
        if (!channel) throw new Error("This channel is not configured here, so nothing can be posted as anyone from it.");
        return userTokensFor(channel);
      },
      review: (input, postAs, sourceChannelId) => {
        const channel = this.channelNow(sourceChannelId);
        return reviewDraft(
          {
            modelRuntime: this.opts.modelRuntime,
            role: postAs.reviewer,
            onUsage: (message) => { if (channel) recordUsage({ channel, source: "post-guard", message }); },
          },
          input,
        );
      },
      held: new PendingHeldPosts(),
      limiter: new RateLimiter(),
      onHeld: (e) => this.activityOf(e.channelId)?.record({ key: `held:${e.id}`, sourceTs: e.ts, kind: "approval", title: "Held post needs your decision", interaction: "pending", ephemeral: true, expiresAt: new Date(e.expiresAt).toISOString() }),
      onHeldConsumed: (channelId, id) => this.activityOf(channelId)?.resolveKey(`held:${id}`),
      onEvent: (e) =>
        this.timelineOf(e.channelId, e.channelId.startsWith("D")).record({
          kind: "post", actor: "channel", title: e.title, detail: e.detail, userId: e.userId, status: statusOf[e.status],
        }),
      ...overrides,
    });
  }

  /** A model named in an edit has to be one this harness can resolve, or the channel would be left unable to answer. */
  private checkModelsExist(edits: ConfigEdit[]): string | undefined {
    for (const edit of edits) {
      const last = edit.path.at(-1);
      const isModel = last === "model" && typeof edit.value === "string" && !edit.remove;
      if (!isModel) continue;
      try { resolveModel(edit.value as string, this.opts.modelRuntime); }
      catch { return `No model called "${edit.value as string}" is available here, so nothing was changed. \`!models\` lists what is.`; }
    }
    return undefined;
  }

  /** Separate from tool telemetry: user-facing publications and authoritative interaction-state changes. */
  private activityOf(channelId: string): ChannelActivityLog | undefined {
    return this.opts?.dataDir ? new ChannelActivityLog(channelPaths(this.opts.dataDir, channelId).root, channelId) : undefined;
  }

  private recordReplyActivity(channelId: string, text: string, requestId: string, threadTs: string, scheduled = false): void {
    if (!text.trim()) return;
    this.activityOf(channelId)?.record({ key: `reply:${requestId}`, kind: scheduled ? "scheduled" : "chat", sourceTs: threadTs,
      title: scheduled ? "Scheduled update" : "Conversation update", text });
  }

  /** The channel's timeline log. Excerpts of what people said are left out of direct messages. */
  private timelineOf(channelId: string, isDm: boolean) {
    return timelineFor(channelPaths(this.opts.dataDir, channelId).root, isDm);
  }

  private async runAgentTurn(
    client: WebClient,
    channel: ResolvedChannel,
    threadKey: string,
    threadTs: string,
    msg: IncomingMessage,
    prompt: string,
    options?: { scheduled?: Pick<ScheduledTask, "timezone">; scheduledThread?: boolean; taskTracker?: TaskRunTracker; requestId?: string; steering?: TurnSteering },
    turnConfig: HarnessConfig = this.config,
  ): Promise<AgentRunResult> {
    // Normal conversational replies do not create records. Scheduled runs and
    // clearly substantive requests start immediately; other interactive turns
    // become tasks only when a substantive tool proves work is being done.
    const initialTaskKind = options?.scheduled ? "scheduled" : substantivePromptKind(prompt);
    const task = options?.taskTracker ?? new TaskRunTracker(this.taskStore, {
      channelId: channel.ref.id,
      ...(channel.ref.name ? { channelName: channel.ref.name } : {}),
      threadKey,
      summary: redactTaskUrls(prompt.trim()).slice(0, 500) || "Agent work",
      ...(initialTaskKind ? { kind: initialTaskKind } : {}),
    });
    if (initialTaskKind && !options?.taskTracker) task.start(initialTaskKind);
    // A plain Slack reply is often precisely the dependency we were waiting
    // on. Resume it even when that reply does not itself look like new work.
    if (!initialTaskKind && !options?.taskTracker && shouldResumeWaitingTask(this.taskStore, channel.ref.id, threadKey)) {
      task.start();
    }

    // A request_access call during this turn should post into this thread.
    this.pendingThread.set(msg.channelId, threadTs);
    this.pendingUser.set(msg.channelId, msg.userId);

    const stream = new SlackResponseStream({
      client,
      channel: msg.channelId,
      threadTs,
      // React to the message that triggered this turn.
      anchorTs: msg.ts,
      ackEmoji: turnConfig.ui.ackEmoji,
      assistantThread: msg.channelType === "im",
      quietAfterMs: turnConfig.ui.toolActivityAfterMs,
    });

    try {
      await stream.open();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("could not post placeholder message", err);
      task.finish("failed", detail);
      return { status: "failed", error: detail };
    }

    let activeModelRef = channel.model;
    const turnStartedAt = performance.now();
    const timeline = timelineForChannel(channel);
    let historyMs = 0;
    let firstOutputAt: number | undefined;
    let newSessionTimings: { toolsMs: number; storeMs: number; threadMs: number; totalMs: number } | undefined;

    try {
      const toolActivity = turnConfig.ui.showToolActivity;
      const showTools = toolActivity !== false;
      // In long_running mode the stream sits on these until the turn goes quiet.
      const progress = { defer: toolActivity === "long_running" };
      if (showTools) stream.setStatus("thinking…", progress);
      let thread = this.pool.get(channel.ref.id, threadKey);
      // A thread with no conversation yet is genuinely new, as opposed to one
      // resumed after an idle eviction. Slack holds the only record of what was
      // said before it, and this is the one turn on which to read it.
      let isNewConversation = false;
      if (!thread) {
        if (showTools) stream.setStatus("starting up…", progress);
        thread = await createThreadSession({
          ...this.baseSessionOptions(channel, turnConfig),
          threadKey,
          threadTs,
          initialUserId: msg.userId,
        });
        isNewConversation = thread.isNewConversation;
        newSessionTimings = thread.timings;
        await this.pool.set(channel.ref.id, threadKey, thread);
      }

      // Every other entry point (scheduled runs, check-backs, shortcuts, resumes) is a fresh request each time.
      const requestId = options?.requestId ?? `internal:${randomUUID()}`;
      if (await thread.store.steeringParent(threadKey, requestId)) {
        // The durable steering receipt, not just an in-memory set, owns Slack redeliveries.
        await stream.discard();
        task.finish("completed");
        return { status: "completed", postedDirectly: true };
      }
      if (this.resumedRequests.has(requestId)) {
        // The restart-recovery is already answering this very request; replying here too would double-post.
        logger.info(`request ${requestId} in ${channel.ref.id} is being resumed after a restart; not answering it twice`);
        await stream.discard();
        task.finish("completed");
        return { status: "completed", postedDirectly: true };
      }
      // Make the reply idempotent: a Slack redelivery or a restart can never produce a second message, and an
      // answer already delivered is not generated again.
      await stream.attachLedger(storeLedger({
        store: thread.store, client, channel: channel.ref.id, threadTs, threadKey, requestId,
        onDelivered: (text, id, ts) => this.recordReplyActivity(channel.ref.id, text, id, ts, !!options?.scheduled),
      }));
      if (stream.delivered) {
        logger.info(`duplicate request ${requestId} in ${channel.ref.id}: already answered, not running again`);
        await stream.discard();
        task.finish("completed");
        return { status: "completed", postedDirectly: true };
      }

      // A turn can contain several assistant messages: the agent says
      // something, calls a tool, then says something else. All of it is the
      // reply, so every part is collected. Using only the final message would
      // discard the substance and leave just the closing remark.
      const parts: string[] = [];
      const outcome = new AgentTurnOutcome();
      let current = "";
      // If the agent published directly — a channel message, or a file people
      // can already see — its reply is not the deliverable, and an empty one
      // should not become "(no response)".
      let postedDirectly = false;
      const publishingTools = new Set(["post_message", "upload_file"]);
      const flush = () => {
        if (current.trim()) parts.push(current.trim());
        current = "";
      };

      const unsubscribe = thread.session.subscribe((event: TurnEvent) => {
        if (firstOutputAt === undefined && (event.type === "text_delta" || event.type === "tool_start")) firstOutputAt = performance.now();
        switch (event.type) {
          case "assistant_message_start":
            // Separate consecutive assistant messages in the rendered reply.
            if (current.trim()) stream.appendText("\n\n");
            flush();
            break;
          case "text_delta":
            // A live preview; the message end below replaces it with the authoritative text when it has some.
            current += event.delta;
            stream.appendText(event.delta);
            break;
          case "assistant_message_end":
            // The finished message is authoritative when it has text; an error ending has none and
            // must not erase what was already streamed.
            current = assistantText(event.message) || current;
            outcome.observe(event.message);
            recordUsage({ channel, threadKey, source: options?.scheduled ? "scheduled" : "agent", message: event.message });
            break;
          case "tool_start":
            task.onToolStart(event.toolName);
            if (showTools) stream.setStatus(`running \`${event.toolName}\`…`, progress);
            break;
          case "tool_end":
            // A subagent run is drawn as its own branch, so the call that started it is not also a step on the main line.
            if (event.toolName !== "run_subagent") {
              timeline.record({ kind: "tool", actor: "channel", threadKey, title: event.toolName, status: event.isError ? "error" : "ok" });
            }
            if (event.isError) task.onToolError(event.toolName);
            if (publishingTools.has(event.toolName) && !event.isError) postedDirectly = true;
            if (showTools) stream.setStatus("thinking…", progress);
            break;
          case "compaction_start":
            stream.setStatus("summarising earlier conversation…");
            break;
          default:
            break;
        }
      });

      // Attachments. Slack file URLs are private, so this needs files:read.
      // Documents are staged into this channel's workspace as text, whether or
      // not it may file them: being able to read what was attached is worth
      // having on its own, and is the half that stays inside the channel.
      const { images, notes } = await collectFiles(msg.files, this.opts.botToken, {
        paths: channel.paths,
        userId: msg.userId,
        canFile: channel.documents.canAdd,
      });
      const model = await thread.session.model();
      activeModelRef = [model?.provider, model?.id].filter(Boolean).join("/") || activeModelRef;
      const canSeeImages = modelAcceptsImages(model);

      const attachmentNotes = [...notes];
      let attachedImages = images;

      if (images.length > 0 && !canSeeImages) {
        // Don't silently drop them: say so, and point at the way out. The
        // agent has switch_model, so it can move to a vision-capable model
        // itself if this channel allows one.
        attachedImages = [];
        const alternatives = listModels({
          catalog: this.opts.modelRuntime,
          allow: channel.models,
          onlyAvailable: true,
        })
          .filter((m) => m.acceptsImages)
          .slice(0, 3)
          .map((m) => m.ref);

        attachmentNotes.push(
          `${images.length} image(s) were attached, but the current model ` +
            `(${model?.provider}/${model?.id}) cannot see images.` +
            (alternatives.length > 0
              ? ` You can switch to one that can: ${alternatives.join(", ")}. Ask before switching if cost matters.`
              : ` No vision-capable model is available in this channel, so tell the user you cannot look at it.`),
        );
      }

      const body = attachmentNotes.length > 0
        ? `${prompt || "(no message text)"}\n\n[${attachmentNotes.join(" ")}]`
        : prompt;

      // What was already said, read from Slack. Once per conversation, so an
      // ongoing thread pays nothing. A normal scheduled run skips this because
      // the harness created its thread a moment ago; a scheduled thread
      // check-back reads history only if its persisted transcript is missing.
      let preamble: string | undefined;
      if (isNewConversation && (!options?.scheduled || options?.scheduledThread)) {
        if (showTools) stream.setStatus("reading the conversation…", progress);
        // A thread with an older JSONL transcript is one the conversation store is picking up for the first time.
        const historyStartedAt = performance.now();
        preamble = await this.readHistory(client, channel, msg, hasLegacyTranscript(channel.paths.sessions, threadKey));
        historyMs = performance.now() - historyStartedAt;
      }

      const framed = options?.scheduled
        ? scheduledPrompt(body, options.scheduled.timezone, options.scheduledThread)
        : `<@${msg.userId}> says:\n\n${body}`;

      if (showTools) stream.setStatus("thinking…", progress);

      try {
        // Attribute the speaker: several people share a channel, and the agent
        // should be able to tell them apart.
        thread.currentUserId = msg.userId;
        thread.setTaskTracker(task);
        // A subagent started during this turn tells the thread what it was handed and what it finds, ahead of the answer.
        const progressMode = turnConfig.ui.subagentProgress ?? "all";
        thread.setSubagentProgress(progressMode === "off" ? undefined : new SubagentProgressPoster(stream, { updates: progressMode === "all" }).sink);
        timeline.record({
          kind: "turn.start", actor: "channel", threadKey, userId: msg.userId,
          title: options?.scheduled ? "Scheduled run" : `Request from ${msg.userId}`,
          detail: redactTaskUrls(prompt.trim()), model: activeModelRef,
        });
        await thread.session.prompt(preamble ? `${preamble}\n\n${framed}` : framed, {
          // Slack redelivers an event with the same message ts, so a retry is the same request.
          requestId,
          userId: msg.userId,
          // History/fallback framing can differ on redelivery. Identify real Slack input by
          // its original payload, not transient runtime chronology/context annotations.
          fingerprint: options?.requestId?.startsWith("slack:")
            ? JSON.stringify({ text: msg.text ?? prompt, files: (msg.files ?? []).map((file) => file.id ?? file.name ?? file.url_private) })
            : `${framed}\u0000${attachedImages.length}`,
          ...(attachedImages.length > 0 ? { images: attachedImages } : {}),
          ...(options?.steering ? { steering: options.steering } : {}),
        });
      } finally {
        thread?.setTaskTracker(undefined);
        thread?.setSubagentProgress(undefined);
        unsubscribe();
      }

      outcome.assertCompleted();
      // A cold turn (new session or new conversation) is where the time goes; say where, once, so it can be seen.
      if (newSessionTimings || isNewConversation) {
        const total = Math.round(performance.now() - turnStartedAt);
        logger.info(
          `first-turn timing ${channel.ref.name ?? channel.ref.id}/${threadKey}: total ${total}ms` +
            (newSessionTimings ? ` = session ${newSessionTimings.totalMs}ms (tools ${newSessionTimings.toolsMs}, store+recovery ${newSessionTimings.storeMs}, thread ${newSessionTimings.threadMs})` : "") +
            `${isNewConversation ? ` + slack history ${Math.round(historyMs)}ms` : ""}` +
            `${firstOutputAt !== undefined ? ` ; first model output at +${Math.round(firstOutputAt - turnStartedAt)}ms` : ""}`,
        );
      }
      flush();
      // Fall back to the last assistant message only if nothing was streamed,
      // e.g. a reply that arrived without deltas.
      const final = parts.length > 0 ? parts.join("\n\n") : thread.session.getLastAssistantText();

      const delivery = await finishAgentReply(stream, final, postedDirectly);
      if (delivery.deliveryError) {
        logger.warn(`could not render completed agent response in ${channel.ref.id}: ${delivery.deliveryError}`);
      }
      task.finish("completed");
      timeline.record({
        kind: "turn.end", actor: "channel", threadKey, title: "Replied", status: "ok",
        durationMs: Math.round(performance.now() - turnStartedAt), detail: redactTaskUrls(final ?? ""),
      });
      return {
        status: "completed",
        ...(final?.trim() ? { text: final } : {}),
        ...(postedDirectly ? { postedDirectly: true } : {}),
        ...delivery,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (shouldRenderNoResponseForAgentError(err, activeModelRef)) {
        logger.warn(`agent run exhausted codex usage in ${channel.ref.id}: ${detail}`);
        // This is still a final Slack render. Keep a channel_not_found (or
        // similar delivery failure) from replacing the actual model outcome
        // in a delegated completion callback.
        const result = await finishNoResponseAgentFailure(stream, detail);
        if (result.deliveryError) {
          logger.warn(`could not render exhausted-agent response in ${channel.ref.id}: ${result.deliveryError}`);
        }
        task.finish("failed", detail);
        return result;
      }
      logger.error(`agent run failed in ${channel.ref.id}`, err);
      timeline.record({ kind: "turn.end", actor: "channel", threadKey, title: "Failed", status: "error", detail, durationMs: Math.round(performance.now() - turnStartedAt) });
      await stream.fail(`Something went wrong: ${detail}`);
      task.finish("failed", detail);
      return { status: "failed", error: detail };
    }
  }

  /**
   * Run a scheduled task. Most visible tasks post a fresh top-level message in
   * their own channel and answer in that thread. One-shot check-backs can
   * instead resume the Slack thread where they were created. Quiet tasks run
   * headlessly; people only see messages the agent explicitly publishes.
   */
  private async runScheduledTask(task: ScheduledTask): Promise<ScheduledTaskRunResult> {
    const client = this.app.client;
    // Record the attempt before channel resolution or Slack delivery. Those
    // early failures are real scheduled work and belong in task history.
    const taskStatus = this.taskStore
      ? new TaskRunTracker(this.taskStore, {
          channelId: task.channelId,
          threadKey: task.thread?.threadKey ?? `scheduled-${task.id}`,
          summary: redactTaskUrls(task.prompt.trim()).slice(0, 500) || "Scheduled work",
          kind: "scheduled",
        })
      : undefined;
    taskStatus?.start("scheduled");

    try {
      const { channel, rejected } = await this.resolveBackgroundChannel(task.channelId);
      if (rejected || !channel) {
        const error = `Channel unavailable${rejected ? `: ${rejected}` : ""}.`;
        logger.warn(`scheduled task ${task.id}: ${error}`);
        taskStatus?.finish("failed", error);
        return { status: "failed", error };
      }
      if (!channel.schedulesEnabled) {
        const error = `Scheduling is disabled in ${task.channelId}.`;
        logger.info(`scheduled task ${task.id}: ${error}`);
        taskStatus?.finish("failed", error);
        return { status: "failed", error };
      }

      logger.info(
        `scheduled task ${task.id}: config=${channel.configKey ?? "(defaults — no matching entry)"} ` +
          `tools=[${channel.tools.join(",")}] env=[${channel.envSources.join(",")}] ` +
          `mode=${task.quiet ? "quiet" : task.thread ? "thread" : "visible"}`,
      );
      if (task.heartbeat && task.prompt.trim().toLowerCase() === "nothing to do") {
        taskStatus?.finish("completed");
        return { status: "completed" };
      }
      if (task.heartbeat || task.quiet) return this.runQuietScheduledTask(channel, task, taskStatus);

      if (task.thread) {
        markThreadActive(channel.paths.sessions, task.thread.threadKey);
        const slackOutputUrl = await this.scheduledOutputPermalink(task.channelId, task.thread.threadTs);
        const result = await this.runAgent(
          client, channel, task.thread.threadKey, task.thread.threadTs,
          { channelId: task.channelId, userId: task.createdBy, text: task.prompt, ts: task.thread.threadTs },
          task.prompt, { scheduled: { timezone: task.timezone }, scheduledThread: true, ...(taskStatus ? { taskTracker: taskStatus } : {}) },
        );
        return scheduledRunResult(result, slackOutputUrl);
      }

      const posted = await this.post({ channelId: task.channelId, text: `:alarm_clock: *Scheduled* — ${task.prompt}` });
      const threadTs = posted.ts;
      // Replies to a visible scheduled post are the continuation boundary for
      // wait/block tasks, so replace the pre-post synthetic key immediately.
      taskStatus?.setThreadKey(threadTs);
      const result = await this.runAgent(
        client, channel, threadTs, threadTs,
        { channelId: task.channelId, userId: task.createdBy, text: task.prompt, ts: threadTs },
        task.prompt, { scheduled: { timezone: task.timezone }, ...(taskStatus ? { taskTracker: taskStatus } : {}) },
      );
      return scheduledRunResult(result, posted.permalink);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      taskStatus?.finish("failed", error);
      return { status: "failed", error };
    }
  }

  /** A permalink is useful evidence for the run ledger, but never worth failing a run over. */
  private async scheduledOutputPermalink(channelId: string, threadTs: string): Promise<string | undefined> {
    try {
      const link = await this.app.client.chat.getPermalink({ channel: channelId, message_ts: threadTs });
      return link.permalink as string | undefined;
    } catch {
      return undefined;
    }
  }

  private async runQuietScheduledTask(
    channel: ResolvedChannel,
    task: ScheduledTask,
    taskStatus?: TaskRunTracker,
  ): Promise<ScheduledTaskRunResult> {
    const threadKey = `scheduled-${task.id}-${Date.now()}`;
    let slackOutputUrl: string | undefined;
    let thread: Awaited<ReturnType<typeof createThreadSession>> | undefined;
    let unsubscribeTasks: (() => void) | undefined;
    try {
      thread = await this.createQuietScheduledThread({
        channel,
        threadKey,
        sandboxThreadKey: `scheduled-${task.id}`,
        onSubagentMessage: ({ runKey, message }) => recordUsage({ channel, threadKey: runKey,
          source: task.heartbeat ? "heartbeat" : "scheduled", message }),
        harnessName: this.config.name,
        slackChannelLabel: channel.ref.name ? `#${channel.ref.name}` : "a direct message",
        botUserId: this.botUserId,
        modelRuntime: this.opts.modelRuntime,
        ...(channel.schedulesEnabled ? { schedules: this.scheduler } : {}),
        factoryGitHub: () => this.factoryBackend(channel),
        poster: {
          post: async (input) => {
            const result = await this.post(input);
            slackOutputUrl ??= result.permalink;
            return result;
          },
        },
        crossPoster: this,
        userPoster: this.postAs,
        uploader: {
          upload: async (input) => {
            const result = await this.upload(input);
            slackOutputUrl ??= result.permalink;
            return result;
          },
        },
        // Quiet work has no source thread for a completion callback, so it
        // cannot transfer work cross-channel.
        defaultTimezone: this.config.schedules.timezone,
        initialUserId: task.createdBy,
        ...(taskStatus ? { taskTracker: taskStatus } : {}),
        onViolation: (m) => logger.warn(`[jail] ${channel.ref.id}: ${m}`),
        runtimes: this.runtimes,
        // The store's tool schemas are the channel's, not this restricted run's.
        template: this.baseSessionOptions(channel, this.config),
      });

      thread.currentUserId = task.createdBy;
      const outcome = new AgentTurnOutcome();
      unsubscribeTasks = thread.session.subscribe((event: TurnEvent) => {
        if (event.type === "assistant_message_end") {
          outcome.observe(event.message);
          if (isAssistantMessage(event.message)) recordUsage({ channel, threadKey,
            source: task.heartbeat ? "heartbeat" : "scheduled", message: event.message });
        }
        if (event.type === "tool_start") taskStatus?.onToolStart(event.toolName);
        if (event.type === "tool_end" && event.isError) taskStatus?.onToolError(event.toolName);
      });
      await thread.session.prompt(quietScheduledPrompt(task.prompt, task.timezone, task.heartbeat ? task.intervalMinutes : undefined), {
        // Each fire gets its own thread key, so its request id is unique and stable for that run.
        requestId: `sched:${channel.ref.id}:${threadKey}`,
        userId: task.createdBy,
      });
      outcome.assertCompleted();
      taskStatus?.finish("completed");
      return { status: "completed", ...(slackOutputUrl ? { slackOutputUrl } : {}) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      taskStatus?.finish("failed", detail);
      return scheduledRunResult({ status: "failed", error: detail }, slackOutputUrl);
    } finally {
      unsubscribeTasks?.();
      if (thread) await thread.dispose();
    }
  }

  /**
   * Kept behind a method so scheduled-run behavior can be tested without a
   * real Slack session or model runtime.
   */
  private async createQuietScheduledThread(
    input: Parameters<typeof createThreadSession>[0],
  ): ReturnType<typeof createThreadSession> {
    return createThreadSession(input);
  }

  /**
   * Consolidate one channel's memory.
   *
   * A dream is an ordinary agent turn with an unusual framing: no Slack stream,
   * no reply going anywhere, and a prompt that says so. It runs in a
   * pseudo-thread of its own, cleared either side, because it should have the
   * channel's memory and skills but not a year of its own previous dreams.
   *
   * It is also given none of the outward-facing tools. Nobody is watching at
   * 3am, so posting to the channel, asking for permission or scheduling work
   * would all be actions with no one to see them — and `announce` covers the
   * one case where the channel should hear about it.
   *
   * Every exit leaves a line in `dreams/log.jsonl`, including the ones that do
   * nothing. "Why did this channel not dream last night?" is the question a
   * log is for, and it has no answer if only the successful runs are recorded.
   */
  private async runDream(channelId: string): Promise<void> {
    const { channel, rejected } = await this.resolveBackgroundChannel(channelId);
    if (rejected || !channel) {
      logger.debug(`dream: skipping ${channelId} (${rejected ?? "unresolved"})`);
      return;
    }
    const started = Date.now();
    const log = (entry: DreamLogEntry) => appendDreamLog(channel, entry);

    if (!channel.dreamsEnabled) {
      log({ at: new Date().toISOString(), status: "skipped", reason: "disabled in this channel", conversations: 0 });
      return;
    }

    // Reading the lookback needs the channel's store; a channel that never had one has nothing to look back on.
    const lookback = existsSync(channelStoreDir(channel))
      ? await withChannelRuntime(this.baseSessionOptions(channel, this.config), async (runtime) => {
          const source = storeTranscriptSource(runtime.store);
          return collectDreamContext(channel, this.dreamSettings, source);
        })
      : await collectDreamContext(channel, this.dreamSettings, { threads: async () => [], turns: async () => [] });
    const context = lookback;
    const base = {
      conversations: context.conversations.length,
      staleBefore: context.stale.length,
      ...(context.since ? { since: context.since.toISOString() } : {}),
    };

    if (!worthDreaming(context)) {
      logger.debug(`dream: nothing new in ${channel.ref.name ?? channelId}`);
      log({
        at: new Date().toISOString(),
        status: "skipped",
        reason: "nothing said since the last pass, and no memory has aged out",
        ...base,
      });
      return;
    }

    const label = channel.ref.name ? `#${channel.ref.name}` : channelId;
    const memory = new MemoryFile(channel.memory.channelFile);
    const entriesBefore = memory.entries().length;

    // Every dream is its own fork of the channel's main conversation, so no earlier
    // dream's context carries over and there is nothing to clear.
    const dreamThreadKey = `${DREAM_THREAD_KEY}-${Date.now()}`;

    let session: Awaited<ReturnType<typeof createThreadSession>> | undefined;
    let failure: string | undefined;
    let summary = "";
    let model: string | undefined;

    try {
      session = await createThreadSession({
        channel,
        threadKey: dreamThreadKey,
        defaultTimezone: this.config.schedules.timezone,
        harnessName: this.config.name,
        slackChannelLabel: channel.ref.name ? `#${channel.ref.name}` : "a direct message",
        botUserId: this.botUserId,
        modelRuntime: this.opts.modelRuntime,
        initialUserId: this.botUserId,
        onViolation: (m) => logger.warn(`[jail] ${channelId}: ${m}`),
        runtimes: this.runtimes,
        template: this.baseSessionOptions(channel, this.config),
      });

      const unsubscribeUsage = session.session.subscribe((event: TurnEvent) => {
        if (event.type === "assistant_message_end") {
          recordUsage({ channel, threadKey: DREAM_THREAD_KEY, source: "dream", message: event.message });
        }
      });
      try {
        await session.session.prompt(dreamPrompt(context), {
          requestId: `dream:${channelId}:${dreamThreadKey}`,
          userId: this.botUserId,
        });
      } finally {
        unsubscribeUsage();
      }
      summary = session.session.getLastAssistantText()?.trim() ?? "";

      const current = await session.session.model();
      if (current) model = `${current.provider}/${current.id}`;

      const outcome = {
        entriesBefore,
        entriesAfter: new MemoryFile(channel.memory.channelFile).entries().length,
        summary,
        conversations: context.conversations.length,
        staleBefore: context.stale.length,
      };
      recordDream(channel, outcome);
      logger.info(`dream: ${label} — ${describeOutcome(outcome)}`);

      if (this.dreamSettings.announce && summary) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: toMrkdwn(`:crescent_moon: *Overnight* — ${describeOutcome(outcome)}\n\n${summary}`),
        });
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      recordDreamFailure(channel, failure);
      logger.warn(`dream: ${label} failed: ${failure}`);
    } finally {
      await session?.dispose();

      // Keeping the transcript is what makes a strange pass debuggable: it
      // holds the tool calls, so the exact text handed to `forget` is still
      // there. It is read from the dream's own conversation (a fork of the
      // channel's main one), so it cannot leak into the next dream.
      let transcriptText: string | undefined;
      try {
        const view = await this.runtimes.peek(channelId)?.store.transcriptIfExists(dreamThreadKey);
        transcriptText = view?.messages.map((message) => JSON.stringify(message)).join("\n");
      } catch (err) {
        logger.debug(`dream: could not read transcript: ${err instanceof Error ? err.message : String(err)}`);
      }
      const transcript = keepDreamTranscript(channel, transcriptText, this.dreamSettings.keepTranscripts);

      log({
        at: new Date().toISOString(),
        status: failure ? "failed" : "completed",
        ...(failure ? { reason: failure } : {}),
        ...base,
        entriesBefore,
        entriesAfter: new MemoryFile(channel.memory.channelFile).entries().length,
        durationMs: Date.now() - started,
        ...(model ? { model } : {}),
        ...(transcript ? { transcript } : {}),
        ...(summary ? { summary } : {}),
      });
    }
  }

  /**
   * Re-establish work a restart interrupted, under the CURRENT rules, before the channel's store is used.
   * Anything that cannot be safely resumed leaves the channel paused and is reported (see `!recovery`).
   */
  private async recoverInterruptedWork(runtime: ChannelRuntime): Promise<RecoveryOutcome> {
    const { channel } = runtime;
    const base = this.baseSessionOptions(channel, this.config);
    const outcome = await recoverChannel(runtime, {
      isEphemeral: (key) => key.startsWith("scheduled-") || isSubagentRunKey(key) || key === DREAM_THREAD_KEY || key.startsWith(`${DREAM_THREAD_KEY}-`),
      speakerAllowed: (userId) => !channel.allowUsers || channel.allowUsers.includes(userId),
      jobProblem: (definition) => jobProblem(definition, channel),
      factoryProblem: factoryRunProblem(channel),
      bind: ({ threadKey, conversationId, userId }) =>
        bindRecoveredThread(runtime, { ...base, threadKey, threadTs: threadKey, initialUserId: userId }, conversationId),
    });
    // A subagent run the restart cut off is not resumed: close its branch on the timeline as interrupted.
    closeInterruptedRuns(timelineForChannel(channel), outcome.abandoned.filter(isSubagentRunKey));
    // Answers of resumed turns, and answers committed but never delivered before the crash, go to Slack through
    // the ledger (never twice). Background: the gate must not wait for a turn to finish.
    const client = this.app.client;
    for (const request of outcome.requests) {
      this.resumedRequests.add(request.requestId);
      void deliverRecoveredRequest({
        store: runtime.store, client, channel: channel.ref.id,
        conversationId: request.conversationId, threadKey: request.threadKey, threadTs: request.threadKey,
        requestId: request.requestId,
        onDelivered: (text, id, ts) => this.recordReplyActivity(channel.ref.id, text, id, ts),
      }).catch((err) => logger.warn(`could not deliver resumed answer for ${request.requestId}: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.resumedRequests.delete(request.requestId));
    }
    if (outcome.resumed) {
      void reconcileDeliveries({ store: runtime.store, client, channel: channel.ref.id,
        onDelivered: (text, id, ts) => this.recordReplyActivity(channel.ref.id, text, id, ts) })
        .then((done) => { if (done.delivered.length > 0) logger.info(`delivered ${done.delivered.length} answer(s) that never reached Slack before the restart`); })
        .catch((err) => logger.warn(`delivery reconciliation failed in ${channel.ref.id}: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (outcome.factoryRuns.resumed.length + outcome.factoryRuns.aborted.length > 0) {
      logger.info(`recovery in ${channel.ref.name ?? channel.ref.id}: ${outcome.factoryRuns.resumed.length} workflow run(s) carry on, ${outcome.factoryRuns.aborted.length} aborted`);
    }
    if (outcome.jobs.resumed.length + outcome.jobs.aborted.length > 0) {
      logger.info(`recovery in ${channel.ref.name ?? channel.ref.id}: ${outcome.jobs.resumed.length} job run(s) carry on, ${outcome.jobs.aborted.length} aborted`);
    }
    if (outcome.recovered.length + outcome.abandoned.length + outcome.blocked.length === 0) return outcome;
    const label = channel.ref.name ? `#${channel.ref.name}` : channel.ref.id;
    logger.warn(
      `recovery in ${label}: resumed ${outcome.recovered.length}, abandoned ${outcome.abandoned.length} interrupted run(s), ` +
        `${outcome.blocked.length} blocked${outcome.resumed ? "" : " (channel paused)"}`,
    );
    return outcome;
  }

  /** The channels that should have an open store, split by whether they already have one on disk. */
  private channelsToOpen(): { existing: string[]; fresh: string[] } {
    return channelsToOpen({
      dataDir: this.opts.dataDir,
      seen: this.registry.all().map((record) => record.id),
      configured: Object.keys(this.config.channels),
    });
  }

  /**
   * Open one channel's store (recovering interrupted work, through the runtime gate) and leave it open. A channel the
   * configuration rejects is skipped and its store, if any, is left untouched.
   */
  private async openChannelStore(channelId: string): Promise<"opened" | "skipped" | "failed"> {
    try {
      const { channel, rejected } = await this.resolveBackgroundChannel(channelId);
      if (rejected || !channel) {
        logger.warn(`channel ${channelId} is not configured (${rejected ?? "unresolved"}); its store was left untouched`);
        return "skipped";
      }
      await withChannelRuntime(this.baseSessionOptions(channel, this.config), async () => undefined);
      return "opened";
    } catch (err) {
      logger.warn(`could not open the store for ${channelId}: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
  }

  /**
   * Open the store of every channel the harness knows, instead of waiting for each channel's next message. Channels that
   * already have a store come first and are awaited, so interrupted work is recovered before the harness announces itself.
   * Channels that do not have one yet are given one in the background. This is what lets the web console show every
   * channel live from boot.
   */
  /** The factory channels whose repositories should be polled for issues now, from the configuration as it stands. */
  private intakeTargets(): { channelId: string; intervalSeconds: number }[] {
    const { existing, fresh } = this.channelsToOpen();
    const ids = new Set([...this.runtimes.channelIds(), ...existing, ...fresh]);
    const targets: { channelId: string; intervalSeconds: number }[] = [];
    for (const channelId of ids) {
      const channel = this.channelNow(channelId);
      const intake = channel?.factory?.intake;
      if (channel && intake?.enabled && !workflowProblem(channel)) targets.push({ channelId, intervalSeconds: intake.intervalSeconds });
    }
    return targets;
  }

  /**
   * Make sure a factory channel's GitHub labels exist (see labels.ts). Needs the channel's store open, because the outcome is kept in
   * its intake record for the console; a channel whose store is not open yet is left for the next opportunity, unless `force` (an
   * operation just failed on a missing label, so the labels matter more than the record).
   */
  private async ensureFactoryLabels(channelId: string, force = false): Promise<void> {
    if (!this.factoryLabels) return; // an app built without its constructor, as some tests do
    const channel = this.channelNow(channelId);
    if (!channel) return;
    const runtime = this.runtimes.peek(channelId);
    if (!runtime && !force) return;
    await ensureChannelLabels(this.factoryLabels, channel, {
      ...(runtime ? { store: runtime.store, changed: () => { runtime.jobs.version++; } } : {}), ...(force ? { force: true } : {}),
    });
  }

  /** Check the labels of every factory channel that keeps them. A channel already checked, with the same needs, costs nothing. */
  private async reconcileFactoryLabels(): Promise<void> {
    if (!this.factoryLabels) return;
    const { existing, fresh } = this.channelsToOpen();
    const ids = new Set([...this.runtimes.channelIds(), ...existing, ...fresh]);
    for (const channelId of ids) await this.ensureFactoryLabels(channelId);
  }

  /** Give every factory channel's waiting runs their status post, if they have none (see FactoryPresence.catchUp). Never throws. */
  private async catchUpFactoryPresence(): Promise<void> {
    try {
      if (!this.factoryPresence) return; // an app built without its constructor, as some tests do
      const { existing, fresh } = this.channelsToOpen();
      const ids = new Set([...this.runtimes.channelIds(), ...existing, ...fresh]);
      for (const channelId of ids) {
        const channel = this.channelNow(channelId);
        if (channel && this.runtimes.peek(channelId)) {
          if (channel.factory) await this.factoryPresence.catchUp(channel);
          await this.taskWorkflowPresence?.catchUp(channelId, channel.ref.isDm);
        }
      }
    } catch (error) {
      logger.warn(`factory presence catch-up failed: ${error}`);
    }
  }

  private factoryBackend(channel: ResolvedChannel) {
    return createFactoryBackend(channel, { ambiguous: async (id) => {
      const { existing, fresh } = this.channelsToOpen();
      const ids = new Set([...this.runtimes.channelIds(), ...existing, ...fresh, channel.ref.id]);
      // A configured channel known only by name has no resolved credential context yet.
      // Do not silently ignore a possible second route until Slack resolves that name.
      const knownNames = new Set([...ids].flatMap(id => this.registry.nameFor(id) ?? []));
      for (const [name, settings] of Object.entries(this.config.channels)) {
        if (settings.factory?.intake?.source === "jira" && settings.factory.intake.enabled && settings.factory.jira?.site === channel.factory?.jira?.site && !ids.has(name) && !knownNames.has(name)) throw new Error("Jira routing cannot be verified: a configured Jira factory channel has not been resolved by Slack");
      }
      let matches = 0;
      for (const otherId of ids) {
        const other = this.channelNow(otherId);
        // Polling may be disabled on the explicitly selected factory; manual starts still select it.
        if (other?.factory?.intake?.source !== "jira" || (!other.factory.intake.enabled && otherId !== channel.ref.id) || other.factory.jira?.site.toLowerCase() !== channel.factory?.jira?.site.toLowerCase()) continue;
        const issue = await createFactoryBackend(other).source!.issue(other.factory.repositories[0]!, id);
        if (issue?.selection?.eligible) matches++;
      }
      return matches > 1;
    } });
  }

  /** One poll of one factory channel's repositories. Nothing is polled for a channel whose store is not open, or that no longer has intake. */
  private async pollFactoryIntake(channelId: string): Promise<IntakeOutcome | undefined> {
    const channel = this.channelNow(channelId);
    const intake = channel?.factory?.intake;
    const runtime = this.runtimes.peek(channelId);
    if (!channel?.factory || !intake?.enabled || !runtime || workflowProblem(channel)) return undefined;
    // A repository's labels are looked after before it is polled (a no-op once they are known to be there, and a failure is only recorded).
    await this.ensureFactoryLabels(channelId);
    const github = this.factoryBackend(channel);
    if (!github.source) return undefined;
    const service = createFactoryRunService({ channel, store: () => runtime.store, github: () => github, threadKey: "", currentUserId: () => "", source: "operator" });
    // The console reads the mapping from the store; a poll that changed nothing in any run still moves it, so tell it.
    const finished = () => { runtime.jobs.version++; };
    const poll = () => pollIntake({
      channelId, repositories: channel.factory!.repositories, settings: intake, maxLive: channel.factory!.maxLiveRuns, store: scopedFactoryStore(runtime.store, channel.factory), source: github.source!, github,
      start: async (request) => { await service.startFromIntake(request); },
      now: () => Date.now(),
      audit: (event, fields) => appendFactoryAudit(channel, event, fields),
      note: (note) => { void this.factoryPresence.intakeEvent(channel, note); },
      onRunChange: (run) => { this.factoryPresence.notify(channel, run); },
    });
    return poll().then(async (outcome) => {
      // A start that failed on a label that is not there: make the labels exist and poll once more.
      if (!outcome.repos.some((repo) => repo.error && isLabelMissingError(repo.error))) return outcome;
      await this.ensureFactoryLabels(channelId, true);
      return poll();
    }).finally(finished);
  }

  private async openAllChannelStores(): Promise<void> {
    const started = Date.now();
    const { existing, fresh } = this.channelsToOpen();
    const counts = { opened: 0, skipped: 0, failed: 0 };
    for (const channelId of existing) counts[await this.openChannelStore(channelId)]++;
    logger.info(`channel stores: ${counts.opened} open, ${counts.skipped} skipped, ${counts.failed} failed in ${Date.now() - started}ms; opening ${fresh.length} new in the background`);
    void (async () => {
      const begun = Date.now();
      const freshCounts = { opened: 0, skipped: 0, failed: 0 };
      for (const channelId of fresh) freshCounts[await this.openChannelStore(channelId)]++;
      if (fresh.length > 0) logger.info(`channel stores: ${freshCounts.opened} new open, ${freshCounts.skipped} skipped, ${freshCounts.failed} failed in ${Date.now() - begun}ms`);
      if (fresh.length > 0) { void this.reconcileFactoryLabels(); void this.catchUpFactoryPresence(); }
    })();
  }

  /**
   * After a config reload every store has been told to retire. Each is reopened on the new configuration as soon as its own
   * turns finish, so no channel goes dark until its next message. Channels with turns in flight wait for them, and channels
   * that are no longer configured are retired and not reopened.
   */
  private async reopenChannelStores(): Promise<void> {
    const { existing, fresh } = this.channelsToOpen();
    const ids = new Set([...this.runtimes.channelIds(), ...existing, ...fresh]);
    await Promise.allSettled([...ids].map(async (channelId) => {
      await this.runtimes.invalidate(channelId);
      await this.openChannelStore(channelId);
    }));
  }

  /** A store failed and was retired: open a replacement now, unless this channel's store failed a moment ago too. */
  private reopenFailedStore(channelId: string): void {
    const now = Date.now();
    const last = this.storeFailures.get(channelId);
    this.storeFailures.set(channelId, now);
    if (!shouldReopenFailedStore(last, now)) {
      logger.warn(`the store for ${channelId} failed again within a minute; it will reopen on the channel's next message`);
      return;
    }
    void this.openChannelStore(channelId);
  }

  async start(): Promise<void> {
    startSandboxCleanup(this.opts.dataDir);
    const abandoned = this.taskStore.abandonInProgress();
    if (abandoned) logger.warn(`task status: marked ${abandoned} interrupted task(s) abandoned`);
    await this.app.start();
    const auth = await this.app.client.auth.test({ token: this.opts.botToken });
    this.botUserId = (auth.user_id as string) ?? "";
    logger.info(
      `connected to Slack as ${auth.user as string} (${this.botUserId}) in workspace ${auth.team as string}`,
    );
    this.checkScopes(auth.response_metadata?.scopes);
    if (this.config.schedules.enabled) this.scheduler.start();
    this.dreamer.start();
    this.digester.start();
    this.topicUsageIndicator.start();
    await this.openAllChannelStores();
    void this.intakeLoop?.reconcile();
    void this.reconcileFactoryLabels();
    void this.catchUpFactoryPresence();
    await this.announceStartup(auth);
  }

  /**
   * Tell the operator channel that this process reached a usable state.
   *
   * This is deliberately separate from the scheduled feedback digest. The
   * digest may stay quiet when nothing changed; startup success is a liveness
   * signal and should be emitted exactly when the process has connected to
   * Slack and registered its background jobs. A failure to announce is logged
   * but does not take down an otherwise-working harness.
   */
  private async announceStartup(auth: Awaited<ReturnType<WebClient["auth"]["test"]>>): Promise<void> {
    try {
      const result = await postStartupNotice({
        digestChannel: this.config.feedback.digestChannel,
        registry: this.registry,
        harnessName: this.config.name,
        botUser: auth.user as string | undefined,
        botUserId: this.botUserId,
        team: auth.team as string | undefined,
        post: async ({ channelId, text }) => {
          await this.post({ channelId, text });
        },
      });

      if (result.status === "posted") {
        logger.info(`startup notice: posted to ${result.channelId}`);
      } else if (result.status === "no-channel") {
        logger.warn(
          `startup notice: no channel matching "${result.configured}" — name it as a Slack id, ` +
            "or say something to the bot there once so the harness learns the id.",
        );
      }
    } catch (err) {
      logger.warn("startup notice: failed to post", err);
    }
  }

  /**
   * Deliver what the agents could not do, to whoever can do something about it.
   *
   * Posts nothing when nothing has changed since the last digest, and records
   * the moment only when a message actually went out — so a Slack failure means
   * the next digest still carries the news rather than swallowing it.
   */
  private async postFeedbackDigest(): Promise<"posted" | "nothing-new" | "no-channel"> {
    const configured = this.config.feedback.digestChannel;
    const channelId = configured ? this.registry.resolveId(configured) : undefined;
    if (!channelId) {
      logger.warn(
        `feedback digest: no channel matching "${configured}" — name it as a Slack id, ` +
          "or say something to the bot there once so the harness learns the id.",
      );
      return "no-channel";
    }

    const log = new FeedbackLog(sharedPaths(this.opts.dataDir));
    const state = new DigestState(log);
    const since = state.read().lastDigestAt;
    const now = new Date();

    const text = buildDigest(log, { ...(since ? { since } : {}), now });
    if (!text) {
      logger.debug("feedback digest: nothing has changed, staying quiet");
      return "nothing-new";
    }

    await this.post({ channelId, text });
    state.record(now.toISOString());
    return "posted";
  }

  /**
   * Slack reports the token's granted scopes on API responses. Checking them at
   * startup turns "the bot silently does nothing" into a message that names the
   * missing scope, which is otherwise very hard to diagnose from the outside.
   */
  private checkScopes(granted: string[] | undefined): void {
    if (!granted || granted.length === 0) return; // not always returned; skip quietly

    const required: Record<string, string> = {
      "app_mentions:read": "see mentions in channels",
      "chat:write": "reply at all",
      "channels:history": "read messages in public channels",
      "im:history": "read direct messages",
      // Backfilled history is a wall of <@U01ABC> without this, and the agent
      // cannot tell two people in a thread apart.
      "users:read": "put names to people in the conversation history",
      "reactions:read": "receive and resolve emoji reactions as conversation events",
      "reactions:write": `acknowledge with the :${this.config.ui.ackEmoji}: reaction`,
      // Without this Slack omits the `files` field entirely, so an attached
      // image never reaches the harness and looks like it "didn't come through".
      "files:read": "read the images and documents you attach",
      "files:write": "attach charts, reports and other files it generates",
      ...(this.config.channelTopicUsage.enabled && this.config.channelTopicUsage.channel.trim()
        ? { "channels:write.topic": "update the configured public channel's usage topic" }
        : {}),
    };

    const missing = Object.entries(required).filter(([scope]) => !granted.includes(scope));
    if (missing.length === 0) return;

    logger.warn(
      [
        `Slack app is missing ${missing.length} scope(s):`,
        ...missing.map(([scope, why]) => `  - ${scope}  (needed to ${why})`),
        "Add them under OAuth & Permissions, then reinstall the app to the workspace.",
      ].join("\n"),
    );
  }

  async stop(): Promise<void> {
    this.connectorOAuth?.close();
    for (const timer of this.recentConversationTimers.values()) clearTimeout(timer);
    this.recentConversationTimers.clear();
    this.scheduler.stop();
    this.intakeLoop?.stop();
    this.dreamer.stop();
    this.digester.stop();
    this.topicUsageIndicator.stop();
    stopAllSandboxes();
    await this.pool.disposeAll();
    await this.runtimes.closeAll();
    await this.app.stop();
  }
}
