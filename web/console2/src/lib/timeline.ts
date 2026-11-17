import type { TimelineRowView } from "@api/api-types";

/** The same geometry as the original console's `renderGraphCell`, so the graph reads the same. */
export const LANE_W = 18;
export const ROW_H = 34;
export const PAD = 8;

/** Eight lane colours, cycled. Fixed hues that read on both the light and the dark card. */
export const LANE_COLORS = ["#4c8dd6", "#d2691e", "#2e9e6b", "#b04fb8", "#c9a227", "#d1495b", "#2fa3b8", "#7b8794"] as const;

export const laneColor = (lane: number): string => LANE_COLORS[((lane % 8) + 8) % 8]!;

export const laneX = (lane: number): number => PAD + lane * LANE_W + LANE_W / 2;

export const graphWidth = (lanes: number): number => PAD * 2 + (lanes + 1) * LANE_W;

const RING_BAD = new Set(["failed", "error", "denied", "interrupted"]);
const RING_WARN = new Set(["blocked", "needs_input", "needs-input"]);

/** The ring round a dot: red for a bad ending, amber for a stall, none otherwise. */
export function statusRing(status: string | undefined): string | undefined {
  if (!status) return undefined;
  if (RING_BAD.has(status)) return "#d1495b";
  if (RING_WARN.has(status)) return "#c9a227";
  return undefined;
}

export interface GraphPath { d: string; lane: number; dashed: boolean }
export interface GraphDot { cx: number; cy: number; r: number; lane: number; ring: string | undefined; dead: boolean }
export interface GraphCell { width: number; height: number; paths: GraphPath[]; dot: GraphDot }

type GraphInput = Pick<TimelineRowView, "lane" | "shape" | "dead" | "through" | "kind" | "status">;

/** One row's graph cell. Newest is at the top of the page, so "newer" is up and "older" is down. */
export function graphCell(row: GraphInput, lanes: number): GraphCell {
  const mid = ROW_H / 2;
  const nx = laneX(row.lane);
  const x0 = laneX(0);
  const paths: GraphPath[] = [];
  const line = (lane: number, d: string, dashed = false) => paths.push({ d, lane, dashed });
  for (const lane of row.through) line(lane, `M${laneX(lane)} 0V${ROW_H}`);
  if (row.lane === 0) {
    line(0, `M${nx} 0V${ROW_H}`);
  } else if (row.shape === "fork") {
    if (!row.dead) line(row.lane, `M${nx} ${mid}V0`);
    line(row.lane, `M${nx} ${mid}C${nx} ${ROW_H} ${x0} ${mid} ${x0} ${ROW_H}`);
  } else if (row.shape === "merge") {
    line(row.lane, `M${nx} ${mid}V${ROW_H}`);
    line(row.lane, `M${nx} ${mid}C${nx} 0 ${x0} ${mid} ${x0} 0`);
  } else if (row.dead) {
    line(row.lane, `M${nx} ${mid}V${ROW_H}`, true);
  } else {
    line(row.lane, `M${nx} 0V${ROW_H}`);
  }
  const radius = row.shape !== "node" ? 6 : row.kind === "tool" ? 3 : 5;
  return {
    width: graphWidth(lanes), height: ROW_H, paths,
    dot: { cx: nx, cy: mid, r: radius, lane: row.lane, ring: statusRing(row.status), dead: row.dead },
  };
}

/** `850ms`, `12s`, `3m 5s`, `1h 2m`. */
export function timelineDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function timelineCost(usd: number | undefined): string | undefined {
  if (usd === undefined || usd <= 0) return undefined;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** `MM-DD HH:MM:SS` in UTC, as the original showed it. */
export const stamp = (iso: string): string => `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;

export type StatusTone = "good" | "bad" | "warn" | "neutral";

export function statusTone(status: string): StatusTone {
  if (["done", "ok", "granted"].includes(status)) return "good";
  if (RING_BAD.has(status)) return "bad";
  if (RING_WARN.has(status)) return "warn";
  return "neutral";
}

export const statusText = (status: string): string => status.replaceAll("_", " ");

/** Tool rows carry their status as the dot ring only, unless it is an error. */
export function showStatusBadge(row: Pick<TimelineRowView, "kind" | "status">): boolean {
  if (!row.status) return false;
  return row.kind !== "tool" || row.status === "error";
}
