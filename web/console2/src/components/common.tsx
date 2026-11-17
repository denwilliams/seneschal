import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import type { ActivityState } from "@api/api-types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Fetched } from "@/lib/hooks";

const STATE_LABEL: Record<ActivityState, string> = { running: "Running", blocked: "Blocked", waiting: "Waiting", idle: "Idle" };
const STATE_DOT: Record<ActivityState, string> = {
  running: "bg-emerald-500",
  blocked: "bg-red-500",
  waiting: "bg-amber-500",
  idle: "bg-muted-foreground/40",
};

export function StateDot({ state, className }: { state: ActivityState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={STATE_LABEL[state]}
      title={STATE_LABEL[state]}
      className={cn("inline-block size-2 shrink-0 rounded-full", STATE_DOT[state], state === "running" && "animate-pulse", className)}
    />
  );
}

export function StateBadge({ state }: { state: ActivityState }) {
  return <Badge variant={state === "blocked" ? "destructive" : state === "idle" ? "outline" : "secondary"}>{STATE_LABEL[state]}</Badge>;
}

export function Section({ title, count, children, className }: { title: string; count?: number; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count !== undefined && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] normal-case tracking-normal">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** Renders loading, error and "nothing selected" the same way in every tab. */
export function Async<T>({ result, children }: { result: Fetched<T>; children: (data: T) => ReactNode }) {
  if (result.data !== undefined) return <>{children(result.data)}</>;
  if (result.error) {
    return (
      <div role="alert" className="space-y-2 rounded-md border border-destructive/50 px-3 py-2 text-xs">
        <p>Could not load: {result.error}</p>
        <button type="button" onClick={result.reload} className="underline underline-offset-2">Retry</button>
      </div>
    );
  }
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
    </div>
  );
}
