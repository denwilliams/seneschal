import { AlertTriangle, Check, Circle, OctagonX, PauseCircle } from "lucide-react";
import { useRef, useState } from "react";
import type { TimelineResponse, TimelineRowView } from "@api/api-types";
import { Async, Empty } from "@/components/common";
import { api } from "@/lib/api";
import { formatCost } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import {
  graphCell, laneColor, showStatusBadge, stamp, statusText, statusTone, timelineCost, timelineDuration, type StatusTone,
} from "@/lib/timeline";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<StatusTone, string> = {
  good: "border-emerald-600/40 bg-emerald-50 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-950/50 dark:text-emerald-300",
  bad: "border-red-600/40 bg-red-50 text-red-800 dark:border-red-400/40 dark:bg-red-950/50 dark:text-red-300",
  warn: "border-amber-600/40 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/50 dark:text-amber-300",
  neutral: "bg-muted text-muted-foreground",
};
const TONE_ICON: Record<StatusTone, typeof Check> = { good: Check, bad: OctagonX, warn: PauseCircle, neutral: Circle };

/** The status in words and an icon, never colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status);
  const Icon = TONE_ICON[tone];
  return (
    <span data-testid="timeline-status" className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none", TONE_CLASS[tone])}>
      <Icon className="size-3" aria-hidden />{statusText(status)}
    </span>
  );
}

/** One row's graph cell: the git-log-style lines and the dot. Decorative; the row's text says everything. */
export function GraphCell({ row, lanes }: { row: TimelineRowView; lanes: number }) {
  const cell = graphCell(row, lanes);
  const { dot } = cell;
  return (
    <svg data-testid="timeline-graph" aria-hidden="true" focusable="false" className="block shrink-0" width={cell.width} height={cell.height} viewBox={`0 0 ${cell.width} ${cell.height}`}>
      {cell.paths.map((path, index) => (
        <path
          key={index} d={path.d} fill="none" stroke={laneColor(path.lane)} strokeWidth={2} strokeLinecap="round"
          {...(path.dashed ? { strokeDasharray: "3 3", "data-dashed": "true" } : {})}
        />
      ))}
      <circle
        cx={dot.cx} cy={dot.cy} r={dot.r} fill={laneColor(dot.lane)} strokeWidth={2} opacity={dot.dead ? 0.55 : 1}
        className={dot.ring ? undefined : "stroke-card"} {...(dot.ring ? { stroke: dot.ring, "data-ring": dot.ring } : {})}
      />
    </svg>
  );
}

function Meta({ row }: { row: TimelineRowView }) {
  const duration = timelineDuration(row.durationMs);
  const cost = timelineCost(row.costUsd);
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {row.status && showStatusBadge(row) && <StatusBadge status={row.status} />}
      {row.next && <span className="hidden sm:inline">next: <b className="font-semibold text-foreground">{row.next}</b></span>}
      {duration && <span className="hidden md:inline">{duration}</span>}
      {row.steps !== undefined && <span className="hidden md:inline">{row.steps} step{row.steps === 1 ? "" : "s"}</span>}
      {cost && <span className="hidden md:inline">{cost}</span>}
    </span>
  );
}

function Row({ row, lanes }: { row: TimelineRowView; lanes: number }) {
  return (
    <li
      data-testid="timeline-row" data-kind={row.kind} data-dead={row.dead || undefined}
      className="flex h-[34px] md:min-w-[640px] items-center gap-2.5 pr-3 text-sm hover:bg-muted/50"
    >
      <GraphCell row={row} lanes={lanes} />
      <code className="hidden shrink-0 text-xs text-muted-foreground md:inline">{row.id}</code>
      <span
        className="w-20 shrink-0 truncate rounded-full border-l-[3px] bg-muted px-2 md:w-24 md:px-2.5 py-0.5 text-center text-xs"
        style={{ borderLeftColor: laneColor(row.lane) }} title={row.actor}
      >{row.actor}</span>
      <span
        className={cn("w-64 min-w-0 shrink-0 truncate", row.kind === "tool" ? "text-xs text-muted-foreground" : row.kind === "turn.start" ? "font-semibold" : "")}
        title={[row.title, row.detail].filter(Boolean).join(" — ")}
      >{row.title}{row.detail && <span className="text-muted-foreground"> {row.detail}</span>}</span>
      <Meta row={row} />
      <time className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:inline" dateTime={row.at} title={row.at}>{stamp(row.at)}</time>
    </li>
  );
}

function Summary({ data }: { data: TimelineResponse }) {
  const statuses = Object.entries(data.summary.byStatus);
  return (
    <div data-testid="timeline-summary" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      <span><b className="text-foreground">{data.summary.runs}</b> branch{data.summary.runs === 1 ? "" : "es"}</span>
      {statuses.map(([status, count]) => (
        <span key={status} className="inline-flex items-center gap-1"><StatusBadge status={status} /><span className="tabular-nums">× {count}</span></span>
      ))}
      <span>cost <b className="text-foreground">{formatCost(data.summary.costUsd)}</b></span>
      <span><b className="text-foreground">{data.summary.tools}</b> tool call{data.summary.tools === 1 ? "" : "s"}</span>
    </div>
  );
}

/** The channel's timeline drawn like `git log --graph`: the channel agent is the main line, each subagent run a branch. */
export function TimelineView({ channelId, refreshToken }: { channelId: string; refreshToken: number }) {
  const [hideTools, setHideTools] = useState(false);
  const [actor, setActor] = useState("");
  const result = useApi(
    (signal) => api.timeline(channelId, { hideTools, actor }, signal),
    `timeline\n${channelId}\n${hideTools}\n${actor}`,
    refreshToken,
  );
  // The filters stay on screen (and keep focus) while a filtered response loads, so remember the actor list.
  const actors = useRef<{ channelId: string; names: string[] }>({ channelId, names: [] });
  if (result.data) actors.current = { channelId, names: result.data.actors };
  const names = actors.current.channelId === channelId ? actors.current.names : [];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 sm:p-4" data-testid="timeline-view">
      <h2 className="text-sm font-semibold">Timeline</h2>
      <Async result={result}>{(data) => <Summary data={data} />}</Async>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-primary" checked={hideTools} onChange={(event) => setHideTools(event.target.checked)} />
          Hide tool calls
        </label>
        <label className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">Actor</span>
          <select
            value={actor} onChange={(event) => setActor(event.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">All actors</option>
            {names.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
      {result.data && (
        result.data.rows.length === 0 ? (
          <Empty>Nothing on the timeline yet.</Empty>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border bg-card" tabIndex={0} role="region" aria-label="Timeline, scrollable">
              <ol aria-label="Timeline, newest first">
                {result.data.rows.map((row) => <Row key={row.id} row={row} lanes={result.data!.lanes} />)}
              </ol>
            </div>
            {result.data.rows.some((row) => row.dead) && (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><AlertTriangle className="size-3" aria-hidden />A dashed branch never reported back and has been quiet too long to still be running.</p>
            )}
          </>
        )
      )}
    </div>
  );
}
