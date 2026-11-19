export interface RecentForm { basic: boolean; values: Record<string, unknown>; unsupported: string[] }
const fields = [
  { key: "enabled", label: "summaries enabled", help: "Generate rolling thread summaries.", type: "boolean" },
  { key: "debounceSeconds", label: "summary debounce", help: "Seconds to wait after the last handled turn; positive integer.", type: "integer" },
  { key: "maxThreads", label: "summary thread limit", help: "Recent threads retained per channel; positive integer.", type: "integer" },
  { key: "model", label: "summary model", help: "Model used by the background summariser.", type: "string" },
  { key: "maxTranscriptChars", label: "summary transcript limit", help: "Transcript characters sent to the summariser; positive integer.", type: "integer" },
];
const inputClass = "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const display = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "unset";
export function RecentConversationSettings({ label, data, inherited, builtins, change }: {
  label: string; data: RecentForm; inherited?: RecentForm; builtins: Record<string, unknown>;
  change: (key: string, value?: unknown) => void;
}) {
  return <section aria-label={label + " recent conversations"} className="space-y-3 rounded-md border p-3">
    <h3 className="text-sm font-semibold">{label} recent-conversation summaries</h3>
    <p className="text-xs text-muted-foreground">Rolling thread summaries for orientation, not durable memory. Timer changes may require a restart; saving does not force one. Environment references are not expanded.</p>
    {!data.basic ? <p className="text-sm">This mapping has an unsupported representation. Edit it in Raw YAML; it is retained unchanged.</p> :
      <div className="grid gap-3 sm:grid-cols-2">{fields.map(({ key, label: field, help, type }) => {
        const name = label + " " + field;
        const id = "recent-" + label.toLowerCase() + "-" + key;
        const value = data.values[key];
        const fallback = inherited?.basic && inherited.values[key] !== undefined ? inherited.values[key] : builtins[key];
        const fallbackText = inherited && !inherited.basic ? "Unsupported global mapping — see Raw YAML" : display(fallback);
        const source = inherited && (inherited.values[key] !== undefined || !inherited.basic) ? "global default" : "built-in default";
        const unsupported = data.unsupported.includes(key);
        const integerFallback = (typeof fallback === "number" || typeof fallback === "string" && /^\d+$/.test(fallback))
          && Number.isSafeInteger(Number(fallback)) && Number(fallback) > 0;
        const initial = type === "boolean" ? typeof fallback === "boolean" ? fallback : builtins[key]
          : type === "integer" ? String(integerFallback ? fallback : builtins[key]) : typeof fallback === "string" ? fallback : builtins[key];
        return <div key={key} className="min-w-0 space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={id} className="text-sm font-medium">{name}</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={name + " explicit override"} checked={value !== undefined}
              onChange={(event) => change(key, event.target.checked ? initial : undefined)} />Explicit override</label>
          </div>
          {type === "boolean" && !unsupported ? <select id={id} className={inputClass} disabled={value === undefined} value={value === undefined ? "" : String(value)} onChange={(event) => change(key, event.target.value === "true")}>
            {value === undefined && <option value="">Inherited</option>}<option value="true">Enabled</option><option value="false">Disabled</option>
          </select> : <input id={id} className={inputClass} inputMode={type === "integer" ? "numeric" : undefined}
            disabled={value === undefined || unsupported} value={value === undefined ? "" : display(value)} placeholder={fallbackText}
            onChange={(event) => change(key, event.target.value)} />}
          <p className="text-xs text-muted-foreground">{help}</p>
          <p className="break-words text-xs text-muted-foreground">{value === undefined ? "Unset / inherited" : "Explicit override"}. Inherited {source}: {fallbackText}</p>
          {unsupported && <p className="break-words text-xs text-amber-700 dark:text-amber-300">Unsupported form value retained unchanged. Edit it in Raw YAML or uncheck this override to inherit.</p>}
        </div>;
      })}</div>}
  </section>;
}
