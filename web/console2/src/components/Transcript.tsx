import { AlertCircle, CheckCircle2, EyeOff, Loader2, Wrench } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ToolCallCard, TranscriptEntry, TranscriptResponse } from "@api/api-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { clock, formatCost, formatTokens } from "@/lib/format";
import { hasDraftContent, mergeEntries, replaceNewest, type Draft } from "@/lib/live";
import { cn } from "@/lib/utils";
import { Notice } from "./common";

const ROLE_LABEL: Record<TranscriptEntry["role"], string> = { user: "You", assistant: "Agent", tool: "Tool", system: "System" };

export function ToolCard({ call }: { call: ToolCallCard }) {
  const Icon = call.status === "pending" ? Loader2 : call.status === "error" ? AlertCircle : CheckCircle2;
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs" data-testid="tool-card">
      <Wrench className="size-3.5 text-muted-foreground" aria-hidden />
      <code className="font-mono font-medium">{call.name}</code>
      <Badge variant={call.status === "error" ? "destructive" : "secondary"} className="ml-auto gap-1">
        <Icon className={cn("size-3", call.status === "pending" && "animate-spin")} aria-hidden />
        {call.status === "pending" ? "Running" : call.status === "error" ? "Error" : "Done"}
      </Badge>
    </div>
  );
}

function EntryView({ entry }: { entry: TranscriptEntry }) {
  return (
    <article
      className={cn("space-y-2 rounded-lg px-3 py-2", entry.role === "user" && "bg-muted/50", entry.inherited && "opacity-60")}
      aria-label={`${ROLE_LABEL[entry.role]} entry ${entry.id}`}
      data-testid="entry"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide text-foreground/80">{ROLE_LABEL[entry.role]}</span>
        <span className="font-mono">#{entry.id}</span>
        {entry.at && <time dateTime={entry.at}>{clock(entry.at)}</time>}
        {entry.model && <span>{entry.model}</span>}
        {entry.tokens !== undefined && <span>{formatTokens(entry.tokens)} tok</span>}
        {entry.costUsd !== undefined && <span>{formatCost(entry.costUsd)}</span>}
        {entry.inherited && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">from main</Badge>}
      </header>
      {entry.redacted ? (
        <p className="flex items-center gap-1.5 text-sm italic text-muted-foreground"><EyeOff className="size-3.5" aria-hidden />content hidden (direct message)</p>
      ) : entry.text ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.text}</p>
      ) : null}
      {entry.toolCalls && entry.toolCalls.length > 0 && (
        <div className="space-y-1">{entry.toolCalls.map((call) => <ToolCard key={call.callId} call={call} />)}</div>
      )}
    </article>
  );
}

function DraftView({ draft }: { draft: Draft }) {
  return (
    <article className="space-y-2 rounded-lg border border-dashed px-3 py-2" aria-label="Agent response in progress" data-testid="draft">
      <header className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide text-foreground/80">Agent</span>
        <span className="inline-flex items-center gap-1"><Loader2 className={cn("size-3", !draft.done && "animate-spin")} aria-hidden />{draft.done ? "finishing" : "streaming"}</span>
      </header>
      {draft.text && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{draft.text}</p>}
      {draft.toolCalls.length > 0 && <div className="space-y-1">{draft.toolCalls.map((call) => <ToolCard key={call.callId} call={call} />)}</div>}
    </article>
  );
}

export interface TranscriptProps {
  channelId: string;
  threadKey: string;
  draft: Draft | undefined;
  /** Bumped when the server says the transcript changed (resync, a finished message). */
  refreshToken: number;
  onLoaded?: (response: TranscriptResponse) => void;
}

export function Transcript({ channelId, threadKey, draft, refreshToken, onLoaded }: TranscriptProps) {
  const [meta, setMeta] = useState<TranscriptResponse>();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const olderPosition = useRef<number | undefined>(undefined);
  const key = `${channelId}\n${threadKey}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  // Newest page: replaces everything when the thread changes, merges on a refresh.
  useEffect(() => {
    const controller = new AbortController();
    const fresh = keyRef.current;
    setError(undefined);
    api.transcript(channelId, threadKey, undefined, controller.signal).then(
      (response) => {
        if (controller.signal.aborted || fresh !== keyRef.current) return;
        setMeta(response);
        setEntries((previous) => (previous.length === 0 || refreshToken === 0 ? response.entries : replaceNewest(previous, response.entries)));
        setLoading(false);
        onLoadedRef.current?.(response);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [channelId, threadKey, refreshToken]);

  // Reset before positioning the new transcript, not in a later passive effect.
  useLayoutEffect(() => {
    setMeta(undefined);
    setEntries([]);
    setLoading(true);
    setLoadingOlder(false);
    olderPosition.current = undefined;
    stick.current = true;
  }, [key]);

  const loadOlder = useCallback(async () => {
    if (!meta?.nextBefore) return;
    setLoadingOlder(true);
    try {
      const page = await api.transcript(channelId, threadKey, meta.nextBefore);
      if (keyRef.current !== key) return;
      // Snapshot immediately before inserting: the reader may have moved during the request.
      const element = viewport.current;
      olderPosition.current = element ? element.scrollHeight - element.scrollTop : undefined;
      stick.current = false;
      setEntries((previous) => mergeEntries(previous, page.entries));
      setMeta((previous) => (previous ? { ...previous, nextBefore: page.nextBefore } : previous));
    } catch (reason) {
      if (keyRef.current === key) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (keyRef.current === key) setLoadingOlder(false);
    }
  }, [meta?.nextBefore, channelId, threadKey, key]);

  const followLatest = useCallback(() => {
    const element = viewport.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element && olderPosition.current !== undefined) {
      // Restore before paint, without a stale animation-frame callback crossing a thread switch.
      element.scrollTop = element.scrollHeight - olderPosition.current;
      olderPosition.current = undefined;
    } else {
      followLatest();
    }
  }, [entries, draft, meta, followLatest]);

  useLayoutEffect(() => {
    // React's layout effect can precede final sizing (Radix, text reflow, panel/viewport resizing).
    // Observe both boxes: a viewport can shrink without the content changing, and vice versa.
    const observer = new ResizeObserver(followLatest);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [followLatest]);

  const onScroll = () => {
    const element = viewport.current;
    if (element) stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const firstOwn = entries.findIndex((entry) => !entry.inherited);
  const hasInherited = entries.some((entry) => entry.inherited);
  const dividerAt = hasInherited ? (firstOwn === -1 ? entries.length : firstOwn) : -1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewport} onViewportScroll={onScroll}>
        <div ref={content} className="mx-auto max-w-3xl space-y-3 p-4" aria-live="polite" aria-busy={loading}>
          {loading && !meta && (
            <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-12 w-3/4" /></div>
          )}
          {error && <div role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm">Could not load the transcript: {error}</div>}
          {meta && !meta.available && (
            <Notice>{meta.reason ?? "This conversation is not available. A channel's store can only be read while it is open in the harness process."}</Notice>
          )}
          {meta?.available && meta.redacted && <Notice>Direct message: the shape of the conversation is shown, the words are not.</Notice>}
          {meta?.available && entries.length === 0 && !draft && <p className="py-8 text-center text-sm text-muted-foreground">No entries yet.</p>}
          {meta?.nextBefore !== undefined && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load older entries"}
              </Button>
            </div>
          )}
          {entries.map((entry, index) => (
            <div key={entry.key} className="space-y-3">
              {index === dividerAt && (
                <div role="separator" className="flex items-center gap-3 py-1 text-xs text-muted-foreground" data-testid="fork-divider">
                  <span className="h-px flex-1 bg-border" />
                  <span>forked from entry {meta?.forkedFromEntry ?? "?"} of main</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <EntryView entry={entry} />
            </div>
          ))}
          {dividerAt === entries.length && entries.length > 0 && (
            <div role="separator" className="flex items-center gap-3 py-1 text-xs text-muted-foreground" data-testid="fork-divider">
              <span className="h-px flex-1 bg-border" />
              <span>forked from entry {meta?.forkedFromEntry ?? "?"} of main</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {hasDraftContent(draft) && <DraftView draft={draft} />}
        </div>
      </ScrollArea>
      <p className="border-t px-4 py-2 text-center text-xs text-muted-foreground">Closing this window never interrupts your agent.</p>
    </div>
  );
}
