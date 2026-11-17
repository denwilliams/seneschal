# Runbook: symptom → what to check → what to do

Ask the person for the **exact text** the bot said and the relevant **log lines**. Don't guess
at a cause you have not seen evidence for.

| Symptom | Check | Do |
|---|---|---|
| The bot does not answer in a channel | Is it invited? A first reply needs a mention (or a DM); after that it follows threads it is in. Is `allowUsers` excluding the person? | `!status` there; fix `allowUsers` or invite the bot; `!reload` |
| "This channel is paused: … interrupted request(s) could not be safely resumed" | The reason is in the message; `!recovery` lists it | Fix the cause (restore the speaker in `allowUsers`, restore the connector/tool, re-allow the model), then `!recovery retry`. Only if the work is not wanted: `!recovery discard` |
| A reply says it was "Resumed after a restart" | Normal: a turn was interrupted and finished after the restart | Nothing. If it looks wrong, the interrupted effect is described to the agent as interrupted, so ask it what it did and did not finish |
| The first message in a channel or thread is slow | The `first-turn timing` and `session ready in … (tools, store+recovery, thread)` log lines say which phase. Usually: opening connectors (tools), Slack history read, or the model's first response | Slow connector → check that connector. Slow history → lower `context.threadBackfill`. Slow first token → provider/model, or a token refresh after idle |
| Model errors ("not supported", "model_error", unauthorised) | `!models`, `!model`; logs show the provider's message | A model refused for this login: choose another (`!model <id>`). Expired login: `npm run login` on the host. A model not in `models:` is rejected by design |
| A config change did not take effect | Did `!reload` succeed or print an error? Needs a **restart** if it was `.env`, Slack scopes/tokens, or startup-only settings | Fix the YAML error and `!reload`; or restart |
| A tool or connector is missing in a channel | `!connectors`, `!status`; log line `tools not registered …` | A connector that was down when the channel's store opened is re-registered when the store re-opens (automatic, or any `!reload`/grant). If still missing, it is not enabled for that channel (`share.connectors`) or its credentials are missing (`!env`, `!doctor`) |
| A skill is not visible | `!skills` in that channel; is the collection assigned (`share.skillCollections`)? Does it live in exactly one collection directory? Legacy flat `data/shared/skills/<name>`? | Assign the collection and `!reload`; `npm run migrate-skills -- --dry-run` for the flat layout; or write the skill into the channel yourself with `admin_save_channel_skill` |
| A skill is "read-only" and the agent cannot change it | By design for `ro` collections | If sharing edits is really wanted, `mode: rw` — warn that it changes what every holding channel runs |
| A reply appeared twice, or an answer never arrived after a crash | Reconciliation needs the Slack history scopes (`channels:history`, `groups:history`, `im:history`); check the log for "could not look for an earlier reply" | Add the scopes and reinstall the app. Two instances on one Slack app also cause duplicates — make sure only one is running |
| Errors opening a channel's conversation store, or "database is locked" | A second process owns that channel's `durable/` | Stop the other process. Never run two harnesses on one `data/` |
| Disk filling up | `data/channels/*/workspace`, `dreams/`, `backups/` (`keepLast`), `durable/` growth | Lower `keepLast` / `dreams.keepTranscripts`; prune workspaces with the channel's owner; do not delete `durable/` casually — it is the conversation history |
| Unexpected cost | `!usage channels 30d` in the review channel; per-channel `!usage 7d` | Restrict `models:`, lower `recentConversations`/dream models, or remove `bash`/web tools from a noisy channel |
| Agent in another channel is doing something wrong because of a skill | `admin_list_channel_skills`, `admin_read_channel_skill` for that channel id | Edit or delete that skill with the admin tools (logged). Don't copy memory or private conversation into it |

## Things not to do from here

- Do not tell anyone to disable isolation (shared memory, broad `share:`) to fix a single
  request. Find the narrow entry.
- Do not recommend `permissions.allowPermanent`, `bash`, `memoryWrite` grants, `sandbox` with the
  Docker socket, or `mode: rw` collections without saying what each hands over.
- Do not delete a channel's `durable/`, `workspace/` or `memory/` to "reset" it. `!reset` resets a
  thread; clearing a channel is a decision for the person who owns it, after a backup.
