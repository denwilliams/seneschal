import { isAbsolute } from "node:path";
import { z } from "zod";
import { CloudflareAccessSchema } from "./cloudflare-access-schema.ts";
import { KeychainSchema } from "./keychain-schema.ts";
import { keychainIsolationIssues } from "./keychain-policy.ts";
import { JobTableSchema } from "../jobs/definition.ts";
import { OpenBaoSchema } from "./openbao-schema.ts";
import { openBaoIsolationIssues } from "./openbao-policy.ts";

/**
 * Isolation model
 * ---------------
 * A channel is isolated by default. Its memory, skills, connectors, tools, files
 * and preferences are its own, and nothing crosses a channel boundary unless the
 * config says so explicitly.
 *
 * The single deliberate exception is account knowledge: a small shared brain
 * (`shared/knowledge`) that every channel reads unless it opts out. That is the
 * "shared across the account" half of the requirement; everything else is
 * opt-in via `share:`.
 */

export const ToolNameSchema = z.enum([
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
  // First-class structured SQLite database inspection and querying.
  "sqlite",
  // First-class deterministic PNG charts, so channels without bash can still
  // turn structured data into a chart file.
  "charts",
  // Markdown-to-HTML slide decks, generated as one self-contained attachment.
  "slides",
  // First-class workspace file management without a shell: mkdir, move/rename, copy and delete.
  "file_ops",
  "bash",
  // Not a pi built-in: "exec" exposes configured command-line tools through
  // a restricted runner: no shell, no pipes, and only argv patterns the
  // operator named for this channel.
  "exec",
  // Not a pi built-in: "web" switches on the harness's own `fetch_url` and
  // `search_web`. It sits in the same list because from a channel's point of
  // view it is the same decision — what this channel can do.
  "web",
  // Not a pi built-in: search Slack using the current speaker's stored user token.
  "slack",
  // Prompt-based AI image generation through a configured provider.
  "images",
], {
  // `herdr` (delegating coding tasks to a worker in a Herdr pane) was removed. Say so, rather than printing a list of
  // valid names, to anyone whose config still has it.
  error: (issue) =>
    issue.input === "herdr"
      ? 'the "herdr" tool was removed along with Herdr worker delegation (delegate_task). Delete it from `tools`, and `herdrRepos` / `herdr` / `share.herdrRepos` if present.'
      : undefined,
});
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

const HttpConnectorOAuthSchema = z.object({
  /** OAuth client id for a pre-registered MCP client. Omit only when the server supports dynamic registration. */
  clientId: z.string().optional(),
  /** OAuth client secret, when the server issued one. Values may use ${ENV_VAR}. */
  clientSecret: z.string().optional(),
  /** Redirect URI registered with the OAuth server. This can be the static manual-completion page. */
  redirectUrl: z.string().url(),
  /** Opt in to Slack/browser pairing with the configured web console callback. redirectUrl must match it exactly. */
  consoleCallback: z.boolean().optional(),
  /** Lifetime for the one-time PKCE/state session used by manual Slack completion. */
  manualCompletionTtlSeconds: z.number().int().min(60).max(3600).default(600),
  /** Optional OAuth scope override. Omit to let the MCP server advertise its required scopes. */
  scope: z.string().optional(),
  /** Optional file for tokens/verifiers. Relative paths resolve from the repo root; default is channel-private state. */
  tokenFile: z.string().optional(),
  clientName: z.string().optional(),
  tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post", "none"]).optional(),
  resourceMetadataUrl: z.string().url().optional(),
});
export type HttpConnectorOAuthConfig = z.infer<typeof HttpConnectorOAuthSchema>;

/** An MCP server definition. Defining one does NOT enable it anywhere. */
export const ConnectorSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    description: z.string().optional(),
    command: z.string(),
    args: z.array(z.string()).default([]),
    /** Values may use ${ENV_VAR}, expanded against the channel env and harness runtime vars. */
    env: z.record(z.string(), z.string()).default({}),
    /** Restrict which of the server's tools are exposed. Omit to expose all. */
    allowTools: z.array(z.string()).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    description: z.string().optional(),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    /** OAuth for remote MCP servers. Token state is per channel. */
    oauth: HttpConnectorOAuthSchema.optional(),
    allowTools: z.array(z.string()).optional(),
  }),
]);
export type ConnectorConfig = z.infer<typeof ConnectorSchema>;

const ModelProviderCompatSchema = z
  .object({
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsStrictMode: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    supportsFinishReason: z.boolean().optional(),
    maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  })
  .catchall(z.unknown());

const ModelProviderCostSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
  })
  .catchall(z.unknown());

export const ModelProviderModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    reasoning: z.boolean().default(false),
    input: z.array(z.enum(["text", "image"])).default(["text"]),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    cost: ModelProviderCostSchema.optional(),
    compat: ModelProviderCompatSchema.optional(),
  })
  .catchall(z.unknown());
export type ModelProviderModelConfig = z.infer<typeof ModelProviderModelSchema>;

/** OpenAI-compatible Chat Completions provider backed by a local or private server. */
export const ModelProviderSchema = z.object({
  name: z.string().optional(),
  baseUrl: z.string().url(),
  /** Local servers often ignore this, but pi treats a provider with an apiKey as configured. */
  apiKey: z.string().default("local"),
  headers: z.record(z.string(), z.string()).default({}),
  compat: ModelProviderCompatSchema.optional(),
  models: z.array(ModelProviderModelSchema).min(1),
});
export type ModelProviderConfig = z.infer<typeof ModelProviderSchema>;


const DelegationTargetObjectSchema = z.object({
  /** Slack channel ID, channel name, or #name. */
  channel: z.string().min(1),
  /** Why this source channel should hand work to this target. Shown to the agent. */
  reason: z.string().min(1).optional(),
});
export type DelegationTargetConfig = z.infer<typeof DelegationTargetObjectSchema>;
export const DelegationTargetSchema = z.union([
  z.string().min(1).transform((channel): DelegationTargetConfig => ({ channel })),
  DelegationTargetObjectSchema,
]);

/**
 * Argv patterns a restricted command runner accepts from the agent. Empty
 * means no extra args are accepted. Literals match exactly, `*` matches one
 * positional (non-option) arg, and a trailing `**` matches remaining
 * positional args. Option-shaped tokens must be explicit literals. These are
 * argv tokens, not shell fragments — shared by `exec.commands.*.allowArgs` and
 * `share.sharedTools.*.allowArgs`, and `cliTools.*.allowArgs`.
 */
const allowArgsShape = z
  .array(
    z.array(z.string()).refine((pattern) => {
      const index = pattern.indexOf("**");
      return index === -1 || index === pattern.length - 1;
    }, "** may only appear as the final argv pattern token"),
  )
  .default([]);

/**
 * A consuming channel's own policy for one shared-bin tool (`shared/bin/<name>`,
 * see `ShareSchema.sharedTools`). The name itself, and whether it exists at
 * all, is decided by whichever channel published it with `publish_shared_tool`
 * — this shape only ever narrows what THIS channel may do with it once named.
 */
const sharedToolShape = z.object({
  /** Argv patterns this channel may supply. Same syntax as exec.commands.*.allowArgs. */
  allowArgs: allowArgsShape,
  /** Extra environment for this channel's invocations. Values may use ${ENV_VAR}. */
  env: z.record(z.string(), z.string()).default({}),
  timeoutSeconds: z.number().int().positive().default(30),
  maxOutputBytes: z.number().int().positive().default(200_000),
  /**
   * Pin execution to this exact published script (sha256, lowercase hex, as
   * shown by `publish_shared_tool`/`list_shared_tools`). When set, this
   * channel refuses to run the tool if the publishing channel has changed it
   * since — an update needs this pin bumped too, rather than taking effect
   * here silently. Leave unset to always run whatever is currently published.
   */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters")
    .optional(),
});
export type SharedToolConfig = z.infer<typeof sharedToolShape>;

/**
 * Names of skill collections (`shared/skills/<collection>/`) and skills share
 * one grammar. `channel` and `builtin` are reserved because they are the
 * in-container mount names for a channel's own skills and the harness's.
 */
export const SKILL_COLLECTION_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const RESERVED_COLLECTION_NAMES = ["channel", "builtin"] as const;
const skillCollectionNameShape = z
  .string()
  .max(64)
  .regex(SKILL_COLLECTION_NAME, "collection names are lowercase letters, numbers and single hyphens")
  .refine((n) => !(RESERVED_COLLECTION_NAMES as readonly string[]).includes(n), {
    message: `collection names ${RESERVED_COLLECTION_NAMES.join(" and ")} are reserved`,
  });

/**
 * One assignment of a skill collection to a channel. `ro` (default) lets the
 * channel load and read the collection; `rw` additionally lets its agent
 * create, edit and delete skills in it, which changes what EVERY channel
 * holding the collection executes — use sparingly. Every write is logged.
 */
const skillCollectionAssignmentObject = z.object({
  name: skillCollectionNameShape,
  mode: z.enum(["ro", "rw"]).default("ro"),
});
export type SkillCollectionAssignment = z.infer<typeof skillCollectionAssignmentObject>;
const skillCollectionAssignmentShape = z.union([
  skillCollectionNameShape.transform((name): SkillCollectionAssignment => ({ name, mode: "ro" })),
  skillCollectionAssignmentObject.strict(),
]);

/** Slack user ids: `U` or `W`, then letters and digits. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

export const AGENT_NAME = /^[a-z][a-z0-9_]*$/;
const agentNameShape = z
  .string()
  .max(48)
  .regex(AGENT_NAME, "agent and set names are lowercase letters, numbers and underscores, starting with a letter");

/**
 * `post_as_user`: lets this channel's agent post to Slack as one named person, through a mandatory reviewer. A channel setting only:
 * `defaults.share.postAs` is refused, so a channel can never inherit the power to speak as someone.
 */
export const PostAsSchema = z
  .object({
    /** The Slack user the posts are made as. Their user token must be configured. */
    user: z.string().regex(SLACK_USER_ID, "user must be a Slack user id such as U0123ABCD"),
    /** A role in this channel's agent set that reviews every draft. It must have no tools and no connectors. */
    reviewer: agentNameShape,
    maxPerHour: z.number().int().min(1).max(100).default(10),
    /** Extra rules the reviewer applies on top of its own instructions. */
    rules: z.string().max(4000).optional(),
    /** Hosts whose links are private and always hold a post. */
    privateLinkHosts: z.array(z.string()).default([]),
  })
  .strict();
export type PostAsConfig = z.infer<typeof PostAsSchema>;

/** Same grammar as skill collections: lowercase words joined by single hyphens. */
export const KNOWLEDGE_BASE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const knowledgeBaseNameShape = z
  .string()
  .max(48)
  .regex(KNOWLEDGE_BASE_NAME, "knowledge base names are lowercase letters, numbers and single hyphens");

/**
 * A read-only knowledge base: a folder of markdown documents (an Obsidian-style wiki, typically maintained by an LLM) with
 * index files that link to the pages beneath them. Declared once at account level; each channel opts in with
 * `share.knowledgeBases`. Nothing in it is ever writable from a channel.
 */
export const KnowledgeBaseSchema = z
  .object({
    /** The folder that contains the whole wiki. Relative paths resolve against the repo root. */
    path: z.string().min(1),
    /** The starting page, relative to `path`. Defaults to `index.md`. */
    index: z.string().min(1).default("index.md"),
    /** One line saying what is in it, shown to the agent when it chooses which knowledge base to open. */
    description: z.string().trim().max(300).optional(),
  })
  .strict();
export type KnowledgeBaseConfig = z.infer<typeof KnowledgeBaseSchema>;

/**
 * The librarian: a built-in subagent that exists in any channel linked to a knowledge base. It runs the knowledge tools in a
 * context of its own and reports back a curated answer, so the channel agent does not spend its context on the lookups.
 */
export const LibrarianSchema = z
  .object({
    /** Defaults to the channel's model. A smaller, cheaper model is usually enough for a read-only search. */
    model: z.string().optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    timeoutSeconds: z.number().int().positive().max(3600).default(300),
  })
  .strict()
  .prefault({});
export type LibrarianConfig = z.infer<typeof LibrarianSchema>;

/** What a channel opts into from the account level. Everything defaults to closed. */
export const ShareSchema = z
  .object({
    /**
     * Read the account knowledge base (shared/knowledge/*.md).
     * `true` = all of it, `false` = none, or a list of specific filenames.
     * This is the one setting that defaults to open.
     */
    knowledge: z.union([z.boolean(), z.array(z.string())]).default(true),
    /**
     * REMOVED. The flat `shared/skills/<name>` catalogue was replaced by
     * collections (`share.skillCollections`). A non-empty value is rejected by
     * config validation with a migration message rather than silently ignored,
     * because a channel quietly losing its skills is worse than failing to load.
     */
    skills: z.array(z.string()).default([]),
    /**
     * Skill collections (`shared/skills/<collection>/<skill>/SKILL.md`) this
     * channel holds, each read-only (default) or read-write. Strings are
     * shorthand for read-only. A skill belongs to exactly one collection.
     */
    skillCollections: z.array(skillCollectionAssignmentShape).default([]),
    /**
     * Browse and install skills other channels published to the library.
     *
     * On by default, and safe to be: the library is empty until a channel is
     * allowed to publish, and installing is an explicit act by this channel's
     * own agent that copies the skill here rather than activating it remotely.
     */
    library: z.boolean().default(true),
    /**
     * Publish this channel's own skills into the library.
     *
     * Off by default. Publishing writes instructions that other channels may
     * end up following, which is the isolation model pointing the wrong way
     * unless somebody chose it. Add `skillPublish` to `permissions.grantable`
     * to let the agent ask for it a request at a time instead.
     */
    libraryPublish: z.boolean().default(false),
    /**
     * Search and read the account's document library.
     *
     * On by default. A document library that channels had to be let into one
     * at a time would mostly be a library nobody looks in, and reading is the
     * half with no way to affect anybody else. A channel that should not see
     * what the rest of the account has filed sets this to false.
     */
    documents: z.boolean().default(true),
    /**
     * File documents into that library.
     *
     * On by default too, because the whole feature is "attach it and it is
     * kept" and a default of false makes that "attach it and be told no". The
     * risk it carries is disclosure rather than instruction — a document filed
     * from a private channel is readable by every channel that can read the
     * library — so a channel handling anything sensitive should set this, and
     * usually `documents`, to false.
     */
    documentsAdd: z.boolean().default(true),
    /**
     * Knowledge bases (top-level `knowledgeBases`) this channel may read. Read-only, by name; a channel can reach nothing
     * outside the folders it is linked to.
     */
    knowledgeBases: z.array(knowledgeBaseNameShape).default([]),
    /** Connectors from the account catalogue to enable here. */
    connectors: z.array(z.string()).default([]),
    /**
     * Channel assistants this channel may hand work to. Entries may be strings
     * (`engineering`) or objects with a reason. The target channel gets a
     * normal assistant thread and its initial completion result or failure is
     * automatically posted back to the source thread.
     */
    delegateTo: z.array(DelegationTargetSchema).default([]),
    /**
     * Other channels this channel may publish a message to with
     * `post_to_channel`. Entries may be strings or `{ channel, reason }`.
     * Nothing else is reachable: the model picks from this list, never an
     * arbitrary channel. Slack IDs are the durable option. Posting to a public
     * channel the bot has not joined needs the `chat:write.public` scope.
     * Like `delegateTo`, this is never inherited from the account defaults.
     */
    postTo: z.array(DelegationTargetSchema).default([]),
    /**
     * Post to Slack as a real person, through a mandatory reviewer, with a forced footer. Channel-only: like `delegateTo` it is
     * never inherited, and `defaults.share.postAs` is refused.
     */
    postAs: PostAsSchema.optional(),
    /** Read the account-wide memory file. */
    memoryRead: z.boolean().default(true),
    /** Append to the account-wide memory file. Off by default: one channel
     *  should not silently rewrite what every other channel believes. */
    memoryWrite: z.boolean().default(false),
    /**
     * Read another channel's memory. Escape hatch for "the ops channel should
     * see what the alerts channel learned". Names/IDs, explicit only.
     */
    channelMemoryRead: z.array(z.string()).default([]),
    /**
     * Publish executable scripts to the account-wide shared bin
     * (`data/shared/bin/`) with `publish_shared_tool`, so an operator can let
     * other channels run them by name. Off by default, same shape as
     * `libraryPublish`: writing something another channel may end up
     * executing is not something a channel should be able to do just because
     * it felt like it. Publishing alone exposes nothing — see `sharedTools`.
     */
    sharedToolsPublish: z.boolean().default(false),
    /**
     * The shared-bin tools THIS channel may run, keyed by name, each with its
     * own argv allowlist. A name's presence here — decided by the operator,
     * per consuming channel — is what makes a published tool executable;
     * nothing is exposed just because some channel published it. Each entry
     * becomes a tool `shared__<name>`, run the same way `exec` runs a
     * configured command: no shell, argv-checked, output-capped, timed out.
     */
    sharedTools: z.record(z.string(), sharedToolShape).default({}),
  })
  .prefault({});
export type ShareConfig = z.infer<typeof ShareSchema>;

/**
 * Hard requirements on the host environment. The harness is opinionated: if a
 * channel's work depends on `gh` or `jq` being on PATH, say so here and the
 * harness verifies it at startup rather than letting the model discover the
 * gap halfway through a task.
 */
export const RequirementsSchema = z
  .object({
    /** Executables that must resolve on PATH (e.g. gh, git, jq, rg). */
    binaries: z.array(z.string()).default([]),
    /** Environment variables that must be set and non-empty (e.g. GH_TOKEN). */
    env: z.array(z.string()).default([]),
    /**
     * What to do when a requirement is missing.
     * - "fail": refuse to start (account level) or to serve the channel.
     * - "warn": log loudly and carry on.
     */
    onMissing: z.enum(["fail", "warn"]).default("fail"),
  })
  .prefault({});
export type RequirementsConfig = z.infer<typeof RequirementsSchema>;

/**
 * How `bash` is executed.
 *
 * Path checking confines every other tool, but not a shell. "docker" defaults to a persistent
 * per-thread container with only that channel's workspace mounted,
 * which restores the channel boundary for the one tool that could otherwise
 * step over it. "host" runs commands directly — simpler, but a channel with
 * bash can then reach anything the harness process can.
 */
const sandboxShape = z.object({
  mode: z.enum(["host", "docker", "macos-container", "kiri"]).default("host"),
  /**
   * Image for this channel's container. Point a channel at its own image to
   * give it tools the others do not have.
   */
  image: z.string().default("seneschal-sandbox:latest"),
  /**
   * Keep one long-lived container per stable thread and exec into it, so anything
   * installed or left running persists between commands. `false` uses a
   * throwaway container per command instead.
   */
  reuse: z.boolean().default(true),
  /** "none" keeps commands offline; "bridge" allows outbound network. */
  network: z.enum(["none", "bridge"]).default("none"),
  memory: z.string().default("512m"),
  cpus: z.number().positive().default(1),
  /** null explicitly disables this limit (required by Apple, which has no cgroup PID-limit flag). */
  pidsLimit: z.number().int().positive().nullable().default(256),
  timeoutSeconds: z.number().int().positive().default(120),
  /** Idle container retention. Active commands/background processes are protected. */
  idleSeconds: z.number().int().positive().default(86_400),
  /** Writable root preserves /repos in the container layer; true uses bounded tmpfs. */
  readOnlyRoot: z.boolean().default(false),
  /** Run as this uid:gid inside the container. Empty uses the image default. */
  user: z.string().default(""),
});
export const SandboxSchema = sandboxShape.prefault({});

/**
 * A CLI supplied by the operator once at account scope. A channel receives it
 * only when it names the tool under its own `exec.shared` allowlist.
 */
const cliToolNameShape = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,59}$/, "tool names must be 1–59 letters, numbers, underscores or hyphens");

/** The actual Pi tool name for an exec command. Keep schema collision checks
 * tied to the same normalization used when tools are registered. */
export function cliToolName(name: string): string {
  return `cli__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const execCommandShape = z.object({
  /** Human-facing summary; included in the tool description. */
  description: z.string().default(""),
  /** Executable to run. Prefer an absolute path for reviewed host tools. */
  command: z.string().min(1),
  /** Fixed argv prepended before anything the agent supplies. */
  args: z.array(z.string()).default([]),
  /** Argv patterns the agent may supply on top of the fixed `args`, unless allowAllArgs is enabled. */
  allowArgs: allowArgsShape,
  /** Trust all supplied argv, including flags, for this executable. Overrides allowArgs. */
  allowAllArgs: z.boolean().default(false),
  /** Extra environment for this command. Values may use ${ENV_VAR}. */
  env: z.record(z.string(), z.string()).default({}),
  timeoutSeconds: z.number().int().positive().default(30),
  maxOutputBytes: z.number().int().positive().default(200_000),
});
export type ExecCommandConfig = z.infer<typeof execCommandShape>;

const execShape = z.object({
  /** Named commands exposed as tools `cli__<name>`. */
  commands: z.record(z.string(), execCommandShape).default({}),
  /**
   * Account-wide `cliTools` this channel explicitly opts into. These names
   * are deliberately channel-only: defining a tool (or putting one in
   * defaults) never grants it to every channel.
   */
  shared: z.array(cliToolNameShape).default([]),
});
export const ExecSchema = execShape.prefault({});
/** Runtime command map. `shared` is configuration-only; resolution expands
 * selected registry tools into `commands` before agents see this shape. */
export type ExecConfig = {
  commands: Record<string, ExecCommandConfig>;
  shared?: string[];
};

/** Channel-level override; see SandboxOverrideSchema. */
export const ExecOverrideSchema = z
  .object({
    commands: z.record(z.string(), execCommandShape).optional(),
    /** Explicit allowlist of names from the account-wide `cliTools` registry. */
    shared: z.array(cliToolNameShape).optional(),
  })
  .optional();

/**
 * Channel-level override.
 *
 * Spelled out without defaults on purpose. `.partial()` makes fields optional
 * but leaves their `.default()` intact, so an "override" would still
 * materialise every default and overwrite the account settings it never
 * mentioned. The keys are kept in step with the full schema by a test.
 */
export const SandboxOverrideSchema = z
  .object({
    mode: z.enum(["host", "docker", "macos-container", "kiri"]).optional(),
    image: z.string().optional(),
    reuse: z.boolean().optional(),
    network: z.enum(["none", "bridge"]).optional(),
    memory: z.string().optional(),
    cpus: z.number().positive().optional(),
    pidsLimit: z.number().int().positive().nullable().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    idleSeconds: z.number().int().positive().optional(),
    readOnlyRoot: z.boolean().optional(),
    user: z.string().optional(),
  })
  .optional();
export type SandboxConfig = z.infer<typeof SandboxSchema>;

/**
 * Extra host directories a channel may reach only by following a symlink from
 * its workspace. This is deliberately separate from the ordinary jail roots:
 * naming a target does not make its absolute path generally readable/writable.
 */
const workspaceShape = z.object({
  /**
   * Absolute directories that a workspace symlink may resolve into. Empty
   * keeps the normal rule that every workspace symlink must stay in-workspace.
   * Keep these narrow: every file below a named root becomes available through
   * a symlink the channel can create in its own workspace.
   */
  symlinkTargets: z
    .array(z.string().refine(isAbsolute, "workspace.symlinkTargets entries must be absolute paths"))
    .default([]),
});
export const WorkspaceSchema = workspaceShape.prefault({});
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;

/** Channel-level override; see SandboxOverrideSchema. */
export const WorkspaceOverrideSchema = z
  .object({
    symlinkTargets: z
      .array(z.string().refine(isAbsolute, "workspace.symlinkTargets entries must be absolute paths"))
      .optional(),
  })
  .optional();

/**
 * How the `web` tools behave.
 *
 * Separate from `tools: [..., web]` for the same reason `sandbox:` is separate
 * from `bash`: the list says whether a channel has the capability, this says
 * what it is allowed to do with it.
 *
 * The defaults are deliberately narrow. Reading a page costs tokens, and the
 * harness usually runs on a home network where "fetch this URL" pointed at
 * 192.168.x.x is a router admin page, not a web page.
 */
const searchShape = z.object({
  /**
   * Which backend answers `search_web`. "none" leaves the agent able to read
   * URLs it is given but not to find new ones — no provider is assumed,
   * because every real search API needs a key and the keyless alternative is
   * scraping someone's results page.
   */
  provider: z.enum(["none", "brave", "tavily", "searxng"]).default("none"),
  /** API key for the provider. Supports ${ENV_VAR}. */
  apiKey: z.string().default(""),
  /** Base URL of a self-hosted SearXNG instance. */
  url: z.string().default(""),
  maxResults: z.number().int().positive().default(5),
});

const webShape = z.object({
  search: searchShape.prefault({}),
  /** Stop reading a response past this many bytes. */
  maxBytes: z.number().int().positive().default(2_000_000),
  /** Characters of extracted text handed to the model. A page is a token bill. */
  maxChars: z.number().int().positive().default(20_000),
  /** Maximum bytes staged by `download_url`; PDFs and binaries never enter model context. */
  downloadMaxBytes: z.number().int().positive().default(20 * 1024 * 1024),
  timeoutSeconds: z.number().int().positive().default(20),
  maxRedirects: z.number().int().nonnegative().default(5),
  /** Empty means any public host. Entries match a host and its subdomains. */
  allowHosts: z.array(z.string()).default([]),
  blockHosts: z.array(z.string()).default([]),
  /**
   * Allow RFC1918, loopback and link-local addresses. Off by default: this
   * harness sits inside a home network, so "summarise http://192.168.1.1" would
   * otherwise read the router's admin page out into Slack. Turn it on for a
   * channel that genuinely should reach your own Grafana or NAS.
   */
  allowPrivateHosts: z.boolean().default(false),
  userAgent: z.string().default("seneschal (+https://github.com/denwilliams/seneschal)"),
});

/**
 * Prompt-based AI image generation.
 *
 * This is separate from `upload_file`: generation writes a file into the
 * channel workspace, then upload_file posts it. Off by default because it calls
 * a paid external API and prompts may be sensitive.
 */
const imageGenerationShape = z.object({
  provider: z.enum(["none", "openai"]).default("none"),
  /** API key for the provider. Supports ${ENV_VAR}, expanded against the channel env. */
  apiKey: z.string().default(""),
  /** Model provider id whose configured credentials should be used instead of images.apiKey, e.g. openai-codex. */
  authProvider: z.string().default(""),
  /** Base OpenAI-compatible API URL; /images/generations is appended. Empty uses provider/runtime defaults. */
  baseUrl: z.union([z.literal(""), z.string().url()]).default("https://api.openai.com/v1"),
  model: z.string().default("gpt-image-1"),
  size: z.string().default("1024x1024"),
  quality: z.string().default("auto"),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  /** Some image APIs need b64_json or url requested explicitly; auto sends neither. */
  responseFormat: z.enum(["auto", "b64_json", "url"]).default("auto"),
  timeoutSeconds: z.number().int().positive().default(120),
  maxBytes: z.number().int().positive().default(20 * 1024 * 1024),
  maxPromptChars: z.number().int().positive().default(4_000),
});
export const ImageGenerationSchema = imageGenerationShape.prefault({});
/** Channel-level override; see SandboxOverrideSchema. */
export const ImageGenerationOverrideSchema =
  z
    .object({
      provider: z.enum(["none", "openai"]).optional(),
      apiKey: z.string().optional(),
      authProvider: z.string().optional(),
      baseUrl: z.union([z.literal(""), z.string().url()]).optional(),
      model: z.string().optional(),
      size: z.string().optional(),
      quality: z.string().optional(),
      outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
      responseFormat: z.enum(["auto", "b64_json", "url"]).optional(),
      timeoutSeconds: z.number().int().positive().optional(),
      maxBytes: z.number().int().positive().optional(),
      maxPromptChars: z.number().int().positive().optional(),
    })
    .optional();
export type ImageGenerationConfig = z.infer<typeof ImageGenerationSchema>;

export const WebSchema = webShape.prefault({});
/** Channel-level override; see SandboxOverrideSchema. */
export const WebOverrideSchema = z
  .object({
    search: z
      .object({
        provider: z.enum(["none", "brave", "tavily", "searxng"]).optional(),
        apiKey: z.string().optional(),
        url: z.string().optional(),
        maxResults: z.number().int().positive().optional(),
      })
      .optional(),
    maxBytes: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    downloadMaxBytes: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    maxRedirects: z.number().int().nonnegative().optional(),
    allowHosts: z.array(z.string()).optional(),
    blockHosts: z.array(z.string()).optional(),
    allowPrivateHosts: z.boolean().optional(),
    userAgent: z.string().optional(),
  })
  .optional();
export type WebConfig = z.infer<typeof WebSchema>;
export type SearchConfig = z.infer<typeof searchShape>;

/**
 * What the agent may ask a human to turn on at runtime, and who may say yes.
 *
 * `grantable` is a ceiling, not a default: a capability absent from this list
 * cannot be requested or granted no matter what anyone clicks. Runtime grants
 * only ever widen within it, and always expire unless granted "until revoked".
 */
const permissionsShape = z.object({
  /**
   * Capabilities the agent may request. Empty disables asking entirely.
   *
   * `network` and `web` are on by default: asking is not a privilege, since
   * nothing happens without a human clicking approve and the grant expires by
   * itself. `bash` and `memoryWrite` are deliberately not — those change what
   * the channel fundamentally is, and should be a config decision.
   *
   * `web` only ever comes up in a channel that had the tool removed; a channel
   * on the defaults already has it and is never offered it.
   */
  grantable: z.array(z.string()).default(["network", "web"]),
  /** Slack user ids allowed to approve. Empty means anyone in the channel. */
  approvers: z.array(z.string()).default([]),
  /** Durations offered on the approval message, in minutes. 0 = until revoked. */
  durations: z.array(z.number().int().nonnegative()).default([15, 60, 480]),
  /** Longest a time-limited grant may last, in minutes. 0 disables the cap. */
  maxMinutes: z.number().int().nonnegative().default(1440),
  /**
   * Whether a grant may be made permanent ("until revoked", duration 0).
   *
   * Off by default, and separate from `maxMinutes` so a cap means what it
   * looks like: a permanent grant is not "a very long one", it is a different
   * decision. Prefer putting genuinely permanent capabilities in the config,
   * where they are reviewable and survive `data/` being cleared.
   */
  allowPermanent: z.boolean().default(false),
});
export const PermissionsSchema = permissionsShape.prefault({});
/** Channel-level override; see SandboxOverrideSchema. */
export const PermissionsOverrideSchema = z
  .object({
    grantable: z.array(z.string()).optional(),
    approvers: z.array(z.string()).optional(),
    durations: z.array(z.number().int().nonnegative()).optional(),
    maxMinutes: z.number().int().nonnegative().optional(),
    allowPermanent: z.boolean().optional(),
  })
  .optional();
export type PermissionsConfig = z.infer<typeof PermissionsSchema>;

/**
 * How much of Slack's own history the agent reads when a conversation starts.
 *
 * The harness only ever saw messages delivered to it live, which made it
 * useless for the most ordinary request in Slack: being tagged into a
 * discussion that is already happening. Backfill is read once, when a thread
 * has no transcript yet, so it costs nothing on an ongoing conversation.
 *
 * The three numbers are separate because the decisions are. Reading the thread
 * you were just tagged into is what the mention implies; reading a channel
 * nobody invited you into the middle of is not, so it is off by default.
 */
const contextShape = z.object({
  /**
   * Messages read from a thread when joining one that is already running.
   * This is the one that makes "@seneschal what did we decide above?" work.
   */
  threadBackfill: z.number().int().nonnegative().default(50),
  /**
   * Recent channel messages read when a new top-level conversation starts.
   * Off by default: being mentioned is not an invitation to read the room.
   */
  channelBackfill: z.number().int().nonnegative().default(0),
  /**
   * Recent messages read at the top level of a DM. On by default, because a
   * DM is a conversation people do not thread — without it, every message
   * outside a thread starts from nothing.
   */
  dmBackfill: z.number().int().nonnegative().default(20),
});
export const ContextSchema = contextShape.prefault({});
/** Channel-level override; see SandboxOverrideSchema. */
export const ContextOverrideSchema = z
  .object({
    threadBackfill: z.number().int().nonnegative().optional(),
    channelBackfill: z.number().int().nonnegative().optional(),
    dmBackfill: z.number().int().nonnegative().optional(),
  })
  .optional();
export type ContextConfig = z.infer<typeof ContextSchema>;

/**
 * Rolling, lightweight summaries of the most recently updated Slack threads.
 *
 * These are not durable memory. They are orientation context: after a thread
 * has been quiet for a short debounce window, the harness asks a small model
 * for one sentence and injects the newest entries into every turn's prompt.
 */
const recentConversationsShape = z.object({
  enabled: z.boolean().default(true),
  /** Wait this long after the last handled turn before summarising the thread. */
  debounceSeconds: z.number().int().positive().default(60),
  /** Keep this many most recently updated thread summaries per channel. */
  maxThreads: z.number().int().positive().default(10),
  /** Small model used by the background summariser. */
  model: z.string().default("deepseek-flash"),
  /** Characters of first/recent transcript text sent to the summariser. */
  maxTranscriptChars: z.number().int().positive().default(8000),
});
export const RecentConversationsSchema = recentConversationsShape.prefault({});
export type RecentConversationsConfig = z.infer<typeof RecentConversationsSchema>;
export const RecentConversationsOverrideSchema =
  z
    .object({
      enabled: z.boolean().optional(),
      debounceSeconds: z.number().int().positive().optional(),
      maxThreads: z.number().int().positive().optional(),
      model: z.string().optional(),
      maxTranscriptChars: z.number().int().positive().optional(),
    })
    .optional();
/** Opt-in invitation to read a post in its own assistant channel. */
export const ReactionTriggersSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Slack emoji name without colons (custom emoji names are supported). */
    emoji: z.string().regex(/^[a-zA-Z0-9_+-]+$/, "Use a Slack emoji name without colons").default("robot_face"),
  })
  .prefault({});

export const ShortcutsSchema = z
  .object({
    sendToAssistant: z
      .object({
        /** Default target for the Slack `Send to assistant` message shortcut. Empty means the modal must choose one. */
        defaultChannel: z.string().default(""),
      })
      .prefault({}),
  })
  .prefault({});
export type ShortcutsConfig = z.infer<typeof ShortcutsSchema>;

/** Safe Slack buttons that resume the originating conversation with a fixed response. */
export const InteractiveComponentsSchema = z
  .object({
    /** Expose ask_canned_response; disabled until an operator explicitly opts in. */
    enabled: z.boolean().default(false),
  })
  .prefault({});
export type InteractiveComponentsConfig = z.infer<typeof InteractiveComponentsSchema>;

/** Channel overrides only choose whether the account default is enabled. */
export const InteractiveComponentsOverrideSchema = z
  .object({ enabled: z.boolean().optional() })
  .optional();

/** A reviewed, GitHub-backed software factory attached to one Slack channel. */
export const FactoryLifecycleSkillSchema = z.enum(["planning", "implementation", "review", "commit-pr"]);
export type FactoryLifecycleSkill = z.infer<typeof FactoryLifecycleSkillSchema>;
/**
 * When a pull request the factory's reviewer approved may merge by itself, and who decides when it may not. All optional: a
 * repository's own rules are laid over the factory's, and what neither sets falls back to the safe default (nothing merges
 * automatically, the channel's allowed users approve). Unknown keys are refused, so a typo cannot quietly relax a rule.
 */
export const FactoryMergeRulesSchema = z.object({
  /** Slack users who may approve or decline a merge (and a deploy). Default: the channel's `allowUsers`. */
  approvers: z.array(z.string().regex(/^[UW][A-Z0-9]{2,}$/, "must be a Slack user ID")).max(50).optional(),
  /** Merge by itself at or under this final risk (1 to 4). 0, the default, never merges automatically. 5 is never automatic. */
  autoMergeMaxRisk: z.number().int().min(0).max(4).optional(),
  method: z.enum(["squash", "merge", "rebase"]).optional(),
  /** Changed paths matching any of these (`*` within a folder, `**` across folders) make the final risk at least 4. */
  sensitivePaths: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /** A change of more than this many added and removed lines makes the final risk at least 3. */
  largeDiffLines: z.number().int().min(1).max(100_000).optional(),
  /** Where the deploy stage deploys, for a channel with a deployer role. */
  deployEnvironment: z.enum(["staging", "production"]).optional(),
}).strict();
export type FactoryMergeRules = z.infer<typeof FactoryMergeRulesSchema>;

/**
 * How much of its own judgement a factory is trusted with: a preset for `merge.autoMergeMaxRisk`, `intake.assumeAfterHours`,
 * `reviewRounds` and `autoRetries`. Explicit settings beat it. It never loosens a gate (required checks, the head check, sensitive
 * paths, who approves, deploy approval). See docs/FACTORY_WORKFLOW_DESIGN.md section 24.
 */
export const FactoryAutonomySchema = z.enum(["cautious", "balanced", "autonomous"]);
export type FactoryAutonomy = z.infer<typeof FactoryAutonomySchema>;

/** A repository's own rules: the merge rules, and its own autonomy level. */
export const FactoryRepositoryRulesSchema = FactoryMergeRulesSchema.extend({ autonomy: FactoryAutonomySchema.optional() }).strict();

/**
 * Whether the factory's agent may file a GitHub issue in one of its repositories for a request that has none yet (a Slack
 * message, a support ticket, an email). Off unless an operator turns it on: it writes to GitHub as the channel, from text that
 * may have come from anyone. A creation is rate limited per channel and every one is audited.
 */
export const FactoryIssuesSchema = z.object({
  create: z.boolean().default(false),
  /** Labels put on a created issue. The harness creates any that are missing from a repository (it never changes an existing one), as it does for the go label and the `status:*` labels the roles use. */
  labels: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,49}$/, "must be a plain GitHub label name (no commas or quotes)")).max(10).default(["status:triage"]),
  /** At most this many issues are created per channel per hour. */
  maxPerHour: z.number().int().min(1).max(100).default(10),
  /** Reserved: an approver confirming each creation. Not built; refused rather than quietly ignored. */
  requireApproval: z.boolean().default(false).refine((value) => !value, "is not supported yet: a created issue cannot wait for an approver. Leave it off, or leave `issues.create` off"),
}).strict();
export type FactoryIssuesConfig = z.infer<typeof FactoryIssuesSchema>;

/**
 * Whether the harness watches the factory's repositories and starts a workflow run for every new issue, and sends changes on an
 * issue to its run. Off unless an operator turns it on: it spends model time on issues anyone who can file one may have written.
 * Only trusted authors (owners, members and collaborators, the harness's own filings, or an issue carrying `goLabel`) start a run by
 * themselves. See docs/FACTORY_WORKFLOW_DESIGN.md section 15.
 */
export const FactoryIntakeSchema = z.object({
  enabled: z.boolean().default(false),
  /** Work tracker. GitHub remains the code/PR host for Jira factories. */
  source: z.enum(["github", "jira"]).default("github"),
  /** How often each repository is polled. */
  intervalSeconds: z.number().int().min(60).max(3600).default(120),
  /** An issue carrying this label starts a run whoever filed it: only people with triage rights can add a label. */
  goLabel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,49}$/, "must be a plain GitHub label name (no commas or quotes)").default("factory:go"),
  /** An issue carrying any of these is not for the factory. */
  ignoreLabels: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,49}$/, "must be a plain GitHub label name (no commas or quotes)")).max(20).default(["wontfix", "duplicate", "invalid", "status:rejected"]),
  /** At most this many runs are started by one poll of one channel. */
  maxStartsPerPoll: z.number().int().min(1).max(20).default(5),
  /** At most this many runs are started per channel per hour. */
  maxPerHour: z.number().int().min(1).max(200).default(20),
  /** A run waiting for an answer on its issue is rejected as stale after this many days. */
  needsInfoDays: z.number().min(0.01).max(365).default(14),
  /**
   * After this many hours with no answer, triage is run once more and told to stop asking: it states its assumptions on the issue and
   * goes on (READY), or rejects. 0 never assumes: the run waits for a person. The merge gate is unaffected: whatever is
   * built on an assumption still goes through review and the merge rules.
   */
  assumeAfterHours: z.number().min(0).max(720).optional(),
  /** Start runs for the open issues that already exist (the last 30 days) instead of only new ones. Still under the caps. */
  backfill: z.boolean().default(false),
}).strict();
export type FactoryIntakeConfig = z.infer<typeof FactoryIntakeSchema>;

export const FactoryJiraSchema = z.object({
  /** Expected active ACLI site; never switch a process-wide CLI login while polling. */
  site: z.string().regex(/^[a-zA-Z0-9-]+\.atlassian\.net$/, "must be a Jira Cloud hostname").transform(site => site.toLowerCase()),
  projects: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  components: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
  intakeLabel: z.string().trim().min(1).max(100),
  /** Jira account IDs allowed to supply work/answers; selection is not authorization. */
  trustedAccountIds: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  statuses: z.object({
    triage: z.string().trim().min(1).default("To Do"),
    implement: z.string().trim().min(1).default("In Progress"),
    review: z.string().trim().min(1).default("In Review"),
    completed: z.string().trim().min(1).default("Done"),
  }).strict().default({ triage: "To Do", implement: "In Progress", review: "In Review", completed: "Done" }).refine(statuses => [statuses.triage, statuses.implement, statuses.review].every(status => status.toLowerCase() !== statuses.completed.toLowerCase() && status.toLowerCase() !== "done"), "pre-completion mappings must not use the completed/Done status"),
}).strict();
export type FactoryJiraConfig = z.infer<typeof FactoryJiraSchema>;

export const FactorySchema = z.object({
  /** Human-facing factory/project name. */
  name: z.string().trim().min(1).max(120),
  /** GitHub owner/repository names that this factory is allowed to describe. */
  repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be an owner/repository GitHub name")).min(1).max(20),
  /** Explicit identity for new coder commits; absent leaves Git's existing behavior unchanged. */
  commitAuthor: z.object({
    name: z.string().trim().min(1).max(200).regex(/^[^<>\x00-\x1f\x7f]+$/, "must not contain angle brackets or control characters"),
    email: z.email().max(254),
  }).strict().optional(),
  /** Reviewed lifecycle skills shipped with the harness; channel-local copies may shadow them. */
  lifecycleSkills: z.array(FactoryLifecycleSkillSchema).default(["planning", "implementation", "review", "commit-pr"]),
  /** The merge rules for every repository in this factory. */
  merge: FactoryMergeRulesSchema.optional(),
  /** Rules for one repository, laid over `merge`. Keys must be in `repositories`. */
  repositoryRules: z.record(z.string(), FactoryRepositoryRulesSchema).optional(),
  /** Whether each workflow run gets a status post in the channel. Off, a run still works and reports where it was started. */
  announce: z.boolean().default(true),
  /** How many times review may send a run back to the coder before a person is asked whether to allow another round. Unset: the level's (3 when cautious). */
  reviewRounds: z.number().int().min(1).max(10).optional(),
  /** How many workflow runs may be live in this channel at once (a run waiting for a person counts). */
  maxLiveRuns: z.number().int().min(1).max(10).default(3),
  /** How many times the engine tries a stage again on its own, after it timed out or its report was unusable, before a person is asked. Unset: the level's. */
  autoRetries: z.number().int().min(0).max(3).optional(),
  /** How much of its own judgement the factory is trusted with: a preset for the knobs above and `merge.autoMergeMaxRisk`. Unset: `cautious`, which is how a factory ran before this existed. */
  autonomy: FactoryAutonomySchema.optional(),
  /** Filing issues for requests that have none yet. Off by default. */
  issues: FactoryIssuesSchema.optional(),
  /** Watching the repositories for issues and starting runs by itself. Off by default. */
  intake: FactoryIntakeSchema.optional(),
  jira: FactoryJiraSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.intake?.source === "jira") {
    if (!value.jira) ctx.addIssue({ code: "custom", path: ["jira"], message: "is required for Jira intake" });
    if (value.repositories.length !== 1) ctx.addIssue({ code: "custom", path: ["repositories"], message: "Jira factories need exactly one target repository" });
    if (value.issues?.create) ctx.addIssue({ code: "custom", path: ["issues", "create"], message: "Jira issue filing is not supported; file tickets in Jira" });
  }
  if (new Set(value.repositories.map((repo) => repo.toLowerCase())).size !== value.repositories.length) {
    ctx.addIssue({ code: "custom", path: ["repositories"], message: "must not contain duplicate repositories" });
  }
  if (new Set(value.lifecycleSkills).size !== value.lifecycleSkills.length) {
    ctx.addIssue({ code: "custom", path: ["lifecycleSkills"], message: "must not contain duplicate lifecycle skills" });
  }
  const known = new Set(value.repositories.map((repo) => repo.toLowerCase()));
  for (const repo of Object.keys(value.repositoryRules ?? {})) {
    if (!known.has(repo.toLowerCase())) ctx.addIssue({ code: "custom", path: ["repositoryRules", repo], message: "is not one of this factory's repositories" });
  }
});
export type FactoryConfig = z.infer<typeof FactorySchema>;

/**
 * Subagents: purpose-built workers a channel agent can hand work to, defined once in an agent set and
 * assigned to channels. A subagent talks to systems (GitHub, Linear, Gmail), never to the user: it has no
 * Slack posting tools, and only the channel agent decides what the user sees. Names use underscores
 * (`software_engineering`, `code_reviewer`) because they are also tool arguments.
 */

export const SubagentSchema = z
  .object({
    /** One line the channel agent reads when choosing who to hand work to. */
    description: z.string().trim().min(1).max(300),
    /** The role's standing instructions. The channel's own skills and memory add to these. */
    instructions: z.string().optional(),
    /** Defaults to the channel's model. Added to that channel's model allowlist, so name it exactly. */
    model: z.string().optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    /**
     * A ceiling, not a grant: the worker gets these tools only if the channel has them too. Empty by
     * default, so a role that only calls connectors needs no tools at all.
     */
    tools: z.array(ToolNameSchema).default([]),
    /** Connectors by name; the worker gets only those the channel already has. */
    connectors: z.array(z.string()).default([]),
    /** A hard wall-clock limit for one run. */
    timeoutSeconds: z.number().int().positive().max(3600).default(900),
    /**
     * The role only runs while a person has approved it, with the same Slack approve/deny buttons and
     * expiring grants as other runtime permissions (`subagent:<name>`). For roles that change the outside
     * world, like a deployer. The grant is for the role over a time window, not for one specific job, so
     * offer short durations (`permissions.durations`) in channels that use it.
     */
    requireApproval: z.boolean().default(false),
  })
  .strict();
export type SubagentConfig = z.infer<typeof SubagentSchema>;

export const AgentSetSchema = z
  .object({
    description: z.string().optional(),
    agents: z
      .record(agentNameShape, SubagentSchema)
      .refine((agents) => Object.keys(agents).length > 0, "an agent set needs at least one agent"),
  })
  .strict();
export type AgentSetConfig = z.infer<typeof AgentSetSchema>;

/** A channel can only narrow what the set grants: drop an agent, or take tools/connectors away. */
export const AgentOverrideSchema = z
  .object({
    enabled: z.boolean().default(true),
    tools: z.array(ToolNameSchema).optional(),
    connectors: z.array(z.string()).optional(),
  })
  .strict();
export type AgentOverrideConfig = z.infer<typeof AgentOverrideSchema>;

/** Profile writes are a host-configured channel capability, never inherited. */
export const SlackProfileSchema = z.object({
  user: z.string().regex(/^[UW][A-Z0-9]{2,}$/, "must be a Slack user ID"),
  team: z.string().regex(/^T[A-Z0-9]{2,}$/, "must be a Slack workspace ID"),
}).strict();
export type SlackProfileConfig = z.infer<typeof SlackProfileSchema>;

export const ChannelSchema = z.object({
  /** Human note about what this channel is for; also injected into the prompt. */
  description: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  /**
   * Models this channel may switch itself to. Entries can be a bare id
   * ("gpt-5.4"), "provider/id", or "provider/*" for a whole provider.
   * Omit to inherit defaults; an empty list means no restriction.
   */
  models: z.array(z.string()).optional(),
  /** Built-in tools enabled here. Omit to inherit defaults. */
  tools: z.array(ToolNameSchema).optional(),
  /** Set/clear one authorized person's status and photo. Host-only opt-in. */
  slackProfile: SlackProfileSchema.optional(),
  /** Connectors defined privately for this channel (not in the account catalogue). */
  connectors: z.record(z.string(), ConnectorSchema).default({}),
  share: ShareSchema,
  /**
   * Mark this as the admin channel. Its agent may read, write and delete OTHER
   * channels' own skills with the `admin_*_channel_skill` tools. At most one
   * channel may be the admin channel; everything else about the channel
   * (tools, sandbox, who may talk to it) is configured normally.
   */
  admin: z.boolean().optional(),
  /** Opt-in built-in configuration administrators. Never inherited from defaults. */
  configurators: z.object({
    channel: z.boolean().default(false),
    harness: z.boolean().default(false),
  }).strict().prefault({}),
  /** Opt into GitHub-Issue-based software-factory guidance, skills and a static dashboard publisher. */
  factory: FactorySchema.optional(),
  /** An agent set (top-level `agentSets`) whose subagents this channel's agent may run. */
  agentSet: agentNameShape.optional(),
  /** Per-channel narrowing of the set: disable an agent, or remove tools/connectors from it. Never widens. */
  agentOverrides: z.record(agentNameShape, AgentOverrideSchema).default({}),
  /** Free-form preferences injected into the system prompt (tone, format, timezone...). */
  preferences: z.string().optional(),
  /** Slack users allowed to talk to the bot here. Omit = anyone in the channel. */
  allowUsers: z.array(z.string()).optional(),
  /**
   * Reply to every new top-level message in this channel, even without an
   * explicit mention. Thread replies still only reach the agent once it is
   * already part of that thread.
   */
  respondToRootMessages: z.boolean().default(false),
  /** Extra host requirements for this channel, on top of the account ones. */
  requires: RequirementsSchema,
  /** How bash runs here. Defaults to the global setting. */
  sandbox: SandboxOverrideSchema,
  /** Which restricted command-line tools `exec` may run here. */
  exec: ExecOverrideSchema,
  /** Explicit external targets that workspace symlinks may reach. */
  workspace: WorkspaceOverrideSchema,
  /** How the web tools behave here. Defaults to the global setting. */
  web: WebOverrideSchema,
  /** How prompt-based AI image generation behaves here. Defaults to the global setting. */
  images: ImageGenerationOverrideSchema,
  /** What may be granted at runtime here. Defaults to the global setting. */
  permissions: PermissionsOverrideSchema,
  /** How much Slack history is read here. Defaults to the global setting. */
  context: ContextOverrideSchema,
  /** Rolling one-line summaries of recently updated threads. Defaults to the global setting. */
  recentConversations: RecentConversationsOverrideSchema,
  /** Safe canned-response buttons. Defaults to the global setting. */
  interactiveComponents: InteractiveComponentsOverrideSchema,
  /** Allow the agent to schedule work here. Defaults to the global setting. */
  schedules: z.boolean().optional(),
  /**
   * Jobs this channel's agent may run: named, repeatable workflows of phases (see docs/STATE_AND_JOBS_DESIGN.md). Never
   * inherited from `defaults`, like `share.sharedTools`: that a channel may run something unattended has to be a decision
   * about that channel, not something it gets by not saying otherwise.
   */
  jobs: JobTableSchema.optional(),
  /** Consolidate this channel's memory overnight. Defaults to the global setting. */
  dreams: z.boolean().optional(),
  /**
   * Env file holding this channel's own secrets (connector tokens and the
   * like). Overrides the global bundle. Relative paths resolve against the
   * repo root. If omitted, `<dataDir>/channels/<id>/env` is used when present.
   */
  envFile: z.string().optional(),
});
export type ChannelConfig = z.infer<typeof ChannelSchema>;

export const DefaultsSchema = z
  .object({
    slackProfile: z.unknown().refine((value) => value === undefined, { error: "slackProfile is enabled on individual channels, never in defaults" }).optional(),
    model: z.string().default("deepseek-v4-pro"),
    thinkingLevel: ThinkingLevelSchema.default("medium"),
    /**
     * Models any channel may switch itself to. Empty means anything the
     * harness has credentials for.
     */
    models: z.array(z.string()).default([]),
    /**
     * bash is deliberately absent: it is opt-in per channel.
     *
     * `web` is not. An assistant that cannot look anything up answers every
     * question about the present from a training set that ended months ago,
     * which is the failure people actually notice. It reads pages over GET and
     * nothing else, so it is not the same kind of decision as a shell —
     * drop it from this list for a channel that should stay offline.
     */
    tools: z
      .array(ToolNameSchema)
      .default(["read", "write", "edit", "ls", "find", "grep", "sqlite", "charts", "slides", "file_ops", "web"]),
    sandbox: SandboxSchema,
    exec: ExecSchema,
    /** Refused rather than ignored: jobs are listed under a channel, never inherited (see the channel entry's `jobs`). */
    jobs: z.unknown().refine((value) => value === undefined, { error: "jobs are set on each channel, not in defaults: that a channel may run something unattended has to be a decision about that channel" }).optional(),
    workspace: WorkspaceSchema,
    web: WebSchema,
    images: ImageGenerationSchema,
    permissions: PermissionsSchema,
    context: ContextSchema,
    recentConversations: RecentConversationsSchema,
    /** Disabled by default: enabling this exposes only fixed response buttons, never callbacks. */
    interactiveComponents: InteractiveComponentsSchema,
    share: ShareSchema,
    /** Slack users allowed to talk to the bot by default. Omit = anyone. */
    allowUsers: z.array(z.string()).optional(),
    preferences: z.string().optional(),
  })
  .prefault({});
export type DefaultsConfig = z.infer<typeof DefaultsSchema>;

export const HarnessConfigSchema = z.object({
  /** OpenBao KV v2 imports; values stay out of YAML and process.env. */
  openbao: OpenBaoSchema.optional(),
  /** Native host-only Keychain; config contains import names, never values. */
  keychain: KeychainSchema.optional(),
  /** Name of this deployment, used in the system prompt. */
  name: z.string().default("Seneschal"),
  /** Where runtime state lives. Relative paths resolve against the repo root. */
  dataDir: z.string().default("./data"),
  /** Document library only. Relative paths resolve against the repo root; default: <dataDir>/shared/documents. */
  documentsDir: z.string().min(1).optional(),
  /**
   * Shared credential store (auth.json), used by every channel — credentials
   * belong to the operator, not to a channel. Defaults to <dataDir>/auth.json.
   * Point it at ~/.pi/agent/auth.json to reuse an existing `pi` login, which
   * is how subscription providers (openai-codex, github-copilot) authenticate.
   */
  authPath: z.string().optional(),
  /**
   * Env file of shared secrets available to every channel, layered over the
   * process environment. Per-channel files override it. Keep provider API keys
   * here or in the real environment; put per-channel connector tokens in the
   * channel's own file instead.
   */
  envFile: z.string().optional(),
  /** Account-wide connector catalogue. Definitions only; channels opt in. */
  connectors: z.record(z.string(), ConnectorSchema).default({}),
  /**
   * Operator-defined CLI registry. Defining a command here exposes it nowhere:
   * each consuming channel must name it in `exec.shared`, and also have the
   * `exec` tool. The same argv restrictions as per-channel exec commands
   * apply.
   */
  cliTools: z.record(cliToolNameShape, execCommandShape).default({}),
  /** OpenAI-compatible model servers available to every channel by provider id. */
  modelProviders: z.record(z.string(), ModelProviderSchema).default({}),
  defaults: DefaultsSchema,
  /** Host requirements checked once at startup, before Slack is connected. */
  requires: RequirementsSchema,
  /** Read-only markdown knowledge bases, linked to channels with `channels.<name>.share.knowledgeBases`. */
  knowledgeBases: z.record(knowledgeBaseNameShape, KnowledgeBaseSchema).default({}),
  /** The built-in librarian subagent that channels with a knowledge base can ask to do the research. */
  librarian: LibrarianSchema,
  /** Named groups of subagents, assigned to channels with `channels.<name>.agentSet`. */
  agentSets: z.record(agentNameShape, AgentSetSchema).default({}),
  /** Keyed by channel name ("general") or Slack channel ID ("C123ABC"). */
  channels: z.record(z.string(), ChannelSchema).default({}),
  /**
   * Whether a channel with no entry in `channels` gets a default isolated
   * workspace, or is ignored entirely. `false` is the locked-down choice.
   */
  allowUnconfiguredChannels: z.boolean().default(true),
  /** Direct messages are treated as a private channel per user when true. */
  allowDirectMessages: z.boolean().default(true),
  /**
   * A compact account-wide token/cost readout in one designated Slack channel's
   * topic. It is intentionally opt-in: a topic is shared channel real estate.
   */
  channelTopicUsage: z
    .object({
      enabled: z.boolean().default(false),
      /** Public Slack channel ID. Empty disables this opt-in feature. */
      channel: z
        .string()
        .regex(/^$|^C[A-Z0-9]{2,}$/, "must be empty or a public Slack channel ID starting with C")
        .default(""),
    })
    .superRefine((value, ctx) => {
      if (value.enabled && !value.channel) {
        ctx.addIssue({
          code: "custom",
          path: ["channel"],
          message: "is required when channelTopicUsage is enabled",
        });
      }
    })
    .prefault({}),
  schedules: z
    .object({
      /** Whether the agent can schedule its own follow-up work. */
      enabled: z.boolean().default(true),
      /** IANA timezone used when a schedule does not name one. */
      timezone: z.string().default("UTC"),
      /** Cap per channel, so a channel cannot accumulate runaway jobs. */
      maxPerChannel: z.number().int().positive().default(20),
      /**
       * Reject schedules firing more often than this. Guards against an agent
       * reaching for "* * * * *" and billing someone by the minute.
       */
      minIntervalMinutes: z.number().int().positive().default(5),
    })
    .prefault({}),
  /**
   * The nightly consolidation pass.
   *
   * Memory only ever grew: every "remember this" added a line and nothing ever
   * took one away, so the file got longer and less useful at the same time.
   * Once a day, when nobody is talking, each channel rereads its own recent
   * conversations, folds what mattered into memory, merges the duplicates and
   * lets go of what has sat unused since it arrived.
   *
   * It costs one model call per channel per night, and only for channels that
   * have something to think about.
   */
  dreams: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * When to dream. Small hours by default — the pass reads the channel's
       * own transcripts, and doing that while people are still adding to them
       * is both wasteful and confusing.
       */
      cron: z.string().default("0 3 * * *"),
      /** IANA timezone for the cron. Defaults to the schedules timezone. */
      timezone: z.string().optional(),
      /**
       * How long an entry may sit unused, unrepeated and unrecalled before the
       * pass is invited to drop it. Dropped entries go to MEMORY.archive.md,
       * never to nothing.
       */
      forgetAfterDays: z.number().int().positive().default(90),
      /** Conversations reread per dream, most recently active first. */
      maxConversations: z.number().int().positive().default(8),
      /**
       * Full transcripts kept under `channels/<id>/dreams/`, for debugging a
       * pass that did something surprising. The one-line-per-run log beside
       * them is kept forever regardless; only these are pruned, because only
       * these are big. 0 keeps none.
       */
      keepTranscripts: z.number().int().nonnegative().default(14),
      /**
       * Post a one-line note to the channel after a dream. Off by default: a
       * daily "I tidied my memory" message in a family chat is spam. The
       * journal in memory/DREAMS.md is always written either way.
       */
      announce: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Daily compressed backups of the whole data directory.
   *
   * The harness is intentionally file-backed, which makes the backup boundary
   * simple: archive `dataDir` once a day, write the archive outside that tree
   * by default, and keep only the newest few archives so the disk cannot fill
   * indefinitely.
   */
  backups: z
    .object({
      enabled: z.boolean().default(true),
      /** When to write the archive. Defaults to just before the overnight dream. */
      cron: z.string().default("30 2 * * *"),
      /** IANA timezone for the cron and YYYY-MM-DD filename. Defaults to schedules timezone. */
      timezone: z.string().optional(),
      /**
       * Where archives are written. Empty means a `backups/` sibling next to
       * `dataDir`; relative paths resolve against the repo root.
       */
      directory: z.string().default(""),
      /** Keep this many newest `data-YYYY-MM-DD.tar.gz` files. */
      keepLast: z.number().int().positive().default(14),
    })
    .prefault({}),
  /**
   * Shared notification batching.
   *
   * Any channel may explicitly submit a short item to the account-wide inbox.
   * Only the configured notification channel may collect those submissions, so
   * a scheduled agent there can turn many noisy updates into one post.
   */
  notifications: z
    .object({
      /** Whether the notification inbox tools are available. */
      enabled: z.boolean().default(true),
      /** Channel name, "#name", or Slack id allowed to collect the batch. Empty means submit works but collection is disabled. */
      channel: z.string().default(""),
      /** Maximum uncollected submissions before new submissions are refused. */
      maxPending: z.number().int().positive().default(200),
      /** Maximum characters accepted for one submission. */
      maxMessageChars: z.number().int().positive().default(4000),
    })
    .prefault({}),
  /** Workspace-facing Slack shortcuts. */
  shortcuts: ShortcutsSchema,
  /** Reactions that explicitly invite the source channel's assistant to read a post. */
  reactionTriggers: ReactionTriggersSchema,
  /**
   * The other half of `report_limitation`.
   *
   * Agents filing what the harness would not let them do is only worth
   * anything if somebody sees it, and "there is a file in `data/`" is not a
   * review loop — it is a file nobody opens. So the digest goes out on a
   * schedule, to a channel, leading with what changed.
   *
   * It stays quiet when nothing has moved. A weekly message that is sometimes
   * empty trains people to ignore the ones that are not. Startup is the
   * exception: a successful process start posts a one-line liveness notice to
   * the digest channel.
   */
  feedback: z
    .object({
      /**
       * Where the digest and startup notice are posted: a channel name,
       * "#name", or a Slack id. Empty means no digest or startup notice —
       * reports still accumulate in the file.
       *
       * This channel is also the one place the whole log can be read: its
       * agent gets read access to `shared/feedback/`, and `!feedback all`
       * works there, because it is by definition the operator's view.
       */
      digestChannel: z.string().default(""),
      /** When it goes out. Weekly, at the start of the week, by default. */
      cron: z.string().default("0 9 * * MON"),
      /** IANA timezone for the cron. Defaults to the schedules timezone. */
      timezone: z.string().optional(),
      /**
       * Tell the channels that reported something when it is closed. On by
       * default: an agent that reports a wall and never hears back is one
       * whose users learn that reporting things achieves nothing.
       */
      announceResolved: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * The harness's one web server: a read-only console (a channel list, a page
   * per channel with work and non-secret configuration, and a live factory
   * page), `/health`, `/api/status` (task state as JSON) and, with
   * `artifacts: true`, each channel's `workspace/artifacts/` files, all on one
   * origin (there is no artifacts-only mode). Off by default because it shows
   * harness internals: enable Cloudflare Access validation, use an authenticating
   * proxy, or keep it on loopback. Loopback alone does not stop DNS
   * rebinding, so the server answers 421 to any Host other than loopback, the
   * bind `host` (unless a wildcard) and `baseUrl`'s hostname; a reverse proxy
   * must forward that public Host (nginx: `proxy_set_header Host $host;`, not
   * the default `$proxy_host`).
   */
  webConsole: z
    .object({
      enabled: z.boolean().default(false),
      /** Optional server-side Access session validation. A tunnel alone is not authentication. */
      cloudflareAccess: CloudflareAccessSchema.optional(),
      /** Opt-in server-side HTTP MCP OAuth callback; requires HTTPS and this console's exact /oauth/callback URL. */
      oauth: z.object({
        callbackUrl: z.string().url(),
        ttlSeconds: z.number().int().min(60).max(900).default(600),
      }).optional(),
      /** Optional factory MCP adapter on this same listener; writes also require `actions`. */
      mcp: z.object({
        enabled: z.boolean().default(false),
        /** Use ${FACTORY_MCP_TOKEN} to keep the token outside the config file. */
        bearerToken: z.string().min(1).max(4096).regex(/^\S+$/).optional(),
      }).optional(),
      /** Bind address. Use loopback behind a local reverse proxy, or an interface address when externally secured. */
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(3012),
      /** Public browser URL, including any reverse-proxy path prefix, without a query or fragment. */
      baseUrl: z.string().url().optional(),
      /** Serve `/channels/<id>/artifacts/<file>` from each channel's `workspace/artifacts/`. */
      artifacts: z.boolean().default(false),
      /** Completed tasks retained in each `/api/status` response, globally and per channel. */
      historyLimit: z.number().int().min(1).max(1000).default(100),
      /**
       * Let the console edit channel lists and act on software factory runs: retry, skip, restart from a stage, abort, read the issue again, answer a
       * question, start a run, poll now. Every admitted console user can do these, so turn it on only
       * where the console is not public (loopback, or behind your VPN or authenticating proxy). It cannot approve or merge.
       */
      actions: z.boolean().default(false),
    })
    .superRefine((value, ctx) => {
      if (value.enabled && !value.baseUrl) {
        ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "is required when webConsole is enabled" });
      }
      if (value.oauth) {
        let valid = false;
        try {
          const base = new URL(value.baseUrl ?? "");
          const expected = new URL(base);
          expected.pathname = `${base.pathname.replace(/\/$/, "")}/oauth/callback`;
          const callback = new URL(value.oauth.callbackUrl);
          valid = value.enabled && base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash
            && callback.toString() === expected.toString() && value.oauth.callbackUrl === expected.toString();
        } catch { /* Normal URL validation supplies details. */ }
        if (!valid) ctx.addIssue({ code: "custom", path: ["oauth", "callbackUrl"], message: "requires enabled HTTPS webConsole and its exact baseUrl + /oauth/callback (no credentials/query/fragment)" });
      }
      if (value.baseUrl) {
        try {
          const parsed = new URL(value.baseUrl);
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
            ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "must be an http(s) URL without credentials, a query, or a fragment" });
          }
        } catch {
          // `z.string().url()` reports this in the normal validation result.
        }
      }
    })
    .prefault({}),
  ui: z
    .object({
      /**
       * Reaction added to your message while the agent works, then removed.
       * Slack has no typing indicator for bots, so this is the acknowledgement.
       * Needs the `reactions:write` scope. Name it without colons.
       */
      ackEmoji: z.string().default("hourglass_flowing_sand"),
      /**
       * Show what the agent is doing while it works.
       *
       * `true` shows thinking/tool status as soon as the turn starts thinking
       * or a tool starts. `"long_running"` holds it back until the turn has
       * produced nothing for `toolActivityAfterMs`, so a quick answer stays
       * clean and only a turn that has gone quiet long enough to look stuck
       * explains itself. `false` never shows it.
       */
      showToolActivity: z.union([z.boolean(), z.literal("long_running")]).default(true),
      /**
       * How long a turn must go without producing text before
       * `showToolActivity: long_running` starts reporting it.
       */
      toolActivityAfterMs: z.number().int().positive().default(10_000),
      /**
       * What the thread shows while a subagent works. `all`: a post when work is handed over, the subagent's own short
       * updates as it goes, and a closing line when it is done. `handoffs`: only the hand-off and the closing line.
       * `off`: nothing but the channel agent's own answer.
       */
      subagentProgress: z.enum(["all", "handoffs", "off"]).default("all"),
    })
    .prefault({}),
}).superRefine((value, ctx) => {
  if (value.keychain) {
    for (const message of keychainIsolationIssues(value)) {
      ctx.addIssue({ code: "custom", path: ["keychain"], message });
    }
  }
  for (const message of openBaoIsolationIssues(value)) {
    ctx.addIssue({ code: "custom", path: ["openbao"], message });
  }
  // The registry is definition-only. In particular, account defaults cannot
  // turn a named host command into ambient authority for every channel.
  if (value.defaults.exec.shared.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["defaults", "exec", "shared"],
      message: "shared CLI tools must be allowlisted per channel under channels.<name>.exec.shared",
    });
  }

  // Admin channel: exactly zero or one.
  const admins = Object.entries(value.channels).filter(([, c]) => c.admin === true).map(([n]) => n);
  if (admins.length > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["channels", admins[1]!, "admin"],
      message: `at most one channel may set admin: true (found ${admins.map((n) => `"${n}"`).join(", ")})`,
    });
  }

  // Skill collections: the flat catalogue is gone; assignments are unique.
  const shareScopes: [(string | number)[], z.infer<typeof ShareSchema>][] = [
    [["defaults", "share"], value.defaults.share],
    ...Object.entries(value.channels).map(([n, c]): [(string | number)[], z.infer<typeof ShareSchema>] => [["channels", n, "share"], c.share]),
  ];
  for (const [path, share] of shareScopes) {
    if (share.skills.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "skills"],
        message:
          "share.skills was replaced by share.skillCollections. Move each skill into a collection " +
          "(data/shared/skills/<collection>/<skill>/, see `npm run migrate-skills`) and assign the " +
          "collection with share.skillCollections: [{ name: <collection>, mode: ro }]",
      });
    }
    const seenCollections = new Set<string>();
    share.skillCollections.forEach((assignment, index) => {
      if (seenCollections.has(assignment.name)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "skillCollections", index],
          message: `skill collection "${assignment.name}" is assigned more than once`,
        });
      }
      seenCollections.add(assignment.name);
    });
  }

  for (const [path, share] of shareScopes) {
    const seenBases = new Set<string>();
    share.knowledgeBases.forEach((name, index) => {
      if (!value.knowledgeBases[name]) {
        ctx.addIssue({ code: "custom", path: [...path, "knowledgeBases", index], message: `no knowledgeBases entry named "${name}"` });
      }
      if (seenBases.has(name)) {
        ctx.addIssue({ code: "custom", path: [...path, "knowledgeBases", index], message: `knowledge base "${name}" is linked more than once` });
      }
      seenBases.add(name);
    });
  }

  if (value.defaults.share.postAs !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["defaults", "share", "postAs"],
      message: "share.postAs is a channel setting: set it on the one channel that may post as a person, never in defaults",
    });
  }

  // Built-in roles cannot be shadowed by an agent set.
  for (const [setName, set] of Object.entries(value.agentSets)) {
    for (const role of ["librarian", "channelConfigurator", "harnessConfigurator"]) {
      if (Object.hasOwn(set.agents, role)) {
        ctx.addIssue({ code: "custom", path: ["agentSets", setName, "agents", role], message: `"${role}" is a built-in ${role === "librarian" ? "knowledge base subagent" : "configuration subagent"}; name this role something else` });
      }
    }
  }

  // Agent sets: a channel names one set, and may only narrow it.
  for (const [channelName, channel] of Object.entries(value.channels)) {
    const at = (...rest: (string | number)[]) => ["channels", channelName, ...rest];
    const overrides = Object.entries(channel.agentOverrides);
    const postAs = channel.share.postAs;
    if (postAs) {
      const reviewerPath = at("share", "postAs", "reviewer");
      const role = channel.agentSet === undefined ? undefined : value.agentSets[channel.agentSet]?.agents[postAs.reviewer];
      if (channel.agentSet === undefined) {
        ctx.addIssue({ code: "custom", path: reviewerPath, message: "postAs needs an agentSet that holds the reviewer role" });
      } else if (value.agentSets[channel.agentSet] && !role) {
        ctx.addIssue({ code: "custom", path: reviewerPath, message: `agent set "${channel.agentSet}" has no agent "${postAs.reviewer}" to review posts` });
      } else if (role) {
        if (role.tools.length > 0) ctx.addIssue({ code: "custom", path: reviewerPath, message: `the reviewer "${postAs.reviewer}" must have no tools` });
        if (role.connectors.length > 0) ctx.addIssue({ code: "custom", path: reviewerPath, message: `the reviewer "${postAs.reviewer}" must have no connectors` });
      }
    }
    if (channel.agentSet === undefined) {
      if (overrides.length > 0) {
        ctx.addIssue({ code: "custom", path: at("agentOverrides"), message: "agentOverrides needs an agentSet to narrow" });
      }
      continue;
    }
    const set = value.agentSets[channel.agentSet];
    if (!set) {
      ctx.addIssue({ code: "custom", path: at("agentSet"), message: `no agentSets entry named "${channel.agentSet}"` });
      continue;
    }
    for (const [agentName, override] of overrides) {
      const agent = set.agents[agentName];
      if (!agent) {
        ctx.addIssue({ code: "custom", path: at("agentOverrides", agentName), message: `agent set "${channel.agentSet}" has no agent "${agentName}"` });
        continue;
      }
      for (const tool of override.tools ?? []) {
        if (!agent.tools.includes(tool)) {
          ctx.addIssue({ code: "custom", path: at("agentOverrides", agentName, "tools"), message: `"${tool}" is not granted by the agent set, and a channel can only narrow it` });
        }
      }
      for (const connector of override.connectors ?? []) {
        if (!agent.connectors.includes(connector)) {
          ctx.addIssue({ code: "custom", path: at("agentOverrides", agentName, "connectors"), message: `connector "${connector}" is not granted by the agent set, and a channel can only narrow it` });
        }
      }
    }
  }

  for (const [channelName, channel] of Object.entries(value.channels)) {
    const requested = channel.exec?.shared ?? [];
    const seen = new Set<string>();
    for (let index = 0; index < requested.length; index++) {
      const name = requested[index]!;
      const path = ["channels", channelName, "exec", "shared", index] as (string | number)[];
      if (seen.has(name)) {
        ctx.addIssue({ code: "custom", path, message: `shared CLI tool "${name}" is listed more than once` });
      }
      seen.add(name);
      if (!Object.hasOwn(value.cliTools, name)) {
        ctx.addIssue({ code: "custom", path, message: `no account-wide cliTools entry named "${name}"` });
      }
      // Both variants become cli__<name>. Compare generated tool names, not
      // raw config keys: a local `foo.bar` and registry `foo_bar` otherwise
      // silently register two definitions named `cli__foo_bar`.
      const sharedToolName = cliToolName(name);
      const localNames = [...Object.keys(value.defaults.exec.commands), ...Object.keys(channel.exec?.commands ?? {})];
      const collidingLocal = localNames.find((localName) => cliToolName(localName) === sharedToolName);
      if (collidingLocal) {
        ctx.addIssue({
          code: "custom",
          path,
          message:
            `shared CLI tool "${name}" conflicts with local exec.commands entry "${collidingLocal}": ` +
            `both become ${sharedToolName}`,
        });
      }
    }
  }
});
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
