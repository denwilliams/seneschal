# Commands you can tell people to run

## In Slack (typed by a person; you cannot run these)

Handled by the harness itself, without a model call. They act on the channel they are typed in.

| Command | What it does |
|---|---|
| `!help` | list of commands |
| `!status` | what this channel is configured with: model, models allowed, tools, sandbox |
| `!reload` (or `!config reload`) | reload `harness.yaml` for future turns. If the new file is invalid the **previous config stays active** and the error is shown. Idle sessions are rebuilt now; running turns finish on the old config |
| `!doctor` | check this channel's required binaries and env vars |
| `!models` / `!model <id>` / `!model reset` | list models usable here / set the channel default / clear the override. An agent may also switch a single thread itself |
| `!usage [today\|24h\|7d\|30d\|all]` | token and cost usage for this channel. `!usage channels 30d` works only in the review (feedback digest) channel |
| `!context` | estimate of a fresh conversation's context by prompt, skills and tools |
| `!memory` | this channel's memory |
| `!dream` / `!dream now` | the last consolidation pass / run one |
| `!skills` / `!library` | skills available here / skills other channels published |
| `!docs` | documents filed in the account library |
| `!feedback` / `!feedback resolve <id>` | limitations this channel reported / close one |
| `!schedules` | scheduled work in this channel |
| `!connectors` | connectors enabled here |
| `!connector-auth connect\|start\|complete …` | OAuth pairing for HTTP connectors |
| `!slack` | Slack user-token search status for the person typing |
| `!grants` / `!revoke <cap>` | runtime permissions and what can be requested / take one back. Revoking retires the channel's conversation store; it re-opens on the next message |
| `!env` | **names** of secrets available here, never values |
| `!reset` | start a fresh conversation in this thread (forks again from the channel's main conversation; the old fork is kept) |
| `!recovery` | work a restart interrupted that could not be safely resumed. `!recovery retry` re-runs the checks; `!recovery discard` gives up on everything interrupted in this channel |

## On the host (a person runs these in the repo directory)

| Command | Use |
|---|---|
| `npm run doctor` | pre-flight for the whole install: what each channel would get, host tooling, sandbox images, legacy skill layout. Run it after every config change and before every start |
| `npm run login` | sign in to a model provider (writes the harness's own credential store) |
| `npm run secrets -- list CHANNEL` | secret **names** for a channel |
| `printf '%s' "$TOKEN" \| npm run secrets -- set CHANNEL KEY` | set a channel secret from stdin or `SECRET_VALUE`; prints names and target files, never values. Also `remove CHANNEL KEY` |
| `npm run connector-auth` | authorize a connector from the host |
| `npm run slack-user-token` | store a Slack user token for user-scoped search |
| `npm run migrate-skills [-- --collection NAME] [-- --dry-run]` | move old flat `data/shared/skills/<skill>` directories into a collection. Never overwrites; stops before moving anything if a destination exists. Use `--dry-run` first |
| `npm start` | compile, then run. `npm run dev` runs from source and restarts on change |
| `npm test`, `npm run typecheck`, `npm run build` | for a developer, not for routine administration |

`CHANNEL` may be a Slack channel ID, a known channel name, or `#name`. Prefer the ID.

Docker: `docker compose up -d` (add `-f docker-compose.sandbox.yml` only for the sandbox
override, and set `HARNESS_DOCKER_DATA_DIR` first — see *Running it*).
