import { ExternalLink } from "lucide-react";
import type { ApprovalView, TaskView } from "@api/api-types";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { clock, formatCost, formatDuration, formatTokens, relativeTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { Async, Empty, Section } from "@/components/common";
import { JobRuns } from "@/components/JobRuns";
import { FactoryActions } from "@/components/RunActions";
import { IntakeBlock, WorkflowRuns } from "@/components/WorkflowRuns";

const STATUS_VARIANT = (status: string): "default" | "secondary" | "destructive" | "outline" =>
  /fail|error|denied|abandon|blocked/.test(status) ? "destructive" : /progress|requested|running|waiting|needs/.test(status) ? "default" : "secondary";

function TaskRow({ task, now }: { task: TaskView; now: number }) {
  return (
    <li className="space-y-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words">{task.summary}</span>
        <Badge variant={STATUS_VARIANT(task.status)}>{task.status.replace(/_/g, " ")}</Badge>
      </div>
      <p className="text-[11px] text-muted-foreground">{task.kind} · started {relativeTime(task.startedAt, now)}{task.finishedAt ? ` · finished ${relativeTime(task.finishedAt, now)}` : ` · updated ${relativeTime(task.updatedAt, now)}`}</p>
      {task.detail && <p className="text-xs text-muted-foreground">{task.detail}</p>}
      {task.links && task.links.length > 0 && (
        <p className="flex flex-wrap gap-x-3 text-xs">
          {task.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
              {link.label ?? link.url}<ExternalLink className="size-3" aria-hidden />
            </a>
          ))}
        </p>
      )}
    </li>
  );
}

function ApprovalRow({ approval }: { approval: ApprovalView }) {
  return (
    <li className="space-y-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words">{approval.title}</span>
        <Badge variant={STATUS_VARIANT(approval.status)}>{approval.status.replace(/_/g, " ")}</Badge>
      </div>
      <p className="text-[11px] text-muted-foreground">{approval.kind === "post" ? "post as user" : "approval"} · {approval.actor} · {clock(approval.at)}</p>
      {approval.detail && <p className="text-xs text-muted-foreground">{approval.detail}</p>}
    </li>
  );
}

export function TasksTab({
  channelId, refreshToken, now, isDm = false, isFactory = false, runId, onOpenRun,
}: { channelId: string; refreshToken: number; now: number; isDm?: boolean; isFactory?: boolean; runId?: string; onOpenRun?: (runId: string | undefined) => void }) {
  const result = useApi((signal) => api.tasks(channelId, signal), `tasks\n${channelId}`, refreshToken);
  // A failing list leaves the rest of the tab alone: it is just not shown.
  const workflows = useApi((signal) => api.workflows(channelId, signal), `workflows\n${channelId}`, refreshToken);
  const runs = workflows.data?.runs ?? [];
  const intake = workflows.data?.intake;
  return (
    <Async result={result}>
      {(t) => (
        <div className="space-y-5">
          {(runs.length > 0 || isFactory || intake) && (
            <>
              <Section title="Workflow runs" count={runs.length}>
                {workflows.data?.actions && <FactoryActions channelId={channelId} actions={workflows.data.actions} onChanged={workflows.reload} onOpenRun={(id) => onOpenRun?.(id)} />}
                {runs.length === 0 ? (
                  <Empty>{intake?.enabled ? "No workflow runs yet. A new issue from a trusted author starts one by itself." : "No workflow runs yet. Ask the channel agent to work an issue."}</Empty>
                ) : (
                  <WorkflowRuns channelId={channelId} runs={runs} isDm={isDm} now={now} runId={runId} onOpen={onOpenRun ?? (() => {})} refreshToken={refreshToken} onChanged={workflows.reload} actionsOn={workflows.data?.actions !== undefined} />
                )}
              </Section>
              {intake && (
                <Section title="Issue intake" count={intake.repos.reduce((sum, repo) => sum + Object.values(repo.counts).reduce((a, b) => a + (b ?? 0), 0), 0)}>
                  <IntakeBlock intake={intake} isDm={isDm} now={now} onOpen={(id) => onOpenRun?.(id)} />
                </Section>
              )}
              <Separator />
            </>
          )}
          {(t.jobs ?? []).length > 0 && (
            <>
              <Section title="Jobs" count={t.jobs.length}><JobRuns runs={t.jobs} isDm={isDm} now={now} /></Section>
              <Separator />
            </>
          )}
          {t.blocked.length > 0 && (
            <>
              <Section title="Blocked" count={t.blocked.length}>
                <ul className="space-y-2">
                  {t.blocked.map((item) => (
                    <li key={item.threadKey} className="rounded-md border border-destructive/50 px-3 py-2 text-sm">
                      <p className="break-words">{item.reason}</p>
                      <p className="text-[11px] text-muted-foreground">thread {item.threadKey}{item.since ? ` · since ${relativeTime(item.since, now)}` : ""}</p>
                    </li>
                  ))}
                </ul>
              </Section>
              <Separator />
            </>
          )}
          <Section title="Approvals" count={t.approvals.length}>
            {t.approvals.length === 0 ? <Empty>No approvals or held posts.</Empty> : <ul className="space-y-2">{t.approvals.map((a) => <ApprovalRow key={a.id} approval={a} />)}</ul>}
          </Section>
          <Separator />
          <Section title="Active tasks" count={t.active.length}>
            {t.active.length === 0 ? <Empty>Nothing running.</Empty> : <ul className="space-y-2">{t.active.map((task) => <TaskRow key={task.id} task={task} now={now} />)}</ul>}
          </Section>
          <Separator />
          <Section title="Agent activity" count={t.activity.length}>
            {t.activity.length === 0 ? <Empty>No recorded activity.</Empty> : (
              <ol className="space-y-1" aria-label="Recent agent activity">
                {t.activity.map((item) => (
                  <li key={item.id} className="flex items-baseline gap-2 text-xs">
                    <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{relativeTime(item.at, now)}</span>
                    <span className="min-w-0 flex-1 break-words"><span className="text-muted-foreground">{item.actor} · {item.kind} · </span>{item.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {[item.status, formatDuration(item.durationMs), item.tokens !== undefined ? `${formatTokens(item.tokens)} tok` : "", item.costUsd !== undefined ? formatCost(item.costUsd) : ""].filter(Boolean).join(" · ")}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>
          <Separator />
          <Section title="Schedules" count={t.schedules.length}>
            {t.schedules.length === 0 ? <Empty>No schedules.</Empty> : (
              <ul className="space-y-2">
                {t.schedules.map((s) => (
                  <li key={s.id} className="space-y-1 rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 break-words">{s.prompt || <em className="text-muted-foreground">content hidden</em>}</span>
                      {s.reminder && <Badge variant="outline">reminder</Badge>}
                      {s.quiet && <Badge variant="outline">quiet</Badge>}
                    </div>
                    <p className="font-mono text-[11px] text-muted-foreground">{s.heartbeat ? `heartbeat every ${s.heartbeat.intervalMinutes} min (${s.heartbeat.enabled ? "enabled" : "paused"})` : s.cron ?? (s.runAt ? `once at ${clock(s.runAt)}` : "")} · {s.timezone}</p>
                    <p className="text-[11px] text-muted-foreground">next {s.nextRun ? `${clock(s.nextRun)} (${relativeTime(s.nextRun, now)})` : "none"} · last {relativeTime(s.lastRun, now)} · {s.runCount} runs</p>
                    {s.lastError && <p className="text-xs text-destructive">{s.lastError}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Schedule runs" count={t.scheduleRuns.length}>
            {t.scheduleRuns.length === 0 ? <Empty>No runs recorded.</Empty> : (
              <ul className="space-y-1">
                {t.scheduleRuns.map((run) => (
                  <li key={run.id} className="flex items-center gap-2 text-xs">
                    <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
                    <span className="text-muted-foreground">{clock(run.startedAt)}</span>
                    {run.error && <span className="min-w-0 flex-1 truncate text-destructive" title={run.error}>{run.error}</span>}
                    {run.slackOutputUrl && <a href={run.slackOutputUrl} target="_blank" rel="noreferrer noopener" className="ml-auto underline underline-offset-2">thread</a>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Separator />
          <Section title="Recent tasks" count={t.recent.length}>
            {t.recent.length === 0 ? <Empty>No finished tasks.</Empty> : <ul className="space-y-2">{t.recent.map((task) => <TaskRow key={task.id} task={task} now={now} />)}</ul>}
          </Section>
        </div>
      )}
    </Async>
  );
}
