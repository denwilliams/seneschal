# Recipes

Complete channel configurations, and what each one is like to use.

The point of the design is that these coexist in one harness without leaking
into each other: the project channel cannot see the house, the finance channel
cannot see either, and none of them share a workspace, memory or credentials
unless a line below says so.

See the [README](README.md) for setup, and
[Configuration](README.md#configuration) for every option.

## A household channel

Conversation, memory, and the ability to look something up. It inherits the
defaults, so no shell and no connectors — but it can read a web page, which is
what most household questions turn out to need.

```yaml
channels:
  general:
    description: Household questions, reminders, and general chat.
    preferences: |
      We are in Sydney. Keep answers short.
      Prices in AUD. Dates as "Tue 12 Aug".
```

That is the whole entry. It gets its own memory and workspace regardless, can
schedule reminders, and can open a link someone pastes:

> **you** @seneschal is this the right filter for the dryer? https://example.com/parts/lint-4820
> **seneschal** _reading `example.com/parts/lint-4820`…_
> That one is for the 8kg vented models. Yours is the 9kg heat pump — same shape, different depth, and the page lists 4823 for it.

Without a search provider it can follow a link but not go looking for one, and
it says so rather than guessing. Give the whole harness one and every channel
can search:

```yaml
defaults:
  web:
    search:
      provider: brave              # or tavily, or a self-hosted searxng
      apiKey: ${BRAVE_API_KEY}     # from .env, or a channel's own env file
      maxResults: 5
```

`${VAR}` is resolved per channel, exactly like a connector's token — so
`#engineering` can search on its own key by putting `BRAVE_API_KEY` in
`data/channels/<id>/env`, and nothing else in the account uses that key. A
channel whose environment cannot supply the key loses search and keeps
`fetch_url`, rather than failing to answer at all.

Self-hosting instead, which suits a harness already running on your own
hardware:

```yaml
defaults:
  web:
    search:
      provider: searxng
      url: http://searx.lan:8080   # needs `formats: [html, json]` in its settings.yml
```

## An engineering channel with real tooling

Shell access, sandboxed, with its own GitHub identity and a hard requirement on
the tools it depends on.

```yaml
channels:
  engineering:
    description: Build, deploy and debug the home services.
    model: openai/gpt-5.4
    thinkingLevel: high
    models: [deepseek-v4-pro, openai/gpt-5.4, openai/o4-mini]
    tools: [read, write, edit, ls, find, grep, sqlite, web, bash]

    # Enables reviewed local lifecycle guidance and the read-only GitHub
    # factory dashboard publisher. Issues are the task system for this work.
    factory:
      name: Home Services
      repositories: [acme/home-services]
      lifecycleSkills: [planning, implementation, review, commit-pr]

    # bash cannot be confined by path checks, so give it a container with only
    # this channel's workspace mounted. Offline until someone approves.
    sandbox:
      mode: docker
      network: none
      memory: 1g

    # Refuse to serve the channel at all if the tooling is not there, rather
    # than letting the model find out halfway through a task.
    requires:
      binaries: [git, gh, jq]
      env: [GH_TOKEN]
      onMissing: fail

    share:
      skillCollections: [software-development]   # data/shared/skills/software-development/
      memoryWrite: true
```

`GH_TOKEN` goes in `data/channels/<id>/env`, not the global `.env`, so it is
this channel's identity and nothing else can use it.

## A GitHub software factory

A channel becomes a software factory only when it has a `factory` block. Its
`repositories` are reviewed `owner/repository` names — the factory dashboard
never accepts a repository name from a model or Slack message. GitHub Issues
are the durable work records: planning and PRs should link to an issue rather
than treating Slack as the task tracker.

Factory-enabled channels receive four shipped, local lifecycle skills:
`factory-planning`, `factory-implementation`, `factory-review`, and
`factory-commit-pr`. They live in this repository and are selected explicitly
by `lifecycleSkills`; the harness never downloads or activates online skills.
To tailor one factory, save a channel-local skill with the same name. It shadows
the shipped copy only in that channel, so the customisation remains visible and
reversible.

The factory's live dashboard is a page of the web console, at
`<webConsole.baseUrl>/channels/<channel-id>/factory`; enable top-level
`webConsole` and put it behind your normal access proxy. Each time it is opened
(briefly cached) it reads open Issues, open PRs, recent merges and GitHub events
for the configured repositories with authenticated, read-only `gh` commands. Do
not expect private Issue/PR text to be hidden by the console URL. The agent's
`get_factory_dashboard_link` tool returns the link.

MVP limits: the dashboard does not create or update Issues, manipulate PRs,
merge, deploy, infer custom workflow state, or sync Linear/Jira. If `gh`, its
authentication, network access, or repository permission is missing, the page
marks that repository unavailable instead of fabricating status.


## A channel with selected CLIs

Some channels need a real command-line tool, but not an arbitrary shell. Enable
`exec` for that channel and name the exact commands and argv patterns the agent
may use. The harness calls the executable directly — no shell, pipes, redirects,
glob expansion or command substitution.

```yaml
channels:
  project-admin:
    description: Jira admin tasks for one project.
    tools: [read, write, edit, ls, find, grep, sqlite, web, exec]
    exec:
      commands:
        acli:
          description: Limited Atlassian CLI access for one project.
          command: /usr/local/bin/acli
          env:
            ACLI_TOKEN: ${ACLI_TOKEN}
          timeoutSeconds: 30
          maxOutputBytes: 200000
          allowArgs:
            - [jira, issue, view, "*"]
            - [jira, issue, search, "**"]
            - [jira, issue, comment, "*", "*"]
```

The model sees `cli__acli`, not a free-form shell. A request like "show me
PROJ-123" becomes one tool call with `args: ["jira", "issue", "view",
"PROJ-123"]`. A request outside the allowlist is refused before `acli` runs.

Common selected-CLI recipes:

| CLI | Useful argv patterns | Notes |
| --- | --- | --- |
| `acli` / Jira | `[jira, issue, view, "*"]`, `[jira, issue, search, "**"]`, selected transitions/comments | Scope tokens to one site/project where possible. |
| `gh` | `[pr, list, "**"]`, `[pr, view, "*", --json, "*"]`, `[run, rerun, "*"]` | Prefer GitHub's MCP/server API if it covers the job. |
| `aws` | `[cloudwatch, get-metric-data, "**"]`, selected `describe-*` operations | Use an IAM role/token with the same narrow permissions as the allowlist. |
| `gcloud` | selected `[... list]` / `[... describe]` forms | Keep project/region fixed in `args` or env rather than letting the agent switch. |
| `kubectl` | `[get, pods, "**"]`, `[describe, pod, "*"]`, `[logs, "*"]` | Do not expose arbitrary `exec`, `apply -f -`, context switching or secret reads. |
| `docker` | `[ps]`, `[logs, "*"]`, selected `compose` actions | Treat Docker as host-level power unless wrapped very tightly. |

Use fixed `args` to bake in project, namespace or output format. For example,
this exposes only pods in one namespace, and lets the agent choose the remaining
safe flags:

```yaml
channels:
  ops:
    tools: [read, write, edit, ls, find, grep, sqlite, web, exec]
    exec:
      commands:
        kube_pods:
          description: Inspect pods in the production namespace.
          command: /usr/local/bin/kubectl
          args: [--namespace, production]
          allowArgs:
            - [get, pods, "**"]
            - [describe, pod, "*"]
            - [logs, "*"]
```

### When chaining becomes real shell work

`exec` deliberately does not do `acli | jq | xargs ...`. For simple chains, let
the agent make multiple tool calls: run the CLI with JSON/plain output, inspect
or filter the result, then run the next allowed command. For heavier chains,
write a reviewed wrapper such as `/usr/local/bin/acli-find-overdue` and expose
that as one configured command.

If the work genuinely needs ad-hoc pipes, temporary files, `jq`, or several
CLIs cooperating, use Docker-sandboxed `bash` instead. Put the channel in Docker
mode so `bash` sees only that channel's workspace, and install the CLIs in the
image or drop small wrappers into `workspace/bin`.

```yaml
channels:
  release:
    tools: [read, write, edit, ls, find, grep, sqlite, web, bash]
    sandbox:
      mode: docker
      image: harness-release:latest
      network: none
      memory: 1g
      timeoutSeconds: 120
    requires:
      binaries: [gh, jq]
      env: [GH_TOKEN]
```

Use `exec` when you want "the agent may do these CLI-backed operations". Use
Docker `bash` when you want "the agent may work like an engineer inside this
channel's workspace".


## A self-maintaining harness admin channel

The harness can apply its own reviewed PRs once a human explicitly gives the
final go-ahead in Slack. Keep the risky host operations behind one reviewed
wrapper rather than letting the agent improvise a deploy sequence each time.

First make sure the host process is managed by PM2 and that the process name is
stable, for example `harness`. Then expose the wrapper to the admin channel as a
restricted `exec` command. Use the real absolute path to your checkout; the
example below assumes `/srv/seneschal`:

```yaml
channels:
  admin:
    description: Admin and configuration questions for the harness itself.
    tools: [read, write, edit, ls, find, grep, sqlite, web, exec]
    preferences: |
      Make pull requests for harness changes.
      Do not merge or deploy until a human explicitly says to go ahead.
      After that go-ahead, use the self-maintain command to merge the approved PR,
      pull main, run npm install, build, and restart PM2.
    requires:
      binaries: [git, gh, node, npm, pm2]
      env: [GH_TOKEN]
      onMissing: fail
    exec:
      commands:
        self_maintain:
          description: Merge an approved Seneschal PR and restart the harness through PM2.
          command: /srv/seneschal/scripts/self-maintain.sh
          env:
            HARNESS_PM2_NAME: harness
          timeoutSeconds: 900
          maxOutputBytes: 200000
          allowArgs:
            - [--pr, "*"]
            - [--pr, "*", --merge-method, squash]
            - [--pr, "*", --merge-method, merge]
            - [--pr, "*", --merge-method, rebase]
            - [--dry-run]
```

A normal turn then looks like:

> **you** @seneschal go ahead and self-maintain PR #123
> **seneschal** _running `cli__self_maintain`…_
> Merged #123, pulled `main`, ran `npm install`, built, and scheduled `pm2 restart harness`.

`scripts/self-maintain.sh` defaults to the repo it lives in, branch `main`, and
a PM2 process it can autodetect from the repo path (falling back to `harness`).
Set `HARNESS_PM2_NAME` in the process environment or pass `--pm2 <name>` if your
PM2 process has a different name. The restart is scheduled a few seconds after
the wrapper exits so the agent can post its final Slack reply before PM2 replaces
the process; use `--sync-restart` when running it manually and you want to wait.

## An on-call channel that reports on a schedule

Reads what engineering learned, but one-way — engineering cannot see back.

```yaml
channels:
  ops:
    description: Alerts, on-call, and the morning summary.

    # The one channel allowed to read things on your own network. Off
    # everywhere else, because the harness sits inside it — "summarise
    # http://192.168.1.1" would otherwise be the router's admin page in Slack.
    web:
      allowPrivateHosts: true
      # With allowHosts set, these are the only hosts it can reach at all —
      # the local dashboards, and the vendors whose status pages matter.
      allowHosts: [grafana.lan, nas.lan, status.cloudflare.com, githubstatus.com]

    share:
      channelMemoryRead: [engineering]
      connectors: [grafana]
    permissions:
      approvers: [U01234567]   # only the on-call lead approves here
      durations: [15, 60]
      maxMinutes: 60
```

Ask it once for "a summary of overnight alerts every weekday at 8" and it
schedules that itself, posting to the channel with `post_message` rather than
burying it in a thread. With the hosts above it can answer the question that
follows an alert without anyone opening a laptop:

> **you** @seneschal is the API slow for everyone or just us?
> **seneschal** _reading `status.cloudflare.com`…_ _reading `grafana.lan/d/api-latency`…_
> Cloudflare reports degraded performance in APAC since 04:12. Our p99 tracks it almost exactly, and origin latency is flat — so it's them, not us.

`allowHosts` is a bound, not a hint: anything not on the list is refused, and
both lists match a domain and its subdomains rather than by string suffix, so
`notgrafana.lan` does not pass as `grafana.lan`.

## A channel that keeps to itself

No account knowledge, no shared memory, nothing that reaches the internet, one
cheap model it cannot switch away from, and only two people may talk to it.

```yaml
channels:
  finance:
    description: Invoices and bookkeeping.
    model: deepseek-v4-flash
    models: [deepseek-v4-flash]
    allowUsers: [U01234567, U07654321]
    # No web: nothing said here leaves the box, not even as a search query.
    tools: [read, write, edit, ls, find, grep, sqlite]
    permissions:
      grantable: []            # cannot even ask for more
    share:
      knowledge: false
      memoryRead: false
      memoryWrite: false
      library: false           # not even the shelf other channels share
      documents: false         # cannot see what the account has filed
      documentsAdd: false      # and an invoice attached here is never kept
```

With `grantable: []` it cannot ask for the web back either — the only way to
change this channel is a config edit someone can review.

`documentsAdd: false` is the setting to think hardest about in a channel like
this one. It defaults to **true**, because the point of the document library is
that attaching something is enough to keep it — but the library is readable by
every channel that has `documents: true`, so a supplier invoice filed from
#finance is an invoice #general can read. Attachments are still downloaded and
read here; they are answered from and then dropped.

## Channels that teach each other

One channel does the hard thinking; the others get the benefit. #ops may put a
skill on the shared shelf whenever it wants; #support has to ask a human first,
and the grant lapses by itself; #finance above never sees any of it.

```yaml
channels:
  ops:
    description: Alerts and on-call.
    share:
      libraryPublish: true     # trusted to publish for everyone

  support:
    description: Customer questions and escalations.
    permissions:
      # It can ask, one skill at a time. The approval message names the skill
      # and the reason, so the decision is made on the actual content.
      grantable: [network, web, skillPublish]
      approvers: [U01234567]
```

Publishing changes nothing for anyone by itself — it puts the skill on the
shelf. Another channel's agent has to find it with `list_library_skills`, read
it, and install it, which copies it into that channel where it becomes an
ordinary skill it can refine or delete. `!library` shows the shelf, who
published what, and whether anything you installed has been updated since.

`share.library` defaults to `true`, so every channel can browse and install
without configuration. Only publishing needs a decision.

### And documents they all read

The same shape, one shelf over. Attach a policy, a contract or a manual in any
channel and its agent reads it, summarises it and files it into
`data/shared/documents/`; every other channel finds it with
`search_documents` from then on.

```yaml
channels:
  hr:
    description: Policies and people questions.
    # Both halves are on by default; this is the channel where that matters
    # most, because it is where the documents everybody asks about arrive.
    share:
      documents: true
      documentsAdd: true
```

> **you** _(#hr)_ @seneschal here's the new leave policy _(leave-2026.pdf)_
> **seneschal** Read it — four weeks accruing monthly, ten days carry-over with a manager's sign-off, unchanged sick leave. Filed as `leave-policy-2026` under `hr`.

> **you** _(#engineering, a month later)_ @seneschal how much leave can I carry over?
> **seneschal** Ten days, and it needs your manager's approval. That's the 2026 leave policy, filed from #hr on the 3rd.

Unlike skills, a document is not installed anywhere: there is one copy, and the
channel that filed it is the only one that can replace or remove it. `!docs`
shows the shelf.

### A shared CLI tool, run only where it's named

`exec` (above) gives one channel a named CLI, entirely from config an operator
writes. The shared tool bin is the cross-channel version: #ops writes a small
script once, and other channels get to run it only where an operator has
explicitly said so — least privilege in both directions, since publishing a
tool and being allowed to run it are two different people's decisions.

```yaml
channels:
  ops:
    description: Alerts and on-call.
    share:
      sharedToolsPublish: true   # trusted to write scripts for other channels

  release:
    description: Deploys and release notes.
    share:
      sharedTools:
        deploy-notify:                  # must already exist in the shared bin
          allowArgs: [["--env", "staging"], ["--env", "production"]]
          env:
            NOTIFY_WEBHOOK: ${DEPLOY_WEBHOOK}
          timeoutSeconds: 30
```

> **you** _(#ops)_ @seneschal write a script that posts to the release webhook and put it somewhere #release can use it
> **seneschal** Published `deploy-notify` to the shared bin as v1. It runs nowhere yet — ask an operator to add it to a channel's `share.sharedTools`.

Once an operator adds the block above, `#release` gets a tool called
`shared__deploy-notify`. It always runs whatever `#ops` currently has
published under that name — unlike the skill library there is no copy, because
this is a shared *tool*, not a shared starting point. A channel that should not
pick up a change automatically can pin `sha256` (shown by
`list_shared_tools`), so an unreviewed update from `#ops` refuses to run there
until the pin is bumped.

Published scripts must start with a shebang line (`#!/usr/bin/env bash`,
`#!/usr/bin/env node`, …) and stay under 64 KiB — reviewable text, not opaque
binaries. Like `exec`, execution is argv-checked and never touches a shell:
`allowArgs` here is the *consuming* channel's own allowlist, separate from
whatever the publisher intended, because the operator configuring `release`
should not have to trust `ops`'s judgment about `release`'s blast radius.

The shared bin is never part of any channel's filesystem jail — not even the
publisher's own `bash` can `cat`/`cp` it directly. `publish_shared_tool` is the
only way in, and a `shared__<name>` tool built from a channel's own
`share.sharedTools` is the only way to run something.

## A channel that works on a software project

The channel workspace is a bind mount into the sandbox, so a repo cloned there
persists, and so does everything built in it. With `reuse: true` (the default)
the channel keeps one container, so `node_modules` and a warm build cache
survive between commands rather than being rebuilt every time.

```yaml
channels:
  project-acme:
    description: The acme-api repo. Triage issues, review PRs, small fixes.
    model: openai/gpt-5.4
    thinkingLevel: high
    tools: [read, write, edit, ls, find, grep, sqlite, web, bash]

    sandbox:
      mode: docker
      image: harness-sandbox-node:latest   # its own image, with a toolchain
      network: bridge                      # git and gh need to reach the network
      memory: 2g
      cpus: 2
      timeoutSeconds: 600                  # test suites take longer than a curl

    requires:
      binaries: [git, gh, node]
      env: [GH_TOKEN]
      onMissing: fail

    share:
      skillCollections: [software-development]   # read-only; { name: ..., mode: rw } to let the agent edit it
```

The stock sandbox image has `git`, `gh`, `jq` and `ripgrep` but no language
toolchain, so give a project channel its own:

```dockerfile
# Dockerfile.sandbox-node
FROM seneschal-sandbox:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
  && rm -rf /var/lib/apt/lists/*
USER sandbox
```

```bash
docker build -f Dockerfile.sandbox-node -t harness-sandbox-node:latest .
```

A second project is a second channel with a second workspace — they cannot see
each other's code, and each keeps its own container.

### In practice

Set it up once:

> **you** @seneschal clone https://github.com/acme/acme-api into your workspace
> **seneschal** ⏳
> _running `bash`…_
> Cloned. It's a TypeScript service — `src/` with Fastify routes, `test/` on
> node:test, Postgres via docker-compose. 340 files, main is 2 commits ahead of
> the last tag.

Then use it like a colleague who has the repo checked out:

> **you** @seneschal the nightly build is red — have a look
> **seneschal** ⏳
> _running `bash`…_
> `test/orders.test.ts` fails on `applies bulk discount`. It expects 45.00 and
> gets 45.000000001 — the discount path switched to floating point in `a91c4f2`
> ("simplify pricing"). The other money paths use integer cents.
> Want me to fix it the same way, or is the float deliberate?

> **you** fix it, same as the others
> **seneschal** ⏳
> _running `bash`…_
> Done — `applyDiscount` now works in cents and rounds once at the boundary.
> Full suite passes (84 tests). Pushed `fix/bulk-discount-rounding`.
> I can't open the PR: no network in this channel's sandbox.
>
> 🔒 *Permission request*
> I'd like *internet access for commands in this channel*.
> **Why:** to push the branch and open a PR with `gh`.
> `[15 min] [1 hour] [8 hours] [Deny]`

Click **15 min**:

> **seneschal** ✅ *internet access* approved by @den — for 15 minutes.
> Opened acme/acme-api#218 — "Fix bulk discount rounding". CI is running.

The branch, the checkout and the build cache are all still there tomorrow. The
network grant is not.

## A channel that runs the house

Home Assistant over MCP, defined privately to this channel so nothing else in
the account can reach the house.

```yaml
channels:
  home:
    description: Lights, heating, and the solar inverter.
    preferences: |
      Confirm before changing anything in a bedroom after 21:00.
      Report temperatures in °C.
    connectors:
      home-assistant:
        transport: http
        description: Home Assistant — devices, states and automations
        url: http://homeassistant.local:8123/mcp_server/sse
        headers:
          Authorization: Bearer ${HASS_TOKEN}
        # Read freely; keep the destructive surface small and deliberate.
        allowTools: [get_state, list_entities, call_service]
    share:
      knowledge: false
```

`HASS_TOKEN` goes in `data/channels/<id>/env` — a long-lived token to the house
should not sit in the global bundle where every channel's connectors could use
it.


### In practice

> **you** @seneschal is the garage door still open?
> **seneschal** Yes, since 18:42.

> **you** close it and turn the outside lights on
> **seneschal** Garage door closing. Outside lights on at 60%.

The `preferences` above are not decoration — they change what it does:

> **you** @seneschal turn on the lamp in Rosie's room
> **seneschal** It's 22:10 and that's a bedroom — confirm and I'll do it.

And it will do the boring recurring things if asked once:

> **you** @seneschal every night at 23:00 check nothing's left on downstairs and tell me if it is
> **seneschal** Scheduled as `7c2a91b4`. Next run tonight 23:00 (Australia/Sydney).

Which later shows up on its own:

> **seneschal** ⏰ *Scheduled* — check nothing's left on downstairs
> Kitchen bench lights and the study heater are still on. The heater's been
> running 4 hours. Want them off?


### Giving the house channel a shell of its own

The connector covers "turn the lamp off". It does not cover "work out why the
hot water runs at 3am", because that means pulling a month of history out of
the REST API, and nothing in `call_service` will do it. Add `bash` in a
container so the channel can build the tooling it keeps needing:

```yaml
channels:
  home:
    description: Lights, heating, and the solar inverter.
    tools: [read, write, edit, ls, find, grep, sqlite, bash]
    sandbox:
      mode: docker
      image: harness-home-assistant:latest
      # One long-lived container, so a venv or a half-written script is still
      # there on the next message.
      reuse: true
      # The house is on the LAN, and the REST API is a network call.
      network: bridge
      # `pip install` and `apt` need somewhere to write. The default read-only
      # root is right for a channel that only runs scripts; it is wrong for one
      # that is meant to accumulate tools.
      readOnlyRoot: false
      # Match the host user that owns data/channels/<id>/workspace.
      user: "1000:1000"
      memory: 768m
      timeoutSeconds: 300
    requires:
      # Checked on the HOST, not inside the image — so this asserts the sandbox
      # can start and the token exists, not what the image contains.
      binaries: [docker]
      env: [HASS_TOKEN, HASS_URL]
      onMissing: fail
    connectors:
      home-assistant:
        transport: http
        description: Home Assistant — devices, states and automations
        url: http://homeassistant.local:8123/mcp_server/sse
        headers:
          Authorization: Bearer ${HASS_TOKEN}
        allowTools: [get_state, list_entities, call_service]
    share:
      knowledge: false
```

Build the image once:

```bash
docker build -f Dockerfile.home-assistant -t harness-home-assistant:latest .
```

Or skip the `image:` line and the build entirely: copy the file to
`data/channels/<id>/Dockerfile` and the harness builds it on the first command,
rebuilding whenever you edit it. That is usually the better home for it, since
the tooling a house channel wants is specific to your house.

It carries `curl` and `jq` for the REST API, `mosquitto-clients` for MQTT,
`sqlite3` for a copy of the recorder database, `gnuplot-nox` to render a chart
straight to PNG, and `python3` with `venv` for anything larger.

The channel's env file (`data/channels/<id>/env`) is passed into the container
by name, so the same `HASS_TOKEN` the connector uses is already there for
`curl`:

```
HASS_TOKEN=eyJhbGciOi…
HASS_URL=http://homeassistant.local:8123
```

Where a tool *lives* decides how long it lives, and the three places are not
equivalent:

- **The workspace** (`/workspace`) is a bind mount on the host. A script, a
  venv or a cached CSV written here survives restarts, upgrades and reboots.
  This is where the channel's own tooling belongs.
- **The container layer** — `apt-get install`, or a `pip install` into
  `~/.local` — survives between messages but not a harness restart, because the
  container is removed on shutdown and recreated from the image.
- **The image** is the durable answer for anything slow to install. Edit
  `Dockerfile.home-assistant`, rebuild, restart the harness.

Worth telling the channel as much, so it stops re-installing the same thing:

```yaml
    preferences: |
      Confirm before changing anything in a bedroom after 21:00.
      Report temperatures in °C.
      Anything you want to keep goes in /workspace — installs outside it are
      lost when the harness restarts. Put reusable scripts in
      /workspace/bin and write a skill so you remember they exist.
```

#### In practice

> **you** @seneschal the hot water keeps running at 3am — can you find out why?
> **seneschal** ⏳
> _running `bash`…_
> Pulled 30 days of `sensor.hot_water_power` off the REST API. It's not
> random: 27 of 30 nights it starts within two minutes of 03:00, which smells
> like a schedule rather than a thermostat. `automation.cheap_rate_boost` fires
> at 03:00 daily — it was set for the old off-peak window, which moved to 01:00
> in April.
> Chart attached. Want me to shift the automation to 01:00?
>
> 📎 hot-water-30d.png

> **you** @seneschal do that energy summary again for last week
> **seneschal** ⏳
> _running `bash`…_
> Reused `/workspace/bin/energy-report.py` from last time. Attached — solar
> covered 62% of consumption, down from 71%, mostly the two overcast days.
>
> 📎 energy-week.png

If the harness itself runs in Docker, note the caveat in the README's isolation
section: sandboxing `bash` from inside a container means mounting the Docker
socket, which is effectively root on the host. On a Pi running only this,
`mode: host` for the house channel may be the more honest trade.

## Connectors: one catalogue, different identities

Defining a connector does not enable it. Two channels can enable the same one
and authenticate as different accounts, because `${VAR}` is resolved per
channel:

```yaml
connectors:
  github:
    transport: http
    description: Issues and pull requests
    url: https://api.example.com/mcp
    headers:
      Authorization: Bearer ${GITHUB_TOKEN}

channels:
  engineering:
    share:
      connectors: [github]     # uses data/channels/<eng>/env
  contractors:
    share:
      connectors: [github]     # uses its own GITHUB_TOKEN, scoped elsewhere
```
