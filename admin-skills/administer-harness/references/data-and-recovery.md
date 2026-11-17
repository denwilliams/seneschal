# Data, backups, recovery, running and upgrading

## Where state lives

Plain files, plus one SQLite store per channel. Built-in backups archive `dataDir` (`data/` by default).
If the host's optional `documentsDir` places the document library outside `dataDir`, back up and restore
that directory separately too, with the harness stopped. Changing the setting does not migrate files;
see the README's library storage location procedure before moving an existing library.

```
data/
  shared/        account-wide: knowledge/, skills/<collection>/<skill>/, global-bin/,
                 library/, bin/, documents/, memory/, feedback/, audit/skill-writes.jsonl
  channels/<slack-id>/
    workspace/   the agent's cwd and filesystem sandbox (workspace/bin = its own CLIs)
    memory/      MEMORY.md, MEMORY.archive.md, DREAMS.md
    skills/      channel-private skills
    durable/     the conversation store (SQLite): the channel's main conversation + one fork per thread
    sessions/<thread>/   marker only: the bot is in this thread (older installs also hold *.jsonl
                         transcripts here; nothing reads them any more)
    dreams/      log.jsonl and recent dream transcripts
    recent-conversations.json
```

Conversation content is private to its channel. **Never serve `durable/`**, never copy it to
a shared place, and never paste from it into another channel.

## Backups

Configured under `backups:` (cron, directory, `keepLast`). By default a tarball
`./backups/data-YYYY-MM-DD.tar.gz` per day of the whole `dataDir`, older ones pruned.

- A backup taken **while the harness runs** can catch a channel's `durable/` mid-write. For a
  copy you intend to restore from, stop the harness first, or rely on the scheduled archive
  and accept losing the last moments.
- **Before a risky step** (upgrade, `migrate-skills`, `!recovery discard`, deleting anything
  under `data/`), a person should run, while the harness is stopped:
  `cp -a data data.bak-$(date +%F)`.
- **Restore:** stop the harness, put the archive's contents back as `dataDir`, start it.
  Anything said in Slack since the backup is not in the restored stores (Slack still has it).
  Do not restore over a running harness.

## Recovery after a restart

Each channel's conversation store survives a restart. A turn that was running is **resumed**,
but only after it is re-established under the rules that apply *now*:

- the original speaker is still allowed in the channel;
- the thread's tools rebuild from today's config and grants (a revoked permission or removed
  connector is simply absent);
- the models involved are still allowed.

Interrupted tool calls are reported to the model as interrupted and **never repeated
automatically**. Interrupted scheduled runs and dreams are dropped (they run again on schedule).

If any check fails the **whole channel is held paused**: nobody can use it, because resuming
any one conversation would start all of them. A message there answers that the channel is
paused. The person fixes the cause and types:

- `!recovery` — what is held and why;
- `!recovery retry` — run the checks again;
- `!recovery discard` — give up on everything interrupted in that channel (irreversible for
  that work; back up first if it matters).

Typical causes: the speaker was removed from `allowUsers`; a connector or tool the turn needed
no longer exists; a model was removed from the allowlist.

If a channel's store ever fails at the storage level it retires itself and the next message
opens a fresh one over the same directory (and runs these checks again).

## Running it

- **Node ≥ 22.19** is required (built-in SQLite). The harness refuses to start on older Node.
- **Directly:** `npm start` (compiles first). **Docker:** `docker compose up -d`. The Compose
  service deliberately has **no Docker socket**. To use `sandbox.mode: docker`, a person
  must opt in explicitly:
  ```
  export HARNESS_DOCKER_DATA_DIR="$(pwd)/data"   # absolute host path
  docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
  ```
  The Docker socket is host-root authority for the harness: only for a trusted, single-owner
  install. Say that when recommending it.
- **Logs** go to the process's stdout/stderr (`docker compose logs -f` under Compose). Useful lines:
  `session ready in … (tools …, store+recovery …, thread …)` and `first-turn timing …` (where a
  slow first message went), `durable store open`, `recovery in …` / `recovery blocked …`,
  `tools not registered … ` (a connector was down when the channel's store opened; the store
  re-opens by itself), `conversation store … failed and will be re-opened`.
- **Only one instance** per data directory (stores are locked) and per Slack app.

## Upgrading

1. Read what changed (release notes / the PR) for **breaking config changes** before pulling.
2. Stop the harness; back up `data/` (`cp -a data data.bak-$(date +%F)`).
3. `git pull`, `npm ci`, `npm run doctor`. Fix anything doctor reports (it flags legacy
   skill layouts, missing sandbox images, missing binaries).
4. Start it. Watch the log for `recovery …` lines and try `!status` in the admin channel.
5. If it goes wrong: stop it, restore the backup, start the previous version. Conversations held
   in the new version's stores are lost on a restore; Slack still has what was said.

Moving **to** the Durable conversation store (the change that introduced `durable/`) is
one-way in practice: old `sessions/*.jsonl` are left in place and never read, and existing
threads start a fresh conversation (backfilled from Slack, with a larger window than usual)
the first time they are spoken to. Back up first.
