import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { HarnessConfig } from "../config/schema.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { isSlackChannelId } from "../workspace/registry.ts";
import { mergeChannelRecords } from "../console/status.ts";
import { isTerminal, type TaskRecord, type TaskStatusStore } from "../tasks/store.ts";
import { ghJson, readFactoryRepository, type FactoryGitHubReader } from "../factory/tools.ts";
import type { FactoryIssue, FactoryPullRequest, FactoryRepositorySnapshot } from "../factory/dashboard.ts";
import { factoryTimelineView, SEVEN_DAYS_MS, type TimelineView } from "../factory/timeline.ts";
import { channelPaths } from "../workspace/paths.ts";
import { ChannelTimelineLog, type TimelineEvent } from "../agent/timeline.ts";

/** Everything the console reads. Getters, so a config reload is visible without restarting. */
export interface ConsoleSource {
  /** Public base URL of the web server (may carry a reverse-proxy prefix). */
  baseUrl: string;
  dataDir: string;
  config: () => HarnessConfig;
  tasks: TaskStatusStore;
  channels: () => ChannelRecord[];
  /** Resolve a known channel to its effective configuration; undefined when it is rejected. */
  resolve: (channel: ChannelRecord) => ResolvedChannel | undefined;
  /** Test seam for the GitHub CLI. */
  github?: FactoryGitHubReader;
}

export type ChannelState = "blocked" | "waiting" | "active" | "idle";

export interface ChannelListItem {
  id: string;
  name?: string;
  isDm: boolean;
  /** A configured name that has not been matched to a Slack ID yet has no page to open. */
  linkable: boolean;
  state: ChannelState;
  activeTasks: number;
  lastActivity?: string;
  factory?: string;
}

function tasksFor(tasks: TaskRecord[], channel: ChannelRecord): TaskRecord[] {
  return tasks.filter((task) => task.channelId === channel.id || (channel.name !== undefined && task.channelName === channel.name));
}

function stateOf(active: TaskRecord[]): ChannelState {
  return active.some((t) => t.status === "blocked") ? "blocked" : active.some((t) => t.status === "waiting") ? "waiting" : active.length ? "active" : "idle";
}

export function listChannels(source: ConsoleSource): ChannelListItem[] {
  const tasks = source.tasks.all();
  const config = source.config();
  const records = mergeChannelRecords(source.channels(), Object.keys(config.channels));
  return [...records.values()].map((channel) => {
    const history = tasksFor(tasks, channel);
    const active = history.filter((t) => !isTerminal(t.status));
    const lastTask = history.map((t) => t.updatedAt).sort().at(-1);
    const entry = config.channels[channel.id] ?? (channel.name ? config.channels[channel.name] ?? config.channels[`#${channel.name}`] : undefined);
    return {
      id: channel.id, name: channel.name, isDm: channel.isDm, linkable: isSlackChannelId(channel.id),
      state: stateOf(active), activeTasks: active.length,
      lastActivity: [lastTask, channel.lastSeen || undefined].filter(Boolean).sort().at(-1),
      ...(entry?.factory ? { factory: entry.factory.name } : {}),
    };
  }).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

export function findChannel(source: ConsoleSource, id: string): ChannelRecord | undefined {
  if (!isSlackChannelId(id)) return undefined;
  const known = source.channels().find((channel) => channel.id === id);
  if (known) return known;
  // Configured by ID but not yet seen in Slack.
  return source.config().channels[id] ? { id, isDm: id.startsWith("D"), firstSeen: "", lastSeen: "" } : undefined;
}

export interface ChannelSettings {
  model: string;
  thinkingLevel: string;
  tools: string[];
  sandbox: string;
  schedules: boolean;
  dreams: boolean;
  respondToRootMessages: boolean;
  /** Names only: the console never shows secret values, env keys, or allowed-user IDs. */
  connectors: string[];
  /** Supported opt-in names only, never credential/config values. */
  connectableConnectors?: string[];
  allowedUsers: number | "anyone";
  sharing: string[];
}

export interface ChannelOverview {
  channel: ChannelRecord;
  description?: string;
  rejected?: string;
  settings?: ChannelSettings;
  factory?: { name: string; repositories: string[] };
  state: ChannelState;
  active: TaskRecord[];
  recent: TaskRecord[];
  counts: Record<string, number>;
}

export function channelOverview(source: ConsoleSource, channel: ChannelRecord, historyLimit = 20): ChannelOverview {
  const history = tasksFor(source.tasks.all(), channel).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = history.filter((t) => !isTerminal(t.status));
  const counts: Record<string, number> = {};
  for (const task of history) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const resolved = source.resolve(channel);
  return {
    channel, state: stateOf(active), active, counts,
    recent: history.filter((t) => isTerminal(t.status)).slice(0, historyLimit),
    ...(resolved ? {
      description: resolved.description,
      settings: {
        model: resolved.model, thinkingLevel: resolved.thinkingLevel, tools: resolved.tools,
        sandbox: resolved.sandbox.mode, schedules: resolved.schedulesEnabled, dreams: resolved.dreamsEnabled,
        respondToRootMessages: resolved.respondToRootMessages,
        connectors: resolved.connectors.map((c) => c.name),
        connectableConnectors: resolved.connectors.filter((c) => source.config().webConsole?.oauth
          && c.config?.transport === "http" && c.config.oauth?.consoleCallback && !c.config.oauth.tokenFile
          && c.config.oauth.redirectUrl === source.config().webConsole.oauth!.callbackUrl
          && /^[A-Za-z0-9._-]+$/.test(c.name)).map((c) => c.name),
        allowedUsers: resolved.allowUsers?.length ?? "anyone",
        sharing: [
          resolved.library.canRead && "reads skill library", resolved.library.canPublish && "publishes to skill library",
          resolved.documents.canRead && "reads documents", resolved.documents.canAdd && "files documents",
          resolved.memory.sharedFile && "shared memory",
        ].filter((s): s is string => Boolean(s)),
      },
      ...(resolved.factory ? { factory: { name: resolved.factory.name, repositories: resolved.factory.repositories } } : {}),
    } : { rejected: "This channel is not configured and unconfigured channels are disabled." }),
  };
}

export interface ArtifactEntry { path: string; size: number; modified: string }

const MAX_ARTIFACTS = 500;
const MAX_DEPTH = 6;

/** Names, sizes and times only. Symlinks are never followed or listed. */
export async function listArtifacts(directory: string): Promise<{ entries: ArtifactEntry[]; truncated: boolean }> {
  const entries: ArtifactEntry[] = [];
  let truncated = false;
  async function walk(relative: string[], depth: number): Promise<void> {
    let names: string[];
    try { names = (await readdir(join(directory, ...relative))).sort(); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (entries.length >= MAX_ARTIFACTS) { truncated = true; return; }
      const info = await lstat(join(directory, ...relative, name)).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory() && depth < MAX_DEPTH) await walk([...relative, name], depth + 1);
      else if (info.isFile()) entries.push({ path: [...relative, name].join("/"), size: info.size, modified: info.mtime.toISOString() });
    }
  }
  await walk([], 0);
  return { entries, truncated };
}

export interface MergedPullRequest extends FactoryPullRequest { mergedAt: string; author?: { login?: string } }
export interface FactoryRepositoryView extends FactoryRepositorySnapshot { merged: MergedPullRequest[]; mergedError?: boolean }
export interface FactoryView { generatedAt: string; name: string; repositories: FactoryRepositoryView[] }

/** What the factory page's client receives: no raw activity, just the drawn timeline. */
export interface FactoryApiRepository {
  repository: string;
  error?: string;
  issues: FactoryIssue[];
  pullRequests: FactoryPullRequest[];
  merged: MergedPullRequest[];
  mergedError?: boolean;
  timeline?: TimelineView;
}
export interface FactoryApiResponse { generatedAt: string; name: string; repositories: FactoryApiRepository[] }

export function factoryApiResponse(view: FactoryView): FactoryApiResponse {
  return {
    generatedAt: view.generatedAt, name: view.name,
    repositories: view.repositories.map(({ activity, activityCoverage, ...repo }) => ({
      ...repo, timeline: factoryTimelineView(activity, view.generatedAt, activityCoverage),
    })),
  };
}

const CACHE_MS = 60_000;
/** A manual refresh may skip the cache, but not more than this often. */
const REFRESH_MIN_MS = 10_000;
const cache = new Map<string, { at: number; view: Promise<FactoryView> }>();

/**
 * Live, read-only GitHub view for a factory channel. Repositories come from
 * reviewed channel config, never from the request. Cached briefly and shared
 * between concurrent viewers so an auto-refreshing page cannot hammer `gh`.
 */
export function loadFactory(source: ConsoleSource, channel: ResolvedChannel, options: { refresh?: boolean; now?: number } = {}): Promise<FactoryView> {
  const now = options.now ?? Date.now();
  const key = channel.ref.id;
  const hit = cache.get(key);
  if (hit && now - hit.at < (options.refresh ? REFRESH_MIN_MS : CACHE_MS)) return hit.view;
  const factory = channel.factory!;
  const reader = source.github ?? ghJson;
  const view = Promise.all(factory.repositories.map(async (repository): Promise<FactoryRepositoryView> => {
    const [snapshot, merged] = await Promise.all([
      readFactoryRepository(repository, channel.env, reader),
      reader<MergedPullRequest[]>(channel.env, ["pr", "list", "--repo", repository, "--state", "merged", "--limit", "30", "--json", "number,title,state,updatedAt,url,mergedAt,author"]).then((rows) => ({ rows }), () => undefined),
    ]);
    const since = now - SEVEN_DAYS_MS;
    return {
      ...snapshot,
      merged: (merged?.rows ?? []).filter((pr) => Date.parse(pr.mergedAt) >= since).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)),
      ...(merged ? {} : { mergedError: true }),
    };
  })).then((repositories) => ({ generatedAt: new Date(now).toISOString(), name: factory.name, repositories }));
  cache.set(key, { at: now, view });
  void view.catch(() => cache.delete(key));
  return view;
}

/** Test seam. */
export function clearFactoryCache(): void { cache.clear(); }

const DEFAULT_TIMELINE_LIMIT = 300;
const MAX_TIMELINE_LIMIT = 1000;

export function timelineEvents(source: ConsoleSource, channelId: string, limit = DEFAULT_TIMELINE_LIMIT): TimelineEvent[] {
  const bounded = Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(limit) || DEFAULT_TIMELINE_LIMIT));
  return new ChannelTimelineLog(channelPaths(source.dataDir, channelId).root).read(bounded);
}
