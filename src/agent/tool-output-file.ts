import fs, { type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, sep } from "node:path";

interface Identity { dev: string; ino: string }
export interface OutputFileRequest extends Identity {
  workspace: string;
  path: string;
  data: string;
}

function same(a: BigIntStats, b: Identity): boolean {
  return String(a.dev) === b.dev && String(a.ino) === b.ino;
}
function identity(stat: BigIntStats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function stat(path: string): BigIntStats { return fs.statSync(path, { bigint: true }); }
function changed(): never { throw new Error("Output destination changed during tool execution or publication."); }

/**
 * Runs ONLY in a dedicated child process: cwd is a portable directory-inode
 * anchor (including on macOS, where /proc/self/fd is unavailable). All writes
 * below are single-component names relative to that anchor, never paths with
 * mutable ancestors. The configured workspace root/its ancestors are trusted;
 * hostile host processes able to relocate already-open directories or steal
 * private files require OS sandboxing, as with other native file tools. A move
 * racing link is detected/cleaned up afterward, not prevented by this anchor.
 */
export function publishToolOutput(request: OutputFileRequest): void {
  const { workspace, path, data } = request;
  const parts = path.split(sep);
  if (isAbsolute(path) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Output path must be a file inside this channel's own workspace.");
  }
  if (!fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY) {
    throw new Error("Secure tool output publication is not supported on this platform.");
  }
  process.chdir(workspace);
  if (!same(stat("."), request) || fs.realpathSync(".") !== workspace) changed();

  const temporary = `.tool-output-${randomUUID()}`;
  const staged = join(workspace, temporary);
  let file: number | undefined;
  let stagedIdentity: Identity | undefined;
  let linked = false;
  let parentIdentity = identity(stat("."));
  let parent = workspace;
  const leaf = basename(path);
  const verifyParent = () => {
    if (!same(stat(workspace), request) || !same(stat("."), parentIdentity) ||
        fs.realpathSync(".") !== parent || fs.realpathSync(parent) !== parent ||
        !same(stat(parent), parentIdentity)) changed();
  };
  try {
    // Stage the private data at the trusted workspace root, not under a
    // caller-controlled parent that can be renamed or replaced mid-write.
    file = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    stagedIdentity = identity(fs.fstatSync(file, { bigint: true }));
    fs.writeFileSync(file, data, "utf8");
    verifyParent();

    for (const part of parts.slice(0, -1)) {
      verifyParent();
      try { fs.mkdirSync(part); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      // Open without following the leaf, then verify chdir reached exactly
      // that inode. A swap between open and chdir fails before any write.
      const dir = fs.openSync(part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const expected = identity(fs.fstatSync(dir, { bigint: true }));
        process.chdir(part);
        parentIdentity = expected;
        parent = join(parent, part);
        verifyParent();
      } finally { fs.closeSync(dir); }
    }
    verifyParent();
    if (!same(fs.lstatSync(staged, { bigint: true }), stagedIdentity)) changed();
    // The target is a single leaf relative to the pinned cwd; the source is
    // at the trusted root. link is atomic and never overwrites.
    fs.linkSync(staged, leaf);
    linked = true;
    verifyParent();
    if (!same(fs.lstatSync(leaf, { bigint: true }), stagedIdentity)) changed();
  } catch (error) {
    // Even if the parent was moved, cwd still denotes the actual directory
    // where link published, not a replacement symlink. Never unlink a rival.
    if (linked && stagedIdentity) {
      try {
        if (same(fs.lstatSync(leaf, { bigint: true }), stagedIdentity)) fs.unlinkSync(leaf);
      } catch { /* Preserve the original failure. */ }
    }
    throw error;
  } finally {
    if (file !== undefined) fs.closeSync(file);
    if (stagedIdentity) {
      try {
        if (same(stat(workspace), request) && same(fs.lstatSync(staged, { bigint: true }), stagedIdentity)) fs.unlinkSync(staged);
      } catch { /* A crash/root relocation can leave a private staging file. */ }
    }
  }
}
