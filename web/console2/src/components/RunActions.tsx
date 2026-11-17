import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkflowActionName, WorkflowChannelActions, WorkflowRunView } from "@api/api-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { TONE_NOTICE } from "@/lib/jobs";
import { cn } from "@/lib/utils";

/** The most an answer may be: the server refuses more. */
export const ANSWER_MAX = 4000;
export const NOTES_MAX = 1000;

interface Outcome { tone: "ok" | "bad"; text: string }

/** What the last action said: fixed words from the server when it worked, its refusal when it did not. */
function Outcome({ outcome }: { outcome: Outcome | undefined }) {
  if (!outcome) return null;
  return (
    <div role={outcome.tone === "bad" ? "alert" : "status"} data-testid="action-outcome" data-tone={outcome.tone} className={cn("rounded-md border px-2.5 py-1.5 text-xs", TONE_NOTICE[outcome.tone])}>
      <span className="break-words">{outcome.text}</span>
    </div>
  );
}

const textareaClass = "flex min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/** One request at a time: the buttons are disabled while one is in flight, so a double click cannot send it twice. */
function useAction() {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const run = async (name: string, send: () => Promise<{ message: string; runId?: string }>): Promise<{ message: string; runId?: string } | undefined> => {
    if (busy) return undefined;
    setBusy(name);
    setOutcome(undefined);
    try {
      const result = await send();
      setOutcome({ tone: "ok", text: result.message });
      return result;
    } catch (error) {
      setOutcome({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, outcome, run };
}

const BUTTON_LABEL: Partial<Record<WorkflowActionName, string>> = { approve: "Approve merge", decline: "Decline merge", verify_approver: "Verify my browser in Slack", retry: "Retry", skip: "Skip this stage", abort: "Abort run", recheck: "Re-check the issue" };
const BUTTON_HINT: Partial<Record<WorkflowActionName, string>> = {
  retry: "Run the stage again as a new attempt",
  skip: "Move on without it (an optional stage only)",
  abort: "End the run",
  recheck: "Read the issue's comments again from where the run began",
};

/**
 * What a run is waiting for and what carries it on: the words come from the server, which knows the state. When the operator turned
 * console actions on, the applicable buttons are here. Merge decisions additionally require run-scoped Slack verification.
 */
export function GuidancePanel({ channelId, run, showSummary, onChanged }: { channelId: string; run: WorkflowRunView; showSummary: boolean; onChanged: () => void }) {
  const guidance = run.guidance;
  const { busy, outcome, run: act } = useAction();
  const [answer, setAnswer] = useState("");
  const [stage, setStage] = useState("");
  const [confirmAbort, setConfirmAbort] = useState(false);
  useEffect(() => {
    if (guidance?.mergeVerification?.state !== "pending") return;
    const timer = setInterval(onChanged, 2000);
    return () => clearInterval(timer);
  }, [guidance?.mergeVerification?.state, onChanged]);
  if (!guidance) return <Outcome outcome={outcome} />;
  const actions = guidance.actions ?? [];
  const has = (name: WorkflowActionName) => actions.includes(name);
  const restartFrom = guidance.restartFrom ?? [];
  const chosenStage = stage || restartFrom[restartFrom.length - 1] || "";
  const simple = (["approve", "decline", "verify_approver", "retry", "skip", "recheck"] as const).filter(has);
  const go = async (name: WorkflowActionName, body: Record<string, unknown> = {}) => {
    const done = await act(name, () => api.runAction(channelId, run.runId, name, body));
    if (done) onChanged();
    return done;
  };
  return (
    <section aria-label="What you can do" data-testid="workflow-actions" data-actions={actions.join(",")} className="space-y-2.5 rounded-md border px-3 py-2.5">
      <p className="text-xs font-semibold">What you can do</p>
      {showSummary && <p data-testid="workflow-guidance" className="text-xs">{guidance.summary}</p>}
      {guidance.elsewhere.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[11px] font-medium text-muted-foreground">{actions.length > 0 ? "Or, without the console:" : "How to carry it on:"}</p>
          <ul data-testid="workflow-elsewhere" className="list-inside list-disc text-[11px] text-muted-foreground">
            {guidance.elsewhere.map((way) => <li key={way} className="break-words">{way}</li>)}
          </ul>
        </div>
      )}
      {actions.length === 0 && <p data-testid="workflow-actions-off" className="text-[11px] text-muted-foreground">This console is read-only. The operator can let it act with <code className="font-mono">webConsole.actions</code>.</p>}
      {run.waiting?.kind === "merge" && guidance.actions !== undefined && (
        <div data-testid="merge-authorization" className="space-y-2 text-xs">
          <p>{guidance.mergeVerification?.state === "verified"
            ? "Slack approver verified for this wait and reviewed commit. Choose Approve merge or Decline merge. Verification is not merge authorization."
            : guidance.mergeVerification?.state === "pending"
              ? `Match challenge ${guidance.mergeVerification.challenge} in your run's Slack thread. Confirm ONLY your own matching browser, then return here. Waiting for verification; this does not approve the merge.`
              : guidance.mergeVerification?.state === "unverified"
                ? "Verify your own browser in Slack first. Only a current factory approver can verify it. Verification expires after 10 minutes and is limited to this wait and reviewed commit; console access alone is not merge authorization."
                : "Console merge verification is unavailable. Use Approve or Decline in the run's Slack post or ask the channel agent."}</p>
          {!has("approve") && <div className="flex flex-wrap gap-2"><Button size="sm" disabled>Approve merge</Button><Button size="sm" variant="outline" disabled>Decline merge</Button></div>}
        </div>
      )}
      {has("answer") && (
        <form
          className="space-y-1.5"
          onSubmit={(event) => { event.preventDefault(); if (answer.trim()) void go("answer", { text: answer }).then((done) => { if (done) setAnswer(""); }); }}
        >
          <label htmlFor={`answer-${run.runId}`} className="text-xs font-medium">Answer the question</label>
          <textarea
            id={`answer-${run.runId}`} data-testid="action-answer-text" className={textareaClass} value={answer} maxLength={ANSWER_MAX} disabled={busy !== undefined}
            placeholder="What was decided. It goes on the issue as a comment from the harness, and triage runs again with it." onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground" data-testid="action-answer-count">{answer.length} / {ANSWER_MAX}</span>
            <Button type="submit" size="sm" data-testid="action-answer" disabled={busy !== undefined || answer.trim() === ""}>
              {busy === "answer" && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}Send answer
            </Button>
          </div>
        </form>
      )}
      {(simple.length > 0 || has("restart_from") || has("abort")) && (
        <div className="flex flex-wrap items-center gap-2">
          {simple.map((name) => (
            <Button key={name} type="button" size="sm" variant="outline" data-testid={`action-${name}`} title={BUTTON_HINT[name]} disabled={busy !== undefined} onClick={() => void go(name)}>
              {busy === name && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}{BUTTON_LABEL[name]}
            </Button>
          ))}
          {has("restart_from") && restartFrom.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <label htmlFor={`restart-${run.runId}`} className="sr-only">Restart from stage</label>
              <select
                id={`restart-${run.runId}`} data-testid="action-restart-stage" value={chosenStage} disabled={busy !== undefined} onChange={(event) => setStage(event.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                {restartFrom.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <Button type="button" size="sm" variant="outline" data-testid="action-restart_from" title="Go back to that stage; later stages start again" disabled={busy !== undefined || chosenStage === ""} onClick={() => void go("restart_from", { stage: chosenStage })}>
                {busy === "restart_from" && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}Restart from
              </Button>
            </span>
          )}
          {has("abort") && (
            <Button type="button" size="sm" variant="outline" data-testid="action-abort" title={BUTTON_HINT.abort} disabled={busy !== undefined} onClick={() => setConfirmAbort(true)}
              className="border-red-500/60 text-red-700 hover:bg-red-500/10 hover:text-red-700 dark:text-red-300 dark:hover:text-red-300">
              Abort run
            </Button>
          )}
        </div>
      )}
      <Outcome outcome={outcome} />
      <Dialog open={confirmAbort} onOpenChange={setConfirmAbort}>
        <DialogContent data-testid="abort-dialog" className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Abort this run?</DialogTitle>
            <DialogDescription>It ends the run. The pull request and anything the run already did on GitHub stay there; the issue can be started again later.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" data-testid="abort-cancel" onClick={() => setConfirmAbort(false)}>Keep it running</Button>
            <Button type="button" size="sm" data-testid="abort-confirm" className="bg-red-600 text-white hover:bg-red-600/90" disabled={busy !== undefined} onClick={() => { setConfirmAbort(false); void go("abort"); }}>
              Abort run
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Task controls intentionally offer neither retry nor gate approval. */
export function TaskWorkflowActions({ channelId, run, onChanged }: { channelId: string; run: WorkflowRunView; onChanged: () => void }) {
  const { busy, outcome, run: act } = useAction();
  const [confirm, setConfirm] = useState(false);
  const control = run.taskControl;
  const go = async (name: "stop" | "bump") => {
    if (!control) return;
    const done = await act(name, () => api.taskAction(channelId, run.runId, name, control.revision));
    // Refresh even on a stale-revision refusal; never resubmit automatically.
    onChanged();
    if (done) setConfirm(false);
  };
  return <section aria-label="Task workflow controls" className="space-y-2 text-xs">
    {control && control.actions.length === 0 && !run.endedAt && <p className="text-muted-foreground">Console controls are unavailable. Ask in the owning conversation, or enable <code>webConsole.actions</code>.</p>}
    {control && control.actions.length > 0 && <div className="flex flex-wrap gap-2">
      {control.actions.includes("stop") && <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => setConfirm(true)}>Stop workflow</Button>}
      {control.actions.includes("bump") && <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => void go("bump")}>Bump workflow</Button>}
      <p className="basis-full text-muted-foreground">Bump asks the owning conversation to inspect, not retry. If it is busy, the request waits its turn.</p>
    </div>}
    <Outcome outcome={outcome} />
    <Dialog open={confirm} onOpenChange={setConfirm}>
      <DialogContent className="max-w-sm" data-testid="task-stop-dialog">
        <DialogHeader><DialogTitle>Stop this workflow?</DialogTitle>
          <DialogDescription>This prevents further progression and invalidates this attempt. Cancellation of an executing worker is best-effort; in-flight tools may still finish. Already-completed external effects are not undone.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => setConfirm(false)}>Keep it running</Button>
          <Button size="sm" disabled={busy !== undefined} onClick={() => { setConfirm(false); void go("stop"); }}>Confirm stop</Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}

/** Start a run for an issue, and ask intake to poll now: the channel-level actions. */
export function FactoryActions({ channelId, actions, onChanged, onOpenRun }: { channelId: string; actions: WorkflowChannelActions; onChanged: () => void; onOpenRun: (runId: string) => void }) {
  const { busy, outcome, run: act } = useAction();
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [notes, setNotes] = useState("");
  const tracker = actions.source === "jira" ? "Jira" : "GitHub";
  const single = actions.repositories.length === 1 ? actions.repositories[0] : undefined;
  const start = async () => {
    const done = await act("start", () => api.factoryAction(channelId, "start", { issue: issue.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}) }));
    if (!done) return;
    setOpen(false);
    setIssue("");
    setNotes("");
    onChanged();
    if (done.runId) onOpenRun(done.runId);
  };
  return (
    <div data-testid="factory-actions" className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {actions.start && <Button type="button" size="sm" variant="outline" data-testid="action-start" disabled={busy !== undefined} onClick={() => setOpen(true)}>Start a run for an issue…</Button>}
        {actions.poll && (
          <Button type="button" size="sm" variant="outline" data-testid="action-poll" title={`Ask intake to look at ${tracker} now`} disabled={busy !== undefined} onClick={() => void act("poll", () => api.factoryAction(channelId, "poll")).then((done) => { if (done) onChanged(); })}>
            {busy === "poll" && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}Poll {tracker} now
          </Button>
        )}
      </div>
      {!open && <Outcome outcome={outcome} />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="start-dialog" className="max-w-md">
          <DialogHeader>
            <DialogTitle>Start a run for an issue</DialogTitle>
            <DialogDescription>{actions.source === "jira" ? `Name a Jira key or browse URL. Code goes to ${single}.` : single ? `The issue is one of ${single}'s.` : `One of ${actions.repositories.join(", ")}.`} It must be open and have no live run.</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (issue.trim()) void start(); }}>
            <div className="space-y-1">
              <label htmlFor="start-issue" className="text-xs font-medium">Issue</label>
              <Input id="start-issue" data-testid="start-issue" value={issue} maxLength={200} autoFocus disabled={busy !== undefined} placeholder={actions.source === "jira" ? "HAR-123 or Jira browse URL" : single ? `#123 or ${single}#123` : "owner/repo#123"} onChange={(event) => setIssue(event.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="start-notes" className="text-xs font-medium">Notes for the stages <span className="font-normal text-muted-foreground">(optional)</span></label>
              <textarea id="start-notes" data-testid="start-notes" className={textareaClass} value={notes} maxLength={NOTES_MAX} disabled={busy !== undefined} onChange={(event) => setNotes(event.target.value)} />
            </div>
            <Outcome outcome={outcome} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" data-testid="start-submit" disabled={busy !== undefined || issue.trim() === ""}>
                {busy === "start" && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}Start run
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
