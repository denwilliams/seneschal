import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ListColumn, ListItem, ListsView } from "../console2/api-types.ts";
export type { ListColumn, ListItem, ListsView } from "../console2/api-types.ts";

export const MAX_ITEM_BYTES = 16 * 1024;

const name = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "Use 1–48 lowercase letters, digits or underscores, starting with a letter.");
const fields = z.record(z.string(), z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]));
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const listMutation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), list: name }).strict(),
  z.object({ op: z.literal("rename"), list: name, name }).strict(),
  z.object({ op: z.literal("delete_list"), list: name, confirm: z.literal(true) }).strict(),
  z.object({ op: z.literal("add_column"), list: name, column: name, type: z.enum(["text", "integer", "real", "boolean"]) }).strict(),
  z.object({ op: z.literal("drop_column"), list: name, column: name, confirm: z.literal(true) }).strict(),
  z.object({ op: z.literal("add_item"), list: name, values: fields }).strict(),
  z.object({ op: z.literal("update_item"), list: name, id, values: fields }).strict(),
  z.object({ op: z.literal("delete_item"), list: name, id }).strict(),
]);
export type ListMutation = z.infer<typeof listMutation>;
export class ListError extends Error {}
const STANDARD = ["id", "title", "notes", "completed", "created_at", "updated_at"];
const TYPES = { text: "TEXT", integer: "INTEGER", real: "REAL", boolean: "BOOLEAN" };
const table = (n: string) => `"list_${name.parse(n)}"`;
const quote = (n: string) => `"${name.parse(n)}"`;

/** The root comes ONLY from resolved channel context, never a tool argument. Outside the workspace jail.
 * Refuse symlinks in ancestors, database and sidecars (also hard links). These operator-owned paths
 * must not be writable by sandbox processes. Open only for one synchronous transaction and always close.
 */
function safeFile(root: string): string {
  let path = resolve(root);
  for (;;) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ListError("Unsafe lists directory.");
    if (dirname(path) === path) break;
    path = dirname(path);
  }
  const file = join(resolve(root), "lists.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const info = lstatSync(file + suffix);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new ListError("Unsafe lists database or sidecar.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return file;
}

export class ChannelLists {
  private readonly channelRoot: string;
  constructor(channelRoot: string) { this.channelRoot = channelRoot; }
  private run<T>(write: boolean, fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(safeFile(this.channelRoot));
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;");
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      try { const result = fn(db); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      if (error instanceof ListError) throw error;
      if (error instanceof z.ZodError) throw new ListError(error.issues.map((i) => i.message).join("; "));
      throw new ListError("List operation failed: a name may already exist, or the database is unavailable.");
    } finally { db.close(); }
  }
  private names(db: DatabaseSync): string[] {
    return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'list_*' ORDER BY name LIMIT 101").all().map((r) => String(r.name).slice(5));
  }
  private columns(db: DatabaseSync, list: string): ListColumn[] {
    if (!this.names(db).includes(list)) throw new ListError("No such list in this channel.");
    return db.prepare(`PRAGMA table_info(${table(list)})`).all().map((r) => ({ name: String(r.name), type: String(r.type).toLowerCase(), standard: STANDARD.includes(String(r.name)), editable: !["id", "created_at", "updated_at"].includes(String(r.name)) }));
  }
  private checkItemSizes(db: DatabaseSync, list: string, columns: ListColumn[], itemId?: number): void {
    const query = db.prepare(`SELECT * FROM ${table(list)}${itemId === undefined ? "" : " WHERE id=?"}`);
    const rows = itemId === undefined ? query.iterate() : query.iterate(itemId);
    // Count persisted editable values, including defaults/nulls and canonical booleans, for item AND schema writes.
    // Stream all rows for schema changes; validation stays inside the transaction so even ALTER TABLE rolls back.
    for (const row of rows) {
      const data = Object.fromEntries(columns.filter((c) => c.editable).map((c) => [c.name, c.type === "boolean" && row[c.name] !== null ? !!row[c.name] : row[c.name]]));
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_ITEM_BYTES) throw new ListError("An item is limited to 16 KiB of data.");
    }
  }
  read(list?: string, offset = 0): ListsView {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ListError("Invalid page offset.");
    return this.run(false, (db) => {
      const lists = this.names(db);
      if (!list) return { lists };
      const columns = this.columns(db, list);
      const rows = db.prepare(`SELECT * FROM ${table(list)} ORDER BY id LIMIT 51 OFFSET ?`).all(offset);
      const items: ListItem[] = [];
      let bytes = 0;
      for (const row of rows.slice(0, 50)) {
        const item = Object.fromEntries(columns.map((c) => [c.name, c.type === "boolean" && row[c.name] !== null ? !!row[c.name] : row[c.name]])) as ListItem;
        const size = Buffer.byteLength(JSON.stringify(item));
        if (size > 64 * 1024) throw new ListError("An item exceeds the read size limit.");
        if (bytes + size > 64 * 1024) break;
        items.push(item); bytes += size;
      }
      return { lists, list, columns, items, offset, ...(rows.length > items.length ? { nextOffset: offset + items.length } : {}) };
    });
  }
  mutate(input: unknown): { ok: true; id?: number } {
    const parsed = listMutation.safeParse(input);
    if (!parsed.success) throw new ListError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const p = parsed.data;
    return this.run(true, (db) => {
      if (p.op === "create") {
        if (this.names(db).length >= 100) throw new ListError("Limit: 100 lists per channel.");
        db.exec(`CREATE TABLE ${table(p.list)} (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', completed BOOLEAN NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
        return { ok: true };
      }
      const columns = this.columns(db, p.list);
      if (p.op === "rename") db.exec(`ALTER TABLE ${table(p.list)} RENAME TO ${table(p.name)}`);
      if (p.op === "delete_list") db.exec(`DROP TABLE ${table(p.list)}`);
      if (p.op === "add_column") {
        if (STANDARD.includes(p.column)) throw new ListError("Standard columns are protected.");
        if (columns.length >= 30) throw new ListError("Limit: 24 custom columns per list.");
        db.exec(`ALTER TABLE ${table(p.list)} ADD COLUMN ${quote(p.column)} ${TYPES[p.type]}`);
        this.checkItemSizes(db, p.list, this.columns(db, p.list));
      }
      if (p.op === "drop_column") {
        if (STANDARD.includes(p.column)) throw new ListError("Standard columns are protected.");
        if (!columns.some((c) => c.name === p.column)) throw new ListError("No such custom column.");
        db.exec(`ALTER TABLE ${table(p.list)} DROP COLUMN ${quote(p.column)}`);
      }
      if (p.op === "delete_item") {
        if (!db.prepare(`DELETE FROM ${table(p.list)} WHERE id=?`).run(p.id).changes) throw new ListError("No such item.");
      }
      if (p.op === "add_item" || p.op === "update_item") {
        const entries = Object.entries(p.values);
        if (!entries.length) throw new ListError("Provide item values.");
        for (const [key, value] of entries) {
          const c = columns.find((c) => c.name === key);
          if (!c?.editable) throw new ListError(`Unknown or read-only field: ${key}`);
          if (key === "title" && (typeof value !== "string" || !value.trim())) throw new ListError("Title must be non-empty text.");
          if (value === null) { if (c.standard) throw new ListError("Standard fields cannot be null."); continue; }
          if ((c.type === "text" && typeof value !== "string") || (c.type === "boolean" && typeof value !== "boolean") || (c.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) || (c.type === "real" && typeof value !== "number")) throw new ListError(`Wrong value type for ${key}.`);
        }
        if (p.op === "add_item" && !Object.hasOwn(p.values, "title")) throw new ListError("Title is required.");
        const now = new Date().toISOString();
        const values: SQLInputValue[] = entries.map(([, v]) => typeof v === "boolean" ? Number(v) : v);
        if (p.op === "add_item") {
          const keys = [...entries.map(([k]) => quote(k)), '"created_at"', '"updated_at"'];
          const result = db.prepare(`INSERT INTO ${table(p.list)} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...values, now, now);
          this.checkItemSizes(db, p.list, columns, Number(result.lastInsertRowid));
          return { ok: true, id: Number(result.lastInsertRowid) };
        }
        const result = db.prepare(`UPDATE ${table(p.list)} SET ${entries.map(([k]) => `${quote(k)}=?`).join(",")}, updated_at=? WHERE id=?`).run(...values, now, p.id);
        if (!result.changes) throw new ListError("No such item.");
        this.checkItemSizes(db, p.list, columns, p.id);
      }
      return { ok: true };
    });
  }
}
