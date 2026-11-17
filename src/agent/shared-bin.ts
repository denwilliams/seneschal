import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { SharedPaths } from "../workspace/paths.ts";

/**
 * The shared tool bin: how one channel's script becomes another channel's
 * tool, without ever handing either of them a general-purpose shell into the
 * other's territory.
 *
 * It is deliberately shaped like the skill library rather than like `exec`:
 * - **Publishing is a permission** (`share.sharedToolsPublish`), same as
 *   `libraryPublish` — writing an executable other channels may end up
 *   running is not something a channel does just because it felt like it.
 * - **Nothing is copied.** Unlike the library, execution reads the live
 *   published script — this is a shared *tool*, not a shared *starting
 *   point*. A consuming channel that needs to freeze a version pins its own
 *   config to a sha256 (see `SharedToolConfig.sha256` in the schema).
 * - **Execution is not "installed", it is configured.** A published tool runs
 *   nowhere until an operator lists its name in some channel's own
 *   `share.sharedTools`, with that channel's own argv allowlist. Publishing
 *   a tool and being allowed to run it are two entirely separate decisions,
 *   made by two different people (the publishing channel's agent; the
 *   operator editing that *other* channel's config).
 * - **Provenance is kept**, same as the library: every entry records who
 *   published it, when, and a content hash — a tool with no provenance is
 *   not listed at all.
 *
 * The directory this writes to is never added to any channel's filesystem
 * jail. The only way in is `publish_shared_tool`/`unpublish_shared_tool`
 * (this module, gated on `share.sharedToolsPublish`), and the only way to run
 * a script here is a `shared__<name>` tool built from a channel's own
 * `share.sharedTools` entry — never a path a generic `read`/`write`/`bash`
 * call could reach.
 */

export interface SharedToolEntry {
  name: string;
  description: string;
  /** Channel label as it read at publish time, e.g. "#ops". For humans. */
  publishedBy: string;
  /** Slack channel id of the publisher. This is the identity that matters. */
  publishedByChannelId: string;
  publishedAt: string;
  updatedAt: string;
  /** Bumped each time the publisher republishes. */
  version: number;
  /** Why the publisher thought other channels might want this. */
  note?: string;
  /** Size of the published script, in bytes. */
  bytes: number;
  /** sha256 of the script content, so a consumer can pin to this exact version. */
  sha256: string;
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
/** Shared tools are reviewed scripts, not binaries — keep them small enough to actually review. */
const MAX_SCRIPT_BYTES = 65_536;

export function validateSharedToolName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!name) throw new Error("A shared tool needs a name.");
  if (name.length > MAX_NAME) {
    throw new Error(`Shared tool names are at most ${MAX_NAME} characters; "${name}" is longer.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `"${raw}" is not a valid shared tool name. Use lowercase letters, numbers and single hyphens — ` +
        "for example `deploy-notify` or `resize-image`.",
    );
  }
  return name;
}

function metaFile(shared: SharedPaths, name: string): string {
  return join(shared.binMeta, `${name}.json`);
}

export function sharedToolPath(shared: SharedPaths, rawName: string): string {
  return join(shared.bin, validateSharedToolName(rawName));
}

function readEntry(shared: SharedPaths, name: string): SharedToolEntry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(metaFile(shared, name), "utf-8")) as SharedToolEntry;
    if (parsed && typeof parsed.name === "string") return parsed;
  } catch {
    // A name without readable metadata is not a published tool. Dropping it
    // from the listing is the right failure: a tool with no provenance is
    // exactly what should not be offered to another channel.
  }
  return undefined;
}

function writeEntry(shared: SharedPaths, entry: SharedToolEntry): void {
  mkdirSync(shared.binMeta, { recursive: true });
  const file = metaFile(shared, entry.name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

/** Everything in the shared bin, newest first. */
export function listSharedTools(shared: SharedPaths): SharedToolEntry[] {
  if (!existsSync(shared.binMeta)) return [];
  let files: string[];
  try {
    files = readdirSync(shared.binMeta);
  } catch {
    return [];
  }
  const out: SharedToolEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    if (!existsSync(sharedToolPath(shared, name))) continue;
    const entry = readEntry(shared, name);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readSharedToolEntry(shared: SharedPaths, rawName: string): SharedToolEntry {
  const name = validateSharedToolName(rawName);
  const entry = readEntry(shared, name);
  if (!entry || !existsSync(sharedToolPath(shared, name))) {
    throw new Error(`No shared tool called \`${name}\` has been published.`);
  }
  return entry;
}

export function readSharedToolSource(shared: SharedPaths, rawName: string): { entry: SharedToolEntry; source: string } {
  const entry = readSharedToolEntry(shared, rawName);
  const source = readFileSync(sharedToolPath(shared, entry.name), "utf-8");
  return { entry, source };
}

export interface PublishSharedToolInput {
  name: string;
  /** What it does and how to call it — shown to every channel allowed to run it. */
  description: string;
  /** Full script source, including its shebang line. */
  content: string;
  /** Why another channel might want this. */
  note?: string;
}

/**
 * Put an executable script in the shared bin.
 *
 * The script must name its own interpreter with a shebang line: the harness
 * spawns it directly, never through a shell of its own, so there is nothing
 * else that would know how to run it. This also keeps published tools to
 * reviewable text rather than opaque binaries.
 */
export function publishSharedTool(
  shared: SharedPaths,
  channel: ResolvedChannel,
  input: PublishSharedToolInput,
  now = new Date(),
): SharedToolEntry {
  const name = validateSharedToolName(input.name);

  const description = input.description.replace(/\s+/g, " ").trim();
  if (!description) {
    throw new Error("A shared tool needs a description saying what it does and how to call it.");
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new Error(`Shared tool descriptions are at most ${MAX_DESCRIPTION} characters.`);
  }

  const content = input.content.replace(/\r\n/g, "\n");
  if (!content.trim()) {
    throw new Error("A shared tool needs a script body.");
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_SCRIPT_BYTES) {
    throw new Error(`Shared tools are at most ${MAX_SCRIPT_BYTES} bytes; this script is larger.`);
  }
  if (!content.startsWith("#!")) {
    throw new Error(
      "A shared tool must start with a shebang line (e.g. `#!/usr/bin/env bash` or `#!/usr/bin/env node`) " +
        "naming the interpreter that runs it — the harness executes the file directly, never through a shell of its own.",
    );
  }

  const existing = readEntry(shared, name);
  if (existing && existing.publishedByChannelId !== channel.ref.id) {
    throw new Error(
      `\`${name}\` is already in the shared bin, published by ${existing.publishedBy}. ` +
        `Only the channel that published a tool can replace it — publish yours under a different name.`,
    );
  }

  mkdirSync(shared.bin, { recursive: true });
  const scriptPath = sharedToolPath(shared, name);
  const tmp = `${scriptPath}.tmp`;
  writeFileSync(tmp, content);
  chmodSync(tmp, 0o755);
  renameSync(tmp, scriptPath);

  const entry: SharedToolEntry = {
    name,
    description,
    publishedBy: channel.ref.name ? `#${channel.ref.name}` : channel.ref.id,
    publishedByChannelId: channel.ref.id,
    publishedAt: existing?.publishedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    version: (existing?.version ?? 0) + 1,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    bytes: Buffer.byteLength(content, "utf-8"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  writeEntry(shared, entry);
  return entry;
}

/** Remove a tool from the shared bin. Only the publisher may. */
export function unpublishSharedTool(shared: SharedPaths, channel: ResolvedChannel, rawName: string): boolean {
  const name = validateSharedToolName(rawName);
  const entry = readEntry(shared, name);
  if (!entry) return false;
  if (entry.publishedByChannelId !== channel.ref.id) {
    throw new Error(
      `\`${name}\` was published by ${entry.publishedBy}, so this channel cannot withdraw it.`,
    );
  }
  rmSync(sharedToolPath(shared, name), { force: true });
  rmSync(metaFile(shared, name), { force: true });
  return true;
}
