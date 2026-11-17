# Gated task workflows

For a task that needs a small ordered pipeline rather than a software factory,
use the always-available task workflow tools. These workflows are **linear**:
no parallel steps, branches, scheduler, visual editor, executable gate language,
or automatic advancement. Existing software-factory tools and policies are
unchanged; use those for software-factory work.

## Declare and run

`create_task_workflow` attaches a workflow to the current substantive task and
parent conversation. Declare 1–20 uniquely named steps, each with a `directive`,
1–20 plain-language `gates`, and optionally an `agent` from the channel's configured
subagents. Omit `agent` when the parent should do that step itself. For example:

```json
{
  "steps": [
    { "name": "research", "directive": "Gather sources for the requested report", "gates": ["Claims have primary sources"], "agent": "researcher" },
    { "name": "draft", "directive": "Write the report using approved research", "gates": ["All requested topics are covered"], "agent": "writer" },
    { "name": "verify", "directive": "Check claims and coverage", "gates": ["No unsupported claims remain"] }
  ]
}
```

The response contains a `workflowId` (the record's `id`) and `revision`. On every
mutation pass `workflowId` and the latest `revision`. A stale revision is refused;
read `check_task_workflow` again instead of guessing. Without an ID, checking
lists only workflows owned by this parent conversation, including finished ones.

1. Call `run_task_workflow_step` to start the current ready step. For a configured
   subagent it waits for the existing subagent runner; for a parent-executed step
   it returns the brief. Approval-required roles still need their normal
   `request_access` grant before they can start.
2. The worker calls `submit_task_workflow_step` with `output`. Its report alone
   is **not** a submission. Submission changes the step to `submitted`, never
   advances it, and never completes the workflow.
3. The parent reads the output and independently evaluates the declared gates.
   Call `decide_task_workflow_step` with `decision: "approve"`, `feedback`, and
   one `{ "passed": true, "evidence": "what you verified" }` for **every** gate,
   in declaration order. The runtime requires all gates to pass; it cannot
   establish the truth of plain-language evidence on the parent's behalf.
4. Approval makes the next step ready. Start it explicitly. The final step also
   requires approval before the workflow becomes `completed`.

Every attempt receives the ordered flow (names, directives, agents, gates and
statuses), its position, approved prior output, its previous submission, and
rework/return feedback. Subagent tools are bound to that particular workflow,
step, and run attempt by the runtime, not by arguments it supplies. Ordinary
subagents, including software-factory roles, get no workflow tools unless they
are started as a workflow participant.

## Correct a definition

The parent can call `edit_task_workflow` to correct an **active** workflow's
plain-English directives and/or acceptance gates without replacing its identity:

```json
{
  "workflowId": "workflow_…",
  "revision": 7,
  "reason": "The report needs primary sources, not secondary summaries",
  "edits": [
    { "step": 1, "directive": "Gather primary sources for the report", "gates": ["Claims have primary sources", "Source dates are recorded"] }
  ]
}
```

- `step` is a **1-based position** in the existing flow. Supply 1–20 unique
  positions and at least one of `directive` or `gates` for each. Omitted fields
  stay unchanged; supplying `gates` replaces that step's entire ordered gate list.
  Existing definition limits apply. Blank, invalid, duplicate-position, stale
  and wholly unchanged edits are rejected without modifying the workflow.
- Every actually changed step and **all downstream work** become ready again.
  Their current outputs and attempt keys are cleared, their feedback becomes the
  correction reason, and they must run, submit and pass review again. Attempt
  counters are not reset. The cursor moves back if necessary. Earlier unaffected
  work, including approvals, remains valid. Future-only corrections leave the
  current step in place.
- The audit history retains previous submissions/decisions plus the reason and
  before/after definitions of each change. `check_task_workflow` (including its
  list form) shows the corrected definition and history. Subsequent run briefs
  use the corrected flow, never invalidated outputs. Old revisions cannot
  approve the corrected workflow; invalidated worker attempts cannot regain
  authority by reading a newer revision.
- **No edit while any step is working**, even for a future step: every worker
  receives the full flow. An interrupted attempt is still working. Inspect its
  effects and finish/submit it before correcting; an assigned subagent must
  submit its own output. The existing explicit retry policy still applies if an
  attempt cannot finish. This tool neither interrupts workers nor undoes external
  side effects, and corrections never automatically rerun anything.
- Completed and aborted workflows remain immutable. This first version does not
  insert, delete, reorder or rename steps, change subagent assignments, or add a
  dedicated UI editor. Subagents cannot edit definitions.

## Rework and backward returns

- A failed gate: the parent calls `decide_task_workflow_step` with
  `decision: "rework"` and actionable `feedback`. Optionally include failed-gate
  evaluations for the audit history. The same step becomes ready and must run,
  submit and receive approval again. The response includes a parent-facing
  `nextAction` with the exact dispatch arguments and current revision. **Start
  that ready step now with `run_task_workflow_step`, without `retry: true`**;
  feedback and the previous submission travel into the new attempt. Readiness
  means awaiting parent dispatch, not an executing/interrupted attempt or a
  safety/access block.
- A downstream worker that finds missing upstream work calls
  `request_task_workflow_return` with a nonempty `reason`. This is only a request;
  it does not move the workflow. Step one cannot request a previous step.
- The parent authorizes it with `decision: "return"` and feedback, or denies it
  with `decision: "rework"` and instructions to the current worker. An authorized
  return moves back **exactly one step** and invalidates that step and all work
  downstream. Earlier approved steps remain approved. The affected steps must
  be resubmitted and reapproved; old attempts lose their transition authority.
- The parent can `decision: "abort"` at any active point, with a reason. This
  ends the workflow without approving it.

If a concrete external dependency prevents dispatch (for example, a missing
access grant or input from a person), call parent-only `defer_task_workflow_step`
with `workflowId`, the latest `revision`, and a nonempty `dependency`. This
records the dependency in the workflow/audit history without starting work or
approving anything. Explain who/what must unblock it. Mere readiness or forgetting
to dispatch is not an external dependency. Once resolved, explicitly run the
step with the latest revision; dispatch clears the recorded dependency.

After a successful parent request ends with reworked steps still ready and no
recorded dependency, the runtime sends **one** corrective continuation request
under the same parent's identity, tools and task. It asks the parent to re-read
state, dispatch normally, or record a concrete dependency. It never invokes a
worker, supplies retry authority, or approves output itself. If the parent still
leaves rework ready without a dependency, the turn reports an explicit
"Parent continuation stalled" error instead of silently completing. The task
stays waiting with a state-specific next action. There is no background retry
loop; failed/aborted requests, working/interrupted attempts, submitted output,
finished workflows and other tasks/channels are not continuation candidates.
The durable reminder receipt is keyed to the original parent request, not workflow
revisions or the pending workflow set. Redelivery after session/store restart
reuses that reminder and its result even if it dispatched, submitted and requested
rework again; it cannot renew the one-reminder budget. Unrelated history events,
such as editing a future step, do not hide current undispatched rework.
Recorded dependencies survive session/store restart. A genuinely new parent
follow-up request can recover previously undispatched rework with its own reminder;
restarting the harness alone does not launch work.

A parent cannot submit on behalf of an assigned subagent. A subagent cannot
start other steps, approve gates, authorize a return, inspect another workflow,
or keep submitting after its attempt has been superseded.

## Follow a run

Slack keeps one **top-level status card in the owning channel**, even when the
workflow starts in a thread. The card links back to the owning task conversation;
continue gate review there, not in a new thread under the card. It shows the
workflow ID, ordered steps, current step, awaiting-parent-review state and terminal
outcome, edited in place as work progresses. Task workflows have no separate name
field; step names identify the flow. DM cards remain replies in the owning thread
when there is one, showing structure/status without private step names.

Posting is best effort: Slack failures do not change execution or gate approval.
Restart reconciliation redraws active runs and existing tracked cards without
executing workflow work. Legacy channel-thread reply cards are replaced once by
a persisted channel card; the old reply is retired with a static notice (best
effort). Existing main-conversation cards are reused. Historical terminal runs
without a tracked card are not announced retroactively.

In the web console, open **Tasks → Workflow runs** in the owning channel, even
when it is not a software factory. Select a task workflow to open the shared
side panel: ordered stage statuses, persisted submission excerpts, and feedback.
“Submitted — awaiting parent review” is not approval. Pending stages say
“No results yet”; approved legacy stages without output say so explicitly.
Rework/return stages label retained output as a previous, unapproved submission.
Long results have Show all within a bounded 6,000-character excerpt; full output
and history remain available through `check_task_workflow` in the task
conversation. No extra model calls generate these summaries.

The console never opens a closed channel store. It shows existing stored runs
without backfilling results. Direct-message channels expose structure/status and
fixed activity explanations only, not stage names, outputs, feedback or diagnostic
free text. Gate decisions, corrections and explicit retry continue to use the
parent’s existing workflow tools; the panel does not grant approval authority.

With the operator's existing `webConsole.actions` switch enabled, task details offer:

- **Stop workflow**, with confirmation: atomically aborts the workflow and clears
  attempt capabilities. Further progression and late workflow submissions are
  refused, including after restart. The response distinguishes a cancellation
  request for a process-local live worker from no live worker found. Cancellation
  is best-effort: in-flight tools or old external work may still finish, and
  already-completed external effects are **not undone**. A parent-executed step
  does not have a separate worker to cancel; unrelated work in its conversation
  is not aborted.
- **Bump workflow**: requests an inspection in the owning conversation, queued
  behind its current turn if busy. It never directly starts or retries a step,
  changes attempt keys, or authorizes repeating external effects. The parent
  must inspect current state and ask before repeating potentially side-effecting
  work. Recovery-blocked/unavailable conversations return explicit feedback.

Both actions require the displayed workflow revision, the owning channel's open
store, and the same origin/header/body/rate-limit protections as existing console
actions. Concurrent changes refuse stale requests; the UI refreshes rather than
resubmitting automatically. As with other non-merge console actions, access is
operator opt-in, not a new Slack-user identity or permission grant.

**Current step activity** shows the latest recorded step/worker activity time,
process-local evidence of a live worker (possibly waiting on a model/tool), parent
review, interruption recovery, or an unknown cause. Old persisted `working`
state alone is **not** evidence of execution; elapsed time is labelled as elapsed,
not ongoing progress. A worker that returns without submitting, or throws,
retains a bounded diagnostic for inspection across restart. These diagnostic
updates are presentation-only and do not change execution revision/authority.

## Durability and interruption

Definitions and correction history, task/channel ownership, revisions, attempt
keys, full submissions, gate decisions, return reasons and feedback are stored
atomically in the owning
channel's Durable SQLite store, outside its tool workspace. Each step is a
logical subtask in that aggregate; it does not create an unrelated console task.
The owning task stays waiting while any workflow attached to it is active, even
on chat-only or read-only follow-up turns. If several workflows share a parent
task, it closes successfully only once all have final approval; if any was
aborted, it becomes abandoned once none remain active.
The audit history preserves invalidated/reworked submissions rather than
erasing them. Limits are 32,000 characters per directive/output/feedback, 2,000
per gate/evidence, and 1,000 history events (abort remains available at the limit).

Intent is committed **before** running a subagent. Workflow tools use the existing
unsafe-to-replay tool policy. If a run is interrupted, throws, or returns without
submitting/requesting return, its step remains `working`. The attempt's `runKey`
identifies its conversation/timeline. Read progress and inspect its effects;
do not assume it did nothing. Nothing is automatically rerun on restart.

After inspection, explicitly call `run_task_workflow_step` with `retry: true`
and the latest revision to supersede a working attempt, or abort the workflow.
Retry can repeat external side effects; the parent must decide deliberately.
A process-local live worker cannot be duplicated with `retry: true`; wait for it
to finish, inspect it, or stop the workflow.
The old attempt's workflow tools immediately become stale. A lost parent tool
result can be reconciled using `check_task_workflow`: committed submissions and
decisions are not applied a second time with the same revision.
