import { useState } from "react";
import { Database, FileText, Folder } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes } from "@/lib/format";
import { Async, Empty, Notice, Section } from "@/components/common";
import { Button } from "@/components/ui/button";

export function WorkspaceBrowser({ channelId, refreshToken }: { channelId: string; refreshToken: number }) {
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState(0);
  const [database, setDatabase] = useState<string>();
  const listing = useApi((signal) => api.workspace(channelId, path, offset, signal), JSON.stringify(["workspace", channelId, path, offset]), refreshToken);
  const navigate = (next: string) => { setPath(next); setOffset(0); setDatabase(undefined); };
  return <Section title="Workspace">
    <p className="mb-2 text-xs text-muted-foreground">Read-only channel files. Open a SQLite database to inspect tables. No downloads or editing.</p>
    <nav aria-label="Workspace path" className="mb-3 flex flex-wrap items-center gap-1 text-xs">
      <Button size="sm" variant="outline" onClick={() => navigate("")}>Workspace root</Button>
      {path && <Button size="sm" variant="outline" onClick={() => navigate(path.split("/").slice(0, -1).join("/"))}>Parent directory</Button>}
      <span className="min-w-0 break-all font-mono">/{path}</span>
      {!database && <Button size="sm" variant="ghost" onClick={listing.reload}>Refresh files</Button>}
    </nav>
    {listing.data && listing.error && !database && <Notice>{listing.error}</Notice>}
    {database ? <DatabaseBrowser key={database} channelId={channelId} path={database} refreshToken={refreshToken} onClose={() => setDatabase(undefined)} /> : <Async result={listing}>{(data) => <>
      {data.entries.length === 0 ? <Empty>This directory is empty.</Empty> : <ul aria-label="Workspace files" className="divide-y rounded-md border">
        {data.entries.map((entry) => {
          const clickable = entry.kind === "directory" || entry.kind === "database";
          const Icon = entry.kind === "directory" ? Folder : entry.kind === "database" ? Database : FileText;
          return <li key={entry.name} className="flex min-w-0 items-start gap-2 px-3 py-2 text-sm">
            <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              {clickable ? <button className="break-all text-left font-mono text-xs underline underline-offset-2" onClick={() => {
                const next = path ? `${path}/${entry.name}` : entry.name;
                if (entry.kind === "directory") navigate(next); else setDatabase(next);
              }}>{entry.name}{entry.kind === "directory" ? "/" : ""}</button> : <span className="break-all font-mono text-xs">{entry.name}</span>}
              <p className="text-[11px] text-muted-foreground">{entry.kind} · {formatBytes(entry.size)} · <time dateTime={entry.modified}>{new Date(entry.modified).toLocaleDateString()}</time>{entry.kind === "symlink" && " · not followed"}</p>
            </div>
          </li>;
        })}
      </ul>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous files</Button>
        <Button size="sm" variant="outline" disabled={data.nextOffset === undefined || data.nextOffset > 10000} onClick={() => setOffset(data.nextOffset!)}>Next files</Button>
        <span className="text-xs text-muted-foreground">Up to 100 entries per page</span>
      </div>
      {data.nextOffset !== undefined && data.nextOffset > 10000 && <Notice>Browsing stops at 10,000 entries in one directory.</Notice>}
    </>}</Async>}
  </Section>;
}

function DatabaseBrowser({ channelId, path, refreshToken, onClose }: { channelId: string; path: string; refreshToken: number; onClose: () => void }) {
  const [table, setTable] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [tableOffset, setTableOffset] = useState(0);
  const result = useApi((signal) => api.database(channelId, path, table, offset, tableOffset, signal), JSON.stringify(["database", channelId, path, table, offset, tableOffset]), refreshToken);
  return <div className="min-w-0 space-y-3" aria-label="SQLite database browser">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={onClose}>Back to files</Button>
      <Button size="sm" variant="ghost" onClick={result.reload}>Refresh database</Button>
    </div>
    <h3 className="break-all font-mono text-sm">{path}</h3>
    <Notice>Read-only snapshot, up to 64 MiB including WAL. Views and virtual tables are excluded. Refresh to retry a changing database.</Notice>
    {result.data && result.error && <Notice>{result.error}</Notice>}
    <Async result={result}>{(data) => <>
      <label className="block space-y-1 text-xs">Table
        <select aria-label="Database table" className="block w-full min-w-0 rounded-md border bg-background p-2" value={table ?? ""} onChange={(event) => { setTable(event.target.value || undefined); setOffset(0); }}>
          <option value="">Select a table</option>
          {table && !data.tables.includes(table) && <option value={table}>{table}</option>}
          {data.tables.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      {data.tables.length === 0 && <Empty>No ordinary tables on this page.</Empty>}
      {(tableOffset > 0 || data.nextTableOffset !== undefined) && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={tableOffset === 0} onClick={() => setTableOffset(Math.max(0, tableOffset - 100))}>Previous tables</Button>
        <Button size="sm" variant="outline" disabled={data.nextTableOffset === undefined || data.nextTableOffset > 10000} onClick={() => setTableOffset(data.nextTableOffset!)}>Next tables</Button>
      </div>}
      {data.nextTableOffset !== undefined && data.nextTableOffset > 10000 && <Notice>Browsing stops at table offset 10,000.</Notice>}
      {data.table && <>
        <details><summary className="cursor-pointer text-sm">Schema and columns</summary>
          <p className="mt-2 text-xs text-muted-foreground">Schema text is limited to 8,192 characters.</p>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">{data.schema}</pre>
          <ul className="mt-2 space-y-1 text-xs">{data.columns?.map((column) => <li key={column.name} className="break-all font-mono">{column.name} · {column.type || "no type"}{column.primaryKey ? " · primary key" : ""}{column.notNull ? " · not null" : ""}</li>)}</ul>
        </details>
        <p className="text-xs text-muted-foreground">Up to 50 rows, 32 columns and 256 characters per cell. BLOBs show sizes; values are display text. Row order is database order; pages are not a transaction.</p>
        {data.columnsTruncated && <Notice>Only the first 32 columns are shown.</Notice>}
        <div className="max-w-full overflow-x-auto rounded border" role="region" aria-label="Table contents" tabIndex={0}>
          <table className="w-full text-left text-xs">
            <thead><tr>{data.columns?.map((col) => <th key={col.name} className="border-b p-2 align-top"><span className="block max-w-48 break-all">{col.name}</span></th>)}</tr></thead>
            <tbody>{data.rows?.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b p-2 align-top"><span className="block max-w-48 break-all">{cell === null ? <em className="text-muted-foreground">NULL</em> : cell}</span></td>)}</tr>)}</tbody>
          </table>
        </div>
        {data.rows?.length === 0 && <Empty>This table page is empty.</Empty>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous rows</Button>
          <Button size="sm" variant="outline" disabled={data.nextOffset === undefined || data.nextOffset > 10000} onClick={() => setOffset(data.nextOffset!)}>Next rows</Button>
          <span className="text-xs text-muted-foreground">Row offset {offset}</span>
        </div>
        {data.nextOffset !== undefined && data.nextOffset > 10000 && <Notice>Browsing stops at row offset 10,000.</Notice>}
      </>}
    </>}</Async>
  </div>;
}
