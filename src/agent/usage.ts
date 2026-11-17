import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { SharedPaths } from "../workspace/paths.ts";

/**
 * Append-only token/cost accounting for harness model calls.
 *
 * This is intentionally JSONL rather than a database: it is durable across
 * restarts, cheap to append from observed model responses, and easy for an operator to
 * inspect or back up. Reports are derived from the log so later report shapes
 * can be added without migrating counters.
 */

export type UsageSource = "agent" | "dream" | "recent-conversation" | "subagent" | "post-guard" | "heartbeat" | "scheduled";

const USAGE_SOURCES = new Set<UsageSource>(["agent", "dream", "recent-conversation", "subagent", "post-guard", "heartbeat", "scheduled"]);

export interface UsageCostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageLogRecord {
  version: 1;
  at: string;
  channelId: string;
  channelName?: string;
  threadKey?: string;
  source: UsageSource;
  provider: string;
  model: string;
  responseModel?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  /** Provider/native total when available; otherwise the sum of token buckets. */
  totalTokens: number;
  /** Undefined means the provider/runtime did not report enough pricing data. */
  costUsd?: number;
  cost?: UsageCostBreakdown;
}

export interface UsageLogInput {
  at?: Date;
  channelId: string;
  channelName?: string;
  threadKey?: string;
  source: UsageSource;
  provider: string;
  model: string;
  responseModel?: string;
  usage: Usage;
}

export interface UsageQuery {
  channelId?: string;
  since?: Date;
  until?: Date;
  sources?: readonly UsageSource[];
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Sum of calls with known cost only. */
  costUsd: number;
  unknownCostCalls: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageSummary extends UsageTotals {
  records: UsageLogRecord[];
  byChannel: UsageGroup[];
  byModel: UsageGroup[];
  byDay: UsageGroup[];
}

export interface UsageWindow {
  since?: Date;
  until?: Date;
  label: string;
}

export function usageLogPath(shared: SharedPaths): string {
  return shared.usageLog;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isUsageSource(value: unknown): value is UsageSource {
  return typeof value === "string" && USAGE_SOURCES.has(value as UsageSource);
}

function isParseableDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function totalFromUsage(usage: Usage): number {
  const native = finite(usage.totalTokens);
  if (native > 0) return native;
  return finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
}

function hasReportedCost(usage: Usage): usage is Usage & { cost: UsageCostBreakdown } {
  const cost = (usage as { cost?: UsageCostBreakdown }).cost;
  return Boolean(
    cost &&
      isNonNegativeFinite(cost.input) &&
      isNonNegativeFinite(cost.output) &&
      isNonNegativeFinite(cost.cacheRead) &&
      isNonNegativeFinite(cost.cacheWrite) &&
      isNonNegativeFinite(cost.total),
  );
}

export function usageRecord(input: UsageLogInput): UsageLogRecord {
  const cost = hasReportedCost(input.usage) ? input.usage.cost : undefined;
  return {
    version: 1,
    at: (input.at ?? new Date()).toISOString(),
    channelId: input.channelId,
    ...(input.channelName ? { channelName: input.channelName } : {}),
    ...(input.threadKey ? { threadKey: input.threadKey } : {}),
    source: input.source,
    provider: input.provider,
    model: input.model,
    ...(input.responseModel ? { responseModel: input.responseModel } : {}),
    inputTokens: finite(input.usage.input),
    outputTokens: finite(input.usage.output),
    cacheReadTokens: finite(input.usage.cacheRead),
    cacheWriteTokens: finite(input.usage.cacheWrite),
    ...(input.usage.reasoning !== undefined ? { reasoningTokens: finite(input.usage.reasoning) } : {}),
    totalTokens: totalFromUsage(input.usage),
    ...(cost
      ? {
          costUsd: cost.total,
          cost: {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cacheRead,
            cacheWrite: cost.cacheWrite,
            total: cost.total,
          },
        }
      : {}),
  };
}

function isCostBreakdown(value: unknown): value is UsageCostBreakdown {
  const cost = value as UsageCostBreakdown;
  return Boolean(
    cost &&
      isNonNegativeFinite(cost.input) &&
      isNonNegativeFinite(cost.output) &&
      isNonNegativeFinite(cost.cacheRead) &&
      isNonNegativeFinite(cost.cacheWrite) &&
      isNonNegativeFinite(cost.total),
  );
}

function isRecord(value: unknown): value is UsageLogRecord {
  const r = value as UsageLogRecord;
  return Boolean(
    r &&
      r.version === 1 &&
      typeof r.at === "string" &&
      isParseableDate(r.at) &&
      typeof r.channelId === "string" &&
      optionalString(r.channelName) &&
      optionalString(r.threadKey) &&
      isUsageSource(r.source) &&
      typeof r.provider === "string" &&
      typeof r.model === "string" &&
      optionalString(r.responseModel) &&
      isNonNegativeFinite(r.inputTokens) &&
      isNonNegativeFinite(r.outputTokens) &&
      isNonNegativeFinite(r.cacheReadTokens) &&
      isNonNegativeFinite(r.cacheWriteTokens) &&
      (r.reasoningTokens === undefined || isNonNegativeFinite(r.reasoningTokens)) &&
      isNonNegativeFinite(r.totalTokens) &&
      (r.costUsd === undefined || isNonNegativeFinite(r.costUsd)) &&
      (r.cost === undefined || isCostBreakdown(r.cost)),
  );
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export class UsageLog {
  readonly path: string;

  constructor(shared: SharedPaths) {
    this.path = usageLogPath(shared);
  }

  append(input: UsageLogInput): UsageLogRecord {
    const record = usageRecord(input);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    return record;
  }

  appendAssistantMessage(input: {
    at?: Date;
    channelId: string;
    channelName?: string;
    threadKey?: string;
    source: UsageSource;
    message: AssistantMessage;
  }): UsageLogRecord | undefined {
    if (!input.message.usage) return undefined;
    return this.append({
      at: input.at,
      channelId: input.channelId,
      channelName: input.channelName,
      threadKey: input.threadKey,
      source: input.source,
      provider: input.message.provider,
      model: input.message.model,
      responseModel: input.message.responseModel,
      usage: input.message.usage,
    });
  }

  read(): UsageLogRecord[] {
    let text = "";
    try {
      text = readFileSync(this.path, "utf-8");
    } catch (err) {
      if (isMissingFile(err)) return [];
      throw err;
    }
    const records: UsageLogRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // Leave bad lines in place for forensic inspection, but do not let one
        // partial append break every report.
      }
    }
    return records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  query(query: UsageQuery = {}): UsageLogRecord[] {
    const since = query.since?.getTime();
    const until = query.until?.getTime();
    const sources = query.sources ? new Set(query.sources) : undefined;
    return this.read().filter((record) => {
      if (query.channelId && record.channelId !== query.channelId) return false;
      if (sources && !sources.has(record.source)) return false;
      const at = Date.parse(record.at);
      if (Number.isFinite(since) && at < since!) return false;
      if (Number.isFinite(until) && at >= until!) return false;
      return true;
    });
  }

  summarize(query: UsageQuery = {}): UsageSummary {
    return summarizeUsage(this.query(query));
  }
}

function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unknownCostCalls: 0,
  };
}

function addRecord(totals: UsageTotals, record: UsageLogRecord): void {
  totals.calls += 1;
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cacheReadTokens += record.cacheReadTokens;
  totals.cacheWriteTokens += record.cacheWriteTokens;
  totals.reasoningTokens += record.reasoningTokens ?? 0;
  totals.totalTokens += record.totalTokens;
  if (record.costUsd === undefined) totals.unknownCostCalls += 1;
  else totals.costUsd += record.costUsd;
}

function groupBy(
  records: readonly UsageLogRecord[],
  keyOf: (record: UsageLogRecord) => { key: string; label: string },
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const record of records) {
    const { key, label } = keyOf(record);
    let group = groups.get(key);
    if (!group) {
      group = { key, label, ...emptyTotals() };
      groups.set(key, group);
    }
    addRecord(group, record);
  }
  return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));
}

export function summarizeUsage(records: readonly UsageLogRecord[]): UsageSummary {
  const totals = emptyTotals();
  for (const record of records) addRecord(totals, record);
  return {
    ...totals,
    records: [...records],
    byChannel: groupBy(records, (r) => ({
      key: r.channelId,
      label: r.channelName ? `#${r.channelName}` : r.channelId,
    })),
    byModel: groupBy(records, (r) => ({
      key: `${r.provider}/${r.model}`,
      label: `${r.provider}/${r.model}`,
    })),
    byDay: groupBy(records, (r) => {
      const day = r.at.slice(0, 10);
      return { key: day, label: day };
    }).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function parseUsageWindow(value: string | undefined, now = new Date()): UsageWindow {
  const arg = value?.trim().toLowerCase();
  if (!arg || arg === "7d") {
    return { since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), until: now, label: "last 7 days" };
  }
  if (arg === "all") return { until: now, label: "all time" };
  if (arg === "today") {
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    return { since, until: now, label: "today" };
  }

  const match = arg.match(/^(\d+)([hdw])$/);
  if (!match) throw new Error("Usage: `!usage [today|24h|7d|30d|all]` or `!usage channels [window]`.");
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error("Usage window must be a positive number, like `24h`, `7d`, or `4w`.");
  }
  const unit = match[2];
  const hours = unit === "h" ? count : unit === "d" ? count * 24 : count * 7 * 24;
  return {
    since: new Date(now.getTime() - hours * 60 * 60 * 1000),
    until: now,
    label: `last ${count}${unit}`,
  };
}

export function formatTokenCount(value: number): string {
  if (value < 1000) return Math.round(value).toString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}

export function formatUsageCost(value: number, unknownCalls = 0): string {
  const amount = value === 0 ? "$0" : Math.abs(value) < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  return unknownCalls > 0 ? `${amount} + ${unknownCalls} unknown` : amount;
}

function groupLine(group: UsageGroup): string {
  const cache = group.cacheReadTokens || group.cacheWriteTokens
    ? `, cache R/W ${formatTokenCount(group.cacheReadTokens)}/${formatTokenCount(group.cacheWriteTokens)}`
    : "";
  return `• ${group.label}: ${formatTokenCount(group.totalTokens)} total (` +
    `↑${formatTokenCount(group.inputTokens)} ↓${formatTokenCount(group.outputTokens)}${cache}), ` +
    `${formatUsageCost(group.costUsd, group.unknownCostCalls)} across ${group.calls} call${group.calls === 1 ? "" : "s"}`;
}

export function formatUsageReport(input: {
  summary: UsageSummary;
  window: UsageWindow;
  scopeLabel: string;
  maxGroups?: number;
}): string {
  const { summary, window, scopeLabel } = input;
  const maxGroups = input.maxGroups ?? 8;
  if (summary.calls === 0) return `_No token usage recorded for ${scopeLabel} in ${window.label}._`;

  const cache = summary.cacheReadTokens || summary.cacheWriteTokens
    ? `, cache R/W ${formatTokenCount(summary.cacheReadTokens)}/${formatTokenCount(summary.cacheWriteTokens)}`
    : "";
  const lines = [
    `*Token usage — ${scopeLabel}, ${window.label}*`,
    `${formatTokenCount(summary.totalTokens)} total tokens (` +
      `↑${formatTokenCount(summary.inputTokens)} ↓${formatTokenCount(summary.outputTokens)}${cache})`,
    `${formatUsageCost(summary.costUsd, summary.unknownCostCalls)} estimated across ` +
      `${summary.calls} model call${summary.calls === 1 ? "" : "s"}.`,
  ];

  if (summary.byChannel.length > 1) {
    lines.push("", "*By channel*", ...summary.byChannel.slice(0, maxGroups).map(groupLine));
    if (summary.byChannel.length > maxGroups) lines.push(`_…and ${summary.byChannel.length - maxGroups} more channel(s)._`);
  }

  if (summary.byModel.length > 0) {
    lines.push("", "*By model*", ...summary.byModel.slice(0, maxGroups).map(groupLine));
    if (summary.byModel.length > maxGroups) lines.push(`_…and ${summary.byModel.length - maxGroups} more model(s)._`);
  }

  return lines.join("\n");
}
