import type { ChannelRecord } from "../workspace/registry.ts";
import { isTerminal, type TaskRecord, type TaskStatusStore } from "../tasks/store.ts";

/** What the web server's `/api/status` reads: durable tasks plus every known or configured channel. */
export interface StatusSource { tasks: TaskStatusStore; channels: () => ChannelRecord[]; configuredChannels: () => string[] }

export function expectedLinkLabel(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname === "github.com" && parts.length >= 2) {
      const repository = `${parts[0]}/${parts[1]}`;
      if (parts[2] === "pull" && /^\d+$/.test(parts[3] ?? "")) return `PR ${repository}#${parts[3]}`;
      if (parts[2] === "issues" && /^\d+$/.test(parts[3] ?? "")) return `Issue ${repository}#${parts[3]}`;
      if (parts[2] === "commit" && /^[0-9a-f]+$/i.test(parts[3] ?? "")) return `Commit ${repository}@${parts[3]!.slice(0, 7)}`;
      return `GitHub ${repository}`;
    }
    if ((parsed.hostname === "slack.com" || parsed.hostname.endsWith(".slack.com")) && parts[0] === "archives" && /^p\d+$/.test(parts[2] ?? "")) return "Slack thread";
  } catch { /* Fall back to the stored URL below. */ }
  return undefined;
}

function displayTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    ...(task.links ? { links: task.links.map((link) => ({ ...link, label: link.label ?? expectedLinkLabel(link.url) })) } : {}),
  };
}

/** Registry channels plus configured keys not yet seen, so config-only channels still appear. */
export function mergeChannelRecords(seen: ChannelRecord[], configuredKeys: string[]): Map<string, ChannelRecord> {
  const records = new Map(seen.map((channel) => [channel.id, channel]));
  for (const key of configuredKeys) {
    const name = key.startsWith("#") ? key.slice(1) : key;
    if (records.has(key) || [...records.values()].some((channel) => channel.name === name)) continue;
    records.set(key, { id: key, name: key.startsWith("C") || key.startsWith("D") || key.startsWith("G") ? undefined : name, isDm: key.startsWith("D"), firstSeen: "", lastSeen: "" });
  }
  return records;
}

/** The `/api/status` body: every channel's state and work, plus global active work and recent terminal history. */
export function statusSnapshot(source: StatusSource, historyLimit = 100): object {
  const tasks = source.tasks.all().map(displayTask).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const records = mergeChannelRecords(source.channels(), source.configuredChannels());
  const channels = [...records.values()].map((channel) => {
    const history = tasks.filter((task) => task.channelId === channel.id || (channel.name !== undefined && task.channelName === channel.name));
    const active = history.filter((task) => !isTerminal(task.status));
    return { ...channel, state: active.some((task) => task.status === "blocked") ? "blocked" : active.some((task) => task.status === "waiting") ? "waiting" : active.length ? "active" : "idle", active, history: history.slice(0, historyLimit) };
  }).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  return { generatedAt: new Date().toISOString(), channels, active: tasks.filter((task) => !isTerminal(task.status)), history: tasks.filter((task) => isTerminal(task.status)).slice(0, historyLimit) };
}
