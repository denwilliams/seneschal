import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { channelOverview } from "./data.ts";
import { executionEnvironment, toolExecution } from "./execution.ts";
import { ConsoleLinks } from "./links.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import { createJobService } from "../jobs/service.ts";
import type { ConnectorView, ExtendResponse, JobDefinitionView, SkillView, ToolView, ToolsResponse } from "./api-types.ts";
import type { Console2Source } from "./source.ts";

const BUILTIN = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "exec", "web", "images", "web_fetch", "web_search"]);

function sanitized(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Where a tool name comes from. Connector tools are `<connector>__<tool>`; the rest are told apart by their prefix. */
export function classifyTool(name: string, connectors: readonly string[]): ToolView {
  const connector = connectors.find((c) => name.startsWith(`${sanitized(c).slice(0, 40)}__`) || name.startsWith(`${sanitized(c)}__`));
  if (connector) return { name, group: "connector", connector };
  if (BUILTIN.has(name)) return { name, group: "builtin" };
  if (/^(kb_|knowledge)/.test(name)) return { name, group: "knowledge" };
  if (/schedule|remind|heartbeat/.test(name)) return { name, group: "schedules" };
  if (/memory|remember|dream/.test(name)) return { name, group: "memory" };
  if (/subagent|delegate|librarian|run_agent|handoff/.test(name)) return { name, group: "subagents" };
  if (/^(slack|post_|send_|react|thread|channel)/.test(name) || /slack/.test(name)) return { name, group: "slack" };
  if (/file|document|attachment|artifact|workspace|library|sqlite/.test(name)) return { name, group: "files" };
  return { name, group: "other" };
}

function connectorViews(source: Console2Source, channel: ResolvedChannel | undefined, registered: readonly string[] | undefined, connectable: readonly string[]): ConnectorView[] {
  const links = new ConsoleLinks(source.baseUrl);
  return (channel?.connectors ?? []).map((connector) => {
    const isConnectable = connectable.includes(connector.name);
    return {
      name: connector.name, transport: connector.config.transport,
      toolsLoaded: registered ? registered.some((tool) => tool.startsWith(`${sanitized(connector.name)}__`)) : false,
      connectable: isConnectable,
      ...(isConnectable && channel ? { connectUrl: links.connectorConnect(channel.ref.id, connector.name) } : {}),
    };
  });
}

/** The Tools tab: what the agent holds. Registered names when the store is open; the configured set otherwise. */
export function buildTools(source: Console2Source, channel: ChannelRecord, threadKey: string | undefined): ToolsResponse {
  const resolved = source.resolve(channel);
  const runtime = source.runtime(channel.id);
  const overview = channelOverview(source, channel, 0);
  const registered = runtime?.store.registeredToolNames();
  const connectorNames = (resolved?.connectors ?? []).map((c) => c.name);
  const configured = [...(overview.settings?.tools ?? [])];
  const names = registered ?? configured;
  const execution = executionEnvironment(resolved, runtime?.channel);
  return {
    channelId: channel.id, ...(threadKey ? { threadKey } : {}), live: runtime !== undefined,
    execution,
    tools: [...new Set(names)].sort().map((name) => {
      const tool = classifyTool(name, connectorNames);
      return { ...tool, execution: toolExecution(tool, execution.toolMode) };
    }),
    configured, connectors: connectorViews(source, resolved, registered, overview.settings?.connectableConnectors ?? []),
  };
}

function skillNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md"))).sort();
  } catch {
    return [];
  }
}

function dirNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith(".") && statSync(join(dir, name)).isDirectory()).sort();
  } catch {
    return [];
  }
}

/**
 * The Extend tab: skills by where they come from, collections and their mode, connectors, subagents and knowledge. Names
 * only: no skill bodies, no connector URLs or credentials.
 */
export function buildExtend(source: Console2Source, channel: ChannelRecord): ExtendResponse {
  const resolved = source.resolve(channel);
  if (!resolved) {
    return { channelId: channel.id, jobs: [], skills: [], collections: [], connectors: [], subagents: [], knowledgeBases: [], knowledgeFiles: [] };
  }
  const skills: SkillView[] = skillNames(resolved.paths.skills).map((name) => ({ name, source: "channel" }));
  const collections = resolved.skillCollections.map((collection) => {
    const names = skillNames(collection.dir);
    for (const name of names) skills.push({ name, source: "collection", collection: collection.name, mode: collection.mode });
    return { name: collection.name, mode: collection.mode, skills: names.length };
  });
  if (resolved.library.canRead) for (const name of dirNames(resolved.shared.library)) skills.push({ name, source: "library" });
  const overview = channelOverview(source, channel, 0);
  const collectionDirs = new Set(resolved.skillCollections.map((collection) => collection.dir));
  for (const dir of resolved.skillPaths) {
    if (dir === resolved.paths.skills || collectionDirs.has(dir)) continue;
    for (const name of skillNames(dir)) skills.push({ name, source: "builtin" });
  }
  // Definitions need no store: they come from the channel's own configuration.
  const jobs: JobDefinitionView[] = createJobService({ channel: resolved, store: () => undefined, threadKey: "", currentUserId: () => "" }).list().map((job) => ({
    name: job.name, ...(job.description ? { description: job.description } : {}),
    inputs: job.inputs.map((input) => ({ name: input.name, required: input.required, ...(input.default !== undefined ? { default: input.default } : {}) })),
    phases: job.phases.map((phase) => ({ name: phase.name, kind: phase.kind as "exec" | "state" })),
    available: job.available, ...(job.problem ? { problem: job.problem } : {}),
  }));
  return {
    channelId: channel.id, jobs, skills, collections,
    connectors: connectorViews(source, resolved, source.runtime(channel.id)?.store.registeredToolNames(), overview.settings?.connectableConnectors ?? []),
    subagents: resolved.agents.map((agent) => ({ name: agent.name, model: agent.model, ...(agent.description ? { description: agent.description } : {}) })),
    ...(resolved.agentSet ? { agentSet: resolved.agentSet } : {}),
    knowledgeBases: resolved.knowledgeBases.map((kb) => ({ name: kb.name })),
    knowledgeFiles: resolved.knowledge.map((file) => ({ name: file.name })),
  };
}
