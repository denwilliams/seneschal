import { STATE_LIMITS } from "../agent/durable/state.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { StateResponse, StateValue } from "./api-types.ts";
import { iso, isDirect, type Console2Source } from "./source.ts";

/**
 * The State tab: the channel's shared state object, read from the open store. Read-only. A closed store cannot be read, so
 * that is said rather than shown as an empty object. For a direct message the contents are withheld, including key names
 * (the paths in the change log), and only the revision, size and change times are shown.
 */
export async function buildState(source: Console2Source, channel: ChannelRecord): Promise<StateResponse> {
  const direct = isDirect(channel);
  const base = { channelId: channel.id, maxBytes: STATE_LIMITS.bytes };
  const runtime = source.runtime(channel.id);
  if (!runtime) {
    return {
      ...base, live: false, rev: 0, bytes: 0, changes: [],
      reason: "This channel's conversation store is not open in the running harness, so its state cannot be read. Stores open at startup for configured channels, so this is a channel the harness has not been shown yet, one it does not allow, or a store that is reopening after a config reload.",
    };
  }
  const snapshot = await runtime.store.stateSnapshot();
  const writer = (source: string, threadKey: string) => ({ source: source as "agent" | "job" | "operator", ...(threadKey ? { threadKey } : {}) });
  return {
    ...base, live: true, rev: snapshot.rev, bytes: snapshot.bytes,
    ...(snapshot.updatedAt > 0 ? { updatedAt: iso(snapshot.updatedAt)!, updatedBy: writer(snapshot.updatedBy.source, snapshot.updatedBy.threadKey) } : {}),
    ...(direct ? { redacted: true } : { value: snapshot.value as StateValue }),
    changes: snapshot.changes.map((change) => ({
      rev: change.rev, at: iso(change.at) ?? new Date(change.at).toISOString(), op: change.op,
      path: direct ? "" : change.path, source: change.source, ...(change.threadKey ? { threadKey: change.threadKey } : {}),
    })),
  };
}
