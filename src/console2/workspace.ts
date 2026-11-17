import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { Console2Source } from "./source.ts";
import type { DatabaseResponse, WorkspaceResponse } from "./api-types.ts";

/** Same openat/no-follow boundary as artifact hosting, including intermediate directories.
 * SQLite reads a bounded private snapshot (including WAL), never the original or its sidecars.
 * A subprocess bounds CPU, elapsed time, output and concurrent inspections (plus memory on Linux) independently
 * of the console event loop. Python 3's sqlite3 is part of the existing artifact-hosting runtime.
 */
const BROWSE = String.raw`
import datetime, json, os, resource, sqlite3, stat, sys, time

PAGE = 100
ROWS = 50
MAX_BYTES = 64 * 1024 * 1024
# Linux enforces this cap; Darwin can reject it below Python's existing mappings.
# Other platforms retain CPU, elapsed, output, concurrency and snapshot-size bounds,
# but have no process address-space cap. Do not silently weaken Linux enforcement.
if sys.platform == 'linux':
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
root, channel, mode, relative, offset, table, table_offset, snapshot_folder = sys.argv[1:]
offset, table_offset = int(offset), int(table_offset)
nofollow = os.O_NOFOLLOW
flags = os.O_RDONLY | nofollow | os.O_NONBLOCK

def open_dir(parent, name):
    return os.open(name, flags | os.O_DIRECTORY, dir_fd=parent)

def metadata(parent, name):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'other'
    if kind == 'file':
        try:
            fd = os.open(name, flags, dir_fd=parent)
            try:
                if stat.S_ISREG(os.fstat(fd).st_mode) and os.read(fd, 16) == b'SQLite format 3\x00': kind = 'database'
            finally: os.close(fd)
        except OSError: pass
    return {'name': name, 'kind': kind, 'size': info.st_size, 'modified': datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).isoformat()}

def snapshot(parent, name, destination, budget, optional=False):
    try: fd = os.open(name, flags, dir_fd=parent)
    except FileNotFoundError:
        if optional: return budget
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode): raise ValueError('Only regular database files can be inspected.')
        if info.st_size > budget: raise ValueError('Database and WAL snapshots are limited to 64 MiB.')
        with open(destination, 'wb') as output:
            while True:
                chunk = os.read(fd, min(65536, budget + 1))
                if not chunk: break
                budget -= len(chunk)
                if budget < 0: raise ValueError('Database and WAL snapshots are limited to 64 MiB.')
                output.write(chunk)
        return budget
    finally: os.close(fd)

def inspect(parent, name):
    # The Node parent owns cleanup, even if this helper is killed by a resource limit.
    filename = os.path.join(snapshot_folder, 'snapshot.db')
    budget = snapshot(parent, name, filename, MAX_BYTES)
    snapshot(parent, name + '-wal', filename + '-wal', budget, optional=True)
    db = sqlite3.connect('file:' + filename + '?mode=ro', uri=True, timeout=0)
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        db.execute('PRAGMA cache_size=-2048')
        started = time.monotonic()
        db.set_progress_handler(lambda: time.monotonic() - started > 2, 1000)
        # Do not execute views or virtual tables supplied by an untrusted database.
        tables = db.execute("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ? OFFSET ?", (PAGE + 1, table_offset)).fetchall()
        result = {'tables': [r[0] for r in tables[:PAGE]], 'tableOffset': table_offset}
        if len(tables) > PAGE: result['nextTableOffset'] = table_offset + PAGE
        if any(len(n) > 256 for n in result['tables']): raise ValueError('Database table names exceed the browser limit.')
        if table:
            found = db.execute("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name=? AND name NOT LIKE 'sqlite_%'", (table,)).fetchone()
            if not found: raise ValueError('That table is not available for inspection (views and virtual tables are excluded).')
            columns = db.execute('SELECT name, type, "notnull", pk FROM pragma_table_xinfo(?) LIMIT 33', (table,)).fetchall()
            shown = columns[:32]
            if any(len(c[0]) > 256 or len(c[1]) > 256 for c in shown): raise ValueError('Database column metadata exceeds the browser limit.')
            quote = lambda s: '"' + s.replace('"', '""') + '"'
            expressions = []
            for col in shown:
                c = quote(col[0])
                expressions.append("CASE WHEN typeof(" + c + ")='blob' THEN '[BLOB ' || length(" + c + ") || ' bytes]' WHEN " + c + " IS NULL THEN NULL ELSE substr(CAST(" + c + " AS TEXT),1,256) END")
            statement = 'SELECT ' + ','.join(expressions) + ' FROM ' + quote(table) + ' LIMIT ? OFFSET ?'
            rows = db.execute(statement, (ROWS + 1, offset)).fetchall()
            schema = db.execute('SELECT substr(sql,1,8192) FROM sqlite_schema WHERE type=\'table\' AND name=?', (table,)).fetchone()
            result.update({'table': table, 'columns': [{'name': c[0], 'type': c[1], 'notNull': bool(c[2]), 'primaryKey': bool(c[3])} for c in shown], 'columnsTruncated': len(columns) > 32, 'schema': schema[0] if schema else '', 'rows': rows[:ROWS], 'offset': offset})
            if len(rows) > ROWS: result['nextOffset'] = offset + ROWS
        return result
    finally: db.close()

current = None
try:
    current = os.open(root, flags | os.O_DIRECTORY)
    for component in ['channels', channel, 'workspace'] + ([p for p in relative.split('/') if p] if mode == 'directory' else relative.split('/')[:-1]):
        child = open_dir(current, component)
        os.close(current)
        current = child
    if mode == 'directory':
        entries = []
        more = False
        with os.scandir(current) as listing:
            for index, entry in enumerate(listing):
                if index < offset: continue
                if len(entries) == PAGE:
                    more = True
                    break
                try: entries.append(metadata(current, entry.name))
                except OSError: continue
        result = {'entries': entries, 'offset': offset}
        if more: result['nextOffset'] = index
    else:
        result = inspect(current, relative.split('/')[-1])
    print(json.dumps(result, ensure_ascii=False))
except ValueError as error:
    print(json.dumps({'error': str(error), 'status': 422}))
except sqlite3.Error:
    print(json.dumps({'error': 'The database snapshot could not be read. It may be invalid, locked or changing; try again.', 'status': 422}))
except OSError:
    print(json.dumps({'error': 'Workspace path is unavailable. Symlinks are not followed.', 'status': 404}))
finally:
    if current is not None: os.close(current)
`;

export class WorkspaceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

let active = 0;
const number = (value: string | null): number => {
  if (value === null) return 0;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 10_000) throw new WorkspaceError(400, "Page offset must be between 0 and 10000.");
  return Number(value);
};

export async function browseWorkspace(source: Console2Source, channel: ChannelRecord, database: boolean, query: URLSearchParams): Promise<WorkspaceResponse | DatabaseResponse> {
  if (channel.isDm) throw new WorkspaceError(403, "Workspace contents are not shown for direct messages.");
  if (!source.resolve(channel)) throw new WorkspaceError(404, "That channel's workspace is unavailable.");
  const path = query.get("path") ?? "";
  if (path.length > 2048 || path.includes("\\") || path.includes("\0") || (path !== "" && path.split("/").some((p) => !p || p === "." || p === "..")) || (database && !path)) throw new WorkspaceError(400, "Select a relative workspace path without traversal components.");
  const offset = number(query.get("offset"));
  const tableOffset = number(query.get("tableOffset"));
  const table = query.get("table") ?? "";
  if (table.length > 256 || table.includes("\0")) throw new WorkspaceError(400, "Invalid table name.");
  if (active >= 2) throw new WorkspaceError(429, "The workspace browser is busy. Try again shortly.");
  active++;
  let snapshotFolder: string | undefined;
  try {
    snapshotFolder = database ? await mkdtemp(join(tmpdir(), "harness-workspace-")) : "";
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.env.HARNESS_ARTIFACT_PYTHON || "python3", ["-c", BROWSE, source.dataDir, channel.id, database ? "database" : "directory", path, String(offset), table, String(tableOffset), snapshotFolder!], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) reject(new WorkspaceError(503, "Workspace browsing requires Python 3 with sqlite3; the helper was unavailable or exceeded its resource limit."));
        else resolve(stdout);
      });
    });
    const result = JSON.parse(output);
    if (result.error) throw new WorkspaceError(result.status, result.error);
    return { channelId: channel.id, path, ...result };
  } finally {
    if (snapshotFolder) await rm(snapshotFolder, { recursive: true, force: true }).catch(() => {});
    active--;
  }
}
