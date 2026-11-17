import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FactoryRepositoryView, FactoryResponse, FactoryTimelineView } from "@api/api-types";
import { Empty, Notice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { AUTO_REFRESH_MS, countLabel, filterRepository, reviewLabel, safeGithubUrl, shouldAutoRefresh } from "@/lib/factory";
import { clock, relativeTime } from "@/lib/format";

/** An external link only when it really is a github.com one; anything else is plain text. */
function Ext({ url, children, className }: { url: string | undefined; children: ReactNode; className?: string }) {
  const safe = safeGithubUrl(url);
  if (!safe) return <span className={className}>{children}</span>;
  return <a href={safe} target="_blank" rel="noopener noreferrer" className={`underline-offset-2 hover:underline ${className ?? ""}`}>{children}<span className="sr-only"> (opens GitHub in a new tab)</span></a>;
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded border bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">{children}</span>;
}

function Block({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <h4 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}{count !== undefined && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] normal-case tracking-normal" data-testid="factory-count">{count}</span>}
      </h4>
      {children}
    </div>
  );
}

function Items({ empty, children, label }: { empty: string; children: ReactNode[]; label: string }) {
  if (children.length === 0) return <Empty>{empty}</Empty>;
  return <ul aria-label={label} className="divide-y rounded-md border">{children}</ul>;
}

function Item({ children, testId }: { children: ReactNode; testId: string }) {
  return <li data-testid={testId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-sm">{children}</li>;
}

function ActivityChart({ view }: { view: FactoryTimelineView | undefined }) {
  if (!view) return <Notice>Activity timeline unavailable: invalid snapshot date.</Notice>;
  return (
    <div className="space-y-2" data-testid="factory-timeline">
      <p className="text-xs text-muted-foreground">Trailing seven days · UTC · {view.range}</p>
      <ul aria-label="Event symbol legend" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {view.legend.map((kind) => <li key={kind.label}><span aria-hidden="true" className="mr-1 text-foreground">{kind.symbol}</span>{kind.label}</li>)}
      </ul>
      <p className="text-xs text-muted-foreground">{view.note}</p>
      {view.markers.length === 0 && <p className="text-xs text-muted-foreground">No activity returned within the trailing seven days.</p>}
      <div tabIndex={0} role="region" aria-label="Seven-day activity timeline, scrollable" className="overflow-x-auto rounded-md border bg-card px-8">
        <div className="relative min-w-[640px]">
          <ol aria-label="GitHub activity, oldest first" className="relative" style={{ height: view.height + 56 }}>
            {view.markers.map((marker, index) => {
              const top = 24 + marker.lane * 36;
              const safe = safeGithubUrl(marker.url);
              const face = <span aria-hidden="true">{marker.symbol}</span>;
              const faceClass = "relative z-10 flex size-6 -translate-x-1/2 items-center justify-center rounded-full border bg-background text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
              return (
                <li
                  key={`${marker.date}${index}`} data-testid="factory-marker" data-kind={marker.kind} data-lane={marker.lane}
                  className="group absolute" style={{ left: `${marker.position}%`, top }}
                >
                  {marker.lane > 0 && <span aria-hidden="true" className="absolute bottom-full left-0 w-px bg-border" style={{ height: marker.lane * 36 }} />}
                  {safe ? (
                    <a href={safe} target="_blank" rel="noopener noreferrer" aria-label={marker.label} className={faceClass}>{face}</a>
                  ) : (
                    <span tabIndex={0} role="img" aria-label={marker.label} className={faceClass}>{face}</span>
                  )}
                  <span
                    role="tooltip" aria-hidden="true" data-testid="factory-tooltip"
                    className={`pointer-events-none absolute top-full z-20 mt-1 hidden w-56 rounded-md border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md group-focus-within:block group-hover:block ${marker.position > 50 ? "right-0" : "left-0"}`}
                  >{marker.label}</span>
                </li>
              );
            })}
          </ol>
          <div aria-label="UTC date scale" className="relative h-6 border-t text-[10px] text-muted-foreground">
            {view.axis.map((tick) => (
              <span key={tick.iso} className="absolute top-1 -translate-x-1/2 whitespace-nowrap" style={{ left: `${tick.left}%` }}><time dateTime={tick.iso}>{tick.text}</time></span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Repository({ repo, query, now }: { repo: FactoryRepositoryView; query: string; now: number }) {
  const shown = filterRepository(repo, query);
  return (
    <section data-testid="factory-repo" aria-label={repo.repository} className="space-y-4 rounded-lg border bg-card p-3 sm:p-4">
      <h3 className="flex items-center gap-1.5 break-all text-sm font-semibold">
        <Ext url={`https://github.com/${repo.repository}`}>{repo.repository}</Ext>
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </h3>
      {repo.error && <div role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-xs text-destructive">{repo.error}</div>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Block title="Open issues" count={countLabel(shown.issues.length, repo.issues.length, shown.filtered)}>
          <Items label={`Open issues in ${repo.repository}`} empty={shown.filtered ? "No matching issues." : "No open issues returned."}>
            {shown.issues.map((issue) => (
              <Item key={issue.number} testId="factory-issue">
                <Ext url={issue.url} className="font-medium">#{issue.number}</Ext>
                <span className="min-w-0 break-words">{issue.title}</span>
                {(issue.labels ?? []).map((label) => <Tag key={label.name}>{label.name}</Tag>)}
                <span className="text-xs text-muted-foreground">{relativeTime(issue.updatedAt, now)}</span>
              </Item>
            ))}
          </Items>
        </Block>
        <Block title="Open pull requests" count={countLabel(shown.pullRequests.length, repo.pullRequests.length, shown.filtered)}>
          <Items label={`Open pull requests in ${repo.repository}`} empty={shown.filtered ? "No matching pull requests." : "No open pull requests returned."}>
            {shown.pullRequests.map((pr) => (
              <Item key={pr.number} testId="factory-pr">
                <Ext url={pr.url} className="font-medium">#{pr.number}</Ext>
                <span className="min-w-0 break-words">{pr.title}</span>
                {pr.isDraft && <Tag>draft</Tag>}
                {pr.reviewDecision && <Tag>{reviewLabel(pr.reviewDecision)}</Tag>}
                <span className="text-xs text-muted-foreground">{relativeTime(pr.updatedAt, now)}</span>
              </Item>
            ))}
          </Items>
        </Block>
      </div>
      <Block title="Merged · last seven days" count={repo.mergedError ? undefined : countLabel(shown.merged.length, repo.merged.length, shown.filtered)}>
        {repo.mergedError ? (
          <Notice>Merged pull requests unavailable.</Notice>
        ) : (
          <Items label={`Pull requests merged in ${repo.repository}`} empty={shown.filtered ? "No matching merges." : "Nothing merged in the last seven days."}>
            {shown.merged.map((pr) => (
              <Item key={pr.number} testId="factory-merged">
                <Ext url={pr.url} className="font-medium">#{pr.number}</Ext>
                <span className="min-w-0 break-words">{pr.title}</span>
                <span className="text-xs text-muted-foreground">{pr.author?.login ? `${pr.author.login} · ` : ""}merged {relativeTime(pr.mergedAt, now)}</span>
              </Item>
            ))}
          </Items>
        )}
      </Block>
      <Block title="Activity · last seven days"><ActivityChart view={repo.timeline} /></Block>
    </section>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "This channel is not a software factory.";
    if (error.status === 429) return "GitHub was refreshed too recently; try again in a moment";
    return `The server could not read GitHub (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The software factory's live GitHub view. Read-only; refreshes itself every 30 seconds while the page is visible. */
export function FactoryView({ channelId, name, now }: { channelId: string; name: string; now: number }) {
  const [data, setData] = useState<FactoryResponse>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [auto, setAuto] = useState(true);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState("");
  const inFlight = useRef<AbortController>(undefined);

  const load = useCallback(async (manual: boolean) => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);
    try {
      const next = await api.factory(channelId, manual, controller.signal);
      if (controller.signal.aborted) return;
      setData(next);
      setError(undefined);
    } catch (failure) {
      if (!controller.signal.aborted) setError(describe(failure));
    } finally {
      if (inFlight.current === controller) { inFlight.current = undefined; if (!controller.signal.aborted) setRefreshing(false); }
    }
  }, [channelId]);

  useEffect(() => {
    setData(undefined); setError(undefined); setOnly(""); setQuery("");
    void load(false);
    return () => { inFlight.current?.abort(); inFlight.current = undefined; setRefreshing(false); };
  }, [load]);

  useEffect(() => {
    if (!auto) return undefined;
    const timer = setInterval(() => { if (shouldAutoRefresh(auto, document.hidden)) void load(false); }, AUTO_REFRESH_MS);
    // Catch up as soon as the page is visible again, rather than waiting out the rest of an interval.
    const visible = () => { if (shouldAutoRefresh(auto, document.hidden)) void load(false); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [auto, load]);

  const repos = (data?.repositories ?? []).filter((repo) => !only || repo.repository === only);
  const total = (pick: (repo: FactoryRepositoryView) => number) => repos.reduce((sum, repo) => sum + pick(repo), 0);
  const stats: [string, number][] = [
    ["Repositories", repos.length], ["Open issues", total((r) => r.issues.length)], ["Open PRs", total((r) => r.pullRequests.length)], ["Merged · 7 days", total((r) => r.merged.length)],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 sm:p-4" data-testid="factory-view">
      <div>
        <h2 className="text-sm font-semibold">{data?.name ?? name}</h2>
        <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="factory-fetched">
          Live read-only GitHub view{data ? ` · fetched ${clock(data.generatedAt)}` : ""}{refreshing ? " · refreshing…" : ""}
        </p>
      </div>
      {error && <div role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-xs">Could not refresh: {error}.{data ? " Showing the last data received." : ""}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="factory-filter">Filter issues and pull requests</label>
        <Input id="factory-filter" type="search" placeholder="Filter issues and pull requests" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 min-w-0 flex-1 basis-48" />
        {(data?.repositories.length ?? 0) > 1 && (
          <select
            aria-label="Repository" value={only} onChange={(event) => setOnly(event.target.value)}
            className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">All repositories</option>
            {data!.repositories.map((repo) => <option key={repo.repository} value={repo.repository}>{repo.repository}</option>)}
          </select>
        )}
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={refreshing} onClick={() => void load(true)}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} aria-hidden />Refresh
        </Button>
        <label className="inline-flex items-center gap-2 text-xs">
          <input type="checkbox" className="size-4 accent-primary" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
          Auto-refresh
        </label>
      </div>
      {!data && !error && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading"><Skeleton className="h-10 w-full" /><Skeleton className="h-40 w-full" /></div>
      )}
      {data && (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="factory-stats">
            {stats.map(([label, count]) => (
              <div key={label} className="rounded-md border bg-card px-3 py-2">
                <dd className="text-lg font-semibold tabular-nums leading-tight">{count}</dd>
                <dt className="text-[11px] text-muted-foreground">{label}</dt>
              </div>
            ))}
          </dl>
          {repos.map((repo) => <Repository key={repo.repository} repo={repo} query={query} now={now} />)}
          {repos.length === 0 && <Empty>No repositories are configured for this factory.</Empty>}
        </>
      )}
    </div>
  );
}
