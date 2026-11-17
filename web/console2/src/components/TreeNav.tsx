import { ChevronRight, GitBranch, Hash, MessageSquare, Lock, Moon, Bot, Clock, PanelLeftClose } from "lucide-react";
import { useMemo, useState } from "react";
import type { NodeKind, TreeChannel, TreeNode, TreeResponse } from "@api/api-types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTime, threadLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StateDot } from "./common";

const KIND_ICON: Record<NodeKind, typeof Hash> = { main: Hash, thread: MessageSquare, run: Bot, scheduled: Clock, dream: Moon };

export interface TreeNavProps {
  tree: TreeResponse | undefined;
  loading: boolean;
  error: string | undefined;
  channelId: string | undefined;
  threadKey: string | undefined;
  now: number;
  onSelect: (channelId: string, threadKey?: string) => void;
  /** Given where the panel can fold away (the wide layout); the drawer on a narrow screen has no such button. */
  onCollapse?: () => void;
}

export function channelTitle(channel: Pick<TreeChannel, "name" | "id" | "isDm">): string {
  return channel.name ? (channel.isDm ? channel.name : `#${channel.name}`) : channel.id;
}

function matches(channel: TreeChannel, needle: string): boolean {
  if (!needle) return true;
  const hay = `${channelTitle(channel)} ${channel.id}`.toLowerCase();
  return hay.includes(needle) || channel.nodes.some((node) => nodeMatches(node, needle));
}

function nodeMatches(node: TreeNode, needle: string): boolean {
  return `${node.label} ${node.id}`.toLowerCase().includes(needle) || (node.children ?? []).some((child) => nodeMatches(child, needle));
}

export function TreeNav({ tree, loading, error, channelId, threadKey, now, onSelect, onCollapse }: TreeNavProps) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needle = filter.trim().toLowerCase();
  const channels = useMemo(() => (tree?.channels ?? []).filter((channel) => matches(channel, needle)), [tree, needle]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-1">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workspace</h2>
          <span className="ml-auto text-xs text-muted-foreground">{tree ? `${tree.channels.length} channels` : ""}</span>
          {onCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="Collapse workspace panel" aria-expanded aria-controls="workspace-panel" onClick={onCollapse}>
                  <PanelLeftClose className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Collapse workspace panel</TooltipContent>
            </Tooltip>
          )}
        </div>
        <label className="sr-only" htmlFor="tree-filter">Filter channels and threads</label>
        <Input id="tree-filter" placeholder="Filter…" value={filter} onChange={(event) => setFilter(event.target.value)} className="h-8" />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Channels and threads" className="space-y-0.5 px-2 pb-4">
          {loading && !tree && (
            <div className="space-y-2 p-1" aria-busy="true">
              <Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-5/6" />
            </div>
          )}
          {error && !tree && <p role="alert" className="p-2 text-xs text-destructive">Could not load the tree: {error}</p>}
          {tree && channels.length === 0 && <p className="p-2 text-xs text-muted-foreground">{needle ? "Nothing matches." : "No channels yet."}</p>}
          {channels.map((channel) => {
            const selected = channel.id === channelId;
            const expanded = needle ? true : (open[channel.id] ?? selected);
            return (
              <Collapsible key={channel.id} open={expanded} onOpenChange={(value) => setOpen((previous) => ({ ...previous, [channel.id]: value }))}>
                <div className={cn("flex items-center rounded-md", selected && !threadKey && "bg-accent")}>
                  <CollapsibleTrigger
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${channelTitle(channel)}`}
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
                  </CollapsibleTrigger>
                  <button
                    type="button"
                    disabled={!channel.linkable}
                    aria-current={selected && !threadKey ? "page" : undefined}
                    onClick={() => onSelect(channel.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-accent disabled:opacity-60"
                  >
                    <StateDot state={channel.state} />
                    <span className="min-w-0 flex-1 truncate font-medium">{channel.isDm && <Lock className="mr-1 inline size-3 opacity-60" aria-label="Direct message" />}{channelTitle(channel)}</span>
                    {channel.activeTasks > 0 && <span className="rounded bg-muted px-1.5 text-[10px] tabular-nums" title="Active tasks">{channel.activeTasks}</span>}
                    <span className="hidden shrink-0 text-[10px] text-muted-foreground xl:inline">{relativeTime(channel.lastActivity, now)}</span>
                  </button>
                </div>
                <CollapsibleContent>
                  <div className="ml-3.5 border-l pl-1.5">
                    {!channel.live && (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        Store not loaded: it opens at startup for configured channels, so this one is not configured or is reopening.
                      </p>
                    )}
                    {channel.live && channel.nodes.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No threads yet.</p>}
                    {channel.nodes.filter((node) => !needle || nodeMatches(node, needle) || `${channelTitle(channel)}`.toLowerCase().includes(needle)).map((node) => (
                      <NodeRow key={node.id} node={node} depth={0} channelId={channel.id} selectedChannel={channelId} selectedThread={threadKey} now={now} onSelect={onSelect} />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </nav>
      </ScrollArea>
    </div>
  );
}

function NodeRow({ node, depth, channelId, selectedChannel, selectedThread, now, onSelect }: {
  node: TreeNode; depth: number; channelId: string; selectedChannel: string | undefined; selectedThread: string | undefined; now: number;
  onSelect: (channelId: string, threadKey?: string) => void;
}) {
  const Icon = KIND_ICON[node.kind] ?? GitBranch;
  const active = selectedChannel === channelId && (selectedThread ?? "main") === node.id && selectedThread !== undefined;
  return (
    <div>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(channelId, node.id)}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={cn("flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs hover:bg-accent", active && "bg-accent")}
      >
        <StateDot state={node.state} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{node.kind === "main" ? "main" : threadLabel(node.id, node.label)}</span>
        {node.forkedFromEntry !== undefined && <span className="shrink-0 text-[10px] text-muted-foreground" title={`Forked from entry ${node.forkedFromEntry} of main`}>↳ #{node.forkedFromEntry}</span>}
        <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(node.lastActivity, now)}</span>
      </button>
      {(node.children ?? []).map((child) => (
        <NodeRow key={child.id} node={child} depth={depth + 1} channelId={channelId} selectedChannel={selectedChannel} selectedThread={selectedThread} now={now} onSelect={onSelect} />
      ))}
    </div>
  );
}
