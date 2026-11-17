# Conversations on Pi Durable: how it is built

This describes the backend as built. For the operator's view (restarts, `!recovery`,
what survives) see the README section *Durable conversations, restarts and recovery*.

## Shape

```
channel store  (data/channels/<id>/durable/, SQLite, one owning process)
└─ main conversation            harness.root(): the channel's shared context
     ├─ thread  <ts>            fork of main's tail when the bot first joined the thread
     ├─ thread  <ts>
     ├─ scheduled-<id>-<time>   a one-off fork for a quiet scheduled run
     └─ dream-<time>            a one-off fork per nightly pass
```

| Piece | File | Role |
|---|---|---|
| `DurableChannelStore` | `src/agent/durable/channel-store.ts` | One store: main + thread forks, model policy, delivery records, blocked-recovery list |
| `ChannelRuntimes` | `src/agent/channel-runtime.ts` | Opens one store per channel: at startup for every channel the harness knows (existing stores recovered first, new ones in the background), again after a config reload, and on first use for anything else; reference-counted, explicit invalidation; runs the recovery gate on open |
| `createThreadSession` | `src/agent/session.ts` | Builds a thread's tools (closures over speaker/thread/sandbox), binds them to the thread's conversation, drives turns |
| `adaptPiTools` / `ThreadToolBindings` | `src/agent/durable/pi-tool-adapter.ts` | Store-wide tool registrations that dispatch to the calling conversation's tools |
| `TurnEventAdapter` | `src/agent/turn-events.ts` | Durable event batches → backend-neutral `TurnEvent`s for the Slack layer |
| `recoverChannel` | `src/agent/recovery.ts` | The recovery gate |
| delivery ledger | `src/slack/delivery.ts` | Idempotent Slack replies |
| model policy | `src/agent/durable/model-policy.ts`, `model-dispatch.ts` | Exact `provider/model` allowlist enforced at dispatch |

## Forks

A thread conversation is `main.fork(tail)` created lazily; its mapping is written in the same commit as the fork
(`ThreadDoc`, a session-scoped document *family* keyed by thread key, so lookup cost does not grow with the thread
count). Verified behaviour: a fork sees the parent's entries up to the fork entry and nothing later; parent and fork
then diverge; the fork inherits the parent's stored agent but gets its own provider session id.

Consequences:

- Threads never see each other, and nothing a thread says is written into main. The harness appends short
  `slack.thread.digest` entries to main so *new* threads know what the channel has been doing.
- A fork inherits stored tool names and model, so on **every activation** the store re-applies the current loadout,
  instructions, cwd and model policy — never trusting what was persisted. A thread follows the channel's default model
  until the agent switches it (`pinnedModel`); `!model` sets the channel default on main.
- `!reset` forks again from main's tail and repoints the thread; the old fork is kept for inspection and is not read
  back by dreams or summaries.

## Tools

Durable registers tools **by name for the whole store**, but this harness's tools are closures over one thread
(speaker, thread to post into, sandbox container, task tracker). So a registration carries only the schema; calling it
resolves the implementation bound to `api.conversationId`. A conversation with no live binding fails closed with an
error result, never with ambient authority.

The registry is always built from the channel's **full** option set (`template`), so a restricted run (a quiet
scheduled task, a dream) can never define the schemas. Each conversation is then offered only its own *profile* —
tool names and instructions — set from a freshly built tool set (`setThreadProfile`), so a revoked tool is withdrawn
even from a pre-existing fork. Pi's native file tools are jailed by `enforceJail` (shared with the legacy extension)
inside the adapter, which also rewrites an allowed path to its checked real path.

Tool replay is forced to `unsafe` for everything: an interrupted effect is **reported, never repeated**.

## Events

`message_end` carries an entry, not a message; streamed deltas are optional (a fast model commits a whole message in
one batch); a slow watcher gets a single `snapshot` in place of dropped batches. So `assistant_message_end` is
authoritative for a message's text, and `text_delta` is only a live preview that the adapter synthesises when absent.

## Recovery

Any progress call on a store starts **all** ready work in it. Therefore:

1. The gate runs when a store is opened (`ChannelRuntimes` `gate`), before any session, command or timer can use it,
   and again at start-up for every existing store.
2. For each conversation with live work it checks the Slack thread is known, there is exactly one recorded speaker who
   is still allowed, and the thread's tools can be rebuilt from today's configuration (`bindRecoveredThread`).
   Interrupted scheduled runs and dreams are abandoned.
3. Any failure leaves the store paused and records a `BlockedRecovery` list; while it is non-empty **every** operation
   that could start work throws `RecoveryBlockedError` (including per-item aborts, which would start the scheduler).
   Operators resolve it all-or-nothing with `!recovery retry` / `!recovery discard`.
4. Only then are models of every live conversation and every pinned checkpoint re-checked, ephemeral runs aborted, and
   the scheduler started.

Approvals in this harness are time-limited capability grants evaluated when tools are built, so a recovered turn gets
exactly the capabilities granted *now*.

## Request identity and "new"

The request receipt hashes a caller-supplied **fingerprint** (the user's own message and attachments), not the whole
prompt, because the prompt carries a one-time history preamble that legitimately differs on a redelivery after a crash.
A thread counts as *new* (needs that preamble) until a request was actually **admitted** to it, not merely until its fork
exists, so a crash between creating the fork and submitting cannot skip the history read.

## Delivery

`intended → sent(ts) → delivered`, recorded in the store (`DeliveryRecord`), with the request id carried in invisible
Slack message metadata. Intent is recorded before the first send; an `intended` record without a timestamp is
reconciled by finding that metadata in the thread before sending again. `delivered` is terminal. Request ids:
`slack:<channel>:<message ts>` for real Slack events (redeliveries are the same request), unique
`internal:<uuid>` for every other entry point so a repeat is never mistaken for a duplicate.

Long replies are reconciled per part (each carries `{request_id, part}`), the history lookup reads the whole thread, and an
in-process set stops a redelivered event from replying to a request that restart-recovery is already answering. Limits: a crash after the final send and before `delivered` is recorded re-checks the thread by metadata and edits;
if the history scope is missing that lookup cannot happen and a warning is logged. Messages the app queued in memory
behind a running turn (not yet submitted) are lost on a crash, as before.

## Models, credentials and custom providers

`ModelRuntime` from pi-coding-agent implements pi-ai's `Models`; the store takes that interface directly, with the one
shared credential/OAuth owner. There is no second provider registry.

An allowed virtual alias is **selection permission only**. The exact alias and **every actual physical `provider/model`
target** must independently appear in the same immutable allowlist (e.g. `router/auto` routing to `vendor/model`
needs both). A denied route fails the request without invoking credential resolution/refresh or the transport, for
generation, compaction, continuation, retries and reopened tasks; nothing is cached from a prior success.
`model-dispatch.ts` owns the transport boundary instead of calling opaque `ModelRuntime` completion methods, resolving
through the owner's public `resolveModel`, validating and snapshotting the physical result, and rechecking exact policy
and catalog identity before auth and again immediately before transport. Hidden routing inside a custom `Models`
implementation is not supported; new SDK routing APIs need an explicit adapter review. This is a provider/model-ID gate,
not an endpoint/firewall/secret sandbox against malicious implementations.

The allowlist is exact `provider/model` references computed from the channel's `models` (permission, not credential
availability). A store will not open if its configured default is not allowed.

## Failure of a store

Since pi-durable 1.2 any storage error fails the whole Session permanently (`SessionFailed`; every later call rejects).
`ChannelRuntimes` watches `store.ended`; on `failed` it retires the store (after its sessions finish) so the next message
opens a fresh one over the same directory, and the recovery gate runs again. `close()` always releases the directory lock,
even for a failed store.

## Node and runtime

`@earendil-works/pi-durable` (pinned to 1.3.0, as is `chord`) requires Node >= 22.19 (built-in SQLite with a lock timeout). `src/util/runtime-check.ts`
refuses to start on an older Node and `Dockerfile.harness` pins a verified version and checks it at build time.
Conversations use WAL with `synchronous=FULL` (crash-safe against process death, not power loss on every filesystem;
network filesystems are unsupported). SQLite still prints Node's experimental warning.

## Known limits and follow-ups

- A store's tool **schemas** are fixed when it opens. If a connector was down at that moment its tools are not
  registered; a later session that has them withholds them (with a warning) and schedules the store to be re-opened,
  so the next session registers the full set. Until then those tools are not offered.
- Opening a store builds one throwaway tool set (and so opens connectors) when no session is available, e.g. at
  start-up recovery or for a dream lookback on a channel with connectors.
- Requests queued in the app's per-thread queue are not durable.
- Raspberry Pi hardware behaviour (SQLite `synchronous=FULL` on SD/SSD) was not measured on the device.
