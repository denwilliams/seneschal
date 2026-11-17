import { listArtifacts } from "./data.ts";
import { ConsoleLinks } from "./links.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { ArtifactsResponse } from "./api-types.ts";
import type { Console2Source } from "./source.ts";

/**
 * The files a channel has published through artifact hosting. Names, sizes and times only, never contents, and symlinks and
 * dotfiles are never listed (`listArtifacts` guarantees that). Each URL is the one the file is actually served at, below the
 * console's own prefix and safely encoded.
 */
export async function buildArtifacts(source: Console2Source, channel: ChannelRecord): Promise<ArtifactsResponse> {
  const resolved = source.resolve(channel);
  if (!resolved?.artifacts) {
    return {
      channelId: channel.id, enabled: false, entries: [], truncated: false,
      reason: "Artifact hosting is not on for this channel. It needs `webConsole.artifacts: true` and the channel's artifacts folder.",
    };
  }
  const links = new ConsoleLinks(source.baseUrl);
  const listing = await listArtifacts(resolved.artifacts.directory);
  return {
    channelId: channel.id, enabled: true, truncated: listing.truncated,
    entries: listing.entries.map((entry) => ({ path: entry.path, size: entry.size, modified: entry.modified, url: links.artifactFile(channel.id, entry.path) })),
  };
}
