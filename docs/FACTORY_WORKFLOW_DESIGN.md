# Software factory workflow runs

Status: agreed design (decisions in section 9). Implementation is staged as in section 8: the spike and the engine (section 11) are built; the service and tools, the Slack status post, the console and revert are not. It builds on the durable task machinery that jobs use (`docs/STATE_AND_JOBS_DESIGN.md`).

## 1. The gap

A software-factory channel already has the parts of a pipeline: dedicated roles (`github_triage`, `coder`, `reviewer`, `cloudflare_deployer`), a hand-off contract (each report ends `STATUS:`, `NEXT:`, and for review `VERDICT:`), a pipeline skill describing the order, and a timeline that draws each run as a branch. What it does not have is **the issue as a durable thing**.

Today the channel agent (an LLM) holds the pipeline in its head. So:

- Where issue #7 is (in review, round 2) lives only in the conversation. A compaction, a restart or a lapse of attention loses it, and the console cannot show it.
- The order is prose. Nothing stops a skipped review or an endless coder/reviewer loop.
- A role in flight at a restart is interrupted and nothing resumes the issue at the right step.
- "Rejected", "waiting for a human" and "deployed" are not recorded states.

## 2. The idea

One **workflow run** per issue, executed as one durable task, walking a **state machine** whose stages are each handled by a dedicated sub-agent. The task, not an LLM, knows where the run is. The channel agent starts runs, reports on them and relays human decisions.

```
                 ┌────────────── CHANGES_REQUESTED (round < max) ──────────────┐
                 ▼                                                              │
 triage ──READY──▶ implement ──done──▶ review ──APPROVED + RISK n──▶ merge ──▶ deploy ──▶ completed
   │                  │                  │                         risk ≤ limit: automatic   (skipped if
   ├─NEEDS_INFO──▶ rejected              │                         risk > limit: waits for     no deployer)
   ├─REJECT────────▶ rejected            │                         an approver
   │                  blocked/failed ──▶ failed
   │                                     └─rounds exhausted──▶ waiting (a person: one more round, or stop)
```

The reviewer also scores the change's **risk from 1 (trivial) to 5 (dangerous)**. Each factory (and each repository in it) sets the risk at or under which the merge is automatic; above it, the run waits for an approver. Out of the box nothing merges by itself.

The state machine is **hard coded for the software factory** in v1 but written as data (section 4), so custom workflows later are a schema and a loader, not a rewrite.

## 3. Statuses

Every stage has one of five statuses, always:

| Status | Meaning |
| --- | --- |
| `not_started` | The run has not reached it yet, or a loop sent the run back past it (its earlier attempts stay in the history) |
| `in_progress` | Its sub-agent is running, or (for the merge gate) it is waiting for an approver |
| `success` | It finished and its verdict allowed the run to move on |
| `failed` | It finished badly: the sub-agent failed, timed out, was blocked, or returned a report that did not follow the contract |
| `skipped` | It did not apply: the deploy stage with no deployer configured, or a stage a person chose to skip after a restart |

A **run** has its own status: `running`, `waiting` (for a human: the merge gate, or a review that ran out of rounds), `needs_decision` (a stage was interrupted by a restart and may have had effects), `completed`, `rejected` (the pipeline decided not to proceed: needs info, duplicate, won't fix), `failed` (something broke, or review rounds ran out) and `aborted` (a person stopped it). `rejected` and `failed` are deliberately different: the first is a valid outcome, the second needs someone's attention.

A stage that is re-entered (review sends the run back to implement) gets a new **attempt**; the stage shows the latest attempt's status, and every attempt is kept: round number, role, sub-agent run key, verdict, a bounded summary, duration, cost.

## 4. The definition (hard coded, as data)

```ts
type StageKind = "agent" | "gate";
interface Stage {
  name: string;                       // triage, implement, review, merge, deploy
  kind: StageKind;
  role?: string;                      // the sub-agent for an agent stage; a gate has none
  /** Where each verdict leads: another stage, or an end. */
  on: Record<string, string | "complete" | "reject" | "fail">;
  /** Loop guard: how many times this stage may be entered in one run. */
  maxEntries?: number;
  /** An optional stage is `skipped` when its role is not assigned to the channel. */
  optional?: boolean;
  /** May the engine run it again by itself after a restart interrupted it? Read-only roles yes, the coder no. */
  replaySafe: boolean;
}
```

v1 constant `SOFTWARE_FACTORY_WORKFLOW`: triage (`READY`→implement, `NEEDS_INFO`/`REJECT`→reject), implement (`done`→review, `blocked`→fail), review (`APPROVED`→merge, `CHANGES_REQUESTED`→implement, `maxEntries` 3 then the run goes `waiting` so a person can allow another round or stop it), merge (a gate: `merged`→deploy, `declined`→reject, `failed`→fail), deploy (optional: `done`→complete, `failed`→fail).

The engine only applies transitions the definition allows. A verdict the stage has no arrow for is a `failed` stage, not a guess.

## 5. The engine

- **One durable task per run**, kind `slack.factory-run`, owned by the channel's main conversation like a job run, excluded from the live-route recovery checks the same way (`isJobTaskKind` gets a sibling). It reuses the job run's patterns: a session-scoped document family holds everything people read (`slack.factory-run`), the task checkpoint holds only where it is.
- **Run document**: run id; issue (`owner/repo#n`, title, URL); the definition version; status and reason; `stages[]` (name, status, attempts[]); current stage and round; PR URL once a report names one; who started it and from which thread; timestamps; total cost. Bounded, plain JSON, no tool arguments or results.
- **A stage is two commits**, the same rule as exec phases: commit `started` (with the sub-agent run key) before spawning, commit the parsed report after. Finding `started` on re-entry means the sub-agent may have acted:
  - `replaySafe` stages (triage, review: read-only roles) are re-run automatically.
  - Others (implement, deploy) set the run `needs_decision`: retry, skip or abort, answered by a person through the channel agent, exactly like `job_decide`.
- **The merge gate** decides from the factory's merge rules (next section) whether the change merges by itself or waits for a person, then performs the merge. While it waits the run is `waiting` and the task parks until `factory_approve` or `factory_decline` writes a decision document, or until the pull request is merged or closed on GitHub by someone else (polled while waiting), which counts as the decision. The merge is `gh pr merge` with the channel's own credentials, so GitHub's branch protection and required checks remain the final authority: if GitHub refuses, the stage fails with its message.
- **Reports are parsed strictly.** The existing contract (`STATUS`, `NEXT`, `VERDICT`, `READY`) is the input. `NEXT` is cross-checked against the arrow taken and logged if they disagree; the definition wins. A report that does not parse fails the stage after one automatic retry by re-asking the same sub-agent to restate its verdict.
- **Each stage's brief is built from the run document alone**: the issue, the PR, and the previous stage's report (for a loop, the reviewer's findings). Not from the channel conversation, so a restart or a compaction cannot change what a role is told.
- **Limits**: `MAX_LIVE_RUNS` per channel (3, like jobs), one live run per issue (starting a second for the same issue is refused and points at the first), the stage timeout is the sub-agent's own, and the run has an overall ceiling.
- **Audit**: `shared/audit/factory-runs.jsonl` records who started, approved, declined, decided or aborted what.

### The risk to settle first

Sub-agents are launched today by `run_subagent` from a **live parent session** (`SubagentRunner` takes the parent's thread key, timeline, progress sink and tool context). A background task has no such parent. The first piece of work is a spike that runs a sub-agent from a durable task with a synthetic parent (the run's own thread key, the channel timeline, no progress sink) and proves it: the role gets its tools, the run appears on the timeline and in the console tree, a restart mid-run is recoverable, and the result is read from the store rather than from a returned promise. If that needs changes to the runner, they are small and go in their own PR before the engine.

## 5b. Merge rules and risk

Rules live on the factory config, with an optional per-repository override. They are config, so they are edited by a person and are refused to the admin channel's config tools like `jobs` is.

```jsonc
"factory": {
  "name": "Acme",
  "repositories": ["acme/web", "acme/api"],
  "merge": {
    "approvers": ["U123", "U456"],      // Slack users who may approve or decline. Default: the channel's allowed users
    "autoMergeMaxRisk": 0,              // 0 = never automatic (the default); 1..4 = merge by itself at or under this score
    "method": "squash",                 // squash | merge | rebase
    "sensitivePaths": ["infra/**", "**/migrations/**", ".github/**"]
  },
  "repositoryRules": { "acme/api": { "autoMergeMaxRisk": 1 } }
}
```

- **The score.** The reviewer's report gains `RISK: <1-5>` and `RISK_REASON: <one line>`, scored against a rubric in the role's instructions (1 comment or docs only; 2 small, tested, contained; 3 behaviour change in one area; 4 touches shared code, data shape, auth or many areas; 5 migration, security, billing, infra or irreversible). A missing or out-of-range score is treated as 5.
- **The score is advisory input, not the authority.** A model's judgement of its own review must not be what lets code into main. The engine only ever *raises* it: any changed path matching `sensitivePaths` makes the score at least 4, and a diff over a size limit at least 3. Both the model's score and the final one are stored on the run.
- **Automatic merge requires all of:** the reviewer's `APPROVED`, final risk at or under `autoMergeMaxRisk`, the pull request head still being the commit the reviewer reviewed (a push after review sends it back to review), and GitHub reporting at least one required check, all green (no required checks means a person merges). Anything else waits for an approver, with the reason shown.
- **Approving.** Only users in `approvers` can approve or decline; the tool checks the speaking user, not the channel agent's say-so. An approval records who and when, and is also bound to the reviewed head commit.
- **Everything is audited**, including automatic merges, with the final score, the model's score and why any floor applied.

## 6. How people and the channel agent use it

- **Start**: the channel agent calls `start_factory_run({ issue })` when someone asks it to work an issue ("work through #7"). The issue is validated against `factory.repositories` and read with `gh` to confirm it exists and is open. A later version can poll for issues carrying a status label, or take a webhook.
- **Follow**: `check_factory_run` (one run or recent runs); a person is told when a run needs them (waiting, needs_decision, rejected, failed, completed) in the run's own Slack thread (section 6b).
- **Act**: `factory_approve`, `factory_decline`, `factory_more_rounds` (when review ran out of rounds), `factory_decide` (retry/skip/abort), `factory_abort`. The agent uses them only on a person's say-so, with the same warning wording as the job tools.
- The `factory-pipeline` skill shrinks from "here is the sequence, walk it" to "start the run, report what the run reports, relay decisions". The roles and the hand-off contract stay.

## 6b. Slack presence: a status post and a run thread

Each run gets its own place in Slack, so nobody has to ask the channel agent where it is.

- **The status post.** Starting a run posts one top-level message in the factory channel, and the harness **edits that message in place** (`chat.update`) as the run moves: the issue, a line of stage markers (`✅ triage → ✅ implement → 🔄 review (round 2) → ⬜ merge → ⬜ deploy`), the run status, the risk score once review has scored it, the PR link, elapsed time and cost. It is an artifact of the run, **not a message in any agent conversation**: it is written by the engine, the channel agent never sees it as input, and the engine ignores edits and reactions on it. Its timestamp is kept on the run document; if the post was deleted or the edit fails, the next update posts a fresh one and records that.
- **The run thread.** The status post is the root of a Slack thread. The engine posts a short reply there only at moments that matter: a stage finished with its verdict and a one-line summary, a loop back with the reviewer's findings, the run `waiting` (with who can answer and why), `needs_decision`, and the end state. Not tool calls and not progress chatter: that stays on the console and the timeline.
- **Steering from the thread.** A message in the run thread starts an ordinary assistant thread in the channel (the same mechanism as any thread) but bound to that run: the channel agent is told which run it is, given its current state, and its run tools default to it. So "approve it", "one more round", "skip deploy", "why did review fail?" and "stop" all work where the run is. Approvals still check the speaking Slack user against the factory's `approvers`, not the agent's say-so, and a thread message from anyone else cannot approve.
- **Buttons.** When the run is `waiting`, the status post carries Approve / Request changes / Decline at merge approval, Approve / Decline at deploy approval, and "One more round" / "Stop" for exhausted rounds. The click is checked against `approvers`, bound to the reviewed commit, and the post is edited to show who decided. Request changes opens a cancellable feedback modal. Submission rechecks the clicker's current permissions, original wait and status post; the store atomically binds feedback to the wait and reviewed head and refuses a competing decision. The task independently checks the decider and feedback, records it in the merge attempt's report, and returns the same PR to implementation using the existing review-round guard. Reviewed head, risk, merge consent and deploy consent are cleared. The coder receives the feedback and must update the existing branch; fresh independent review and applicable merge authorization follow. New runs pin v5's changes_requested → implement arrow. Older pins support this explicit manual control through their existing review → implement → review route without rewriting the stored definition; automatic conflict handling of older pins is unchanged.
- **Quiet by default for tooling, loud for people.** Edits do not notify. Only the thread replies at the moments above can, and only a run that needs a person mentions the approvers.
- **Slack limits.** `chat.update` is rate limited, so updates are coalesced: at most one edit every few seconds per run, always the latest state, and a final edit on any terminal state. A burst of stage changes is one edit, not several.
- **Config.** `factory.announce` (default on) controls the status post. Off, the engine still keeps the run and the console, and replies in the thread the run was started from instead.
- **A run started elsewhere.** A run started in a thread by asking the channel agent still gets its own status post; the agent's reply links to it, so the thread that asked is not cluttered.

This replaces the "notify the thread that started it" question in section 6: the run owns its thread.

## 7. The console

Workflow runs go in the **Tasks tab**, as a "Workflow runs" section next to Jobs, rather than a seventh tab (the tab bar is already full at six).

- **List**: one row per run. Issue (`repo#7` and title), a row of five stage pips coloured by status, the run's status badge, the risk score once review has scored it, the round, elapsed time and cost. Waiting and needs_decision runs sort first.
- **Detail**: clicking a row opens a side sheet (full width on a phone). A vertical stage timeline: each stage with its status icon, role, and every attempt (round, duration, cost, verdict, a bounded summary), a link to the sub-agent's run in the conversation tree, the PR link, and, when the run is waiting, a line saying what it is waiting for and who can answer. The console stays read-only: decisions are made through the channel agent. The merge stage shows the risk (the model's score, the final one, and any floor that raised it), the merge rule that applied, and who may approve.
- **Live**: a `workflow` event on the existing event stream updates rows and an open sheet.
- **Privacy**: the same rule as everywhere. In a direct message the structure (stages, statuses, durations, cost) shows, and summaries, issue titles and reasons do not.
- **API**: `/console2/api/v1/channels/:id/workflows` (list) and `/workflows/:runId` (one run with attempts).

## 8. Order of work

1. **Spike**: a sub-agent run from a durable task (section 5), with tests. Small PR if the runner needs adjusting.
2. **Definition and engine**: the hard-coded workflow as data, the run document, the task, with faux sub-agents: the happy path, a review loop, the round cap, reject, a restart in a replay-safe and in a non-replay-safe stage, abort, a report that does not parse.
3. **Service, tools and audit**; the Slack status post, run thread and buttons (section 6b); recovery gate and `liveRoutes` integration; config/edit-policy guards as for jobs; the skill and prompt change.
4. **Console**: API, events, the Tasks-tab section and the sheet, mock fixtures, unit and browser tests.
5. **Revert**: `factory_revert` for an automatic merge that was wrong (decision 5).
6. **Later**: custom workflow definitions in config (the type in section 4 plus validation), issue polling or webhooks, more than one approver rule, run retention.

## 9. Decisions

1. **Who may merge or approve** is set by each factory, and each repository can override it (section 5b): an `approvers` list, an auto-merge risk limit and the merge method. Default: the channel's allowed users may approve, and nothing merges automatically.
2. **Deploy is in v1.** It is in the definition and is `skipped` unless the `cloudflare_deployer` role is assigned to the channel; it runs after the merge, behind the same gate.
3. **Review rounds exhausted**: the run goes `waiting`, and a person can allow another round (`factory_more_rounds`) or stop it.

4. **No required checks means a human merges.** Automatic merge needs GitHub to report at least one required check, all green. A repository with none always waits for an approver, whatever `autoMergeMaxRisk` says.
5. **A bad automatic merge gets a revert pull request.** If the merge was automatic and a person (or a failing deploy) says it was wrong, `factory_revert` opens a revert PR from the merge commit and starts a new run for it, which goes through the same review and gate. The harness does not force-push or revert on its own. This is built after the first version of the engine (section 8, step 5).

## 11. What the engine does, and where it differs from the sections above

Built in `src/factory/workflow/` (definition, report contract, run document, merge rules, the durable task) and `DurableChannelStore` (`startFactoryRun`, `factoryRun`, `listFactoryRuns`, `decideFactoryRun`, `abortFactoryRun`, admission). Not built: the tools and service (`start_factory_run` and the rest), the Slack status post and thread, the console, `factory_revert`, polling for issues.

Differences and things the build showed:

- **Loop guards apply at both ends.** A stage with `maxEntries` holds the run back when it would send the run to an earlier stage once it has been entered that many times, and also when anything would enter it again past that many entries (the merge gate sending a moved pull request back to review). Both end in the same wait for a person (`rounds`).
- **The headless runner bypasses a role's `requireApproval`.** That check lives in the `run_subagent` tool, which a task does not use. The engine therefore enforces it: a deployer role that needs approval does not start until a person has approved it (their approval of the merge counts; an automatic merge does not, so the run waits at `deploy`).
- **A missing `RISK:` is 5, as designed, not a failure.** A missing `VERDICT:` (triage, review) or a coder report with no pull request URL in the run's repository is asked for once more, then fails the stage. A pull request URL in any other repository is ignored.
- **A re-ask is a new run of the role**, with its previous report in the brief, not another message in the old conversation: the runner tears a conversation down when it finishes.
- **`deployEnvironment` is a merge rule.** The design had nowhere to say which environment the deployer deploys to.
- **The task re-checks who may decide.** `decideFactoryRun` only checks that the run is waiting for a decision of that kind; the task checks the user against the approvers and ignores (with a note on the run) a decision from anyone else, so a caller that forgot to check cannot approve a merge.
- **pi-durable does not re-enter a phase when a commit leaves the checkpoint unchanged.** Resuming a stage after a decision therefore stamps the checkpoint (`resumed`). Worth knowing for the next phase that waits on a person.
- **A stage entered by a loop is `in_progress` from the moment the run arrives**, before its role starts, so the console never shows a gap between stages.

## 12. Where the service and tools differed from the design

- **Aborting and `factory_decide` need an approver too.** The design listed approve, decline and more rounds as the approver-checked ones. Stopping someone else's run, or answering for an interrupted stage, is the same kind of decision, so the service applies the same speaker check to every decision tool, and the task re-checks it for the waits it parks on.
- **Declining a run that is out of review rounds is stopping it.** There is no separate "stop" tool: `factory_decline` on a run waiting on `rounds` records `stop`.
- **A run is only offered the tools when the channel has the roles.** Not just the `factory` config: a team without `github_triage`, `coder` or `reviewer` gets no run tools and the prompt and `factory-pipeline` skill say the agent walks the pipeline itself (the old behaviour), because a run could not complete.
- **The service says why before the store refuses.** It reads the issue (open, in a configured repository) and checks the one-run-per-issue and three-live-runs limits first, so a person gets a plain answer; the store still enforces them atomically.
- **Recovery asks the factory.** After a restart a live run whose factory was removed, whose required role was unassigned, or whose repository is no longer listed is aborted with the reason rather than failing closed forever.
- **Not built here, as planned:** the Slack status post, thread and buttons (section 6b), the console views, `factory_revert`, issue polling. `ChannelRuntimes` takes an `onFactoryRunChange` hook for the first two to hang off; nothing uses it yet.

## 13. Where the Slack presence differed from the design

Built in `src/slack/factory-render.ts` (the post and replies as pure functions of the run), `factory-presence.ts` (when to post, edit and reply), `factory-clicks.ts` (the buttons) and `app.ts`.

- **The run thread is a normal thread of the app.** Section 6b imagined binding a thread to the run. The app already treats a thread it has a session directory for as one it answers in, and ignores every message with a `bot_id`. So the status post's thread is marked active when it is posted, and a person's reply reaches the agent like any other; the engine's own posts and edits can never loop back, because they are the bot's. What is new is only the run context put in front of the message and the service finding "this run" from the thread.
- **Review sending the run back is one reply, not two.** The finished-stage reply for review carries the loop-back wording and the findings when the verdict is `CHANGES_REQUESTED`.
- **A stage asked again counts once.** Only the last attempt of an entry is a "stage finished" moment; the first, which lacked a verdict, is not.
- **What was said is kept on the run, written by the presence, not the task.** A `slack` part on the run document (the post's channel and timestamp, how many posts the run has had, the keys of the replies said, and a button decision not yet acted on). Runs recorded before it existed load with an empty one. It is at-least-once: a crash between posting a reply and recording it says it again after a restart, which seemed better than a person missing the wait.
- **A button carries the run, the kind of wait and when it began** (`fr_x|merge|1700000000000`), nothing else. A stale button, a post that was replaced and a double click are told apart from that and from a claim on the run; the commit is read from the run by the service.
- **Anything untrusted is plain text.** Issue titles, summaries and reasons only appear in the header block or `plain_text` blocks, never in mrkdwn, and the notification text is the harness's own words. A link is only drawn for github.com.
- **After a restart a post is redrawn once** (the presence does not remember what it last drew), but never reposted.
- **`start_factory_run` makes the post itself**, before the task has run a phase, so the link can be in the tool's answer; the run's first change finds it already there.
- **Not built:** a "Retry/Skip/Abort" button set for `needs_decision` (the thread says to answer in words), and `factory_revert`.

## 14. Where issue creation differed from the design

Issue creation was not in the original design; it was asked for afterwards ("an issue that was created elsewhere"). What was built, and the choices made:

- **`factory.issues`** (`create`, `labels`, `maxPerHour`, `requireApproval`), off by default, and refused to the admin channel's configuration tools like the merge rules. `requireApproval` is refused at configuration time with a message: reusing the existing approval flow would need a held-action store and buttons for a filing, which is its own piece of work, and a setting that is accepted but ignored would be worse than none.
- **The tool is only offered when filing is on** (and the workflow's roles are present), and the prompt says plainly when it is not, so the agent does not try and the person is asked to file the issue.
- **Limit and repeat detection read the factory audit file**, not a new store. It survives a restart, it is what an operator already reads, and the process also remembers what it filed itself so an audit line that could not be written does not reset the limit. Creation is serialised per channel so two requests together cannot both pass the check.
- **Sanitising is deliberate and narrow** (`src/factory/workflow/issue-text.ts`): it neutralises what would act on its own once on GitHub (mentions, closing keywords, HTML, remote images, hidden characters) and bounds length. It does not try to detect "instructions" in the text; that is the agent's job, and the tool's description says so.
- **Public provenance is privacy-safe by default.** The footer discloses agent authorship and that a person has not reviewed the request, but includes no Slack user/channel IDs, thread timestamps or permalinks, even in hidden HTML comments. Source attribution remains in the channel's private `shared/audit/factory-runs.jsonl` (`issue_created` entries with `channelId`, `userId`, `threadKey` and the issue reference), and run starter attribution remains in the private workflow store. The disclosure phrase and metadata-only filing marker stay stable for intake; deduplication still reads the local audit. See [legacy provenance redaction](factory-provenance-privacy.md) for existing issues.
- **The body goes to `gh` on standard input** (`--body-file -`), never on the command line, with labels from configuration as separate arguments. The new issue is read back from the URL `gh` prints and checked to be in the requested repository.
- **Delegation composes without change.** A delegated turn is an ordinary first turn in a thread the harness opens in the target channel, as the requester, so the run belongs to them and approvals are checked against them. The test drives the factory side of that (the delegation prompt, the turn, the run) and the outcome report; the Slack calls inside `HarnessApp.transfer` itself (the target's permission and requirement checks, the seed post) cannot be built in a test, because the app's constructor starts a Slack call, and are untested here.
- **Not built:** polling or webhooks for issues filed elsewhere, Linear or Jira as an issue source, and the approval-per-filing setting above.

## 15. Issue intake

Runs used to start only when someone asked. With intake on, the harness watches the factory's GitHub repositories and **keeps every open issue mapped to a run**: a new issue gets a run, a changed issue sends its changes to its run, a closed issue ends its run. Slack, Jira and Linear later all become ways of putting something into the tracker; the tracker is the source of truth. Webhooks are out for now (polling only).

### 15.1 The mapping

Per channel and repository, the engine keeps `issue number -> { runId, intakeStatus, lastUpdatedAt, commentWatermark, ... }` in an **engine-owned, session-scoped document** in the channel's durable store (`slack.factory-intake`), written only by the intake code and the store's methods. It is deliberately **not** the channel's state object (`state_read` / `state_update`): the agent can write that, so a prompt-injected agent could edit the mapping and make the harness start, skip or abort runs. The agent has no tool that writes the mapping; it can only ask for a release (15.3), which the service checks against the factory's approvers.

`intakeStatus` is one of `open` (mapped to a run), `queued` (eligible, waiting for a free slot), `held` (not trusted, waiting for a person), `ignored` (not for the factory: older than intake, an ignore label, locked) and `closed`. The rules, each poll:

| The issue is | And | The harness |
| --- | --- | --- |
| open | unmapped | applies the trust, queue and cap rules (15.2, 15.3), then starts a run |
| open | mapped | delivers what changed to the run (15.4) |
| closed | mapped | checks the associated PR on GitHub before cancellation; an observed merge resolves pre-merge runs as completed, otherwise live unresolved work is aborted with reason `issue_closed`; already recorded merges and deployment work are left alone |
| closed | unmapped | nothing: it is never recorded |
| reopened | mapping `closed` | starts a **new** run, repoints the mapping at it, and keeps the old run for history |

A manual `start_factory_run`, and a run a person asked the agent to start on an issue filed in Slack, register the **same mapping** in the same commit that creates the run, so a manual start and the poller can never give two runs for one issue (the store also refuses a second live run for an issue, and serialises starts per channel). Closed mappings are pruned after 30 days; open ones are never pruned, and the mapping is additionally cross-checked against every run the channel has ever had, so a pruned or lost entry cannot restart an issue.

Closure reconciliation records the observed PR head and merge commit durably, appends a successful merge attempt without rewriting earlier failures, and stops obsolete pre-merge work. It does **not** review, approve, merge or deploy: review/risk/approval records stay unchanged, and an unstarted deployment is skipped. PR read failures defer closure for retry instead of guessing. Each run is reconciled independently when several issues or runs share a PR (one PR read per poll). While closed mappings are retained, up to five quiet eligible mappings per poll are rechecked oldest-check first, so closure observed before the merge, or an older `issue_closed` cancellation, can later resolve successfully without another issue event. Explicit operator cancellations and already completed/rejected runs are not reopened.

### 15.2 Who can start a run (trust)

A new issue starts a run by itself only if its author is **trusted**: GitHub `author_association` of `OWNER`, `MEMBER` or `COLLABORATOR`; or the harness filed it (the provenance footer **and** a recorded filing: the intake document's `filedByHarness` list, written when `create_factory_issue` files it, since text alone can be forged); or it carries the go label (`factory.intake.goLabel`, default `factory:go`; only people with triage rights can add a label). Anyone else's issue is `held`: listed in the console and the rolling Slack intake note, started only by the go label or by `factory_intake_release`, which is checked against the factory's approvers like every other decision.

### 15.3 No backfill, caps, queue, breaker

- **No backfill.** The first poll after intake is enabled records `enabledAt` and nothing else. Issues created before it are `ignored` (reason: predates intake) and are never started by the poller; the go label or a release still starts one. `backfill: true` starts existing open issues instead, under the same caps.
- **Caps.** `maxStartsPerPoll` (5) and `maxPerHour` (20 starts, counted in the document so a restart does not reset them).
- **Queue.** Eligible issues beyond `MAX_LIVE_FACTORY_RUNS` (3, waiting runs count) are `queued`, not lost and not failed, and started oldest first as slots free up: on each poll, and when a run ends.
- **Circuit breaker.** If more than 3 x `maxPerHour` new eligible issues appear in one interval, the rest are `held` and one note says why.
- **Ignored.** Locked issues, pull requests (the issues API returns them), and issues carrying any of `ignoreLabels` (default `wontfix`, `duplicate`, `invalid`, `status:rejected`).

### 15.4 Updates

An open, mapped issue whose `updated_at` moved is compared with the mapping and the changes are delivered to its run as bounded entries in the run document's `updates[]`: `kind` (`comment`, `labels`, `edited`, `reopened`), author login, `authorAssociation`, `trusted`, an excerpt of about 1,000 characters, a time. At most about 20 are kept. The mapping update and the run update are one commit, so a crash neither loses nor repeats an update.

- **Only trusted updates reach a role.** Authors who are `OWNER`, `MEMBER`, `COLLABORATOR`, or the harness's own recorded filings are `trusted`. Untrusted updates are recorded and shown (console, intake note) but **never placed in a brief**: a brief is the only thing a role reads, and a stranger's comment is exactly where a prompt injection would sit. If they are ever included, it will be fenced and labelled untrusted data; today they are left out.
- **Briefs are still built from the run document alone**, and now include the trusted updates since that stage last ran, as information, never instructions.
- **No approval by comment.** Nothing reads `updates[]` to decide a wait. Approvals, declines and more rounds go only through the approvers, as before.
- **Timing.** A running run picks updates up at its next stage boundary (the brief). A run waiting on a person records them and the thread says a trusted update arrived; only `needs_info` reacts (15.5).
- The harness's own comments on the issue (its token's login) are not updates.

### 15.5 NEEDS_INFO is a wait

Triage `NEEDS_INFO` no longer ends the run. The run goes `waiting` with reason `needs_info` (a new wait kind, `info`); the triage stage stays in progress. A **trusted update** (typically the author answering) re-enters triage with that update in its brief. `REJECT` stays terminal. If nothing trusted arrives in `factory.intake.needsInfoDays` (default 14), the run ends `rejected` with reason `stale`. In the definition this is an arrow to the pseudo-target `wait_for_info`, next to the ends `complete`, `reject` and `fail`; the engine parks, then re-enters the same stage. It is bounded by people, not rounds: every re-entry needs a new trusted update. A run that stops at triage (rejected, stale, needs_info) is **not** announced with a top-level post (15.7).

### 15.6 Polling

One loop per factory channel that has intake on, per process, started at boot, restarted on config reload, stopped on removal and on shutdown. Never overlapping for a channel, jittered, with backoff on `gh` failures and rate limits (an audit line, never an exception into the app).

- **One list call per repository per interval.** `gh api` on `repos/OWNER/REPO/issues?state=all&sort=updated&direction=asc&since=<since>&per_page=100`: every issue changed since the last poll, open or closed, with `author_association`, labels, `locked`, comment count and a `pull_request` marker. It is the REST listing, not search, so a freshly filed issue shows at once (search lags). `gh issue list --json` was checked and has no `authorAssociation` field, which trust needs. A full page continues on the next tick from the last `updated_at` seen; `since` is backed off by a few minutes' overlap and everything applied is idempotent.
- **Per-issue calls only when needed.** Comments are fetched only for a mapped issue whose `updated_at` changed **and** whose comment count grew, with `since=commentWatermark`.
- **Idle polling.** Closing an issue changes `updated_at`, so every open mapped issue is covered by the one list. For deletion or transfer (which change nothing visible), a mapped issue with a live run that has been quiet for six hours is fetched individually, a few per poll; a 404 counts as closed.
- `pollNow(channel)` runs one poll immediately (used after `create_factory_issue` files an issue, so "file it" needs no `start_factory_run`). Overlap-safe: a request during a poll runs one more poll after it.

### 15.7 Slack

- A run **started by intake gets no top-level status post until it leaves triage.** A run that stops at triage (rejected, stale, needs_info, failed) gets one line in a rolling **intake note**: one top-level post per channel per day (found or created, kept in the intake note document so it survives a restart), edited with running counts, and a thread of one line per event. Held issues and the breaker are lines in it too. Runs started by a person (the tool) keep their immediate status post.
- With `factory.announce: false` there is no intake note either.

### 15.8 Console

Each run's sheet lists the updates received, marked trusted or untrusted; the Tasks tab's Workflow runs section has an Intake block: the mapping (issue to run, status, last update seen), held and queued issues, the last poll time and error.

### 15.9 Configuration

`factory.intake: { enabled (false), source: "github", intervalSeconds (120, 60-3600), goLabel ("factory:go"), ignoreLabels, maxStartsPerPoll (5), maxPerHour (20), needsInfoDays (14), backfill (false) }`. Operator-only: the admin channel's configuration tools refuse it, like the merge rules. `source` is an enum so Jira and Linear slot in behind the same `IssueSource` interface; the run document's issue gains `source` and `origin` (`intake`, `manual`, `slack`).

## 16. Where intake differed from section 15

- **REST listing, not `gh issue list`.** `gh issue list --json` has no `authorAssociation` field (checked against gh 2.102), which trust needs, so the poll uses `gh api repos/OWNER/REPO/issues?state=all&sort=updated&direction=asc&since=...`. It also returns closed issues as they change, so "a mapped issue that vanishes from the open list is fetched individually" became the six-hourly idle sweep, kept only for what changes nothing visible (a deleted or transferred issue).
- **The mapping lives in `slack.factory-intake`** (one document per repository, keyed by a hash of its name) plus `slack.factory-intake-note` for the rolling Slack note. The mapping update and the run's update list are written in one commit, so a crash neither loses nor repeats an update. A manual start writes the mapping in the same commit as the run.
- **A harness-filed issue is recognised by a list in the mapping** (`filedByHarness`, written when `create_factory_issue` files it), not by scanning the audit file: the audit file is only read for the last hour, and the recognition has to outlive a long outage of the poller.
- **A started run belongs to "intake", not a Slack user.** Roles run as the user id `intake`; `by.source` is `intake`. Nothing that checks a speaker (approvals, releases) ever accepts it.
- **Two races in aborting a run were found and fixed** because "the issue closed a moment after the run started" makes them likely. An abort asked for before the first stage's role began, or while its input was being admitted, was never delivered to the role, so the run hung until the model turn ended and aborting never returned. The sub-agent runner now honours an already-aborted signal at both points. A run's abort reason is also kept in its own field (`abortReason`), because a stage starting just after the abort cleared the shared `reason`.
- **`NEEDS_INFO` is an arrow to `wait_for_info`**, not a stage: the engine parks in a new `info` phase and re-enters the same stage on news. News is any trusted update newer than the stage's last attempt began, so an answer that arrived while triage was still working counts. The workflow's version is 2; runs pinned to version 1 keep their old arrow.
- **Untrusted updates are left out of briefs entirely**, not fenced. A fenced block would still put a stranger's words in front of the role; there is no case yet where a role needs them.
- **Not built:** the poll does not read edits to a comment (only new comments), and an issue transferred between repositories is seen only as closed.

## 17. Labels

The roles move an issue along with `status:*` labels, a filed issue carries `factory.issues.labels`, and the intake go label starts a run. GitHub refuses a label that does not exist, so on a fresh repository every one of those failed until someone created the labels by hand. The harness now creates the missing ones (`src/factory/workflow/labels.ts`).

- **Which labels.** `factory.issues.labels`, `factory.intake.goLabel` and the status set `FACTORY_STATUS_LABELS`, once each (names compare without case). A test reads every `status:*` the shipped skills name and fails if it is not in the constant, or the constant has one no skill uses, so the two cannot drift.
- **Create only.** An existing label is never edited, recoloured or renamed (no `--force`). A label made here is neutral grey and says the harness made it. A label made by someone else a moment earlier is success.
- **When.** For a factory channel that files issues or watches for them and whose team can run the workflow: at startup once its store is open, once per process per repository, again when the repositories or the labels it needs change (a config reload), and once more when filing an issue fails on a label that is not there. A channel that stops wanting labels is forgotten, so turning it back on checks again. A failure is left alone for ten minutes, so a missing permission is not hammered; `force` (the filing retry) bypasses the "already fine" shortcut but not that wait.
- **Failure is not fatal.** No token, no permission, a rate limit or a missing repository is audited (`labels_failed`, one bounded line), recorded in the intake record and shown in the console, and never stops startup, a poll, a filing or a run. Success is audited (`labels_created`, the names) only when something was made.
- **Console.** The intake record (`slack.factory-intake`) gains an optional `labels` field: when it last looked, what it created, why it failed. The Intake block shows it per repository. A direct message keeps the status and loses the reason.

Where it differed from the brief: the poller does not itself add labels, so "retry after the poller hits a missing label" is a small wrapper around a poll (an error naming a missing label makes the labels exist and polls once more) that nothing in the poller can trigger today; filing is the path that does. A channel whose store is not open yet is skipped by the startup pass and checked when its store opens (the app re-runs the pass after the background opens), because the outcome is kept in that store.

## 18. A failed stage is recoverable

**The problem.** A stage that failed ended the whole run as `failed`. A person who then fixed the cause (a token, a missing label, a role's config or skill, more detail on the issue) could not carry on: the only way forward was a brand-new run, which lost the pull request, the risk score, the review rounds and the history, and redid the stages before the one that failed (a review failing on a `gh` problem redid the coder). The retry / skip / abort decision existed only for a stage a restart had interrupted.

**The rule.** A stage failure does not end the run. The stage is `failed`, the run is `needs_decision`, and the task parks in a `failed` phase on a decision document, exactly as an interrupted stage does, keeping everything the run knows: its pull request, risk, rounds, attempts and trusted updates. Counts as live, so it holds one of the three places, keeps its issue mapping, receives the issue's updates, and is aborted if the issue closes.

**What now parks instead of ending the run.** The sub-agent failed, timed out or was cut off (a thrown error included); the coder reported `blocked` (the `fail` arrow); a report was unusable after the one automatic re-ask (no verdict, no pull request URL in the run's repository); GitHub could not be read when review starts or at the gate; the gate had no pull request; GitHub refused the merge.

**What still ends a run `failed`, and why.** Only what a decision cannot fix: the run's record is missing, its pinned workflow is unreadable or does not match its hash, its stage is not in that workflow, or the channel's store has no workflow deps (the factory was removed from the channel or the recovery gate found a role or repository gone, which aborts). These end the run because retrying them runs the same broken thing. Everything else is a decision.

**The answers** (`DECISIONS_FOR.failed`):

- `retry`: the same stage again, as a new attempt (the stage shows "attempt N"). It is not a new entry, so it is not a round and the loop guard does not count it; the checkpoint restarts the stage with `reask: false`, so a report that was unusable gets a fresh full brief. Nothing is cleared. The role, its tools and the credentials are resolved when the stage starts, so a fix to the config or a skill is what runs. The brief is rebuilt from the run document, including trusted updates that came in while it waited. A retry never happens by itself: the one automatic re-ask for a missing verdict is the only automatic repeat.
- `skip`: only a stage the workflow marks `optional` (the deploy). Refused for triage, implement, review and the merge, because passing the run on without the work the run exists for would be the opposite of what the workflow enforces. Checked in the service (so the person is told) and again in the task (so a decision written another way is ignored, noted on the run, and the wait goes on).
- `restart_from <stage>`: an earlier stage than the failed one (`failedStageProblem`). Later stages reset to `not_started`, every attempt is kept (`enterStage`), and the loop guard is honoured through `move()`: if the stage that failed, or the one it goes back to, has used its `maxEntries`, the run holds for a person (`waiting` on `rounds`) first, and `more_rounds` carries on. When the coder is sent back after a failed review there are no review findings to give it (the review never asked for changes), so its brief says a person sent the run back and points at the pull request that already exists, instead of quoting an unusable report as findings.
- `abort`: ends the run `aborted`; the stage stays `failed` on the record.

Who may answer is the same approver check as every other decision, in the service by the trusted session user and again in the task. A stranger's answer is consumed, noted on the run, and ignored. The decision document gained a `stage` field (for `restart_from`); a document written before it reads as "".

**Reopening a run that already ended `failed`.** Runs that ended failed before this change, and the few that still do, are carried on by `retry` through the same tool: `FactoryRunService.decide` sees a terminal `failed` run and calls `DurableChannelStore.reopenFactoryRun`. It is **a new durable task attached to the same run record** rather than a new run seeded from the old one. pi-durable has no objection to two tasks with one `runId` input (the old one is terminal, and `liveFactoryRuns` already filters on state), the record's reset and the new task are created in ONE commit (so a restart never finds one without the other), and everything stays on one record: the same pull request, risk, attempts, Slack post and audit trail, with no `continuedFrom` chain to follow and no duplicate in the console or the intake mapping. The alternative (a seeded copy and a "superseded" mark on the old run) would have needed a second run to show, a second Slack post, and a mapping repoint, and a person reads "the same run carried on" more easily than "a new run that continues the old". Refused unless: the run is `failed` (not `aborted`, `rejected` or `completed`), its pinned workflow reads and has the stage, its issue's mapping still points at it and is not closed, the issue is open on GitHub (checked in the service), nothing else is live for the issue, and the channel is under the three-run limit. `restart_from` and `skip` are not offered on a terminal run (go further back by retrying it and answering when it stops again), to keep one rule: the stage it failed at is the one that is retried.

**Slack.** A failed stage is told **once**: a failed attempt is never a reply of its own (the render drops them), and the run's `needs_decision` reply carries the stage, the attempt, the reason and the choices that apply. So a retry later cannot make the old failure be told again, and a failure that happens again is a new wait with a new key. The status post says "Stage failed: *implement* (attempt 2), needs a person" (not the interrupted wording) and carries **Retry** / **Abort**, with the same click rules as the other buttons: the approver check by the clicker in the service, one claim per wait, a stale or replaced-post button does nothing, a button that does not answer what the run waits for is refused (`buttonsFor`), and the post shows who decided. The interrupted-stage wait gets the same two buttons (the earlier build left it to words). `skip` and `restart_from` stay words or the tool. An intake run that fails at triage used to be silent (it has no status post until it passes triage); a run that needs a person now has its own post, because a parked run must not be a silent one.

**The agent.** `factory_decide` takes `retry`, `skip`, `restart_from` (with `stage`) and `abort`; `check_factory_run` describes a failed stage with `failedStage`, `failedAttempt` and the `answers` that apply (from the run's pinned workflow). The prompt and the pipeline skill say a failed stage is recoverable, to explain the reason, suggest the fix, never start a new run for an issue whose run is waiting, and to decide only on a person's say-so.

**The console.** A run whose stage failed shows "Stage failed" on its row with "implement failed · attempt 2"; its sheet explains it is waiting, not over, lists the answers that apply and what each does, and says decisions are made in Slack or through the agent (the console stays read-only). A run that ended failed shows its stage and that retry alone carries it on. The API adds `waiting.kind: "failed"` and a `recovery` object (stage, attempt, `ended`, answers, restartFrom). In a direct message the structure shows and the reason and summaries do not.

**Where it differed from the brief.** None of the brief's rules needed to change. Two things it did not name: the decision document needed a `stage` field; and several existing tests asserted the old terminal failure and were updated (see the pull request).

**Not built.** A note on a decision (why a person chose it), a cap on human retries (there is none by design), and `restart_from` for a run that already ended failed.

## 19. One GitHub account for the agent and a person

The harness acts on GitHub through one token. When that token is a person's own account (the common small setup), the roles' comments and the person's replies in the GitHub UI have the same login. Intake used to skip every comment from that login as "the harness's own", so a person's answer to triage's question was never delivered: the run stayed waiting for information and was rejected as stale.

**What marks a comment as the agent's.** Everything the factory agent writes to GitHub ends with a footer of two lines, written by one helper (`footer.ts`) that is also its only parser:

```
*Sent by the factory agent (coder) · run abc123*
<!-- harness:factory run=abc123 role=coder stage=implement -->
```

The visible line is so a person reading an issue or a pull request can see what an agent wrote; the hidden line is for the machine. They are not left to the skills: the brief the engine builds for every stage ends with the exact footer for that stage (real run, role and stage) and the instruction to put it, unchanged, at the end of every comment, review, issue or pull request description the role writes. The skills and the example role instructions say "the footer given in your brief". Issues the harness files carry the marker line after their provenance sentence, and the older provenance wording is still recognised (and still needs a recorded filing, as before).

**How a comment from the harness's own login is classified** (`classifyOwnComment`), in this order:
1. **A footer at the very end** (the marker or the visible line): the agent's. Only the last non-blank lines count, and only when they start the line. GitHub's quote-reply copies the agent's comment with `>` in front of every line and the person writes under it, so a quoted footer neither starts a line nor is last: that reply is the person's. A footer typed by hand would pass, but only the token's own account can write a comment this is asked about, and that account is the one in question.
2. **Made while one of the run's stage attempts was working**: the role's, whether or not it remembered the footer. The window runs from 2 seconds before an attempt started to 5 seconds after it ended (GitHub stamps whole seconds and the clocks differ; a person's reply that restarts a stage was posted before it, and was classified when first seen). An attempt still working has an open end.
3. **Otherwise a person's reply.** It is delivered as an update, marked `viaToken`, and trusted: whoever holds the token can write to the repository, so a person speaking through it is as trusted as the token. Another login is judged as before.

**The limitation, chosen on purpose.** A person's reply typed on the same account while a stage is actively working, with no footer, is taken for the role's, and is not delivered. The two mistakes are not equal: delivering a role's footer-less comment as a person's reply would make triage re-run on its own question again and again; dropping a reply typed during a stage costs the person writing again after the stage ends. The window rule only matters for a role that forgot the footer (which the brief should prevent), and every such comment is counted in an `intake_own_comment_in_window` audit line so the limitation is visible. A dedicated bot account or a GitHub App avoids all of it: nobody else writes as it.

**Enforcing the footer instead of asking for it.** Built afterwards: section 21.

**Other updates that assumed a login.** A label change has no author in GitHub's issue list, and the roles move an issue along with the `status:*` labels through the same account, so those changes used to arrive as trusted news and could wake a run waiting for information. A change to only the workflow's own status labels is no longer delivered; any other label change still is. A body or title edit is attributed to the issue's author and is unchanged (the roles do not edit issue text).

**Upgrading.** Comments already seen stay as they were: the watermark means nothing is classified or delivered twice. `viaToken` is optional on an update, so older run documents load unchanged.

## 20. Answering a stuck triage in Slack

A run that triage sent back for information (`waiting`, waiting on `info`) used to be answerable only with a comment on the issue, and an intake run had no Slack post of its own to answer in. Now:

- **The run gets its own status post while it waits for information**, whatever its origin, and the question (triage's reason) is said in that post's thread: "Reply in this thread with the answer, or comment on the issue yourself." The line in the intake note is no longer said for such a run; a run that already has a post keeps it to the end.
- **The reply is steering, like any message in a run's thread.** The agent there has a new tool, `factory_answer`, which takes the answer, written down as the person gave it. It is not offered a run id in the thread (the thread is the run).
- **The service does the rest, and checks the speaker.** `answer` requires the run to be waiting on `info` and the speaker (from the session, never an argument) to be one of the people who may decide for the repository, the same rule as approvals. The answer is sanitised the way a filed issue is (hidden characters, mentions and closing keywords in code spans, HTML escaped, bounded), then posted on the issue as a comment ending in the agent footer (section 19), so the same-account poll recognises it as the harness's and does not deliver it again. The Slack user id is not written to GitHub. Only when GitHub took the comment is the answer added to the run's updates (kind `slack`, author `slack:<id>`, trusted); if the comment fails the run is not told, and the person is.
- **Triage resumes the way it does for a GitHub answer.** The `info` phase wakes on a trusted update after the stage last ran, and the stage runs again with the answer in its brief ("an answer given in Slack by a person allowed to answer for this factory"). If it is still not enough, triage says `NEEDS_INFO` again, the run waits again, and the next answer is new news. An answer a stage already saw is not shown again.
- **Not echoed.** The thread does not repeat an answer as "new on the issue"; it is not an approval of anything, and nothing here can approve or merge.
- **Audit.** `answer` and `answer_failed` in `shared/audit/factory-runs.jsonl`, with the length of the answer, not its text.

Deviation to note: `FactoryGitHub` gained `commentIssue` (`gh issue comment --body-file -`), and `FactoryRunStore` gained `addFactoryRunUpdate`.

### 20.1 Runs that were already waiting get their post at startup

A run's Slack post is drawn when the run changes. A run that was already waiting for a person (information, or a decision) when the harness was upgraded or restarted had no post and no change coming, so there was no thread to answer in. `FactoryPresence.catchUp` gives every live run that should have a post of its own and has none (`hasOwnPost`, no timestamp, not terminal) its post, from the stored run: the question is said in the thread because the thread's lines are derived from the run (`replyEvents`), not from the moment of change.

- **When.** Once a channel's store is open: at startup, after a config reload (the stores reopen), and when the stores opened in the background finish. The app calls it next to the label pass.
- **Bounded and idempotent.** Once per process per run; at most 20 runs a pass, 1.5 seconds apart, the rest in a later pass. A run with a post, a terminal run, and an intake run still at triage are left alone. A channel that does not announce is skipped, and a direct message gets the structure-only post it always had.
- **Never throws.** A Slack failure is the presence's usual best-effort failure; the post is retried when the run next changes.

## 21. The footer is added by the harness, not asked of the model

**The problem.** Section 19 asked every role to end what it writes with the footer. A role can forget, and the agent in a factory channel that is not in a run (the one a person talks to) was never asked. Everything goes to GitHub as the token's account, which is often a person's own, so an unmarked comment looks like the person wrote it.

**What is guaranteed now.** In a factory channel, every comment, review, issue or pull request description the agent or a role writes through `gh` ends with the footer, whether or not the model wrote it. The harness's own writes carry it too.

**How.**
- *Roles and the channel agent: a `gh` guard.* A small POSIX shell script (`gh-footer-shim.sh`) is installed as `gh` in the operator's global bin (`shared/global-bin/gh`) when a channel has a `factory` block. That directory is on the PATH of every route commands run through (the bash tool on the host and in the container, the exec tool, shared tools), after the channel's own `bin` and before the system's, and is mounted read-only into every container, so one file covers them all and needs no new mount. The script runs the real `gh` (the first one on the PATH that is not itself) and does nothing unless the session's environment has `HARNESS_AGENT_FOOTER` and `HARNESS_AGENT_FOOTER_MARKER`, so other channels are unaffected. A file named `gh` already in the global bin that is not the harness's is left alone and a warning says the footer is then not guaranteed.
- *The text comes from one place.* `footerEnv()` in `footer.ts` builds both variables from the same helper that writes and parses the footer, so the shell script never copies the format. A factory channel's own session has the footer without a run; each role in a factory channel has it with its role; a workflow stage has it with its run, role and stage (passed by the engine as `SubagentRunRequest.env`, overlaid on the channel's environment). A model cannot set these: they are built by the harness when it builds the session.
- *What it stamps.* `gh issue|pr comment`, `create`/`new`, `edit`, `pr review` and `pr revert` (`--body`, `-b`, `--body-file`, `-F`, `--body=`, attached short forms, and standard input); `gh issue|pr close|reopen --comment`; and on `gh api` any write (POST, PATCH, PUT) with a field named `body`, sent as a plain string (`-f`, `-F body=@file`, `-F body=@-`), including adding a `body` to a new comment, review, issue or pull request that has none. An approval with no words gets a body that is just the footer. A body that already ends with this run's marker line is left alone, so the footer is never added twice, and a quoted footer is not mistaken for one.
- *What it refuses, rather than passing on unmarked.* A write whose text it cannot see: an editor (`-e`), `--fill` or a template or saved draft on `create`, `gh api --input` to issues, pulls or commits, and a GraphQL request that contains a mutation (queries are unaffected). It stops with a message that says what to do instead.
- *The harness's own writes.* The engine's `createIssue` and `commentIssue` (the Slack answer) refuse to run `gh` when the text has no footer (`requireFooter`), so a change that forgot would fail a test instead of posting unmarked. Merging a pull request and creating labels write no comment or description. Any new engine write that sends text must go through `requireFooter`.

**Why this and not an after-the-fact repair.** The factory cannot tell a role's comment from the person's on the same account except by the stage window, which is the very ambiguity this solves; editing comments that "lack a footer" would stamp a person's words as the agent's. The detection that exists (`intake_own_comment_in_window` in the audit file) stays; repair was not built.

**What can still slip through.** The guard is not a security boundary. It stops an agent that forgets, not one that tries: the real `gh` by its full path, `curl` to the API with the token, a `gh` of its own in the channel's `bin` (which is first on the PATH), a `gh` alias, or `gh release`, `gist` and `discussion` writes, which it does not look at. A channel that is not a factory channel is not covered, and neither is any non-`gh` client. These are named in the README.

**Tested** against a fake `gh` that records what it is given, under `sh`, `dash` and `bash`, and by hand in Debian and Alpine (BusyBox) containers with the guard mounted read-only.

## 22. A stuck triage that never reads the answer

**The problem.** A run waiting for information (`waiting` on `info`) stayed stuck after a person answered on the issue, and seemed to go in circles. Three causes, all in how intake reads an issue's comments:

1. **Dropped for good.** Before section 19, every comment from the harness's own GitHub login was skipped as "the agent's own", and the per-issue comment watermark moved past it. When the token is a person's account, the person's answer was one of them. Section 19 sorts new comments correctly, but a comment already skipped is never looked at again, so a run that was stuck before the upgrade stayed stuck until it was stale-rejected.
2. **The role's own edits woke the run.** Triage sets labels (and may tidy the description) through the same account. A label or description change is "from someone trusted", so one made *while the stage worked* was news to the run it came from: the run left its wait at once, triage asked its question again, and so round after round. A change that lands while one of the run's stage attempts is working (the same window as section 19, from the `issue.updatedAt` the poll sees) is now the role's own and is not delivered. The cost is the one section 19 already accepts: a person's label or edit made in the middle of a stage is not news (a comment is judged by its own time and footer, as before).
3. **Long threads.** The REST call read the first hundred comments only. It now reads every page (bounded at five), so a re-read of a long thread does not stop short of the newest answer.

**The recovery.**
- **Once, automatically.** The intake record keeps `commentRules`, the version of the rules that sort comments (`COMMENT_RULES_VERSION`, 2 for section 19). A repository whose record says less, or nothing, has the issue of every live run that is *waiting on information* read again on the next poll: the watermark goes back to just before the run began (`rewindPoint`), the comments since are sorted under today's rules, and what is a person's reaches the run as an update. The version is written when the poll finishes without a failed re-read; one that failed is tried again on the next poll.
- **Nothing twice.** A comment the run already has as an update (same moment, same writer) is skipped, so a re-read changes nothing for a run that was told. The agent's own comments are skipped as they always were: its footer, or made while one of its stages ran.
- **Late news is still news.** An update records when the harness saw it (`seen`). A stage counts an update as new to it when it happened after the stage last ran *or* was first seen after that: a re-read finds comments that are old by their own clock, and a stage that began since (a second round of triage, say) must still hear them, once. A stage that ran after it was seen does not hear it again, so this cannot loop.
- **By hand, without a redeploy.** `factory_recheck_issue` (approvers only; the speaker is the session's, never an argument; the run must be live and intake must map its issue) marks the entry `recheck` and asks for a poll now. The next poll does exactly the above for that one issue. It writes nothing to GitHub and says so. It is for "I answered on the issue and nothing happened". To answer in Slack instead, `factory_answer` (section 20) records the answer on the issue and in the run in one step, and does not depend on any of this.

**Seeing it.** Each read of an issue's comments that found any, and each re-read, audits `intake_comments` with counts only: how many were fetched, delivered (trusted), kept as untrusted, skipped as the agent's own (and how many of those by footer rather than by window), duplicates, and changes taken as the role's. The same counts are on the intake entry as `lastScan` and are listed per mapped run by `check_factory_intake` (`scans`), so a run that is "deaf" can be told from a quiet issue: an answer that was skipped shows up as `skippedOwn`. `intake_recheck` and `intake_recheck_failed` mark the re-read itself. No comment text is in any of them.

**The rest of the loop was checked, not changed.** After an answer is delivered, triage runs again with it in its brief (the brief is built before the new attempt is recorded, so the answer is not "older than the stage"), and the agent's question is not returned to it as news (its footer, or its window). A test runs question, answer from the same account, resume with the answer in the brief, and no second question.

**Limits.** An answer made in the middle of a stage is still taken for the role's if it carries no footer (section 19). A run whose issue was reopened keeps the mapping's old watermark rules. A repository with intake off has nothing that reads comments, so there is nothing to re-read.

## 23. Why a run stops, and how to get it going

**The problem.** "The factory gets stuck a lot, and once stuck I cannot tell how to unstick it." A copy of the example config left most of the stops at their most cautious setting, and a stuck run did not say what it was waiting for.

**Every way a run stops for a person.** What the example config made it do, how often it bites, and what changed.

| Stop | Before (example config) | How often | Now |
| --- | --- | --- | --- |
| Merge: `autoMergeMaxRisk` unset is 0, "never" | A person merges every pull request | Every run | The example sets `autoMergeMaxRisk: 2`. The default stays 0: nothing merges by itself unless an operator says so |
| Merge: no required check on the branch | A person merges | Every run on a repository without branch protection | Unchanged by design (a decision of section 5b). The merge wait now says how to fix it, and that merging on GitHub yourself carries the run on |
| Merge: risk over the limit, sensitive path, large diff | A person decides | The riskiest changes | Unchanged: these are the gate working. The example lists sensible `sensitivePaths` |
| Merge: reviewer forgot `RISK:` (counts as 5) | A person merges | Whenever a reviewer left the line out | The reviewer is asked for it once more before it counts as unscored (`report.ts`) |
| Triage asks (`NEEDS_INFO`), waits for a person, then is rejected stale after 14 days | Waits | Any under-specified issue; a stale wait is a lost issue | Triage is told to prefer going ahead on stated assumptions and to ask everything in ONE comment with what it will assume. New `factory.intake.assumeAfterHours` (off by default, 24 in the example): after that long with no answer triage runs once more, may not ask again, and goes READY on its assumptions or REJECTs. Review and the merge rules still apply |
| Triage reports `needs_input`/`blocked` instead of a verdict | The stage failed: `needs_decision` | Occasionally | Read as `NEEDS_INFO` |
| Coder asks a question (`needs_input`) | The stage failed: `needs_decision` | Whenever the issue is ambiguous | The brief and skills tell it not to stop to ask: assume, record under "Assumptions" in the pull request, go on. `blocked` is for "cannot build it at all" |
| Reviewer nitpicks round after round, then review is out of rounds | `waiting` on `rounds` after 3 | Chatty reviewers | The review skill: request changes only for blockers and real problems; nits do not block. New `factory.reviewRounds` (3 default, 4 in the example) |
| Harness restarted while the coder worked (`replaySafe: false`) | `needs_decision` | Every deploy of the harness while a run was building | Stages marked `resumable` (the coder) are run again by the engine, up to twice in a row, with a brief that says an earlier run was cut off and to look for its branch and pull request first and not open another. The deploy is not resumable |
| Deploy: `requireApproval` role in the example's set | Every merged change waits for a deploy approval, and needs Cloudflare credentials | Every run that merged | The example's `factory` channel turns the deployer off (`agentOverrides`); delete the lines to deploy |
| Capacity: 3 live runs, waiting ones count | New issues queue behind stuck runs | As soon as three runs are stuck | New `factory.maxLiveRuns` (1 to 10; 3 default, 5 in the example). The limit message says to abort a waiting run or raise it |
| A stage failed (role failed, timeout, unusable report, GitHub refused the merge) | `needs_decision`: retry, skip, restart_from or abort | Setup mistakes | Unchanged (section 18). The wait says what to fix |
| Label, skill or config refusals | The run does not start, with a message | Config mistakes | Unchanged (sections 14 and 17). The example's channel now `requires` `gh` and `GH_TOKEN`, so a missing one is reported at startup, not in a run |
| Triage `REJECT` | Run ends rejected | By design | Unchanged. The way back is the go label or `start_factory_run` |

**Settings that need an operator** (the admin agent's config tools refuse them): `reviewRounds`, `maxLiveRuns`, `intake.assumeAfterHours`, like the rest of `merge`, `issues` and `intake`. None of the new settings loosen a merge gate: `assumeAfterHours` only changes what triage does when nobody answers, and what is then built is still reviewed and held by the merge rules. A comment still cannot approve or merge anything.

**Telling a person what to do.** One function (`unstick.ts`, `stuckGuide`) says what a waiting, failed or rejected run is waiting for and every way to move it: the Slack reply, a GitHub comment, merging on GitHub, `factory_recheck_issue`, the settings that stop it recurring. `check_factory_run` returns it as `howToGetItGoing`, and the README has it as a table ("Unsticking a run"). The status post's merge and info lines say the most direct thing. The run's sheet in the web console shows the same words, and, when the operator turned console actions on, the buttons that apply (section 24).

**Versions.** The workflow's version is now 3 (`resumable` on the coder). A run keeps the definition it started with, so runs in flight are unchanged; `reviewRounds` sets the review stage's `maxEntries` in the definition a new run is pinned to.

**Not done.** Making waiting-on-information runs not count toward the live limit (a decision of section 16: they count); an automatic extra review round before asking (`reviewRounds` is the knob); a custom workflow per channel.

## 24. Autonomy levels: a risk appetite per factory

**The problem.** Section 23 made a factory able to run by itself, but only by setting four unrelated numbers (`merge.autoMergeMaxRisk`, `intake.assumeAfterHours`, `reviewRounds`, and the engine's retries) that a person has to know about and keep consistent. Some projects want every decision scrutinised, most want the agent to do its best. That is one decision, so it is one setting.

**`factory.autonomy: cautious | balanced | autonomous`** is a preset for those knobs. Per repository the same word goes in `repositoryRules.<repo>.autonomy`, so a payments repository can be `cautious` inside an `autonomous` factory.

| | `cautious` | `balanced` | `autonomous` |
| --- | --- | --- | --- |
| Merges by itself at risk (`merge.autoMergeMaxRisk`) | never (0) | 2 or under | 3 or under |
| Waits for an answer before assuming (`intake.assumeAfterHours`) | forever (0) | 24 h | 4 h |
| Review rounds before asking (`reviewRounds`) | 3 | 4 | 5 |
| Engine retries of a failed stage (`autoRetries`) | 0 | 0 | 1 |
| Everything else (deploy approval, who approves, floors, checks) | as configured | as configured | as configured |

**The default is `cautious`, and it is today's behaviour exactly** (nothing merges by itself, triage waits, three rounds, no automatic retry), so a config written before this section does not change on upgrade. The example config sets `balanced`. A repository that wants the old behaviour says `cautious`.

**Resolution** (one pure function, `effectiveAutonomy(factory, repo)` in `autonomy.ts`, the only place the numbers are decided): an explicit setting beats the level, whichever layer it is in (a repository's own `autoMergeMaxRisk`, then the factory's `merge.autoMergeMaxRisk` / `intake.assumeAfterHours` / `reviewRounds` / `autoRetries`); among levels the repository's beats the factory's; what is left is the default level's. Every value comes back with its source (`explicit` or `level`) and the level with where it came from (`repository`, `factory`, `default`). The choice "explicit beats level even when the level is the repository's" is deliberate (it is what "explicit settings always override the preset" means) but can surprise: a repository set `cautious` inside a factory with `merge.autoMergeMaxRisk: 3` still gets 3. So the config load **warns** about exactly that (`autonomyWarnings`), and about an assume window that is longer than `needsInfoDays` (the run would go stale first and never get there).

**What no level can change.** The gates have no setting a level could move, and the tests (`levels.test.ts`) pin them at every level: a pull request merges only if the reviewer approved it, every required check is green (none required, failing or still running means a person merges), and its head is unchanged since the review (`--match-head-commit`, and a moved head goes back to review); a missing or out-of-range score is 5; sensitive paths still score at least 4 and big diffs at least 3; 5 is never automatic and no preset exceeds 3 (the schema allows 4, an explicit choice); only trusted authors start runs; a comment never approves or merges; a deploy still waits for an approver unless the deployer's `requireApproval` is turned off explicitly. There is deliberately **no** "merge without checks" opt-in: the decision of section 5b that no required checks means a human merges stands, and fixing it means branch protection on GitHub.

**Automatic retry of a failed stage** (`autonomous`, or `autoRetries` explicitly). When a stage fails, the run used to park for a person (section 18). Now the engine first tries it again itself, as the same new attempt a person's `retry` makes (not a new round; nothing the run knows is cleared), at most `autoRetries` times, and audits each (`auto_retry`, with the stage, which retry, and the reason). It is deliberately narrow:
- only a failure that is plainly one: the role timed out or died, or its report was unusable even when asked again (the attempt is recorded `failed`). The coder's own `blocked`, and GitHub refusing a merge, are not retried: asking again says the same thing;
- only a stage that is safe to run again: `replaySafe` (triage, review, the merge gate) or `resumable` (the coder, whose brief tells it to find the branch it left and not open a second pull request). The deploy is neither, so it always waits for a person: it may have acted, which is the two-commit rule's whole point;
- bounded: a person's retries add failures to the same count, so they use the budget up rather than extend it, and a run cannot loop.
The run still passes through `needs_decision` for an instant (the failure is recorded before the retry is), so the status post may flash it and be edited back; the audit file is the record that a person was not needed.

**Where it is shown.** One line, the same words everywhere (`describeAutonomy`): "balanced · auto-merge at risk ≤2 · assumes after 24h · 4 review rounds". In the config-load log (once per repository, and again only when it changes), on every run's status post (a context line), in `check_factory_run` and `check_factory_intake` (per repository), and as structured data (level, where it came from, each number with its source) in the console's run payload (`autonomy`); no new console UI.

**Operator-only.** `factory.autonomy` and `factory.autoRetries` are refused by the admin agent's config tools, as are `merge`, `repositoryRules`, `intake` and `reviewRounds`: a model cannot raise its own level.

**What changed in existing settings.** `reviewRounds` and `intake.assumeAfterHours` no longer have schema defaults (3 and 0): "not set" has to be distinguishable from "set to the default" for an explicit value to beat a level. The values a factory with neither set gets are unchanged (the `cautious` preset is 3 and 0). `maxLiveRuns` is not part of the levels: it is a resource limit, not a risk appetite. A run's review rounds are fixed when it starts, from its repository's level at that moment, and it keeps them (the pinned workflow definition); the assume window, the retries and the merge number are read when they are needed, so a change applies to runs in flight.

## Merge-conflict rework (workflow v4)

GitHub PR facts now include raw mergeable/mergeStateStatus, head branch/SHA and actual target base branch/SHA. Only CONFLICTING or DIRTY confirms a conflict. An unknown result gets two refreshes (three total reads, one-second delay by default), then parks as unresolved; protection, permissions, checks and a behind branch are not labelled conflicts.

Review preflight routes confirmed conflicts through changes_requested without spending a reviewer model run. After an approval report, review re-reads the PR before handing off for merge approval, so a base change during review invalidates that approval. The merge gate reads again at entry and immediately before merging (also on recovery of a decided gate); approval-wait polling also notices confirmed conflicts or a moved head. A rejected merge is re-read, not interpreted by searching its error message for conflict-like words.

Confirmed conflicts return to implementation on the existing PR, carrying evidence in the stage attempt's report. Gate conflicts use the review stage's existing round guard before starting another coder. The transition clears the reviewed head, risk, merge authorization and deploy approval; after repair, review and all applicable merge gates run again. Restating an incomplete review report does not change the commit that was originally reviewed. The coder's brief requires an isolated checkout, fetched head/target base SHAs, semantic resolution without force-push, test/typecheck/build evidence and the exact pushed head; unsafe resolution reports blocked with paths and alternatives. Replacement PRs are refused during rework. The PR changed-files list is not presented as conflicting paths.

New runs pin workflow v4's merge conflicts → implement arrow. Older definitions are not rewritten: review conflicts still use their existing changes_requested arrow; an older merge gate without a conflict arrow parks with evidence and an explicit restart_from implement instruction. No live runs are restarted or modified by this change. Revert the change to roll back; any already-pinned v4 run must retain an engine that understands its conflict arrow.

## 25. The web console can act

The console was read-only. A person who finds a run stuck should be able to unstick it from the page that shows it, so it can now answer a stuck run and start one, when the operator allows it.

**Decisions (the user's).** No login: the console is reached on loopback or behind the operator's VPN or proxy, and "anyone who can reach it can act" is accepted. First actions: unstick a run (retry, skip, restart from a stage, abort, read the issue again, answer a question) and start a run (plus poll now). Originally approve, decline, more rounds, deploy approval and merging stayed in Slack. Merge approval now has the run-scoped Slack verification extension below; other consent and direct merging remain unavailable.

**Switch.** `webConsole.actions` (default false), a key of `webConsole`, which the admin channel's config tools already refuse to edit. The web server's own flag decides: a source cannot turn actions on by itself. With it off, every action route is a 403 and the pages carry no controls; the guidance text (what the run is waiting for, how to carry it on) is still shown, because it is information, and it is `unstick.ts`'s `stuckGuide`, the same words as `check_factory_run` and the README.

**The console as an actor.** The service takes an `actor: { kind: "console", remote }`. It answers as `console` (a value no Slack user id can have), skips the approver check that identifies a Slack speaker, and puts `actor` and `remote` on every audit line. It refuses, for that actor, `moreRounds`, `releaseIntake` and `createIssue`. Merge-only `approve`/`decline` require a server-derived, run/wait/head-scoped Slack identity and recheck approver permissions; deploy and rounds consent are still refused. The engine repeats the rule: a decision whose `by` is `console` is accepted only if it is retry, skip, restart_from or abort (`CONSOLE_DECISIONS`), and anything else is ignored with the reason "the web console cannot decide this", so a forged request that reached the store would still not approve a merge. A console answer is a comment on the issue ("Answered in the harness's web console by a person with access to it", the agent footer, no Slack id, no address) and an update of kind `console`, trusted like a Slack answer; the stage brief says it was entered in the console.

**Request defences** (`src/console2/actions.ts`), in order: the switch; `Content-Type: application/json`; the `X-Console-Action: 1` header, which a cross-site form cannot send and which would need a CORS preflight the server never answers; `Origin` must be the console's own and `Sec-Fetch-Site` must be same-origin or none; a rate limit (20 a minute per connection address, 60 overall, `Retry-After`); a 16 KiB body; a strict schema (unknown keys refused, the stage name a plain identifier, an answer at most 4000 characters, notes at most 1000). The `Host` check and the DNS-rebinding defence were already the server's. The action routes are a closed list (`/workflows/:runId/actions/{retry,skip,restart_from,abort,recheck,answer,verify_approver,approve,decline}` and `/factory/{start,poll}`): any other name is a route that does not exist. A per-run, per-action lock makes a double click run once.

**What it says back.** Fixed words on success; a refusal is a 409 (an unknown run a 404) with the service's message. In a direct message channel a refusal is one fixed sentence, a started run does not echo its title, and the audit line carries no reason. Every outcome is audited as `console_action` (actor, address as the connection saw it with a proxy's `X-Forwarded-For` noted but never trusted, run, action, outcome).

**In the page.** The run sheet gains a "What you can do" panel: what the run is waiting for (when no other notice already says), the other ways to carry it on, and the buttons that apply, which the server decides (`WorkflowGuidance.actions`, from the run's state and workflow; a merge wait offers verification and Abort, then Approve merge / Decline merge only after Slack verification). Abort asks first. The answer box is bounded. The Workflow runs section gains "Start a run for an issue…" and "Poll GitHub now" when the channel is a factory the workflow can run in. The top bar says "Can act" instead of "Read-only", from a flag on the tree. Buttons are disabled while a request is in flight, and what the server said is shown, as a status or an alert.

**Run-scoped merge verification (#178).** `ConsoleMergeApprovals` holds at most 200 ten-minute in-memory challenges. The browser cookie and Slack button id are distinct random 256-bit secrets; Slack never sees the browser bearer. The browser displays a matching challenge; an authenticated Slack approver verifies only their own browser in the run's thread, without yet authorizing the merge. A channel/run/wait/reviewed-head scope and current permissions are checked on confirmation, view lookup and service use. The API never accepts a caller-supplied Slack user id. HttpOnly/SameSite=Strict cookies are scoped under the console API (including reverse-proxy prefixes), Secure on HTTPS, and become unusable on restart or expiry. The service writes the verified Slack id to the ordinary decision document, so the unchanged engine applies its normal approver and reviewed-head protections. No schema migration or new config permission is needed; `webConsole.actions` still gates every action. The page distinguishes review approval from merge authorization, explicitly labels a parked merge stage, and explains read-only/unverified/unavailable states rather than promising missing buttons.

**Limits.** Except for verified merge decisions, no login means no per-person record: the audit says "console" and where the request came from, not who. A proxy in front makes every caller one address for the rate limit. Retry, skip and restart act through the same decision document the Slack buttons use, so a run another person is deciding at the same moment takes whichever decision arrives first.
