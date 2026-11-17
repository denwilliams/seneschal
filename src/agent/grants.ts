import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { channelPaths } from "../workspace/paths.ts";

/**
 * Runtime permissions, granted from Slack.
 *
 * Editing YAML and restarting is the wrong loop for "can you get online for a
 * minute" — it is slow enough that the safe default gets turned off
 * permanently instead. So the agent can ask, a human approves with a button,
 * and the grant expires on its own.
 *
 * Two rules keep this from being a way around the config rather than a use of
 * it:
 * - `permissions.grantable` is the ceiling. A capability that is not listed
 *   cannot be requested or granted, whatever the agent or a user clicks.
 * - Grants live in the channel's own directory, so approving network access in
 *   #engineering does nothing for #home.
 */

export const CAPABILITIES = [
  "network",
  "web",
  "bash",
  "memoryWrite",
  "skillPublish",
  "sharedToolsPublish",
] as const;
export type Capability = (typeof CAPABILITIES)[number] | `connector:${string}` | `subagent:${string}`;

/** The capability a person grants to let a `requireApproval` subagent run. */
export const subagentCapability = (agent: string): Capability => `subagent:${agent}`;

export interface Grant {
  capability: Capability;
  grantedBy: string;
  grantedAt: string;
  /** ISO timestamp, or null for "until revoked". */
  expiresAt: string | null;
  reason?: string;
}

interface GrantFile {
  grants: Grant[];
}

export function describeCapability(capability: Capability): string {
  switch (capability) {
    case "network":
      return "internet access for commands in this channel";
    case "web":
      return "reading web pages and downloading public files into this channel’s workspace";
    case "bash":
      return "running shell commands in this channel";
    case "memoryWrite":
      return "writing to the account-wide memory";
    case "skillPublish":
      return "publishing a skill to the shared library, where other channels can install it";
    case "sharedToolsPublish":
      return "publishing an executable script to the shared tool bin, where an operator can let other channels run it";
    default:
      if (capability.startsWith("subagent:")) {
        return `running the "${capability.slice("subagent:".length)}" subagent in this channel`;
      }
      return capability.startsWith("connector:")
        ? `the "${capability.slice("connector:".length)}" connector`
        : capability;
  }
}

/**
 * Whether a channel holds an active grant right now, read from its own grant file. For a check made at the moment of
 * use, by a session that may have been built before the grant was approved.
 */
export function channelHasGrant(channelRoot: string, capability: Capability, now = Date.now()): boolean {
  const file = join(channelRoot, "grants.json");
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as GrantFile;
    return (Array.isArray(parsed.grants) ? parsed.grants : []).some((g) => g.capability === capability && !isExpired(g, now));
  } catch {
    // Unreadable means no grant, which is the safe direction.
    return false;
  }
}

export function isExpired(grant: Grant, now = Date.now()): boolean {
  return grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now;
}

export class GrantStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private fileFor(channelId: string): string {
    return join(channelPaths(this.dataDir, channelId).root, "grants.json");
  }

  /** Active (non-expired) grants for a channel. */
  active(channelId: string, now = Date.now()): Grant[] {
    return this.all(channelId).filter((g) => !isExpired(g, now));
  }

  all(channelId: string): Grant[] {
    const file = this.fileFor(channelId);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as GrantFile;
      return Array.isArray(parsed.grants) ? parsed.grants : [];
    } catch {
      // An unreadable grant file means no grants, which is the safe direction.
      return [];
    }
  }

  has(channelId: string, capability: Capability, now = Date.now()): boolean {
    return this.active(channelId, now).some((g) => g.capability === capability);
  }

  private write(channelId: string, grants: Grant[]): void {
    const file = this.fileFor(channelId);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ grants } satisfies GrantFile, null, 2));
    renameSync(tmp, file);
  }

  grant(channelId: string, grant: Grant): void {
    // Replacing rather than appending keeps one row per capability, so a
    // re-approval extends the window instead of stacking.
    const others = this.all(channelId).filter(
      (g) => g.capability !== grant.capability && !isExpired(g),
    );
    this.write(channelId, [...others, grant]);
  }

  revoke(channelId: string, capability: Capability): boolean {
    const current = this.all(channelId);
    const remaining = current.filter((g) => g.capability !== capability);
    if (remaining.length === current.length) return false;
    this.write(channelId, remaining);
    return true;
  }

  revokeAll(channelId: string): number {
    const count = this.active(channelId).length;
    this.write(channelId, []);
    return count;
  }
}

export function formatExpiry(grant: Grant): string {
  if (grant.expiresAt === null) return "until revoked";
  const remaining = Date.parse(grant.expiresAt) - Date.now();
  if (remaining <= 0) return "expired";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h left` : `${Math.round(hours / 24)}d left`;
}
