import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelPaths } from "../workspace/paths.ts";

/**
 * The operator's `!model` channel default as it was recorded before the conversation owned it.
 *
 * Model choices now live in the Durable store (the channel's main conversation holds the
 * channel default; each thread's own conversation holds its model), so nothing writes
 * `models.json` any more. This is read once when a channel's store is first created, so a
 * deliberate channel-wide override is not silently lost. Per-thread overrides are not carried
 * over: a thread's model is part of its conversation.
 */
export function legacyChannelModelOverride(paths: ChannelPaths): string | undefined {
  const file = join(paths.root, "models.json");
  if (!existsSync(file)) return undefined;
  try {
    const value = (JSON.parse(readFileSync(file, "utf-8")) as { channelDefault?: unknown }).channelDefault;
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}
