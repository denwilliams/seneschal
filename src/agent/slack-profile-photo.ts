import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

const MAX_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IMAGE_ERROR = "Use a valid PNG or JPEG image, at most 5 MiB, with each side between 512 and 1024 pixels (Slack's supported dimensions).";

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function dimensions(width: number, height: number): void {
  if (width < 512 || height < 512 || width > 1024 || height > 1024) throw new Error(IMAGE_ERROR);
}

/** Fully decode bounded image bytes, not just a filename or magic-number check. */
function validateImage(data: Buffer, extension: string): void {
  try {
    if (extension === ".png" && data.length >= 33 && data.subarray(0, 8).equals(PNG_SIGNATURE) && data.toString("ascii", 12, 16) === "IHDR") {
      const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
      dimensions(width, height);
      // Reject duplicate/late headers before the decoder can change its allocation dimensions.
      const idat: Buffer[] = [];
      let ended = false;
      for (let offset = 8; offset < data.length;) {
        if (offset + 12 > data.length) throw new Error(IMAGE_ERROR);
        const length = data.readUInt32BE(offset);
        const type = data.toString("ascii", offset + 4, offset + 8);
        const end = offset + length + 12;
        if (end > data.length || (type === "IHDR" && (offset !== 8 || length !== 13))) throw new Error(IMAGE_ERROR);
        if (type === "IDAT") idat.push(data.subarray(offset + 8, end - 4));
        if (type === "IEND") {
          if (length !== 0 || end !== data.length) throw new Error(IMAGE_ERROR);
          ended = true;
        }
        offset = end;
      }
      if (!ended || !idat.length) throw new Error(IMAGE_ERROR);
      // pngjs bounds non-interlaced inflate itself, but uses unbounded zlib for Adam7.
      // Preflight interlaced data with a hard ceiling before that second decode.
      if (data[28] !== 0) inflateSync(Buffer.concat(idat), { maxOutputLength: width * height * 8 + height * 7 + 1024 });
      const decoded = PNG.sync.read(data, { checkCRC: true });
      dimensions(decoded.width, decoded.height);
      return;
    }
    if ([".jpg", ".jpeg"].includes(extension) && data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) {
      const decoded = jpeg.decode(data, { maxResolutionInMP: 2, maxMemoryUsageInMB: 64, tolerantDecoding: false });
      dimensions(decoded.width, decoded.height);
      return;
    }
  } catch {
    throw new Error(IMAGE_ERROR);
  }
  throw new Error(IMAGE_ERROR);
}

/** Only this channel's workspace and original attachments, never expanded sharing roots or URLs. */
export function readSlackProfilePhoto(path: string, workspace: string, attachments: string): Buffer {
  if (typeof path !== "string" || !path.trim() || path.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new Error("Provide a local PNG/JPEG path in this channel's workspace or attachments, not a URL.");
  }
  let fd: number | undefined;
  let data: Buffer;
  try {
    // Original attachments are created lazily; a channel with none can still upload a workspace image.
    const roots = [workspace, attachments].flatMap((root) => {
      try { return [realpathSync(root)]; } catch { return []; }
    });
    const requested = resolve(workspace, path);
    // Check both the spelling and final symlink target: neither host escapes nor links to other channels are allowed.
    if (![workspace, attachments].some((root) => within(resolve(root), requested))) throw new Error("outside");
    const real = realpathSync(requested);
    if (!roots.some((root) => within(root, real))) throw new Error("outside");
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    const checkedPath = realpathSync(requested);
    const checked = statSync(checkedPath);
    if (!roots.some((root) => within(root, checkedPath)) || opened.dev !== checked.dev || opened.ino !== checked.ino || !opened.isFile()) throw new Error("not a confined regular file");
    if (opened.size < 1 || opened.size > MAX_BYTES) throw new Error("size");
    // Bound reads even if a concurrent writer grows the file after fstat.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length < 1 || length > MAX_BYTES) throw new Error("size");
    data = bytes.subarray(0, length);
  } catch {
    throw new Error("Cannot read profile photo: choose an existing regular file inside this channel's workspace or attachments, at most 5 MiB. Symlink escapes and host paths are not allowed.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  validateImage(data, extname(path).toLowerCase());
  return data;
}
