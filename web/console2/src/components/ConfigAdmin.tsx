import { lazy, Suspense, useEffect, useState } from "react";
import { ConnectorSettings, type ConnectorForm } from "./ConnectorSettings";
import { SecretAdmin } from "./SecretAdmin";
import { Button } from "@/components/ui/button";
import { apiUrl, ApiError } from "@/lib/api";

const YamlEditor = lazy(() => import("@/components/YamlEditor").then((module) => ({ default: module.YamlEditor })));

type Fields = Record<string, string | undefined>;
interface Form { defaults: Fields; channels: (Fields & { key: string })[]; connectors: ConnectorForm[] }
interface Edit { path: string[]; value?: string | string[]; remove?: boolean; yaml?: string; create?: boolean }
interface Snapshot { text: string; revision: string }
interface Saved { saved: boolean; applied: boolean; revision: string; warnings: string[] }
async function request<T>(body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try { response = await fetch(apiUrl("config"), {
    method: body ? "POST" : "GET", cache: "no-store",
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json", "x-console-admin": "1" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }); } catch { throw new Error("Network request failed. If you were saving, the outcome is unknown; copy your draft before reloading persisted config to check."); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error("The server did not return JSON. Check your access-proxy session and the harness connection."); }
  if (!response.ok) throw new ApiError(response.status, result.error ?? "Configuration request failed.");
  return result as T;
}
const inputClass = "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
const thinking = ["off", "minimal", "low", "medium", "high", "xhigh"];
function Field({ label, value, fallback, onChange, choices, multiline }: {
  label: string; value?: string; fallback?: string; onChange: (value?: string) => void; choices?: string[]; multiline?: boolean;
}) {
  return <div className="space-y-2 rounded-md border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{label}</span>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={label + " explicit override"} checked={value !== undefined} onChange={(e) => onChange(e.target.checked ? fallback ?? "" : undefined)} />Explicit override</label>
    </div>
    {choices ? <select className={inputClass} aria-label={label} disabled={value === undefined} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      {value === undefined && <option value="">Inherited</option>}
      {value !== undefined && !choices.includes(value) && <option value={value}>{value || "(empty)"}</option>}
      {choices.map((c) => <option key={c}>{c}</option>)}
    </select> : multiline ? <textarea className={inputClass} rows={3} aria-label={label} disabled={value === undefined} value={value ?? ""} placeholder={fallback} onChange={(e) => onChange(e.target.value)} />
      : <input className={inputClass} aria-label={label} disabled={value === undefined} value={value ?? ""} placeholder={fallback} onChange={(e) => onChange(e.target.value)} />}
    <p className="break-words text-xs text-muted-foreground">{value === undefined ? "Inherited / unset" : "Explicit value — uncheck to return to inheritance"}{fallback !== undefined ? ": " + fallback : ""}</p>
  </div>;
}

export function ConfigAdmin({ active }: { active: boolean }) {
  const [showSecrets, setShowSecrets] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"raw" | "forms">("raw");
  const [form, setForm] = useState<Form>();
  const [channel, setChannel] = useState("");
  const [edits, setEdits] = useState<Edit[]>([]);
  const [connector, setConnector] = useState("");
  const [connectorMode, setConnectorMode] = useState<"basic" | "raw">("basic");
  const [connectorYaml, setConnectorYaml] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = !!snapshot && (snapshot.text !== text || edits.length > 0 || connectorYaml !== undefined);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); }
    catch (e) { setError((e instanceof Error ? e.message : "Network request failed.") + " Your draft has not been discarded."); }
    finally { setBusy(false); }
  }
  async function load() {
    const loaded = await request<Snapshot>();
    setSnapshot(loaded); setText(loaded.text); setEdits([]); setMode("raw"); setForm(undefined); setConnectorYaml(undefined); setConnectorMode("basic");
    setMessage("Persisted configuration loaded. Values are not expanded from the environment.");
  }
  useEffect(() => { if (active && !snapshot && !busy && !error) void run(load); }, [active, snapshot, busy, error]);
  async function draft(extra: Edit[] = []): Promise<string> {
    const pending = [...edits, ...(connectorYaml === undefined ? [] : [{ path: ["connectors", connector], yaml: connectorYaml }]), ...extra];
    if (!pending.length) return text;
    const patched = await request<Form & { text: string }>({ operation: "patch", text, edits: pending });
    setText(patched.text); setEdits([]); setConnectorYaml(undefined); setForm(patched);
    return patched.text;
  }
  function changeConnector(path: string[], value?: string | string[]) {
    setMessage(""); setError("");
    const fullPath = ["connectors", connector, ...path];
    setEdits((previous) => [...previous.filter((e) => JSON.stringify(e.path) !== JSON.stringify(fullPath)), { path: fullPath, ...(value === undefined ? { remove: true } : { value }) }]);
    setForm((previous) => previous && { ...previous, connectors: previous.connectors.map((c) => {
      if (c.key !== connector) return c;
      if (path.length === 1) return { ...c, [path[0]!]: value };
      const field = path[0] as "env" | "headers";
      const entries = Object.fromEntries([...Object.entries(c[field]).filter(([key]) => key !== path[1]), ...(value === undefined ? [] : [[path[1]!, value as string]])]);
      return { ...c, [field]: entries };
    }) });
  }
  async function selectConnector(name: string, next = connectorMode) {
    await draft(); setConnector(name); setConnectorMode(next);
  }
  async function addConnector(name: string, transport: "stdio" | "http") {
    await draft([{ path: ["connectors", name], create: true, yaml: transport === "stdio" ? "transport: stdio\ncommand: \"\"\n" : "transport: http\nurl: \"\"\n" }]);
    setConnector(name); setConnectorMode("basic");
    setMessage("Connector added to the unsaved draft. Complete its settings, then validate and save. Channel access has not changed.");
  }
  async function removeConnector() {
    if (!window.confirm("Remove connector \"" + connector + "\" from this draft? Channel references are not changed; validation may require you to update them.")) return;
    await draft([{ path: ["connectors", connector], remove: true }]);
    setConnector(form?.connectors.find((c) => c.key !== connector)?.key ?? ""); setConnectorMode("basic");
    setMessage("Connector removed from the unsaved draft. Nothing saved or applied.");
  }
  function change(path: string[], value?: string) {
    setMessage(""); setError("");
    setEdits((previous) => [...previous.filter((e) => JSON.stringify(e.path) !== JSON.stringify(path)), { path, ...(value === undefined ? { remove: true } : { value }) }]);
    setForm((previous) => previous && (path[0] === "defaults" ? { ...previous, defaults: { ...previous.defaults, [path[1]!]: value } }
      : { ...previous, channels: previous.channels.map((c) => c.key === path[1] ? { ...c, [path[2]!]: value } : c) }));
  }
  async function switchMode(next: "raw" | "forms") {
    if (next === mode) return;
    const current = await draft();
    if (next === "forms") {
      const inspected = await request<Form>({ operation: "inspect", text: current });
      setForm(inspected);
      if (!inspected.connectors.some((c) => c.key === connector)) setConnector(inspected.connectors[0]?.key ?? "");
      if (!inspected.channels.some((c) => c.key === channel)) setChannel(inspected.channels[0]?.key ?? "");
    }
    setMode(next);
  }
  async function validate(save: boolean) {
    const current = await draft();
    if (!save) {
      await request({ operation: "validate", text: current });
      setMessage("Valid configuration. Nothing saved or applied.");
      return;
    }
    const saved = await request<Saved>({ operation: "save", text: current, revision: snapshot!.revision });
    setSnapshot({ text: current, revision: saved.revision });
    setMessage((saved.applied ? "Saved. Reload completed; restart-only settings and active turns may still use the previous config." : "Saved, but NOT applied. Restart required.") + (saved.warnings.length ? "\n" + saved.warnings.join("\n") : ""));
  }
  const selected = form?.channels.find((c) => c.key === channel);
  const selectedConnector = form?.connectors.find((c) => c.key === connector);
  return <section aria-label="Configuration administration" className="h-full overflow-y-auto">
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-semibold">Configuration</h1><a href="#/" className="text-sm underline">Back to console</a></div>
      <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">Full operator administration. There is no built-in login. Protect this page and its APIs with Cloudflare Zero Trust or equivalent. Raw YAML may contain literal secrets; environment references stay unexpanded.</p>
      <div role="group" aria-label="Administration area" className="flex flex-wrap gap-2">
        <Button variant={!showSecrets ? "secondary" : "outline"} aria-pressed={!showSecrets} onClick={() => setShowSecrets(false)}>Configuration editor</Button>
        <Button variant={showSecrets ? "secondary" : "outline"} aria-pressed={showSecrets} onClick={() => setShowSecrets(true)}>Secrets and restart</Button>
      </div>
      {showSecrets ? active && <SecretAdmin /> : <>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Editor mode" className="flex gap-2">
          <Button variant={mode === "raw" ? "secondary" : "outline"} aria-pressed={mode === "raw"} disabled={busy || !snapshot} onClick={() => void run(() => switchMode("raw"))}>Raw YAML</Button>
          <Button variant={mode === "forms" ? "secondary" : "outline"} aria-pressed={mode === "forms"} disabled={busy || !snapshot} onClick={() => void run(() => switchMode("forms"))}>Basic settings</Button>
        </div>
        <span className="text-xs text-muted-foreground">{busy ? "Working…" : dirty ? "Unsaved draft" : "No unsaved edits"}</span>
      </div>
      {error && <div role="alert" className="whitespace-pre-wrap break-words rounded-md border border-destructive bg-destructive/10 p-3 text-sm">{error}</div>}
      {message && <div role="status" className="whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-sm">{message}</div>}
      {snapshot && <fieldset disabled={busy} className="min-w-0 space-y-4">
        {mode === "raw" ? <Suspense fallback={<p className="text-sm text-muted-foreground">Loading YAML editor…</p>}><YamlEditor value={text} disabled={busy} onChange={(value) => { setText(value); setMessage(""); setError(""); }} /></Suspense> : form && <>
          <p className="text-sm text-muted-foreground">Forms patch this same draft. All other sections, comments and environment references are retained. Use raw YAML for everything else.</p>
          <ConnectorSettings connectors={form.connectors} selected={selectedConnector} mode={connectorMode} yaml={connectorYaml}
            select={(name) => void run(() => selectConnector(name))}
            toggle={(next) => void run(() => selectConnector(selectedConnector?.key ?? "", next))}
            rawChange={(yaml) => { setConnector(selectedConnector!.key); setConnectorYaml(yaml); setMessage(""); setError(""); }}
            change={(path, value) => { changeConnector(path, value); }}
            add={(name, transport) => void run(() => addConnector(name, transport))}
            remove={() => void run(removeConnector)} />
          <h2 className="font-semibold">Global defaults</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default model" value={form.defaults.model} fallback="deepseek-v4-pro" onChange={(v) => change(["defaults", "model"], v)} />
            <Field label="Default thinking level" value={form.defaults.thinkingLevel} fallback="medium" choices={thinking} onChange={(v) => change(["defaults", "thinkingLevel"], v)} />
          </div>
          <h2 className="font-semibold">Existing channels</h2>
          <label className="block space-y-2 text-sm">Channel<select aria-label="Channel" className={inputClass} value={channel} onChange={(e) => setChannel(e.target.value)}>{form.channels.map((c) => <option key={c.key}>{c.key}</option>)}</select></label>
          {selected ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Channel model" value={selected.model} fallback={form.defaults.model ?? "deepseek-v4-pro"} onChange={(v) => change(["channels", channel, "model"], v)} />
            <Field label="Channel thinking level" value={selected.thinkingLevel} fallback={form.defaults.thinkingLevel ?? "medium"} choices={thinking} onChange={(v) => change(["channels", channel, "thinkingLevel"], v)} />
            <Field label="Description" value={selected.description} multiline onChange={(v) => change(["channels", channel, "description"], v)} />
            <Field label="Preferences" value={selected.preferences} fallback={form.defaults.preferences} multiline onChange={(v) => change(["channels", channel, "preferences"], v)} />
          </div> : <p className="text-sm text-muted-foreground">No configured channels. Add them in raw YAML.</p>}
        </>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void run(() => validate(false))}>Validate</Button>
          <Button onClick={() => void run(() => validate(true))}>Validate and save</Button>
          <Button variant="outline" onClick={() => { if (!dirty || window.confirm("Discard your unsaved draft and load the persisted configuration?")) void run(load); }}>Reload persisted config</Button>
        </div>
      </fieldset>}
      {!snapshot && <Button variant="outline" disabled={busy} onClick={() => void run(load)}>Load persisted config</Button>}
      <p className="text-xs text-muted-foreground">Save uses the loaded revision and refuses stale drafts. A backup is made before atomic replacement. Reload follows the harness’s existing semantics; web server, provider and timer changes may require a restart. Use Secrets and restart for write-only managed environment changes; resolved OAuth credentials are not editable here.</p>
      </>}
    </div>
  </section>;
}
