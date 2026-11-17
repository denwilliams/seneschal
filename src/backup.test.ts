import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backupDateStamp, createDataBackup, resolveBackupDirectory } from "./backup.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-backup-"));
  const data = join(root, "data");
  mkdirSync(join(data, "shared", "memory"), { recursive: true });
  writeFileSync(join(data, "shared", "memory", "MEMORY.md"), "# Account memory\n");
  return { root, data };
}

function parseOctal(buf: Buffer, start: number, length: number): number {
  const text = buf.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parseString(buf: Buffer, start: number, length: number): string {
  return buf.subarray(start, start + length).toString("utf-8").replace(/\0.*$/, "");
}

function tarContents(path: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(path));
  const out = new Map<string, Buffer>();
  let offset = 0;
  let paxPath: string | undefined;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;

    const rawName = parseString(header, 0, 100);
    const prefix = parseString(header, 345, 155);
    const type = parseString(header, 156, 1) || "0";
    const size = parseOctal(header, 124, 12);
    const body = tar.subarray(offset, offset + size);
    offset += size + ((512 - (size % 512)) % 512);

    if (type === "x") {
      const text = body.toString("utf-8");
      const match = text.match(/\d+ path=([^\n]+)\n/);
      paxPath = match?.[1];
      continue;
    }

    const name = paxPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    paxPath = undefined;
    out.set(name, body);
  }

  return out;
}

test("a backup is a single date-named compressed tarball of the data directory", async () => {
  const { root, data } = setup();
  const backups = join(root, "backups");

  const result = await createDataBackup({
    dataDir: data,
    directory: backups,
    timezone: "UTC",
    keepLast: 14,
    now: new Date("2026-08-09T12:00:00Z"),
  });

  assert.equal(result.path, join(backups, "data-2026-08-09.tar.gz"));
  assert.ok(result.bytes > 0);
  assert.ok(result.entries >= 3);

  const entries = tarContents(result.path);
  assert.equal(entries.get("data/shared/memory/MEMORY.md")?.toString(), "# Account memory\n");
});

test("rotation keeps the newest date-named archives", async () => {
  const { root, data } = setup();
  const backups = join(root, "backups");
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, "data-2026-08-07.tar.gz"), "old");
  writeFileSync(join(backups, "data-2026-08-08.tar.gz"), "old");
  writeFileSync(join(backups, "data-2026-08-09.tar.gz"), "old");

  const result = await createDataBackup({
    dataDir: data,
    directory: backups,
    timezone: "UTC",
    keepLast: 2,
    now: new Date("2026-08-10T12:00:00Z"),
  });

  assert.deepEqual(result.removed, ["data-2026-08-08.tar.gz", "data-2026-08-07.tar.gz"]);
  assert.deepEqual(
    readdirSync(backups).filter((f) => f.endsWith(".tar.gz")).sort(),
    ["data-2026-08-09.tar.gz", "data-2026-08-10.tar.gz"],
  );
});


test("a parent backup directory still archives the data directory", async () => {
  const { root, data } = setup();

  const result = await createDataBackup({
    dataDir: data,
    directory: root,
    timezone: "UTC",
    keepLast: 14,
    now: new Date("2026-08-09T12:00:00Z"),
  });

  const entries = tarContents(result.path);
  assert.equal(entries.get("data/shared/memory/MEMORY.md")?.toString(), "# Account memory\n");
});

test("a backup directory inside dataDir is not recursively archived", async () => {
  const { data } = setup();
  const backups = join(data, "backups");
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, "data-2026-08-08.tar.gz"), "old backup");

  const result = await createDataBackup({
    dataDir: data,
    directory: backups,
    timezone: "UTC",
    keepLast: 14,
    now: new Date("2026-08-09T12:00:00Z"),
  });

  const entries = [...tarContents(result.path).keys()];
  assert.ok(!entries.some((name) => name.startsWith("data/backups")));
});


test("the data directory itself is refused as a backup directory", async () => {
  const { data } = setup();

  await assert.rejects(
    createDataBackup({
      dataDir: data,
      directory: data,
      timezone: "UTC",
      keepLast: 14,
      now: new Date("2026-08-09T12:00:00Z"),
    }),
    /must not be the data directory/,
  );
});

test("backup dates use the configured timezone", () => {
  assert.equal(backupDateStamp(new Date("2026-08-09T14:30:00Z"), "UTC"), "2026-08-09");
  assert.equal(
    backupDateStamp(new Date("2026-08-09T14:30:00Z"), "Australia/Melbourne"),
    "2026-08-10",
  );
});

test("the default backup directory is a sibling of dataDir", () => {
  assert.equal(resolveBackupDirectory("/srv/harness/data", "", "/repo"), "/srv/harness/backups");
  assert.equal(resolveBackupDirectory("/srv/harness/data", "./safe", "/repo"), resolve("/repo/safe"));
});
