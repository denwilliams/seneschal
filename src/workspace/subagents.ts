import { join } from "node:path";
import type {
  ChannelConfig,
  HarnessConfig,
  LibrarianConfig,
  SubagentConfig,
  ToolName,
} from "../config/schema.ts";
import { AGENT_SET_SKILLS_DIR } from "../agent/skills.ts";
import { logger } from "../util/log.ts";
import type { ResolvedChannel } from "./resolve.ts";

/**
 * Subagents, as one channel sees them.
 *
 * An agent set says what a role WANTS; the channel decides what it GETS. The effective capability of a
 * subagent is therefore always an intersection: what the set grants, narrowed by the channel's own
 * overrides, and then limited to what the channel itself holds. A set can never hand a role a tool or
 * a credential the channel does not have, and a channel can only take things away from a role, never add.
 */

export interface ResolvedSubagent {
  name: string;
  description: string;
  instructions?: string;
  /** `provider/id` or bare id, as written in config; defaults to the channel's model. */
  model: string;
  thinkingLevel: ResolvedChannel["thinkingLevel"];
  /** Built-in/harness tools this worker is offered. */
  tools: ToolName[];
  /** Names of channel connectors this worker is offered. */
  connectors: string[];
  timeoutSeconds: number;
  /** Runs only while `subagent:<name>` is granted in the channel. */
  requireApproval: boolean;
  /** Offered the channel's knowledge base tools. Only the built-in librarian is. */
  knowledge?: boolean;
  /** Host-only marker; only the opt-in built-in roles receive configuration tools. */
  configuration?: "channel" | "harness";
}

/** The built-in subagent that does knowledge base research on the channel agent's behalf. */
export const LIBRARIAN = "librarian";

const LIBRARIAN_INSTRUCTIONS = [
  "You are the librarian for this channel's knowledge bases: read-only wikis of markdown pages, with index pages that say what is beneath them.",
  "You answer one question or gather one body of material per brief, using `kb_read`, `kb_ls` and `kb_search`, and report back what you found.",
  "",
  "- Start from the index (`kb_read` with no path) when you do not know the shape of the wiki, or search when you know what you want. Follow links; open pages before you rely on them, because a search snippet is not the page.",
  "- If a search finds nothing, try other words the wiki might use before you say the answer is not there. If it is genuinely not there, say that, and say what you looked at.",
  "- Report the answer first, then where it came from: the knowledge base and page path for every claim, so the assistant can cite it or open the page itself.",
  "- Quote exact figures, names, commands and wording rather than paraphrasing them. Do not pad the report with page contents the question did not need.",
  "- Report what the wiki says, including when pages disagree or look out of date. Do not fill gaps from your own general knowledge; if you do add something the wiki does not say, mark it plainly as not from the wiki.",
].join("\n");

export function librarianRole(
  config: LibrarianConfig,
  channelModel: string,
  channelThinking: ResolvedChannel["thinkingLevel"],
): ResolvedSubagent {
  return {
    name: LIBRARIAN,
    description:
      "Researches the channel's knowledge bases for you: give it a question, it searches and walks the wiki and comes back with a curated answer and the pages it came from. Use it for anything that needs more than one lookup, so the pages it reads stay out of your context.",
    instructions: LIBRARIAN_INSTRUCTIONS,
    model: config.model ?? channelModel,
    thinkingLevel: config.thinkingLevel ?? channelThinking,
    tools: [],
    connectors: [],
    timeoutSeconds: config.timeoutSeconds,
    requireApproval: false,
    knowledge: true,
  };
}

export function configuratorRoles(entry: ChannelConfig | undefined, model: string, thinkingLevel: ResolvedChannel["thinkingLevel"]): ResolvedSubagent[] {
  return (["channel", "harness"] as const).filter((scope) => entry?.configurators[scope]).map((scope) => ({
    name: scope === "channel" ? "channelConfigurator" : "harnessConfigurator",
    description: scope === "channel" ? "Safely inspect and configure this channel's non-security settings." : "Administer configuration across the whole harness. This is operator-level authority.",
    instructions: "Use config_get before editing. Paths start at the harness root. Use config_validate to check a batch, then config_save with the revision from config_get. Saves automatically back up and reload; config_backup also makes an explicit backup. Never write literal credentials: preserve environment references. Report persisted/applied status, reload warnings, restart requirements and any failure accurately. Do not work around scope refusals.",
    model, thinkingLevel, tools: [], connectors: [], timeoutSeconds: 900, requireApproval: false, configuration: scope,
  }));
}

export interface ResolvedAgentSet {
  name: string;
  agents: ResolvedSubagent[];
  /** Why part of a role's request was left out (a connector the channel does not have, ...). Names only. */
  notes: string[];
}

/** Directory of skills shipped with the harness for an agent set, e.g. the factory's orchestration skills. */
export function agentSetSkillsDir(setName: string): string {
  return join(AGENT_SET_SKILLS_DIR, setName);
}

const intersect = <T>(wanted: readonly T[], held: readonly T[]): T[] => wanted.filter((item) => held.includes(item));

export function resolveAgentSet(input: {
  config: HarnessConfig;
  entry: ChannelConfig | undefined;
  channelTools: readonly ToolName[];
  channelConnectors: readonly string[];
  channelModel: string;
  channelThinking: ResolvedChannel["thinkingLevel"];
  channelLabel: string;
}): ResolvedAgentSet | undefined {
  const setName = input.entry?.agentSet;
  if (!setName) return undefined;
  const set = input.config.agentSets[setName];
  if (!set) {
    // Config validation rejects this; a hot-reloaded or hand-built config must not take the channel down.
    logger.warn(`${input.channelLabel}: agent set "${setName}" is not defined; no subagents`);
    return undefined;
  }
  const notes: string[] = [];
  const agents: ResolvedSubagent[] = [];
  for (const [name, definition] of Object.entries(set.agents) as [string, SubagentConfig][]) {
    // The post_as_user reviewer runs only as that tool's reviewer, never as a subagent the channel agent can hand work to.
    if (name === input.entry?.share.postAs?.reviewer) continue;
    const override = input.entry?.agentOverrides[name];
    if (override?.enabled === false) continue;
    const grantedTools = override?.tools ? intersect(definition.tools, override.tools) : definition.tools;
    const grantedConnectors = override?.connectors ? intersect(definition.connectors, override.connectors) : definition.connectors;
    const tools = intersect(grantedTools, input.channelTools);
    const connectors = intersect(grantedConnectors, input.channelConnectors);
    for (const tool of grantedTools) if (!tools.includes(tool)) notes.push(`${name}: tool "${tool}" left out, ${input.channelLabel} does not have it`);
    for (const connector of grantedConnectors) {
      if (!connectors.includes(connector)) notes.push(`${name}: connector "${connector}" left out, ${input.channelLabel} does not have it`);
    }
    agents.push({
      name,
      description: definition.description,
      ...(definition.instructions ? { instructions: definition.instructions } : {}),
      model: definition.model ?? input.channelModel,
      thinkingLevel: definition.thinkingLevel ?? input.channelThinking,
      tools,
      connectors,
      timeoutSeconds: definition.timeoutSeconds,
      requireApproval: definition.requireApproval,
    });
  }
  for (const note of notes) logger.warn(`${input.channelLabel}: ${note}`);
  return { name: setName, agents, notes };
}

/**
 * The channel as a subagent sees it: the same workspace, memory, skills and secrets (with a role-selected
 * GitHub identity), but only this role's tools and connectors, and none of the channel agent's reach outward (no scheduling, delegation, library,
 * documents, notifications, permission requests, or running subagents of its own).
 */
export function narrowChannelForAgent(channel: ResolvedChannel, agent: ResolvedSubagent): ResolvedChannel {
  // Select from this channel's already-layered secrets, never mutate the parent's merge identity,
  // and withhold every role override (including this role's) from the child environment.
  const tokenKey = `GH_TOKEN_${agent.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
  const token = channel.env[tokenKey] || channel.env.GH_TOKEN;
  const env = Object.fromEntries(Object.entries(channel.env).filter(([key]) => !key.startsWith("GH_TOKEN_")));
  if (token !== undefined) env.GH_TOKEN = token;
  return {
    ...channel,
    env,
    model: agent.model,
    models: [agent.model],
    thinkingLevel: agent.thinkingLevel,
    tools: [...agent.tools],
    connectors: channel.connectors.filter((connector) => agent.connectors.includes(connector.name)),
    admin: false,
    schedulesEnabled: false,
    dreamsEnabled: false,
    requestable: [],
    library: { canRead: false, canPublish: false },
    sharedTools: { canPublish: false, execute: {} },
    documents: { canRead: false, canAdd: false },
    // Reading the wiki is the librarian's job; other roles get what they asked for and no more.
    knowledgeBases: agent.knowledge ? channel.knowledgeBases : [],
    delegation: { targets: [] },
    // Posting as a person is the channel agent's alone, never a subagent's.
    postAs: undefined,
    slackProfile: undefined,
    notifications: { ...channel.notifications, enabled: false, canCollect: false },
    feedback: { isReviewer: false },
    memory: { ...channel.memory, canWriteShared: false },
    agents: [],
  };
}

/**
 * The capabilities a channel may ask for because its agent set says a role needs a person's approval. The set is the
 * operator's own config, so this stands in for listing them in `permissions.grantable`.
 */
export function approvalCapabilities(
  config: Pick<HarnessConfig, "agentSets">,
  entry: Pick<ChannelConfig, "agentSet" | "agentOverrides"> | undefined,
): `subagent:${string}`[] {
  const set = entry?.agentSet ? config.agentSets[entry.agentSet] : undefined;
  if (!set) return [];
  return Object.entries(set.agents)
    .filter(([name, agent]) => agent.requireApproval && entry?.agentOverrides[name]?.enabled !== false)
    .map(([name]) => `subagent:${name}` as const);
}
