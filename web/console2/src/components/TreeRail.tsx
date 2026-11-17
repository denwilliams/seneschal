import { Lock, PanelLeftOpen } from "lucide-react";
import type { TreeResponse } from "@api/api-types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StateDot } from "./common";
import { channelTitle } from "./TreeNav";

/** The workspace panel folded away: one button to bring it back, and each channel as a small button with its name in a tooltip. */
export function TreeRail({ tree, channelId, onSelect, onExpand }: {
  tree: TreeResponse | undefined;
  channelId: string | undefined;
  onSelect: (channelId: string) => void;
  onExpand: () => void;
}) {
  return (
    <div data-testid="tree-rail" className="tree-rail flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Expand workspace panel" aria-expanded={false} aria-controls="workspace-panel" onClick={onExpand}>
            <PanelLeftOpen />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Expand workspace panel</TooltipContent>
      </Tooltip>
      <ScrollArea className="min-h-0 w-full flex-1">
        <nav aria-label="Channels" className="flex flex-col items-center gap-1 pb-2">
          {(tree?.channels ?? []).map((channel) => {
            const selected = channel.id === channelId;
            const title = channelTitle(channel);
            const initial = (channel.name || channel.id).replace(/^[#@]/, "").charAt(0).toUpperCase();
            return (
              <Tooltip key={channel.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={!channel.linkable}
                    aria-label={title}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onSelect(channel.id)}
                    className={cn(
                      "relative flex size-9 items-center justify-center rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
                      selected && "bg-accent text-foreground",
                    )}
                  >
                    {channel.isDm ? <Lock className="size-3.5" aria-hidden /> : <span aria-hidden>{initial}</span>}
                    <StateDot state={channel.state} className="absolute right-1 top-1 size-1.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{title}{channel.activeTasks > 0 ? ` · ${channel.activeTasks} active` : ""}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
      </ScrollArea>
    </div>
  );
}
