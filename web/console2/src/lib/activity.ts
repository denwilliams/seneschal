import type { ActivityEntry } from "@api/api-types";

/** Polls and older pages can overlap. Never duplicate or replace a newer interaction state with a stale page. */
export function mergeActivity(current: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const old = byId.get(entry.id);
    if (!old || entry.updatedAt >= old.updatedAt) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}
