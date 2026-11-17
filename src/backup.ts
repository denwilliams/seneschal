import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  lstat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Cron } from "croner";
import { logger } from "./util/log.ts";

/**
 * Daily data directory backups.
 *
 * The harness keeps almost everything that matters in plain files under
 * `data/`. This service takes that promise seriously: once a day it writes a
 * single `tar.gz` containing the data directory, then removes older archives so
 * the backup directory does not grow forever. It is deliberately independent of
 * the agent scheduler — backups are operator housekeeping, not a task a channel
 * created and can cancel.
 */

export interface BackupSettings {
  enabled: boolean;
  cron: string;
  timezone: string;
  /** Absolute directory where archives are written. */
  directory: string;
  /** Number of newest date-named archives to keep. */
  keepLast: number;
}

export interface BackupResult {
  path: string;
  bytes: number;
  entries: number;
  removed: string[];
}

export function resolveBackupDirectory(dataDir: string, configured: string, baseDir: string): string {
  const trimmed = configured.trim();
  if (!trimmed) return resolve(dirname(dataDir), "backups");
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed);
}

export function backupDateStamp(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isInsideOrEqual(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function octal(value: number, length: number): Buffer {
  const text = Math.max(0, Math.floor(value)).toString(8);
  const out = Buffer.alloc(length, 0);
  out.write(text.slice(-(length - 1)).padStart(length - 1, "0"), 0, length - 1, "ascii");
  return out;
}

function writeString(buf: Buffer, offset: number, length: number, text: string): void {
  const src = Buffer.from(text, "utf-8");
  src.copy(buf, offset, 0, Math.min(length, src.length));
}

function splitUstarName(name: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };

  const parts = name.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const rest = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) {
      return { name: rest, prefix };
    }
  }
  return undefined;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (true) {
    const record = `${length}${body}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

function padding(size: number): Buffer | undefined {
  const pad = (512 - (size % 512)) % 512;
  return pad > 0 ? Buffer.alloc(pad) : undefined;
}

interface TarHeaderInput {
  name: string;
  type: "0" | "2" | "5" | "x";
  size: number;
  mode: number;
  mtime: number;
  linkname?: string;
}

function tarHeader(input: TarHeaderInput): Buffer {
  const header = Buffer.alloc(512, 0);
  const split = splitUstarName(input.name) ?? { name: input.name.slice(-100), prefix: "" };

  writeString(header, 0, 100, split.name);
  octal(input.mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108); // uid
  octal(0, 8).copy(header, 116); // gid
  octal(input.size, 12).copy(header, 124);
  octal(input.mtime, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(input.type, 156, 1, "ascii");
  if (input.linkname) writeString(header, 157, 100, input.linkname);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("harness", 265, 7, "ascii");
  header.write("harness", 297, 7, "ascii");
  if (split.prefix) writeString(header, 345, 155, split.prefix);

  let sum = 0;
  for (const byte of header) sum += byte;
  const chk = Buffer.alloc(8, 0x20);
  chk.write(sum.toString(8).padStart(6, "0"), 0, 6, "ascii");
  chk[6] = 0;
  chk[7] = 0x20;
  chk.copy(header, 148);
  return header;
}

function needsPax(input: TarHeaderInput): Record<string, string> {
  const pax: Record<string, string> = {};
  if (!splitUstarName(input.name)) pax.path = input.name;
  if (input.linkname && Buffer.byteLength(input.linkname) > 100) pax.linkpath = input.linkname;
  return pax;
}

async function* tarEntry(input: TarHeaderInput): AsyncGenerator<Buffer> {
  const pax = needsPax(input);
  if (Object.keys(pax).length > 0) {
    const body = Buffer.from(Object.entries(pax).map(([k, v]) => paxRecord(k, v)).join(""), "utf-8");
    yield tarHeader({
      name: `PaxHeaders/${basename(input.name).slice(0, 80) || "entry"}`,
      type: "x",
      size: body.length,
      mode: 0o644,
      mtime: input.mtime,
    });
    yield body;
    const pad = padding(body.length);
    if (pad) yield pad;
  }

  yield tarHeader(input);
}

async function* walkDataDir(input: {
  root: string;
  archiveRoot: string;
  excludeDir?: string;
  count: { entries: number };
  path?: string;
}): AsyncGenerator<Buffer> {
  const path = input.path ?? input.root;
  if (input.excludeDir && isInsideOrEqual(path, input.excludeDir)) return;

  const st = await lstat(path);
  const rel = relative(input.root, path).split("\\").join("/");
  const name = rel ? `${input.archiveRoot}/${rel}` : `${input.archiveRoot}/`;
  const mtime = Math.floor(st.mtimeMs / 1000);

  if (st.isDirectory()) {
    input.count.entries++;
    yield* tarEntry({ name: name.endsWith("/") ? name : `${name}/`, type: "5", size: 0, mode: st.mode & 0o777, mtime });
    const children = (await readdir(path)).sort();
    for (const child of children) {
      yield* walkDataDir({ ...input, path: join(path, child) });
    }
    return;
  }

  if (st.isSymbolicLink()) {
    input.count.entries++;
    const linkname = await readlink(path);
    yield* tarEntry({ name, type: "2", size: 0, mode: st.mode & 0o777, mtime, linkname });
    return;
  }

  if (!st.isFile()) return;

  input.count.entries++;
  yield* tarEntry({ name, type: "0", size: st.size, mode: st.mode & 0o777, mtime });
  for await (const chunk of createReadStream(path)) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
  const pad = padding(st.size);
  if (pad) yield pad;
}

async function* tarArchive(
  root: string,
  archiveRoot: string,
  excludeDir: string | undefined,
  count: { entries: number },
) {
  yield* walkDataDir({ root, archiveRoot, ...(excludeDir ? { excludeDir } : {}), count });
  yield Buffer.alloc(1024);
}

async function rotateBackups(directory: string, keepLast: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const backups = entries
    .filter((e) => e.isFile() && /^data-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();

  const remove = backups.slice(keepLast);
  for (const name of remove) await rm(join(directory, name), { force: true });
  return remove;
}

export async function createDataBackup(input: {
  dataDir: string;
  directory: string;
  timezone: string;
  keepLast: number;
  now?: Date;
}): Promise<BackupResult> {
  const dataDir = resolve(input.dataDir);
  const directory = resolve(input.directory);
  const now = input.now ?? new Date();
  if (directory === dataDir) {
    throw new Error("backup directory must not be the data directory itself");
  }
  const excludeDir = isInsideOrEqual(directory, dataDir) ? directory : undefined;

  const stamp = backupDateStamp(now, input.timezone);
  const target = join(directory, `data-${stamp}.tar.gz`);
  const temp = join(directory, `.data-${stamp}.${process.pid}.${Date.now()}.tmp`);

  await mkdir(directory, { recursive: true });

  const count = { entries: 0 };
  try {
    await pipeline(
      Readable.from(tarArchive(dataDir, basename(dataDir) || "data", excludeDir, count)),
      createGzip({ level: 9 }),
      createWriteStream(temp, { flags: "wx" }),
    );
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }

  const bytes = (await stat(target)).size;
  const removed = await rotateBackups(directory, input.keepLast);
  return { path: target, bytes, entries: count.entries, removed };
}

export class BackupRunner {
  private readonly settings: BackupSettings;
  private readonly dataDir: string;
  private job?: Cron;
  private stopped = false;
  private running = false;

  constructor(dataDir: string, settings: BackupSettings) {
    this.dataDir = dataDir;
    this.settings = settings;
  }

  start(): void {
    if (!this.settings.enabled) return;

    try {
      this.job = new Cron(
        this.settings.cron,
        { timezone: this.settings.timezone, catch: true },
        () => void this.fire(),
      );
    } catch (err) {
      logger.warn(`backup: "${this.settings.cron}" is not a usable cron expression`, err);
      return;
    }

    if (!this.job.nextRun()) {
      this.job.stop();
      this.job = undefined;
      return;
    }

    logger.info(
      `backup: writing ${this.settings.directory}/data-YYYY-MM-DD.tar.gz at "${this.settings.cron}" ` +
        `(${this.settings.timezone}), keeping ${this.settings.keepLast}`,
    );
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      logger.warn("backup: previous run is still in progress; skipping this tick");
      return;
    }

    this.running = true;
    try {
      const result = await createDataBackup({
        dataDir: this.dataDir,
        directory: this.settings.directory,
        timezone: this.settings.timezone,
        keepLast: this.settings.keepLast,
      });
      logger.info(
        `backup: wrote ${result.path} (${result.bytes} bytes, ${result.entries} entries)` +
          (result.removed.length > 0 ? `; pruned ${result.removed.join(", ")}` : ""),
      );
    } catch (err) {
      logger.warn("backup: failed", err);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.job?.stop();
    this.job = undefined;
  }
}
