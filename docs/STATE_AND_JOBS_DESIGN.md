# Design: always-open stores, a shared state object, and durable jobs

Status: **design. Parts 0 (stores always open) and 1 (the state object) are built. Part 2 (jobs): spikes done; the job core (2a: `exec` and `state` phases) is built, see "As built"; `approve`, `agent` and agent-authored jobs are next.** Decisions already made are marked **Decided**. This replaces nothing: it builds on
[DURABLE_ARCHITECTURE.md](DURABLE_ARCHITECTURE.md) and [SUBAGENTS_DESIGN.md](SUBAGENTS_DESIGN.md).

Motivation: the Durable Pi walkthrough shows three things this harness does not do yet. A session is always there and
every client can look at it. An agent has one structured, shared state object it can read and update. And long work
runs as durable *jobs*, repeatable workflows with named phases that checkpoint, resume after a restart, and can wait for
a human. The harness already stores everything in pi-durable, so these are mostly a matter of using what is there
properly.

## What exists today

| Area | Today |
|---|---|
| Stores | `recoverAllChannels` (`slack/app.ts`) opens every channel store that already has a `durable/` directory at boot, so interrupted work recovers before the next message. A config reload retires **every** store (`runtimes.invalidateAll`) and each one reopens only on the channel's next message. A channel that was never used has no store. |
| State | pi-durable documents are used only for internal bookkeeping (`HostDoc`, `ThreadFamily`, `DeliveryFamily`, `RouteDoc`, `RequestDoc`). The agent has prose memory files (for recall) and nothing structured it can read, update and share across threads. |
| Tasks | The "tasks" in the console come from `TaskStatusStore` (`tasks/store.ts`), a JSON status log inferred from which tools ran. It is not tied to durable tasks. Scheduled work is croner plus `schedules.json` firing a plain agent turn; a restart abandons it. Subagent runs are driven by an in-process function and are abandoned on restart (`isEphemeral`). |
| pi-durable | Provides typed documents committed with the transcript (`defineDoc`, scope `session`), `defineTask` state machines with named phases and checkpoints, child tasks, `watchDoc` for a task to wait on a change, a task graph, and background tasks that survive a parent's abort. |

## Part 0: stores always open

**Decided:** open the store of every configured channel at startup.

### Why

- The web console can only read a store that is open in the running harness (it is exclusively locked by this process).
  A closed store is a "not live" channel with no threads or transcript.
- After a config reload every store is closed until the next message, so the console goes blind exactly when an operator
  is checking that the reload worked.
- A channel never used has no store, so nothing shows.

### Change

1. **Boot:** open a store for every channel that resolves as enabled: those known to the registry, those configured by
   Slack ID, and those that already have a `durable/` directory. This extends `recoverAllChannels`, which already does
   it for the last group. A channel configured only by name that has not been seen yet has no ID, so it cannot be opened
   and still appears in the console as configured-but-not-live.
2. **Reload:** after `invalidateAll`, reopen every channel in the background. `ChannelRuntimes.exclusive` already
   serializes retire and open per channel, and a store with active turns closes only when they finish, so the reopen
   simply waits for them. A reload still does not wait on a long turn.
3. **Failure:** a store that fails (`ended` with reason `failed`) is reopened once in the background instead of waiting
   for the next message. A repeated failure is logged and left for the next message, so a broken disk cannot spin.
4. Every open still runs the recovery gate, so nothing resumes unvalidated. A channel the gate pauses stays paused and
   reported (`!recovery`).
5. One log line at boot: how many stores opened, how long it took, how many were blocked.

### Cost and risk

- Memory per store is a SQLite handle and the registered tool schemas. Connectors are opened per thread session, not per
  store, so an idle store is light; boot already pays this for every used channel. The TODO's one-MCP-process-per-thread
  problem is separate and unchanged.
- Opening creates `data/channels/<id>/durable/` for configured channels that never had one.
- There is deliberately no switch to turn this off: boot already pays the cost for every channel that has been used, and a
  second code path for "lazy" would be one more thing to keep correct. If a small device proves it needs one, add it then.

### Tests

- A fixture with configured, seen, never-used and rejected channels: after `start()` the first three are open
  (`runtimes.peek`), the rejected one is not and is left untouched.
- A reload reopens them, including one that was mid-turn.
- A store that fails once is reopened; one that fails twice is not retried in a loop.

## Part 1: the state object

**Decided:** one object **per channel**, shared by `main`, every thread and every subagent run in it.

### Model

A pi-durable document, scope `session` (one per store, so one per channel; forks do not copy it):

```ts
{ rev: number; value: JsonValue; updatedAt: number; updatedBy: { threadKey?: string; userId?: string; source: "agent" | "job" | "operator" };
  changes: { rev: number; at: number; op: string; path: string; threadKey?: string }[] /* last 50 */ }
```

This is different from memory on purpose. Memory is prose the model recalls. State is structured working data that code
and jobs also read and write: cursors, counters, the last result of a job, a checklist.

### Operations

`DurableChannelStore.readState(path?)` and `updateState({ op, path, value?, expectedRev? })`, each one atomic commit.

- **ops:** `set`, `merge` (object into object), `delete`, `append` (to an array). `set` at the root path replaces
  everything.
- **paths:** JSON Pointer (RFC 6901). `__proto__`, `constructor` and `prototype` are rejected as keys.
- **compare-and-set:** an optional `expectedRev`. A mismatch fails with the current `rev`, so two threads cannot
  silently overwrite each other and a model can re-read and retry.
- **limits:** serialized value 64 KiB, depth 12, arrays 1,000 items, keys 128 characters, strings 16 KiB, plus the change
  log cap. Over a limit is a clear error, never a truncation.
- JSON only: no functions, no `undefined`, no non-finite numbers.

### Tools

`state_read({ path? })` and `state_update({ op, path, value?, expectedRev? })`, **always available** (decided in review): state is
session infrastructure like memory, not a capability a channel opts into, and jobs will depend on every channel having it.
There is no `state` entry in `tools`. A subagent gets `state_read` only, like `recall`. The tool description says what
state is for and how it differs from memory. Tool replay stays `unsafe` like every tool; an interrupted update is atomic,
so it either happened or did not, and the model is told which on recovery by reading `rev`.

### Console

A State tab (read-only) shows the live object as a tree, `rev`, who wrote it last, and the recent change log. It updates
through the event stream (a `state` event when a channel's `rev` changes). For a direct message the values are hidden and
only size and `rev` are shown, the same rule as the rest of the console.

### Tests

Path and limit validation, prototype-pollution keys, CAS conflict, persistence across a store reopen, two concurrent
updates from two threads, SIGKILL during an update (using the existing crash-child pattern), tool behavior, and console
API redaction for a DM.

## Part 2: durable jobs

### What a job is

A named, repeatable workflow with ordered **phases**. Each phase is a checkpoint: a restart resumes at the phase it was
in, never from the start. A run is a real pi-durable task, so the task graph, abort and recovery machinery apply.

**Decided phase kinds (v1):** `exec`, `agent`, `approve`, `state`.

| Kind | Does | Reuses |
|---|---|---|
| `exec` | Runs an allowed command, given as an argv array (no shell), with a timeout | The channel's `exec` policy (which CLIs, env, limits), the sandbox and jail |
| `agent` | Runs a subagent role with a prompt template; its report is the phase result | The subagent runner, role tools, `requireApproval` gate, concurrency cap |
| `approve` | Posts a Slack approval card with Approve and Decline, waits durably for a human | The Slack button flow and the permission authority used for grants |
| `state` | Writes a value, or an earlier phase's result, into the state object | Part 1 |

Templating is minimal string substitution: `${input.name}`, `${phases.<name>.result}`, `${state:/pointer}`. There is no
expression evaluation. Inputs are typed strings with length caps and no NUL. Because `exec` takes an argv array, a
substituted value can never become a second command.

### Definition

```yaml
jobs:
  release-check:
    description: Review the release candidate and publish notes
    input: { branch: { type: string, default: main } }
    phases:
      - { name: plan,    kind: exec,    argv: [git, log, --oneline, "${input.branch}"] }
      - { name: gather,  kind: agent,   role: reviewer, prompt: "Review these commits: ${phases.plan.result}" }
      - { name: approve, kind: approve, message: "Publish these notes?", onDeny: abort }
      - { name: publish, kind: state,   path: /releases/latest, value: "${phases.gather.result}" }
```

Limits: 20 phases, 20 definitions per channel, run history retained per channel.

### Run semantics

- The run is a task owned by the channel's main conversation as a **background** task, so a thread abort or `!stop` does
  not kill it; `job_abort` does.
- The definition is **snapshotted into the run and pinned by hash** at start, so editing a job mid-run cannot change a
  run in flight.
- Each phase: commit "starting phase N" → do the work → commit the result and advance. Results are bounded (4 KiB of
  text; exec output is truncated and says so).
- **Interrupted effect rule, the same as tools:** a phase that was `running` when the process died is never silently
  repeated. For `exec` and `agent` the run waits in `needs_decision` and reports it; a human or the agent chooses `retry`,
  `skip` or `abort` (`job_decide`). `state` and `approve` are idempotent and resume by themselves (an approval reuses the
  stored Slack message).
- **Recovery gate first.** After a restart a run resumes only after the gate re-validates it under current rules: the
  channel still has jobs enabled, the job is still allowed, every remaining phase is still permitted (the `exec` policy
  still allows the CLI, the role still exists and is still allowed). Otherwise the run is blocked with a reason, like a
  blocked thread.
- **Approvals** wait on a document the Slack button handler writes. A task watches it with `watchDoc`, so there is no polling;
  confirmed by the spikes, including across a restart.

### Tools

`list_jobs`, `run_job({ name, input })`, `check_job({ runId? })`, `job_decide({ runId, decision })`, `job_abort({ runId })`,
and `propose_job` (below).

### Agent-authored jobs

**Decided:** agents can propose new jobs, not only operators. This is a new way for an agent to widen what it does
unattended, so it is gated hard:

1. **The agent can only propose.** `propose_job` validates the definition against the same static policy a run uses
   (allowed phase kinds, `exec` argv within this channel's exec policy, roles that exist for this channel, size limits)
   and stores a *proposal*. It does nothing else.
2. **A human approves the exact definition.** The proposal is posted as an approval card in the channel showing every
   phase in full (commands, roles, prompts) and its hash. The Approve button works only for users who may already approve
   grants in this channel. The agent cannot approve its own proposal, and a message the agent writes can never act as a
   click.
3. **Approval pins the hash.** The approved definition is saved with `source: agent`, the approver and the time. Any
   edit is a new proposal and needs a new approval; the old version stays active until then. A config-defined job with the
   same name always wins; an agent cannot shadow or override an operator's job.
4. **Capability ceiling.** A job can never do more than the channel could already do interactively, and this is checked
   again at run time, not only at approval. If the channel later loses a permission, the next run is blocked.
5. **No scheduling in v1.** Jobs run on request. Letting a schedule trigger a job (the "proactive" runs in the video) is
   a later step and needs its own approval, because it is the point where a job runs with nobody watching.
6. **Audit.** Proposals, approvals, denials, runs, decisions and aborts go to `shared/audit/jobs.jsonl`, like skill
   writes. Prompts and commands are recorded; secrets are not (they are never in a definition, only by name in the env).

### Console and status

- Tasks tab: job runs with their phases as a strip (done, running, waiting, needs decision), plus pending proposals.
- Extend tab: job definitions with source (config or agent), hash and approver.
- Each run also writes a `TaskStatusStore` record (new kind `job`) so `/api/status` and the console show it.
  Statuses map: running → `in_progress`, approve or `needs_decision` → `waiting`/`blocked`, then the terminal ones.

### Spike results

The four risks were each tested before any job code was written. The first two are pinned by
`src/agent/durable/tasks-characterization.test.ts` (8 tests, including a real SIGKILL), so an upgrade of pi-durable that changes
them fails there. Two of them change the design above, and the changes are folded in here.

| Question | Result |
|---|---|
| Can a task kind be registered in a store's registry, and does it survive a restart? | Yes. `defineExtension({ tasks })`, created with `tx.createTask(Task, input, { ownership: { kind: "conversation" }, conversationId, background: true })`. A graceful close and a SIGKILL both leave it to resume. |
| What does a restart do to a task mid-phase? | **It replays the phase it was in, and no earlier one.** A phase that wrote its effect but had not yet committed its checkpoint runs again. So a phase is at-least-once, never exactly-once. |
| Can a task wait for a person, durably? | Yes. The phase creates an approval document, then `watchDoc`s it; whoever handles the Slack button writes the decision into it. It survives a restart (the phase is re-entered and waits again), and a decision made while the harness was down is found immediately on restart, with no wait. A declined approval ends the task through its own phase as an `aborted` outcome. |
| Can a job abort from outside? | Yes. `harness.abortTask(id)` marks it, the task's `abort` handler runs, and it ends `aborted`. |
| Can the `agent` phase use the subagent runner without a Slack thread? | Yes. `createSubagentRunner` needs the channel, a thread key, a speaker and identity fields, and treats progress and timeline as optional. A job gives it a **synthetic parent** built from the same base session options a dream or scheduled run uses, with `threadKey: "job-<run id>"` and no progress sink. The runner's concurrency cap, role narrowing and `requireApproval` gate all still apply. |
| Will the recovery gate understand a job? | **No, and this is a real problem.** A job task is owned by a conversation (`main`), so `liveRoutes()` reports `main` as having live work (the last spike test shows `inspect()` doing exactly that). `main` has no Slack thread, so by reading `recoverChannel` the gate would block the whole channel with "the conversation has no recorded Slack thread". That last step is from reading the gate, not a test, because the store cannot hold jobs yet; the first job test pins it. |

Design changes from the spikes:

1. **Jobs are kept out of conversation recovery.** Job tasks use a task kind with a `slack.job` prefix. `liveRoutes()` ignores
   them, a new `liveJobs()` lists them, and `recoverChannel` gets a separate job step that runs **before** the scheduler is
   resumed (resuming starts every ready task in the store, jobs included). That step validates each live job against current
   rules, and aborts or blocks the ones that fail. A job can never be resumed unvalidated.
2. **Every side-effecting phase checkpoints twice.** Because a phase is replayed after a crash, `exec` and `agent` phases
   first commit "starting phase N, attempt k", then do the work, then commit the result. A phase that is entered and finds
   "starting" already recorded was interrupted, so it never repeats the effect: the run goes to `needs_decision`
   (retry, skip or abort). `state` and `approve` phases are idempotent and simply run again.

Still to confirm while building: the cost of re-registering the job task kind when a store reopens after a config reload (the
registry is per store, so it should be as cheap as the tools'), and that `background: true` keeps `!stop` from aborting a job
without hiding it from `inspect()`.

### As built: the job core (part 2a)

Where the build refined the design above:

- **Definitions are per channel and never inherited.** `jobs` is a key of a channel's own entry; `defaults.jobs` is refused with a
  message (the way `share.sharedTools` is never merged): that a channel may run something unattended is a decision about that
  channel. An `exec` phase names a command from the channel's own `exec.commands` (`command: git`, `args: [...]`) rather than
  giving a raw argv, so the channel's existing allowlist, timeout and output limits apply unchanged, and the channel must have the
  `exec` tool on (the ceiling).
- **Run state is two documents plus a task.** `slack.job-run` (the record the console and tools read: pinned definition and hash, input,
  per-phase status and summary, results) and `slack.job-decision` (what a person decided about an interrupted phase), both
  session-scoped; the task's own checkpoint is only `{ phase, index, started }`.
- **`state` phases reuse the exact state code.** `applyStateUpdate` was extracted so a job's write and an agent's write are the same
  atomic, checked commit; the write, the phase marked done and the advance are one commit.
- **A run the gate will not allow is aborted, not blocked.** The design said "blocked with a reason like a blocked thread". A blocked
  job would need its own unblock mechanism, and a run that is no longer permitted should not be resumable by anyone. So the gate
  aborts it with the reason in the run record; the operator re-runs it once the config is right.
- **Mutation-tested.** Removing the `liveRoutes` job filter makes the gate log "recovery blocked ... no recorded Slack thread" and fail
  five tests, which confirms the spike's reading of the gate.
- **Run retention is not bounded yet.** Run records are small and kept; a retention policy belongs with the rest of the TODO's
  state-growth item.
- **Deferred from the 2a list:** the `TaskStatusStore` mirror (runs appear in the console's Tasks tab but not yet in `/api/status`),
  and the retry/skip/abort decision by Slack button (today the agent applies a person's answer with `job_decide`; the buttons arrive
  with the `approve` phase, which needs the same approval card).

### Tests

Definition validation and policy rejection; templating (no injection through inputs); a run end to end with a faux model;
SIGKILL in each phase kind (`needs_decision` vs automatic resume); approve then deny; gate blocking when the policy
changed; abort; one proposal approved by a human, one denied, a self-approval attempt refused, an edit needing
re-approval, a name collision with a config job; console API and a browser test for the phase strip.

## Order of work

| Step | Content | Notes |
|---|---|---|
| 1 | Part 0: stores always open | Small, and makes every later console view live. |
| 2 | Part 1: state object, tools, console State tab | Self-contained and useful alone. |
| 3 | Part 2a: jobs core with `state` and `exec` phases, tools, recovery, console | The spikes above happen first. |
| 4 | Part 2b: `approve` and `agent` phases | Needs the approval and subagent spikes. |
| 5 | Part 2c: agent-authored jobs | Last, on top of an already-trusted runner. |

Each step is its own PR with its own tests, README section and console changes.

## Not in scope

Controls in the console (interrupt, send, reset), account-wide shared state across channels, schedule-triggered jobs, and
a session-service refactor of `slack/app.ts`. Each is a possible follow-up.
