import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { apiUrl } from "@/lib/api";

interface Snapshot {
  enabled: boolean; instance: string;
  variables: { name: string; set: boolean; source: "inherited" | "managed"; pendingRestart: boolean; protected: boolean }[];
  restart: { available: boolean; pending: boolean };
  scoped?: { backends: { id: string; label: string; enabled: boolean; unavailableReason?: string; warning?: string; canDelete?: boolean }[]; channels: { id: string; name?: string }[] };
}
async function request<T>(body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl("secrets"), { method: body ? "POST" : "GET", cache: "no-store", headers: { accept: "application/json", ...(body ? { "content-type": "application/json", "x-console-admin": "1" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new Error("Connection unavailable. The outcome is unknown; refresh names or check service return before retrying."); }
  let result;
  try { result = await response.json(); } catch { throw new Error("Check the harness connection and your access-proxy session."); }
  if (!response.ok) throw new Error(result.error || "Secret administration failed.");
  return result as T;
}
const inputClass = "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function SecretAdmin() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [name, setName] = useState("");
  const value = useRef<HTMLInputElement>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [backend, setBackend] = useState("environment");
  const [scope, setScope] = useState("channel");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [previousInstance, setPreviousInstance] = useState<string>();
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Secret administration failed."); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const next = await request<Snapshot>();
    setSnapshot(next);
    if (previousInstance) {
      setMessage(next.instance !== previousInstance ? "Harness returned with a new process. Saved environment was loaded at startup; verify the affected integration separately." : "Still the same process. Restart completion has not been verified.");
      if (next.instance !== previousInstance) setPreviousInstance(undefined);
    }
  }
  useEffect(() => { void run(refresh); }, []);
  async function save() {
    // Never retain a secret in React state, browser storage or the input after a submission (including failures).
    const secret = value.current?.value ?? "";
    if (value.current) value.current.value = "";
    await request(backend === "environment" ? { operation: "save", name, value: secret, overwrite } : { operation: "backend-save", backend, scope: targetScope(), name, value: secret, overwrite });
    setOverwrite(false);
    setSnapshot(await request<Snapshot>());
    setMessage(backend === "environment" ? "Saved for next startup. Running work is unchanged; restart the harness to apply pending secrets." : `Saved in the backend${backend === "macos-keychain" ? "; lookup cache invalidated" : ""}. Add the matching config import if needed; reload channels or restart main-process clients to apply.`);
  }
  function targetScope() { return scope === "channel" ? { kind: scope, channel } : { kind: scope }; }
  async function remove() {
    if (value.current) value.current.value = "";
    await request({ operation: "backend-delete", backend, scope: targetScope(), name, confirm: true });
    setOverwrite(false);
    setMessage("Scoped secret deleted and lookup cache invalidated. Remove its config import, then reload channel sessions or restart main-process clients. Existing sessions may retain the old value.");
  }
  async function restart() {
    setConfirm(false); setInterrupted(false);
    const accepted = await request<{ instance: string }>({ operation: "restart", confirm: true });
    setPreviousInstance(accepted.instance);
    setSnapshot((s) => s && { ...s, restart: { ...s.restart, pending: true } });
    setMessage("Restart acknowledged. Work will be interrupted. Return to service is NOT yet verified; wait a few seconds, then check service return.");
  }
  const existing = backend === "environment" ? snapshot?.variables.find((v) => v.name === name) : undefined;
  const selectedBackend = snapshot?.scoped?.backends.find((b) => b.id === backend);
  return <div className="space-y-4" aria-label="Secrets and restart">
    <h2 className="text-lg font-semibold">Secrets and backends</h2>
    <p className="text-sm text-muted-foreground">Existing values can never be read back here. The list below shows legacy environment names and set status. Scoped imports override legacy env files. Within each backend, per-channel imports override global-channel imports. If both are configured, Keychain overrides OpenBao. Main-process secrets stay private.</p>
    {error && <p role="alert" className="break-words rounded-md border border-destructive p-3 text-sm">{error}</p>}
    {message && <p role="status" className="break-words rounded-md border bg-muted p-3 text-sm">{message}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>{previousInstance ? "Check service return" : "Refresh names"}</Button>
    {snapshot && <>
      {!snapshot.enabled && backend === "environment" && <p className="text-sm">Saving is unavailable. The operator must configure private managed environment storage on the host.</p>}
      <ul aria-label="Environment variable names" className="max-h-60 overflow-y-auto rounded-md border divide-y">
        {snapshot.variables.map((v) => <li key={v.name} className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs"><code className="min-w-0 break-all font-medium">{v.name}</code><span className="text-muted-foreground">{v.set ? "Set" : "Unset"} · {v.source}{v.pendingRestart ? " · Pending restart" : ""}{v.protected ? " · Protected" : ""}</span></li>)}
        {!snapshot.variables.length && <li className="p-3 text-sm">No configured names.</li>}
      </ul>
      <form autoComplete="off" className="space-y-3 rounded-md border p-4" onSubmit={(e) => { e.preventDefault(); void run(save); }}>
        <h3 className="font-semibold">Add or replace a secret</h3>
        <label className="block space-y-1 text-sm">Storage backend<select aria-label="Storage backend" className={inputClass} disabled={busy} value={backend} onChange={(e) => { setBackend(e.target.value); setOverwrite(false); if (value.current) value.current.value = ""; }}><option value="environment">Environment (.env / managed, restart)</option>{snapshot.scoped?.backends.map((b) => <option key={b.id} value={b.id} disabled={!b.enabled}>{b.label}{!b.enabled ? " (unavailable)" : ""}</option>)}</select></label>
        {snapshot.scoped?.backends.filter((b) => !b.enabled && b.unavailableReason).map((b) => <p key={b.id} role="note" className="break-words rounded-md border bg-muted p-3 text-sm"><strong>{b.label} unavailable.</strong> {b.unavailableReason}</p>)}
        {snapshot.scoped?.backends.filter((b) => b.warning).map((b) => <p key={b.id} role="alert" className="break-words rounded-md border bg-muted p-3 text-sm"><strong>{b.label} security warning.</strong> {b.warning}</p>)}
        {backend === "environment" && <p className="text-xs text-muted-foreground">Existing .env files remain usable without Keychain. This form saves to managed environment storage, not your .env file. Environment selection does not override configured Keychain imports or OpenBao imports; those still fail closed.</p>}
        {backend !== "environment" && <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Write-only scoped storage. No stored values are fetched. Config import allowlists control delivery. Main-process scope is private to Slack/model clients; channel scope is available only to the selected channel. Global-channel scope is available to every channel, including DMs.</p>
          <label className="block space-y-1 text-sm">Secret scope<select aria-label="Secret scope" className={inputClass} disabled={busy} value={scope} onChange={(e) => { setScope(e.target.value); setOverwrite(false); if (value.current) value.current.value = ""; }}><option value="channel">Per channel</option><option value="global-channel">Global to all channels</option><option value="main-process">Main process only</option></select></label>
          {scope === "channel" && <label className="block space-y-1 text-sm">Channel<select aria-label="Secret channel" className={inputClass} disabled={busy} value={channel} onChange={(e) => { setChannel(e.target.value); setOverwrite(false); if (value.current) value.current.value = ""; }} required><option value="">Select channel…</option>{snapshot.scoped?.channels.map((c) => <option key={c.id} value={c.id}>{c.name ? "#" + c.name + " · " : ""}{c.id}</option>)}</select></label>}
        </div>}
        <fieldset disabled={busy || (backend === "environment" ? !snapshot.enabled : !selectedBackend?.enabled) || snapshot.restart.pending} className="min-w-0 space-y-3">
          <label className="block space-y-1 text-sm">Environment name<input className={inputClass} aria-label="Environment name" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={name} maxLength={128} pattern="[A-Z][A-Z0-9_]*" required onChange={(e) => { setName(e.target.value); setOverwrite(false); }} placeholder="EXAMPLE_API_KEY" /></label>
          <label className="block space-y-1 text-sm">New secret value<input ref={value} className={inputClass} aria-label="New secret value" type="password" autoComplete="new-password" spellCheck={false} maxLength={16384} required /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />I confirm replacement or deletion if this scoped name is already set.</label>
          {existing?.protected && <p className="text-sm">This runtime/control variable is protected; manage it on the host.</p>}
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={existing?.protected || (!!existing && !overwrite) || (backend !== "environment" && (!overwrite || scope === "channel" && !channel))}>{backend === "environment" ? "Save secret for restart" : "Save scoped secret"}</Button>
          {selectedBackend?.canDelete && <Button type="button" variant="outline" disabled={!overwrite || !name || scope === "channel" && !channel} onClick={() => void run(remove)}>Delete scoped secret</Button>}</div>
        </fieldset>
        <p className="text-xs text-muted-foreground">The value is cleared after every submission. No values are saved in browser storage. Bootstrap and runtime-control names cannot be changed here.</p>
      </form>
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="font-semibold">Restart harness</h3>
        <p className="text-sm text-muted-foreground">Restart interrupts active turns and workflows and applies saved environment changes. It does not refresh variables injected by Docker Compose; recreate the container for host .env changes.</p>
        {!snapshot.restart.available && <p className="text-sm">Unavailable: supervised restart has not been enabled by the operator.</p>}
        <Button variant="outline" disabled={busy || !snapshot.restart.available || snapshot.restart.pending} onClick={() => { setInterrupted(false); setConfirm(true); }}>Restart harness…</Button>
      </div>
    </>}
    <Dialog open={confirm} onOpenChange={setConfirm}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogTitle>Restart the harness?</DialogTitle>
        <DialogDescription>Active turns and workflows will be interrupted. Saved environment changes apply on startup. Your supervisor must bring the harness back; an acknowledgement is not proof that it returned.</DialogDescription>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={interrupted} onChange={(e) => setInterrupted(e.target.checked)} />I understand that running work will be interrupted.</label>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button><Button disabled={!interrupted || busy} onClick={() => void run(restart)}>Confirm restart</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
