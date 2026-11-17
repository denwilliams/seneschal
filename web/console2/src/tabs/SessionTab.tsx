import type { SessionResponse } from "@api/api-types";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatCost, formatTokens } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { Async, KeyValue, Section } from "@/components/common";
import { ExecutionBoundary } from "@/components/ExecutionBoundary";

const SOURCE_LABEL: Record<string, string> = { heartbeat: "Heartbeats", scheduled: "Scheduled tasks", agent: "Conversations", dream: "Dreams", subagent: "Subagents", "recent-conversation": "Conversation summaries", "post-guard": "Post guard" };

const ROW_LABEL = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" } as const;

function ContextMeter({ context }: { context: NonNullable<SessionResponse["context"]> }) {
  const { usedTokens, windowTokens } = context;
  const percent = windowTokens ? Math.min(100, (usedTokens / windowTokens) * 100) : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span><span className="text-xl font-semibold tabular-nums">{formatTokens(usedTokens)}</span> {windowTokens ? `of ${formatTokens(windowTokens)} tokens` : "tokens in the last request"}</span>
        {percent !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{percent < 1 ? "<1" : Math.round(percent)}%</span>}
      </div>
      {percent !== undefined && <Progress value={percent} aria-label="Context used" />}
    </div>
  );
}

export function SessionTab({ channelId, threadKey, refreshToken }: { channelId: string; threadKey: string | undefined; refreshToken: number }) {
  const result = useApi((signal) => api.session(channelId, threadKey, signal), `session\n${channelId}\n${threadKey ?? ""}`, refreshToken);
  return (
    <Async result={result}>
      {(s) => (
        <div className="space-y-5">
          <Section title="Agent">
            <dl className="space-y-1.5">
              <KeyValue label="Model">{s.model ?? "unknown"}{s.pinnedModel && <Badge variant="outline" className="ml-2">pinned</Badge>}</KeyValue>
              <KeyValue label="Thinking">{s.thinkingLevel}</KeyValue>
              <KeyValue label="Tools">{s.toolCount}</KeyValue>
              <KeyValue label="Allowed users">{s.allowedUsers === "anyone" ? "anyone" : s.allowedUsers}</KeyValue>
            </dl>
          </Section>
          <Separator />
          <ExecutionBoundary execution={s.execution} sandbox={s.sandbox} />
          <Separator />
          <Section title="Context">
            {s.context ? <ContextMeter context={s.context} /> : <p className="text-xs text-muted-foreground">No request yet in this conversation.</p>}
          </Section>
          <Separator />
          <Section title={s.usage.scope === "channel" ? "Usage (whole channel)" : "Usage (this thread)"}>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[["Tokens", formatTokens(s.usage.totalTokens)], ["Cost", formatCost(s.usage.costUsd, s.usage.unpricedCalls > 0)], ["Calls", String(s.usage.calls)]].map(([label, value]) => (
                <div key={label} className="rounded-md border px-2 py-2">
                  <div className="text-base font-semibold tabular-nums">{value}</div>
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Type</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
              <TableBody>
                {s.usage.rows.map((row) => (
                  <TableRow key={row.type}>
                    <TableCell>{ROW_LABEL[row.type]}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.tokens.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCost(row.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {s.usage.bySource && <div className="mt-3">
              <p className="text-xs font-medium">Usage by activity</p>
              <Table>
                <TableHeader><TableRow><TableHead>Activity</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
                <TableBody>{s.usage.bySource.map((row) => <TableRow key={row.source}>
                  <TableCell>{SOURCE_LABEL[row.source] ?? row.source}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.calls.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.tokens.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCost(row.costUsd, row.unpricedCalls > 0)}</TableCell>
                </TableRow>)}</TableBody>
              </Table>
              <p className="text-xs text-muted-foreground">Heartbeats are quiet recurring checks. Idle “nothing to do” prompts skip the model; short active prompts still incur context costs.</p>
            </div>}
            {s.usage.unpricedCalls > 0 && <p className="text-xs text-muted-foreground">{s.usage.unpricedCalls} call(s) had no pricing data, so cost is a lower bound.</p>}
          </Section>
          <Separator />
          <Section title="Channel">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={s.schedules ? "secondary" : "outline"}>Schedules {s.schedules ? "on" : "off"}</Badge>
              <Badge variant={s.dreams ? "secondary" : "outline"}>Dreams {s.dreams ? "on" : "off"}</Badge>
              <Badge variant={s.respondToRootMessages ? "secondary" : "outline"}>Root messages {s.respondToRootMessages ? "on" : "off"}</Badge>
              {s.sharing.map((item) => <Badge key={item} variant="outline">{item}</Badge>)}
            </div>
          </Section>
        </div>
      )}
    </Async>
  );
}
