# Design sketch: per-channel subagents ("agent sets")

Status: **steps 0–2 built on `feature/subagents`, plus a software-factory proof of concept;
the rest is still design.** See "As built" below for what exists and where this document was
overtaken by the implementation. User-facing docs are in the README's *Subagents* section.

## As built

What exists, with the file to start from:

| Piece | Where |
|---|---|
| Config: `agentSets`, channel `agentSet` and narrowing-only `agentOverrides` (validated) | `src/config/schema.ts` |
| Resolver: capability = set ∩ channel; `ResolvedChannel.agents`; the narrowed channel a role runs in | `src/workspace/subagents.ts`, `resolve.ts` |
| `run_subagent` tool (synchronous) and the report type | `src/agent/subagent-tools.ts` |
| Runner: a fresh Durable conversation per run, own tools/prompt/model, report parsing, concurrency cap, timeout | `src/agent/subagents.ts` |
| Store support: `openSubagentRun`, `sub-` run keys, excluded from thread listings | `src/agent/durable/channel-store.ts` |
| Role-aware tool set (`role: "subagent"`): role tools + read-only `recall`, no outward reach | `src/agent/session.ts` |
| Recovery: an interrupted run is abandoned, like scheduled runs and dreams | `src/slack/app.ts` (`isEphemeral`) |
| Usage: every subagent model call is logged with source `subagent` | `src/agent/usage.ts`, `app.ts` |
| Approval gate: `requireApproval` → `subagent:<name>` capability, same Slack buttons and expiring grants | `grants.ts`, `app.ts`, `subagent-tools.ts` |
| Software factory set, example channel, and shipped skills | `config/harness.example.yaml`, `agent-set-skills/software_factory/` |
| Progress in the Slack thread: a hand-off post, the subagent's own updates, a closing line; the answer stays last (`ui.subagentProgress`) | `src/slack/subagent-progress.ts`, `SlackResponseStream.postInterjection` in `stream.ts`, runner events in `subagents.ts` |
| Timeline: per-channel event log (turns, tool calls, runs, approvals, interruptions) | `src/agent/timeline.ts`, written from `app.ts` and `subagents.ts` |
| Timeline in the web console: git-graph layout (main line + one branch per run), page, JSON API, live refresh | `src/console2/timeline-graph.ts` (layout), `timeline.ts` (API), `web/console2/src/components/TimelineView.tsx` |

Where the implementation differs from the design below (the design text is left as written):

- **No dedup by attaching to an existing run (§4.2, §8.1).** The harness forces every tool to
  replay-`unsafe`, so a recovered `run_subagent` call is reported to the channel agent as interrupted
  and the run is abandoned, never re-attached. The "no duplicate coder after a crash" guarantee comes
  from that rule instead. Attaching would be a later optimisation, and needs a `replay: "safe"` tool.
- **Tools are registered store-wide by name.** A role's tools are always a subset of the channel's, so
  nothing new is registered except `run_subagent`; each run binds its own implementations to its own
  conversation. This is why a role can never have a tool the channel lacks.
- **A subagent is not a fork** of the channel trunk and not task-owned. It is an ownerless fresh
  conversation (so it carries none of the channel's history), pinned to its role's model, and its run
  key starts with `sub-`.
- **Skills are not yet role-targeted.** Every role with `read` sees every channel skill; skill
  descriptions say who they are for. The `applies_to` frontmatter in §5.1 is not built.
- **Subagents cannot write memory or propose skills yet.** They get `recall` only. The feedback inbox
  (§5.2) and reflection (§5A) are the planned way for them to contribute, and are not built.
- **Orchestration is the channel agent's, by skill.** Triage → coder → reviewer → deployer is driven by
  the channel agent following `factory-pipeline`; roles report a suggested `NEXT`, and nothing calls a
  subagent from a subagent (§4.4 kept).
- **Approval is a role-level time window, not per job.** The grant is `subagent:<name>` for a duration
  the approver picks. It cannot carry a commit SHA or environment, so the deployer skill also requires
  the user's words, environment and commit in the brief (a soft check on top of the hard gate).
- **Per-channel context in the system prompt.** The store's prompt sections (skills list, workspace,
  runtime context) are shared by all conversations in the channel, so a subagent also sees the
  channel's "runtime" late-context block. The skills list is only shown to roles that can `read`.

Known gaps for the factory to be run for real, roughly in priority order:

1. **Async runs** (`wait:false`, `check`/`cancel`) so a long coder job does not hold the channel
   agent's turn open. Today `run_subagent` blocks, bounded by `timeoutSeconds`.
2. **Per-run transcripts in the console.** The timeline shows each run's steps, status, duration, spend and
   report excerpt, but not the full transcript of what the subagent said and read.
3. **Scoped connector grants** (a read-only GitHub for the reviewer). Today the only guards are the
   role's tool list, the `allowTools` on the connector, and separate credentials per channel.
4. **Feedback inbox, reflection, custom compaction** (§5.2, §5A), including the compaction-model
   setting and the model-gate change it needs.
5. **Role-targeted skills** and a configurable concurrency cap.
6. **A live run against real GitHub and Cloudflare.** The pipeline has been run end to end with a **real
   model** (`openai-codex/gpt-6-luna`, about half a cent a run): `src/agent/software-factory.live.test.ts`
   drives the real example agent set against a throwaway git repository with a real bug, a local `origin`,
   and a stand-in `gh` (`src/agent/fixtures/`), and asserts what it observes: triage labels the clear issue
   ready and holds the vague one for information, the coder's branch makes the real test suite pass, a PR is
   opened and approved by the reviewer, every issue ends with exactly one status label, nothing is merged,
   and the whole run is on the timeline. Run it with
   `HARNESS_LIVE_MODEL=<provider/model> node --experimental-strip-types --test src/agent/software-factory.live.test.ts`.
   Not yet exercised: the real `gh`/GitHub connector, the Cloudflare deployer, and the approval flow in a real
   Slack workspace. The first live run found two real bugs that scripted tests could not: Pi's `bash` tool
   threw on every command under the Durable adapter (broken for all channels, not only subagents), and the
   roles left stale `status:` labels behind.

## 1. The idea

Today a channel has one agent that does everything: talks to the user, holds every tool and
connector, and accumulates every tool result in one context window.

Proposal: a channel keeps exactly **one user-facing agent** (the *channel agent*), and may be
assigned an **agent set**, a named group of purpose-built **subagents** (code writer, reviewer,
deployer; calendar manager, inbox triager). Subagents:

- talk to *systems* (GitHub, Linear, Gmail, Calendar), never to the user;
- have **their own tools and their own context**, so a Gmail dump never bloats the channel agent
  and the channel agent's tool list never bloats a subagent;
- **share the channel's memory and skills** (the "hive mind"), and can write to both;
- report back to the channel agent, which decides what the user needs to see.

Agent sets are defined **once in config** and **assigned to many channels**
(`software_engineering` on three channels). Behaviour differs per channel because the *channel's
skills and memory* differ, not because the definitions differ.

First use case: software factories (write / review / deploy). Second: life admin (calendar,
mail, bills).

## 2. Where this sits relative to what exists

| Existing | Relationship |
|---|---|
| `transfer_to_channel` (`delegation-tools.ts`) | Hands work to **another channel's** agent, which gets its own thread, memory and workspace. Subagents are the opposite: **inside** one channel, sharing its memory and skills. Keep both; they answer different questions (*who owns this domain* vs *who does this step*). |
| Factory (`src/factory/`, `factory-skills/`) | Today one engineering agent walks lifecycle skills (planning, implementation, review, commit-pr). Subagents turn each lifecycle phase into a role with its own context and tools. The factory dashboard becomes a view over subagent runs. |
| Skills / collections (Workstream B) | Subagents consume them. Agent sets should reference **collections** (`software-development`) so the two concepts compose. |
| Memory (`memory-store.ts`) | Shared per channel. See sections 5 and 5A for the write discipline this needs. |

## 3. Config shape (strawman)

```yaml
agentSets:
  software_engineering:
    description: Plan, implement, review and ship changes via GitHub and Linear.
    agents:
      planner:
        description: Turns an issue into a reviewed plan. Read-only on code.
        model: openai/gpt-5.4
        tools: [read, grep, find, web]
        connectors: [linear, github]
        skills: { collections: [software-development] }
      coder:
        description: Implements a plan in a sandbox and opens a PR.
        model: openai/gpt-5.4
        tools: [read, write, edit, grep, bash]
        sandbox: { mode: docker }
        connectors: [github]
      reviewer:
        description: Reviews a PR against the plan and channel conventions. Cannot push.
        model: anthropic/claude-sonnet-5-5
        tools: [read, grep, bash]
        connectors: [github]       # a read-only grant, see 6
      deployer:
        description: Runs the deploy runbook. Always asks the channel agent to confirm first.
        tools: [bash]
        connectors: [github]
        requiresConfirmation: true

  life_admin:
    agents:
      calendar: { connectors: [google_calendar], tools: [] }
      inbox:    { connectors: [gmail],           tools: [] }

channels:
  engineering:
    agentSet: software_engineering
  family:
    agentSet: life_admin
    # per-channel narrowing, never widening:
    agentOverrides:
      inbox: { connectors: { gmail: read-only } }
```

Rules that fall out of this:

1. A subagent definition is **a ceiling**, and the channel assignment may only **narrow** it.
   Overrides cannot add tools/connectors the set doesn't grant.
2. A subagent can only use connectors **the channel is already permitted to use**. An agent set
   never grants a credential the channel does not hold. The set says what a role *wants*; the
   channel's permissions decide what it *gets* (intersection).
3. A channel has at most one `agentSet` at first. Multiple sets per channel is possible later
   but invites name collisions and prompt bloat. Don't build it until needed.
4. Model for each subagent follows the existing allowlist rules (`models:`), so a cheap model
   for the inbox triager and a strong one for the coder is a normal config line.

## 4. Runtime model

### 4.1 Invocation

The channel agent gets one tool, **`run_subagent`** (plus `list_subagents` for discovery, or the
list is simply in the prompt):

```
run_subagent({ agent: "coder", task: "...", context?: "...", wait: true | false })
```

- The channel agent writes the task as if briefing a colleague. The subagent does **not** inherit
  the conversation, which is the whole point of having its own context. The channel agent is
  therefore responsible for a self-contained brief (the prompt should say so).
- `wait: true`: the call blocks and returns the subagent's final report as the tool result.
- `wait: false`: returns a run id immediately; the result is delivered back into the channel
  agent's thread as a follow-up turn when finished (reuses the "delegated result returns to the
  source thread" mechanism from `transfer_to_channel`). Long jobs (coder, deployer) want this.
- Also `check_subagent(runId)` / `cancel_subagent(runId)`.

### 4.2 Subagent execution on Durable

Each subagent run is a **Durable conversation** in the channel's store, keyed
`sub:<parentThreadKey>:<runId>`:

- Own context, own checkpointed events. A crash mid-run resumes or reports interrupted effects,
  exactly like any other task. This is the main reason to wait for Durable before building this.
- `requestId` derived from the parent request + tool call id + agent name, so a recovered parent
  turn that re-issues `run_subagent` **attaches to the existing run** instead of spawning a
  second coder. (Dedup is the hard correctness requirement here; see risks.)
- Route/speaker binding: a subagent run inherits the **originating human's identity and the
  parent's `RequestDoc`**. It never acts "as itself". The recovery gate (A.5) applies unchanged
  and additionally checks that the agent set / agent still exists and its grants still hold.
- A subagent has **no Slack posting tools and no `transfer_to_channel`** by construction. Its only
  outputs are: its final report, memory/skill writes, and effects through its own connectors.
  This enforces "only the channel agent talks to the user" structurally rather than by prompt.

### 4.3 Subagent output contract

The final report is a short structured result, not a transcript:

```
{ status: "done" | "blocked" | "needs_input" | "failed",
  summary: string,              // what the channel agent should tell the user
  artifacts: [{ kind: "pr" | "issue" | "event" | "file", ref: string }],
  question?: string }           // when needs_input
```

`needs_input` is how a subagent asks the user something: it returns to the channel agent, which
asks in Slack and re-invokes (or resumes) the run with the answer. Subagents never block on a
human directly.

### 4.4 Nesting and fan-out

- **No subagent-spawns-subagent** in v1. The channel agent orchestrates; depth is 1. Simpler
  recovery, simpler cost control, and the failure mode "agents calling agents in a loop" is
  gone.
- Concurrency: channel agent may start several runs (reviewer on PR A while coder works on B).
  Per-set `maxConcurrent` limit and per-run `maxTurns`/`maxCost` budgets, enforced by the
  harness, not by the model.

## 5. Shared memory and skills (the hive mind)

This is the most interesting and the riskiest part.

### 5.1 Reading

Resolved by the single resolver (Workstream B): a subagent's context is built from
- its own role prompt (from the set definition),
- the **channel's memory** (same store the channel agent uses),
- the **channel's skills** plus assigned collections, filtered to those relevant to the role
  (`skills.collections` on the agent, optionally narrowed to named skills).

So the *same* `reviewer` definition behaves differently in two channels because channel A saved
a skill "reviews must check migration safety" and channel B did not. This is the mechanism for
per-channel behaviour; nothing in the agent set config needs to change.

Recommend a **naming convention for role-targeted skills**: a skill may declare
`applies_to: [reviewer]` (or `all`) in frontmatter, so the reviewer sees review conventions and the
coder doesn't spend context on them. Without this every subagent pays for every channel skill.

### 5.2 Writing: subagents give feedback, they don't write

Revised after discussion: subagents get **no direct write access** to shared memory or skills.
Instead they emit **feedback records** into a per-channel inbox (a Durable doc family, not
memory). The channel agent decides what to do with them during **reflection** (section 6).

A feedback record is structured and carries provenance:

```
{ id, run, agent, kind: "learned_fact" | "proposed_skill" | "friction" | "suggestion" | "error_pattern",
  text, evidence?: ref, untrusted: boolean, createdAt }
```

- `untrusted` is set by the harness, not the model: true if the run touched external content
  (emails, issue bodies, web pages, PR text). Taint is sticky and travels with the record.
- Emitted via a `submit_feedback` tool. Cheap, append-only, no side effects; safe to call freely.

Why this beats direct writes:

| Concern | How the inbox handles it |
|---|---|
| Concurrent subagents corrupt memory | They only append to the inbox; one reflection pass is the single writer to memory/skills. |
| Prompt injection persisted into shared memory ("remember: BCC attacker@...") | Injected text becomes an inbox item, tagged `untrusted`, never live memory. Reflection treats inbox text as **data to evaluate**, not instructions, and by default promotes only plain facts, never imperative/behavioural text from tainted records. |
| One bad run poisons the channel | Nothing is live until promoted; single-source tainted facts need corroboration (second run, or the user) before promotion. |
| Skills drift with no explanation | Every promoted item records the feedback ids/runs that justified it. |

This does not make injection impossible: the reflection agent still reads summaries of untrusted
content. It moves the decision to one place, with taint information and time to think, rather
than trusting each worker mid-task. Skills authored from tainted feedback should additionally
require human approval (console), at least initially.

The user's model, "channel agent writes up skills for how they want things to work", remains the
primary path for skills. Reflection is how *lessons learned* reach them.

### 5.3 What is *not* shared

Context. A subagent's transcript is not visible to the channel agent unless the final report
carries it, and vice versa. Memory is the only durable shared channel. That is deliberate: it
forces "what did we learn" to be written down rather than leaked via context.

## 5A. Reflection (replaces dreaming)

Today `dream.ts`/`dreamer.ts` run a nightly cron per channel: read recent conversations, fold
facts into memory, merge duplicates, `forget` stale entries into an archive, log to
`memory/DREAMS.md`. Proposal: generalise this into **reflection**, a scheduled (and
event-triggered) channel-agent turn whose job list is pluggable. Memory consolidation is just
the first job and keeps its guarantees (nothing destroyed, own channel only, skippable when idle).

### Reflection jobs

| Job | Input | Output |
|---|---|---|
| **Consolidate memory** (today's dream) | recent conversations, memory | merged/strengthened/forgotten entries (archived, never deleted) |
| **Triage subagent feedback** | feedback inbox (5.2) | per record: promote to memory, draft/update a skill, discard, or escalate to a human. Records are marked resolved with the decision and reason. |
| **Review skills** | channel skills + recent runs/friction | proposed edits, merges, retirements; flags skills that conflict or never fire |
| **Review the workers** | run reports, budgets, failure rates | notes like "reviewer misses migration issues, needs a skill"; suggests prompt/model/tool tweaks to the *operator* (set definitions are config, not agent-editable) |
| **Compact long-lived context** | Durable conversations | see below |

Each job is independently enable-able and has its own budget. A reflection run with an empty
inbox and no new conversations does nothing, as dreams do now.

### Triggers

- Nightly cron (the existing `dreams.cron`) as the default.
- **Threshold**: inbox depth or tainted-item count exceeds N, so a busy factory doesn't wait a
  day for lessons to land.
- **Post-run**: optionally after a failed or `needs_input` subagent run, for friction only.
- Manual: `!reflect` / console button, which is also how you debug it.

### Outputs and safety

- Reflection is the **single writer** of memory/skills for the channel, which removes the
  concurrent-write class of bugs from section 5.
- Same ledger as dreams: every decision appended to a reflection log (`REFLECTIONS.md`, or fold
  into `DREAMS.md`), each memory/skill change linked to its source feedback ids.
- Config: `dreams:` becomes `reflection:` with `jobs:` and per-job settings; keep reading
  `dreams:` as a deprecated alias for one release so existing config doesn't break.
- A reflection run is itself a Durable request with a derived id
  (`reflect:<channelId>:<date>`), so recovery and dedup work as for dreams (the Durable plan
  already specifies `dream:<channelId>:<date>`).

### Custom compaction

Durable makes conversations long-lived, so compaction stops being an emergency measure and
becomes the main way a channel's working memory is shaped. Default compaction is a generic
"summarise the transcript" step, which is exactly where the important details get lost. Reflection
is the natural place to do it properly:

1. **Promote durable knowledge from the log.** Facts, decisions, preferences and open
   commitments go to memory/skills via reflection, ideally before compacting but not required
   (the log is retained). Memory is the source of truth; the summary is a cache of "what we were
   in the middle of".
2. **Channel-aware summary instructions.** Preserve what matters for this channel type: for a factory,
   open PRs/issues and their states, decisions and why, who asked for what; for life admin,
   pending commitments and deadlines. The prompt can come from a channel skill, so each channel
   shapes its own compaction.
3. **Compact on idle, not mid-turn, and only after discussion.** Run during reflection when the
   thread is quiet and has new human discussion; automatic compaction handles the forced case. Fewer surprising
   forgettings in the middle of someone's request.
4. **Pin, don't summarise, some things**: the last N turns verbatim, unresolved tool calls,
   outstanding approvals, in-flight subagent run ids.
5. **Keep the original.** Durable's event log already retains full history; the compacted view is
   a projection, so a bad summary is recoverable and diffable.
6. **Subagent runs compact differently**: they are short-lived, so default is *discard context,
   keep the final report and feedback records*; no summary needed.

**Research result (pi-durable 1.0.4, from its README and type definitions): no fallback needed.**
The SDK already provides what custom compaction needs:

| Need | What the SDK offers |
|---|---|
| Supply our own summary | `beforeCompact` hook on `CompactionTask` (`CompactionHooks`). It receives `reason` (`manual`/`threshold`/`overflow`), the `entries` and model `messages` being replaced, the `firstKept` entry and any `instructions`. It returns `{ summary }` to replace the built-in summariser or `{ decline: true }` to skip. First decision wins. |
| Trigger compaction ourselves | `conversation.compact(instructions, context)` admits a manual task; it summarises in the background and is placed at once if idle, otherwise at the next turn boundary. Reflection can call this on idle threads. |
| Steer the built-in summariser | The `instructions` argument (e.g. "keep open PRs and their states"), so a channel skill can supply per-channel instructions without us writing a summariser. |
| Tune thresholds | `settings.compaction`: `enabled`, `reserveTokens`, `keepRecentTokens` (recent context kept verbatim), `backgroundTokens` (background compaction starts this far below the blocking threshold). The background threshold already gives us "compact before it hurts". |
| Keep the original | Compaction appends a `pi.compaction` entry; older entries stay in storage. A bad summary is recoverable. |
| Start fresh with a handoff | `reset(handoffNote)` starts a new context from a note, and a tool can request it via `control: { handoff }`. Useful as the fallback for runaway threads. |
| Spend accounting | Summarisation cost lands in `pi.usage`. |

Consequences for the design:

- **Hook, not rotation.** Implement "promote then compact" as a `beforeCompact` hook registered
  through an extension (`hook(CompactionTask, {...})`). Before returning, the hook (or the task
  that wraps it) writes durable facts to memory, then returns the channel-aware summary.
- **The hook only produces the summary; memory promotion is decoupled.** `HookApi` is read-only
  plus task memos, so the hook cannot write memory, and it does not need to. Compaction never
  deletes entries (the `pi.compaction` entry just heads the kept range), so reflection can promote
  durable facts from the **full log** before or after a compaction, including a forced one. "Promote
  before compact" is therefore an ordering preference, not a safety requirement: nothing is lost if
  a forced compaction wins the race, and the next reflection pass still sees everything.
- **Forced compaction is expected and needed.** The blocking threshold and overflow-retry will
  compact mid-conversation regardless of our schedule. Proactive compaction in reflection (plus
  `backgroundTokens`) just makes forced compaction less likely. The hook must therefore be a good
  summariser on its own: channel-aware `instructions` (from a channel skill) with the compaction
  model below.
- **Manual compaction only after discussion.** Reflection never compacts a conversation with no new
  human discussion since its last compaction or reflection pass: no discussion, no compaction (the
  same "skippable when idle" rule as dreams). "Discussion" means at least one human-originated turn
  since the last `pi.compaction` entry; subagent-only or scheduled-only activity does not count by
  default. Optionally also require the context to be above a minimum size so tiny threads are left
  alone. Automatic threshold/overflow compaction is unaffected, since it is needed to keep the model
  working.
- **Compaction model: a global default plus per-channel override.** Add a top-level
  `compactionModel` setting and an optional per-channel `compactionModel`. Resolution: channel
  override, else global default. Rules:
  - The **global default is always usable for compaction regardless of the channel's `models:`
    allowlist**, so a locked-down channel (or one on a model that can't summarise well) still
    compacts. This needs a deliberate change to the Stage 1 model-policy gate, which today validates
    `pi.compaction` `summarize`/`retry` checkpoints against the channel allowlist: the check becomes
    "channel allowlist, or the resolved compaction model".
  - The **per-channel override** must itself be a model the operator has configured (exists in the
    provider registry); it need not be in the channel's conversational allowlist, but it is
    operator-set config, never something the agent can change.
  - **Data egress:** compaction sends channel content to the compaction model's provider. A global
    default on another provider is a deliberate data-flow decision, so document it, and allow an
    override per channel for sensitive channels that must stay on one provider.
  - **Recovery:** compaction checkpoints pin their model. If `compactionModel` changes while a
    compaction is in flight, the recovery gate must accept the pinned model that was valid when the
    task was admitted (or re-run the compaction), not strand the channel.
  - Same setting applies to reflection's own summarising jobs if we want one cheap model for all
    background work; keep it separate (`reflectionModel`) only if a need appears.

- **Subagents get this free.** An owned child conversation is a normal conversation, so it
  compacts like any other; default for short runs is "discard context, keep the report".

**Subagent support in the SDK (relevant to section 4, found while researching):** the SDK has a
first-class pattern for exactly this feature. A tool creates a child conversation owned by its
task (`ownership: { kind: "task", taskId }`), starts as a copy of the parent's agent, can be given
a different model and extension set (the README example gives the child a cheaper model and removes
the subagent extension so it cannot recurse), and is aborted with its parent. `replay: "safe"` plus
the ownership index means a rerun after a crash **finds the same child and submission** instead of
spawning another, which is the dedup guarantee section 8 asks for. A background variant
(`{ background: true }` tasks) survives the parent's abort and posts the answer back to the parent as
a follow-up input once it arrives, keyed by request ids so a restart cannot send a report twice.
That is the `wait:false` mode in section 4.1. So sections 4.2 and 4.4 should be built on these
primitives rather than invented: the SDK ships `22-subagent-foreground.ts` and
`23-subagent-background.ts` examples to start from. Confirmed in the types: a child is created with `agent: AgentChange`, which accepts `model`,
`thinkingLevel`, `instructions`, `cwd`, and `tools`/`extensions` as either an **array that selects
exactly those** or `{ add, remove }` edits. A task-owned child starts as a copy of its owner's agent
and the change is applied on top, so a subagent can have a completely different tool set, model,
system instructions and working directory (a fork, by contrast, inherits the parent's agent as of
the fork point, so subagents rather than forks are the right primitive). Setting `tools: [...]`
replaces the list outright, which also gives the structural guarantee that a worker has no Slack
posting tools.

The real question is therefore not capability but **recovery**: tools and extensions are stored by
*name* and resolved against the registry, and ours are closures bound to channel, connector
credentials and request context (Durable plan Stage 2, "tool rebinding"). A recovered child must have
its tool set rebuilt for `(channel, agent definition, originating request)` through the same resolver
and recovery gate as any other task, with grants re-checked. If a worker's tool is missing or its
grant revoked at recovery, the child stays paused, as for any task. **Verified with a throwaway test against pi-durable 1.0.4 and a fake model:** a parent's `subagent`
tool created an owned child, configured it with only a `submit_feedback` tool, and the child's call
wrote to a **session-scoped document family** via `api.commit(tx => tx.doc(Family, key, seed))`; the
record was readable afterwards with `harness.snapshot(Family, key)`. So the feedback inbox design
works. Gotchas found: `tx.createConversation()` does **not** accept an `agent` option (only
`Harness.createConversation/root/fork` do), so a tool-created child must be configured with the
exported `configure(tx, childId, {...})`; and a child's tools/extensions must be installed in the
registry (the agent stores only names), else the call fails with `tool_unavailable`. The
`ConversationHandle` a tool gets exposes only `submit`, `abort` and `waitForIdle`, so reading a
child's entries goes through `harness.conversation(id)` outside the tool.

## 6. Tools, connectors, secrets, and permissions

- Tool list per subagent is explicit (`tools:`). There is no inheritance from the channel agent.
- **Connectors per subagent**, not per channel: the `reviewer` gets GitHub read-only, the `coder`
  gets GitHub write. This needs the connector layer to support **scoped grants / read-only
  modes**. Check how far `connectors.ts` and `grants.ts` already go; this may be new work.
- Secrets: same envFile resolution as the channel. A subagent only receives env vars for
  connectors/CLIs it lists. No ambient channel env.
- **Approvals**: `requiresConfirmation` on a subagent (deployer) means its run starts in a
  `awaiting_confirmation` state that surfaces to the channel agent, which must get an explicit
  human yes (existing approvals machinery, bound to task + args + speaker per Stage 2 item 5)
  before the run proceeds. Humans approve at the channel; they never talk to the subagent.
- Sandbox: a coder subagent runs in the channel's Docker sandbox (or its own per-run container).
  Decide whether subagents share the thread's container (shared filesystem state, simple) or
  get isolated ones (clean, costs more). Recommend: share the **workspace**, separate
  **containers** per concurrent run.

## 7. UX in Slack

- Normal case: the user sees only the channel agent. It may say "handing this to the coder" in
  one line; it should not narrate every subagent step.
- Visibility is **opt-in per channel** (`showSubagentActivity`): a compact status line / task
  card per run (`coder: running 4m, step 3`), reusing the existing task dashboard and the factory
  timeline. The web console shows full per-run transcripts for debugging; Slack never does.
- Failures come back as `status: failed` summaries to the channel agent, which decides tone.
  A crashed/blocked recovered run produces the standard "I was interrupted and couldn't safely
  continue" notice via the channel agent, not directly.

## 8. Failure modes to design against

1. **Duplicate spawn after recovery.** Covered by deterministic request ids (4.2). Needs a
   crash-injection test: kill between "subagent run created" and "tool result committed".
2. **Runaway cost.** Budgets per run and per channel per day, hard-enforced. Subagents on cheap
   models by default unless the role needs better.
3. **Brief is too thin.** Subagent lacks context and flails. Mitigations: prompt guidance for the
   channel agent; `context` param; subagents may return `needs_input`; and memory/skills carry
   standing context.
4. **Telephone game.** The channel agent summarises a subagent summarising a tool result and
   facts degrade. Artifacts (PR URL, event id) are structured, not paraphrased, so the user gets
   real links.
5. **Memory poisoning** (5.2). The security-critical one.
6. **Over-delegation.** The channel agent spawns a subagent for a one-line lookup. Tune with prompt
   guidance and by keeping simple read tools on the channel agent. Subagents are worth it for
   *context-heavy or permission-distinct* work, not everything.
7. **Config reload mid-run.** Agent set edited while runs are in flight: runs finish against the
   definition they were admitted under (store the resolved definition hash in the `RequestDoc`),
   but recovery re-validates grants.

## 9. Suggested build order

Each step is independently useful and mergeable.

0. **Prereqs**: Durable cutover; Workstream B resolver; request-scoped identity.
1. **Agent set config + resolver**: schema, validation, `agentSet` on channel, per-channel
   resolved view (tools/connectors/skills intersection). No runtime yet. Tests: narrowing-only
   overrides, unknown set/agent, grant intersection.
2. **Synchronous `run_subagent`** on Durable: own context, own tools, final report contract,
   no memory writes, no Slack tools, read-only memory + skills. Dedup ids + crash test. This is
   already enough for a useful reviewer/calendar agent.
3. **Async runs** (`wait:false`, result delivered as follow-up, `check`/`cancel`), budgets,
   concurrency limits, console visibility.
4. **`submit_feedback` inbox** with harness-set taint, `applies_to` skill targeting.
4b. **Custom compaction** in reflection (promote-then-compact), after the compaction spike.
5. **Reflection**: generalise dreams into jobs; add feedback-triage and skill-review jobs; human approval for skills from tainted feedback.
6. **Scoped connector grants** (read-only vs write per role), `requiresConfirmation`.
7. **Factory rebuilt on subagents**: planner/coder/reviewer/deployer replace the monolithic
   lifecycle; dashboard reads subagent runs.
8. Later/maybe: multiple sets per channel, subagent-defined-in-channel (the channel agent
   *authoring* a new subagent, which is extremely powerful and a sizeable new attack surface),
   depth > 1.

## 10. Open questions

1. **Subagent as a Durable conversation vs. a tool-internal loop.** Durable conversation gives
   crash-resume for free but is heavier. Is a conversation-per-run acceptable at the volumes we
   expect (spike S2 territory)?
2. **Who may promote tainted feedback**: reflection alone, or a human? Proposal: reflection for
   untainted facts and corroborated ones; human for any skill derived from tainted records.
3. **Do read-only connector modes exist today?** If most connectors are all-or-nothing, the
   reviewer-can't-push guarantee needs either a proxy/filter layer or separate credentials
   (e.g. a read-only GitHub token per role). Separate tokens are the pragmatic answer.
4. **Should the user be able to address a subagent directly** ("@reviewer look at this")? The
   stated model says no. Worth keeping it no: it preserves a single conversational identity and
   keeps recovery/approval binding simple.
5. **Skill targeting**: `applies_to` frontmatter vs. skills nested per role directory. Frontmatter
   keeps one flat namespace and fits collections; directory-per-role is more visible on disk.
6. **Naming**: "agent set" vs "crew" vs "team". Config name `agentSets` is a placeholder.
7. **Interaction with `transfer_to_channel`**: can a subagent trigger a transfer? Recommend no;
   it must go through the channel agent.
8. **Cost model for always-on life-admin agents**: scheduled runs (inbox triage every morning)
   should run as subagents invoked by a scheduled channel-agent turn, reusing the scheduler's
   request-id scheme (`sched:<id>:<fireTime>`), rather than a separate scheduler.

## 11. The one-paragraph version

One user-facing agent per channel; a config-defined **agent set** assigned to channels gives it
named workers with their own tools, connectors, models and context windows. Workers run as Durable
conversations, are invoked via `run_subagent`, can't talk to the user or other channels, and
return structured reports. They read the channel's memory and skills, so identical definitions
behave differently per channel, and they submit feedback rather than writing, and a reflection pass (the successor to dreaming, which also does custom compaction) is the single writer of memory and skills. Capabilities only ever narrow
(set ceiling ∩ channel grants ∩ per-channel overrides). Build synchronous, read-only workers
first, then async, then writes, then the factory rebuild.
