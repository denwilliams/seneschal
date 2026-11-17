import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isSlackChannelId } from "../workspace/registry.ts";

/**
 * Which channel stores should be open: every channel that already has one, and every channel the harness knows by Slack ID
 * (seen in Slack, or configured by ID) that does not yet.
 *
 * The two groups are opened differently. A channel with an existing store may have interrupted work, so it is recovered
 * before the harness announces itself. A channel without one is only being given a store, so it opens in the background.
 *
 * A channel configured only by name that has not been seen has no ID yet and cannot be opened. It stays configured but
 * not live until Slack shows it to the harness.
 */
export function channelsToOpen(input: { dataDir: string; seen: Iterable<string>; configured: Iterable<string> }): { existing: string[]; fresh: string[] } {
  const root = join(input.dataDir, "channels");
  let names: string[] = [];
  try { names = readdirSync(root); } catch { /* no channels yet */ }
  const existing = names.filter((id) => existsSync(join(root, id, "durable")));
  const known = new Set(existing);
  const fresh: string[] = [];
  for (const id of [...input.seen, ...input.configured]) {
    if (!isSlackChannelId(id) || known.has(id)) continue;
    known.add(id);
    fresh.push(id);
  }
  return { existing, fresh };
}

/** A store that fails is reopened once; one that fails again this soon is left for the next message, so a broken disk cannot spin. */
export const STORE_REOPEN_COOLDOWN_MS = 60_000;

export function shouldReopenFailedStore(lastFailureAt: number | undefined, now: number): boolean {
  return lastFailureAt === undefined || now - lastFailureAt >= STORE_REOPEN_COOLDOWN_MS;
}
