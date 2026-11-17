import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Maps Slack channel names to IDs so config written by humans ("ops") can point
 * at directories keyed by ID ("C0123ABCD"). Populated as channels are seen.
 */

export interface ChannelRecord {
  id: string;
  name?: string;
  isDm: boolean;
  firstSeen: string;
  lastSeen: string;
}

/** Slack conversation IDs begin with C, D, or G; names and config aliases do not. */
export function isSlackChannelId(value: string): boolean {
  return /^[CDG][A-Z0-9]+$/.test(value);
}

export class ChannelRegistry {
  private records = new Map<string, ChannelRecord>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "channels", "index.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as ChannelRecord[];
      if (!Array.isArray(parsed)) return;

      // Older versions could accidentally persist a configured name as an ID
      // (for example, { id: "qa", name: "qa" }). It is not a Slack channel
      // and must never be allowed to select a data/channels/<name> workspace.
      // Drop those cache entries on load and rewrite the index once to migrate
      // existing installs without touching any channel workspace or secrets.
      let migrated = false;
      for (const rec of parsed) {
        if (!rec || typeof rec.id !== "string" || !isSlackChannelId(rec.id)) {
          migrated = true;
          continue;
        }
        this.records.set(rec.id, rec);
      }
      if (migrated) this.save();
    } catch {
      // A corrupt index is recoverable: it is a cache, not the source of truth.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
    renameSync(tmp, this.file);
  }

  record(ref: { id: string; name?: string; isDm: boolean }): void {
    // A name can arrive here only after a failed/legacy lookup. Recording it
    // would make the bad alias durable and could route later work to a
    // name-keyed workspace with none of the real channel's environment.
    if (!isSlackChannelId(ref.id)) return;

    const now = new Date().toISOString();
    const existing = this.records.get(ref.id);
    const next: ChannelRecord = {
      id: ref.id,
      ...(ref.name ? { name: ref.name } : existing?.name ? { name: existing.name } : {}),
      isDm: ref.isDm,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    };
    const changed =
      !existing || existing.name !== next.name || existing.isDm !== next.isDm;
    this.records.set(ref.id, next);
    // Only rewrite on meaningful change; lastSeen churn is not worth the IO on a Pi.
    if (changed) this.save();
  }

  /**
   * The name this channel was last seen under, if any.
   *
   * The inverse of `resolveId`, and the reason the index is written to disk:
   * work that starts without a Slack event behind it — a scheduled task, an
   * overnight pass — has only a channel id to go on, and config written by
   * humans is keyed by name.
   */
  nameFor(id: string): string | undefined {
    return this.records.get(id)?.name;
  }

  /** Accepts an ID, a name, or "#name". */
  resolveId(key: string): string | undefined {
    const bare = key.startsWith("#") ? key.slice(1) : key;

    // A Slack ID is always unambiguous, including when an invalid/stale stored
    // name happens to look like one. IDs must keep precedence over names.
    // Unseen IDs are also accepted so config can use a channel before an event
    // has taught the registry its name.
    if (isSlackChannelId(bare)) return bare;

    // For names, choose the learned real channel rather than any legacy
    // pseudo-record whose id happens to equal the name (for example, "qa").
    for (const rec of this.records.values()) {
      if (rec.name === bare && isSlackChannelId(rec.id)) return rec.id;
    }
    return undefined;
  }

  all(): ChannelRecord[] {
    return [...this.records.values()];
  }
}
