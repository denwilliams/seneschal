import { useState } from "react";
import type { ListColumn, ListItem } from "@api/api-types";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Async, Empty, Section } from "@/components/common";
import { Button } from "@/components/ui/button";

const inputClass = "w-full min-w-0 rounded border bg-background px-2 py-1 text-sm";
type Mutate = (body: Record<string, unknown>) => Promise<boolean>;

function ItemEditor({ item, columns, list, mutate, disabled }: { item: ListItem; columns: ListColumn[]; list: string; mutate: Mutate; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<ListItem>(() => Object.fromEntries(columns.filter((c) => c.editable).map((c) => [c.name, item[c.name] ?? null])));
  return <details onToggle={(e) => setOpen(e.currentTarget.open)} className="min-w-0 rounded border p-2">
    <summary className="cursor-pointer break-words text-sm">{item.completed ? "✓ " : "○ "}{String(item.title)} <span className="text-xs text-muted-foreground">#{item.id}</span></summary>
    {open && <form className="mt-3 space-y-3" onSubmit={async (event) => { event.preventDefault(); await mutate({ op: "update_item", list, id: item.id, values }); }}>
      <fieldset disabled={disabled} className="space-y-3">
        {columns.filter((c) => c.editable).map((c) => <label key={c.name} className="block space-y-1 text-xs">
          <span>{c.name} <span className="text-muted-foreground">{c.standard ? "" : `(${c.type}, nullable)`}</span></span>
          {c.type === "boolean" ? <select aria-label={c.name} className={inputClass} value={values[c.name] === null ? "" : String(values[c.name])} onChange={(e) => setValues({ ...values, [c.name]: e.target.value === "" ? null : e.target.value === "true" })}>
            {!c.standard && <option value="">Not set</option>}<option value="false">False</option><option value="true">True</option>
          </select> : c.name === "notes" ? <textarea aria-label={c.name} className={inputClass} maxLength={4000} value={String(values[c.name] ?? "")} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })} /> :
            <input aria-label={c.name} className={inputClass} type={c.type === "text" ? "text" : "number"} step={c.type === "integer" ? "1" : "any"} required={c.name === "title"} maxLength={4000} value={String(values[c.name] ?? "")} onChange={(e) => setValues({ ...values, [c.name]: e.target.value === "" && !c.standard ? null : c.type === "text" ? e.target.value : Number(e.target.value) })} />}
        </label>)}
        <p className="break-all text-[11px] text-muted-foreground">Created {String(item.created_at)}<br />Updated {String(item.updated_at)} · ID and timestamps are read-only.</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" type="submit">Save item</Button><Button size="sm" variant="outline" type="button" onClick={async () => { if (window.confirm(`Delete item #${item.id}?`)) await mutate({ op: "delete_item", list, id: item.id }); }}>Delete item</Button></div>
      </fieldset>
    </form>}
  </details>;
}

function SchemaEditor({ list, columns, mutate, disabled }: { list: string; columns: ListColumn[]; mutate: Mutate; disabled: boolean }) {
  const [column, setColumn] = useState("");
  const [type, setType] = useState("text");
  const [newName, setNewName] = useState(list);
  return <details className="rounded border p-2 text-xs">
    <summary className="cursor-pointer">List settings and custom columns</summary>
    <fieldset disabled={disabled} className="mt-3 space-y-3">
      <p className="text-muted-foreground">Standard columns cannot be removed. New custom columns default to null. Empty custom inputs are saved as null.</p>
      {columns.filter((c) => !c.standard).map((c) => <div key={c.name} className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-all">{c.name} ({c.type})</span><Button size="sm" variant="outline" onClick={async () => { if (window.confirm(`Remove column ${c.name} and all its values?`)) await mutate({ op: "drop_column", list, column: c.name, confirm: true }); }}>Remove {c.name}</Button></div>)}
      <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); if (await mutate({ op: "add_column", list, column, type })) setColumn(""); }}>
        <label className="block">New column name<input className={inputClass} required pattern="[a-z][a-z0-9_]*" maxLength={48} value={column} onChange={(e) => setColumn(e.target.value)} /></label>
        <label className="block">Column type<select aria-label="Column type" className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>{["text", "integer", "real", "boolean"].map((t) => <option key={t}>{t}</option>)}</select></label>
        <Button size="sm" type="submit">Add column</Button>
      </form>
      <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); await mutate({ op: "rename", list, name: newName }); }}>
        <label className="block">Rename list<input className={inputClass} required pattern="[a-z][a-z0-9_]*" maxLength={48} value={newName} onChange={(e) => setNewName(e.target.value)} /></label><Button size="sm" variant="outline" type="submit">Rename</Button>
      </form>
      <Button size="sm" variant="outline" onClick={async () => { if (window.confirm(`Delete list ${list} and ALL its items?`)) await mutate({ op: "delete_list", list, confirm: true }); }}>Delete list</Button>
    </fieldset>
  </details>;
}

export function ListsPanel({ channelId, refreshToken }: { channelId: string; refreshToken: number }) {
  const [selected, setSelected] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [pages, setPages] = useState<number[]>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [newList, setNewList] = useState("");
  const [title, setTitle] = useState("");
  const view = useApi((signal) => api.lists(channelId, selected, offset, signal), `lists:${channelId}:${selected ?? ""}:${offset}`, refreshToken + version);
  const mutate: Mutate = async (body) => {
    setBusy(true); setMessage(""); setError("");
    try {
      await api.updateList(channelId, body);
      if (body.op === "rename" || body.op === "create") { setSelected(String(body.name ?? body.list)); setOffset(0); setPages([]); }
      if (body.op === "delete_list") { setSelected(undefined); setOffset(0); setPages([]); }
      setVersion((v) => v + 1); setMessage("Saved."); return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); return false; }
    finally { setBusy(false); }
  };
  return <Section title="Channel lists">
    <p className="mb-3 text-xs text-muted-foreground">Shared with the assistant in this channel. Refresh to see its latest edits.</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => setVersion((v) => v + 1)}>Refresh lists</Button>
    {message && <p role="status" className="mt-2 text-xs">{message}</p>}{error && <p role="alert" className="mt-2 break-words text-xs text-destructive">{error}</p>}
    <Async result={view}>{(v) => <div className="mt-3 min-w-0 space-y-3">
      {!v.writable && <p className="text-xs text-muted-foreground">Read-only. Enable webConsole.actions to edit lists.</p>}
      {v.lists.length ? <label className="block text-xs">List<select aria-label="List" className={inputClass} value={selected ?? ""} onChange={(e) => { setSelected(e.target.value || undefined); setOffset(0); setPages([]); setError(""); setMessage(""); }}><option value="">Choose a list</option>{v.lists.map((n) => <option key={n}>{n}</option>)}</select></label> : <Empty>No lists yet.</Empty>}
      {v.list && <>
        <div className="space-y-2">{v.items?.map((item) => <ItemEditor key={JSON.stringify(item)} item={item} columns={v.columns ?? []} list={v.list!} mutate={mutate} disabled={busy || !v.writable} />)}{!v.items?.length && <Empty>No items yet.</Empty>}</div>
        <div className="flex flex-wrap gap-2">{offset > 0 && <Button size="sm" variant="outline" onClick={() => { setOffset(pages.at(-1) ?? 0); setPages((p) => p.slice(0, -1)); }}>Previous items</Button>}{v.nextOffset !== undefined && <Button size="sm" variant="outline" onClick={() => { setPages((p) => [...p, offset]); setOffset(v.nextOffset!); }}>Next items</Button>}</div>
        <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); if (await mutate({ op: "add_item", list: v.list, values: { title } })) setTitle(""); }}><label className="block text-xs">New item title<input className={inputClass} required maxLength={4000} disabled={busy || !v.writable} value={title} onChange={(e) => setTitle(e.target.value)} /></label><Button size="sm" type="submit" disabled={busy || !v.writable}>Add item</Button></form>
        <SchemaEditor key={v.list} list={v.list} columns={v.columns ?? []} mutate={mutate} disabled={busy || !v.writable} />
      </>}
      <form className="space-y-2 border-t pt-3" onSubmit={async (e) => { e.preventDefault(); if (await mutate({ op: "create", list: newList })) setNewList(""); }}><label className="block text-xs">New list name<input className={inputClass} required pattern="[a-z][a-z0-9_]*" maxLength={48} disabled={busy || !v.writable} value={newList} onChange={(e) => setNewList(e.target.value)} /></label><p className="text-[11px] text-muted-foreground">Lowercase letters, digits and underscores; start with a letter.</p><Button size="sm" type="submit" disabled={busy || !v.writable}>Create list</Button></form>
    </div>}</Async>
  </Section>;
}
