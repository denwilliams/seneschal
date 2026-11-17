import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface ConnectorForm {
  key: string; yaml: string; transport: string; basic: boolean;
  command: string; url: string; args: string[]; env: Record<string, string>; headers: Record<string, string>;
}
const inputClass = "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
function Entries({ label, entries, change }: { label: string; entries: Record<string, string>; change: (key: string, value?: string) => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const duplicate = Object.hasOwn(entries, name);
  return <div className="space-y-2 rounded-md border p-3">
    <h4 className="text-sm font-medium">{label}</h4>
    {Object.entries(entries).map(([key, v]) => <div key={key} className="flex min-w-0 items-end gap-2">
      <label className="min-w-0 flex-1 text-xs"><span className="block break-all pb-1">{key}</span><input aria-label={label + " value " + key} className={inputClass} value={v} onChange={(e) => change(key, e.target.value)} /></label>
      <Button variant="outline" aria-label={"Remove " + label + " " + key} onClick={() => change(key)}>Remove</Button>
    </div>)}
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <input aria-label={label + " new name"} placeholder="Name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label={label + " new value"} placeholder="Value or ${ENV_REFERENCE}" className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} />
    </div>
    {duplicate && <p className="text-xs text-destructive">That name already exists. Edit its value above.</p>}
    <Button variant="outline" disabled={!name.trim() || duplicate} onClick={() => { change(name, value); setName(""); setValue(""); }}>Add {label.toLowerCase()} entry</Button>
  </div>;
}
export function ConnectorSettings({ connectors, selected, mode, yaml, select, toggle, rawChange, change, add, remove }: {
  connectors: ConnectorForm[]; selected?: ConnectorForm; mode: "basic" | "raw"; yaml?: string;
  select: (name: string) => void; toggle: (mode: "basic" | "raw") => void; rawChange: (yaml: string) => void;
  change: (path: string[], value?: string | string[]) => void; add: (name: string, transport: "stdio" | "http") => void; remove: () => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const duplicate = connectors.some((c) => c.key === name);
  return <section aria-label="Connector management" className="min-w-0 space-y-3 rounded-md border p-3">
    <h2 className="font-semibold">Connectors</h2>
    <p className="text-sm text-muted-foreground">Supported transports: stdio and HTTP. Definitions do not grant channel access. Advanced settings (including OAuth) stay in the draft and can be edited in connector YAML. Environment references are not expanded.</p>
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <label className="min-w-0 space-y-1 text-sm">New connector name<input aria-label="New connector name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="min-w-0 space-y-1 text-sm">New connector transport<select aria-label="New connector transport" className={inputClass} value={transport} onChange={(e) => setTransport(e.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>
    </div>
    {duplicate && <p className="text-sm text-destructive">A connector with that name already exists.</p>}
    <Button variant="outline" disabled={!name.trim() || duplicate} onClick={() => add(name, transport)}>Add connector</Button>
    {connectors.length ? <>
      <label className="block min-w-0 space-y-1 text-sm">Connector<select aria-label="Connector" className={inputClass} value={selected?.key ?? ""} onChange={(e) => select(e.target.value)}>{connectors.map((c) => <option key={c.key} value={c.key}>{c.key} ({c.transport || "invalid transport"})</option>)}</select></label>
      {selected && <>
        <div role="group" aria-label="Connector editor mode" className="flex flex-wrap gap-2">
          <Button variant={mode === "basic" ? "secondary" : "outline"} aria-pressed={mode === "basic"} onClick={() => toggle("basic")}>Connector form</Button>
          <Button variant={mode === "raw" ? "secondary" : "outline"} aria-pressed={mode === "raw"} onClick={() => toggle("raw")}>Connector YAML</Button>
          <Button variant="outline" onClick={remove}>Remove connector</Button>
        </div>
        {mode === "raw" ? <label className="block space-y-2 text-sm">Connector definition (YAML)<textarea aria-label="Connector definition YAML" className={inputClass + " min-h-64 font-mono text-xs"} spellCheck={false} value={yaml ?? selected.yaml} onChange={(e) => rawChange(e.target.value)} /></label>
          : !selected.basic ? <p className="text-sm text-destructive">This definition cannot be represented by the basic form. Use Connector YAML to fix it; nothing has been dropped.</p>
          : selected.transport === "stdio" ? <div className="space-y-3">
            <label className="block space-y-1 text-sm">Command<input aria-label="Connector command" className={inputClass} value={selected.command} onChange={(e) => change(["command"], e.target.value)} /></label>
            <div className="space-y-2 rounded-md border p-3"><h4 className="text-sm font-medium">Arguments (one value per row)</h4>
              {selected.args.map((arg, index) => <div key={index} className="flex min-w-0 gap-2"><input aria-label={"Argument " + (index + 1)} className={inputClass} value={arg} onChange={(e) => change(["args"], selected.args.map((a, i) => i === index ? e.target.value : a))} /><Button variant="outline" aria-label={"Remove argument " + (index + 1)} onClick={() => change(["args"], selected.args.filter((_, i) => i !== index))}>Remove</Button></div>)}
              <Button variant="outline" onClick={() => change(["args"], [...selected.args, ""])}>Add argument</Button>
            </div>
            <Entries key={selected.key + "env"} label="Environment" entries={selected.env} change={(key, v) => change(["env", key], v)} />
          </div> : <div className="space-y-3">
            <label className="block space-y-1 text-sm">URL<input aria-label="Connector URL" className={inputClass} value={selected.url} onChange={(e) => change(["url"], e.target.value)} /></label>
            <Entries key={selected.key + "headers"} label="Headers" entries={selected.headers} change={(key, v) => change(["headers", key], v)} />
          </div>}
      </>}
    </> : <p className="text-sm text-muted-foreground">No connector definitions yet.</p>}
  </section>;
}
