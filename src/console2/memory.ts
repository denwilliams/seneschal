import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { MemoryFileView, MemoryResponse } from "./api-types.ts";
import { isDirect, type Console2Source } from "./source.ts";

const MAX_BYTES = 24_000;

/** Reads the head of a file without following a symlink. Undefined when it is missing or not a regular file. */
export function readBounded(path: string, readText = true): { bytes: number; modified: string; text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    // A direct message channel's text is never sent, so do not read it: size and time come from the descriptor.
    const buffer = Buffer.alloc(readText ? Math.min(info.size, MAX_BYTES) : 0);
    const read = readText ? readSync(fd, buffer, 0, buffer.length, 0) : 0;
    return { bytes: info.size, modified: info.mtime.toISOString(), text: buffer.subarray(0, read).toString("utf8"), truncated: info.size > MAX_BYTES };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The State tab for now: what the channel remembers. Channel memory, the account's shared memory if this channel is
 * wired to it, and the dream journal. Read-only, bounded, and omitted for direct messages.
 */
export function buildMemory(source: Console2Source, channel: ChannelRecord): MemoryResponse {
  const resolved = source.resolve(channel);
  if (!resolved) return { channelId: channel.id, files: [] };
  const direct = isDirect(channel);
  const candidates: { name: string; scope: MemoryFileView["scope"]; path: string }[] = [
    { name: "MEMORY.md", scope: "channel", path: resolved.memory.channelFile },
    ...(resolved.memory.sharedFile ? [{ name: "shared MEMORY.md", scope: "shared" as const, path: resolved.memory.sharedFile }] : []),
    { name: "DREAMS.md", scope: "dreams", path: join(resolved.paths.memory, "DREAMS.md") },
  ];
  const files: MemoryFileView[] = [];
  for (const candidate of candidates) {
    const file = readBounded(candidate.path, !direct);
    if (!file) continue;
    files.push({
      name: candidate.name, scope: candidate.scope, bytes: file.bytes, modified: file.modified,
      ...(direct ? { redacted: true } : { text: file.text, ...(file.truncated ? { truncated: true } : {}) }),
    });
  }
  return { channelId: channel.id, files };
}
