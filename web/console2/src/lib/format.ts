export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < -45) return `in ${compactDuration(-seconds)}`;
  if (seconds < 45) return "just now";
  return `${compactDuration(seconds)} ago`;
}

function compactDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatCost(value: number | undefined, lowerBound = false): string {
  if (value === undefined) return "n/a";
  const text = value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
  return lowerBound ? `≥ ${text}` : text;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function clock(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
}

/** Slack-style thread keys are `<seconds>.<micros>`; show those as a short time, anything else as is. */
export function threadLabel(key: string, label: string): string {
  if (label && label !== key) return label;
  const seconds = Number(key.split(".")[0]);
  if (/^\d{9,11}\.\d+$/.test(key) && Number.isFinite(seconds)) return shortStamp(new Date(seconds * 1000).toISOString());
  return key;
}
