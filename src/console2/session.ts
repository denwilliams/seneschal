import type { UsageLogRecord } from "../agent/usage.ts";
import { channelOverview } from "./data.ts";
import { executionEnvironment, sandboxStatus } from "./execution.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { SessionResponse, UsageRow } from "./api-types.ts";
import type { ViewLike } from "./transcript.ts";
import type { Console2Source } from "./source.ts";

const USAGE_TTL_MS = 5_000;
const usageCache = new WeakMap<object, { at: number; records: UsageLogRecord[] }>();

/** `usage.jsonl` is append-only and unbounded; parse it at most once per few seconds however many viewers ask. */
function usageRecords(source: Console2Source, now: number): UsageLogRecord[] {
  const hit = usageCache.get(source.usage);
  if (hit && now - hit.at < USAGE_TTL_MS) return hit.records;
  const records = source.usage.read();
  usageCache.set(source.usage, { at: now, records });
  return records;
}

/** Prompt tokens of the most recent request that reported usage: input plus cache reads and writes. */
export function lastPromptTokens(view: ViewLike): number | undefined {
  for (let i = view.contributions.length - 1; i >= 0; i--) {
    const messages = view.contributions[i] as readonly { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }[];
    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      if (message?.role === "assistant" && message.usage) {
        const used = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
        if (used > 0) return used;
      }
    }
  }
  return undefined;
}

export function usageSummary(records: readonly UsageLogRecord[], scope: "thread" | "channel" = "channel"): SessionResponse["usage"] {
  const rows: Record<UsageRow["type"], { tokens: number; cost: number; priced: boolean }> = {
    input: { tokens: 0, cost: 0, priced: false }, output: { tokens: 0, cost: 0, priced: false },
    cacheRead: { tokens: 0, cost: 0, priced: false }, cacheWrite: { tokens: 0, cost: 0, priced: false },
  };
  const sources = new Map<string, { source: string; calls: number; tokens: number; costUsd: number; unpricedCalls: number }>();
  // Always expose the heartbeat row, including when no model work has been needed.
  sources.set("heartbeat", { source: "heartbeat", calls: 0, tokens: 0, costUsd: 0, unpricedCalls: 0 });
  let totalTokens = 0, costUsd = 0, unpricedCalls = 0;
  for (const record of records) {
    const activity = sources.get(record.source) ?? { source: record.source, calls: 0, tokens: 0, costUsd: 0, unpricedCalls: 0 };
    activity.calls++; activity.tokens += record.totalTokens; activity.costUsd += record.costUsd ?? 0;
    if (record.costUsd === undefined) activity.unpricedCalls++;
    sources.set(record.source, activity);
    totalTokens += record.totalTokens;
    if (record.costUsd === undefined) unpricedCalls++; else costUsd += record.costUsd;
    rows.input.tokens += record.inputTokens; rows.output.tokens += record.outputTokens;
    rows.cacheRead.tokens += record.cacheReadTokens; rows.cacheWrite.tokens += record.cacheWriteTokens;
    if (record.cost) {
      for (const [type, value] of [["input", record.cost.input], ["output", record.cost.output], ["cacheRead", record.cost.cacheRead], ["cacheWrite", record.cost.cacheWrite]] as const) {
        rows[type].cost += value; rows[type].priced = true;
      }
    }
  }
  return {
    scope, calls: records.length, totalTokens, costUsd, unpricedCalls,
    bySource: [...sources.values()],
    rows: (Object.keys(rows) as UsageRow["type"][]).map((type) => ({ type, tokens: rows[type].tokens, ...(rows[type].priced ? { costUsd: rows[type].cost } : {}) })),
  };
}

/** The Session tab: model and context (from the open store, if any), usage totals and the channel's flags. */
export async function buildSession(source: Console2Source, channel: ChannelRecord, threadKey: string | undefined, now = Date.now()): Promise<SessionResponse> {
  const overview = channelOverview(source, channel, 0);
  const settings = overview.settings;
  const runtime = source.runtime(channel.id);
  const execution = executionEnvironment(source.resolve(channel), runtime?.channel);
  execution.status = await sandboxStatus(source.dataDir, channel.id, threadKey, execution, undefined, now);
  let model = settings?.model;
  let pinnedModel: boolean | undefined;
  let context: SessionResponse["context"];
  if (runtime) {
    try {
      const transcript = await runtime.store.consoleTranscript(threadKey ?? "main");
      if (transcript) {
        if (transcript.model) model = `${transcript.model.provider}/${transcript.model.modelId}`;
        if (threadKey && threadKey !== "main") pinnedModel = transcript.pinnedModel;
        const used = lastPromptTokens(transcript.view as unknown as ViewLike);
        const windowTokens = model ? source.contextWindow(model) : undefined;
        if (used !== undefined) context = { usedTokens: used, ...(windowTokens ? { windowTokens } : {}) };
      }
    } catch { /* an unreadable thread leaves the rest of the tab intact */ }
  }
  // The trunk has no usage records of its own (calls are logged against the thread that made them), so it shows the channel.
  const scoped = threadKey !== undefined && threadKey !== "main";
  const records = usageRecords(source, now).filter((record) => record.channelId === channel.id && (!scoped || record.threadKey === threadKey));
  return {
    channelId: channel.id, ...(threadKey ? { threadKey } : {}), live: runtime !== undefined,
    ...(model ? { model } : {}), thinkingLevel: settings?.thinkingLevel ?? "off",
    ...(pinnedModel !== undefined ? { pinnedModel } : {}), ...(context ? { context } : {}),
    usage: usageSummary(records, scoped ? "thread" : "channel"),
    toolCount: runtime ? runtime.store.registeredToolNames().length : settings?.tools.length ?? 0,
    execution, sandbox: settings?.sandbox ?? "unknown", allowedUsers: settings?.allowedUsers ?? "anyone", sharing: settings?.sharing ?? [],
    schedules: settings?.schedules ?? false, dreams: settings?.dreams ?? false, respondToRootMessages: settings?.respondToRootMessages ?? false,
  };
}
