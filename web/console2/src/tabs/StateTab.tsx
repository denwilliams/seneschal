import { Check, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";
import type { MemoryFileView, StateResponse } from "@api/api-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { clock, formatBytes, relativeTime, threadLabel } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { copyText, pathLabel, percentOf, sizeLabel } from "@/lib/state-tree";
import { Async, Empty, Notice, Section } from "@/components/common";
import { ListsPanel } from "@/components/ListsPanel";
import { JsonTree } from "@/components/JsonTree";
import { cn } from "@/lib/utils";

function FileCard({ file }: { file: MemoryFileView }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.name}</span>
        <Badge variant="outline">{file.scope}</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 border-t px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{formatBytes(file.bytes)}{file.modified ? ` · updated ${clock(file.modified)}` : ""}</p>
          {file.redacted ? (
            <p className="text-xs italic text-muted-foreground">Content hidden (direct message).</p>
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-xs">{file.text ?? ""}</pre>
          )}
          {file.truncated && <p className="text-[11px] text-muted-foreground">Truncated: showing the start of the file.</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CopyButton({ value }: { value: unknown }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <Button
        type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs"
        onClick={async () => {
          setStatus((await copyText(JSON.stringify(value, null, 2))) ? "copied" : "failed");
          setTimeout(() => setStatus("idle"), 1800);
        }}
      >
        {status === "copied" ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy JSON"}
      </Button>
      {/* Announced to screen readers, but outside the button: a live region inside a button is not read as part of it. */}
      <span role="status" className="sr-only">{status === "copied" ? "Copied to the clipboard" : status === "failed" ? "Could not copy" : ""}</span>
    </>
  );
}

function ChangeLog({ state }: { state: StateResponse }) {
  const [open, setOpen] = useState(false);
  const changes = [...state.changes].reverse();
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        <span className="flex-1 text-xs font-medium">Recent changes</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{changes.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {changes.length === 0 ? (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">No changes recorded.</p>
        ) : (
          <ol aria-label="Recent state changes" className="divide-y border-t">
            {changes.map((change) => (
              <li key={change.rev} className="space-y-0.5 px-3 py-1.5 text-xs">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-muted-foreground">#{change.rev}</span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{change.op}</Badge>
                  {!state.redacted && <span className="min-w-0 break-all font-mono">{pathLabel(change.path)}</span>}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {clock(change.at)} · {change.source}{change.threadKey ? ` · thread ${threadLabel(change.threadKey, "")}` : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function StateObject({ state }: { state: StateResponse }) {
  const empty = !state.redacted && state.value !== undefined && typeof state.value === "object" && state.value !== null && !Array.isArray(state.value) && Object.keys(state.value).length === 0;
  const percent = percentOf(state.bytes, state.maxBytes);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm font-semibold tabular-nums" data-testid="state-rev">rev {state.rev}</span>
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="state-size">{sizeLabel(state.bytes, state.maxBytes)}</span>
          {!state.redacted && state.value !== undefined && !empty && <span className="ml-auto"><CopyButton value={state.value} /></span>}
        </div>
        <Progress value={percent} aria-label="State size used" className={cn(percent >= 90 && "bg-destructive/20 [&>div]:bg-destructive")} />
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" data-testid="state-updated">
          {state.updatedAt ? (
            <>
              <span>Last changed {relativeTime(state.updatedAt)} by</span>
              {state.updatedBy && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{state.updatedBy.source}</Badge>}
              {state.updatedBy?.threadKey && <span>in thread {threadLabel(state.updatedBy.threadKey, "")}</span>}
            </>
          ) : "Never changed."}
        </p>
      </div>
      {state.redacted ? (
        <p className="text-xs italic text-muted-foreground" data-testid="state-hidden">Contents are hidden for direct messages.</p>
      ) : empty || state.value === undefined ? (
        <Empty>Nothing in the channel state yet. Agents write it with state_update; it is shared by every thread in this channel.</Empty>
      ) : (
        <JsonTree value={state.value} />
      )}
      <ChangeLog state={state} />
    </div>
  );
}

export function StateTab({ channelId, refreshToken }: { channelId: string; refreshToken: number }) {
  const state = useApi((signal) => api.state(channelId, signal), `state\n${channelId}`, refreshToken);
  const memory = useApi((signal) => api.memory(channelId, signal), `memory\n${channelId}`, refreshToken);
  return (
    <div className="space-y-5">
      <ListsPanel key={channelId} channelId={channelId} refreshToken={refreshToken} />
      <Separator />
      <Section title="Channel state">
        <Async result={state}>
          {(s) => (s.live ? <StateObject state={s} /> : <Notice>{s.reason ?? "The channel's store is not open, so its state cannot be read."}</Notice>)}
        </Async>
      </Section>
      <Separator />
      <Async result={memory}>
        {(m) => (
          <Section title="Memory and notes" count={m.files.length}>
            {m.files.length === 0 ? <Empty>No memory files yet.</Empty> : <div className="space-y-2">{m.files.map((file) => <FileCard key={`${file.scope}/${file.name}`} file={file} />)}</div>}
          </Section>
        )}
      </Async>
    </div>
  );
}
