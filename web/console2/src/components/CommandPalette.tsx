import { useEffect } from "react";
import type { TreeNode, TreeResponse } from "@api/api-types";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { threadLabel } from "@/lib/format";
import type { ViewName } from "@/lib/route";
import { channelTitle } from "./TreeNav";

/** Every word typed must appear somewhere in the item: predictable, unlike cmdk's default fuzzy ranking. */
function substringMatch(value: string, search: string): number {
  const haystack = value.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word)) ? 1 : 0;
}

function flatten(nodes: TreeNode[], depth = 0): { node: TreeNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children ?? [], depth + 1)]);
}

export function CommandPalette({ open, onOpenChange, tree, onSelect, onView }: {
  open: boolean; onOpenChange: (open: boolean) => void; tree: TreeResponse | undefined; onSelect: (channelId: string, threadKey?: string) => void;
  onView: (channelId: string, view: ViewName) => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  const go = (channelId: string, threadKey?: string) => { onOpenChange(false); onSelect(channelId, threadKey); };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to a channel or thread" filter={substringMatch}>
      <CommandInput placeholder="Jump to a channel or thread…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {(tree?.channels ?? []).filter((channel) => channel.linkable).map((channel) => (
          <CommandGroup key={channel.id} heading={channelTitle(channel)}>
            <CommandItem value={`${channelTitle(channel)} ${channel.id} channel`} onSelect={() => go(channel.id)}>
              Channel overview
            </CommandItem>
            <CommandItem value={`${channelTitle(channel)} ${channel.id} timeline`} onSelect={() => { onOpenChange(false); onView(channel.id, "timeline"); }}>
              Timeline of {channelTitle(channel)}
            </CommandItem>
            {channel.factory && (
              <CommandItem value={`${channelTitle(channel)} ${channel.id} factory`} onSelect={() => { onOpenChange(false); onView(channel.id, "factory"); }}>
                Factory of {channelTitle(channel)}
              </CommandItem>
            )}
            {flatten(channel.nodes).map(({ node, depth }) => (
              <CommandItem key={node.id} value={`${channelTitle(channel)} ${channel.id} ${node.kind} ${node.label} ${node.id}`} onSelect={() => go(channel.id, node.id)}>
                <span style={{ paddingLeft: depth * 12 }} className="truncate">
                  <span className="text-muted-foreground">{node.kind} · </span>{node.kind === "main" ? "main" : threadLabel(node.id, node.label)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
