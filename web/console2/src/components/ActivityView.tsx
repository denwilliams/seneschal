import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { ActivityEntry } from "@api/api-types";
import { api } from "@/lib/api";
import { mergeActivity } from "@/lib/activity";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const STATE = { none: "Activity", pending: "Needs attention", resolved: "Resolved", expired: "Expired", unavailable: "No longer available" };

export function ActivityView({ refreshToken }: { refreshToken: number }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const watermark = useRef<string>(undefined);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        if (!watermark.current) {
          const page = await api.activity({}, controller.signal);
          setEntries(page.entries); setCursor(page.nextCursor); watermark.current = page.watermark;
        } else {
          let next: string | undefined;
          let until: string | undefined;
          const updates: ActivityEntry[] = [];
          let channelIds: string[] = [];
          do {
            const page = await api.activity(next ? { cursor: next } : { since: watermark.current }, controller.signal);
            updates.push(...page.entries); next = page.nextCursor; until = page.watermark; channelIds = page.channelIds;
          } while (next);
          // Commit the watermark only after all pages; an interrupted poll safely replays the same changes.
          setEntries((old) => mergeActivity(old, updates).filter((entry) => channelIds.includes(entry.channel.id))); watermark.current = until;
        }
        setError(undefined);
      } catch { if (!controller.signal.aborted) setError("Activity could not be refreshed. Your last loaded entries are still shown."); }
      finally { polling = false; if (!controller.signal.aborted) setLoading(false); }
    };
    refresh.current = () => { void poll(); };
    void poll();
    const timer = setInterval(() => { if (!document.hidden) void poll(); }, 10_000);
    const visible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => { refresh.current(); }, [refreshToken]);
  const older = async () => {
    if (!cursor || more) return;
    setMore(true);
    try {
      const page = await api.activity({ cursor });
      setEntries((old) => mergeActivity(old, page.entries).filter((entry) => page.channelIds.includes(entry.channel.id))); setCursor(page.nextCursor); setError(undefined);
    } catch { setError("Older activity could not be loaded. Try again."); }
    finally { setMore(false); }
  };
  return <section className="flex h-full min-h-0 flex-col" aria-label="Cross-channel activity">
    <div className="flex shrink-0 items-center justify-between gap-3 border-b p-4">
      <div><h1 className="text-lg font-semibold">Activity</h1><p className="text-xs text-muted-foreground">Across channels · newest first · refreshes every 10 seconds</p></div>
      <Button variant="outline" size="icon" aria-label="Refresh activity" onClick={() => refresh.current()}><RefreshCw className="size-4" /></Button>
    </div>
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        {error && <p role="alert" className="rounded border border-destructive p-3 text-sm">{error}</p>}
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading activity…</p>}
        {!loading && !entries.length && !error && <p className="py-10 text-center text-sm text-muted-foreground">No activity yet. New posts and interaction requests will appear here. Direct messages are never included.</p>}
        <ol className="space-y-3" aria-label="Activity entries">
          {entries.map((entry) => <li key={entry.id} data-testid="activity-entry" className="min-w-0 rounded-lg border bg-card p-4">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <a className="max-w-full truncate font-medium text-foreground hover:underline" href={`#/c/${encodeURIComponent(entry.channel.id)}`}>#{entry.channel.name ?? entry.channel.id}</a>
              <time dateTime={entry.at} title={entry.at}>{new Date(entry.at).toLocaleString()}</time>
              <Badge variant={entry.interaction === "pending" ? "outline" : "secondary"} className={entry.interaction === "pending" ? "border-amber-500 text-amber-700 dark:text-amber-400" : ""}>{STATE[entry.interaction]}</Badge>
            </div>
            <h2 className="break-words text-sm font-semibold">{entry.title}</h2>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{entry.snippet}</p>
            {entry.sourceUrl && <a className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline" href={entry.sourceUrl} target="_blank" rel="noreferrer">Open in Slack<ExternalLink className="size-3" aria-hidden /></a>}
          </li>)}
        </ol>
        {cursor && <div className="py-3 text-center"><Button variant="outline" disabled={more} onClick={() => void older()}>{more ? "Loading…" : "Load older activity"}</Button></div>}
        {!cursor && entries.length > 0 && <p className="py-4 text-center text-xs text-muted-foreground">End of retained activity</p>}
      </div>
    </ScrollArea>
  </section>;
}
