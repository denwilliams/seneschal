import type { TaskWorkflow, WorkflowStep } from "../tasks/workflow.ts";
import type { PresenceSlack } from "./factory-presence.ts";
import { logger } from "../util/log.ts";

export interface TaskPresenceStore {
  taskWorkflow(id: string): Promise<TaskWorkflow | undefined>;
  listTaskWorkflows(threadKey?: string): Promise<TaskWorkflow[]>;
  setTaskWorkflowSlack(id: string, ts: string, location?: "channel" | "thread"): Promise<void>;
}
const SLACK_THREAD_TS = /^\d{6,}\.\d{3,}$/;
const STATUS: Record<WorkflowStep["status"], string> = { ready: "⏳ Not started / ready", working: "🔄 Working", submitted: "👀 Submitted — awaiting parent review", return_requested: "👀 Return requested — awaiting parent review", approved: "✅ Approved" };
const WORKFLOW_STATUS: Record<TaskWorkflow["status"], string> = { active: "active", completed: "✅ completed", aborted: "🛑 aborted" };

function stepStatus(step: WorkflowStep): string {
  if (step.status === "ready" && step.dispatchDependency) return "🚧 Not started / ready — blocked on external dependency";
  if (step.status === "working" && step.diagnostic?.interrupted) return "⚠️ Working — interrupted";
  return STATUS[step.status];
}

/** Plain text blocks keep workflow names/results from mentioning people or injecting Slack markup. */
export function taskWorkflowStatus(workflow: TaskWorkflow, direct = false, conversationUrl?: string): { text: string; blocks: unknown[] } {
  const current = Math.min(workflow.index, workflow.steps.length - 1);
  const name = (index: number) => direct ? `Stage ${index + 1}` : workflow.steps[index]!.name;
  const state = workflow.status === "active" ? `${workflow.status} — ${stepStatus(workflow.steps[current]!)}` : WORKFLOW_STATUS[workflow.status];
  const text = `Task workflow ${workflow.id} · ${state} · ${workflow.status === "active" ? "Current step" : "Last step"} ${current + 1}/${workflow.steps.length}: ${name(current)}`;
  return { text, blocks: [
    { type: "section", text: { type: "plain_text", text: text.slice(0, 2900) } },
    // 20 names of up to 200 characters can exceed one Slack section.
    ...workflow.steps.map((step, index) => ({ type: "section", text: { type: "plain_text", text: `${index + 1}. ${name(index)} — ${stepStatus(step)}` } })),
    { type: "context", elements: [{ type: "plain_text", text: `Revision ${workflow.revision}. Gate review remains with the parent in the original task conversation.` }] },
    ...(conversationUrl ? [{ type: "context", elements: [{ type: "mrkdwn", text: `<${conversationUrl}|Open owning task conversation>` }] }] : []),
  ] };
}

interface State { chain: Promise<unknown>; cancel?: () => void; rendered: string; last: number; retries: number; blockedUntil: number; direct: boolean; conversationUrl?: string }
/** One persisted channel status card per workflow (a thread reply in DMs), edited in place. Observation cannot change execution. */
export class TaskWorkflowPresence {
  private states = new Map<string, State>();
  private readonly deps: {
    store: (channelId: string) => TaskPresenceStore | undefined;
    slack: Pick<PresenceSlack, "post" | "update" | "permalink">;
    schedule?: (fn: () => void, ms: number) => () => void;
    now?: () => number;
  };
  constructor(deps: TaskWorkflowPresence["deps"]) { this.deps = deps; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private schedule(fn: () => void, ms: number) {
    if (this.deps.schedule) return this.deps.schedule(fn, ms);
    const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer);
  }
  notify(channelId: string, workflow: TaskWorkflow, direct = false): void {
    if (workflow.channelId !== channelId) return;
    const key = `${channelId}/${workflow.id}`;
    let state = this.states.get(key);
    if (!state) { state = { chain: Promise.resolve(), rendered: "", last: 0, retries: 0, blockedUntil: 0, direct }; this.states.set(key, state); }
    state.direct = direct;
    const urgent = workflow.status !== "active" || ["submitted", "return_requested"].includes(workflow.steps[workflow.index]?.status ?? "");
    this.queue(channelId, workflow.id, state, urgent ? 0 : Math.max(0, state.last + 4000 - this.now()));
  }
  private queue(channelId: string, id: string, state: State, delay: number): void {
    delay = Math.max(delay, state.blockedUntil - this.now(), 0);
    if (state.cancel && delay > 0) return;
    state.cancel?.();
    state.cancel = this.schedule(() => {
      state.cancel = undefined;
      state.chain = state.chain.then(() => this.draw(channelId, id, state)).catch((error) => logger.warn(`task workflow presence failed: ${error}`));
    }, delay);
  }
  private async draw(channelId: string, id: string, state: State): Promise<void> {
    try {
      const store = this.deps.store(channelId);
      const workflow = await store?.taskWorkflow(id);
      if (!store || !workflow || workflow.channelId !== channelId) return;
      const threadTs = SLACK_THREAD_TS.test(workflow.parentThreadKey) ? workflow.parentThreadKey : undefined;
      // Only the owning channel is ever consulted or posted to. A failed permalink lookup must not hide the card.
      if (threadTs && !state.conversationUrl) {
        state.conversationUrl = await this.deps.slack.permalink({ channel: channelId, ts: threadTs }).catch(() => undefined);
      }
      const conversationUrl = state.conversationUrl ?? (threadTs ? `slack://channel?id=${encodeURIComponent(channelId)}&message=${threadTs}` : undefined);
      const view = taskWorkflowStatus(workflow, state.direct, conversationUrl);
      const location = state.direct && threadTs ? "thread" : "channel";
      // Before location was persisted, a Slack parent timestamp always meant a reply. Main-conversation cards already are top-level.
      const oldLocation = workflow.slack?.location ?? (threadTs ? "thread" : "channel");
      const movedReply = workflow.slack?.ts && oldLocation !== location ? workflow.slack.ts : undefined;
      const rendered = JSON.stringify(view);
      if (state.rendered === rendered && !movedReply) return;
      if (workflow.slack?.ts && !movedReply) {
        try { await this.deps.slack.update({ channel: channelId, ts: workflow.slack.ts, ...view }); }
        catch (error) {
          const code = (error as { data?: { error?: string } }).data?.error;
          if (code !== "message_not_found" && code !== "cant_update_message") throw error;
          await store.setTaskWorkflowSlack(id, "");
          throw error; // next retry recreates the deleted post
        }
      } else {
        const posted = await this.deps.slack.post({ channel: channelId, ...(location === "thread" ? { threadTs } : {}), ...view });
        await store.setTaskWorkflowSlack(id, posted.ts, location);
        if (movedReply) {
          // Persist the new identity first: a failed retirement must never cause another channel card on restart.
          const text = "This workflow’s status card has moved to the channel. Continue gate review in this owning task conversation.";
          await this.deps.slack.update({ channel: channelId, ts: movedReply, text, blocks: [{ type: "section", text: { type: "plain_text", text } }] })
            .catch((error) => logger.debug(`task workflow ${id}: could not retire the old thread status: ${error}`));
        }
      }
      state.rendered = rendered; state.last = this.now(); state.retries = 0;
    } catch (error) {
      logger.warn(`task workflow ${id}: could not draw Slack status: ${error}`);
      if (state.retries++ < 3) {
        const seconds = Number((error as { retryAfter?: number; data?: { retry_after?: number } }).retryAfter ?? (error as { data?: { retry_after?: number } }).data?.retry_after);
        const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) * 1000 : 5000 * 2 ** state.retries;
        state.blockedUntil = this.now() + wait;
        this.queue(channelId, id, state, wait);
      }
    }
  }
  /** Reconcile live runs after restart (including existing posts that missed their last edit). */
  async catchUp(channelId: string, direct = false): Promise<void> {
    try {
      const runs = await this.deps.store(channelId)?.listTaskWorkflows() ?? [];
      runs.filter((run) => run.status === "active" || run.slack?.ts).forEach((run, index) => {
        // Space historical posts/edits like factory catch-up instead of flooding Slack on restart.
        if (index === 0) this.notify(channelId, run, direct);
        else this.schedule(() => this.notify(channelId, run, direct), index * 1500);
      });
    } catch (error) { logger.debug(`task workflow catch-up failed: ${error}`); }
  }
  async flush(): Promise<void> {
    for (const [key, state] of this.states) {
      if (state.cancel) {
        state.cancel(); state.cancel = undefined;
        const split = key.indexOf("/");
        state.chain = state.chain.then(() => this.draw(key.slice(0, split), key.slice(split + 1), state));
      }
      await state.chain;
    }
  }
}
