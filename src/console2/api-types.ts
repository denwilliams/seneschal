/**
 * The wire contract between the harness and webConsole2 (`web/console2/`).
 *
 * Types only: no imports, no runtime code, so the browser app can import this file without pulling in anything from the
 * server. Everything here is deliberately names-and-numbers: no tool arguments or results, and no message text for direct
 * messages ("names, not bodies").
 *
 * Routes (all GET, all under `<base>/console2/api/v1`):
 *   /tree                              TreeResponse
 *   /channels/:id                      ChannelResponse
 *   /channels/:id/session?thread=:key  SessionResponse
 *   /channels/:id/threads/:key         TranscriptResponse   (?before=<entry id>&limit=<n>)
 *   /channels/:id/tasks                TasksResponse
 *   /channels/:id/tools?thread=:key    ToolsResponse
 *   /channels/:id/extend               ExtendResponse
 *   /channels/:id/memory               MemoryResponse
 *   /channels/:id/state                StateResponse
 *   /channels/:id/artifacts            ArtifactsResponse
 *   /channels/:id/timeline             TimelineResponse     (?tools=0&actor=<name>&limit=<n>)
 *   /channels/:id/factory              FactoryResponse      (?refresh=1)
 *   /channels/:id/workflows            WorkflowsResponse
 *   /channels/:id/workflows/:runId     WorkflowRunResponse
 *   /events                            text/event-stream of ConsoleEvent
 */

export const CONSOLE2_API_VERSION = 1;

/** Channel list wire types stay here so the console-only Docker stage needs no server sources. */
export type ListColumn = { name: string; type: string; editable: boolean; standard: boolean };
export type ListItem = Record<string, string | number | boolean | null>;
export interface ListsView {
  lists: string[];
  list?: string;
  columns?: ListColumn[];
  items?: ListItem[];
  offset?: number;
  nextOffset?: number;
}

/** What an agent (or a whole channel) is doing right now. */
export type ActivityState = "running" | "blocked" | "waiting" | "idle";

export type NodeKind = "main" | "thread" | "run" | "scheduled" | "dream";

export interface TreeNode {
  /** Unique within its channel: the thread key, or `main`. */
  id: string;
  kind: NodeKind;
  /** Short human label (thread timestamp, role name, "main"). */
  label: string;
  state: ActivityState;
  lastActivity?: string;
  /** Entry on `main` this node forked from, when it is a fork. */
  forkedFromEntry?: number;
  /** Subagent runs spawned from this thread, when known. */
  children?: TreeNode[];
}

export interface TreeChannel {
  id: string;
  name?: string;
  isDm: boolean;
  /** False for a configured name not yet matched to a Slack ID: it has no page. */
  linkable: boolean;
  state: ActivityState;
  activeTasks: number;
  lastActivity?: string;
  /**
   * Whether the channel's durable store is open in this process. Only then can threads and transcripts be listed; a closed
   * store cannot be read from outside the process that owns it, so `nodes` is empty and the UI says so.
   */
  live: boolean;
  factory?: string;
  nodes: TreeNode[];
  /** Older idle conversations left out of `nodes` to keep the tree small (the newest are kept). */
  hiddenNodes?: number;
  /**
   * The channel state object's revision, for live channels. It is in the tree so that a change to the state changes the tree,
   * which is what tells the browser to refetch (`tree` event).
   */
  stateRev?: number;
  /** Bumps whenever any job run in this channel changes, for the same reason: it makes the browser refetch the Tasks tab. */
  jobVersion?: number;
}

export interface TreeResponse {
  generatedAt: string;
  harnessName: string;
  /** The operator let the console act on factory runs (`webConsole.actions`). Absent otherwise: the console only shows. */
  actions?: true;
  channels: TreeChannel[];
}

export interface ChannelResponse {
  id: string;
  name?: string;
  isDm: boolean;
  description?: string;
  /** Present when the channel is rejected by configuration. */
  rejected?: string;
  live: boolean;
  state: ActivityState;
  counts: Record<string, number>;
  factory?: { name: string; repositories: string[] };
}

export interface UsageRow {
  type: "input" | "output" | "cacheRead" | "cacheWrite";
  tokens: number;
  costUsd?: number;
}

export type SandboxMode = "host" | "docker" | "macos-container" | "kiri" | "unknown";

export interface ExecutionEnvironment {
  /** Current configuration, not proof of a running container. */
  configuredMode: SandboxMode;
  /** The open runtime's tool wiring, or configuration when the store is closed. */
  toolMode: SandboxMode;
  source: "runtime" | "configuration";
  reuse?: boolean;
  status?: {
    state: "running" | "stopped" | "absent" | "not-applicable" | "unknown";
    detail: string;
    checkedAt?: string;
  };
}

export interface SessionResponse {
  channelId: string;
  threadKey?: string;
  live: boolean;
  /** `provider/model` the thread (or channel) is on. */
  model?: string;
  thinkingLevel: string;
  /** Whether this thread was moved off the channel default. */
  pinnedModel?: boolean;
  context?: {
    /** Tokens in the last request's prompt, when the thread has one. */
    usedTokens: number;
    /** The model's window, when known. */
    windowTokens?: number;
  };
  usage: {
    /** `thread` when a conversation is selected; `channel` for the whole channel (no thread, or the `main` trunk, which has no records of its own). */
    scope: "thread" | "channel";
    calls: number;
    totalTokens: number;
    costUsd: number;
    /** Calls with no pricing data, so `costUsd` is a lower bound. */
    unpricedCalls: number;
    rows: UsageRow[];
    /** Activity attribution, including recurring heartbeat cost. Historical records are not reclassified. */
    bySource?: { source: string; calls: number; tokens: number; costUsd: number; unpricedCalls: number }[];
  };
  toolCount: number;
  sandbox: string;
  execution?: ExecutionEnvironment;
  allowedUsers: number | "anyone";
  sharing: string[];
  schedules: boolean;
  dreams: boolean;
  respondToRootMessages: boolean;
}

export type ToolCallStatus = "ok" | "error" | "pending";

export interface ToolCallCard {
  callId: string;
  name: string;
  status: ToolCallStatus;
}

export type EntryRole = "user" | "assistant" | "tool" | "system";

export interface TranscriptEntry {
  /**
   * Unique within the response: the entry id, with a `.n` suffix for the second and later messages of an entry that holds
   * several. Use this as the React key and the merge key.
   */
  key: string;
  /** Durable entry id: stable and increasing within a conversation. Several messages of one entry share it. */
  id: number;
  role: EntryRole;
  at?: string;
  /** Absent when `redacted`. */
  text?: string;
  /** True for a direct-message conversation: the shape is shown, the words are not. */
  redacted?: boolean;
  /** True when the entry came from `main` at fork time rather than being said in this thread. */
  inherited?: boolean;
  model?: string;
  tokens?: number;
  costUsd?: number;
  toolCalls?: ToolCallCard[];
}

export interface TranscriptResponse {
  channelId: string;
  threadKey: string;
  kind: NodeKind;
  /** False when the store is not open here, or the thread does not exist. */
  available: boolean;
  reason?: string;
  redacted: boolean;
  running: boolean;
  forkedFromEntry?: number;
  entries: TranscriptEntry[];
  /** Pass back as `before` for the page of older entries. */
  nextBefore?: number;
}

export interface TaskView {
  id: string;
  summary: string;
  kind: string;
  status: string;
  threadKey?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  detail?: string;
  links?: { url: string; label?: string }[];
}

export interface ScheduleView {
  heartbeat?: { intervalMinutes: number; enabled: boolean };
  id: string;
  /** Prompt text; empty for direct-message channels. */
  prompt: string;
  cron?: string;
  runAt?: string;
  timezone: string;
  quiet: boolean;
  reminder: boolean;
  nextRun?: string;
  lastRun?: string;
  lastError?: string;
  runCount: number;
}

export interface ScheduleRunView {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "failed";
  error?: string;
  slackOutputUrl?: string;
}

export interface ApprovalView {
  id: string;
  at: string;
  /** `requested` while open, otherwise how it was decided. */
  status: "requested" | "granted" | "denied" | "blocked" | "needs_input" | "ok" | "error" | "done" | "failed" | "interrupted";
  kind: "approval" | "post";
  title: string;
  actor: string;
  threadKey?: string;
  detail?: string;
}

export interface BlockedView {
  threadKey: string;
  reason: string;
  since?: string;
}

export interface ActivityView {
  /** `tool` or `turn` events from the timeline log, newest first. */
  id: string;
  at: string;
  kind: "turn.start" | "turn.end" | "tool" | "run.start" | "run.end";
  actor: string;
  title: string;
  status?: string;
  threadKey?: string;
  durationMs?: number;
  costUsd?: number;
  tokens?: number;
}

export type JobRunStatus = "running" | "needs_decision" | "completed" | "failed" | "aborted";
export type JobPhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface JobPhaseView {
  name: string;
  kind: "exec" | "state";
  status: JobPhaseStatus;
  /** Exit code of an exec phase, when it has one. */
  exit?: number;
  /** A short account of what happened. Absent for a direct message channel. */
  summary?: string;
}

/** One run of a job. See docs/STATE_AND_JOBS_DESIGN.md, part 2. */
export interface JobRunView {
  runId: string;
  job: string;
  status: JobRunStatus;
  /** Why it failed, was aborted, or is waiting for a decision. Absent for a direct message channel. */
  reason?: string;
  /** The phase the run is at, or absent once every phase is done. */
  currentPhase?: string;
  phases: JobPhaseView[];
  startedAt: string;
  endedAt?: string;
  by: { source: "agent" | "operator" | "intake"; threadKey?: string };
  /** The inputs the run was given. Absent for a direct message channel. */
  input?: Record<string, string>;
}

export interface TasksResponse {
  channelId: string;
  /** Job runs, newest first. Empty when the channel's store is not open. */
  jobs: JobRunView[];
  active: TaskView[];
  recent: TaskView[];
  schedules: ScheduleView[];
  scheduleRuns: ScheduleRunView[];
  approvals: ApprovalView[];
  blocked: BlockedView[];
  activity: ActivityView[];
}

export interface ToolView {
  name: string;
  group: "builtin" | "slack" | "memory" | "files" | "subagents" | "knowledge" | "schedules" | "connector" | "other";
  /** For connector tools: the connector's name. */
  connector?: string;
  execution?: { location: SandboxMode | "outside"; detail: string };
}

export interface ConnectorView {
  name: string;
  transport: string;
  /** Whether the connector's tools are present in this channel's registered tool set right now. */
  toolsLoaded: boolean;
  /** Needs the console OAuth flow completed. */
  connectable: boolean;
  /** Where to start that flow in the browser (pairing with an allowed Slack user comes next). Present only when `connectable`. */
  connectUrl?: string;
}

export interface ToolsResponse {
  channelId: string;
  threadKey?: string;
  live: boolean;
  /** Names registered with the store; when not live, the configured set. */
  tools: ToolView[];
  execution?: ExecutionEnvironment;
  /** The tool names configured for the channel (before connectors and subagents). */
  configured: string[];
  connectors: ConnectorView[];
}

export interface SkillView {
  name: string;
  source: "channel" | "collection" | "library" | "builtin";
  collection?: string;
  mode?: "ro" | "rw";
}

export interface JobDefinitionView {
  name: string;
  description?: string;
  inputs: { name: string; required: boolean; default?: string }[];
  phases: { name: string; kind: "exec" | "state" }[];
  /** False when the channel's current permissions would refuse the job; `problem` says why. */
  available: boolean;
  problem?: string;
}

export interface ExtendResponse {
  channelId: string;
  /** The jobs this channel defines. */
  jobs: JobDefinitionView[];
  skills: SkillView[];
  collections: { name: string; mode: "ro" | "rw"; skills: number }[];
  connectors: ConnectorView[];
  subagents: { name: string; model: string; description?: string }[];
  agentSet?: string;
  knowledgeBases: { name: string }[];
  knowledgeFiles: { name: string }[];
}

/** Plain JSON, as the state object holds. */
export type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };

export interface StateChangeView {
  rev: number;
  at: string;
  op: "set" | "merge" | "delete" | "append";
  /** JSON Pointer that was changed. Empty for a direct message channel, where even key names are withheld. */
  path: string;
  source: "agent" | "job" | "operator";
  threadKey?: string;
}

/**
 * The channel's shared state object (one JSON object per channel, written by `state_update`; see
 * docs/STATE_AND_JOBS_DESIGN.md). Read-only here.
 */
export interface StateResponse {
  channelId: string;
  /** False when the channel's store is not open, so the object cannot be read; `reason` says why. */
  live: boolean;
  reason?: string;
  rev: number;
  updatedAt?: string;
  updatedBy?: { source: "agent" | "job" | "operator"; threadKey?: string };
  /** Serialized size of the value, and the most it may be. */
  bytes: number;
  maxBytes: number;
  /** Absent when `redacted` or not `live`. */
  value?: StateValue;
  /** Direct message channel: revision, size and change times are shown; the value and key names are not. */
  redacted?: boolean;
  /** The most recent changes, oldest first. */
  changes: StateChangeView[];
}

export interface ArtifactView {
  /** Path inside the channel's artifacts folder, `/`-separated. */
  path: string;
  size: number;
  modified: string;
  /** Where the file is served (below the console's own prefix, safely encoded). */
  url: string;
}

/** The files a channel has published through artifact hosting. */
export interface ArtifactsResponse {
  channelId: string;
  /** False when artifact hosting is not on for this channel; `reason` says so. */
  enabled: boolean;
  reason?: string;
  entries: ArtifactView[];
  /** The listing stopped at a fixed cap. */
  truncated: boolean;
}

export type TimelineEventKind = "turn.start" | "turn.end" | "tool" | "run.start" | "run.end" | "approval.requested" | "approval.decided" | "post";
export type TimelineShape = "node" | "fork" | "merge";

/**
 * One row of the channel timeline, drawn like `git log --graph`: the channel agent is the main line (lane 0) and each subagent run
 * is a branch that forks off it and merges back with its report. `lane`, `shape`, `dead`, `fromOlder` and `through` are everything
 * needed to draw the row's graph cell: `through` are the other lanes with a line straight through this row.
 */
export interface TimelineRowView {
  id: string;
  at: string;
  kind: TimelineEventKind;
  /** `channel`, or a subagent's name. */
  actor: string;
  title: string;
  /** A bounded excerpt. Absent for a direct message channel, where the log keeps none. */
  detail?: string;
  status?: string;
  next?: string;
  durationMs?: number;
  steps?: number;
  costUsd?: number;
  tokens?: number;
  lane: number;
  shape: TimelineShape;
  /** The branch ends here without merging: it never reported and has been quiet too long to be running. */
  dead: boolean;
  /** The branch carries on from before the earliest event shown. */
  fromOlder: boolean;
  through: number[];
}

export interface TimelineResponse {
  generatedAt: string;
  /** Events read, before filtering. */
  count: number;
  /** The highest lane used, for sizing the graph cell. */
  lanes: number;
  /** Everyone in the window, for the filter; the channel agent first. */
  actors: string[];
  summary: { runs: number; byStatus: Record<string, number>; costUsd: number; tools: number };
  /** Newest first, after the `tools` and `actor` filters. */
  rows: TimelineRowView[];
}

export interface FactoryIssueView { number: number; title: string; state: string; updatedAt: string; url: string; labels?: { name: string }[] }
export interface FactoryPullRequestView { number: number; title: string; state: string; updatedAt: string; url: string; isDraft?: boolean; reviewDecision?: string | null }
export interface FactoryMergedView extends FactoryPullRequestView { mergedAt: string; author?: { login?: string } }

export interface FactoryTimelineMarkerView {
  kind: string;
  symbol: string;
  /** Full accessible description, also the tooltip. */
  label: string;
  date: string;
  /** Percent along the seven-day track. */
  position: number;
  lane: number;
  /** Only ever an https://github.com URL. */
  url?: string;
}

export interface FactoryTimelineView {
  range: string;
  note: string;
  legend: { symbol: string; label: string }[];
  axis: { left: number; iso: string; text: string }[];
  height: number;
  markers: FactoryTimelineMarkerView[];
}

export interface FactoryRepositoryView {
  repository: string;
  /** The repository could not be read (the message is safe to show). */
  error?: string;
  issues: FactoryIssueView[];
  pullRequests: FactoryPullRequestView[];
  merged: FactoryMergedView[];
  mergedError?: boolean;
  /** Absent when the snapshot's date was invalid: say "unavailable", never draw a misleading axis. */
  timeline?: FactoryTimelineView;
}

/** A software-factory channel's live, read-only GitHub view: open issues, open and merged pull requests, and seven days of activity. */
export interface FactoryResponse {
  generatedAt: string;
  name: string;
  repositories: FactoryRepositoryView[];
}

export interface MemoryFileView {
  name: string;
  scope: "channel" | "shared" | "dreams";
  bytes: number;
  modified?: string;
  /** Bounded; `truncated` says so. Absent for direct messages. */
  text?: string;
  truncated?: boolean;
  redacted?: boolean;
}

export interface MemoryResponse {
  channelId: string;
  files: MemoryFileView[];
}

/** One message on `/events`. */
export type ConsoleEvent =
  | { type: "hello"; at: string }
  /** The tree changed in some way: refetch `/tree`. */
  | { type: "tree"; at: string }
  /** A subscribed thread produced live activity. */
  | { type: "thread"; at: string; channelId: string; threadKey: string; event: ThreadLiveEvent }
  /** The server dropped events for this thread: refetch its transcript. */
  | { type: "resync"; at: string; channelId: string; threadKey: string };

export type ThreadLiveEvent =
  | { kind: "message_start" }
  | { kind: "text_delta"; delta: string }
  | { kind: "message_end" }
  | { kind: "tool_start"; callId: string; name: string }
  | { kind: "tool_end"; callId: string; name: string; isError: boolean }
  | { kind: "compaction" }
  | { kind: "retry"; attempt: number };

/**
 * Shared presentation of software-factory runs and gated task workflows. Task runs are marked kind=task, also appear in
 * non-factory channels, and use native taskStatus/results rather than factory attempts or merge actions.
 * A software-factory run (docs/FACTORY_WORKFLOW_DESIGN.md) walks one GitHub issue through the
 * stages; each stage has a status, and a stage entered again (review sends the run back to implement) keeps every attempt.
 * For a direct message channel the structure shows (stages, statuses, durations, cost) and the free text does not: issue titles,
 * summaries, reasons and risk reasons are absent.
 */
export type WorkflowStageStatus = "not_started" | "in_progress" | "success" | "failed" | "skipped";
export type WorkflowRunStatus = "running" | "waiting" | "needs_decision" | "completed" | "rejected" | "failed" | "aborted";
export type WorkflowAttemptStatus = "in_progress" | "done" | "failed" | "interrupted";
/** What a waiting run is parked on: the merge gate, a deploy approval, a review that is out of rounds, a stage that was interrupted, or one that failed. */
export type WorkflowWaitKind = "merge" | "deploy" | "rounds" | "decide" | "failed" | "info";

/** What a person can answer when a stage failed. Decisions are made in Slack or through the channel agent: the console only says which apply. */
export type WorkflowAnswer = "retry" | "skip" | "restart_from" | "abort";

/**
 * For a run whose stage failed (it waits for a person, `needs_decision`) or that ended `failed`: which stage, how many times it
 * has been tried, and what can be done. A stage that failed does not end the run: it keeps its pull request, risk and history.
 */
export interface WorkflowRecovery {
  stage: string;
  /** How many times the stage has been tried, the failed one included. */
  attempt: number;
  /** The run ended `failed` (an older run, or something unrecoverable): `retry` carries it on from this stage. */
  ended: boolean;
  answers: WorkflowAnswer[];
  /** The earlier stages `restart_from` can go back to. */
  restartFrom: string[];
}

export interface WorkflowStageSummary {
  name: string;
  kind: "agent" | "gate";
  /** The sub-agent role that handles the stage; absent for a gate. */
  role?: string;
  status: WorkflowStageStatus;
  /** Native task-step state; absent for software-factory stages. */
  taskStatus?: "ready" | "working" | "submitted" | "return_requested" | "approved";
  /** How many times the run has entered the stage. */
  entries: number;
}

export interface WorkflowRunSummary {
  /** Absent for legacy software-factory runs. Task runs have no GitHub issue, risk or cost metrics. */
  kind?: "factory" | "task";
  /** Task-flow title derived from ordered stage names; absent for DMs. */
  title?: string;
  runId: string;
  repo: string;
  issue: number;
  /** Absent for a direct message channel. */
  issueTitle?: string;
  issueUrl?: string;
  workItem?: { tracker: "jira"; site: string; key: string; url: string };
  status: WorkflowRunStatus;
  /** The stage the run is at, or was at when it ended. */
  current: string;
  /** Present while `status` is `waiting` or `needs_decision`. */
  waiting?: { kind: WorkflowWaitKind; since: string };
  /** Present when a stage failed and the run waits for a person, or the run ended failed. */
  recovery?: WorkflowRecovery;
  /** How many times review has run. */
  round: number;
  /** The review's risk score (1 to 5) and the one the merge gate used; absent until review has scored it. */
  risk: { scored: boolean; model?: number; final?: number };
  stages: WorkflowStageSummary[];
  pr?: { number: number; url?: string; merged: boolean };
  by: { source: "agent" | "operator" | "intake"; threadKey?: string };
  /** How the run began: found by intake, started by a person's tool call, or from an issue the agent filed in Slack. */
  origin: "intake" | "manual" | "slack";
  /** How many updates from the issue the run has been sent. Only trusted ones ever reach a role. */
  updates: { trusted: number; untrusted: number };
  startedAt: string;
  endedAt?: string;
  costUsd: number;
}

/** Something that changed on the run's issue after it started. The excerpt is untrusted text from GitHub: show it as text. */
export interface WorkflowUpdateView {
  kind: "comment" | "labels" | "edited" | "reopened" | "slack" | "console";
  /** The GitHub login. Absent for a direct message channel. */
  author?: string;
  association?: string;
  /** Written by an owner, member or collaborator (or the harness): the only updates a role is shown. */
  trusted: boolean;
  /** A person writing through the harness's own GitHub account, not the agent. Absent otherwise. */
  viaToken?: boolean;
  /** Absent for a direct message channel. */
  excerpt?: string;
  at: string;
}

export interface WorkflowAttemptView {
  /** Which time the run entered the stage. */
  entry: number;
  role: string;
  status: WorkflowAttemptStatus;
  /** What the report concluded (`approved`, `changes_requested`, ...). */
  verdict?: string;
  /** A short account. Absent for a direct message channel. */
  summary?: string;
  /** This attempt asked a role again for a report that was missing something. */
  reask?: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  costUsd: number;
  steps: number;
  /** The sub-agent's conversation: `#/c/<channel>/t/<runKey>` in the tree. */
  runKey?: string;
}

export interface WorkflowStageView extends WorkflowStageSummary {
  /** Current persisted task submission, bounded for display; free text absent for DMs. */
  result?: { available: boolean; summary?: string; truncated?: boolean; feedback?: string };
  attempts: WorkflowAttemptView[];
}

/** What the console can do to a run. Merge approval requires verified Slack identity; there is no direct merge action. */
export type WorkflowActionName = "retry" | "skip" | "restart_from" | "abort" | "recheck" | "answer" | "verify_approver" | "approve" | "decline";

/**
 * Why a live run is not moving and how to carry it on. Fixed words from the run's state and its workflow (stage names, a wait
 * kind): nothing from the issue, so a direct message channel gets it too.
 */
export interface WorkflowGuidance {
  /** What the run is waiting for, in a sentence. */
  summary: string;
  /** Ways to carry it on that do not need the console. */
  elsewhere: string[];
  /** What the console can do now. Absent unless the console may act. */
  actions?: WorkflowActionName[];
  /** Merge decisions require run-scoped Slack verification, independent of reviewer approval. */
  mergeVerification?: { state: "unavailable" | "unverified" | "pending" | "verified"; challenge?: string };
  /** For `restart_from`: the earlier stages it can go back to. */
  restartFrom?: string[];
}

export interface WorkflowRunView extends Omit<WorkflowRunSummary, "stages" | "risk"> {
  /** Task controls use optimistic revision checks, not factory merge/retry actions. */
  taskControl?: { revision: number; actions: ("stop" | "bump")[] };
  taskActivity?: { state: "executing" | "waiting" | "unknown" | "interrupted" | "ready" | "stopped" | "completed"; summary: string; lastAt?: string; diagnostic?: string };
  /** Why it is waiting and what carries it on. Absent for a run that ended and cannot be carried on. */
  guidance?: WorkflowGuidance;
  /** Why the run is waiting, was rejected or failed. Absent for a direct message channel. */
  reason?: string;
  stages: WorkflowStageView[];
  risk: {
    scored: boolean;
    model?: number;
    final?: number;
    /** The reviewer's one line, and what raised the score above it. Absent for a direct message channel. */
    reason?: string;
    floors?: string[];
  };
  /** What came in on the issue since the run started, oldest first, at most about twenty. */
  updatesReceived: WorkflowUpdateView[];
  /** The autonomy level this run's repository runs at, and where each number came from. */
  autonomy?: {
    level: "cautious" | "balanced" | "autonomous";
    levelFrom: "repository" | "factory" | "default";
    knobs: Record<"autoMergeMaxRisk" | "assumeAfterHours" | "reviewRounds" | "autoRetries", { value: number; source: "explicit" | "level" }>;
  };
  /** The merge rule that applies to this repository. Who may approve is a count: user ids are never sent. */
  mergeRule?: {
    /** 0: nothing merges automatically. */
    autoMergeMaxRisk: number;
    method: "squash" | "merge" | "rebase";
    approvers: { source: "factory" | "channel"; /** Absent: anyone who can speak in the channel. */ count?: number };
  };
}

/** An issue's place in issue intake: which run it is mapped to, or why it is not. */
export type IntakeStatus = "open" | "queued" | "held" | "ignored" | "closed";

export interface IntakeMappingView {
  workItem?: WorkflowRunSummary["workItem"];
  issue: number;
  /** Absent for a direct message channel. */
  title?: string;
  url?: string;
  author?: string;
  status: IntakeStatus;
  /** The run it is mapped to, for `open`. */
  runId?: string;
  /** Why it is held, queued or ignored. Absent for a direct message channel. */
  reason?: string;
  /** Why it was allowed to start (author_association, harness_filed, go_label, released, manual). */
  trust?: string;
  /** The last change of the issue intake has seen. */
  lastUpdated?: string;
}

/** Whether the labels the factory works with are in the repository: `ok` they were all there, `created` the harness made the missing ones, `failed` it could not look or create. */
export interface IntakeLabelsView {
  status: "ok" | "created" | "failed";
  checkedAt: string;
  /** The labels made by that check. */
  created: string[];
  /** Why it failed. */
  error?: string;
}

export interface IntakeRepoView {
  repo: string;
  lastPollAt?: string;
  lastOkAt?: string;
  /** Why the last poll failed, if it did. */
  lastError?: string;
  counts: Partial<Record<IntakeStatus, number>>;
  /** The last check that the factory's GitHub labels exist here. Absent before the first one. */
  labels?: IntakeLabelsView;
  /** Held and queued first, then open, then recently ignored or closed; at most 40. */
  mappings: IntakeMappingView[];
}

export interface IntakeView {
  source?: "github" | "jira";
  enabled: boolean;
  intervalSeconds?: number;
  repos: IntakeRepoView[];
}

/** What the console may do for the channel as a whole, present only when it may act and the channel is a software factory that can run the workflow. */
export interface WorkflowChannelActions {
  source?: "github" | "jira";
  /** Start a run for an issue. */
  start: boolean;
  /** Ask intake to poll now: only when intake is on. */
  poll: boolean;
  /** The factory's repositories, for the start form. */
  repositories: string[];
}

export interface WorkflowsResponse {
  channelId: string;
  actions?: WorkflowChannelActions;
  /** Runs needing a person first, then newest first. Empty when the channel's store is not open. */
  runs: WorkflowRunSummary[];
  /** Issue intake's mapping. Absent for a channel that has none and does not poll. */
  intake?: IntakeView;
}

/** The body of a console action, by name. The server refuses unknown keys. */
export type ActionBody = Record<string, never> | { stage: string } | { text: string } | { issue: string; notes?: string };

/** What an action answers: `message` is fixed words from the console, never text from the issue. */
export interface ActionResponse {
  ok: true;
  message: string;
  runId?: string;
}

export interface WorkflowRunResponse {
  channelId: string;
  run: WorkflowRunView;
}

export interface WorkspaceResponse {
  channelId: string;
  path: string;
  offset: number;
  nextOffset?: number;
  entries: { name: string; kind: "directory" | "file" | "database" | "symlink" | "other"; size: number; modified: string }[];
}

export interface DatabaseResponse {
  channelId: string;
  path: string;
  tables: string[];
  tableOffset: number;
  nextTableOffset?: number;
  table?: string;
  schema?: string;
  columns?: { name: string; type: string; notNull: boolean; primaryKey: boolean }[];
  columnsTruncated?: boolean;
  /** Display strings: at most 256 characters; blobs are size placeholders. */
  rows?: (string | null)[][];
  offset?: number;
  nextOffset?: number;
}

/** User-visible activity across permitted non-DM channels, not tool telemetry. */
export interface ActivityEntry {
  id: string;
  at: string;
  updatedAt: string;
  channel: { id: string; name?: string };
  kind: "message" | "chat" | "scheduled" | "approval" | "prompt" | "workflow";
  title: string;
  snippet: string;
  sourceUrl?: string;
  interaction: "none" | "pending" | "resolved" | "expired" | "unavailable";
}
export interface ActivityResponse {
  generatedAt: string;
  /** Current feed scope, so consumers can remove previously cached channels after configuration changes. */
  channelIds: string[];
  entries: ActivityEntry[];
  nextCursor?: string;
  /** Use as `since` after consuming all pages; changes at the boundary are deliberately replayed. */
  watermark: string;
}
