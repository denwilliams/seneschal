import type { StateValue } from "@api/api-types";

/** How many items of a long array are drawn before "show more". */
export const PAGE = 50;
/** Strings longer than this are cut until the reader asks for the rest. */
export const LONG_STRING = 120;
/** Levels drawn open when the tree first appears: the root and its children. */
export const OPEN_DEPTH = 2;

export type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function kindOf(value: StateValue): Kind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Kind;
}

export const isContainer = (value: StateValue): value is StateValue[] | { [key: string]: StateValue } => typeof value === "object" && value !== null;

/** `{3 keys}` / `[1 item]`: what a collapsed container says about itself. */
export function summarize(value: StateValue): string {
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  if (value !== null && typeof value === "object") {
    const count = Object.keys(value).length;
    return `{${count} ${count === 1 ? "key" : "keys"}}`;
  }
  return "";
}

/** A container's children, in order. Array items are keyed by their index. */
export function childrenOf(value: StateValue): [string, StateValue][] {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (value !== null && typeof value === "object") return Object.entries(value);
  return [];
}

/** How many of `total` children to draw when `shown` pages have been asked for: the first PAGE, then PAGE more each time. */
export function visibleCount(total: number, pages: number): number {
  return Math.min(total, PAGE * Math.max(1, pages));
}

export function remaining(total: number, pages: number): number {
  return Math.max(0, total - visibleCount(total, pages));
}

export function truncateString(text: string, max: number = LONG_STRING): { text: string; truncated: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false };
}

export const startsOpen = (depth: number): boolean => depth < OPEN_DEPTH;

/** "3.2 KB of 64 KB": a size against its limit, without a pointless ".0". */
export function sizeLabel(bytes: number, max: number): string {
  const one = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB` : `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`);
  return `${one(bytes)} of ${one(max)}`;
}

export function percentOf(bytes: number, max: number): number {
  return max > 0 ? Math.min(100, (bytes / max) * 100) : 0;
}

/** A JSON Pointer for display; the root reads as "/" rather than nothing. */
export const pathLabel = (path: string): string => (path === "" ? "/" : path);

/** Copy text to the clipboard. Returns false, never throws, when the browser will not allow it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
