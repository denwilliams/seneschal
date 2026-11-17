import { dirname } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSkillsForPrompt,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import { section } from "@earendil-works/pi-durable";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { markThreadActive } from "../workspace/paths.ts";
import { buildLatePromptContext, buildSystemPrompt } from "./prompt.ts";
import type { JailConfig } from "./jail.ts";
import { createMemoryTools } from "./memory.ts";
import { openConnectors, type ConnectorOwner, type ConnectorSession } from "./connectors.ts";
import { resolveModel } from "./model.ts";
import { createModelTools, type ModelControl } from "./model-tools.ts";
import { createScheduleTools, type ScheduleService } from "./schedule-tools.ts";
import { createHeartbeatTools, heartbeatContext } from "./heartbeat-tools.ts";
import { createTimeTools } from "./time-tools.ts";
import {
  createCrossChannelPostTools,
  createPostTools,
  type ChannelPoster,
  type CrossChannelPoster,
} from "./post-tools.ts";
import { createPostAsTools, type UserPoster } from "./post-as-tools.ts";
import { createInteractiveTools, type InteractiveResponseService } from "./interactive-tools.ts";
import { createFileTools, type FileUploader } from "./file-tools.ts";
import { createWorkspaceFileTools } from "./workspace-file-tools.ts";
import { createSaveToolOutputTool } from "./tool-output.ts";
import { createKnowledgeTools } from "./knowledge-tools.ts";
import { createLocalPdfTools } from "./local-pdf.ts";
import { containerPathAliases, createSkillTools, loadAvailableSkills, presentSkills } from "./skills.ts";
import { createLibraryTools } from "./library-tools.ts";
import { createDocumentTools } from "./document-tools.ts";
import { createFeedbackTools } from "./feedback-tools.ts";
import { createNotificationTools } from "./notification-tools.ts";
import { createCapabilityTools, createCapabilityConfiguratorTools } from "./capability-tools.ts";
import type { CapabilityRequests } from "../config/capability-requests.ts";
import type { ConfiguratorActor } from "../config/configurator.ts";
import { createPermissionTools, type PermissionService } from "./permission-tools.ts";
import { createWebTools } from "./web-tools.ts";
import { createImageTools } from "./image-tools.ts";
import { createChartTools } from "./chart-tools.ts";
import { createSlideTools } from "./slide-tools.ts";
import { createListTools } from "./list-tools.ts";
import { createSqliteTools } from "./sqlite-tools.ts";
import { createStateTools, type StateService } from "./state-tools.ts";
import { createJobTools } from "./job-tools.ts";
import { createFactoryRunTools } from "./factory-run-tools.ts";
import { createFactoryRunService, workflowProblem, type FactoryRunStore } from "../factory/workflow/service.ts";
import type { FactoryGitHub } from "../factory/workflow/deps.ts";
import { createJobService, type JobStore } from "../jobs/service.ts";
import { createExecTools } from "./exec-tools.ts";
import { createSharedToolTools } from "./shared-tool-tools.ts";
import { createSlackTools } from "./slack-tools.ts";
import { createSlackProfileTools } from "./slack-profile-tools.ts";
import { createDelegationTools, type ChannelDelegator } from "./delegation-tools.ts";
import { defaultSlackUserTokenPath, SlackUserTokenStore } from "./slack-user-tokens.ts";
import { channelPathEnv, isContainerMode, createContainerBashOperations, warnIfUnavailable } from "./sandbox.ts";
import { logger } from "../util/log.ts";
import type { TaskRunTracker } from "../tasks/store.ts";
import { createTaskStatusTools } from "../tasks/tools.ts";
import { createTaskWorkflowTools } from "../tasks/workflow-tools.ts";
import { needsReworkDispatch, workflowNextAction, type TaskWorkflowStore, type WorkflowParticipant } from "../tasks/workflow.ts";
import { createFactoryTools } from "../factory/tools.ts";
import type { ChannelRuntime, ChannelRuntimes, RuntimeLease, RuntimeTemplate } from "./channel-runtime.ts";
import type { DurableChannelStore } from "./durable/channel-store.ts";
import type { BoundThreadTools } from "./durable/pi-tool-adapter.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { steeringText, type TurnSteering } from "./steering.ts";
import { TurnEventAdapter, type TurnEvent } from "./turn-events.ts";
import { createSubagentTools, type SubagentProgressSink, type SubagentRunner } from "./subagent-tools.ts";
import { createConfiguratorTools } from "./configurator-tools.ts";
import type { ConfiguratorService } from "../config/configurator.ts";
import type { OperatorConfig } from "../config/operator.ts";
import { createAdminConfigTools, type AdminConfigService } from "./admin-config-tools.ts";
import { channelHasGrant, subagentCapability } from "./grants.ts";
import type { TimelineSink } from "./timeline.ts";
import { createSubagentRunner } from "./subagents.ts";

/**
 * One Durable conversation per Slack thread: a fork of the channel's main conversation,
 * so the channel supplies the isolation boundary (cwd, skills, connectors, memory, store)
 * and the thread supplies the transcript.
 */

/** What `app.ts` drives: a stream of turn events and a way to run one turn. */
export interface TurnSession {
  subscribe(listener: (event: TurnEvent) => void): () => void;
  /** Submit one user message and wait for the turn to finish. `requestId` makes retries idempotent. */
  prompt(text: string, options: { requestId: string; userId: string; images?: ImageContent[]; fingerprint?: string; steering?: TurnSteering }): Promise<void>;
  /** Text of the last assistant answer of the last completed turn. */
  getLastAssistantText(): string | undefined;
  /** The model the next turn will run on. */
  model(): Promise<Model<never> | undefined>;
  abort(): Promise<void>;
}

export interface ThreadSession {
  session: TurnSession;
  /** The channel's store, for the delivery ledger and other per-request records. */
  store: DurableChannelStore;
  /** How long building this session took, by phase (milliseconds). */
  timings: { toolsMs: number; storeMs: number; threadMs: number; totalMs: number };
  /** True when this session created the thread's conversation (it had no history of its own yet). */
  isNewConversation: boolean;
  channel: ResolvedChannel;
  threadKey: string;
  lastUsed: number;
  /**
   * Who is speaking this turn. Set before each prompt so tools that record
   * attribution (scheduling, memory) credit the right person — several people
   * share a thread, and the session outlives any one of them.
   */
  currentUserId: string;
  /** The app assigns this only while a substantive turn is running. */
  setTaskTracker(tracker: TaskRunTracker | undefined): void;
  /** Where a subagent started during the current turn reports its progress. Cleared when the turn ends. */
  setSubagentProgress(sink: SubagentProgressSink | undefined): void;
  dispose(): Promise<void>;
}

export interface CreateThreadSessionOptions {
  /** Diagnostic attribution only; never changes connector permissions or reuse. */
  connectorOwner?: ConnectorOwner;
  channel: ResolvedChannel;
  threadKey: string;
  /** Stable sandbox identity when transcript identity changes per scheduled run. */
  sandboxThreadKey?: string;
  harnessName: string;
  slackChannelLabel: string;
  botUserId: string;
  /**
   * Shared across all channels: credentials belong to the operator, not to a
   * channel, and OAuth tokens must refresh in one place rather than N.
   */
  modelRuntime: ModelRuntime;
  /** The per-channel Durable stores. Shared by every session in the process. */
  runtimes: ChannelRuntimes;
  /**
   * The channel's full capability set. The store registers tool schemas for the whole channel when it
   * opens, so a restricted session (a quiet scheduled run, a dream) must not be what defines them:
   * pass the options of a normal live turn here. Defaults to these options themselves.
   */
  template?: Omit<CreateThreadSessionOptions, "threadKey" | "template">;
  /** Omit to disable scheduling in this channel. */
  schedules?: ScheduleService;
  /** Harness schedules.timezone, also used by get_current_time even when scheduling is disabled. */
  defaultTimezone?: string;
  initialUserId?: string;
  /** Enables post_message. Omit to withhold channel posting in this channel. */
  poster?: ChannelPoster;
  /** Enables post_to_channel when this channel has `share.postTo` targets. Omit to withhold it. */
  crossPoster?: CrossChannelPoster;
  /** Enables post_as_user when this channel also has `share.postAs`. Omit to withhold it. */
  userPoster?: UserPoster;
  /**
   * The channel's store, for checking a post_as_user `source` against what was said in this thread. Resolved lazily,
   * like `subagentRunner`, because the store does not exist until after the tools are built. Absent means unverified.
   */
  threadStore?: () => Pick<DurableChannelStore, "threadTurns"> | undefined;
  /** The channel's state object, for `state_read` and `state_update`. Resolved lazily like `threadStore`; absent fails closed. */
  stateStore?: () => StateService | undefined;
  /** The channel's store as the job tools use it. Resolved lazily like `stateStore`; absent fails closed. */
  jobStore?: () => JobStore | undefined;
  /** The channel's store as the workflow-run tools use it. Resolved lazily like `jobStore`; absent fails closed. */
  factoryStore?: () => FactoryRunStore | undefined;
  /** Make sure a run's status post exists in Slack and say where it is. The app supplies it; absent outside Slack. */
  factoryAnnounce?: (runId: string) => Promise<{ permalink?: string } | undefined>;
  /** Ask for an intake poll of this channel now. The app supplies it; absent outside Slack. */
  factoryIntakeKick?: () => void;
  /** Make sure the factory's GitHub labels exist in a repository, once more. The app supplies it; absent outside Slack. */
  factoryEnsureLabels?: (repo: string) => Promise<void>;
  /** How the workflow-run tools read an issue, with the channel's own credentials. Absent fails closed. */
  factoryGitHub?: () => Pick<FactoryGitHub, "readIssue" | "createIssue" | "commentIssue" | "tracker"> | undefined;
  /** Enables safe canned-response buttons in this live Slack thread. */
  interactiveResponses?: InteractiveResponseService;
  /** Enables upload_file. Omit to withhold file attachments in this channel. */
  uploader?: FileUploader;
  /** Enables transfer_to_channel when this source channel has configured targets. */
  delegator?: ChannelDelegator;
  /** Thread this session is working in, for in-thread posts. */
  threadTs?: string;
  /** Enables request_access. Omit to withhold runtime permission requests. */
  permissions?: PermissionService;
  capabilityRequests?: CapabilityRequests;
  /** Bound by the subagent runner, never channel tool arguments. */
  capabilityConfiguratorActor?: ConfiguratorActor;
  /** Lets the feedback reviewer agent close the loop when it resolves an item. */
  feedbackResolution?: {
    announceResolved: boolean;
    notify: (channelId: string, text: string) => Promise<void>;
  };
  onViolation?: (msg: string) => void;
  /** Optional tracker for a one-off headless turn such as a quiet schedule. */
  taskTracker?: TaskRunTracker;
  /** Current channel store, resolved lazily; unavailable sessions fail closed. */
  taskWorkflowStore?: () => TaskWorkflowStore | undefined;
  /** Harness-only identity of an optional workflow step subagent. */
  taskWorkflowParticipant?: WorkflowParticipant;
  /**
   * What this tool set is for. A "subagent" gets only the tools of its role plus read-only memory: none of the
   * channel agent's always-on reach (skill writing, library, documents, notifications, model switching,
   * task status, operator feedback) and no way to run subagents of its own.
   */
  role?: "channel" | "subagent";
  /**
   * The runner `run_subagent` calls. Resolved lazily, because the store it runs in does not exist until
   * after the tools are built. Absent for a rebuilt (recovered) thread, where the tool fails closed.
   */
  subagentRunner?: () => SubagentRunner | undefined;
  /** Where this channel's agents record what they do, for the console's timeline. */
  timeline?: TimelineSink;
  /** Lets the admin channel's agent read and change harness.yaml. Only an `admin: true` channel is given the tools. */
  adminConfig?: AdminConfigService;
  /** Configured file/reload hooks; only the runner binds a service for an enabled built-in role. */
  configuratorConfig?: OperatorConfig;
  configuratorService?: ConfiguratorService;
  /**
   * Where a running subagent's progress goes so people can see it (the live turn's Slack thread). Asked each time a run
   * starts, because the turn that owns it changes from message to message. Absent when no one is watching.
   */
  subagentProgress?: () => SubagentProgressSink | undefined;
  /** Called with every finished model message of a subagent run, so its spend is accounted like the channel's own. */
  onSubagentMessage?: (info: { agent: string; runKey: string; message: AssistantMessage }) => void;
}

/** Everything one thread's tools close over, and how to tear it down. */
export interface ThreadToolSet {
  /** Harness tools, bash, connector tools and the Pi file tools, by name. */
  tools: ToolDefinition[];
  jail: JailConfig;
  speaker: { id: string };
  setTaskTracker(tracker: TaskRunTracker | undefined): void;
  dispose(): Promise<void>;
}

/** Slack-thread `threadKey`s have a directory whose existence means "the bot is in this thread". */
export function markThreadPresent(channel: ResolvedChannel, threadKey: string): void {
  markThreadActive(channel.paths.sessions, threadKey);
}

function modelRefOf(model: { provider: string; id: string }): { provider: string; modelId: string } {
  return { provider: model.provider, modelId: model.id };
}

/**
 * Build the tools for one thread. These are closures over the speaker, the Slack thread, the
 * sandbox container and the task tracker, so they are per thread; the channel's store only
 * registers their schemas and dispatches each call to the set bound to the calling thread.
 */
export async function buildThreadToolSet(
  opts: CreateThreadSessionOptions,
  modelControl: ModelControl,
): Promise<ThreadToolSet> {
  const { channel, threadKey } = opts;
  const cwd = channel.paths.workspace;
  const isSubagent = opts.role === "subagent";

  // Connectors are per channel but opened per session; each thread gets its own
  // MCP clients so one thread's crash cannot take down another's tools.
  const connectorSession: ConnectorSession = await openConnectors(
    channel.connectors,
    channel.ref.id,
    channel.env,
    channel.paths.root,
    channel.paths.workspace,
    channel.paths.attachmentText,
    opts.connectorOwner ?? (isSubagent ? "subagent" : "thread"),
  );

  const memoryTools = createMemoryTools(channel);
  const timeTools = createTimeTools(opts.defaultTimezone ?? "UTC");

  // The conversation owns the selected model, so a switch outlives the in-memory session
  // without any side file; the tools only need a handle on it.
  const modelTools = createModelTools({
    control: modelControl,
    allow: channel.models,
    modelRuntime: opts.modelRuntime,
  });

  // Mutable holders let long-lived thread tools see the current turn only.
  const speaker = { id: opts.initialUserId ?? "" };
  let taskTracker: TaskRunTracker | undefined = opts.taskTracker;

  const scheduleTools = opts.schedules
    ? [...createScheduleTools({
        service: opts.schedules,
        channelId: channel.ref.id,
        currentUserId: () => speaker.id,
        defaultTimezone: opts.defaultTimezone ?? "UTC",
        currentThread: () =>
          opts.threadTs ? { threadKey, threadTs: opts.threadTs } : undefined,
      }), ...createHeartbeatTools({ service: opts.schedules, channelId: channel.ref.id,
        currentUserId: () => speaker.id, defaultTimezone: opts.defaultTimezone ?? "UTC" })]
    : [];

  const postTools = opts.poster
    ? createPostTools({
        poster: opts.poster,
        channelId: channel.ref.id,
        channelLabel: opts.slackChannelLabel,
        currentThreadTs: () => opts.threadTs,
      })
    : [];

  const crossPostTools = opts.crossPoster
    ? createCrossChannelPostTools({
        poster: opts.crossPoster,
        sourceChannelId: channel.ref.id,
        allowedTargets: channel.postTo.targets,
      })
    : [];

  const postAsTools = opts.userPoster && channel.postAs
    ? createPostAsTools({
        poster: opts.userPoster,
        sourceChannelId: channel.ref.id,
        postAs: channel.postAs,
        ...(channel.description ? { channelDescription: channel.description } : {}),
        currentThreadTs: () => opts.threadTs,
        verifySource: (quote) => verifySourceInThread(opts.threadStore?.(), threadKey, quote),
      })
    : [];

  const interactiveTools = opts.interactiveResponses
    ? createInteractiveTools({
        service: opts.interactiveResponses,
        channelId: channel.ref.id,
        channelLabel: opts.slackChannelLabel,
        currentThreadTs: () => opts.threadTs,
      })
    : [];

  // The jail is handed to the upload tool rather than enforced by the jail
  // extension: that extension keys off built-in tool names, and an upload path
  // it does not know about would sail straight past it.
  const fileTools = opts.uploader
    ? createFileTools({
        uploader: opts.uploader,
        channelId: channel.ref.id,
        channelLabel: opts.slackChannelLabel,
        currentThreadTs: () => opts.threadTs,
        jail: {
          readRoots: channel.jail.readRoots,
          writeRoots: channel.jail.writeRoots,
          workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
          cwd,
        },
      })
    : [];

  const workspaceFileTools = channel.tools.includes("file_ops")
    ? createWorkspaceFileTools({
        jail: {
          readRoots: channel.jail.readRoots,
          writeRoots: channel.jail.writeRoots,
          workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
          cwd,
        },
      })
    : [];

  // Available without bash or exec: connector downloads should not require a
  // broad shell capability merely to become readable text.
  const localPdfTools = createLocalPdfTools({
    workspace: cwd,
    attachmentDir: channel.paths.attachmentText,
  });

  // The built-in bash tool inherits the harness process environment, which
  // would hand every channel the global secrets. Swap it for one whose
  // environment is this channel's own bundle, with the workspace's `bin` first
  // on PATH so a script the channel keeps there is a command it can just run.
  const wantsBash = channel.tools.includes("bash");
  const bashTool = wantsBash
    ? createBashToolDefinition(cwd, {
        // The Durable adapter runs a tool without a Pi session, and by default Pi's bash tool reads one to export
        // PI_SESSION_ID into the shell: it threw on every command. The harness has no use for those variables.
        exposeSessionEnvironment: false,
        spawnHook: (ctx) => ({ ...ctx, env: channelPathEnv(channel) }),
        // In container modes each thread reuses a container with only
        // this channel's workspace mounted, so bash cannot reach another
        // channel the way it can on the host.
        ...(isContainerMode(channel.sandbox.mode)
          ? {
              operations: createContainerBashOperations({
                config: channel.sandbox,
                workspace: cwd,
                dataDir: dirname(channel.shared.root),
                dockerDataDir: process.env.HARNESS_DOCKER_DATA_DIR,
                env: channel.env,
                mounts: channel.containerMounts,
                channelId: channel.ref.id,
                threadKey: opts.sandboxThreadKey ?? threadKey,
                ...(channel.channelDockerfile ? { dockerfile: channel.channelDockerfile } : {}),
              }),
            }
          : {}),
      })
    : undefined;
  if (wantsBash) {
    warnIfUnavailable(channel.ref.name ?? channel.ref.id, channel.sandbox, channel.channelDockerfile);
  }

  const execTools = channel.tools.includes("exec")
    ? createExecTools({
        config: channel.exec,
        cwd,
        binDir: channel.paths.bin,
        globalBinDir: channel.globalBin,
        env: channel.env,
      })
    : [];

  // The shared tool bin. Not gated by a tools list entry, same as the skill
  // library: publishing and execution are each their own permission, and the
  // function returns nothing when this channel has neither.
  const sharedToolTools = createSharedToolTools({ channel, cwd });

  // Reading the web is the harness's own tool rather than a shell command, so
  // a channel with no bash — which is most of them — can still look something
  // up. The policy comes from the channel, so one channel can be allowed onto
  // the LAN or given a search key without any of the others being.
  const webTools = channel.tools.includes("web")
    ? createWebTools({
        policy: {
          maxBytes: channel.web.maxBytes,
          maxChars: channel.web.maxChars,
          downloadMaxBytes: channel.web.downloadMaxBytes,
          timeoutSeconds: channel.web.timeoutSeconds,
          maxRedirects: channel.web.maxRedirects,
          allowHosts: channel.web.allowHosts,
          blockHosts: channel.web.blockHosts,
          allowPrivateHosts: channel.web.allowPrivateHosts,
          userAgent: channel.web.userAgent,
        },
        search: channel.web.search,
        workspace: cwd,
      })
    : [];

  const chartTools = channel.tools.includes("charts")
    ? createChartTools({
        channelLabel: opts.slackChannelLabel,
        jail: {
          readRoots: channel.jail.readRoots,
          writeRoots: channel.jail.writeRoots,
          workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
          cwd,
        },
      })
    : [];

  const slideTools = channel.tools.includes("slides")
    ? createSlideTools({
        channelLabel: opts.slackChannelLabel,
        jail: {
          readRoots: channel.jail.readRoots,
          writeRoots: channel.jail.writeRoots,
          workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
          cwd,
        },
        canUpload: Boolean(opts.uploader),
      })
    : [];

  const sqliteTools = channel.tools.includes("sqlite")
    ? createSqliteTools({
        jail: {
          readRoots: channel.jail.readRoots,
          writeRoots: channel.jail.writeRoots,
          workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
          cwd,
        },
      })
    : [];

  // The channel's shared state object. Always there, like memory: it is session infrastructure, not a capability a channel
  // opts into, so a channel with a minimal `tools` list has it too. A subagent can read it but not write it (like memory, it
  // gets the read half): what it learns reaches the channel through its report, and the channel agent decides what to record.
  const stateTools = createStateTools({ store: () => opts.stateStore?.(), threadKey, currentUserId: () => speaker.id });

  // The channel's own jobs. Only a channel that defines some is offered the tools, and never a subagent: what runs
  // unattended is the channel agent's to start, and a role's report is how its work reaches the channel.
  const jobTools = !isSubagent && Object.keys(channel.jobs ?? {}).length > 0
    ? createJobTools(createJobService({ channel, store: () => opts.jobStore?.(), threadKey, currentUserId: () => speaker.id }))
    : [];

  // The factory's workflow runs. Only a software-factory channel whose team has the roles the workflow needs is offered the
  // tools, and never a subagent: the channel agent starts a run and relays a person's decisions, the engine walks the stages.
  const factoryRunTools = !isSubagent && channel.factory && !workflowProblem(channel)
    ? createFactoryRunTools(
        createFactoryRunService({ channel, store: () => opts.factoryStore?.(), github: () => opts.factoryGitHub?.(), threadKey, currentUserId: () => speaker.id, ...(opts.factoryAnnounce ? { announce: opts.factoryAnnounce } : {}), ...(opts.factoryIntakeKick ? { intake: { kick: opts.factoryIntakeKick } } : {}), ...(opts.factoryEnsureLabels ? { labels: { ensure: opts.factoryEnsureLabels } } : {}) }),
        { dm: channel.ref.isDm },
      )
    : [];

  const imageTools = channel.tools.includes("images")
    ? createImageTools({
        config: channel.images,
        channelLabel: opts.slackChannelLabel,
        jail: {
          readRoots: channel.jail.readRoots,
          writeRoots: channel.jail.writeRoots,
          workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
          cwd,
        },
        deps: {
          resolveAuth: async (providerId, signal) => (await opts.modelRuntime.getAuth(providerId, { signal }))?.auth,
        },
      })
    : [];

  const capabilityTools = opts.capabilityRequests && !isSubagent
    ? createCapabilityTools(opts.capabilityRequests, () => ({ channelId: channel.ref.id, channelKey: channel.configKey ?? channel.ref.id, userId: speaker.id })) : [];

  const permissionTools = opts.permissions
    ? createPermissionTools({
        service: opts.permissions,
        channelId: channel.ref.id,
        requestable: channel.requestable,
      })
    : [];

  const slackTools = channel.tools.includes("slack")
    ? createSlackTools({
        userTokens: new SlackUserTokenStore(defaultSlackUserTokenPath(channel.shared), channel.env),
        currentUserId: () => speaker.id,
      })
    : [];

  // A channel-only grant: ordinary subagents do not inherit profile writes.
  const slackProfileTools = !isSubagent ? createSlackProfileTools({ channel }) : [];

  const delegationTools = opts.delegator
    ? createDelegationTools({
        delegator: opts.delegator,
        sourceChannelId: channel.ref.id,
        sourceChannelLabel: opts.slackChannelLabel,
        allowedTargets: channel.delegation.targets,
        currentThreadTs: () => opts.threadTs,
        currentUserId: () => speaker.id,
      })
    : [];

  // Always on, like memory: an agent that cannot write down how it did
  // something is one that has to be told again every week. A skill written
  // here is picked up by the reload, so it is live from the next message.
  const skillTools = createSkillTools({
    channel,
    // Skills are read from disk when each request's prompt is prepared, so a
    // saved skill is live from the next request with nothing to reload.
    reload: async () => {},
  });

  // The cross-channel shelf. Installing writes into this channel's own skills
  // directory, so it needs the same reload as writing one.
  const libraryTools = createLibraryTools({
    channel,
    reload: async () => {},
  });

  // The document library. Like the upload tool, it is handed the jail rather
  // than relying on the jail extension: `add_document` takes a path, and a
  // path the extension does not know about would sail straight past it.
  const documentTools = createDocumentTools({
    channel,
    jail: {
      readRoots: channel.jail.readRoots,
      writeRoots: channel.jail.writeRoots,
      workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
      cwd,
    },
    currentUserId: () => speaker.id,
  });

  // Read-only, and empty unless this channel is linked to a knowledge base. The librarian subagent gets the same tools.
  const knowledgeTools = createKnowledgeTools({ channel });

  // Always on, and deliberately not configurable: a channel whose agent cannot
  // say what got in its way is one that fails the same way every week without
  // anyone finding out. Reports name the channel that filed them, so the tool
  // is the only route in — the file itself sits outside every jail.
  const feedbackTools = createFeedbackTools({
    channel,
    currentUserId: () => speaker.id,
    ...(opts.feedbackResolution ? { resolution: opts.feedbackResolution } : {}),
  });

  const notificationTools = createNotificationTools({
    channel,
    currentUserId: () => speaker.id,
  });

  const taskStatusTools = createTaskStatusTools(() => taskTracker);
  const taskWorkflowTools = !isSubagent || opts.taskWorkflowParticipant
    ? createTaskWorkflowTools({
        channelId: channel.ref.id, threadKey, store: () => opts.taskWorkflowStore?.(),
        agents: channel.agents, runner: () => opts.subagentRunner?.(), currentUserId: () => speaker.id,
        isApproved: (name) => channelHasGrant(channel.paths.root, subagentCapability(name)),
        parentTaskId: () => taskTracker?.start().id,
        ...(opts.taskWorkflowParticipant ? { participant: opts.taskWorkflowParticipant } : {
          onChange: async () => {
            taskTracker?.start();
            await reconcileWorkflowTask(taskTracker, opts.taskWorkflowStore?.(), threadKey);
          },
        }),
      })
    : [];
  // Factory tool is strictly read-only against GitHub and only writes this
  // channel's already-public artifacts directory.
  const factoryTools = createFactoryTools(channel);


  // The admin channel only, and never a subagent: changing the config is the one thing that changes what everything else can do.
  const adminConfigTools = !isSubagent && channel.admin && opts.adminConfig
    ? createAdminConfigTools({
        service: opts.adminConfig,
        channelId: channel.ref.id,
        channelKey: channel.configKey ?? channel.ref.name ?? channel.ref.id,
        currentUserId: () => speaker.id,
        approvers: () => channel.allowUsers ?? [],
      })
    : [];

  const subagentTools = isSubagent
    ? []
    : createSubagentTools({
        agents: channel.agents,
        runner: () => opts.subagentRunner?.(),
        currentUserId: () => speaker.id,
        // Read from the channel's grant file at the moment of the call: a session built before an approval
        // must see it, and one built before an expiry must not keep using it.
        isApproved: (name) => channelHasGrant(channel.paths.root, subagentCapability(name)),
      });

  // A subagent keeps only what its role asked for. What it learns reaches the channel through its report, and
  // it reads the channel's memory but never writes it: the channel agent decides what is worth remembering.
  const customTools = isSubagent
    ? [
        ...memoryTools.filter((tool) => tool.name === "recall"),
        ...timeTools,
        ...taskWorkflowTools,
        // `narrowChannelForAgent` leaves knowledge bases only on the librarian, so every other role gets nothing here.
        ...knowledgeTools,
        ...(opts.configuratorService ? createConfiguratorTools(opts.configuratorService) : []),
        ...(opts.capabilityConfiguratorActor && opts.capabilityRequests ? createCapabilityConfiguratorTools(opts.capabilityRequests, opts.capabilityConfiguratorActor) : []),
        // Reading a downloaded PDF is part of reading; a role without `read` has no business with the attachment store.
        ...(channel.tools.includes("read") ? localPdfTools : []),
        ...webTools,
        ...chartTools,
        ...slideTools,
        ...sqliteTools,
        ...stateTools.filter((tool) => tool.name === "state_read"),
        ...createListTools(channel.paths.root).filter((tool) => tool.name === "list_read"),
        ...imageTools,
        ...workspaceFileTools,
        ...execTools,
        ...slackTools,
        ...(bashTool ? [bashTool as ToolDefinition] : []),
        ...connectorSession.tools,
      ]
    : [
        ...memoryTools,
        ...timeTools,
        ...skillTools,
        ...libraryTools,
        ...documentTools,
        ...knowledgeTools,
        ...feedbackTools,
        ...notificationTools,
        ...taskStatusTools,
        ...taskWorkflowTools,
        ...factoryTools,
        ...modelTools,
        ...scheduleTools,
        ...postTools,
        ...crossPostTools,
        ...postAsTools,
        ...interactiveTools,
        ...fileTools,
        ...workspaceFileTools,
        ...localPdfTools,
        ...webTools,
        ...chartTools,
        ...slideTools,
        ...sqliteTools,
        ...stateTools,
        ...createListTools(channel.paths.root),
        ...jobTools,
        ...factoryRunTools,
        ...imageTools,
        ...execTools,
        ...sharedToolTools,
        ...permissionTools,
        ...capabilityTools,
        ...slackTools,
        ...slackProfileTools,
        ...delegationTools,
        ...subagentTools,
        ...adminConfigTools,
        ...(bashTool ? [bashTool as ToolDefinition] : []),
        ...connectorSession.tools,
      ];

  // Built-in tools minus the ones the harness supplies itself: bash, replaced
  // above when enabled; web, charts, slides, sqlite, exec, images, slack, file_ops and
  // which are harness tools rather than pi built-ins. All reach the
  // model through `customTools` instead.
  const builtinTools = channel.tools.filter(
    (t) => !["bash", "web", "charts", "slides", "sqlite", "exec", "images", "slack", "file_ops"].includes(t),
  );


  const builtinDefinitions: ToolDefinition[] = builtinTools.flatMap((name): ToolDefinition[] => {
    switch (name) {
      case "read": return [createReadToolDefinition(cwd) as ToolDefinition];
      case "write": return [createWriteToolDefinition(cwd) as ToolDefinition];
      case "edit": return [createEditToolDefinition(cwd) as ToolDefinition];
      case "grep": return [createGrepToolDefinition(cwd) as ToolDefinition];
      case "find": return [createFindToolDefinition(cwd) as ToolDefinition];
      case "ls": return [createLsToolDefinition(cwd) as ToolDefinition];
      default:
        logger.warn(`unknown built-in tool "${name}" in ${channel.ref.id}; ignoring`);
        return [];
    }
  });

  const tools = [...builtinDefinitions, ...(customTools as ToolDefinition[])];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name in ${channel.ref.id}: ${tool.name}`);
    seen.add(tool.name);
  }

  if (connectorSession.failures.length > 0) {
    logger.warn(
      `connectors unavailable in ${channel.ref.id}: ` +
        connectorSession.failures.map((f) => `${f.name} (${f.error})`).join(", "),
    );
  }

  const jail: JailConfig = {
    readRoots: channel.jail.readRoots,
    writeRoots: channel.jail.writeRoots,
    workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
    pathAliases: containerPathAliases(channel),
    cwd,
  };
  tools.push(createSaveToolOutputTool({ tools, jail, ...(opts.onViolation ? { onViolation: opts.onViolation } : {}) }));

  return {
    tools,
    jail,
    speaker,
    setTaskTracker(tracker: TaskRunTracker | undefined) {
      taskTracker = tracker;
    },
    dispose: () => connectorSession.close(),
  };
}

const normaliseQuote = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
/** Shorter than this, a "quote" matches too much by accident to count as evidence. */
const MIN_QUOTE_CHARS = 12;

/**
 * Whether a post_as_user `source` quote is something a person actually said in this thread: at least 12 characters,
 * found (whitespace-normalised, case-insensitive) in one of the thread's USER turns. The agent's own words never
 * count. No store, a short quote or any error is simply unverified.
 */
export async function verifySourceInThread(
  store: Pick<DurableChannelStore, "threadTurns"> | undefined,
  threadKey: string,
  quote: string,
): Promise<boolean> {
  const wanted = normaliseQuote(quote);
  if (wanted.length < MIN_QUOTE_CHARS || !store) return false;
  try {
    const turns = await store.threadTurns(threadKey);
    return turns.some((turn) => turn.role === "user" && normaliseQuote(turn.text).includes(wanted));
  } catch {
    return false;
  }
}

/** This session's system prompt: what it can do (post, upload, interact) is part of what it says. */
export function threadInstructions(opts: CreateThreadSessionOptions): string {
  return buildSystemPrompt(opts.channel, {
    harnessName: opts.harnessName,
    slackChannelLabel: opts.slackChannelLabel,
    botUserId: opts.botUserId,
    canPost: Boolean(opts.poster),
    canUseInteractiveComponents: Boolean(opts.interactiveResponses),
    canUpload: Boolean(opts.uploader),
    includeLateContext: false,
  });
}

/** The prompt a channel's conversations share: static instructions plus per-request sections. */
export function runtimeTemplate(opts: CreateThreadSessionOptions, toolSet: ThreadToolSet): RuntimeTemplate {
  const { channel } = opts;
  const guidelines = [...new Set(toolSet.tools.flatMap((tool) => tool.promptGuidelines ?? []))];
  // Subagent-only schemas must be registered in the shared store, but are never bound/offered to parent threads.
  const configurationSchemas = opts.configuratorConfig && channel.agents.some((agent) => agent.configuration)
    ? createConfiguratorTools().filter((tool) => !toolSet.tools.some((existing) => existing.name === tool.name))
    : [];
  return {
    tools: [...toolSet.tools, ...configurationSchemas,
      ...(opts.capabilityRequests && channel.admin && channel.agents.some((a) => a.configuration === "harness") ? createCapabilityConfiguratorTools() : [])],
    instructions: threadInstructions(opts),
    sections: [
      ...(guidelines.length > 0
        ? [section("guidelines", () => guidelines.map((rule) => `- ${rule}`).join("\n"), { tag: false })]
        : []),
      // Read on every request, so a skill saved or installed mid-conversation is live next turn.
      section("skills", (input) => {
        // Drop symlink-escaping skills; in docker mode show in-container paths.
        const skills = presentSkills(channel, loadAvailableSkills(channel));
        // Listed only to an agent that can open them: a subagent without `read` would otherwise be shown skills it cannot use.
        const canRead = input.agent.tools.some((tool) => tool.name === "read");
        return skills.length > 0 && canRead ? formatSkillsForPrompt(skills).trim() : undefined;
      }, { tag: false }),
      section("workspace", () => `Current working directory: ${channel.paths.workspace}`, { tag: false }),
      // Volatile, so it comes last: a change must not invalidate the cached prefix above it.
      section("runtime", (input) => {
        const current = input.agent.model ? `${input.agent.model.provider}/${input.agent.model.modelId}` : undefined;
        const heartbeat = opts.schedules && input.agent.tools.some((tool) => tool.name === "read_heartbeat")
          ? heartbeatContext(opts.schedules, channel.ref.id) : undefined;
        return [buildLatePromptContext(channel, current), heartbeat].filter(Boolean).join("\n\n") || undefined;
      }, { tag: false }),
    ],
  };
}

/**
 * Run `fn` against the channel's store, opening it if need be. Used by commands and startup
 * recovery, which need the store but no live thread. When the store is not open yet a throwaway
 * tool set is built just to register its schemas, then released.
 */
export async function withChannelRuntime<T>(
  opts: Omit<CreateThreadSessionOptions, "threadKey">,
  fn: (runtime: ChannelRuntime) => Promise<T>,
): Promise<T> {
  const probe: CreateThreadSessionOptions = { ...opts, threadKey: "channel-runtime", connectorOwner: "template" };
  let toolSet: ThreadToolSet | undefined;
  let lease: RuntimeLease | undefined;
  try {
    lease = await opts.runtimes.acquire(opts.channel, async () => {
      toolSet = await buildThreadToolSet(probe, { current: () => undefined, set: async () => { throw new Error("No active session to switch."); } });
      return runtimeTemplate(probe, toolSet);
    });
    return await fn(lease.runtime);
  } finally {
    lease?.release();
    await toolSet?.dispose().catch(() => undefined);
  }
}

/**
 * Rebuild the tools for a conversation that has live work but no session (after a restart), from the
 * CURRENT configuration, and bind them. Whatever permissions, connectors and sandbox the channel has now
 * is what the recovered turn gets; nothing is restored from stored state. Throws to refuse.
 */
export async function bindRecoveredThread(
  runtime: ChannelRuntime,
  opts: CreateThreadSessionOptions,
  conversationId: ConversationId,
): Promise<{ dispose(): Promise<void> }> {
  const { store, bindings } = runtime;
  const control: ModelControl = {
    current: () => undefined,
    set: async (model) => { await store.setModel(opts.threadKey, modelRefOf(model)); },
  };
  const toolSet = await buildThreadToolSet({ ...opts, connectorOwner: "recovery", threadStore: () => store, stateStore: () => store, jobStore: () => store, factoryStore: () => store, taskWorkflowStore: () => store }, control);
  const bound: BoundThreadTools = {
    tools: new Map(toolSet.tools.map((tool) => [tool.name, tool])),
    jail: toolSet.jail,
    ...(opts.onViolation ? { onViolation: opts.onViolation } : {}),
  };
  const registered = new Set(store.registeredToolNames());
  store.setThreadProfile(opts.threadKey, {
    tools: toolSet.tools.map((tool) => tool.name).filter((name) => registered.has(name)),
    instructions: threadInstructions(opts),
  });
  bindings.bind(conversationId, bound, { recovered: true });
  // Re-apply the current loadout to the stored agent now, so the resumed request is offered today's tools, not the pre-crash list.
  await store.conversationIdFor(opts.threadKey, false);
  return {
    dispose: async () => {
      bindings.unbind(conversationId, bound);
      store.clearThreadProfile(opts.threadKey);
      await toolSet.dispose();
    },
  };
}

/** Task completion belongs to the aggregate of workflows attached to this task, not the last tool call. */
async function reconcileWorkflowTask(tracker: TaskRunTracker | undefined, store: TaskWorkflowStore | undefined, threadKey: string): Promise<void> {
  if (!tracker || !store) return;
  const task = tracker.current();
  if (!task) return;
  const workflows = (await store.listTaskWorkflows(threadKey)).filter(
    (workflow) => workflow.channelId === task.channelId && workflow.parentTaskId === task.id,
  );
  if (!workflows.length) return;
  const status = workflows.some((workflow) => workflow.status === "active") ? "waiting"
    : workflows.some((workflow) => workflow.status === "aborted") ? "abandoned" : "closed_successfully";
  tracker.setStatus(status, `Gated task workflows: ${workflows.map((workflow) => `${workflow.id}: ${workflowNextAction(workflow)}`).join("; ")}`);
}

export async function createThreadSession(opts: CreateThreadSessionOptions): Promise<ThreadSession> {
  const { channel, threadKey } = opts;
  let taskTracker = opts.taskTracker;
  markThreadPresent(channel, threadKey);

  // The model tools reach the conversation through this handle, which is attached once the
  // store (and so the conversation) exists: the tools must be built before the store can be.
  let control: ModelControl | undefined;
  const modelControl: ModelControl = {
    current: () => control?.current(),
    set: (model) => {
      if (!control) throw new Error("No active session to switch.");
      return control.set(model);
    },
  };

  // Subagents run in the channel's store, which is opened below; the delegating tool reaches the runner through this.
  let subagentRunner: SubagentRunner | undefined;
  // The same for post_as_user's source check, which reads this thread's turns from the store.
  let threadStore: DurableChannelStore | undefined;
  // Owned by whichever turn is running now (set by the app, cleared when it ends).
  let subagentProgress: SubagentProgressSink | undefined;
  const startedAt = performance.now();
  const toolSet = await buildThreadToolSet({ ...opts, subagentRunner: () => subagentRunner, threadStore: () => threadStore, stateStore: () => threadStore, jobStore: () => threadStore, factoryStore: () => threadStore, taskWorkflowStore: () => threadStore }, modelControl);
  const toolsMs = performance.now() - startedAt;
  let storeMs = 0;
  let lease: RuntimeLease | undefined;
  let bound: BoundThreadTools | undefined;
  let conversationId: ConversationId | undefined;
  let isNewConversation = false;
  let templateSet: ThreadToolSet | undefined;
  const listeners = new Set<(event: TurnEvent) => void>();
  let lastText: string | undefined;
  let aborted = false;
  let cachedModel: Model<never> | undefined;
  let store!: DurableChannelStore;
  let bindings!: ChannelRuntime["bindings"];

  // Everything from here on can throw, and every step takes something that must be given back: the lease (a leaked
  // one would make the channel's next retirement wait forever), the binding, the profile and the connectors.
  const release = async () => {
    if (conversationId !== undefined && bound) bindings?.unbind(conversationId, bound);
    store?.clearThreadProfile(threadKey);
    lease?.release();
    await toolSet.dispose().catch(() => undefined);
    await templateSet?.dispose().catch(() => undefined);
  };

  async function currentModel(): Promise<Model<never> | undefined> {
    const ref = await store.model(threadKey);
    if (!ref) return undefined;
    if (!cachedModel || cachedModel.provider !== ref.provider || cachedModel.id !== ref.modelId) {
      cachedModel = resolveModel(`${ref.provider}/${ref.modelId}`, opts.modelRuntime) as Model<never>;
    }
    return cachedModel;
  }

  try {
    const acquireStartedAt = performance.now();
    lease = await opts.runtimes.acquire(channel, async () => {
      if (!opts.template) return runtimeTemplate(opts, toolSet);
      const full: CreateThreadSessionOptions = { ...opts.template, threadKey, connectorOwner: "template" };
      templateSet = await buildThreadToolSet(full, { current: () => undefined, set: async () => { throw new Error("No active session to switch."); } });
      return runtimeTemplate(full, templateSet);
    });
    await templateSet?.dispose().catch(() => undefined);
    templateSet = undefined;
    ({ store, bindings } = lease.runtime);
    threadStore = store;
    storeMs = performance.now() - acquireStartedAt;
    if (channel.agents.length > 0) {
      subagentRunner = createSubagentRunner({
        parent: { ...opts, subagentProgress: () => subagentProgress ?? opts.subagentProgress?.() },
        runtime: lease.runtime,
        runtimes: opts.runtimes,
        modelRuntime: opts.modelRuntime,
        buildToolSet: (runOpts) => buildThreadToolSet(runOpts, {
          current: () => undefined,
          set: async () => { throw new Error("A subagent cannot switch models."); },
        }),
      });
    }

    // The store's tool schemas were fixed when it opened. A tool this session has that the store never registered
    // (a connector that was down at that moment) cannot be offered: say so, and retire the store so the next session
    // registers the full set, instead of failing every session until something else happens to reload it.
    const registered = new Set(store.registeredToolNames());
    const names = toolSet.tools.map((tool) => tool.name);
    const missing = names.filter((name) => !registered.has(name));
    if (missing.length > 0) {
      logger.warn(
        `tools not registered in ${channel.ref.id}'s store (a connector was unavailable when it opened): ${missing.join(", ")}. ` +
          "They are withheld from this session and the store will be re-opened.",
      );
      void opts.runtimes.invalidate(channel.ref.id).catch(() => undefined);
    }
    // What this conversation is offered comes from THIS freshly built set (current permissions), applied at activation.
    store.setThreadProfile(threadKey, { tools: names.filter((name) => registered.has(name)), instructions: threadInstructions(opts) });
    // New means no request was ever admitted here (not merely "no fork yet"): a crash between creating the fork and
    // submitting must not skip the one-time history read on the retry.
    isNewConversation = (await store.admittedRequests(threadKey)) === 0;
    conversationId = await store.conversationIdFor(threadKey);
    // A turn resumed after a restart is still running here with ITS speaker and tools; a live session binding over it
    // would let that turn's remaining tool calls run as someone else.
    if (bindings.isRecovered(conversationId) && (await store.liveRequests(conversationId)).length > 0) {
      throw new Error("A request in this thread that was interrupted by a restart is still being resumed. Please try again in a moment.");
    }
    bound = { tools: new Map(toolSet.tools.map((tool) => [tool.name, tool])), jail: toolSet.jail, ...(opts.onViolation ? { onViolation: opts.onViolation } : {}) };
    bindings.bind(conversationId, bound);
    control = {
      current: () => cachedModel,
      set: async (model) => {
        await store.setModel(threadKey, modelRefOf(model));
        cachedModel = model as Model<never>;
      },
    };
    await currentModel();
  } catch (error) {
    await release();
    throw error;
  }

  const session: TurnSession = {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async prompt(text, options) {
      // The speaker holder is what in-process tools read; the request carries it durably.
      toolSet.speaker.id = options.userId;
      aborted = false;
      const content = options.images && options.images.length > 0
        ? [{ type: "text" as const, text }, ...options.images]
        : text;
      const adapter = new TurnEventAdapter();
      const watch = await store.watch(threadKey);
      watch.start(async (events) => {
        for (const event of adapter.feed(events)) for (const listener of [...listeners]) listener(event);
      });
      try {
        const submission = await store.submit(threadKey, {
          requestId: options.requestId, content, userId: options.userId,
          ...(options.fingerprint !== undefined ? { fingerprint: options.fingerprint } : {}),
        });
        options.steering?.start(async (input) => {
          // Defense in depth for callers other than Slack routing. Do not switch an
          // in-flight tool principal or admit another person's instructions under it.
          if (input.userId !== options.userId) throw new Error("Cross-author steering requires a separate turn.");
          const prepared = await input.prepare();
          if (!options.steering!.isOpen) throw new Error("The steering window closed during preparation.");
          const text = steeringText(input.userId, input.messageTs, prepared.text);
          const steered = await store.submit(threadKey, {
            requestId: input.requestId, userId: input.userId, steeringFor: options.requestId,
            fingerprint: input.requestId,
            content: prepared.images?.length ? [{ type: "text", text }, ...prepared.images] : text,
            entry: { kind: "slack.steering", data: { userId: input.userId, messageTs: input.messageTs, parentRequestId: options.requestId } },
          });
          return { completion: store.wait(steered) };
        });
        lastText = (await store.wait(submission)).text;
        // A final-only generation can settle the original request before its queued steering
        // continuation. Keep watching and hold the Slack reply until every owned input settles.
        lastText = (await options.steering?.finish()) ?? lastText;
        // A successful idle answer is not a dispatch. Offer ONE corrective parent request,
        // under the same bindings/speaker/turn lease; never call a worker or retry ourselves.
        const pendingRework = async () => {
          if (opts.role === "subagent" || !taskTracker?.current()) return [];
          const task = taskTracker.current()!;
          return (await store.listTaskWorkflows(threadKey)).filter((workflow) =>
            workflow.channelId === channel.ref.id && workflow.parentThreadKey === threadKey
            && workflow.parentTaskId === task.id && needsReworkDispatch(workflow)).sort((a, b) => a.id.localeCompare(b.id));
        };
        const pending = await pendingRework();
        if (!aborted && pending.length) {
          const reminder = [
            "Runtime continuation check: you ended the parent turn with reworked steps still ready, not working or interrupted.",
            "Continue the already-authorized workflow: check the latest revision, then explicitly run the ready step without retry=true. Feedback travels with the new attempt. Independently review every new submission; never auto-approve gates.",
            "If dispatch genuinely needs an external person/system/access dependency, record the concrete dependency with defer_task_workflow_step and explain it. Readiness or parent dispatch delay alone is not a safety/access block. Do not retry or supersede working attempts.",
            ...pending.map((workflow) => workflow.id + ": " + workflowNextAction(workflow)),
            "This is the only automatic continuation reminder for this turn. Re-read state: these observations confer no attempt/revision authority.",
          ].join("\n\n");
          const continuation = await store.submit(threadKey, {
            // The durable request receipt is the one-reminder budget for this ORIGINAL request,
            // independent of revisions or which workflows remain pending after the reminder runs.
            requestId: options.requestId + ":rework-dispatch",
            // Observations may change on redelivery; reuse the admitted content/result, not a new turn.
            fingerprint: "rework-dispatch",
            content: reminder, userId: options.userId,
          });
          // An abort racing admission must not start the new request when wait() activates it.
          if (aborted) { await store.abort(threadKey); return; }
          lastText = (await store.wait(continuation)).text;
          const remaining = await pendingRework();
          if (!aborted && remaining.length) throw new Error(
            "Parent continuation stalled: " + remaining.map((workflow) => workflow.id).join(", ")
            + " ready — awaiting parent dispatch, not a working/interrupted attempt or a safety/access block. The bounded reminder was exhausted; explicitly run the step or record a concrete external dependency. No attempt was automatically retried.",
          );
        }
      } catch (error) {
        if (options.steering) {
          // Model failure may leave queued steering without a successor generation.
          await options.steering.cancel(() => store.abort(threadKey));
        }
        throw error;
      } finally {
        options.steering?.close();
        try {
          await watch.stop();
          await currentModel();
        } finally {
          // SlackApp eagerly resumes waiting tasks, even for chat/read-only turns. Restore the
          // workflow-owned outcome before its per-turn tracker.finish() can close the parent.
          await reconcileWorkflowTask(taskTracker, store, threadKey);
        }
      }
    },
    getLastAssistantText: () => lastText,
    model: currentModel,
    abort: () => { aborted = true; return store.abort(threadKey); },
  };

  const timings = {
    toolsMs: Math.round(toolsMs), storeMs: Math.round(storeMs),
    threadMs: Math.round(performance.now() - startedAt - toolsMs - storeMs), totalMs: Math.round(performance.now() - startedAt),
  };
  logger.info(
    `session ready in ${timings.totalMs}ms (tools ${timings.toolsMs}ms, store+recovery ${timings.storeMs}ms, thread ${timings.threadMs}ms): ` +
      `channel=${channel.ref.name ?? channel.ref.id} thread=${threadKey} ` +
      `model=${cachedModel ? `${cachedModel.provider}/${cachedModel.id}` : "?"} tools=[${channel.tools.join(",")}] ` +
      `skills=${channel.skillPaths.length} connectors=${channel.connectors.length}`,
  );

  return {
    session,
    store,
    timings,
    isNewConversation,
    channel,
    threadKey,
    lastUsed: Date.now(),
    get currentUserId() {
      return toolSet.speaker.id;
    },
    set currentUserId(id: string) {
      toolSet.speaker.id = id;
    },
    setTaskTracker: (tracker) => { taskTracker = tracker; toolSet.setTaskTracker(tracker); },
    setSubagentProgress: (sink) => { subagentProgress = sink; },
    dispose: release,
  };
}

/**
 * Keeps threads warm without letting a Pi run out of memory. Sessions are
 * evicted after an idle timeout; the transcript is on disk, so a later message
 * in the same thread just reloads it.
 */
export class SessionPool {
  private sessions = new Map<string, ThreadSession>();
  private timer?: NodeJS.Timeout;
  /** Whole-turn leases include async startup, not just sessions already cached. */
  private readonly activeTurns = new Set<string>();
  private readonly invalidatedTurns = new Set<string>();

  private readonly maxSessions: number;
  private readonly idleMs: number;

  constructor(maxSessions = 12, idleMs = 30 * 60 * 1000) {
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
  }

  private key(channelId: string, threadKey: string): string {
    return `${channelId}:${threadKey}`;
  }

  get(channelId: string, threadKey: string): ThreadSession | undefined {
    const found = this.sessions.get(this.key(channelId, threadKey));
    if (found) found.lastUsed = Date.now();
    return found;
  }

  /** The caller serializes turns for a key and holds this lease through cleanup. */
  beginTurn(channelId: string, threadKey: string): void {
    const key = this.key(channelId, threadKey);
    if (this.activeTurns.has(key)) throw new Error(`Turn already active: ${key}`);
    this.activeTurns.add(key);
  }

  async endTurn(channelId: string, threadKey: string): Promise<void> {
    const key = this.key(channelId, threadKey);
    // Keep the lease through asynchronous disposal so a second reload/eviction
    // cannot race cleanup. The per-thread queue waits for this before starting
    // its successor, which resolves the latest config.
    try {
      if (this.invalidatedTurns.delete(key)) await this.drop(channelId, threadKey);
    } catch (err) {
      // Cleanup failure must not rewrite an already-completed agent outcome.
      // drop detached the stale entry before awaiting the failing disposer.
      logger.warn(`could not dispose invalidated session ${key}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.invalidatedTurns.delete(key);
      this.activeTurns.delete(key);
    }
  }

  /**
   * Detach idle sessions synchronously, before awaiting any disposal. Active
   * turns retain their tools until their own endTurn, including sessions still
   * being created. No deferred global disposal can touch newer sessions.
   */
  invalidate(): { activeTurns: number; disposed: Promise<void> } {
    for (const key of this.activeTurns) this.invalidatedTurns.add(key);
    const idle = [...this.sessions.entries()].filter(([key]) => !this.activeTurns.has(key));
    for (const [key] of idle) this.sessions.delete(key);
    return {
      activeTurns: this.activeTurns.size,
      disposed: Promise.allSettled(idle.map(([, session]) => session.dispose())).then(() => undefined),
    };
  }

  async set(channelId: string, threadKey: string, session: ThreadSession): Promise<void> {
    this.sessions.set(this.key(channelId, threadKey), session);
    await this.evictIfNeeded();
    this.startSweeper();
  }

  /**
   * Drop every session in a channel. Used when the channel's capabilities
   * change: tools and sandbox settings are fixed when a session is built, so a
   * live session would keep the old ones until it happened to be evicted.
   */
  async disposeChannel(channelId: string): Promise<void> {
    const prefix = `${channelId}:`;
    // A turn that is running keeps its tools until its own endTurn (like `invalidate`): disposing it now would pull
    // the tools out from under a request in flight, and release the lease its channel store is waiting on.
    for (const key of this.activeTurns) if (key.startsWith(prefix)) this.invalidatedTurns.add(key);
    const idle = [...this.sessions.entries()].filter(([k]) => k.startsWith(prefix) && !this.activeTurns.has(k));
    for (const [key] of idle) this.sessions.delete(key);
    await Promise.allSettled(idle.map(([, s]) => s.dispose()));
  }

  async drop(channelId: string, threadKey: string): Promise<void> {
    const key = this.key(channelId, threadKey);
    const found = this.sessions.get(key);
    if (!found) return;
    this.sessions.delete(key);
    await found.dispose();
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].filter(([key]) => !this.activeTurns.has(key)).sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      )[0];
      if (!oldest) return;
      this.sessions.delete(oldest[0]);
      await oldest[1].dispose();
      logger.debug(`evicted idle session ${oldest[0]}`);
    }
  }

  private startSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const cutoff = Date.now() - this.idleMs;
      for (const [key, s] of [...this.sessions.entries()]) {
        if (s.lastUsed < cutoff && !this.activeTurns.has(key)) {
          this.sessions.delete(key);
          void s.dispose();
          logger.debug(`swept idle session ${key}`);
        }
      }
      if (this.sessions.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, 60_000);
    this.timer.unref?.();
  }

  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(all.map((s) => s.dispose()));
  }
}
