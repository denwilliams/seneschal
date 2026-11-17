import type { ConnectorView, ToolView } from "@api/api-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Async, Empty, Notice, Section } from "@/components/common";
import { ExecutionBoundary, ENVIRONMENT_LABEL } from "@/components/ExecutionBoundary";

const GROUP_LABEL: Record<ToolView["group"], string> = {
  builtin: "Built-in", files: "Files", slack: "Slack", memory: "Memory", schedules: "Schedules", subagents: "Subagents", knowledge: "Knowledge", connector: "Connectors", other: "Other",
};

export function ConnectorRows({ connectors }: { connectors: ConnectorView[] }) {
  if (connectors.length === 0) return <Empty>No connectors configured.</Empty>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Outside channel sandboxes: stdio servers run harness-side; HTTP servers run remotely (server isolation unknown).</p>
      <ul className="space-y-1.5">
        {connectors.map((connector) => (
          <li key={connector.name} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{connector.name}</span>
            <Badge variant="outline">{connector.transport}</Badge>
            <Badge variant={connector.toolsLoaded ? "secondary" : "destructive"}>{connector.toolsLoaded ? "tools loaded" : "no tools"}</Badge>
            {connector.connectable && <Badge variant="outline">needs sign-in</Badge>}
            {connector.connectUrl && (
              <Button asChild size="sm" variant="outline" className="h-7">
                <a href={connector.connectUrl} aria-label={`Connect ${connector.name}`}>Connect</a>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ToolsTab({ channelId, threadKey, refreshToken }: { channelId: string; threadKey: string | undefined; refreshToken: number }) {
  const result = useApi((signal) => api.tools(channelId, threadKey, signal), `tools\n${channelId}\n${threadKey ?? ""}`, refreshToken);
  return (
    <Async result={result}>
      {(t) => {
        const groups = new Map<ToolView["group"], ToolView[]>();
        for (const tool of t.tools) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool]);
        return (
          <div className="space-y-5">
            {!t.live && <Notice>The channel's store is not open, so this is the configured tool set rather than what is registered right now.</Notice>}
            <ExecutionBoundary execution={t.execution} />
            {t.tools.length === 0 && <Empty>No tools.</Empty>}
            {[...groups.entries()].map(([group, tools]) => (
              <Section key={group} title={GROUP_LABEL[group]} count={tools.length}>
                <ul className="flex flex-wrap gap-1.5">
                  {tools.map((tool) => (
                    <li key={tool.name} className="flex max-w-full flex-wrap items-center gap-1 rounded border bg-muted/40 px-1.5 py-1" title={tool.execution?.detail}>
                      <code className="break-all font-mono text-xs">{tool.name}</code>
                      <span className="text-[10px] text-muted-foreground">{ENVIRONMENT_LABEL[tool.execution?.location ?? "unknown"]}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ))}
            <Section title="Connectors" count={t.connectors.length}><ConnectorRows connectors={t.connectors} /></Section>
          </div>
        );
      }}
    </Async>
  );
}
