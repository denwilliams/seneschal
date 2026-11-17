import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { StateValue } from "@api/api-types";
import { Button } from "@/components/ui/button";
import { childrenOf, isContainer, kindOf, PAGE, remaining, startsOpen, summarize, truncateString, visibleCount } from "@/lib/state-tree";
import { cn } from "@/lib/utils";

const VALUE_CLASS = {
  string: "text-emerald-700 dark:text-emerald-400",
  number: "text-sky-700 dark:text-sky-400",
  boolean: "text-violet-700 dark:text-violet-400",
  null: "italic text-muted-foreground",
} as const;

function Primitive({ value }: { value: StateValue }) {
  const [expanded, setExpanded] = useState(false);
  const kind = kindOf(value);
  if (kind === "string") {
    const full = JSON.stringify(value);
    const cut = truncateString(value as string);
    return (
      <span className={cn("min-w-0 break-words", VALUE_CLASS.string)} title={cut.truncated && !expanded ? full : undefined}>
        {expanded || !cut.truncated ? full : `${JSON.stringify(cut.text.slice(0, -1)).slice(0, -1)}…"`}
        {cut.truncated && (
          <button type="button" className="ml-1.5 rounded px-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "show less" : "show all"}
          </button>
        )}
      </span>
    );
  }
  return <span className={VALUE_CLASS[kind as keyof typeof VALUE_CLASS]}>{String(value)}</span>;
}

function Row({ name, value, depth }: { name: string | undefined; value: StateValue; depth: number }) {
  const [open, setOpen] = useState(startsOpen(depth));
  const [pages, setPages] = useState(1);
  const label = name !== undefined && <span className="shrink-0 font-medium text-foreground">{name}<span className="text-muted-foreground">:</span></span>;

  if (!isContainer(value)) {
    return <li role="treeitem" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 py-0.5 pl-5">{label}<Primitive value={value} /></li>;
  }
  const children = childrenOf(value);
  const shown = visibleCount(children.length, pages);
  const more = remaining(children.length, pages);
  return (
    <li role="treeitem" aria-expanded={open} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name ?? "state"}, ${summarize(value)}`}
        onClick={() => setOpen((v) => !v)}
        className="-ml-0.5 flex w-full min-w-0 items-baseline gap-1 rounded py-0.5 text-left hover:bg-muted/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 translate-y-0.5 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
        {label}
        {/* The root has no key, so it always says what it holds; any other container does when closed or empty. */}
        {(name === undefined || !open || children.length === 0) && <span className="text-muted-foreground">{name === undefined ? `state ${summarize(value)}` : summarize(value)}</span>}
      </button>
      {open && children.length > 0 && (
        <ul role="group" className="ml-2 border-l pl-3">
          {children.slice(0, shown).map(([key, child]) => <Row key={key} name={Array.isArray(value) ? `[${key}]` : key} value={child} depth={depth + 1} />)}
          {more > 0 && (
            <li className="py-1 pl-5">
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setPages((n) => n + 1)}>
                Show {Math.min(PAGE, more)} more <span className="ml-1 text-muted-foreground">({more} left)</span>
              </Button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** A read-only, collapsible view of a JSON value. Everything is rendered as text by React; nothing is interpreted as HTML. */
export function JsonTree({ value, label = "Channel state" }: { value: StateValue; label?: string }) {
  return (
    <div className="max-h-[28rem] overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-5">
      <ul role="tree" aria-label={label}>
        <Row name={undefined} value={value} depth={0} />
      </ul>
    </div>
  );
}
