import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ConnectorConfig,
  ContextConfig,
  DelegationTargetConfig,
  ExecConfig,
  FactoryConfig,
  FactoryLifecycleSkill,
  HarnessConfig,
  ImageGenerationConfig,
  PermissionsConfig,
  RecentConversationsConfig,
  RequirementsConfig,
  SandboxConfig,
  SharedToolConfig,
  SlackProfileConfig,
  ToolName,
  WebConfig,
  WorkspaceConfig,
} from "../config/schema.ts";
import { mergeRequirements } from "../config/requirements.ts";
import { GrantStore, type Capability, type Grant } from "../agent/grants.ts";
import { autonomyWarnings, describeAutonomy, effectiveAutonomy } from "../factory/workflow/autonomy.ts";
import { ADMIN_SKILLS_DIR, availableSkillNames, BUILTIN_SKILLS_DIR, factorySkillPath, roleSkillGapMessage, roleSkillGaps } from "../agent/skills.ts";
import { isContainerMode, channelImageTag } from "../agent/sandbox.ts";
import { scopedChannelEnvironment } from "../config/secret-environment.ts";
import { expandDeepWith as expandEnvDeep, layerEnv, readEnvFile, resolveEnvPath } from "../config/envfile.ts";
import { REPO_ROOT } from "../config/load.ts";
import {
  channelPaths,
  ensureChannelDirs,
  ensureSharedDirs,
  type ChannelPaths,
  type SharedPaths,
} from "./paths.ts";
import type { ChannelRegistry } from "./registry.ts";
import {
  CONTAINER_CHANNEL_SKILLS,
  CONTAINER_GLOBAL_BIN,
  containerCollectionPath,
  resolveCollections,
  type ResolvedCollection,
} from "./collections.ts";
import { agentSetSkillsDir, approvalCapabilities, configuratorRoles, librarianRole, resolveAgentSet, type ResolvedSubagent } from "./subagents.ts";
import { openKnowledgeBase, type KnowledgeBase } from "../agent/knowledge-base.ts";
import { logger } from "../util/log.ts";
import { footerEnv } from "../factory/workflow/footer.ts";
import { installGhShim } from "../factory/workflow/gh-shim.ts";
import type { JobTable } from "../jobs/definition.ts";
import { artifactChannelUrl, consoleChannelUrl, webServerPlan } from "../artifacts/server.ts";

export interface SlackChannelRef {
  id: string;
  /** Channel name without "#", when Slack gives us one. */
  name?: string;
  isDm: boolean;
}

export interface KnowledgeFile {
  name: string;
  path: string;
  content: string;
}

export interface EnabledConnector {
  name: string;
  /** "account" = from the shared catalogue, "channel" = defined privately here. */
  origin: "account" | "channel";
  config: ConnectorConfig;
}

/**
 * One extra bind mount for this channel's container, beyond its workspace.
 * Computed once here so the sandbox, the prompt (which shows the container
 * path) and the isolation tests all read the same list.
 */
export interface ContainerMount {
  kind: "channel-skills" | "collection" | "global-bin";
  /** Absolute host path under the data directory. */
  hostPath: string;
  /** Fixed absolute path inside the container. */
  containerPath: string;
  readOnly: boolean;
  /** Collection name, for kind "collection". */
  name?: string;
}

export interface ResolvedPostAs {
  user: string;
  maxPerHour: number;
  rules?: string;
  privateLinkHosts: string[];
  reviewer: { name: string; model: string; thinkingLevel: ResolvedChannel["thinkingLevel"]; instructions: string; timeoutSeconds: number };
}

export interface ResolvedChannel {
  ref: SlackChannelRef;
  /** Key that matched in config, if any. Useful for logging. */
  configKey?: string;
  description?: string;
  paths: ChannelPaths;
  shared: SharedPaths;
  model: string;
  /** Models this channel may switch itself to. Empty = no restriction. */
  models: string[];
  /** Browser-served artifact directory and stable per-channel URL, when configured. */
  artifacts?: { directory: string; url: string };
  /** This channel's web console page, when the console is enabled. The factory page is `<url>/factory`. */
  consoleUrl?: string;
  /** Factory config, present only in explicitly enabled software-factory channels. */
  factory?: FactoryConfig;
  /** Whether the agent may schedule work in this channel. */
  schedulesEnabled: boolean;
  /** The jobs this channel's agent may run. Only what the channel's own entry lists: never inherited. */
  jobs: JobTable;
  /** Whether this channel's memory is consolidated overnight. */
  dreamsEnabled: boolean;
  /** How bash executes here, after runtime grants are applied. */
  sandbox: SandboxConfig;
  /** Which restricted command-line tools `exec` may run here. */
  exec: ExecConfig;
  /**
   * The channel's own Dockerfile, when it has one. The image named in
   * `sandbox.image` is then built from it rather than by hand.
   */
  channelDockerfile?: string;
  /** How the web tools behave here, with ${VAR} expanded against this channel's env. */
  web: WebConfig;
  /** How prompt-based AI image generation behaves here, with ${VAR} expanded against this channel's env. */
  images: ImageGenerationConfig;
  /** What may be requested at runtime, and who may approve. */
  permissions: PermissionsConfig;
  /** Whether top-level channel messages should start a turn without a mention. */
  respondToRootMessages: boolean;
  /** How much Slack history is read when a conversation starts here. */
  context: ContextConfig;
  /** Rolling one-line summaries of recently updated threads. */
  recentConversations: RecentConversationsConfig;
  /** Whether this channel exposes safe, fixed-response Slack buttons to its agent. */
  interactiveComponents: { enabled: boolean };
  /** Runtime grants currently in force. */
  grants: Grant[];
  /**
   * What the agent can usefully ask for right now: grantable, minus anything
   * already in effect. Requesting network when bash runs on the host would be
   * asking for something it already has.
   */
  requestable: Capability[];
  /**
   * Effective secrets for this channel: process env, overlaid with the global
   * env file, overlaid with the channel's own. Passed to connectors and to
   * bash; never rendered into the prompt.
   */
  env: Record<string, string>;
  /** Labels of the layers that contributed, for diagnostics. Names only. */
  envSources: string[];
  /** Variable names supplied by env files. Names only, never values. */
  envKeys: string[];
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools: ToolName[];
  preferences?: string;
  knowledge: KnowledgeFile[];
  /**
   * Knowledge bases this channel is linked to (`share.knowledgeBases`) that exist on disk: read-only wikis the channel's
   * `kb_*` tools walk. Deliberately not in `jail.readRoots`; the tools are the only way in, and they stay inside the folder.
   */
  knowledgeBases: KnowledgeBase[];
  /** Directories handed to pi as skill sources: channel-private first, then assigned collections, then built-ins. */
  skillPaths: string[];
  /** Skill collections assigned to this channel (and existing on disk), in precedence order. */
  skillCollections: ResolvedCollection[];
  /** True only for the one channel configured `admin: true`. */
  admin: boolean;
  /**
   * The operator's global bin: on PATH here after `paths.bin`, and mounted
   * read-only into every container. Never writable from any channel.
   */
  globalBin: string;
  /**
   * Extra bind mounts for this channel's container (skills, global bin). Only
   * this channel's own skills and its assigned collections ever appear here.
   */
  containerMounts: ContainerMount[];
  /**
   * Access to the cross-channel skill library. Reading is browsing a shelf;
   * publishing puts instructions on it that other channels may follow, so it
   * is a permission rather than a default.
   */
  library: { canRead: boolean; canPublish: boolean };
  /**
   * Access to the account-wide shared tool bin (`shared/bin/`).
   * `canPublish` lets this channel add, update or remove its own entries
   * there (`share.sharedToolsPublish`, or a runtime grant of
   * `sharedToolsPublish`). `execute` is this channel's own explicit
   * allowlist — which shared tool names it may run, and with what
   * argv/env/limits — keyed by name; presence here, never publication alone,
   * is what exposes a tool as `shared__<name>`.
   */
  sharedTools: { canPublish: boolean; execute: Record<string, SharedToolConfig> };
  /**
   * Access to the account's document library. Reading is browsing a shelf;
   * filing puts a document where every channel can read it, which is a
   * disclosure decision rather than a default one — but a default of "no"
   * would mean an attachment can never be kept, so both are on unless a
   * channel turns them off.
   */
  documents: { canRead: boolean; canAdd: boolean };
  /**
   * Channel assistants this channel may hand work to. The target resolves in
   * Slack, so names are convenience; IDs are the durable option.
   */
  delegation: { targets: DelegationTargetConfig[] };
  /**
   * Other channels this channel may publish to with `post_to_channel`. The
   * only channels the tool can reach; IDs are the durable option.
   */
  postTo: { targets: DelegationTargetConfig[] };
  /** Present only when this channel's own entry sets `share.postAs`; never inherited from defaults. */
  postAs?: ResolvedPostAs;
  /** Host-only opt-in for one user's Slack profile; never inherited. */
  slackProfile?: SlackProfileConfig;
  /**
   * Account-wide notification batching. Any channel can submit; only the
   * configured notification channel can collect the pending batch.
   */
  notifications: {
    enabled: boolean;
    channel: string;
    canCollect: boolean;
    maxPending: number;
    maxMessageChars: number;
  };
  /**
   * Whether this is the channel the feedback digest goes to. That channel is
   * the operator's view of the whole account, so it — and only it — may read
   * what every channel has filed. Nobody may write there through the jail.
   */
  feedback: { isReviewer: boolean };
  connectors: EnabledConnector[];
  /** Subagents this channel's agent may run (its agent set's roles, plus the librarian when it has a knowledge base), already narrowed to what the channel holds. */
  agents: ResolvedSubagent[];
  /** Name of the agent set `agents` came from. */
  agentSet?: string;
  memory: {
    channelFile: string;
    sharedFile?: string;
    canWriteShared: boolean;
    /** Other channels' memory files this channel may read. */
    foreignFiles: { channel: string; path: string }[];
  };
  /** Filesystem jail. Absolute paths. */
  jail: { readRoots: string[]; writeRoots: string[]; workspaceSymlinkRoots: string[] };
  requires: RequirementsConfig;
  allowUsers?: string[];
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .sort();
}

/**
 * Look up a channel's config by Slack ID first, then by name. IDs win because
 * they survive a channel rename; names are there because humans write configs.
 */
function findChannelConfig(config: HarnessConfig, ref: SlackChannelRef) {
  if (config.channels[ref.id]) return { key: ref.id, entry: config.channels[ref.id]! };
  if (ref.name) {
    const byName = config.channels[ref.name] ?? config.channels[`#${ref.name}`];
    if (byName) return { key: ref.name, entry: byName };
  }
  return undefined;
}

export interface ResolveResult {
  channel?: ResolvedChannel;
  /** Set when the channel is not configured and unconfigured channels are disallowed. */
  rejected?: string;
}

/**
 * Fill in a channel's name from the registry when the caller does not know it.
 *
 * Work that starts without a Slack event behind it — a scheduled task firing,
 * the overnight pass, a turn resumed after a grant — has only a channel id.
 * Without the name, a config entry keyed by name (which is how humans write
 * them) is missed, and the channel silently resolves to the account defaults:
 * no bash, no channel env file, none of its connectors. That is the same
 * channel with a different agent in it, and the only sign is the work coming
 * back wrong. The registry survives restarts precisely so this does not have
 * to depend on what the process happens to have seen since it started.
 */
function withKnownName(ref: SlackChannelRef, registry: ChannelRegistry): SlackChannelRef {
  if (ref.name || ref.isDm) return ref;
  const name = registry.nameFor(ref.id);
  return name ? { ...ref, name } : ref;
}

export function resolveChannel(
  config: HarnessConfig,
  dataDir: string,
  input: SlackChannelRef,
  registry: ChannelRegistry,
): ResolveResult {
  const ref = withKnownName(input, registry);
  registry.record(ref);
  const found = findChannelConfig(config, ref);

  if (!found && !config.allowUnconfiguredChannels) {
    return { rejected: `Channel ${ref.name ?? ref.id} is not configured and unconfigured channels are disabled.` };
  }
  if (ref.isDm && !config.allowDirectMessages) {
    return { rejected: "Direct messages are disabled for this harness." };
  }

  const defaults = config.defaults;
  const server = webServerPlan(config);
  const entry = found?.entry;
  const share = entry?.share ?? defaults.share;

  // Recheck the effective policy, not just YAML validation: callers may hold
  // a mutated config. These routes spawn on the host regardless of sandbox
  // mode; refuse them unless the operator explicitly accepts the same-user
  // risk, even with absolute commands or hash-pinned shared scripts.
  // Reject before resolving any secret imports.
  if (config.keychain && config.keychain.acceptHostExecutionRisk !== true) {
    if ((entry?.tools ?? defaults.tools).includes("exec")) {
      throw new Error("Keychain forbids host CLI execution (exec); use bash inside docker, macos-container or kiri instead.");
    }
    if (Object.keys(share.sharedTools).length > 0) {
      throw new Error("Keychain forbids host shared-tool execution (share.sharedTools), including hash-pinned scripts; use container bash instead.");
    }
  }

  const shared = ensureSharedDirs(dataDir, config.documentsDir === undefined ? undefined : resolve(REPO_ROOT, config.documentsDir));
  const paths = ensureChannelDirs(dataDir, ref.id);

  // --- Knowledge: the one thing shared by default -------------------------
  const knowledge: KnowledgeFile[] = [];
  if (share.knowledge !== false) {
    const wanted =
      share.knowledge === true
        ? listMarkdown(shared.knowledge)
        : share.knowledge.map((n) => (n.toLowerCase().endsWith(".md") ? n : `${n}.md`));
    for (const name of wanted) {
      const path = join(shared.knowledge, name);
      if (!existsSync(path)) continue;
      knowledge.push({ name, path, content: readFileSync(path, "utf-8") });
    }
  }

  // --- Skills: channel-private always, collections only when assigned -----
  // The channel's own directory is handed over whole rather than as one path
  // per skill: pi discovers skills beneath it recursively, so a skill the
  // agent writes mid-conversation is picked up by a reload instead of needing
  // the channel to be resolved again. It goes first, so a channel's own
  // version of a skill wins over a shared one of the same name.
  const skillPaths: string[] = [paths.skills];
  // Collections are handed over whole too (so a skill written into an rw
  // collection is live on reload), but ONLY the assigned ones: an unassigned
  // collection is never a path, a read root or a mount. Order = config order,
  // so a name collision between collections is decided by the operator.
  const skillCollections = resolveCollections(
    share.skillCollections,
    shared.skills,
    ref.name ?? ref.id,
  );
  for (const collection of skillCollections) skillPaths.push(collection.dir);
  // The harness's own skills come last, so anything a channel or the operator
  // named wins over them. Not opt-in: a channel that has never been configured
  // still writes skills from its first day, and these are what it needs to
  // write them well.
  if (existsSync(BUILTIN_SKILLS_DIR)) skillPaths.push(BUILTIN_SKILLS_DIR);
  // How to administer the installation reaches the admin channel automatically, and no other channel at all.
  if (entry?.admin === true && existsSync(ADMIN_SKILLS_DIR)) skillPaths.push(ADMIN_SKILLS_DIR);
  // Factory skills are shipped and reviewed with the harness, never downloaded.
  // They follow built-ins so a channel's own skill of the same name customises it.
  for (const lifecycle of entry?.factory?.lifecycleSkills ?? []) {
    const path = factorySkillPath(lifecycle as FactoryLifecycleSkill);
    if (existsSync(path)) skillPaths.push(path);
  }

  // An agent set ships skills for how its roles work together (e.g. the software factory's pipeline). They
  // come after the channel's own and its collections, so a channel can still override any of them by name.
  if (entry?.agentSet) {
    const dir = agentSetSkillsDir(entry.agentSet);
    if (existsSync(dir)) skillPaths.push(dir);
  }

  // --- Secrets: process env < global env file < channel env file ----------
  // Resolved here so a channel's token can shadow a global one of the same
  // name, and so one channel's secrets never reach another's connectors.
  const channelEnvPath = entry?.envFile
    ? resolveEnvPath(entry.envFile, REPO_ROOT)
    : join(paths.root, "env");
  const layeredEnv = layerEnv([
    {
      label: "process environment",
      values: process.env as Record<string, string>,
      ambient: true,
    },
    ...(config.envFile
      ? [{ label: config.envFile, values: readEnvFile(resolveEnvPath(config.envFile, REPO_ROOT)) }]
      : []),
    { label: entry?.envFile ?? `channels/${ref.id}/env`, values: readEnvFile(channelEnvPath) },
  ]);
  const runtimeEnv: Record<string, string> = {
    HARNESS_CHANNEL_ID: ref.id,
    HARNESS_CHANNEL_ROOT: paths.root,
    HARNESS_CHANNEL_WORKSPACE: paths.workspace,
    HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS: paths.attachmentText,
    HARNESS_CHANNEL_ARTIFACTS: paths.artifacts,
    ...(server.artifacts && server.baseUrl
      ? { HARNESS_CHANNEL_ARTIFACT_URL: artifactChannelUrl(server.baseUrl, ref.id) }
      : {}),
    HARNESS_CHANNEL_NAME: ref.name ?? "",
    // A factory channel's agent writes to GitHub through the operator's token, so everything it writes there carries a footer.
    // The `gh` in the global bin adds it from these (a role's own session overrides them with its run and stage).
    ...(entry?.factory ? footerEnv() : {}),
  };
  if (entry?.factory) installGhShim(shared.globalBin);

  // Runtime values are facts from the harness, not user/operator secrets. They
  // are overlaid last so an env file cannot spoof another channel's paths.
  const scopedEnv = scopedChannelEnvironment(config, ref.id, layeredEnv.bundle, dataDir);
  const env = { ...scopedEnv, ...runtimeEnv };
  const baoKeys = [...(config.openbao?.globalChannel ?? []), ...(config.openbao?.channels[ref.id] ?? [])];
  const keychainKeys = [...(config.keychain?.globalChannel ?? []), ...(config.keychain?.channels[ref.id] ?? [])];
  const importedKeys = [...baoKeys, ...keychainKeys];
  const envSources = [...layeredEnv.sources, ...(baoKeys.length ? ["OpenBao channel imports"] : []), ...(keychainKeys.length ? ["macOS Keychain channel imports"] : [])];
  const envKeys = [...new Set([...layeredEnv.fileKeys.filter((name) => Object.hasOwn(scopedEnv, name)), ...importedKeys])].sort();
  const hasScopedSecrets = Boolean(config.openbao || config.keychain);
  const expandDeepWith = <T>(value: T, bundle: Record<string, string>, context: string): T =>
    expandEnvDeep(value, bundle, context, !hasScopedSecrets);
  // Either backend may supply child env, never process argv or model-visible metadata.
  // Fixed CLI argv is also included in the model's tool descriptions.
  const safeArgv = (value: string | string[]): void => {
    if (!hasScopedSecrets) return;
    const strings = Array.isArray(value) ? value : [value];
    if (strings.some((arg) => importedKeys.some((name) => env[name] && arg.includes(env[name]!)))) {
      throw new Error("Scoped secrets cannot be used in subprocess commands or arguments; use environment variables instead.");
    }
  };

  // --- Runtime grants ------------------------------------------------------
  // Applied on top of config, never beyond `permissions.grantable`, so a grant
  // can only widen something the operator already agreed could be widened.
  // Merge, don't replace: a channel setting one key keeps the account defaults
  // for the rest.
  const permissions: PermissionsConfig = { ...defaults.permissions, ...(entry?.permissions ?? {}) };
  const context: ContextConfig = { ...defaults.context, ...(entry?.context ?? {}) };
  const recentConversations: RecentConversationsConfig = {
    ...defaults.recentConversations,
    ...(entry?.recentConversations ?? {}),
  };
  const interactiveComponents = {
    enabled: entry?.interactiveComponents?.enabled ?? defaults.interactiveComponents.enabled,
  };
  const grants = new GrantStore(dataDir)
    .active(ref.id)
    .filter((g) => permissions.grantable.includes(g.capability));
  const granted = (c: string) => grants.some((g) => g.capability === c);

  const configured: SandboxConfig = { ...defaults.sandbox, ...(entry?.sandbox ?? {}) };
  // A channel may replace the default target list to narrow access; lists are
  // intentionally not merged, because every inherited root is a capability.
  const workspace: WorkspaceConfig = { ...defaults.workspace, ...(entry?.workspace ?? {}) };

  // A Dockerfile in the channel's directory is the most specific statement
  // anyone has made about what this channel's shell runs in, so it wins over a
  // configured image. It is built on first use, under a tag derived from the
  // channel id.
  const channelDockerfile =
    isContainerMode(configured.mode) && existsSync(paths.dockerfile) ? paths.dockerfile : undefined;
  const baseSandbox: SandboxConfig = channelDockerfile
    ? { ...configured, image: channelImageTag(ref.id) }
    : configured;

  const effectiveSandbox: SandboxConfig = granted("network")
    ? { ...baseSandbox, network: "bridge" }
    : baseSandbox;

  // Account-wide CLI definitions are inert until this particular channel
  // names them in exec.shared. They are then resolved with this channel's
  // environment (so registry env references can use channel-local secrets),
  // alongside the existing local/default exec commands.
  const selectedSharedCliTools = Object.fromEntries(
    (entry?.exec?.shared ?? []).map((name) => [name, config.cliTools[name]!]),
  );
  const mergedExec: ExecConfig = {
    commands: {
      ...defaults.exec.commands,
      ...selectedSharedCliTools,
      ...(entry?.exec?.commands ?? {}),
    },
    shared: [],
  };
  const exec: ExecConfig = !hasScopedSecrets ? expandDeepWith(mergedExec, env, `exec commands for ${ref.name ?? ref.id}`) : {
    ...mergedExec,
    commands: Object.fromEntries(Object.entries(mergedExec.commands).map(([name, command]) => {
      const execution = expandDeepWith({ command: command.command, args: command.args, env: command.env }, env, "exec command environment");
      safeArgv(execution.command); safeArgv(execution.args);
      return [name, { ...command, ...execution }];
    })),
  };

  // --- Shared tool bin: publishing is a permission, running is a per-channel
  // allowlist. Unlike `share`'s other fields, this one is never merged with
  // the account defaults — same as delegateTo above — because
  // "this channel may run tool X" has to be a decision about this channel,
  // not something it inherits by not saying otherwise.
  const sharedToolsExecute: Record<string, SharedToolConfig> = !hasScopedSecrets
    ? expandDeepWith(share.sharedTools, env, `shared tools for ${ref.name ?? ref.id}`)
    : Object.fromEntries(
    Object.entries(share.sharedTools).map(([name, policy]) => [name, {
      ...policy, env: expandDeepWith(policy.env, env, "shared tool environment"),
    }]),
  );

  // Web settings merge a level deeper than the others, because `search` is a
  // block a channel should be able to change one key of — pointing one channel
  // at a different provider should not clear the account's API key.
  const mergedWeb: WebConfig = {
    ...defaults.web,
    ...(entry?.web ?? {}),
    search: { ...defaults.web.search, ...(entry?.web?.search ?? {}) },
  };
  let web: WebConfig;
  try {
    web = expandDeepWith(mergedWeb, env, `web settings for ${ref.name ?? ref.id}`);
  } catch (err) {
    // An account-wide search key that this channel's environment does not
    // supply costs the channel its search, not its ability to answer at all —
    // unlike a connector, where failing loudly is the only honest option
    // because the tools would otherwise be silently absent.
    web = { ...mergedWeb, search: { ...mergedWeb.search, provider: "none", apiKey: "" } };
    logger.warn(
      `search disabled in ${ref.name ?? ref.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const mergedImages: ImageGenerationConfig = {
    ...defaults.images,
    ...(entry?.images ?? {}),
  };
  let images: ImageGenerationConfig;
  try {
    images = expandDeepWith(mergedImages, env, `image generation settings for ${ref.name ?? ref.id}`);
  } catch (err) {
    // A missing image API key should remove this optional paid capability, not
    // make the channel unusable. The tool is simply absent until configured.
    images = { ...mergedImages, provider: "none", apiKey: "" };
    logger.warn(
      `image generation disabled in ${ref.name ?? ref.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A channel's tools are its configured list plus anything granted at runtime.
  const baseTools = entry?.tools ?? defaults.tools;
  const effectiveTools: ToolName[] = [
    ...baseTools,
    ...(["bash", "web"] as const).filter((t) => granted(t) && !baseTools.includes(t)),
  ];

  if (config.openbao && config.openbao.acceptHostExecutionRisk !== true && effectiveTools.includes("bash") && effectiveSandbox.mode === "host") {
    throw new Error("OpenBao requires container isolation for bash, including runtime grants. Strict mode is active unless the operator sets openbao.acceptHostExecutionRisk: true on the host.");
  }
  if (config.openbao && config.openbao.acceptHostExecutionRisk !== true && (effectiveTools.includes("exec") || Object.keys(sharedToolsExecute).length)) {
    throw new Error("OpenBao forbids host CLI and shared-tool execution. Strict mode is active unless the operator sets openbao.acceptHostExecutionRisk: true on the host.");
  }
  if (config.keychain && config.keychain.acceptHostExecutionRisk !== true && effectiveTools.includes("bash") && effectiveSandbox.mode === "host") {
    throw new Error("Keychain requires container isolation for bash, including runtime grants.");
  }

  // --- Connectors: catalogue is account-wide, enablement is per channel ----
  // ${VAR} placeholders are expanded now, against this channel's bundle.
  const connectors: EnabledConnector[] = [];
  const expandConnector = (name: string, cfg: ConnectorConfig): ConnectorConfig => {
    if (!hasScopedSecrets) return expandDeepWith(cfg, env, `Connector "${name}" in ${ref.name ?? ref.id}`);
    const { description, ...execution } = cfg;
    const result = { ...expandDeepWith(execution, env, "Connector environment"), ...(description !== undefined ? { description } : {}) } as ConnectorConfig;
    if (result.transport === "stdio") { safeArgv(result.command); safeArgv(result.args); }
    return result;
  };

  for (const name of share.connectors) {
    const cfg = config.connectors[name];
    if (cfg) connectors.push({ name, origin: "account", config: expandConnector(name, cfg) });
  }
  for (const [name, cfg] of Object.entries(entry?.connectors ?? {})) {
    connectors.push({ name, origin: "channel", config: expandConnector(name, cfg) });
  }

  const knowledgeBases = share.knowledgeBases.flatMap((name): KnowledgeBase[] => {
    const declared = config.knowledgeBases[name];
    if (!declared) return []; // config validation rejects this; a hand-built config must not take the channel down
    const opened = openKnowledgeBase(name, declared, REPO_ROOT, ref.name ?? ref.id);
    return opened ? [opened] : [];
  });

  const agentSet = resolveAgentSet({
    config,
    entry,
    channelTools: effectiveTools,
    channelConnectors: connectors.map((connector) => connector.name),
    channelModel: entry?.model ?? defaults.model,
    channelThinking: entry?.thinkingLevel ?? defaults.thinkingLevel,
    channelLabel: ref.name ?? ref.id,
  });

  let postAs: ResolvedPostAs | undefined;
  const postAsConfig = entry?.share?.postAs;
  if (postAsConfig) {
    const role = entry?.agentSet ? config.agentSets[entry.agentSet]?.agents[postAsConfig.reviewer] : undefined;
    if (role) {
      postAs = {
        user: postAsConfig.user,
        maxPerHour: postAsConfig.maxPerHour,
        ...(postAsConfig.rules !== undefined ? { rules: postAsConfig.rules } : {}),
        privateLinkHosts: postAsConfig.privateLinkHosts,
        reviewer: {
          name: postAsConfig.reviewer,
          model: role.model ?? entry?.model ?? defaults.model,
          thinkingLevel: role.thinkingLevel ?? entry?.thinkingLevel ?? defaults.thinkingLevel,
          instructions: role.instructions ?? "",
          timeoutSeconds: role.timeoutSeconds,
        },
      };
    } else {
      // Config validation rejects this; a hand-built config must not take the channel down, and must not post.
      logger.warn(`${ref.name ?? ref.id}: share.postAs names a reviewer that is not in the agent set; post_as_user is off`);
    }
  }

  // --- Memory -------------------------------------------------------------
  const foreignFiles: { channel: string; path: string }[] = [];
  for (const other of share.channelMemoryRead) {
    const otherId = registry.resolveId(other);
    if (!otherId || otherId === ref.id) continue;
    const file = channelPaths(dataDir, otherId).memoryFile;
    if (existsSync(file)) foreignFiles.push({ channel: other, path: file });
  }

  // --- Jail ---------------------------------------------------------------
  // Writable: only this channel's own workspace and memory. Readable: adds the
  // knowledge/skills it was granted, plus any foreign memory explicitly shared.
  const writeRoots = [paths.workspace, paths.memory];
  const readRoots = [...writeRoots, paths.skills];
  if (knowledge.length > 0) readRoots.push(shared.knowledge);
  // Collections are readable but never in writeRoots: a write to one goes
  // through the skill tools, which check the mode and log who wrote what.
  for (const collection of skillCollections) readRoots.push(collection.dir);
  // The global bin is readable so the agent can see what is installed; it is
  // the operator's, so never writable.
  readRoots.push(shared.globalBin);
  // Readable so the agent can go back over a built-in skill it has already
  // been shown; never writable, because these are the harness's, reviewed in
  // git. A channel that wants a different version writes its own by that name.
  if (existsSync(BUILTIN_SKILLS_DIR)) readRoots.push(BUILTIN_SKILLS_DIR);
  if (entry?.admin === true && existsSync(ADMIN_SKILLS_DIR)) readRoots.push(ADMIN_SKILLS_DIR);
  for (const lifecycle of entry?.factory?.lifecycleSkills ?? []) {
    const path = factorySkillPath(lifecycle as FactoryLifecycleSkill);
    if (existsSync(path)) readRoots.push(path);
  }
  // The agent set's own skills, shipped with the harness: readable so a subagent can open them, never writable.
  if (entry?.agentSet) {
    const dir = agentSetSkillsDir(entry.agentSet);
    if (existsSync(dir)) readRoots.push(dir);
  }
  // Readable, never writable: publishing goes through the tool, which checks
  // the permission and records who published what. A `write` pointed at the
  // library would be a way around both.
  if (share.library) readRoots.push(shared.library);
  // Same shape as the library, for the same reason: a channel may read the
  // shelf with its file tools, but filing goes through `add_document`, which
  // is what stamps the channel on the entry and keeps the original honest. A
  // `write` pointed here would be a way around both.
  if (share.documents) readRoots.push(shared.documents);
  // The feedback log is written only through `report_limitation`, from every
  // channel, and read by none of them — except the channel the digest goes to,
  // which is where an operator reviews it and where an agent can be asked to
  // turn it into a backlog. Read only, even there: a channel that could edit
  // the log could erase what another channel filed.
  const configuredNotificationChannel = config.notifications.channel.trim();
  const notificationChannelId = configuredNotificationChannel
    ? registry.resolveId(configuredNotificationChannel)
    : undefined;
  const notificationKey = configuredNotificationChannel.startsWith("#")
    ? configuredNotificationChannel.slice(1)
    : configuredNotificationChannel;
  const isNotificationCollector =
    config.notifications.enabled &&
    Boolean(configuredNotificationChannel) &&
    (notificationChannelId === ref.id || notificationKey === ref.id || notificationKey === ref.name);

  const digestChannelId = config.feedback.digestChannel
    ? registry.resolveId(config.feedback.digestChannel)
    : undefined;
  const isFeedbackReviewer = digestChannelId !== undefined && digestChannelId === ref.id;
  if (isFeedbackReviewer) readRoots.push(shared.feedback);
  if (share.memoryRead) readRoots.push(shared.memory);
  if (share.memoryWrite) writeRoots.push(shared.memory);
  for (const f of foreignFiles) readRoots.push(f.path);

  // Already-in-effect capabilities are not worth asking about.
  const alreadyHave = (c: string): boolean => {
    if (c === "network") {
      // On the host a shell always has network, so the grant would be a no-op.
      // Only meaningful where there is a shell at all: a channel with no bash
      // gains nothing from the sandbox being online, and should be offered
      // `web` instead.
      if (!effectiveTools.includes("bash")) return true;
      return effectiveSandbox.mode === "host" || effectiveSandbox.network === "bridge";
    }
    if (c === "web") return effectiveTools.includes("web");
    if (c === "bash") return effectiveTools.includes("bash");
    if (c === "memoryWrite") return share.memoryWrite || granted("memoryWrite");
    if (c === "skillPublish") return share.libraryPublish || granted("skillPublish");
    if (c === "sharedToolsPublish") return share.sharedToolsPublish || granted("sharedToolsPublish");
    if (c.startsWith("connector:")) {
      return share.connectors.includes(c.slice("connector:".length));
    }
    if (c.startsWith("subagent:")) return granted(c as Capability);
    return false;
  };
  // A role the agent set marks as needing approval is requestable here without being listed in `grantable`: the
  // set is the operator's own config, and it is what says the role must be approved.
  const requestable = [...new Set([...permissions.grantable, ...approvalCapabilities(config, entry)])]
    .filter((c) => !alreadyHave(c)) as Capability[];

  // --- Container mounts ------------------------------------------------------
  // Fixed in-container paths. Channel skills are read-only in the container
  // for the same reason they are outside the file-tool write roots: they are
  // written through save_skill, which validates them.
  const containerMounts: ContainerMount[] = [
    { kind: "channel-skills", hostPath: paths.skills, containerPath: CONTAINER_CHANNEL_SKILLS, readOnly: true },
    ...skillCollections.map((c): ContainerMount => ({
      kind: "collection",
      name: c.name,
      hostPath: c.dir,
      containerPath: containerCollectionPath(c.name),
      readOnly: c.mode !== "rw",
    })),
    { kind: "global-bin", hostPath: shared.globalBin, containerPath: CONTAINER_GLOBAL_BIN, readOnly: true },
  ];

  const channel: ResolvedChannel = {
    ref,
    ...(found ? { configKey: found.key } : {}),
    ...(entry?.description ? { description: entry.description } : {}),
    paths,
    shared,
    ...(entry?.factory ? { factory: entry.factory } : {}),
    ...(server.artifacts && server.baseUrl
      ? { artifacts: { directory: paths.artifacts, url: artifactChannelUrl(server.baseUrl, ref.id) } }
      : {}),
    ...(server.console && server.baseUrl ? { consoleUrl: consoleChannelUrl(server.baseUrl, ref.id) } : {}),
    model: entry?.model ?? defaults.model,
    models: entry?.models ?? defaults.models,
    schedulesEnabled: entry?.schedules ?? config.schedules.enabled,
    jobs: entry?.jobs ?? {},
    dreamsEnabled: entry?.dreams ?? config.dreams.enabled,
    sandbox: effectiveSandbox,
    ...(channelDockerfile ? { channelDockerfile } : {}),
    exec,
    web,
    images,
    permissions,
    respondToRootMessages: entry?.respondToRootMessages ?? false,
    context,
    recentConversations,
    interactiveComponents,
    grants,
    requestable,
    env,
    envSources,
    envKeys,
    thinkingLevel: entry?.thinkingLevel ?? defaults.thinkingLevel,
    tools: effectiveTools,
    ...(entry?.preferences ?? defaults.preferences
      ? { preferences: [defaults.preferences, entry?.preferences].filter(Boolean).join("\n\n") }
      : {}),
    knowledge,
    knowledgeBases,
    skillPaths,
    skillCollections,
    admin: entry?.admin === true,
    globalBin: shared.globalBin,
    containerMounts,
    library: {
      canRead: share.library,
      canPublish: share.libraryPublish || granted("skillPublish"),
    },
    sharedTools: {
      canPublish: share.sharedToolsPublish || granted("sharedToolsPublish"),
      execute: sharedToolsExecute,
    },
    documents: { canRead: share.documents, canAdd: share.documentsAdd },
    delegation: { targets: share.delegateTo },
    postTo: { targets: share.postTo },
    ...(postAs ? { postAs } : {}),
    ...(entry?.slackProfile ? { slackProfile: { ...entry.slackProfile } } : {}),
    notifications: {
      enabled: config.notifications.enabled,
      channel: configuredNotificationChannel,
      canCollect: isNotificationCollector,
      maxPending: config.notifications.maxPending,
      maxMessageChars: config.notifications.maxMessageChars,
    },
    feedback: { isReviewer: isFeedbackReviewer },
    connectors,
    agents: [
      ...(agentSet?.agents ?? []),
      ...configuratorRoles(entry, entry?.model ?? defaults.model, entry?.thinkingLevel ?? defaults.thinkingLevel),
      // Not part of an agent set: any channel with a knowledge base gets the librarian (a set may not define a role of that name).
      ...(knowledgeBases.length > 0
        ? [librarianRole(config.librarian, entry?.model ?? defaults.model, entry?.thinkingLevel ?? defaults.thinkingLevel)]
        : []),
    ],
    ...(agentSet ? { agentSet: agentSet.name } : {}),
    memory: {
      channelFile: paths.memoryFile,
      ...(share.memoryRead || share.memoryWrite ? { sharedFile: shared.memoryFile } : {}),
      canWriteShared: share.memoryWrite || granted("memoryWrite"),
      foreignFiles,
    },
    jail: { readRoots, writeRoots, workspaceSymlinkRoots: workspace.symlinkTargets },
    requires: mergeRequirements(config.requires, entry?.requires ?? { binaries: [], env: [], onMissing: "fail" }),
    ...(entry?.allowUsers ?? defaults.allowUsers
      ? { allowUsers: entry?.allowUsers ?? defaults.allowUsers }
      : {}),
  };

  warnOnRoleSkillGaps(channel, entry?.agentSet);
  announceFactoryAutonomy(channel);
  return { channel };
}

const warnedSkillGaps = new Set<string>();
const announcedAutonomy = new Map<string, string>();

/**
 * Say, when the config loads, how much each repository of a factory may do without a person (the level and each number, whichever
 * way it was set) and any explicit setting that beats a stricter level. Said again only when it changes, so a reload that did not
 * touch it is quiet.
 */
function announceFactoryAutonomy(channel: ResolvedChannel): void {
  const factory = channel.factory;
  if (!factory) { announcedAutonomy.delete(channel.ref.id); return; }
  const lines = factory.repositories.map((repo) => `${repo}: ${describeAutonomy(effectiveAutonomy(factory, repo))}`);
  const warnings = autonomyWarnings(factory, factory.repositories);
  const key = [...lines, ...warnings].join("\n");
  if (announcedAutonomy.get(channel.ref.id) === key) return;
  announcedAutonomy.set(channel.ref.id, key);
  const name = channel.ref.name ?? channel.ref.id;
  for (const line of lines) logger.info(`${name}: factory autonomy: ${line}`);
  for (const warning of warnings) logger.warn(`${name}: ${warning}`);
}

/**
 * Shipped agent-set skills reach a channel only through an agent set named like their folder. A set called something else loads
 * none, and its roles then name skills they cannot read, which shows up much later as a role that "blocked" (a deployer, say). Say
 * so once, here, where the operator reads the log when the config loads. Only looked into when the set has no shipped folder, so a
 * correctly named set costs one `existsSync`.
 */
function warnOnRoleSkillGaps(channel: ResolvedChannel, agentSet: string | undefined): void {
  if (!agentSet || channel.agents.length === 0 || existsSync(agentSetSkillsDir(agentSet))) return;
  const key = `${channel.ref.id}:${agentSet}`;
  if (warnedSkillGaps.has(key)) return;
  warnedSkillGaps.add(key);
  const gaps = roleSkillGaps(channel, availableSkillNames(channel));
  if (gaps.length > 0) logger.warn(`${channel.ref.name ?? channel.ref.id}: ${roleSkillGapMessage(channel, gaps)}`);
}
