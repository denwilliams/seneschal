# Seneschal

Self-hosted AI agents for Slack: one agent per channel, each with its own
memory, skills and tools.

Mention `@seneschal` in a thread and talk to it like a colleague. Behind that,
every channel gets its own agent with its own workspace, and nothing crosses a
channel boundary unless the configuration says it should. Seneschal runs on a
Raspberry Pi or in Docker, keeps its state in plain files, and needs no cloud
infrastructure and no inbound network access (Slack Socket Mode is outbound
only).

**Website:** <https://denwilliams.github.io/seneschal/> · Built on the
[Pi agent SDK](https://pi.dev/docs/latest/sdk) (`@earendil-works/pi-coding-agent`).

## Why it's interesting

- **Isolation by default.** Memory, files, skills, connectors and tools are
  per channel. Sharing is opt-in and explicit, and a connector being defined
  is not the same as a channel being allowed to use it.
- **The agent can't widen its own permissions.** It can propose configuration
  changes from an admin channel, but sensitive ones apply only after a person
  clicks approve. That includes the rules that guard it.
- **A software factory with a real merge gate.** Agent teams take a GitHub
  issue through implementation and independent review. Risk rules, required
  checks and commit-bound approvals decide what merges. Seneschal was
  developed partly through its own factory.
- **Untrusted text stays data.** Web pages, attachments and other channels'
  messages are treated as input, not instructions. Posting as a person goes
  through a separate reviewer agent that has no tools, plus a rate limit and
  secret checks.
- **Sandboxed shells when you want them.** A channel's `bash` can run on the
  host, in Docker, in Apple Containers or in Kiri sandboxes.
- **Durable.** Conversations, jobs and factory runs survive restarts, and an
  operator console shows sessions, tasks, usage and schedules.

Seneschal is a personal project, built for a home network and a small team. It
is not a hosted service.

## Reading this README

The rest of this file is the full reference, and it is long. Good places to start:

- [The idea](#the-idea) and [What it looks like](#what-it-looks-like): the model in two minutes.
- [Quick start](#quick-start): run it locally or with Docker.
- [Software-factory snapshots](#software-factory-snapshots): the issue-to-merge pipeline.
- [Posting as a user](#posting-as-a-user): a guarded, reviewed path for acting as a person.
- [Asking for permission](#asking-for-permission): how grants work.
- [RECIPES.md](RECIPES.md): worked setups. [docs/](docs/): design notes, including
  [heartbeats](docs/heartbeats.md) and [macOS Keychain secrets](docs/macos-keychain.md).

## The idea

Each Slack channel gets its own agent: its own memory, skills, connectors,
tools, files and preferences. **Channels are isolated by default.** Something
crosses a channel boundary only because the config says it should.

The one deliberate exception is the account knowledge base — a small shared
brain every channel reads unless it opts out. That is the "shared across the
account" part; everything else is opt-in.

```
   the harness ─────── skills/          ──── ships in the repo, on everywhere

                    ┌─ shared/knowledge  ──── read by every channel (default on)
   account level ───┼─ shared/skills     ──── collections of skills; assigned per channel (ro, or rw)
                    ├─ shared/global-bin ──── operator tools on every channel's PATH, read-only
                    ├─ shared/library    ──── shelf; channels publish and install
                    ├─ shared/bin        ──── executables channels publish; run only where configured
                    ├─ shared/documents  ──── what people attached, read by every channel
                    ├─ shared/memory     ──── read by default, written only if allowed
                    └─ connectors        ──── catalogue; defining ≠ enabling

   #general      workspace │ memory │ skills │ connectors │ tools │ prefs
   #engineering  workspace │ memory │ skills │ connectors │ tools │ prefs
   #ops          workspace │ memory │ skills │ connectors │ tools │ prefs
                     └──────── never shared unless configured ────────┘
```

## What it looks like

**Ask it something.** Mention it once, then talk normally in the thread.

> **you** @seneschal what did we decide about the router firmware?
> **seneschal** You held off on 7.14 — it broke the VLAN tagging on the AP. Sticking on 7.13.4 until that's fixed upstream.

It knows because someone told it earlier in that channel and it kept the fact:

> **you** @seneschal remember we're staying on 7.13.4 until the VLAN bug is fixed
> **seneschal** Noted.

**It can look things up.** Every channel can read a web page, so the answer to
"has that shipped yet" comes from the changelog rather than from a training set
that ended months ago:

> **you** @seneschal has 7.14.1 landed?
> **seneschal** _reading `mikrotik.com/download/changelogs`…_
> Yes — 7.14.1 went out on the 3rd, and "VLAN tagging on CAPsMAN interfaces" is in the fixed list. That's the one that bit you.

**It asks before it reaches further.** Nothing happens until you click:

> **seneschal** :lock: *Permission request*
> I'd like *running shell commands in this channel*.
> **Why:** to clone the repo and run the test suite against the branch.
> `[15 min] [1 hour] [8 hours] [Deny]`

Click *15 min* and it carries on where it stopped. The grant lapses by itself.

**It tidies up overnight.** Nobody asks it to:

> `data/channels/C07AB.../memory/DREAMS.md`
> **2026-08-09** — _3 conversations reviewed, 24 → 17 memories._
> Mostly the boiler and the failed Thursday deploy. Folded in that Kelly Heating does the service and that the freeze starts on the 15th — both said three times in different words. Dropped the printer questions from April; they are in the archive.

**Drop a document on it.** Attach a file and it is read, not refused:

> **you** @seneschal what's the notice period in this? _(contract.pdf)_
> **seneschal** Sixty days either way, clause 14.2 — and it auto-renews for a year if neither side gives notice, so the decision point is 1 October. Filed it as `acme-msa-2026` under `contracts`, so any channel can find it.

**Channels teach each other.** What one works out, another can install:

> **you** @seneschal the alert says the disk is fine but it clearly isn't
> **seneschal** There's a `grafana-alerts` skill in the library from #ops that covers exactly this — the panel title lies. Installed it and followed it: the query is aggregating across nodes.

**It can work on a schedule.** Say it once:

> **you** @seneschal every weekday at 8, post what's on the calendar and anything red in the dashboard
> **seneschal** Scheduled as `a3f1c2e8`. Next run: tomorrow 08:00 (Australia/Sydney).

**Ops-style channels can be given real tooling.**

> **you** @seneschal anything waiting on me in the repo?
> **seneschal** _running `bash`…_
> Three PRs need your review — #212 (config schema, 2 days), #209 (docs), #204 (dependency bump, CI red on an unrelated flake).

## Channel-topic usage indicator

Optionally put compact account-wide recorded model usage in one primary channel's
Slack topic. It refreshes every 15 minutes and aggregates rolling 1h and 24h
windows across all channels. The first number excludes cached tokens; the
bracket combines cache reads and writes; cost uses the existing estimated-cost
accounting. `~unknown` means no call in that window reported a cost; `+ unknown`
means the shown estimate is only partial:

```text
🤖 1h: 320k [+100k] ~$0.14 | 24h: 2.4M [+800k] ~$1.08
```

It is opt-in and will only replace an empty topic or a `🤖`-marked topic
created by the bot itself. A human-written topic is left untouched, even if it
uses the robot emoji. If both windows become zero, an indicator topic is
cleared once.

```yaml
channelTopicUsage:
  enabled: true
  channel: C0EXAMPLE01 # required public channel ID (starts with C)
```

This feature is deliberately *public-channel only*. Add the bot OAuth scope
`channels:write.topic` and reinstall the Slack app. The bot must also be a
member of the channel. Private channels (including IDs beginning with `G`) and
channel names are rejected by config validation; this avoids granting the
broader `groups:write.topic` permission.

## Browser artifacts

Set `webConsole.artifacts: true` when agents need stable browser links for generated HTML, images, reports, or other files. Artifacts are served by the [web console](#web-console)'s one web server, on its host, port and `baseUrl`; there is no artifacts-only mode, so `webConsole.enabled` must be on too. Every channel receives its own writable `workspace/artifacts/` folder. *Only* this folder is served; normal workspace files, attachments, memories, and transcripts are never exposed.

```yaml
webConsole:
  enabled: true
  artifacts: true
  # Bind locally when an HTTPS proxy shares this host. Binding to an interface
  # is supported too; protect that network path outside the harness.
  host: 127.0.0.1
  port: 3012
  # The browser-facing URL, including an optional reverse-proxy path prefix.
  # It need not match host/port. A proxy path prefix must be forwarded intact.
  baseUrl: https://harness.example.net
```

For Slack channel `C123ABC`, `data/channels/C123ABC/workspace/artifacts/report.html` is available at `https://harness.example.net/channels/C123ABC/artifacts/report.html`. Nested paths work and names are URL-encoded. The channel prompt includes its exact URL prefix, and `HARNESS_CHANNEL_ARTIFACTS` / `HARNESS_CHANNEL_ARTIFACT_URL` are also available to its shell.

When `baseUrl` has a path prefix (for example `/artifacts`), configure the reverse proxy to forward that prefix intact; the server serves the same `/artifacts/channels/...` path.

Artifact files live under `/channels/<id>/artifacts/`. Links created before this layout (`/channels/<id>/<file>`) no longer resolve.

The web server has no authentication **by default**. Enable [server-side Cloudflare Access validation](#cloudflare-access-session-validation), or place it behind Tailscale or another authenticating proxy/firewall that controls who can reach it; never place secrets, private attachments, memories, transcripts, or tokens in `artifacts/`. Artifacts, the console and `/api/status` share one origin, so every artifact file is sent with `Content-Security-Policy: sandbox allow-scripts allow-downloads; worker-src 'none'`: scripts in an artifact run in an opaque origin and cannot read the console or `/api/status`. It accepts only `GET` and `HEAD`, does not list directories, rejects traversal (including encoded paths), and opens every path component relative to an already-open directory descriptor without following symlinks. Artifact names are stable but browser responses revalidate so overwriting a file is visible promptly. The Docker image includes the required `python3`; a host install enabling artifacts also needs Python 3 available as `python3` (or set `HARNESS_ARTIFACT_PYTHON`).

With Docker Compose, publish the configured port only when it is needed (for a local proxy, `ports: ["127.0.0.1:3012:3012"]`; for externally secured direct access, use the appropriate interface rather than opening it on a home router by accident).

### Cloudflare Access session validation

A **Cloudflare Tunnel alone does not authenticate anyone**. For defense in depth against an accidentally public origin or a missing Access policy, the harness can require a cryptographically validated Cloudflare Access session itself:

```yaml
webConsole:
  enabled: true
  host: 127.0.0.1
  baseUrl: https://harness.example.net
  cloudflareAccess:
    enabled: true
    issuer: https://your-team.cloudflareaccess.com
    audience: YOUR_ACCESS_APPLICATION_AUD_TAG
```

1. In Cloudflare Zero Trust, create a **self-hosted Access application** for the console hostname. Protect the whole hostname (or every console, API, OAuth and artifact path if sharing a hostname), not only `/console2/`. Add an Allow policy limited to your operators and identity provider; do not use Bypass for the console.
2. Copy that application's **Application Audience (AUD) Tag**, not its name or client ID, into `audience`. Set `issuer` to your team's canonical `https://<team>.cloudflareaccess.com` origin, without a trailing slash, path, port, query or fragment. These values are not secrets. Custom issuer/key URLs are intentionally unsupported.
3. Keep Tunnel forwarding to the local listener and preserving the public Host. Access supplies `Cf-Access-Jwt-Assertion`; browsers may also supply the signed `CF_Authorization` cookie. Either must be a valid JWT for this exact issuer and audience. An invalid supplied assertion never falls back to a cookie. Plain identity headers and unsigned/forged cookies are never trusted.
4. Restart the harness after changing listener/auth configuration. Enabled mode with missing/invalid issuer or audience fails configuration/startup validation; it never falls back to public mode. Sign in through the public Access URL, then confirm the console's **Signed in as** line (validated email, or validated subject when no email exists). The harness returns no session token to JavaScript.
5. Verify unauthenticated origin access fails, for example `curl -i http://127.0.0.1:3012/console2/` and `/console2/api/v1/config`: expect **401**. Public browser access should work after Access login. A 401 does not start a new login flow: revisit the public Access URL to sign in again. Keep your system clock accurate.

The gate covers HTML, static assets/manifest/service worker, legacy redirects, `/api/status` (including the bare local path), all console APIs and GET/POST administration/actions, OAuth browser routes and artifact downloads. Existing Host, Origin, CSRF, action-switch and Slack approval checks still apply. Every admitted user is a fully trusted console operator; Access identity is **not** Slack merge approval or a new role system. Access configuration is startup-only: saving YAML without restarting does not change this listener's security policy.

Exceptions: `/health` remains a data-free unauthenticated liveness probe. `/mcp` is a separate, opt-in transport and retains its existing authentication/configuration: **set `webConsole.mcp.bearerToken` or otherwise protect it**; this browser-session setting does not secure MCP or unrelated Slack/provider ingress. Keep network/proxy access controls in place too.

Signatures use RS256 and keys fetched only from `<issuer>/cdn-cgi/access/certs` over HTTPS (no redirects). Issuer, application audience, required subject/issued-at/expiry and any not-before time are checked on every request. Keys are cached for at most ten minutes, with a thirty-second refresh cooldown and five-second fetch timeout; a cold/stale cache and failed key fetch denies access, while a still-fresh cached signing key can verify sessions during a transient outage. Key rotation refreshes through the same trusted endpoint. Open live streams/downloads are closed no later than JWT expiry. Validation is local, not per-request revocation introspection: a revoked Access session's already-issued JWT can remain usable until expiry, so choose a suitable Access session duration.

Protected static responses use `no-store`; the updated service worker does not cache protected shells/assets, so newly installed protected consoles do not open offline. APIs/identity are never cached. When enabling this on a previously unprotected console, clear that origin's site data/service worker caches on existing devices (an old cached generic shell cannot be remotely erased while offline). No tokens or user identity are stored in the offline shell. To roll back, remove/disable `cloudflareAccess` and restart **only after confirming equivalent external authentication**; disabling returns to the previous unauthenticated listener behavior.

### Software-factory snapshots

A channel can opt into a GitHub-backed software factory with a reviewed project
name and repository allowlist:

```yaml
webConsole:
  enabled: true
  baseUrl: https://harness.example.net
channels:
  engineering:
    factory:
      name: Home Services
      repositories: [acme/home-services]
      lifecycleSkills: [planning, implementation, review, commit-pr]
```

Factory channels use GitHub Issues as the durable task system and gain reviewed,
local planning, implementation, review and PR-hygiene skills. They are not
fetched from the internet. A channel may save a same-named skill to shadow a
shipped skill locally; it does not alter any other factory. The live, read-only
dashboard is the [web console](#webconsole2)'s Factory view at
`<webConsole.baseUrl>/console2/#/c/<channel-id>?view=factory`; the agent's
`get_factory_dashboard_link` tool returns it. It calls `gh` only with the
configured repository names. Configure `gh`, its GitHub token, and console
access controls in the channel/host policy as appropriate.

The dashboard does not write to GitHub, synchronise Linear/Jira, infer custom
workflow states, merge, or deploy (merging and deploying are done by a
[workflow run](#workflow-runs)). The dashboard marks GitHub data unavailable
when `gh` cannot read it; it never guesses a task state.

#### Merge rules

The software factory's workflow engine (see `docs/FACTORY_WORKFLOW_DESIGN.md` and [Workflow runs](#workflow-runs) below) merges a reviewed pull request by itself only if the factory's rules say so. Nothing does by default.

```yaml
    factory:
      name: Home Services
      repositories: [acme/home-services, acme/home-api]
      autonomy: balanced                # cautious | balanced | autonomous: how much it may do without a person (see below)
      merge:
        approvers: [U01ALICE1]          # Slack users who may approve or decline a merge or a deploy; default: the channel's allowUsers
        # autoMergeMaxRisk: 2           # set by `autonomy` (balanced: 2); set it here only to differ. 0 never merges by itself; 1-4 merges by itself at or under this risk
        method: squash                  # squash | merge | rebase
        sensitivePaths: ["infra/**", "**/migrations/**", ".github/**"]   # touching one makes the risk at least 4
        largeDiffLines: 800             # a change over this many lines makes the risk at least 3
        deployEnvironment: staging      # staging | production
      repositoryRules:                  # one repository's own rules, over `merge`
        acme/home-api: { autonomy: cautious }   # this repository is stricter than the factory
      announce: true                    # a status post per run, edited as it moves, with a thread under it (default true)
```

The reviewer scores each change `RISK: 1` to `5` (a missing or out-of-range score counts as 5). The engine only ever raises that score: by `sensitivePaths` and `largeDiffLines`. A change merges by itself only when all of these hold: the reviewer approved, the final risk is at or under `autoMergeMaxRisk`, the pull request is still at the commit that was reviewed, and GitHub reports at least one required check, all passing. A repository with no required checks always waits for an approver. Everything else waits for one of the `approvers`, whose approval is bound to the reviewed commit. The merge itself is `gh pr merge --match-head-commit`, so GitHub's branch protection stays the final authority. These rules decide what reaches a default branch, so the admin channel's config tools refuse to edit `factory.merge` and `factory.repositoryRules`.

##### Autonomy: how much of its own judgement a factory has

`factory.autonomy` is one word that sets a coherent risk appetite, so most projects need nothing else. Some repositories need every decision scrutinised; most are happy for the agent to do its best.

| Level | Merges by itself at risk | Waits for an answer before assuming | Review rounds before asking | Retries a failed stage itself |
| --- | --- | --- | --- | --- |
| `cautious` (the default when `autonomy` is left out: how a factory behaved before levels) | never: a person merges everything | forever | 3 | no |
| `balanced` | 2 or under | 24 hours | 4 | no |
| `autonomous` | 3 or under | 4 hours | 5 | once, for a stage that timed out or whose report was unusable |

Explicit settings beat the level (`merge.autoMergeMaxRisk`, `intake.assumeAfterHours`, `reviewRounds`, `autoRetries`), and a repository can have its own level or its own `autoMergeMaxRisk` in `repositoryRules`. The effective values are logged when the config loads (with a warning when an explicit setting beats a stricter repository level), shown on every run's status post and in `check_factory_run` / `check_factory_intake`, and carried in the console's run payload. The admin agent's config tools cannot change a level.

**No level loosens a gate.** A pull request still merges only if the reviewer approved it, every required check on the branch is green and the pull request has not changed since review (`--match-head-commit`); sensitive paths and big diffs still raise the risk; a branch with no required check still needs a person to merge; only trusted authors start runs; a comment never approves or merges; a deploy still waits for an approver. Those have no setting, so no level can move them.

#### Workflow runs

Factories can also use **Jira Cloud through ACLI** as their work tracker, with GitHub
retained for code and PRs. See [Jira configuration, authentication and operational
limits](docs/JIRA_WORK_TRACKING.md). Existing GitHub factories need no changes.

A software-factory channel whose team has the roles the workflow needs (`github_triage`, `coder`, `reviewer`; `cloudflare_deployer` is optional) works issues as *workflow runs*: one durable task per issue, carried by the harness through triage, the coder, review, a merge gate and deploy, each stage handled by its own subagent. A run survives a restart, and nothing about where it is lives only in the conversation.

The channel agent's tools (offered only to such a channel, never to a subagent):

| Tool | What it does |
| --- | --- |
| `start_factory_run` | Starts a run for an issue (`owner/repo#7`, its GitHub URL, or `#7` when the factory has one repository). The issue must be open and in one of the factory's repositories; an issue has one live run, and a channel has at most three (a run waiting for a person counts) |
| `check_factory_run` | One run (in a run's own thread: that one), or the recent ones: each stage's status (`not_started`, `in_progress`, `success`, `failed`, `skipped`) and attempts, the pull request, the reviewer's risk score and what the run is waiting for. In a direct message only the structure is shown |
| `factory_approve`, `factory_decline` | A person's decision at the merge gate (or the deployer's approval). Declining a run that is out of review rounds stops it |
| `factory_more_rounds` | Allow another coder/reviewer round when review hit its limit |
| `factory_decide` | Answer a run that needs a decision: a stage that **failed**, or one a restart interrupted. `retry` it, `skip` it (an optional stage, the deploy, only), `restart_from` an earlier stage (named in `stage`), or `abort`. `retry` also carries on a run that already ended `failed`, from the stage it failed at |
| `factory_answer` | Answer the question a run waiting for information is stuck on, in its Slack thread: goes on the issue as a comment marked as the agent's, and triage runs again |
| `factory_recheck_issue` | Read a run's GitHub issue comments again from where the run began and tell the run what is new: for a run stuck waiting on an answer that was given on the issue and never picked up. Approvers only; offered when intake is on; writes nothing to GitHub |
| `factory_abort` | End a run that has not finished |
| `create_factory_issue` | Files a GitHub issue for a request that has none yet, and optionally starts a run on it. Offered only when the factory turns it on (see below) |

Who may decide is **checked by the harness, not the model**: the speaking Slack user, as the session knows them, must be one of the factory's `approvers` (the repository's own list over the factory's, else the channel's `allowUsers`). An approval is for the commit the reviewer looked at, which the run records; if the pull request has moved, the run goes back to review. A run ends `completed`, `rejected` (a decision not to proceed) or `aborted` (a person stopped it). A stage that fails does **not** end the run: see [When a stage fails](#when-a-stage-fails).

**In Slack.** Each run has its own place in the channel, so nobody has to ask the agent where it is:

- **A status post.** Starting a run posts one top-level message that the harness edits in place as the run moves: the issue, a line of stage markers (`✅ triage → ✅ implement → 🔄 review (round 2) → ⬜ merge → ⬜ deploy`), the status, the risk score once review has given it, the pull request, elapsed time and cost. It is not part of any conversation: the harness writes it, and neither it nor its edits ever reach the agent. If someone deletes it, the next change posts a fresh one. Edits are gathered to at most one every few seconds; the end of a run is always drawn. The agent's reply to `start_factory_run` links to it.
- **A thread under it** that hears only what matters: a stage finishing (with its verdict and a one-line summary), review sending the run back with its findings, the run waiting (naming the people who can answer), a stage that needs a decision, and the end. Not tool calls. A restart or a repeated change never says anything twice.
- **Buttons while it waits.** **Approve** / **Request changes** / **Decline** at the merge gate (**Approve** / **Decline** for a deploy approval), **One more round** / **Stop** when review ran out of rounds, **Retry** / **Abort** when a stage failed or was interrupted. Only the factory's approvers can use them: the click is checked against the person who pressed it, exactly as a decision made through the agent is, and an approval is for the commit the reviewer looked at, whatever the button says. A button from an earlier wait, on a replaced post, or pressed twice does nothing and says why (privately), and the post shows who decided. **Request changes** opens a feedback form (1–3000 characters); cancelling it changes nothing. Submitting returns the same run and PR to the coder, then independent review and all applicable merge authorization again. It uses the existing review-round budget: if exhausted, allow another round or stop. Feedback stays in the run's history and the coder's brief, and the status thread reflects the return for changes.
- **Steering from the thread.** A message in the run's thread reaches the channel agent like any thread reply, with the run named and where it stands, so "approve it", "one more round", "why did review fail?" and "stop" work where the run is, and the run id can be left out of the tool calls. The agent's tools still check who is speaking.
- **`announce: false`** turns the status post off. Replies then go in the thread the run was asked for in, if there was one.

In a direct message the shape of a run is shown, but not what was said: no issue title, summaries or reasons.

**When a stage fails.** The role failed or timed out, the coder was blocked, its report was unusable even when asked a second time, GitHub could not be read, or GitHub refused the merge: none of that ends the run. The stage shows `failed`, the run is `needs_decision`, and it **keeps its pull request, risk, rounds and every attempt**, so there is no need to start a new run and redo the earlier stages. Fix the cause (a token, a label, the role's setup or skills, more detail on the issue), then a factory approver answers:

| Answer | What it does |
| --- | --- |
| `retry` | Runs the same stage again as a new attempt (shown as "attempt 3"). It is not a new round, and nothing the run knows is cleared. The role is resolved when it starts, so a fixed setup is what it runs with, and its brief includes what trusted people added to the issue meanwhile |
| `skip` | Moves on without the stage. Only an optional stage can be skipped (the deploy); skipping triage, implement, review or the merge is refused |
| `restart_from <stage>` | Goes back to an earlier stage when the earlier work has to change. Later stages start again, every attempt stays on the record, and the loop guard applies: a stage that is out of rounds holds the run for a person first |
| `abort` | Ends the run. What it already did on GitHub stays there |

In Slack the status post says "Stage failed" with the stage and attempt, the thread tells it once (with the reason and the choices that apply), and **Retry** / **Abort** are buttons; `skip` and `restart_from` are said in the thread or to the agent. A run that already ended `failed` (older runs, or the few things that cannot be recovered, like the factory being removed) is carried on by `retry`, from its failed stage, on the same record, if its issue is still open and nothing else is live for it. Only what cannot be recovered ends a run `failed`: its record or workflow is unreadable, or the factory or a role it needs is gone. Screenshots are in `docs/screenshots/factory-retry/` (`npm run shots:factory-retry` in `web/console2` regenerates them; it needs Pillow to shrink them).

**Audit.** Every start, approve, decline, more-rounds, decide (with the answer and, for `restart_from`, the stage), reopen and abort, every issue filed or refused (`issue_created`, `issue_refused`, `issue_failed`), and every merge (automatic merges as `auto_merge`, with the model's risk score, the final one and why it was raised), is a line in `data/shared/audit/factory-runs.jsonl`.

**Filing an issue for a request that has none.** A request can arrive with no GitHub issue: a Slack message here or in another channel, a pasted email, a support ticket. Run workflows start from an issue, so a factory can let its agent file one first. It is **off by default**, because it writes to GitHub as the channel from text that may have come from anyone:

```yaml
channels:
  engineering:
    factory:
      name: Home Services
      repositories: [acme/home-services]
      issues:
        create: true              # off by default
        labels: ["status:triage"] # put on every filed issue; the harness creates any that are missing
        maxPerHour: 10            # per channel; survives a restart
```

With it on, the channel agent has `create_factory_issue` (never a subagent). It is used only when a person asks for the work to be filed or built, and the agent writes the issue itself from what they asked: a clear problem statement with acceptance criteria. With `startRun` it also starts a run on the new issue, so "file and build this" is one step; without it the issue is only filed, and a run starts later when someone asks. The harness treats what the agent wrote as data on its way to GitHub:

- the title is one line of at most 200 characters, the description at most 7,000; control and bidirectional-override characters are removed;
- an `@mention` is put in a code span so it cannot notify anyone, a closing keyword (`fixes #3`) has its target put in a code span so it cannot close another issue when the text is copied into a pull request, HTML tags are escaped and a Markdown image is made text (fenced code is left as written);
- the labels come from configuration, never from the model;
- the issue ends with a footer saying the harness's factory agent filed it, from which Slack channel and thread (a direct message only says so), and at whose request;
- the same title asked for twice in 15 minutes from one channel is one issue: the second request gets the first issue back, if it is still open;
- at most `maxPerHour` issues per channel per hour, counted from the audit file so a restart does not reset it. Every filing and every refusal is audited. A filing that GitHub refuses (the token may not write to issues, say) is reported plainly and does not count against the limit. One that fails on a label that is not there makes the [labels](#factory-labels) exist and is tried once more.

Setting `requireApproval: true` (an approver confirming each filing) is not built yet and is refused at configuration time rather than quietly ignored. `factory.issues` is the operator's to change: the admin channel's configuration tools refuse it.

**From another channel.** A channel that may delegate to the factory (`share.delegateTo`) can hand it the request: "build acme/web#7", or "file and build: customers want the CSV export to include a header row". The factory channel's agent files and starts the run as the person who asked, so they are the one the approvers check and the audit names, and the delegation's outcome (the issue link and the run's status post) is posted back to the thread that asked. Without `issues.create` the factory agent says it cannot file issues and the person files one.

This is a file-backed migration: upgrading needs no database migration. Back up `data/shared/tasks/tasks.json` with the rest of `data/`; deleting it only clears task history, not conversations or schedules.


#### Factory labels

A factory works through GitHub labels: the roles move an issue along with `status:triage`, `status:ready`, `status:in-progress`, `status:in-review`, `status:approved`, `status:changes-requested` and `status:deployed`; a filed issue gets `factory.issues.labels` (default `status:triage`); and an issue carrying the intake go label (`factory:go`) starts a run whoever filed it. GitHub refuses a label that does not exist, so **the harness creates the missing ones itself**: nothing to set up by hand.

- **When:** for every factory channel that files issues (`factory.issues.create`) or watches for them (`factory.intake.enabled`) and whose team can run the workflow, at startup once the stores are open, once per process per repository, and again after a config reload that changes the repositories or the labels (the configured filing labels, the go label). It also looks again, once, when filing an issue fails on a label that is not there.
- **What:** it lists each repository's labels (all pages) and creates only the missing ones, in a neutral grey, described as created by the harness for the factory workflow. It never edits, recolours or renames a label that exists, so a label you styled yourself stays as it is. Names are compared without regard to case, as GitHub does.
- **Permission:** it uses the channel's own `GH_TOKEN`, which needs to be able to create labels (write access to the repository's issues). Without it the check fails, which is recorded, audited as `labels_failed` with GitHub's reason (a line, bounded) in `shared/audit/factory-runs.jsonl`, and shown in the console; it never stops startup, a poll or a run, and is tried again no sooner than ten minutes later. Creation is audited as `labels_created` with the names; nothing is audited when every label was already there.
- **Where to see it:** the Issue intake block in the Tasks tab says, for each repository, whether the labels are all there, were created, or could not be checked and why, and when it last looked.

#### Issue intake

With **issue intake** on, the harness watches the factory's repositories and keeps every open issue mapped to a run, so "as long as the issue is there it gets picked up": a new issue starts a run, changes on an issue go to its run, a closed issue ends it. Slack, Jira and Linear can all become ways of putting something in the tracker (only GitHub is built; `source` is an enum so another slots in). It is **off by default**, polling only (no webhooks), and the operator's to change: the admin channel's configuration tools refuse `factory.intake`.

```yaml
factory:
  name: Acme
  repositories: [acme/web, acme/api]
  intake:
    enabled: true
    intervalSeconds: 120        # 60 to 3600, per repository
    goLabel: "factory:go"       # an issue with this label starts a run whoever filed it
    ignoreLabels: [wontfix, duplicate, invalid, "status:rejected"]
    maxStartsPerPoll: 5
    maxPerHour: 20
    needsInfoDays: 14           # a run waiting for an answer is rejected as stale after this
    assumeAfterHours: 0         # set by `autonomy` (balanced 24, autonomous 4) unless set here. >0: after this long with no answer triage goes on with stated assumptions (once), instead of waiting for needsInfoDays
    backfill: false             # true: also start the open issues from the last 30 days
```

**The mapping.** Per channel and repository the harness keeps `issue -> run` in an engine-owned store document, not in the agent's [state object](#channel-state) (a prompt-injected agent could edit that): the agent has no tool that writes it. An open issue with no mapping gets a run (after the trust, queue and cap rules below); an open mapped issue sends what changed to its run; a closed issue stops being polled and, if its run is still live and not past the merge, the run is aborted with reason `issue_closed`; a reopened issue gets a **new** run and the old one stays for history. `start_factory_run` registers the same mapping, so a person and the poller never give two runs for one issue.

**Who starts a run (trust).** Only a *trusted* author's issue starts one by itself: an owner, member or collaborator of the repository; an issue the harness itself filed (its footer **and** a filing recorded when it was made, since text can be forged); or an issue carrying the go label (only people with triage rights can add a label). Anyone else's is **held**: listed in the console and the day's intake note, and started only by the go label or by `factory_intake_release`, which is checked against the factory's approvers.

**No backfill, caps, queue, breaker.** The first poll only notes the time: issues filed before intake was turned on are *ignored* (the go label or a release still starts one). At most `maxStartsPerPoll` runs start per poll and `maxPerHour` per hour. Beyond three live runs a channel's eligible issues are *queued*, not lost, and start oldest first as runs finish. If more than 3 x `maxPerHour` new issues appear at once, the rest are held and one note says so. Pull requests, locked issues and issues with an ignore label are never started.

**Updates.** A comment, a label change, an edit to the title or description, or a reopen on a mapped issue reaches its run as a bounded entry (kind, author, `author_association`, a trusted flag, about 1,000 characters, at most about 20 kept). **Only trusted updates are put in a role's brief**, as information and never instructions, and only those since that stage last ran; an untrusted one (a stranger's comment) is recorded and shown in the console and goes no further. A comment can never approve or merge anything: approvals only ever come from the approvers. The harness's own comments are not updates.

**Waiting for information.** Triage's `NEEDS_INFO` no longer ends the run: it waits (`waiting`, reason `needs_info`) until a trusted update arrives, then triage runs again with it; with none in `needsInfoDays` the run ends `rejected` (stale). `REJECT` stays terminal.

**Polling.** One list call per repository per interval through `gh api` (the REST issues listing: every issue changed since the last poll, open or closed, with `author_association`; search is not used because it lags a freshly filed issue), comment fetches only for a mapped issue whose comment count grew, and an individual fetch for a quiet mapped issue every six hours to notice one that was deleted or moved. A poll never overlaps another for the channel, is jittered, and backs off (doubling, to half an hour) after an error or rate limit. It starts at boot, follows a configuration reload, and stops on shutdown. When a conversation files an issue with `create_factory_issue`, a poll is asked for at once, so the agent does not need to start a run for it.

**In Slack.** A run intake started has **no status post until it passes triage.** What stops at triage (rejected, stale, waiting for information, failed) and the issues a poll holds, queues or closes are lines in one **rolling intake note** per channel per day (one top-level post, edited with counts, and a thread of one line per event). From the moment a run passes triage it has its own status post and thread as before. With `announce: false` there is no intake note either. In the console the Tasks tab's **Issue intake** block shows the mapping, what is held or queued, and the last poll; each run's sheet lists the updates it received, marking the ones no role saw. Screenshots are in `docs/screenshots/factory-intake/` (`npm run shots:factory-intake` in `web/console2` regenerates them).

Tools: `check_factory_intake` (what is mapped, held and queued, and why) and `factory_intake_release` (start a held or older issue; approvers only), offered only when intake is on and never to a subagent. Every start, update delivery, release, closure, breaker trip and poll error is audited to `shared/audit/factory-runs.jsonl` (`start` with `origin: intake`, `intake_started`, `intake_updates`, `intake_issue_closed`, `intake_release`, `intake_error`, `intake_baseline`).

#### Unsticking a run

A run that is not moving is waiting for something. `check_factory_run`, the status post and its thread all say what, and how to get it going; this is the same list. In every case the run keeps its pull request, risk score and history.

| The run shows | It means | How to get it going |
| --- | --- | --- |
| `waiting` on **info** | Triage asked a question on the issue | Reply in the run's Slack thread (the harness puts your answer on the issue, marked as the agent's), or comment on the issue. Already answered and nothing happened: ask the agent to use `factory_recheck_issue`. Nobody answers: with `assumeAfterHours` it goes on with its stated assumptions; otherwise it is rejected as stale after `needsInfoDays` |
| `waiting` on **merge** | The rules did not let it merge itself (the reason says which: risk over `autoMergeMaxRisk`, **no required check on the branch**, a check failing or running, a sensitive path or a big diff) | **Approve** in the post or thread, or merge the pull request on GitHub yourself (the run notices). To stop it recurring: set `merge.autoMergeMaxRisk` and add a required check (branch protection) |
| `waiting` on **deploy** | A deployer role needs an approval | **Approve** or **Decline** in the post. To never deploy from the channel: `agentOverrides: { cloudflare_deployer: { enabled: false } }` |
| `waiting` on **rounds** | Review sent the work back as many times as `reviewRounds` allows | **One more round** or **Stop**. Raise `reviewRounds` for more by default |
| `needs_decision`, a stage **failed** | A role failed or timed out, its report was unusable, the coder was blocked, or GitHub refused the merge | Fix the cause (the reason says what), then **Retry**; or restart from an earlier stage, skip an optional one, or abort |
| `needs_decision`, a stage **interrupted** | The harness stopped while a stage that writes was running (the coder is run again by itself, up to twice; the deploy is not) | Look at the issue and the pull request, then **Retry**, skip or **Abort** |
| `failed` | Something that cannot be recovered, or an older run | Say retry: it carries on from the stage it failed at, if the issue is still open |
| `rejected` | Triage decided not to build it, or nobody answered in time | Add the go label to the issue, or ask the agent to start a run for it again |
| Nothing starts at all | The channel holds `maxLiveRuns` runs (a waiting one counts), or intake is off, or the issue is from someone who is not trusted | Finish or abort the waiting ones, raise `maxLiveRuns`, turn on `factory.intake`, or add the go label |

Fewer stops: the example config's `factory` channel is a working block that merges small, tested, low-risk changes by itself, lets triage go on with stated assumptions after a day, and leaves the deployer off. Triage and the coder are told to prefer going ahead on a stated assumption over asking, and to ask everything in one comment when they must.

### Web console

The harness has one web server, configured by one block, `webConsole`. It serves the console ([webConsole2](#webconsole2), at `/console2/`; monitoring views plus [configuration administration](#configuration-administration) and optional [console actions](#console-actions)), `/health`, `/api/status` and, when asked, [browser artifacts](#browser-artifacts), all on one port. The original server-rendered console is gone: its old addresses (`/`, `/channels/<id>`, and the timeline, artifacts and factory pages) redirect to the matching page of the new console, which now has all of them.

```yaml
webConsole:
  enabled: true
  host: 127.0.0.1
  port: 3012
  baseUrl: https://harness.example.net   # public URL, including any proxy path prefix
  artifacts: true      # serve /channels/<id>/artifacts/<file>; default false
  historyLimit: 100    # completed tasks kept in each /api/status response (1-1000)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Start the web server at all |
| `host`, `port` | `127.0.0.1`, `3012` | Bind address |
| `baseUrl` | (required when enabled) | Browser-facing URL, including any reverse-proxy path prefix |
| `artifacts` | `false` | Also serve each channel's `workspace/artifacts/` files |
| `historyLimit` | `100` | Completed tasks retained in each `/api/status` response, globally and per channel |
| `actions` | `false` | Let the console edit channel lists and act on software factory runs (retry, answer, abort, start, poll now). **No login**: see [Console actions](#console-actions) before turning it on |
| `mcp` | unset/off | Optional factory MCP server at `/mcp`; bearer token and setup: [Factory MCP](docs/factory-mcp.md). Writes also require `actions` |
| `oauth` | unset | Optional HTTP MCP OAuth callback; see [cross-device OAuth](#cross-device-slack-initiation-with-the-console-callback-opt-in) |

| Path | Page |
| --- | --- |
| `/` | Redirects to `/console2/` |
| `/channels/<id>` | Redirects to that channel in `/console2/` |
| `/channels/<id>/artifacts`, `/factory`, `/timeline` | Redirect to that channel's Files tab, Factory view and Timeline view in `/console2/` (old bookmarks and Slack links) |
| `/console2/` | **The console**: webConsole2, live monitoring and full operator configuration administration (see [webConsole2](#webconsole2)) |
| `/console2/api/v1/...` | The JSON and event stream behind it. Workflow runs are `channels/<id>/workflows` (the list) and `channels/<id>/workflows/<runId>` (one run with its attempts); an open run has a link of its own, `#/c/<id>?tab=tasks&run=<runId>` |
| `/health` | Liveness check: `{"ok":true}` |
| `/api/status` | Task status JSON for integrations (see below) |
| `/mcp` | Opt-in Streamable HTTP factory MCP adapter; [tools, permissions and remote-access setup](docs/factory-mcp.md) |

Everything above is one HTTP server on one port. `/health` and `/api/status` answer both at the bare path (a local probe straight at the listener) and below a `baseUrl` path prefix.


**Using a person's GitHub account for the token.** Many setups give the harness the owner's own token, so the agent's comments and the person's replies in the GitHub UI are the same login. The harness tells them apart without a second account: everything the factory agent writes to GitHub ends with a footer, *Sent by the factory agent (role) · run id* plus a hidden `<!-- harness:factory ... -->` marker. The engine puts the exact footer in every stage's brief, so the roles do not depend on a skill to know it, and filed issues carry the marker too. A comment from your own login with the footer at its end is the agent's and is not news; one without it, made outside a stage's working time, is **you answering**, and it carries a run waiting for information on. Quoting the agent's comment in a reply (GitHub's quote-reply) does not make your reply the agent's, because the quoted footer is not at the end. The one limit: a reply typed while a stage is actively running, on the same account, is taken for the role's (the audit file records it as `intake_own_comment_in_window`); post again after the stage ends. Moving an issue with the `status:*` labels is not news either. A dedicated bot account or a GitHub App avoids the whole question and is the cleaner setup. The footer is not left to the model: in a factory channel the harness installs a `gh` in the global bin (`shared/global-bin/gh`) that adds it to every comment, review, issue and pull request description written through `gh` or `gh api`, in the host shell and in the Docker sandbox, and refuses a write whose text it cannot see (an editor, `--fill`, a GraphQL mutation) rather than posting it unmarked. It stops an agent that forgets, not one that tries: the real `gh` by its full path or `curl` with the token skip it, and a channel without a `factory` block is not covered. If you keep your own `gh` in the global bin the harness leaves it and logs a warning. Updates written this way are marked "a person, on the token's account" in the run's sheet; screenshots are in `docs/screenshots/factory-shared-login/` (`npm run shots:factory-shared-login` in `web/console2`).

#### webConsole2

`<baseUrl>/console2/` is the console. It replaced the original server-rendered one, whose old addresses now redirect here. The home page is **Activity**: a newest-first cross-channel feed of posts, scheduled/conversation updates and interaction requests, with Slack links, accurate pending/resolved markers, and loading of older activity. The header's **Activity** button returns here from any channel. The same feed is available independently at `GET /console2/api/v1/activity`; see the [activity API, authentication, pagination and retention documentation](docs/activity-feed.md).

Selecting a channel opens the Durable Pi network playground-style view: a tree of channels and their conversations on the left, the transcript in the middle, and six tabs on the right.

| Tab | Shows |
| --- | --- |
| Session | Model and thinking level, context use against the model's window, tokens and cost (from `usage.jsonl`), sandbox and sharing flags |
| State | [Channel lists](#channel-lists), editable when console actions are enabled; the channel's [state object](#channel-state) as a read-only live tree with revision, size, last writer and recent changes; then memory and notes |
| Tasks | For a software-factory channel (or any channel with runs), **Workflow runs** first: one row per run with the issue, five stage markers (triage, implement, review, merge, deploy, each not started, in progress, success, failed or skipped, with its own icon as well as a colour), the run's status, the review's risk score and round; runs waiting for a person come first. A row opens a sheet with the stage timeline: every attempt at every stage with its verdict, a short summary, duration and cost, a link to that sub-agent's conversation, the PR, the merge risk, the merge rule that applies and how many people may approve (a count, never user ids), and what a waiting run is waiting for; a run whose stage failed says so on its row ("implement failed · attempt 2") and its sheet lists the answers that apply. Then jobs, active and recent tasks, schedules with next run and run history, approvals and held posts, conversations blocked by recovery, and a live feed of turns and tool calls |
| Tools | The tool set the agent holds, grouped by where each tool comes from, and connector status |
| Extend | Skills by source, skill collections and their mode, subagents, knowledge bases and connectors |
| Files | A read-only browser for the selected channel's workspace: directories, file metadata, and SQLite table/schema/row inspection. Below it, published [artifacts](#browser-artifacts) with download links (when hosting is enabled) |

Above the transcript a **Transcript | Timeline | Factory** control switches the main pane (the `view` URL parameter). **Timeline** is the channel's activity as a git-style graph: the channel agent on one lane, each subagent run forking off and merging back, with a summary, a toggle that hides tool calls and a filter by actor. **Factory** appears only for a software-factory channel: per repository its open issues, pull requests and recent merges, a seven-day chart, a filter, and a Refresh button; it refreshes itself every 30 seconds while the page is visible. The server reads GitHub through `gh` with the channel's own credentials and caches the result for a minute; a manual refresh bypasses the cache but is limited to once every ten seconds. A direct message's timeline shows what happened but not what was said.

**Workspace browser.** Available independently of artifact hosting, through the existing console access boundary (not a new public file server). Workspace files and database cells can contain sensitive data: grant console access accordingly. Direct-message workspaces are withheld. Symlinks are listed but never followed, including intermediate directories, the workspace root and SQLite WAL sidecars. Ordinary files have metadata only; no general file preview, download, editing or SQL editor is provided. SQLite detection uses its file header, not its extension. Views and virtual/shadow tables are excluded. Python 3 with its standard `sqlite3` module linked to SQLite 3.37+ is required (included in the harness image); `HARNESS_ARTIFACT_PYTHON`, if set for artifact hosting, selects the same helper interpreter here.

Directory and table lists have 100-entry pages; rows have 50-entry pages. Browsing stops at offset 10,000. Cells are display text limited to 256 characters, BLOBs show sizes, tables show at most 32 columns, and schema text stops at 8,192 characters. SQLite inspection copies a private, disposable snapshot of the database and its WAL (64 MiB combined maximum), opens that snapshot read-only, and leaves the original database and sidecars untouched. Changing databases may need a retry; pagination is not a transaction and directory order follows the filesystem. Helpers are limited to two concurrent requests, five seconds elapsed, three CPU seconds and 4 MiB output. Linux additionally enforces a 512 MiB process address-space cap; other platforms (including macOS, which can reject a cap below Python's existing mappings) have no address-space cap. Snapshot and result-size bounds still apply on every platform. Missing Python, invalid/oversized databases and exhausted limits produce bounded errors. The new JSON endpoints are `channels/<id>/workspace?path=<relative>&offset=0` and `channels/<id>/database?path=<relative>&table=<name>&offset=0&tableOffset=0` under `/console2/api/v1/`; they have the same console Host/Origin checks and no-store responses. Regenerate the light/dark/390px mock screenshots with `SCREENSHOTS=1 npx playwright test e2e/screenshots-workspace.spec.ts` in `web/console2/`, then optimise with `python3 scripts/shrink-pngs.py ../../docs/screenshots/workspace-browser` (Pillow required).

Screenshots of the Workflow runs list and sheet (light, dark and 390px) are in `docs/screenshots/factory-runs/`; regenerate them from the mock fixtures with `npm run shots:factory-runs` in `web/console2`.

The tree lists each channel's `main` conversation, its threads (each a fork of `main`, with the entry it forked from), scheduled and dream forks, and subagent runs nested under the thread that started them. State is live: one event stream (`/console2/api/v1/events`) announces tree changes and, for the thread you are looking at, streams the turn as it happens.

The conversation views are **read-only**: there is no composer and no interrupt, reset or fork. The **Admin** page separately grants full configuration administration (see below). It has no login of its own; enable [Cloudflare Access session validation](#cloudflare-access-session-validation) or protect it with an authenticating proxy/firewall. A tunnel alone is not authentication. It applies the same Host check as every route and refuses a cross-origin `Origin`, and it sends no CORS headers.

What the monitoring views will not show (the Admin editor is different: it shows the persisted config):

- **Tool arguments and results.** A tool call is its name, whether it finished or failed, and (in the Tasks feed) how long it took.
- **Anything a direct message said.** For a DM the shape is shown (who spoke, which tools ran, tokens, cost) but never the words: transcripts, task summaries, schedule prompts, memory files and streamed text are all withheld, the same rule as the [timeline](#subagents).
- Secret values, environment variable names, connector URLs and allowed-user IDs.

**Live versus closed stores.** A channel's durable store is locked by the harness process that owns it, so the console only reads stores that are already open in the running harness; it never opens one. The harness opens the store of every channel it knows at startup (channels that already have one first, so interrupted work is recovered before it announces itself; new ones in the background) and again after a config reload, so channels stay live. A channel that is not open, one configured only by name that Slack has not shown the harness yet or one the configuration rejects, shows its tasks, schedules, usage, memory and configuration (all read from files) but no threads or transcript, and says why.

**Building it.** The app is a Vite, React, TypeScript, Tailwind and shadcn/ui project in `web/console2/`, separate from the harness's own toolchain. The Docker image builds it (the `console2` stage of `Dockerfile.harness`). From a checkout, `npm run build` (and so `npm start`, which builds first) builds it too, through a `postbuild` step: it installs the app's dependencies on first use, skips the build when nothing has changed, and never stops the harness from starting (a machine with no network just says it could not build it). `SKIP_CONSOLE2_BUILD=1` skips it and `CONSOLE2_BUILD_STRICT=1` makes a failure fatal. `npm run console2:build` runs it by hand and shows the error. Until it is built, `/console2/` answers `503` and says so. For development, `npm run console2:dev` starts Vite and proxies `/console2/api` to a running harness (`CONSOLE2_TARGET`, default `http://127.0.0.1:3012`), and `npm run mock --prefix web/console2` serves fixture data with no harness at all. The wire types are in `src/console2/api-types.ts`.

**Installing it.** The console is an installable app (a PWA), so it can live on a phone's home screen or in its own window on a desktop, and its shell opens even when the network is down. It needs HTTPS (or `localhost`), which a proxy such as Cloudflare in front of the harness provides.

- **Chrome, Edge and other Chromium browsers:** an **Install** button appears in the console's header when the browser offers installation (or use the address bar's install icon). **Android:** the same button, or the browser menu's *Install app*. **iOS (Safari):** *Share → Add to Home Screen*; iOS offers no install button.
- **Behind an access proxy:** the page asks for its manifest with credentials (`crossorigin="use-credentials"`), so a session cookie from Cloudflare Access is sent with it. Without that the proxy would answer with a login page and the browser could not install the app.
- **What works offline:** only the app shell (the page, its scripts and icons), from a service worker that is registered on the first visit. The console is a live view, so **nothing from the API is ever cached or served stale**: offline, the app opens, a banner says *You are offline*, the connection badge says *Reconnecting*, and the tree says it could not load. It refreshes by itself when the connection returns.
- **What the worker never does:** it does not touch `api/` (the data and the event stream), only caches a response that is `ok`, same-origin and not redirected (an expired proxy session redirects to a login page, which must never be kept), and never touches a non-GET request. It is served with `Cache-Control: no-cache` so a new build replaces it, and the page's security policy allows a same-origin worker and manifest and nothing else.
- Everything it uses is addressed relative to where the console is served, so it works under any reverse-proxy path prefix. The icons are generated from `web/console2/public/icon.svg` by `node web/console2/scripts/make-icons.mjs`.

#### Task status: `/health` and `/api/status`

The harness records substantive work in `data/shared/tasks/tasks.json`: scheduled runs begin immediately; interactive turns create a record only after they use a substantive tool (code/file work, web research/downloads, uploads, or delegation). Plain chat replies do not add noise. Completed work is retained as channel history, while tasks interrupted by a restart are marked `abandoned` rather than left indefinitely in progress.

`GET /api/status` returns that state as JSON: every known or configured channel (including idle ones) with its state, active and recent work, plus global active/blocked/waiting work and recent terminal history, each history list capped at `webConsole.historyLimit`. `GET /health` is a liveness check that returns `{"ok":true}` whenever the web server is on. Like the rest of the console they have no authentication of their own: keep the server on loopback or behind your access proxy, and see [Host checking](#host-checking-and-reverse-proxies) below. (This replaces the old standalone task dashboard, its separate port and its token; the console's `/` page replaces its HTML page.)

Tasks may also carry a small list of public-safe `http(s)` links — for example related PRs, incidents, source threads, or reports. URLs in the original request are captured automatically; agents can add useful references with `add_task_links` while work is active. Links are shown with each task in the console and the API.

The Factory view is a page of the console app. It filters and refreshes without a reload, and auto-refreshes every 30 seconds while the tab is visible. The server reads GitHub through `gh` using the channel's own credentials and caches the result for a minute so open tabs cannot hammer it; a manual refresh bypasses the cache but is limited to once every ten seconds. Factory channels get a `get_factory_dashboard_link` tool that returns this view's URL.

The console is off by default because it shows harness internals that static artifacts do not. It has no authentication of its own, so keep it behind a proxy or firewall that provides it.

#### Configuration administration

**Admin** in the console header opens `/console2/#/admin`. This is a fully trusted **operator** surface, not the Slack agent's limited admin tools. It is available whenever the console is enabled, independently of `webConsole.actions`, and has **no authentication by default**; opt into [Cloudflare Access session validation](#cloudflare-access-session-validation) for application-side enforcement. **Cloudflare Zero Trust or equivalent must protect the entire console and its APIs, including GET and POST `/console2/api/v1/config` and `/console2/api/v1/secrets`** (below the configured base-URL prefix). Do not expose this server publicly without that protection. Access grants full configuration administration, including trust boundaries, commands, users and channels. Proxy identity is not Slack approval; the agent's existing edit policy is unchanged.

- **Raw YAML** edits the complete persisted file the harness was started with (including `HARNESS_CONFIG` when set), never an arbitrary client-supplied path. Raw text may include **literal secrets already in that file**. Environment references remain references; the API never returns expanded runtime configuration, credential stores or env-file contents. Do not paste resolved credentials into the editor; use existing environment references.
- **Basic settings** patches the same draft: global model/thinking defaults, existing channels' description, preferences, model/thinking overrides, and shared **connector definitions**. Uncheck **Explicit override** to inherit (or leave description unset). Forms preserve unrelated text, comments and references; a flow map containing an edited field may be reformatted. Shared YAML aliases that would change another field are refused; edit them explicitly in full raw mode.
- **Connectors** lists the account catalogue and supports adding unique names, editing and confirmed removal. The supported transports are **stdio** (command, argument rows and environment entries) and **HTTP** (URL and header entries). Click **Add environment/header entry** to include a new name/value row in the draft. **Connector YAML** edits only the selected definition, including advanced settings such as `oauth`, `description` and `allowTools`; basic edits never replace those settings. Valid changes follow you between connector form, connector YAML and full-config Raw YAML. Malformed YAML stays available to correct and blocks switching/saving rather than partially applying edits. Definitions do not grant channel access, and removing one never rewrites channel references or private connector definitions. All operations are draft-only until **Validate and save**, using the same loader validation, revision check, backup and reload flow. Other sections remain editable in full raw mode.
- Switching modes retains edits. Drafts survive navigating within the console but are **memory-only**, not local-storage or server drafts; closing/reloading the browser warns when unsaved changes exist. Copy your draft before reloading the persisted file after a conflict.
- **Validate** runs the authoritative startup parser, environment expansion, schema and cross-reference checks without writing. **Validate and save** repeats validation, compares the loaded SHA-256 revision, creates a private backup under the running data directory's `config-backups/` (last 30), and atomically replaces the real file while preserving its permissions and any config-path symlink. Operator and agent saves share one queue. A metadata-only audit entry records the save without configuration values.
- Save invokes the existing reload and displays its warnings: active turns may finish with old settings, and web server bindings, providers, data/auth paths and timers can require a **restart**. Save does not claim those settings are already active. Apply failures restore the previous file and attempt to reload it; an uncertain runtime or failed rollback is reported with a restart instruction. A newer host edit during reload is never overwritten by rollback. Network failure during save has an unknown outcome: copy the draft, inspect persisted state and reconcile before retrying.
- The config directory and backup location must be writable. Docker's default config mount is read-only; use the existing `docker-compose.admin-config.yml` override if operator writes are wanted. Comprehensive config forms are not included. **Secrets and restart** separately provides names/set status, write-only harness environment add/replace and an opt-in supervised restart. See [private storage, Compose setup, precedence, security and rollback](docs/secret-admin.md); use `docker-compose.secret-admin.yml` only behind the authenticated Admin boundary. Saved values apply on startup, not to running turns. Existing OAuth credentials and channel env-file editing are excluded.

Writes retain Host/origin and Fetch Metadata checks, require JSON plus a custom `x-console-admin: 1` header (not sendable by a cross-site form without a refused CORS preflight), and are bounded to 2 MiB and rate-limited. External authentication does not replace these cross-site protections. There are no CORS grants. The service worker excludes all APIs and never caches config data.

Screenshots (light, dark, 390px) are in `docs/screenshots/config-admin/`; regenerate with `SCREENSHOTS=1 npx playwright test e2e/screenshots-admin.spec.ts` from `web/console2`. The mock now uses the repository's config parser/patcher, so install the root dependencies as well as the console dependencies.

#### Console actions

The factory-run views are read-only unless the operator sets `webConsole.actions: true` (a restart applies it; the admin channel's config tools cannot change `webConsole`). Then a run's sheet in the Tasks tab says what the run is waiting for and offers what applies, and the Workflow runs section can start a run and poll GitHub now:

| Control | What it does | Same as |
| --- | --- | --- |
| **Verify my browser in Slack**, **Approve merge**, **Decline merge** | Verify your matching browser challenge in the run's Slack thread as a current approver, then authorize or decline the reviewed commit in the console. Verification alone does not approve a merge | `factory_approve`, `factory_decline` |
| **Retry**, **Skip this stage**, **Restart from…** | Answers a stage that failed or was interrupted. Skip is offered only for an optional stage; Restart from only to an earlier stage | `factory_decide` |
| **Abort run** (asks first) | Ends the run | `factory_abort` |
| **Answer the question** | Records the answer on the issue as a comment from the harness (marked with the agent footer, "answered in the web console") and triage runs again | `factory_answer` |
| **Re-check the issue** | Reads the run's issue comments again from where the run began | `factory_recheck_issue` |
| **Start a run for an issue…**, **Poll GitHub now** | Start follows the rules of `start_factory_run` (a configured repository, an open issue, one live run per issue, at most three live); poll asks intake for a poll now | `start_factory_run` |

**There is no general login.** Except for merge decisions, which require Slack verification, whoever can reach the console can do these, so turn it on only where the console is not public: on loopback, or behind your VPN or an authenticating reverse proxy. What keeps a stray request out:

- **Merge approval needs Slack identity, not proxy access.** On a merge wait, verify ONLY your own matching browser challenge in Slack; the authenticated clicker must satisfy the current factory/repository approver rules (or channel allowed users). An opaque HttpOnly, SameSite=Strict cookie binds that browser to this run, wait and reviewed commit for ten minutes; it is Secure on HTTPS and is lost on harness restart. Permissions are rechecked before the console action and in the service/engine. The decision records the actual Slack approver, never a user id supplied by the browser. Changed waits/commits and revoked permissions invalidate verification. Review approval is labeled **Review approved** and is not merge authorization. The risk threshold alone never promises automatic merge: required checks and other gates must pass.
- **Other consent stays in Slack.** Deploy consent, One more round, Stop, releasing a held issue and filing an issue remain unavailable from the console; direct merging is never an action. A raw `console` decision cannot authorize a merge.
- **A closed request shape.** `POST` only, `application/json` only, the custom `X-Console-Action: 1` header (a form on another site cannot send it, and the server never answers a CORS preflight), an `Origin` and `Sec-Fetch-Site` that are the console's own, a `Host` the server answers to (DNS rebinding), a 16 KiB body limit (17 KiB for list edits, including their request envelope), strict schemas that refuse unknown keys, and a limit of 20 actions a minute per caller and 60 overall.
- **A double click runs once**, and every refusal is a plain message.
- **Everything is audited** in `shared/audit/factory-runs.jsonl`: a `console_action` line (actor `console`, where it came from, the run, the action, the outcome) beside the service's own line for the same action. The run's history records the console for ordinary actions and the verified Slack approver for merge decisions. In a direct message channel the console shows structure only: a refusal is a fixed sentence, a started run does not echo its title, and the audit line carries no reason.

Screenshots are in `docs/screenshots/console-actions/` (`npm run shots:console-actions` in `web/console2` regenerates them). Merge authorization screenshots are in `docs/screenshots/merge-approval/`; regenerate with `SCREENSHOTS=1 npx playwright test e2e/screenshots-merge-approval.spec.ts` in `web/console2`.

#### Host checking and reverse proxies

Binding to loopback alone does not stop DNS rebinding: a web page can resolve its own hostname to `127.0.0.1` and read whatever the server returns. So the server answers only requests whose `Host` header (port ignored) is `localhost`, `127.0.0.1`, `::1`, the configured `host` (unless it is a wildcard such as `0.0.0.0` or `::`), or the hostname of `baseUrl`. Anything else, including a request with no `Host`, gets `421 Misdirected Request`. This covers every route: the console, `/health`, `/api/status`, artifacts and `/oauth/*`.

A reverse proxy must therefore forward the *public* `Host`, the one in `baseUrl`. With nginx that means `proxy_set_header Host $host;`; nginx's default, `$proxy_host` (the upstream address), is refused unless it is a loopback name. Cloudflare Tunnel and Caddy forward the public host by default. There is no artifacts-only mode: artifacts, the console and `/api/status` are one server on one origin, covered by the same optional Access session gate. The monitoring pages do not render secret values, environment variable names or allowed-user IDs and are read-only. The Admin page and config API instead expose the full persisted configuration and permit operator-level edits; protect both with Access validation or external authentication. An optional, separately gated HTTP MCP OAuth flow is described below; proxy identity never substitutes for Slack approval.

## Recipes

Complete worked examples — a household channel, an engineering channel with
sandboxed shell access, an on-call channel that reports on a schedule, a
locked-down channel, one that manages a software project, and one that runs a
house — are in **[RECIPES.md](RECIPES.md)**, each with what it is like to use.

## Quick start

**Node runtime policy:** the harness targets the current Node LTS (v24 today; the Docker images and CI
run it) and moves to the next LTS soon after it is promoted. The hard minimum is **Node >=22.19.0**
(built-in `node:sqlite`); the harness refuses to start on anything older. Check `node --version`.

```bash
cp .env.example .env                              # Slack + model credentials
cp config/harness.example.yaml config/harness.yaml
npm install
npm run login                                     # sign in to a model provider (or set a key in .env)
npm run doctor                                    # check config and host tooling
npm start                                         # compiles first, so it always runs current code
```

Or with Docker (recommended on a Pi):

```bash
cp .env.example .env
cp config/harness.example.yaml config/harness.yaml
docker compose up -d
```



## Using it

### When the bot replies

The rules are mechanical — there is no judgement call about whether a message
"seems to be for it":

| Where | Replies? |
|---|---|
| DM | Always |
| Channel, message @mentions the bot | Always |
| Channel, reply in a thread the bot is already in | Yes, no mention needed |
| Reaction in a DM, active bot thread, or on a bot message | Yes, as a reaction event |
| Configured read-trigger reaction on an accessible post | Yes, when explicitly enabled (below) |
| Channel, anything else | Never |

So it stays quiet in normal channel chatter, and you only need to tag it to
start a conversation. Once it has replied in a thread, keep talking normally.
Emoji reactions in that conversation are delivered to the agent too.

### Ask the assistant to read a post with a reaction

Opt in in `config/harness.yaml`:

```yaml
reactionTriggers:
  enabled: true       # default false
  emoji: robot_face   # default; Slack name without colons, not 🤖
```

An authorized human adding 🤖 now asks that post's **own channel assistant** to
read its full text, even without a mention or an existing assistant thread.
A reply is handled in its parent thread; a root post starts a thread beneath
it. Choose another standard or custom Slack emoji name with `emoji`. These
settings take effect on config reload (`!reload`); set `enabled: false` to
stop new read invitations. Existing reaction feedback in DMs/assistant threads
and on bot messages is unchanged, including when this feature is disabled or
a different emoji is used. Removing a reaction is not a read invitation.

**Slack setup:** subscribe to the bot event `reaction_added` under **Event
Subscriptions → Subscribe to bot events** (`reaction_removed` is optional for
existing feedback). Add bot OAuth scopes `reactions:read` (resolve the exact
post), `users:read` (reject bot/app actors), and `chat:write` (reply). Reinstall
the app after changing scopes. Normal message/backfill subscriptions and
history scopes still apply: `channels:history` for public channels,
`groups:history` for private channels, `im:history` for DMs and `mpim:history`
for group DMs, as appropriate. Channel-name resolution uses `channels:read`
or `groups:read`; ID-keyed configuration avoids relying on a name lookup.
Socket Mode must already be configured as for ordinary messages.

**Boundaries and limitations:**
- Channel posts must be in an explicitly configured `channels` entry, even if
  `allowUnconfiguredChannels` otherwise permits mentions. The bot must have
  access (normally membership); this feature never joins channels or falls
  back to a user's token/search. DMs obey `allowDirectMessages` and normal
  channel-resolution policy. Effective channel/default `allowUsers` applies.
- If the exact post cannot be fetched, its text is empty, or the reacting user
  cannot be verified as human, no read turn starts. Text only is ingested;
  attachments, files, unfurls and externally shared messages inaccessible to
  the bot are not fetched through this trigger.
- The post and its channel/message/thread timestamps are quoted as untrusted
  data. A reaction is a request to **read**, not approval to run commands,
  change config, merge or deploy. Existing tools and approval gates apply.
- Redeliveries use Slack's event identity and the normal durable delivery
  ledger, separately from the original post. A later remove/re-add is a new
  request. Bot/app reactions cannot trigger read invitations, including the
  harness's own acknowledgement reactions.

### Messages sent while the assistant is working

A new Slack message from the **same author** in the same active thread is
**steering input**, not a reply queued behind an answer its author had not seen.
Unthreaded follow-ups in an active DM steer that DM too; other threads/channels remain isolated. Idle
messages retain their normal session and reply behaviour. Commands still use
the command handler; internal jobs/delegations remain serialized rather than
being injected as user steering.

The Pi Durable runtime admits steering durably under the original response and
consumes all available follow-ups, in arrival order, at the next **completed
tool round**. A message arriving during session/attachment startup is held until
the initial request is admitted. Each input includes its Slack author and
original message timestamp, both in the model context and in a structured
`slack.steering` transcript entry. Redelivery does not generate a duplicate
queued turn or a separate steering reply; recovery groups steering with its
original reply and rechecks the author against current channel permissions.
Tools retain that author's approval authority and user credentials. Cross-author
messages cannot safely share this tool principal: they use the chronology-labelled
queued fallback below and execute as their own speaker, even when both users are
allowed in the channel. Recovery blocks legacy interrupted cross-author steering
rather than borrowing another person's authority.

**Provider/runtime limits:** the current runtime does not inject extra input
inside an already-running model request, and steering does not cancel tools,
rewind external effects, or inject into a delegated subagent's own conversation. If a
model finishes without another tool round, steering runs as a continuation at
its generation-completion boundary, with the response watcher kept open until
that continuation settles. Already-streamed text may be visible before the
correction. The injection window closes before final rendering (and the bounded
workflow-dispatch reminder); arrivals after that close, or when live admission
is unavailable, use a normal queued turn explicitly labelled as **sent during
the previous work, not a reaction to its final response**, with the original
author/time. Preparation is permission-checked before admission. If model work
fails, admitted steering is aborted with that response rather than replayed as
an unrelated later instruction.

No new configuration or provider-specific live-injection API is required.

### Canned-response buttons

Set `interactiveComponents.enabled: true` in `defaults` (or per channel) to let
an assistant use `ask_canned_response` in an active thread. It can present only
fixed canned choices: `yes`, `no`, `continue`, `stop`, and `cancel` — for
example `["yes", "no"]`. A click replaces the buttons and resumes the same
assistant thread with a structured response identifying the Slack user and the
selected value.

```yaml
defaults:
  interactiveComponents:
    enabled: true

channels:
  production:
    # Disable this one channel even when the account default is enabled.
    interactiveComponents:
      enabled: false
```

This is intentionally a small v1 surface: component values are checked against
the posting channel, thread, and fixed action ID before a turn is resumed. It
does not support custom scripts, arbitrary HTTP callbacks, or user-supplied
button actions. Enable **Interactivity & Shortcuts** in the Slack app setup;
Socket Mode needs no request URL.

### Sending any Slack message to an assistant

If the Slack app has a message shortcut called `Send to assistant` with callback
ID `send_to_assistant`, any allowed user can open the `⋮` menu on a Slack
message, review the original message text, add optional extra instructions, and
send it to an assistant channel. The original message text is copied unchanged;
the extra instructions field is for why the user is sending it. If
`shortcuts.sendToAssistant.defaultChannel` is set, the channel selector is
optional and falls back to that channel unless the user chooses another one. If
no default is configured, the user must choose a target assistant channel. The
harness posts a new top-level message in the target channel and runs the
selected channel's assistant in that thread, so follow-up discussion stays with
the assistant that has the right tools, memory and connectors.

Attached files from the source message are included by default, including
images. The target channel's model still decides whether images can actually be
seen; if it cannot, the agent is told to switch to an image-capable model or say
so. Non-image files are downloaded and staged into the target channel's
workspace, following the same rules as files posted directly there.

This shortcut is workspace-facing, so access is checked before the modal opens:
if `defaults.allowUsers` is set, only those Slack user IDs can use it. The
target channel's own effective `allowUsers` is also enforced on submit.

To make the shortcut send to one assistant by default while still allowing an
explicit override from the modal, configure a channel name, `#name`, or Slack
channel ID:

```yaml
shortcuts:
  sendToAssistant:
    defaultChannel: admin
```

### Letting one channel assistant transfer to another

The message shortcut is human-driven. A channel assistant can also hand work to
another assistant itself when the source channel is mostly coordination and the
target channel has the tools or context. Configure the source channel with an
explicit allowlist. Strings are accepted (`delegateTo: [engineering]`), but object
form lets the routing reason travel with the config:

```yaml
channels:
  life-admin:
    description: Project management and household admin.
    share:
      delegateTo:
        - channel: engineering
          reason: technical work needing bash, secrets and deploy context

  engineering:
    tools: [read, write, edit, ls, find, grep, web, bash]
```

That exposes `transfer_to_channel` in `#life-admin`. The tool posts a new
assistant thread in `#engineering` and starts the engineering agent there with
the copied task and context. When that initial engineering turn finishes, the
harness posts its result (or failure status) back into the originating
`#life-admin` thread, with a link to the delegated thread. This is the only
cross-channel write the handoff permits: the target assistant cannot otherwise
post into the source channel. It is for moving work to the channel with the
right tools, connectors, memory and local context, not for reading another
channel from the source.

Target names are resolved from the channel registry, so Slack channel IDs are
the durable option; names work after the harness has seen that channel at least
once. The target channel's effective `allowUsers` and `requires` checks still
apply.

"A thread the bot is already in" means one with a presence marker at
`data/channels/<id>/sessions/<thread>/`. It survives restarts with no extra
bookkeeping — you can see exactly which threads the bot is in by listing that
directory. The marker only records *participation*; the conversation itself
lives in the channel's conversation store (below).

**Each channel has a main conversation, and each thread is a fork of it.** Three
layers matter here:

| | Scope | What it holds |
|---|---|---|
| Channel main conversation | the channel's shared context | instructions, one-line digests of what recent threads did |
| Thread | a fork of the main conversation | what was said in that thread, in order |
| Channel | the isolation boundary | memory, skills, connectors, tools, files, model |

Conversations are stored in a per-channel [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
store at `data/channels/<id>/durable/` (SQLite). A thread starts as a *fork* of
the channel's main conversation at that moment: it sees what the channel knew
when the thread began (including digests of recent threads), then continues on
its own. Two threads in `#general` cannot see each other's messages, and
nothing a thread says is written into the main conversation — only short
digests are, by the harness. They share that channel's memory, tools and
workspace. Continuity across threads comes from memory (`remember` / `recall`)
and those digests, which is why the agent is told to save things worth knowing
next week rather than chat trivia.

A new top-level mention starts a new thread (a new fork). Replying inside an
existing thread continues that one, even days later: an idle-evicted
conversation reloads exactly where it left off. `!reset` re-forks the thread
from the main conversation's current tail (the old fork is kept) and leaves
memory alone.

**Restarts are survivable.** A turn that was running when the process stopped
is resumed (or, if it cannot be resumed safely, held for an operator) instead
of being lost, and a Slack redelivery or a crash can never produce a second
reply. See [Durable conversations](#durable-conversations-restarts-and-recovery).

### What it can see

Slack already holds the conversation, so when a new one starts the harness
reads the relevant part of it in. Tag the bot into a thread that has been
running for an hour and it gets the thread, not just the line that mentioned
it.

| Where you tag it | What it reads first |
|---|---|
| Into an existing thread | that thread, up to your message (50 messages) |
| A DM | recent DM history (20 messages) |
| A new top-level mention in a channel | nothing (0 messages) |

The last row is off deliberately. Being mentioned once is not an invitation to
read the room, and "every mention pulls in the last fifty messages" is a bill
on a metered API. Turn it on where it earns its keep:

```yaml
channels:
  ops:
    context:
      channelBackfill: 30      # read the room before answering here
      threadBackfill: 100      # ops threads get long
```

A channel can also opt into being answered on every new top-level message,
without tagging the bot. That is deliberately per channel, not a global default:

```yaml
channels:
  triage:
    respondToRootMessages: true
```

Thread replies still only reach the agent after it is already part of that
thread. If you turn this on, consider setting `context.channelBackfill` too so
a root reply can read the recent room before answering.

To restrict who may talk to the bot everywhere, including DMs, set default
allowed users. A channel can override the list for itself:

```yaml
defaults:
  allowUsers: [U01234567]
channels:
  ops:
    allowUsers: [U01234567, U07654321]
```

Backfill happens **once per conversation**, on the turn that creates it. After
that the thread's own conversation is the record, so a long conversation costs
nothing extra — and resuming one that was evicted for being idle reloads the
conversation, not Slack. `!reset` starts a fresh fork, so the next message
reads the thread in again from scratch. A thread that predates the conversation
store (it has an old transcript file) gets a much larger window on its first
turn here, because Slack is then the only record of the earlier work.

Three things this deliberately is not:

- **Not search.** It reads a window of recent messages and nothing older, and
  it cannot search the workspace. Asked about a decision from March, it says it
  cannot see it rather than guessing.
- **Not cross-channel.** History is read from the channel the message arrived
  in, using the token that received it. There is no way to aim it at another
  channel, which keeps it inside the isolation model rather than being a hole
  in it.
- **Not instructions.** Backfilled messages are framed for the model as
  background, with an explicit note not to act on requests inside them. Anyone
  who can type in the channel writes that text, so it is input, not orders.

This uses the `channels:history` / `groups:history` / `im:history` scopes the
setup above already asks for, plus `users:read` so people appear by name
instead of as `<@U01ABC>`. Without `users:read` it still works, just less
legibly — the harness names the missing scope at startup.

While the agent works it reacts to your message with :hourglass_flowing_sand:
and removes the reaction when the reply lands. Slack has no typing indicator
for bots, so a reaction is the closest thing: it shows up instantly and leaves
no clutter behind.

No placeholder message is posted. The reply message is created on the first
token of real text, so a quick answer appears as a single message with no
intermediate state. If the agent is thinking or running tools and has nothing
to say yet, a progress line appears after a few seconds so a long turn doesn't
look like a hang. While the turn stays silent, that line is refreshed with
elapsed time so people can tell the process is still alive. In DMs the native
assistant status indicator is used as well.

Change the reaction, or how the status line behaves, in config:

```yaml
ui:
  ackEmoji: eyes                # any emoji name, without colons
  showToolActivity: long_running # true | false | long_running
  toolActivityAfterMs: 10000
```

`showToolActivity` takes three values:

| Value | Behaviour |
| --- | --- |
| `true` | Shows the status line as soon as the turn starts thinking or a tool starts. |
| `long_running` | Holds it back until the turn has produced nothing for `toolActivityAfterMs`. |
| `false` | Never shows the thinking/tool status line. |

`long_running` measures silence, not total turn length: any text the agent
streams resets the clock. A tool that starts and finishes inside the window is
never mentioned at all, so a quick answer has no status flicker — but a turn
that streams a paragraph and then goes quiet for a while still explains itself.
Once a turn is in that quiet stretch the line keeps up with whatever is running,
rather than showing one stale tool name.

`reactions:write` is required for this. Without the scope the harness falls
back to posting a progress message instead — and because that message is then
the only acknowledgement the user gets, `long_running` shows it immediately.

Bang-commands are answered directly, without invoking the model:

| Command | What it does |
|---|---|
| `!status` | What this channel is configured with — model, tools, skills, connectors, what it shares |
| `!reload` | Reload the YAML config for future turns (`!config reload` is the same) |
| `!models` | Models available in this channel, with context size and price |
| `!model <id>` | Set the channel default model (`!model reset` to clear) |
| `!usage [today\|24h\|7d\|30d\|all]` | Token/cost usage for this channel; in the review channel, `!usage channels 30d` reports across channels |
| `!context` | Fresh-conversation context estimate by system prompt section, skill list, tool definitions, and not-yet-loaded memory/skill bodies |
| `!schedules` | Work scheduled in this channel, with next run times and latest errors |
| `!memory` | Show this channel's memory |
| `!dream` | The last overnight consolidation pass (`!dream now` runs one) |
| `!skills` | Skills available here, and whether each is the channel's own, shared or built in |
| `!library` | Skills other channels have published |
| `!docs` | Documents filed in the account library (`!docs <category>` narrows it) |
| `!feedback` | Limitations the agent has reported from this channel (`!feedback resolve <id>` closes one; `all`, `digest`, and the reviewer-only `resolve_feedback` tool work in the digest channel) |
| `!connectors` | Connectors enabled here |
| `!grants` | Runtime permissions in force, and what can be requested |
| `!revoke <cap>` | Take a runtime permission back immediately |
| `!env` | Names of secrets available here (never values) |
| `!reset` | Start a fresh conversation in this thread (memory is kept) |
| `!recovery` | Show work a restart interrupted that could not be safely resumed; `retry` re-runs the checks, `discard` gives up on it |
| `!doctor` | Check this channel's required binaries and env vars |
| `!help` | The list above |

`!reload` rereads the same YAML file the process started with. If the file is
invalid, the old config stays active and Slack gets the validation error. When
it succeeds, future messages and scheduled/dream/background runs resolve
channels from the new YAML, so channel config changes such as tools, models,
prompts, connectors, env layering, delegation targets, permissions and
respond-to-root settings take effect without a PM2 restart. Token usage is
recorded in `data/shared/usage/usage.jsonl` as one JSON line per observed model
response from normal Slack turns, dreams and recent-conversation summaries,
including channel, thread, source, provider/model, input/output/cache tokens and
estimated cost when the provider reports it; `!usage` reads that log for Slack
reports by channel and model.

Idle agent sessions
are disposed immediately and rebuilt on the next turn so old tools and sandboxes
do not linger in existing threads. Turns already running finish on the previous
config, then their sessions are rebuilt.

A few process-level things still need a restart because they are wired before
Slack starts or own live timers: Slack tokens/scopes, `dataDir`, `authPath`,
`modelProviders`, artifact hosting, and top-level `schedules`, `dreams`, backups,
and feedback digest timer settings. The reload command still applies the rest of the config
and reports a warning for these changes.

## Images

Attach an image to a message and the agent can look at it.

**This needs the `files:read` scope.** Without it Slack omits the `files` field
from the event entirely, so the harness never learns an image was attached and
the agent will tell you the attachment "didn't come through" — it is not being
evasive, it genuinely received nothing. The harness names this scope at
startup if it is missing.

Slack file URLs are private, so the harness downloads the file
with the bot token and resizes it before sending, since a full-size phone
screenshot is thousands of tokens on someone's own budget.

**The model has to support vision.** DeepSeek models are text-only, so on the
default `deepseek-v4-pro` an attached image cannot be read. Rather than
silently ignoring it, the agent is told an image arrived, that its current
model cannot see it, and which models in this channel can — it has
`switch_model`, so it can move to one if that is what you want.

`!models` marks the ones that can see images.

Up to 5 images per message are read. Anything that is not an image goes down
the other path — see **[Documents](#documents)** below.

## Documents

Attach a document and the agent reads it. Attach one worth keeping and it goes
on a shelf every channel can search.

**There is one library, and it is account-wide** — by default,
`<dataDir>/shared/documents/`. A document filed in any channel is found from every
channel that has `share.documents`. Nothing about a document is per-channel
except the decision to file it.

### Library storage location

Set the optional top-level `documentsDir` on the host to store just the library
elsewhere, independently of `dataDir`:

```yaml
documentsDir: /mnt/library/harness-documents
```

Omitting it preserves `<dataDir>/shared/documents`. Absolute paths are used
directly; relative paths resolve against the **repository root**, not the YAML
file's directory or the process's working directory. The harness creates the
selected directory if needed and uses it for originals, extracted text, metadata
and `INDEX.md`. It does not import/index arbitrary files already in that folder,
move existing documents, or delete the old library. Skills, channel workspaces
and attachment staging stay where they were.

This changes storage, not permissions: `share.documents` still controls reading,
`share.documentsAdd` still controls filing, and only the filing channel can
update/remove its documents. The selected library remains read-only to ordinary
file tools for channels allowed to read it; its parent and sibling directories
are not shared. Choose a dedicated directory, not a folder containing unrelated
private files. For Docker deployments, mount the chosen storage into the harness
container and configure its **container-visible** path, writable by the harness.

To move an existing library safely:

1. Stop the harness (including all writers) and back up the old library.
2. Copy the **entire contents** of the current library into a dedicated, empty
   destination, including every document directory's `original.*`, `text.md`,
   `document.json`, and the top-level `INDEX.md`. Preserve ownership/permissions
   and make sure the harness can read and write the destination.
3. Set `documentsDir`, then restart. Verify the document count, search/read a
   known document, and check a new filing before retiring the old copy.
4. If the library is outside `dataDir`, back it up separately: built-in backups
   archive only `dataDir` and do **not** include external storage. Stop writers
   when taking a consistent backup of both locations.

To roll back, stop the harness, copy any new/updated documents back into the old
library (reconcile removals too), restore the previous setting or omit it, then
restart. Changing the setting alone never synchronises the two copies.

> **you** @seneschal what's the notice period in this? _(contract.pdf)_
> **seneschal** _reading `contract.pdf`…_
> Sixty days either way, in clause 14.2 — and it auto-renews for another year
> if neither side gives notice, so the decision point is 1 October.
> I've filed it as `acme-msa-2026` under `contracts`.

Three months later, in a different channel:

> **you** @seneschal when do we have to tell Acme if we're not renewing?
> **seneschal** _searching the document library…_
> By 1 October — sixty days before the 30 November renewal. That's clause 14.2
> of the Acme MSA, filed from #legal in June.

### What happens to an attachment

An attachment is split in two the moment it lands, and the split is the design:

1. **The harness does the mechanical half.** Download, extract the text,
   checksum, provenance. The text goes to `attachments/` inside the channel's
   workspace, where the agent opens it with the same `read` it uses for
   anything else. The original goes to `channels/<id>/attachments/`, *outside*
   the jail — the agent has no use for a PDF's bytes, and the original is the
   record, so it should not be editable between arriving and being filed.
   Both of those are **staging, not storage**: they hold the last 40
   attachments per channel and are then pruned. Filing copies the original
   into the shared library, which is the only place a document is kept.
2. **The agent does the judgement half.** It reads the text and writes the
   title, the summary, the category and the tags. That part needs a reader: a
   filename and a first paragraph are not a description of what a document is
   for, and a summary guessed from either is worse than no entry at all,
   because it will be found by a search and then waste the reader's turn.
3. **The store keeps them apart.** Everything the agent supplies is metadata.
   Everything that has to be true — the bytes, the checksum, the channel that
   filed it, when — is derived by the harness and cannot be overstated by a
   tool call. The stored text is re-extracted from the original rather than
   read back from the workspace copy, so an agent that edits the staged text
   changes nothing about what the library holds.

| Format | How |
|---|---|
| Text, Markdown, CSV, JSON, YAML, XML, logs, source | read directly |
| HTML | the same strip `fetch_url` uses |
| PDF | bundled pdf.js, with `pdftotext`/poppler used first when present and a tiny built-in fallback last |
| `.docx`, `.pptx` | unzipped and stripped, in-process |
| `.doc`, `.xlsx`, images, archives, audio, video | refused, with what to do instead |

**PDFs use the bundled pdf.js reader.** Earlier versions avoided parser
dependencies and used only a tiny in-process scanner unless `pdftotext` was on
`PATH`; that was too weak for PDFs exported from design tools with custom font
encodings. Poppler is still used first when installed, because it is fast and
robust, but a host install is no longer required for ordinary text PDFs. Scans
still need OCR, which the harness does not include.

**A failure is an answer.** A scanned page has no text in it and no amount of
parsing invents any, so the agent is told which case it hit — a scan, an
encoding it cannot map, a format with no reader — in words it can repeat to the
person who attached the file. That beats "I can't open that", which is what it
used to say to everything.

### The shelf

Documents are account-wide, and there is exactly one shelf — unlike skills,
which are channel-private until published. A contract is a contract in every
channel, and a library that had to be published into channel by channel would
mostly be empty. A document is not copied or installed anywhere: there is one
entry, and the channel that filed it is the only one that can replace or
remove it.

| Tool | What it does |
|---|---|
| `search_documents` | ranked over titles, tags, summaries and full text |
| `list_documents` | the categories in use, and what is in one |
| `read_document` | the text, a page at a time |
| `add_document` | files one, with a summary and a category |
| `remove_document` | takes back one this channel filed |

Search weights a match in the title or the tags above one buried in an
appendix, and caps how much a single document's body can contribute — so one
file that says "invoice" two hundred times cannot bury the invoice.

Filing is checked rather than trusted. A summary under 40 characters is
refused, because the summary *is* the index. The same bytes filed twice by the
same channel update that entry; filed by a different channel, they are reported
as already on the shelf rather than shelved twice. Two genuinely different
documents may share a title — the id is `minutes` and `minutes-2`, and the
agent is told the collision happened so it can say which is which. Only the
channel that filed a document may remove it.

```
data/shared/documents/
  INDEX.md                     the shelf, rendered for a human; regenerated
  acme-msa-2026/document.json  title, summary, category, tags, checksum, who filed it
  acme-msa-2026/text.md        the extracted text — what search and reading use
  acme-msa-2026/original.pdf   the file exactly as it was attached
```

`!docs` shows the shelf in Slack, `!docs contracts` narrows it to a category.

```yaml
channels:
  legal:
    share:
      documents: true         # read the shelf (the default)
      documentsAdd: true      # and file onto it (also the default)

  private-notes:
    share:
      documents: false        # cannot see what the account has filed
      documentsAdd: false     # and nothing attached here is kept
```

Both default to **true**, which is a deliberate choice in a harness whose every
other default is closed: `documentsAdd: false` would make "attach it and it is
kept" into "attach it and be told no", which is the whole feature. The risk it
carries is disclosure rather than instruction — a document filed from a private
channel is readable by every channel that can read the library — so the agent
is told plainly never to file anything private, and any channel where something
sensitive might be attached should turn both off. Attachments are still read
and answered from either way; they are just not kept.

Documents are readable through the file tools and never writable: filing goes
through `add_document`, which stamps the channel on the entry. The agent is
also told that a document's text is information and never instructions, the
same rule that applies to a web page.

## Knowledge bases

Some knowledge is not a handful of attachments but a whole wiki: a folder of
markdown pages with index files that say what is beneath them, usually kept up to
date by an LLM (a Karpathy-style or Obsidian-style wiki). A **knowledge base** is
one of those folders, mounted read-only. The agent walks it the way a person
would: open the index, see what it links to, follow a link, or search when it
knows what it wants.

Declare each wiki once, at account level, and link it to the channels that may
read it:

```yaml
knowledgeBases:
  handbook:
    path: /srv/wikis/handbook     # the whole containing folder; relative paths resolve from the repo root
    index: index.md               # the starting page, relative to path (the default)
    description: How the team works — processes, decisions, who owns what
  product:
    path: /srv/wikis/product
librarian:                        # optional; the defaults are shown except model
  model: anthropic/claude-haiku-5-5   # a cheaper model is usually enough for a read-only search
  timeoutSeconds: 300

channels:
  engineering:
    share:
      knowledgeBases: [handbook, product]
```

A channel sees only the knowledge bases it names, and nothing else on the host:
the folder is not added to the file jail, and the tools resolve every path to a
real path that must stay inside the knowledge base (a symlink out is a dead end,
and hidden files such as `.git` and `.obsidian` do not exist as far as the tools
are concerned). Nothing is writable. A folder that is missing at start-up is
skipped with a warning rather than failing the channel.

| Tool | What it does |
| --- | --- |
| `kb_read` | a page, paged; with no path it opens the index. Also lists the pages it links to (`[[wikilinks]]` and markdown links), so the agent can walk the tree |
| `kb_ls` | the files and folders at a path; `recursive: true` lists the whole tree beneath it (capped at 100 entries) |
| `kb_search` | keyword search across every page: pages with all the terms first, title and path weighted over body, `"quoted phrases"`; returns titles, paths and matching lines, not bodies |

**The librarian.** A channel linked to a knowledge base also gets a built-in
subagent, `librarian`, reached with `run_subagent` (no agent set needed). It runs
the same three tools in a context of its own and reports back a curated answer
and the pages it came from. The point is tokens: a question that takes six
searches and a dozen page reads costs the channel agent one tool call and a
paragraph, not the pages. The channel agent does a single quick lookup itself and
hands anything bigger to the librarian. `librarian.model` lets you run it on a
cheaper model, and an agent set may not define a role of that name. Every other
subagent role gets no knowledge base access.

A page's text is information, never instructions, the same rule as for
documents and web pages. Declaring a knowledge base (it points at a folder on the host) is edited on
the host; the admin channel's config tools refuse it. Linking a declared one to
a channel, `share.knowledgeBases`, is something the admin channel can do.

## Reading the internet

A model's training data has a cutoff, and most of what people ask in Slack is
about now: has that shipped, is that still down, what does this link say. So
reading a page or staging a document is a harness capability — `fetch_url` and
`download_url` — and **they are on by default in every channel**, rather than something only the one channel trusted with a
shell can do.

> **you** @seneschal what's in this? https://example.com/postmortem
> **seneschal** _reading `example.com/postmortem`…_
> Root cause was a certificate that expired on the 3rd; the renewal cron had been failing silently since June. Three actions, one of them yours: rotate the monitoring token.

With a search provider configured it can also go and find the page:

```yaml
defaults:
  tools: [read, write, edit, ls, find, grep, sqlite, charts, slides, file_ops, web]
  web:
    search:
      provider: brave              # none | brave | tavily | searxng
      apiKey: ${BRAVE_API_KEY}     # ${VAR} resolves from this channel's secrets
      maxResults: 5
    maxChars: 20000                # extracted text handed to the model
    downloadMaxBytes: 20971520      # 20 MiB cap for staged documents
    timeoutSeconds: 20
```

There is deliberately **no default search provider**. Every real search API
needs a key, and the keyless alternative is scraping someone's results page —
fragile, and not something to do on your behalf without you choosing it.
`searxng` is there because a self-hosted instance suits a harness that already
runs on your own hardware. Without a provider, `search_web` is not offered at
all: a tool that is always present and always answers "not configured" just
teaches the model to stop trying.

### What it is, exactly

The web capability makes plain GET requests. `fetch_url` converts permitted responses to text; `download_url` stages arbitrary bounded responses as files:

- **No JavaScript.** A page that builds itself in the browser arrives nearly
  empty, and the agent is told to say so rather than fill the gap from memory.
- **Text only in `fetch_url`.** HTML, plain text, JSON, XML and CSV are handed
  to the model; a PDF or image is refused rather than turning into a screenful
  of binary. Use `download_url` for those files instead.
- **No credentials, no methods.** No headers you control, no POST, no logins.
  It cannot drive an API on your behalf; that is what connectors are for.
- **Bounded.** Text has a byte cap while reading and a character cap before it
  reaches the model. `download_url` has its own configurable 20 MiB default
  cap, writes bytes only to the calling channel's workspace, and never
  overwrites an existing file.

### Downloading PDFs and binary documents

`download_url` makes a public HTTP(S) GET and stages the response in the
calling channel's workspace. It is for PDFs, images, archives and other files
that `fetch_url` intentionally will not parse. It returns the final URL, safe
workspace path, content type and exact byte count; the agent can then attach
that file or use an appropriate workspace tool. The optional filename is
sanitised, response-provided names are treated as untrusted metadata, and name
collisions receive a suffix rather than overwriting anything.

It shares `fetch_url`'s host allow/block lists, private-address check, timeout
and manual redirect validation. A public URL that redirects to a router is
therefore refused before any file is written.

### It cannot reach your own network

This runs on a box **inside** your network, so the interesting URL is not
`example.com`, it is `192.168.1.1`. Private, loopback, link-local and CGNAT
addresses are refused: hostnames are resolved before connecting and every
address checked, and **every redirect hop is re-checked**, because a public URL
that redirects to your router is the attack, not the URL you typed.

Open it up per channel when that is what you want:

```yaml
channels:
  ops:
    web:
      allowPrivateHosts: true      # this channel may read the local Grafana
      allowHosts: [grafana.lan, status.example.com]   # empty = any public host
```

`allowHosts` (empty means any public host) and `blockHosts` bound it further,
and both match a domain and its subdomains rather than by string suffix, so
`notexample.com` does not pass as `example.com`.

The connection is pinned to the addresses returned by the policy-checked DNS
lookup while retaining the requested hostname for HTTP `Host` and TLS SNI. A
DNS rebinding answer therefore cannot turn a validated public URL into a LAN or
metadata request; each redirect gets a fresh validation and pinned connection.

### Page text is input, not instructions

Whoever owns a domain writes what is on it, so a fetched page is exactly as
trustworthy as a stranger typing into your channel — which is to say, it is
data. Every result is handed to the model wrapped in a note saying so, and the
system prompt says it again: if a page tells the agent to ignore its
instructions or fetch something else, that is the interesting thing to report,
not a request to comply. This is the same stance the harness takes with
backfilled Slack history.

It is not a guarantee. Prompt injection is unsolved, and the mitigation that
actually holds is the rest of the isolation model: a channel with no `bash`
cannot be talked into running anything, one with no connectors cannot be talked
into calling one, and nothing it reads reaches another channel.

### Turning it off

Drop `web` from a channel's tools and it has no way out of the box:

```yaml
channels:
  private-notes:
    tools: [read, write, edit, ls, find, grep, sqlite]   # nothing typed here leaves
```

It can then ask for it back — `web` is grantable by default, so the agent
requests, someone clicks, and it lapses on its own. `!status` shows what the
channel has: whether it can read pages, whether search is configured, and
whether the local network is in reach.

## Channel lists

Lists are first-class channel data, for todos, shopping lists, release checklists, and similar collections. They are shared by every thread in the channel and survive restarts. `list_read` and `list_update` are always available to the channel agent, independent of its configured tools; subagents get `list_read` only.

- **Storage:** `data/channels/<id>/lists.sqlite`, outside the workspace jail. Each list is a physical `list_<name>` table in that channel's dedicated database. No tool argument selects a channel, database path or SQL statement. Both tools and console use the same transactional storage and validation. Values are bound parameters; identifiers are validated and quoted. Database/sidecar hard links and symlinks (including ancestor directories) are refused. Keep channel roots operator-owned, not writable by sandbox processes.
- **Standard fields:** immutable, generated integer `id`; required, non-blank text `title`; text `notes` (default `""`); boolean `completed` (default `false`); system-managed UTC ISO `created_at` and `updated_at`. Only title, notes and completed are editable. Standard columns cannot be removed. IDs are never reused within a list.
- **Custom columns:** nullable `text`, `integer` (safe JavaScript integers), `real` (finite numbers), or `boolean`. New columns default to null on existing and future items. No SQL expressions or defaults. Removing one column preserves all items and unrelated values.
- **Names and limits:** list/custom-column names match `[a-z][a-z0-9_]{0,47}`. Up to 100 lists per channel and 24 custom columns per list; text values up to 4,000 characters and item data up to 16 KiB. The item bound counts UTF-8 JSON of all editable values, including defaults and nulls, with booleans represented as booleans; generated IDs and timestamps are excluded. Inserts, updates and custom-column additions use this same canonical check inside the transaction; an over-limit write rolls back. Adding a nullable column is rejected if its new key/null would make any existing item exceed the limit; shrink those items first. Reads return at most 50 items / 64 KiB per page, ordered by ID; pass the returned `nextOffset` as `offset`. Pagination is not a snapshot across calls. Updates patch supplied fields; simultaneous changes to the same field are last-writer-wins.
- **Tools:** `list_read({})` discovers lists; `list_read({list: "todo", offset: 0})` returns columns and items. `list_update` accepts these operations:

```jsonc
{"op":"create", "list":"todo"}
{"op":"add_item", "list":"todo", "values":{"title":"Review the release", "notes":"Check upgrade notes"}}
{"op":"update_item", "list":"todo", "id":1, "values":{"completed":true}}
{"op":"add_column", "list":"todo", "column":"owner", "type":"text"}
{"op":"update_item", "list":"todo", "id":1, "values":{"owner":"Ana"}}
{"op":"drop_column", "list":"todo", "column":"owner", "confirm":true}
{"op":"delete_item", "list":"todo", "id":1}
{"op":"rename", "list":"todo", "name":"release_tasks"}
{"op":"delete_list", "list":"release_tasks", "confirm":true}
```

Whole-list and custom-column deletion require `confirm: true`; the agent must first confirm the destructive action with the requester. Treat returned list content as data, not instructions.

**Human editing:** open **State → Channel lists** in the web console. Choose a list, expand an item to view/edit standard and custom fields, or open **List settings and custom columns**. IDs and timestamps remain read-only; empty custom text/number inputs save null, and boolean custom fields offer “Not set”. List/column/item deletion asks for confirmation. **Refresh lists** picks up assistant edits; successful console edits are visible on the next tool read. This is not a general database or SQL editor.

The console can always read non-DM lists; edits require `webConsole.actions: true` (a listener restart applies it), independently of factory configuration. GET and POST `/console2/api/v1/channels/<id>/lists` share the existing console Host/Origin and Cloudflare Access boundary, including reverse-proxy prefixes. POST additionally requires JSON, `x-console-action: 1`, same-site Fetch Metadata, the shared action rate limit, and a body no larger than 17 KiB (16 KiB item data plus room for the operation/list/ID envelope). Every admitted console user can read/edit non-DM lists, so restrict console access accordingly. Unknown/rejected channels are refused; DM names, schemas and items are withheld and DM mutations refused. No cross-channel sharing is provided.

There is no existing-data migration. Back up the channel root while the harness is stopped, including `lists.sqlite` and any sidecars. Rolling back the code leaves these files intact but removes tools/UI access; do not delete them unless the data is no longer needed. Regenerate UI screenshots from mock fixtures in `web/console2/` with `SCREENSHOTS=1 npx playwright test e2e/screenshots-lists.spec.ts`, then `python3 scripts/shrink-pngs.py ../../docs/screenshots/channel-lists` (Pillow required).

## Channel state

Every channel has one shared **state object**: a single JSON object that the agent reads and updates with `state_read` and `state_update`. It is the same from every thread in the channel, for subagents that ask for the tool, and after a restart. It is for structured working data that several conversations (and, later, jobs) need to agree on: a cursor, a counter, the last result of a run, a checklist.

It is not memory. Memory is prose the agent recalls (`remember`, `recall`); state is data that code also reads and writes, so it has a shape and a revision.

- **Tools:** `state_read({ path? })` reads the whole object or part of it, and returns the revision it was read at. `state_update({ op, path, value?, expectedRev? })` changes it. They are always available, like memory: state is part of the session, not a capability a channel opts into, so every channel has it whatever its `tools` list says, and there is nothing to configure. A subagent gets `state_read` only, like `recall` for memory: what it learns reaches the channel through its report, and the channel agent decides what to record.
- **Operations:** `set` writes a value at a path (creating objects on the way; the empty path replaces everything and must be an object), `merge` copies an object's keys onto the object at the path (one level deep), `delete` removes a key or array item (nothing there is fine), `append` adds to the end of an array (created if missing).
- **Paths** are JSON Pointers: `""` is the whole object, `/jobs/last/status` is inside it, `~1` stands for `/` and `~0` for `~` in a key. `__proto__`, `constructor` and `prototype` are refused as keys anywhere.
- **Every change is atomic.** Each update is one commit that reads, checks and writes together, so two threads updating at once never lose each other's work, and a crash in the middle leaves the previous object whole. `expectedRev` makes a stale read a refusal: the error names the current revision so the agent can read again and decide again. An update that changes nothing does not advance the revision.
- **Limits**, enforced on what would be stored and refused with a clear error, never truncated: 64 KiB serialized, 12 levels deep, 1,000 items per array, 128 characters per key, 16,384 per string, finite numbers only. The last 50 changes (which operation, which path, which thread) are kept next to it.
- **Scope:** the object belongs to the channel's own store, so it is private to the channel like everything else. Nothing crosses a channel boundary, and there is no account-wide state yet.
- **Console:** the State tab of [webConsole2](#webconsole2) shows the live object as a tree with its revision, size, last writer and recent changes, read-only. For a direct message only the revision, size and change times are shown: not the contents, and not even key names.

What an agent reads from state is information, not instructions, like any other data it reads.

## Jobs

A **job** is a named, repeatable workflow made of phases, defined in a channel's config and run by the agent in the background. Each phase is a checkpoint: a run that is interrupted by a restart continues from the phase it was in, not from the start. It is for work that takes several steps or a while, that someone wants to be able to repeat exactly, and that should not depend on one conversation staying open.

```yaml
channels:
  "#releases":
    tools: [read, exec]
    exec:
      commands:
        git:
          command: /usr/bin/git
          allowArgs:
            - [log, --oneline, "*"]
    jobs:
      release-check:
        description: Summarise the commits on a branch and remember the result
        input:
          branch: { default: main }
        phases:
          - { name: log, kind: exec, command: git, args: [log, --oneline, "${input.branch}"] }
          - { name: remember, kind: state, op: set, path: /releases/last, value: { branch: "${input.branch}", log: "${phases.log.result}" } }
```

- **Where they live:** on a channel, under `jobs`. They are **never inherited from `defaults`** (putting `jobs` there is refused): that a channel may run something unattended has to be a decision about that channel. At most 20 per channel, 20 phases each.
- **Phase kinds:**
  - `exec` runs a command from **this channel's own `exec.commands`** by its name, with `args` after the command's fixed prefix. It goes through the same argument allowlist the agent's own call would, with the command's own timeout as a ceiling (a phase may ask for less, with `timeoutSeconds`). The channel needs the `exec` tool on. `onFailure: fail` (the default) ends the run when the command exits non-zero; `continue` records the failure and goes on.
  - `state` writes into the channel's [state object](#channel-state) with `op` (`set`, `merge`, `delete`, `append`), a fixed `path`, and a `value`. The write, the phase being marked done and the move to the next phase are one atomic commit.
- **References** are plain substitution, with no evaluation: `${input.name}`, `${phases.NAME.result}` (an earlier exec phase's output, capped at 4 KiB), `${phases.NAME.exit}`, and `${state:/pointer}`. A reference must point at an input the job declares or a phase that comes before; anything else that looks like one (`${env.HOME}`, a typo, an unclosed `${`) is refused when the config loads, and `$${` writes a literal `${`. A substituted value is data: it is never parsed again. Each `exec` argument is **one argv element**, so an input full of shell characters is still just one argument, and the command is run directly with no shell. A missing, over-long (4 KiB) or NUL-containing value fails the run instead of being guessed. Because the allowlist is checked on the rendered argument, write `allowArgs` patterns that constrain the part an input fills.
- **Inputs** are named strings (at most 10), each with an optional `default` (without one it is required), a `maxLength` (default 256) and a `description`.
- **The agent's tools** (offered only to a channel that has jobs, never to a subagent): `list_jobs`, `run_job`, `check_job`, `job_decide` and `job_abort`. `run_job` returns at once with a run id. The prompt tells the agent to start a job when asked or when asked for exactly what it does, never on its own initiative.
- **A run is pinned.** It carries its definition and the SHA-256 of it from the moment it starts, so editing the config mid-run changes nothing for that run. A channel may have 3 live runs, and the same job cannot be running twice at once. Every run has a record (`check_job`, and the console) with each phase's status and a short summary; the full outputs stay in the run's record, not in the agent's context.
- **Restarts.** A `state` phase is atomic, so it simply carries on. An `exec` phase records that it has started *before* it runs the command and its result *after*, so a run found with a phase started and no result may or may not have taken effect: **it is never run again on its own.** The run goes to `needs_decision` and waits for a person to choose `retry` (which may repeat the effect), `skip` or `abort`, which the agent applies with `job_decide` *only* when a person tells it which. Before anything resumes, the [recovery gate](#durable-conversations-restarts-and-recovery) checks each live run against the channel's rules as they are now: a run whose job is no longer allowed (the `exec` tool removed, the command gone) is aborted with the reason, and a run whose record cannot be read is aborted rather than trusted.
- **Audit:** who started, decided and aborted which run goes to `data/shared/audit/jobs.jsonl`.
- **Console:** the Tasks tab of [webConsole2](#webconsole2) shows each run with its phases as a strip (done, running, waiting for a decision, failed), and the Extend tab lists a channel's job definitions and flags one its permissions would refuse. For a direct message only names, statuses and exit codes are shown: not output, reasons or inputs.

Not built yet: `approve` and `agent` phases, jobs proposed by the agent and approved by a person, jobs started by a schedule, and a mirror of runs into `/api/status`.

## SQLite databases

SQLite database work is a harness tool, not a reason to turn on `bash`. The
`sqlite` tool group exposes:

- `inspect_sqlite` — read schema objects, columns, indexes and foreign keys.
- `query_sqlite` — run one read-only `SELECT`, `WITH`, `PRAGMA` or `EXPLAIN`
  statement with optional parameters; the database is opened read-only in SQLite
  safe mode and rows return as JSON.
- `execute_sqlite` — run one intentional write or DDL statement against a DB
  path inside the channel's writable workspace.

Database paths are jailed the same way file paths are. Read-only operations can
inspect databases the channel may read; writes require a writable workspace path.
The tools require a `sqlite3` CLI with `-safe` support; the supplied harness
image includes it. For a host install, provide a current SQLite CLI with that
option. Database rows are treated as information, not instructions.

## Gated task workflows

For simpler multi-step work, the channel agent can declare an ordered task workflow with `create_task_workflow`: each step has a directive, acceptance gates and an optional configured subagent. Workers submit output or request a return to the previous step; only the parent can approve gates, authorize returns or complete the final step. The parent can correct an active workflow’s directives or gates with `edit_task_workflow`; changed and downstream work must run and pass review again, and edits are refused while a step is working. Progress, corrections and decisions survive restarts, and interrupted work is never replayed automatically. See [Task workflows](docs/TASK_WORKFLOWS.md) for the tools, rework/return rules and recovery. Software-factory work continues to use its existing workflow runs.

## Subagents

A channel can have a team. The channel's own agent stays the only voice in the channel, and hands self-contained jobs to **subagents**: purpose-built workers with their own tools, connectors, model and context window. A coder never carries the conversation that started the work; the channel agent never carries the coder's tool output. Subagents talk to systems (GitHub, Cloudflare, mail, calendars) and report back. They cannot post to Slack, schedule, delegate, or run subagents of their own.

Teams are defined once, as an **agent set**, and assigned to as many channels as you like:

```yaml
agentSets:
  software_factory:
    description: Sort GitHub issues, build the ready ones, review the result, deploy to Cloudflare.
    agents:
      github_triage:
        description: Triages issues, sets labels and priority, finds duplicates. Writes no code.
        tools: [read, bash]
        connectors: [github]
      coder:
        description: Implements one ready issue on a branch and opens a PR. Never merges.
        tools: [read, write, edit, ls, find, grep, bash]
        connectors: [github]
        timeoutSeconds: 1800
      reviewer:
        description: Reviews a PR against its issue and runs the tests. Never merges.
        tools: [read, ls, find, grep, bash]
        connectors: [github]
      cloudflare_deployer:
        description: Deploys an approved, merged change to a named environment with wrangler.
        tools: [read, bash] # wrangler is in the image; the channel's env file holds the Cloudflare token
        requireApproval: true # runs only while a person has approved it in Slack

channels:
  factory:
    agentSet: software_factory
    tools: [read, write, edit, ls, find, grep, bash]
    # A role the channel does not have the tools or connectors for simply does not get them.
    # agentOverrides:
    #   cloudflare_deployer: { enabled: false } # this channel builds but never deploys
```

**The set's name matters for the shipped skills.** The harness ships skills for how a set's roles work together, in `agent-set-skills/<set>/` (the software factory's `factory-handoffs`, `github-issue-triage` and `cloudflare-deploy` are in `agent-set-skills/software_factory/`). They load for a channel only when its agent set is named exactly like that folder, so call the factory's set `software_factory`. Under any other name the channel gets none of them, and its roles are still told to follow skills they cannot read: triage, coder and reviewer carry on without (a workflow run's stage brief carries the report lines the engine needs), but the deployer stops and reports `blocked`, after the change has been built, reviewed and merged. The harness logs a warning when it loads such a channel, naming the roles and skills, and a workflow run is refused at the start while a role that needs a person's approval would be missing a skill it must follow. The fix is to rename the set, or to save copies of those skills in the channel's own skills.

What a role gets is always an **intersection**: the tools and connectors its set lists, limited to what the channel itself has. A set can never hand a role something the channel lacks, and a channel can only take things away from a role (`agentOverrides`), never add. A role's `model` is added to that channel's model allowlist, so name it exactly; without one it runs on the channel's model.

**What a subagent shares with its channel.** The workspace, the memory (`recall`, read-only: it never writes memory, the channel agent decides what is worth remembering), and the skills. That is what makes one definition behave differently in two channels: each channel's own skills and memory shape how every role works there. Skills a set ships (`agent-set-skills/<set>/`, loaded automatically, read-only) can be overridden by a channel skill of the same name.

**Optional per-role GitHub identities.** Configure `GH_TOKEN_CODER` and
`GH_TOKEN_REVIEWER` through the [existing secret/env mechanism](#secrets-and-credentials)
(prefer the channel's `envFile` or `data/channels/<id>/env`). The general name is
`GH_TOKEN_<ROLE>`: uppercase the role ID, with separators as underscores (for example,
`github_triage` uses `GH_TOKEN_GITHUB_TRIAGE`). Each subagent receives its nonempty
override as `GH_TOKEN`; an unset or empty override falls back to the channel's existing
`GH_TOKEN`. All `GH_TOKEN_*` variables are removed from that subagent's environment,
including its own override name. The harness/channel agent keeps its original
`GH_TOKEN` for orchestration and merges. No overrides are required for existing setups.
This selects the environment used by shell commands and inherited stdio connector
credentials; it does not rewrite explicit credentials in connector headers or command
configuration. Use separate GitHub accounts with suitably scoped tokens to separate
PR authorship from review, and keep token values out of prompts, logs and repository files.
Remove an override to return that role to the default identity.

**What you see in Slack.** While a subagent works, the thread shows a post when work is handed over (who, and what the job is), the subagent's own short updates as it finds things, and a closing line (how it ended, how long, how many steps, and which role it suggests next). The channel agent's answer is always the last message. For a three-role pipeline that looks like:

```
:handshake: Handing this to github_triage:  > Triage all open issues in acme/app …
github_triage: Issue #1 has testable bug details; #2 is too broad. Applying labels and asking for scope on #2.
:white_check_mark: github_triage finished (21s · 7 steps). It suggests coder next.
:handshake: Handing this to coder:  > Implement ready issue #1 …
…
Triage found two open issues: #1 is implemented and approved in PR #3 … Nothing was merged.
```

What a subagent says can come from anything it read, so it is escaped before posting (`<!channel>` and `<@U123>` stay text) and URL credentials are removed. Updates are throttled (at least ten seconds apart, six per run at most). Turn it down with `ui.subagentProgress: handoffs` (hand-off and closing line only) or `off` (the channel agent's answer alone). Nothing is posted for a run no one is watching, such as a quiet scheduled task.

**How a job runs.** The channel agent calls `run_subagent` with the role, a task and any context, and waits for the report. The subagent starts with no history, only that brief. Its report leads with a `STATUS` (`done`, `blocked`, `needs_input`, `failed`) and an optional `NEXT` (a suggestion for which role should act next). The channel agent reads that as advice and decides, so a pipeline like triage, build, review, deploy is orchestrated by the channel agent following the set's skills, not by subagents calling each other. Up to three run at once per channel; each has a wall-clock limit (`timeoutSeconds`).

**Approval.** A role marked `requireApproval: true` only runs while a person has approved it, using the same Slack approve/deny buttons and expiring grants as [runtime permissions](#asking-for-permission) (`subagent:<name>`). The channel agent asks with `request_access`; the grant is for the role over the window you offer (`permissions.durations`), not for one specific job, so keep it short for roles that change the outside world.

**Restarts.** A subagent run is its own conversation in the channel's [Durable store](#durable-conversations-restarts-and-recovery) and is not resumed after a restart: it is abandoned, and the channel agent's pending `run_subagent` call is reported to it as interrupted, like any other unsafe effect. Nothing is repeated automatically. Model calls by subagents are recorded in the usage log under their own source (`subagent`). Editing `agentSets` or a channel's `agentSet` takes effect from the next message after a config reload; a run already in flight finishes on the old definition.

**The timeline.** Everything the team does is recorded per channel and drawn in the web console at `/channels/<id>/timeline`, like a git commit graph with branches. The channel agent is the main line: each request, its tool calls, approval requests and decisions, and its reply. Each subagent run is a branch that forks off when the run starts and merges back when its report arrives, with its own tool calls along it. Runs that overlap sit in separate lanes, a run that a restart cut off ends as interrupted, and each row shows who, the status, how long it took, how many steps and what it cost. It can be filtered by agent and refreshes by itself. The record (`data/channels/<id>/timeline.jsonl`, rotated at 4 MB) holds tool names and short excerpts only, never tool arguments or output, with URL credentials removed; direct messages record the shape of what happened but none of the words. It sits outside the agent's file jail, so the agent cannot edit its own history.

The deployer uses **wrangler** (Cloudflare's CLI), which is baked into both runtime images at a pinned, locked version (see [`docs/bundled-clis.md`](docs/bundled-clis.md#wrangler-cloudflares-cli)). The channel supplies `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in its own env file: use a token scoped to deploying one account's Workers and nothing else, because the token's scope, not the skill's rules, is the real boundary. The role runs only with a person's approval, deploys the exact merged commit to the one environment named, dry-runs first, and records the version that was live so it can roll back.

The **software factory** in `config/harness.example.yaml` is the worked example: a GitHub issue triage agent, a coder, a reviewer and a Cloudflare deployer, with shipped skills for the pipeline (`factory-pipeline`), the report each role owes the next (`factory-handoffs`), the label scheme and readiness checklist (`github-issue-triage`), and deploying safely (`cloudflare-deploy`). More than one triage agent (for another tracker) is just another role in the set. See `docs/SUBAGENTS_DESIGN.md` for the design and what is not built yet.

## Configuration subagents

Two built-in roles can administer the configured harness YAML through `run_subagent`, without an agent set. Both are **off by default**, opt-in per channel, and use that channel's model and thinking level:

```yaml
channels:
  engineering:
    configurators: { channel: true }
  ops:
    configurators: { harness: true }  # operator-level authority: enable only in a trusted channel
    allowUsers: [U0123ADMIN]
```

- **`channelConfigurator`** can inspect only its invoking channel and edit its description, model/thinking/model allowlist, preferences, root-message replies, context backfill, recent-conversation summaries and interactive components. A tool-side allowlist rejects all other fields, whole-channel replacement/removal, other channels and harness-wide settings. It cannot grant roles, admin rights, permissions, shells, connectors, sharing, unattended jobs or change execution/access boundaries, even indirectly. New environment references are refused (they could expand host secrets into prompts); settings inherited by a posting reviewer also require harness-level authority.
- **`harnessConfigurator`** can inspect and edit any loader-valid harness/channel configuration, including security settings and configurator enablement. This is equivalent to trusting the channel with configuration administration, **not** a safe grant for an untrusted channel. The older admin-config editor cannot grant these roles.

Only these roles receive `config_get`, `config_backup`, `config_validate` and `config_save`. They have no shell, general file tools or connectors; ordinary roles and parent assistants never receive the configuration tools. Tool arguments cannot choose a file, scope or invoking identity. Reads redact literal credentials and preserve unexpanded environment references; the tools never edit secret/env files. Opt-in is rechecked on every operation, so revocation also stops an already-running configurator's next call.

Read first, then validate/save a batch of up to 25 edits with the returned revision. Paths start at the harness root (use the exact configured channel key, including any `#`). Each edit has a `path` and `value`, or `remove: true`. Lists are replaced as a whole. The existing YAML patcher preserves unrelated comments/layout and refuses unsafe alias side effects or unsupported patches rather than guessing. Validation uses the same loader rules as startup. Saves reject stale revisions, share the existing editor's serialized queue, back up **before** atomic replacement, retain file permissions/symlinks, audit the actor, then reload automatically. Backups live in `<dataDir>/config-backups/` (0600; last 30 retained); explicit backup returns an identifier, not contents.

Results distinguish `saved` (persisted) from `applied` (reload succeeded) and include the backup and reload warnings. Channel settings and agent roles apply to future turns; active turns finish on their existing configuration and stores/sessions rebuild afterwards. Existing restart warnings cover data/auth paths, model-provider registration, the web listener, top-level schedule/dream/backup timers, channel-topic usage and feedback digest timers. A successful reload does **not** mean these startup resources were rebuilt. Without a reload hook, a save reports `applied: false` and a restart warning. A refused/throwing reload restores the prior file and attempts to reload it, unless a newer external edit makes rollback unsafe; failures report whether restoration succeeded and whether runtime state is uncertain.

To undo, the operator restores the reported backup to the configured file, reloads, and restarts if the warnings require it. A running configurator is not resumed after a harness restart, just like other subagents.

## Searching Slack as the current user

Add `slack` to a channel's `tools` list to expose `search_slack`. It calls Slack's read-only search API with the stored user token for whoever is speaking in the thread, not with the bot token, so results are limited to what that Slack user can see.

```yaml
channels:
  admin:
    tools: [read, write, edit, ls, find, grep, sqlite, charts, web, slack]
```

Store one token per Slack user id:

```bash
printf '%s' "$TOKEN" | npm run slack-user-token -- set U01234567
npm run slack-user-token -- list
npm run slack-user-token -- remove U01234567
```

Use a Slack user token with read/search scopes only (for example `search:read`). If a speaker has no stored token, the tool refuses and tells them to authenticate; it never falls back to `SLACK_BOT_TOKEN`. `!slack` shows whether the current channel has Slack search enabled and whether you have a token stored.

## Managing a personal Slack status and profile picture

Set `channels.<channel>.slackProfile: { user: U01234567, team: T01234567 }` to expose `set_slack_status`, `clear_slack_status` and `set_slack_profile_photo` in **that channel only**. This is separate from read-only `tools: [slack]` and posting as a person, and cannot be enabled in defaults. It requires an explicitly authorized **user** token with `users.profile:write`, never the bot credential. See [setup, safe photo inputs and a calendar-driven scheduling example](docs/slack-profile.md).

## Posting to a channel

Replying and posting are different things, and the agent has both:

- Its **reply** goes into the thread it is working in — how it answers people.
- **`post_message`** publishes a new top-level message to the channel, which
  everyone sees without opening a thread.

That second one is what makes recurring output work properly: "post the standup
summary every morning" lands as a real channel message rather than a reply
buried under a scheduler marker.

The tool takes no channel argument. It posts to the channel the agent is
already working in, for the same reason scheduling does — a tool that accepted
a channel id would let work started in one channel speak as the bot in another.

When the agent publishes this way and has nothing left to add, its (empty)
reply is dropped rather than posted as "(no response)".

### Posting to other channels

`post_message` only ever posts to the channel the agent is working in. To let
one channel publish to a few others — say, flag a particular email in
`#finance` — list them explicitly:

```yaml
channels:
  den-inbox:
    share:
      postTo:
        - channel: C0123ABC        # IDs are the durable option
          reason: invoices and payment reminders for finance
        - announcements
```

That gives `#den-inbox` a `post_to_channel` tool. The model chooses only from
that list; the harness checks it again before sending and resolves the target
from the configured entry, not from the model's text. A channel with no
`postTo` has no such tool and nothing is inherited from `defaults`. Messages go
out at top level (no thread), the harness logs each cross-channel post, and the
agent cannot post to direct messages or back to its own channel with it. It
works in scheduled and quiet tasks too, which is how "when an email like this
arrives, tell that channel" is done.

The bot must be able to post there: either invite it to the channel, or add the
`chat:write.public` bot scope in the Slack app (OAuth & Permissions, then
reinstall) so it can post to public channels it has not joined. Private
channels always need an invite. A target given by name is looked up with the
channel list if the harness has never seen the channel; a Slack ID avoids that.

## Posting as a user

`post_to_channel` is the bot posting to a short list you wrote. `post_as_user` is
different: the message goes out under a real person's name, to any channel or
DM that person can reach. Because it speaks as someone, it is off unless you turn
it on for one channel, it is never inherited from `defaults`, and every post is
reviewed or held before it goes out.

Here is a worked example. The reviewer is a role in the channel's agent set. It
has no tools and no connectors, and the config is refused if it has either.

```yaml
agentSets:
  guards:
    description: Reviews drafts before they are sent as a person.
    agents:
      post_guard:
        description: Decides whether a draft may be sent now or must be held.
        tools: []
        timeoutSeconds: 30
        instructions: |
          You protect the person the draft would be sent as. Hold anything you are unsure about.

channels:
  inbox:
    agentSet: guards
    share:
      postAs:
        user: U01234567
        reviewer: post_guard
        maxPerHour: 10
        rules: |
          Never share finance figures or salaries.
          Calendar availability is fine; never commit to dates.
          Never forward attachments or links to documents.
        privateLinkHosts: [wiki.example.com]
```

`maxPerHour` defaults to 10 and can be at most 100. `rules` and `privateLinkHosts`
are optional. Changing `share.postAs` through the admin agent needs the same
approval click as `delegateTo`, because it lets the agent speak as a person. So
does changing the reviewer once a channel posts as a person: any setting of the
reviewer role (`instructions`, `model`, `timeoutSeconds`, ...), removing the role
or its agent set, the channel's `agentSet`, or the channel `model` or
`thinkingLevel` the role inherits. The reviewer uses the channel's model unless
the role sets its own.

### What is guaranteed

- Every message ends with the footer `Sent by <@app> on behalf of <@U…>`, where
  `<@app>` is this Slack app, so it shows as the app's own name. (If the app's id
  is not known yet, the footer says `Claude` instead; it is never left off.) The
  footer is added in exactly one place, the function that sends as the user, and
  the agent has no way to skip it. Unblocking a held post goes through the same
  function, so it keeps the footer too. A draft that tries to write its own
  footer just gets the real one added after it.
- Every post leaves a receipt in the channel it came from, showing the
  destination, the reason, the source and the full text. The receipt is posted
  before the message is sent. If the receipt cannot be posted, nothing is sent.
- A message posted this way is output, never input. It is authored by the person, so to Slack it looks like them
  typing, and the harness ignores any message that ends in its own footer (it never starts a turn, in this channel or any
  other, including when it mentions the bot). This is deliberate: otherwise an agent could post as you into a channel with
  its own agent, and that agent would obey it as you. It also means `post_as_user` cannot be used to talk to another
  channel's agent; use `transfer_to_channel` for that.
- There is no token fallback. If the person has no user token stored, the tool
  refuses; it never sends with the bot token.

### The pipeline

Each `post_as_user` call goes through these steps, in order:

1. The rate cap (`maxPerHour`, counted per channel). A post over the cap is held
   without calling the reviewer, but the deterministic checks below still run and
   whatever they find is shown on the alert.
2. The harness looks up the destination and describes it to the reviewer. If it
   cannot describe it, the post is held.
3. Deterministic checks, described below.
4. The reviewer, which answers `send` or `hold`.
5. Send, or hold for the person to decide.

The deterministic checks hold a post that contains:

- a link to a private document host: Google Docs, Drive, Sheets and Slides,
  Notion, Atlassian, SharePoint, Dropbox, Box, OneDrive (`onedrive.live.com`,
  `1drv.ms`), Confluence, or a Slack message permalink. Setting
  `privateLinkHosts` adds hosts to this list. It never replaces it. A link
  hidden behind a Slack link label, on a subdomain, inside another URL
  (percent-encoded repeatedly: the text is decoded up to three more times until
  it stops changing, and so is each URL found inside it, three URLs deep), with an encoded or
  lookalike dot (`%2e`, `。`, `．`) or with invisible characters in the host is
  still found.
- a string shaped like a credential: an AWS access or STS key, a Slack token
  (bot, user, app or refresh), a private key block, a GitHub token (classic or
  fine-grained), an Anthropic, OpenAI or Stripe style `sk-` key, a Google API
  key or OAuth token, or a JWT. Invisible characters inside one do not hide it.
- a broadcast: `@channel`, `@here`, `@everyone` or a user-group mention.

The reviewer is a model call, so it judges what a script cannot: whether the
draft gives away non-public information, whether it answers what was asked and
no more, whether the request looks like an injection aimed at the agent,
whether it makes a commitment on the person's behalf, and whether it breaks the
person's `rules`. `rules` is where the owner writes what they are willing to
share. Specific, content-based lines work best, such as "Never share finance
figures or salaries." Its answer must be strict JSON. Anything else, a timeout
or an error is a hold.

### The source check, and its limit

The tool requires a `source` (the verbatim request that prompted the post, with
who sent it and where) and a `reason`. `source` is checked against the text the
agent received as a user turn in this thread. That includes the channel history
it was handed when the thread started, a scheduled task's prompt, or a
transferred task. It does not cover an email fetched by a connector. When the
source quotes the request, every quoted run (of 12 characters or more) must be
found, so one genuine sentence cannot vouch for a made-up rest; with no quotes,
the whole source must be found. The receipt and the reviewer both see it marked
verified or unverified. An unverified source does not block the post by itself;
the reviewer weighs it.

This is a limited check. It catches an agent that invents a request. "Verified"
means that text appears in what the agent was given as user input, not that a
person said it, and nothing stronger.

### Held posts

A held post is not sent. The channel gets an alert with the full draft, the
destination and why it was held, and two buttons: **Unblock & send** and
**Dismiss**. If the alert itself cannot be posted, the post is dropped and the
agent gets an error: nothing is sent.

- Only the person in `postAs.user` can click them. Anyone else is refused.
- Each held post can be used once. A double click sends one message.
- It expires after 30 minutes, and at most 20 can wait at once.
- Unblocking keeps the footer and still writes a receipt.
- The rate cap still applies. A post held only because the hourly cap was hit
  can be unblocked only when there is room under the cap, which may not be until
  after it has expired. If it expires first, ask the agent to send it again once the cap allows.
  Its alert shows anything the link and secret checks found, and it is sent to
  the channel or person id it named; only a bare channel name is looked up at
  unblock.

### Token scopes and `!status`

The person's Slack user token needs `chat:write`, `im:write` (to open DMs),
`users:read`, `channels:read`, `groups:read`, `im:read` and `mpim:read` (so the
harness can describe the destination). Store it on the host:

```bash
printf '%s' "$TOKEN" | npm run slack-user-token -- set U01234567
```

`!status` in the channel shows whether a token is stored for `postAs.user`. It
can only tell that one is there, not which scopes it has. A missing scope shows
up when a post is attempted, and the error names the scope.

## Attaching files

The agent can write a file and attach it, which is how a chart, a report or a
CSV gets out of the workspace and in front of people:

> **you** @seneschal chart the response times from the log and post it
> **seneschal** _running `bash`…_
> :bar_chart: **latency.png** — p99 by hour; the 09:00 spike is the deploy.

`upload_file` takes a path in the channel's workspace, plus an optional comment
that becomes the message next to it. It attaches in the current thread by
default, or at channel level with `to_channel: true` — the same distinction
`post_message` makes, for the same reason. As with posting, the tool takes no
channel argument: it attaches where the session is already working.

**The path is jailed exactly like `read`.** It is resolved through symlinks and
checked against the channel's readable roots, so a file from another channel —
or a symlink pointing at one — is refused rather than published. Channel env
files live outside those roots by design, so secrets are not reachable this way
either.

Files over 20MB are refused, as are empty files and directories. The agent gets
the reason back and can act on it rather than failing silently.

### HTML slide decks

`slides` is a first-party, dependency-light Markdown-to-HTML deck renderer. It
is included in the default tool set and exposes `create_slide_deck`; remove it
from a channel's `tools` list where presentations are not wanted.

```yaml
channels:
  board-updates:
    tools: [read, write, edit, ls, find, grep, slides]
```

Give the tool Markdown and put a line containing only `---` between slides. It
writes one responsive, keyboard-navigable `.html` file (arrow keys, Home/End,
and print support) to the channel workspace. Attach that returned path with
`upload_file`; Slack presents HTML as a downloadable attachment that opens in a
browser, rather than an inline preview.

```text
# September update

- Reliability is improving
- Dashboard is ready for review

---

## Next steps

1. Gather feedback
2. Ship the pilot
```

The generated document carries all CSS and JavaScript inline and makes no
network requests. Standard Markdown is rendered by `marked`; raw HTML is
escaped, links are limited to `https:`, `http:`, `mailto:` and page fragments,
and Markdown images are embedded only from readable workspace PNG, JPEG, GIF,
or WebP files (2 MiB each, 8 MiB total). Remote images, SVG, and raw HTML are
intentionally excluded so a deck remains self-contained and does not turn
untrusted Markdown into an active document. Use `theme: midnight` (default) or
`theme: paper`; the output will never overwrite an existing file.

This is deliberately not a general-purpose hosted slideshow system: it needs no
headless browser, npm install in a channel workspace, external CDN, or hosted
presentation account. For bespoke decks, agents can still write reviewed HTML
by hand, then attach it through the same jailed `upload_file` workflow.

### Managing workspace files without bash

Channels can also get one structured workspace-management tool instead of a
shell. Add `file_ops` to the channel's `tools` list (it is in the default tools)
and the agent gets `workspace_file_ops`, whose `operation` is one of `mkdir`,
`move`, `rename`, `copy` or `delete`. `move`, `rename` and `copy` take
`to_path`; destination parent directories are created by default; existing
destinations are refused unless `overwrite: true` is explicit. Directory copy
and delete require `recursive: true`.

The tool is narrower than `write`/`edit`: it only manages paths inside the
channel workspace, not memory, skills, the document library, or another
channel's files. It uses the same symlink-resolving jail as upload and document
filing, including any deliberate `workspace.symlinkTargets`.

### Saving any tool's output directly to a file

Every channel and subagent has `save_tool_output` automatically; no shell,
connector-specific export, or `write` permission is needed. It invokes a tool
already available to that thread/role and writes the actual returned data to a
**new JSON file in that channel's own workspace**, before conversation handling.
For example:

```json
{
  "tool": "read",
  "arguments": { "path": "report.txt" },
  "path": "exports/read-result.json"
}
```

For a connector, use its exposed name (for example `finance__export`) and its
normal arguments instead. Use this *instead of* first calling the tool and
reconstructing its response: saving invokes it once, and does not recover a
previous call's output. All existing tool checks (including grants, connector
allowlists, current-user approval and the native file jail) still apply. A
subagent cannot use this to invoke its parent's tools.

The receipt contains `saved`, a workspace-relative `path`, UTF-8 `bytes`,
`toolExecuted`, `toolSucceeded` when known, and completeness information.
Only the receipt reaches the conversation, not the exported body. The path can
then be read or passed to `upload_file` when that tool is available. Parent
directories are created; existing files are **never overwritten**. Absolute
workspace paths (including the container workspace alias) also work. Traversal,
other channels, memory, skills, shared roots and even explicitly allowed
external workspace symlink targets are refused as output destinations.

**Representation:** the version-1 JSON envelope contains `tool`,
`representation` (`pi` or `mcp`), `toolSucceeded`, `completeness`, and
`result`. For built-in/harness tools, `result` is their returned Pi result,
including content, structured content and details. For connectors it is the
**raw MCP call result**, before text-only display conversion: text blocks,
`structuredContent`, metadata, image/audio base64, embedded resources and
resource links are retained. JSON is the only output format; it is not a raw
CSV/PDF/image download. Embedded binary stays base64 (or the tool's own JSON
encoding), and links remain links: they are not fetched or decoded. Optional
undefined fields are omitted according to JSON rules; unsupported non-JSON
values (for example BigInt, non-finite numbers or cycles) fail explicitly.

**Completeness:** no conversation-size truncation is applied to the saved data,
but this cannot undo a tool/server's own truncation, requested limit, pagination,
or image conversion. Such indicators are retained verbatim. Every envelope and
receipt warns about upstream limits: `reported_incomplete` flags common
positive truncation/pagination markers; otherwise the status is `unverified`,
**never a claim of a complete upstream export**. Inspect continuation markers
and fetch further pages separately when needed.

Tool-returned errors can be saved with `saved: true, toolSucceeded: false`
and an error receipt. A thrown error, invalid path, serialization or filesystem
failure returns `saved: false`. Publication is atomic and does not leave a
partial destination. A failure **after** `toolExecuted: true` does not undo the
tool's effects: do not blindly retry a mutation. Temporary files are cleaned up
on normal completion/failure; a process crash may leave a hidden
`.tool-output-*` private staging file at the workspace root. Publication uses
one short-lived Node helper (no shell or extra executable/dependency), with a
verified directory-inode working-directory anchor and no-follow directory
traversal, so replacing a destination parent cannot redirect writes through an
external symlink. The harness process never changes its working directory.
The workspace root and its host ancestors must remain trusted/stable. Native
file tools are not an OS sandbox against host processes that can relocate
already-open directories outside the workspace or steal private files. A move
racing the atomic link is detected afterward and the link removed, but this
cannot guarantee against transient visibility to such a host process. Platforms
without POSIX no-follow directory opens fail closed. There is no configuration
change; existing sessions pick up
the tool when rebuilt (for example after `!reset`).

### Generating something worth attaching

Writing the file is the agent's own problem, and what it can produce depends on
what the channel has:

| Channel has | Can produce |
|---|---|
| the default tools | Markdown reports, CSVs, data extracts, SQLite inspection/querying, PNG charts via `create_chart`, and self-contained HTML slide decks via `create_slide_deck` |
| `bash` as well | real images — the sandbox image ships `gnuplot`, which renders PNG directly |
| `images` plus configured `defaults.images` / channel `images` | prompt-based AI images via `generate_image` |

`create_chart` is deterministic and local: the agent passes structured data and
gets a PNG bar, line or scatter chart under its workspace, no shell or image
provider involved. Slack previews PNG, JPEG and GIF inline, so generated charts
appear inline when uploaded.

Prompt-based AI image generation is separate from rendering charts. Enable it
only in channels where you are comfortable sending prompts to the configured
provider and paying for image calls:

```yaml
defaults:
  images:
    provider: openai              # none | openai
    # Either an API key, or a provider already logged in through authPath.
    # authProvider: openai-codex  # reuse the Codex/ChatGPT Plus-Pro OAuth login
    apiKey: ${OPENAI_API_KEY}     # from the channel/global env bundle
    baseUrl: https://api.openai.com/v1
    model: gpt-image-1
    size: 1024x1024
    quality: auto
    outputFormat: png

channels:
  creative:
    tools: [read, write, edit, ls, find, grep, sqlite, web, images]
```

With `authProvider: openai-codex`, the harness asks the same model runtime credential store used by chat models for a bearer token, so it can reuse the Codex subscription login instead of a separate OpenAI API key.

`generate_image` writes the image under the channel workspace (by default
`generated/image-<timestamp>.png`). The agent then uses `upload_file` to show it
in Slack.

For a channel that wants more than gnuplot, give it its own sandbox image
rather than growing the shared one:

```yaml
channels:
  analytics:
    tools: [read, write, edit, ls, find, grep, sqlite, web, bash]
    sandbox: { mode: docker, image: harness-analytics:latest }
```

```dockerfile
FROM seneschal-sandbox:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-matplotlib python3-pandas && rm -rf /var/lib/apt/lists/*
USER sandbox
```

This needs the `files:write` scope. The harness names it at startup if it is
missing.

## Learning skills

Memory is what a channel knows. A **skill** is what it knows how to *do* — and
the agent writes its own:

> **you** @seneschal that's the third time I've explained the Friday rollup. can you keep it?
> **seneschal** Saved it as `weekly-report`. I'll follow it from now on; tell me when it should change.

`save_skill` writes `data/channels/<id>/skills/<name>/SKILL.md` in the
[Agent Skills](https://agentskills.io/specification) format, and `delete_skill`
removes one. Both are always available, in every channel, with nothing to
configure — an agent that cannot write down how it did something has to be told
again every week.

The split matters because the two are loaded differently:

| | Holds | In context |
|---|---|---|
| `remember` | a fact — a decision, a preference, a name | read on demand, when it looks relevant |
| `save_skill` | a procedure — the steps, the gotchas, what done looks like | name and description always; the body when the task matches |

So a skill's **description** is the part that does the work: it is what decides
whether the skill is ever loaded. The agent is told to be specific there.

Capture a durable learning when it appears, rather than waiting to be asked:

- a person corrects or teaches the agent;
- the agent makes a mistake and discovers the remedy;
- lengthy or iterative work reveals a reusable preference or process; or
- an important decision or outcome will matter in a later conversation.

Keep the entry to the concise fact — the correction, preference, remedy, decision,
or outcome — rather than copying a transcript, turn-by-turn status, or one-off
detail. A repeatable process belongs in `save_skill`, while the durable fact that
it exists belongs in `remember`.

### The one skill that ships with the harness

Left to itself, an agent writes mediocre skills: a description too vague to
ever fire again, a body that reads like a diary of the conversation, a fact
saved as a procedure. That is not a per-channel problem to solve thirty times
over, so the harness ships the answer in the repo — `skills/writing-skills/` —
and it is on in **every** channel, with nothing to configure and no way for a
channel to write to it:

```
skills/                      shipped with the harness, on everywhere
  writing-skills/SKILL.md    how to write a skill worth loading
```

It covers what belongs in a description (the part that decides whether the
skill is ever opened), what belongs in the body, what should not be a skill at
all, and when to revise rather than accumulate. The agent is told in its system
prompt to read it before saving or publishing anything.

It is adapted from [Anthropic's `skill-creator`
skill](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md),
cut down to what this harness can do — the upstream version assumes a skill is
a directory of bundled scripts with an eval harness behind it, and here a skill
is one file written through a tool call. The writing advice is the part that
travels; the SKILL.md says so and links back.

Being in the repo rather than in `data/` is deliberate: it is reviewed in git,
it survives a wiped data directory, and it is outside every channel's jail. A
channel that wants a different version saves a skill of the same name, which
shadows it locally — the same escape hatch the catalogue has. `!skills` marks
where each skill came from, `_(builtin)_` included.

**Skills are per channel.** A channel writes only its own, into its own
directory. There are two ways one can reach another, and they are different
things: **collections** (`data/shared/skills/<collection>/`), which an operator
curates by hand and assigns to channels, read-only unless said otherwise —

```yaml
channels:
  engineering:
    share:
      skillCollections: [software-development]   # from data/shared/skills/
```

— and the **library**, which the agents curate themselves. Collections, the
admin channel and the bin tiers are covered in
[Skills and tools: who sees what](#skills-and-tools-who-sees-what); the library
is below.

A channel that saves a skill with the same name as a shared one shadows it
locally, which is how a channel adapts an account skill to its own habits. The
agent says so when it happens.

`!skills` lists what a channel has, with descriptions and where each came from.
Skills are plain markdown on disk, so you can read, edit or delete one by hand,
and a skill the agent got wrong can be fixed with a text editor.

> A skill is instructions the model will follow, so an agent that writes its
> own is an agent editing its own instructions. It is confined to its channel
> and visible in `!skills` and in git-less plain files, which is the trade this
> harness makes deliberately — but if that is not a trade you want in a given
> channel, delete the directory and it starts over.

## The skill library

A channel that works something out keeps it. That is the isolation model doing
its job, and it is also a waste: #ops spends an afternoon learning to read a
Grafana alert properly, and #engineering learns the same thing again next
month.

The library is the way across. It is a shelf — `data/shared/library/` — that
channels put skills on and take skills off:

> **you** @seneschal that grafana thing you worked out, would the other channels want it?
> **seneschal** Probably — it's not specific to us. I'll need someone to approve publishing it.
> _[Approve for 15 minutes] [Deny]_
> **seneschal** Published `grafana-alerts` as v1. Nothing changes for anyone until a channel installs it.

and, in a different channel, a week later:

> **you** @seneschal the alert says the disk is fine but it clearly isn't
> **seneschal** There's a `grafana-alerts` skill in the library from #ops that covers exactly this — the panel title lies. Installed it and followed it: the query is aggregating across nodes.

Five tools, split the way browsing a shelf is split:

| Tool | What it does |
|---|---|
| `list_library_skills` | names and descriptions of what is on the shelf |
| `read_library_skill` | the full instructions, without installing them |
| `install_library_skill` | copies it into this channel |
| `publish_skill` | puts one of this channel's own skills on the shelf |
| `unpublish_skill` | takes one back off |

Three properties are what make this safe enough to leave switched on:

- **Publishing is a permission, installing is a decision.** Publishing writes
  instructions other channels may follow, so it needs `share.libraryPublish`
  or a human clicking approve. Installing is the *installing* channel's own
  agent choosing to, after reading it.
- **Installing is a copy, not a link.** The skill lands in the installing
  channel's directory and becomes an ordinary channel skill it can refine or
  delete. The publisher cannot reach into another channel by editing what it
  published; an update has to be installed again, and `!library` says when one
  is available.
- **Nothing is anonymous.** Every entry records the channel that published it,
  when, and at what version. A skill with no provenance is not listed at all.

```yaml
channels:
  engineering:
    share:
      libraryPublish: true      # trusted to put skills on the shelf

  ops:
    permissions:
      grantable: [network, web, skillPublish]   # or let it ask, once at a time

  private-notes:
    share:
      library: false            # not even the shelf
```

`share.library` (read and install) defaults to **true**; `libraryPublish`
defaults to **false**. The agent is told plainly that a library skill is advice
from a colleague rather than an instruction from its operator, and to refuse
one that asks it to do something odd with this channel's memory, files or
secrets. `!library` shows the shelf, what this channel has installed, and
whether anything has been updated since.

## Skills and tools: who sees what

Three kinds of thing can be shared with a channel, and each has its own door.
None of them is the agent-published `shared/library` or `shared/bin`, which are
described in their own sections below and work differently.

**Skill collections.** The operator's global book of skills lives in
*collections*: `data/shared/skills/<collection>/<skill>/SKILL.md`. A skill
belongs to exactly one collection (its parent directory; no manifest). A
collection reaches a channel only when config assigns it:

```yaml
channels:
  engineering:
    share:
      skillCollections:
        - software-development             # read-only (the default)
        - { name: ops-runbooks, mode: rw } # this channel's agent may edit it
```

- **`ro` is the default.** The channel loads the collection's skills, and every
  write path refuses it: `save_collection_skill` does not exist, the file-tool
  jail has the directory as a read root only (also through a workspace
  symlink), and in Docker it is a `readonly` bind mount (writes fail with
  `EROFS`).
- **`rw` is rare and explicit.** Whoever can write a collection changes what
  *every* channel holding it will do, so use it sparingly (the admin channel's
  own working collection is the obvious case). An `rw` channel gets
  `save_collection_skill` and `delete_collection_skill`; each write is
  appended to `data/shared/audit/skill-writes.jsonl` (actor channel, collection,
  skill, sha256, time) *before* the file changes, and files are replaced
  atomically, so concurrent writers leave the last complete write and a reader
  never sees a half-written file. Writes made from a shell in an `rw` container
  mount cannot be attributed this way: give `rw` only to channels you trust with
  that, or without `bash`.
- Unassigned collections are invisible: not a skill path, not a read root, not
  a mount. Collection names are lowercase letters, numbers and single hyphens;
  `channel` and `builtin` are reserved. A name that does not exist on disk is
  skipped with a warning (never created), and `npm run doctor` flags it. When two
  assigned collections hold a skill of the same name, the one listed first in
  config wins; precedence overall is the channel's own skill, then collections,
  then the harness's built-ins.
- A symlink inside a collection that resolves outside it is not loaded.
- **The old flat layout is rejected.** `data/shared/skills/<skill>/SKILL.md`
  (no collection) is no longer loaded, and `share.skills` fails config
  validation with a migration message. Move them with
  `npm run migrate-skills` (default collection `default`; `-- --collection
  <name>`, `-- --dry-run`), then assign the collection. The harness never
  rewrites that directory by itself.

**The admin channel.** Mark exactly one channel `admin: true` (config
validation allows at most one). Its agent additionally gets
`admin_list_channel_skills`, `admin_read_channel_skill`,
`admin_save_channel_skill` and `admin_delete_channel_skill`, addressed by a
channel's Slack id or name, for managing *other* channels' own skills. The
target must be a channel that already exists; the write is logged with the admin
channel as actor and takes effect the next time the target starts a session. An
ordinary channel's agent can only ever touch its own skills.

The admin channel also gets the **`administer-harness`** skill automatically, with no
configuration: how this installation is configured, run, backed up, recovered and upgraded, and
which steps a person has to type in Slack or run on the host. It ships in `admin-skills/` (read
from disk, reviewed in git, read-only to the agent) and is added to the skill paths and read
roots of the `admin: true` channel only: no other channel can see it exists or read its files.
Being the admin channel grants **no host access** (no shell unless you gave that channel one, no
other channel's memory or workspace, no secrets), and the skill is explicit that anything on the host
is the agent telling a person exactly what to do. What it **can** do is read and change the harness
config, below.

### Setting up the harness from the admin channel

The admin channel's agent has `admin_config_get` (read the config, literal secrets hidden) and
`admin_config_edit` (change it). The intended use is to *set up the environment, then link it to
channels*: add or update remote MCP connectors, give them to channels, set models and thinking
levels, who may use a channel, which team a channel has, the team definitions themselves, and the
account `defaults` that are safe. "Add the GitHub connector and give it to engineering and design"
is one change.

- **In place.** The file is edited as text: only the lines that change move. Comments (including
  commented-out examples), the layout of lists, spacing and quoting are exactly as you wrote them.
  If a change cannot be made that exactly (a list item, a YAML anchor another setting depends on) it
  is refused, not approximated.
- **One batch, all or nothing.** The edits in a request are validated together as the loader would
  at startup, backed up to `data/config-backups/` (private, newest 30 kept), recorded in
  `data/shared/audit/config-edits.jsonl` (who, which channel, before and after), written atomically
  (a symlinked config stays a symlink and the real file is replaced), and reloaded. If the reload
  refuses the new file the previous one is put back.
- **A blacklist, with a safety net.** `src/config/edit-policy.ts` classifies **every** setting in the
  schema, and a test fails when one is added without a decision, so a new setting cannot become
  editable by being forgotten.

What it will **not** do (these stay edits on the host, and the agent says so and what to run):

| Never from here | Why |
|---|---|
| This channel's own entry; `admin` anywhere | It decides who controls the harness |
| `dataDir`, `documentsDir`, `authPath`, `envFile` (global or per channel) | Where secrets and state live |
| `stdio` connectors, `cliTools`, `exec`, `sandbox`, `workspace` | Commands and folders on the host |
| A shell (`bash`, `exec`) added to a channel's tools | Same |
| `modelProviders`, `web`/`images` settings | Where prompts and keys go, and what the web tools can reach |
| `webConsole`, `backups` | What the harness listens on and serves |
| `permissions`, `requires`, `allowUnconfiguredChannels`, `allowDirectMessages` | Who can be granted what, and who can use the bot |
| `share.memoryWrite`, `channelMemoryRead`, `delegateTo`, `libraryPublish`, `sharedToolsPublish`, `sharedTools`, read-write skill collections | Writing where others read, or reaching into another channel |
| Switching off a role's `requireApproval` | An approval gate is never removed from here |
| Emptying or removing a channel's `allowUsers` | That would lock everyone out or open it to everyone |

Connectors have their own rules because a connector is where credentials meet the network: only
`transport: http` (remote), never a URL on this machine or a cloud metadata address, no credentials in
the URL, headers and OAuth secrets only as `${VAR}` references (never literal values), and a connector
may only reference variables that start with **its own name**: a connector `github` can use
`${GITHUB_TOKEN}`, `google-calendar` can use `${GOOGLE_CALENDAR_…}`, and neither can be pointed at an
unrelated secret such as a model key. The agent cannot see or set a secret's value: after adding a
connector it tells you which variable to set on the host (`npm run secrets`).

**Docker.** The default compose file mounts `./config` read-only, so by default the harness cannot
change its own config and an edit fails with a message saying so. Turn it on deliberately with the
override: `docker compose -f docker-compose.yml -f docker-compose.admin-config.yml up -d`. On a host
install nothing is needed beyond the harness being able to write the config file's folder.

**Skills inside Docker.** With `sandbox.mode: docker` the skills are mounted
into the container at fixed paths, and those are the paths the agent is shown:

| In the container | Host | Mode |
|---|---|---|
| `/skills/channel` | `channels/<id>/skills` | read-only (change them with `save_skill`) |
| `/skills/<collection>` | `shared/skills/<collection>` | `ro` or `rw` as assigned |
| `/global/bin` | `shared/global-bin` | read-only, every channel |

Nothing else of `data/` is mounted: no other channel, no unassigned collection.
The file tools understand the same `/skills/...` paths (translated to the host
path and then checked against the jail like any other path, so it is a spelling
and not a permission). Changing a mode or assignment changes the container's
fingerprint, so a reused container is recreated rather than keeping a stale
mount. The harness itself in Compose already shares all of `data/` with the
daemon via `HARNESS_DOCKER_DATA_DIR`, so these mounts need no extra setup.

**Three bin tiers, three PATH entries.** `PATH` is always *channel bin, then
global bin, then system*, on the host and in the container:

| Tier | Where | Who writes it | Who can run it |
|---|---|---|---|
| Channel bin | `channels/<id>/workspace/bin` | the channel (agent or operator) | that channel, by bare name |
| **Global bin** | `shared/global-bin` | the operator only | every channel, by bare name, host and container |
| Optional CLI pool | `cliTools` + `exec.shared` | the operator | only channels that name it, as `cli__<name>` |

The global bin needs no per-channel config. It is read-only everywhere a channel
runs: outside every write root on the host, a `readonly` mount in containers.
Put scripts or Linux binaries in it that work in your sandbox image (a macOS
binary will not execute inside a Linux container; scripts do). It is **not**
`shared/bin`: that directory holds scripts agents *publish*, is never on any
PATH and is runnable only through a `shared__<name>` tool an operator named in
one channel's own `share.sharedTools`.

The CLI pool remains opt-in per channel
(`exec.shared`, unknown names fail validation, `allowArgs` enforced unless the
operator explicitly enables `allowAllArgs` for that command,
per-tool `env` never visible to other tools). These tools run **on the host**
via the agent's `cli__<name>` tool call even when the channel's `bash` runs in
Docker; code running inside the container cannot call them directly and they do
not appear on its PATH or in its mounts. If you need a tool available to
container scripts, put it in the global bin instead.

All of this is re-resolved from config on `reloadConfig`: assignment, mode,
`admin` and pool changes apply to the next session without a restart, and idle
sessions holding the old resolution are retired.

Tests: `npm test` covers all of the above, including the isolation-invariant
suite (`src/workspace/isolation-invariants.test.ts`). The container cases are in
`src/agent/skills-bin.live.test.ts`; they self-skip without Docker and run with
`HARNESS_SANDBOX_TEST_IMAGE=<image with bash+sleep> node --experimental-strip-types --test src/agent/skills-bin.live.test.ts`.

## The shared tool bin

`exec` (above) gives one channel a named CLI. The shared tool bin is the same
idea stretched across the account: a channel writes a small script once, and an
operator can let *other* channels run it — without handing any channel a
general-purpose shell into somebody else's territory, and without letting the
publishing channel decide who gets to run what it wrote.

Three permissions, each a different person's decision:

- **Writing it is a permission.** `share.sharedToolsPublish` (or a runtime
  grant of `sharedToolsPublish`), same shape as `libraryPublish`. It lets a
  channel's agent put a script in the account-wide `data/shared/bin/`.
- **Naming it is the operator's, per consuming channel.** Publishing exposes
  nothing — not even to the channel that published it. A tool only becomes
  runnable once an operator lists it, by name, in some channel's own
  `share.sharedTools`, together with that channel's own argv allowlist.
- **Running it is argv-checked, like `exec`.** No shell: the harness spawns
  the published script directly, with only the argv patterns that channel's
  config allows.

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
        deploy-notify:                        # must already be published as "deploy-notify"
          allowArgs: [["--env", "staging"], ["--env", "production"]]
          env:
            NOTIFY_WEBHOOK: ${DEPLOY_WEBHOOK}
          timeoutSeconds: 30
          maxOutputBytes: 100000
          # Optional: refuse to run if #ops republishes something unreviewed.
          # sha256: "<64-hex-char sha256 from list_shared_tools>"
```

`release` now has a tool called `shared__deploy-notify`. It runs whatever
`#ops` currently has published under that name — there is no copy, unlike the
skill library, because this is a shared *tool*, not a shared starting point.
Pin `sha256` (shown by `publish_shared_tool`/`list_shared_tools`) on a channel
that should not pick up a change automatically; without it, an update from the
publisher takes effect for every configured consumer the next time it runs.

The published script itself must start with a shebang line
(`#!/usr/bin/env bash`, `#!/usr/bin/env node`, …) naming its own interpreter —
the harness executes the file directly, never through a shell of its own, so
nothing else would know how to run it. That also keeps published tools to
reviewable text rather than opaque binaries (64 KiB cap).

Five tools, split the same way the library is:

| Tool | Needs | What it does |
|---|---|---|
| `publish_shared_tool` | `sharedToolsPublish` | Writes (or replaces) a script this channel published, under a name only it can update. |
| `unpublish_shared_tool` | `sharedToolsPublish` | Removes one — configured consumers lose access immediately. |
| `list_shared_tools` | `sharedToolsPublish` | Names, descriptions, publishers and hashes of everything in the bin, so a publisher does not collide with an existing name. |
| `read_shared_tool` | `sharedToolsPublish` | The full source of one, without running it. |
| `shared__<name>` | that name in `share.sharedTools` | Runs the published script with argv from this channel's own allowlist. |

Nothing here is ever added to a channel's filesystem jail: `data/shared/bin/`
is not readable or writable through `read`/`write`/`bash`/`file_ops` by any
channel, publisher included. The only way in is `publish_shared_tool`; the
only way to run something is a `shared__<name>` tool built from a channel's
own config. A channel with host-mode `bash` can still reach the directory the
same way it can reach anything else the harness process can — that is the same
tradeoff `bash: host` already documents, not a new one this feature adds.

## Recent conversations

Every channel also keeps a tiny rolling index of its most recently updated
assistant threads. After a handled thread has no updates for
`defaults.recentConversations.debounceSeconds` (60 seconds by default), the
harness asks `defaults.recentConversations.model` (default
`deepseek-flash`) for one sentence and stores it in
`data/channels/<channelId>/recent-conversations.json`. The prompt always shows
the newest `maxThreads` entries as `thread id — summary`.

Each summary is also appended to the channel's **main conversation** as a digest,
so a *new* thread (a fork of it) starts already knowing what the channel has been
doing, while a thread already running keeps the live list above.

Failed, incomplete, or empty model responses are logged, not saved or appended as
digests; an existing useful summary is retained until a later handled turn triggers
a successful update. Previously saved empty-summary placeholders are ignored.
If your config explicitly sets the old `deepseek-v4-flash` ID, update it to
`deepseek-flash` (or another available model); explicit model choices are not rewritten.

This is deliberately separate from memory: it is orientation context, not a
fact the agent decided to keep for next week. The nightly dream pass may still
turn an important outcome into memory; the recent-conversations list just tells
a fresh turn what threads have been active lately.

## Durable conversations, restarts and recovery

Conversations are kept in a [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
store per channel (`data/channels/<id>/durable/`, SQLite, one owning process).
That changes what a restart means.

**What survives a restart.** A turn that was running — mid-generation, or in the
middle of a tool call — is not lost. On start (and the first time a channel is
used) the harness *recovers* it. It never repeats an external effect: a tool call
that was in flight is reported to the next model turn as *interrupted*, so the
agent checks before redoing it. Interrupted scheduled runs and dreams are dropped
(they fire again on their schedule).

**Recovery is gated, not automatic.** Resuming a turn runs tools, so before
anything resumes it is re-established under the rules that apply *now*:

- the original speaker is still allowed in the channel (`allowUsers`);
- the thread's tools are rebuilt from today's configuration and grants — a
  permission that was revoked, or a connector that was removed, is simply not
  there for the resumed turn;
- the models in use (and any pinned mid-request) are still allowed.

If any of that fails, **the whole channel is held paused** and nobody can use it,
because resuming any one conversation would start every other ready one too. The
reason is recorded. In the channel:

```
!recovery            what is held, and why
!recovery retry      run the checks again (after fixing the cause)
!recovery discard    give up on everything interrupted; nothing from it will run
```

**Slack never gets a duplicate reply.** Each reply carries its request id in
invisible message metadata, and the harness records "about to send" before
sending. A Slack redelivery of an event, or a crash between sending and noting
the timestamp, finds that record (or that metadata in the thread) and edits the
existing message instead of posting another. An answer that was committed but
never reached Slack before the crash is delivered when the channel next opens,
marked *Resumed after a restart*. This needs the same history scopes as thread
backfill (`channels:history` / `groups:history` / `im:history`); without them a
crashed send cannot be reconciled and the harness logs a warning.

**Operational notes.**

- Runs on the current Node LTS (v24); requires **Node 22.19 or newer** (built-in SQLite). The harness
  refuses to start on anything older, and `Dockerfile.harness` pins a verified version.
- A channel's store is opened on first use and at start-up, and re-opened after a
  config reload or a permission grant/revoke (its tool list is fixed when it
  opens). That wait is invisible except that a reload does not interrupt a turn
  in progress.
- Back up `data/` as before; `durable/` is part of it. Do not copy a live
  `durable/` directory while the harness runs.
- Conversation content is private to the channel. Do not serve `durable/`.

## Dreaming

Memory only ever grew. Every "remember this" added a line, nothing ever took
one away, and the file got longer and less useful at the same time — the useful
note about the boiler ending up under forty lines about a deploy in March.

So once a day, in the small hours, each channel goes back over its own day:

```
## 2026-08-09

_3 conversations reviewed, 24 → 17 memories._

Mostly the boiler and the failed Thursday deploy. Folded in that Kelly Heating
does the service and that the deploy freeze starts on the 15th; those had been
said three times each in different words. Dropped the printer questions from
April — nobody has asked since, and they are in the archive if they matter.
```

That is `data/channels/<id>/memory/DREAMS.md`, written after every pass. The
pass itself reads the channel's own transcripts since the last one, folds what
still matters into memory, merges the entries that say the same thing, and
lets go of the ones that arrived once and were never touched again. It also
catches durable learnings missed in the moment: corrections and teaching,
mistakes with their remedies, reusable preferences or processes exposed by
lengthy work, and important decisions or outcomes. The transcripts are source
material, not memory entries; the pass keeps only concise facts and records
repeatable procedures as skills.

Three mechanisms underneath it:

- **Strengthening.** Being told something twice no longer produces two bullets.
  It makes one bullet count for more, and a fuller restatement refines the
  entry rather than sitting beside it. So when something eventually has to go,
  the fact everyone keeps repeating is not the one that goes.
- **Use.** `recall` takes an `about` argument, and the entries it surfaces are
  marked as used. That is the signal for what a channel actually reaches for.
- **Forgetting, with an undo.** An entry that is old *and* never recalled *and*
  never repeated becomes a candidate — all three, because any one alone
  eventually forgets the address of the house. Everything dropped is appended
  to `memory/MEMORY.archive.md`, so a bad night costs an edit rather than a
  fact.

```yaml
dreams:
  enabled: true
  cron: "0 3 * * *"
  forgetAfterDays: 90       # before an unused entry is even a candidate
  maxConversations: 8       # transcripts reread per pass
  keepTranscripts: 14       # full dream transcripts kept for debugging
  announce: false           # post a one-line note to the channel afterwards
```

### Working out what it did

`DREAMS.md` is the agent's own account of the night, and is exactly as
reliable as the agent. The harness keeps its own, in
`data/channels/<id>/dreams/`:

```
dreams/
  log.jsonl                 one line per run, kept forever
  2026-08-09T03-00-41Z.jsonl  the full transcript of that run
```

```json
{"at":"2026-08-08T03:00:01Z","status":"skipped","reason":"nothing said since the last pass, and no memory has aged out","conversations":0}
{"at":"2026-08-09T03:00:44Z","status":"completed","since":"2026-08-08T03:00:01Z","conversations":3,"staleBefore":6,"entriesBefore":24,"entriesAfter":17,"durationMs":43120,"model":"openai/gpt-5.4","transcript":"2026-08-09T03-00-44Z.jsonl"}
```

Every run is logged, **including the ones that do nothing** — "why did this
channel not dream last night?" is the question a log is for, and it has no
answer if only successes are recorded. The line is small enough at one a night
to keep forever. The transcripts are not, so only the last `keepTranscripts`
survive; they are what holds the tool calls, so the exact text a `forget` was
given is still recoverable a fortnight later.

Both live under the channel root rather than in `memory/`, which puts them
outside the jail: they are for a human with a shell, not context for the agent.
`!dream` shows the last few runs and the path to the rest.

It costs one model call per channel per night, and only for channels with
something to think about: a channel nobody spoke to and whose memory holds no
clutter does not dream at all. Turn it off for a channel with
`dreams: false` in its config, and `!dream` shows the last pass — or runs one
now with `!dream now`, which is how to see what it does without waiting until
3am.

The pass runs with no way to post, no way to ask for permissions and no way to
schedule work: nobody is watching at 3am, so those would be actions with no one
to see them. Its reply goes to the journal, and `announce: true` is the one
route back into the channel.

## Data backups

Upgrading from Pi Durable 1.3 to 1.5 requires a stopped-store backup: SQLite migrates automatically and cannot be
rolled back by reverting dependency pins alone. Stop the harness and back up `data/` before upgrading.

The runtime state is deliberately file-backed, so the backup boundary is simple:
archive the whole `dataDir` once a day. The harness writes one compressed tarball
per date and then removes older date-named archives.

```yaml
backups:
  enabled: true
  cron: "30 2 * * *"
  # Defaults to the schedules timezone. The timezone also decides the date in
  # data-YYYY-MM-DD.tar.gz.
  # timezone: Australia/Melbourne
  # Empty = a backups/ sibling next to dataDir, e.g. ./backups for ./data.
  # Relative paths resolve against the repo root.
  directory: ""
  keepLast: 14
```

By default `dataDir: ./data` produces `./backups/data-YYYY-MM-DD.tar.gz`, not a
folder inside `data/`. If you do point `directory` somewhere inside `dataDir`,
the backup directory is skipped while archiving so new backups do not contain old
ones.

## Asking for permission

Editing YAML and restarting is the wrong loop for "can you get online for a
minute" — slow enough that the safe default gets turned off permanently
instead. So the agent can ask, and a human decides with a button:

> :lock: **Permission request**
> I'd like *internet access for commands in this channel*.
> **Why:** the release notes need the GitHub API.
> `[15 min] [1 hour] [8 hours] [Deny]`

Approving grants the capability **for that duration, in that channel only**,
and the conversation picks up where it left off. Grants expire on their own.

```yaml
channels:
  engineering:
    permissions:
      grantable: [network, web]  # what may be asked for at all
      approvers: [U01234567]     # empty = anyone in the channel
      durations: [15, 60, 480]   # buttons offered; 0 = until revoked
      maxMinutes: 1440
```

Grantable capabilities: `network` (opens the sandbox's network for `bash`),
`web` (reads public pages and downloads public files into the channel workspace,
in a channel that had it removed), `bash` (enables the shell), `memoryWrite`
(account-wide memory).

**`network` and `web` are grantable in every channel by default.** Asking is
not itself a privilege — nothing happens until a human clicks approve, and the
grant expires on its own. `bash` and `memoryWrite` are not, because they change
what the channel fundamentally is; add them deliberately.

The agent is only offered capabilities it does not already have, which is why
these two rarely come up: `web` is on by default, and `network` is only
meaningful where there is a shell for it to put online. In `host` sandbox mode
a shell already has network, and a channel with no `bash` gains nothing from
the sandbox being connected — so neither is offered, rather than spending
somebody's approval on a no-op.

### Permanent grants

A duration of `0` means "until revoked". It needs its own opt-in, because a
permanent grant is a different decision from a long one rather than the end of
the same slider:

```yaml
permissions:
  allowPermanent: true
  durations: [60, 480, 0]   # 0 renders as "Until revoked"
```

Without `allowPermanent`, a `0` button is not offered and a click is refused —
checked at click time, not just when the message is built.

Prefer the config for anything genuinely always-on. A grant lives in `data/`,
which means it is invisible in review and disappears if that directory is
cleared; a config line is neither. When a permanent grant is approved, the
confirmation prints the config that would do the same thing, so you can move it
across when it turns out to be permanent in practice.

Two properties this leans on:

- **`grantable` is a ceiling, not a default.** A capability absent from it
  cannot be requested or granted no matter what the agent asks or who clicks —
  and it is empty by default, so asking is opt-in like everything else. The
  check runs when the button is clicked too, so tightening the config
  invalidates buttons already sitting in the channel.
- **Grants are per channel**, stored in `data/channels/<id>/grants.json`.
  Approving network access in `#engineering` does nothing for `#home`.

`!grants` shows what is granted and what could be asked for; `!revoke <cap>`
or `!revoke all` takes it back immediately.

This needs **Interactivity** enabled on the Slack app. In Socket Mode there is
no request URL to fill in — just switch it on.

## Telling you what's missing

Asking for permission covers the walls you already decided could be moved.
Everything else — a tool that does not exist, data the channel cannot reach,
something it was expected to know that nobody wrote down — has until now been
invisible. The agent apologises in a thread, the person asks someone else, and
next week it happens again. Nothing in `data/` records that it ever happened.

So the agent can file it, with `report_limitation`:

> **you** @seneschal can you log in to the supplier portal and find the tolerance?
> **seneschal** I can't log in to sites or drive their forms. If you can give me a public datasheet URL, I can download it into this channel's workspace; otherwise paste the relevant specification. I've noted the gap for whoever maintains me.

which lands in `data/shared/feedback/FEEDBACK.md`:

```markdown
### Cannot log in to third-party sites

`a3f19c2e5b40` · tool — there was no tool or command for the job
_Reported 4× from #ops, #home, #engineering. First 2026-07-02, last 2026-08-09._

- (2026-07-02, #ops) Supplier documentation was available only after login.
- (2026-08-09, #engineering) A public API required an interactive session.
```

**One log for the whole account, because the count is the point.** "#home
wanted a PDF reader" is a shrug; "four channels wanted a PDF reader" is the
next thing to build. Reporting something already on file bumps its count and
adds the channel rather than opening a second near-identical item — the same
strengthening memory does with a repeated fact, and for the same reason: a file
of near-duplicates is a file nobody reads.

**The record is `feedback.jsonl`, one line per report.** `FEEDBACK.md` is
rendered from it on every change, open items first, worst first — so it is
always current, and anything you write into it by hand is overwritten. The
JSONL is there to feed a backlog: one `jq` line turns open items into issues.

### The loop, not the file

A file in `data/` that somebody has to remember to open is not a review loop.
So the harness comes to you:

```yaml
feedback:
  digestChannel: admin        # where the digest goes; empty = no digest
  cron: "0 9 * * MON"         # Monday morning
  announceResolved: true      # tell the channels that reported it when it closes
```

> **seneschal** *What I couldn't do since 2 Aug* — 2 new, 1 hit again, 1 back open
>
> *Back open after being closed*
> • `a3f19c2e` Cannot read PDFs that people paste — _tool, 5× from #ops, #home, #eng_
>
> *Open, most reported first* (7 in total)
> 5× `a3f19c2e` Cannot read PDFs that people paste _(3 channels)_
> 2× `bc41d0a7` No way to search Slack for an older thread _(2 channels)_

**It leads with the delta and stays quiet when there isn't one.** A weekly
message that is sometimes empty is one people stop opening, so a week where
nothing moved produces no message at all. `!feedback digest` sends one early.
Startup is the exception: once the process has connected to Slack and registered
its background jobs, it posts a one-line success notice to `digestChannel` so
the operator channel has a visible liveness signal.

**Reopening is the honest answer to "was that fixed?"** Closing an item is
`!feedback resolve <id> [note]`, or the reviewer-only `resolve_feedback` tool
when an operator explicitly asks the agent to close ids. If any channel hits the same wall afterwards
the item comes back, and the next digest leads with it — a fix that did not land
is the one thing that cannot wait for next week.

**The channels that reported it are told when it closes** (`announceResolved`,
on by default). An agent that reports a wall and never hears back is one whose
people learn that reporting things achieves nothing:

> **seneschal** *Fixed:* Cannot read PDFs that people paste into the channel.
> _You ran into this and it was reported from here. An operator has now closed it — added a PDF extractor. If it happens again, say so and I'll reopen it._

**The digest channel is the one place the whole log can be read.** Its agent
gets read access to `shared/feedback/` — so you can ask it to group the reports,
weigh them, or turn them into issues through a connector — and `!feedback all`
works there. Read only, even there: a channel that could edit the log could
erase what another channel filed. Everywhere else, `!feedback` shows only what
that channel reported itself.

Four things keep it from becoming noise:

- **The channel is stamped by the harness, not the model.** The distinct-channel
  count is what decides priority, so a channel does not get to write it.
- **The file is outside every jail.** The tool is the only way in, and there is
  no way to read it back — an agent sees the count on its own report, never
  another channel's words. `!feedback` in Slack shows only what *that* channel
  filed; the cross-channel view is the file on disk, where an operator is the
  one reading.
- **The agent is told what not to send.** Not its own mistakes, not someone's
  disappointment with an answer, and not anything `request_access` could grant
  — that door already exists. It is also told plainly that filing a report is
  not a fix, so it does not promise anyone one.
- **Nothing is delivered twice.** A reopened item is news; it is not also
  listed as a number that went up.

Reporting itself has no config: like memory, every channel has it. A channel
whose agent cannot say what got in its way is one that fails the same way every
week without anyone finding out. Only the delivery — where the digest goes, and
when — is yours to set.

## Batched notifications

For noisy routine updates, every channel can queue a short item with
`submit_notification` instead of posting directly. Only the configured
notification channel can collect the shared inbox with `collect_notifications`,
so a scheduled agent there can summarise the batch into one Slack post.

```yaml
notifications:
  enabled: true
  channel: admin             # name, #name, or Slack id allowed to collect
  maxPending: 200            # uncollected items before new submissions refuse
  maxMessageChars: 4000      # per submitted item
```

A typical setup is to schedule this in the notification channel:

> Collect pending notifications with `collect_notifications`, summarise them
> into one concise morning update, publish it with `post_message`, and do not
> post each item separately.

Submitted items are copied into `data/shared/notifications/notifications.jsonl`
with the source channel and user stamped by the harness. That file is outside
channel jails: submitting is the explicit boundary crossing, and collecting is
restricted to `notifications.channel`.

## Current time

`get_current_time({})` reads the harness host's clock at invocation. It is always
available in interactive conversations, scheduled runs (including quiet runs),
and subagents, even without `bash` or scheduling permissions; there is nothing
to add to a channel's `tools` list. Agents can call it again whenever they need
to refresh “now”, interpret today/tomorrow, or set a schedule.

Each call takes one clock reading and returns JSON with:

- `timestamp`: the UTC ISO-8601 instant, e.g. `2026-01-01T13:00:00.000Z`.
- `localDate` and `localTime`: `YYYY-MM-DD` and 24-hour `HH:mm:ss.SSS` in the configured timezone.
- `timezone`: the harness's `schedules.timezone` (defaults to `UTC`), even when scheduling is disabled. It does not inherit an individual scheduled task's timezone, and there is no per-call override.
- `utcOffset`: the numeric offset at that instant, e.g. `+11:00`, `-05:00` or `+00:00`; daylight-saving changes are reflected on each call.

This is an on-demand clock check, not a replacement for fresh scheduled-run
prompt context. It does not change existing schedules.

## Scheduling

The agent can schedule its own follow-up work straight from a conversation —
"remind me Friday", "check the backups every morning", "chase that PR in an
hour". It has four tools: `schedule_task`, `list_scheduled_tasks`,
`update_scheduled_task` and `cancel_scheduled_task`, taking either a cron
expression or a one-off timestamp.

When a task fires, it normally posts a new message in the channel and answers
in that thread, so each run is its own conversation and everyone can see it.
For one-off “check back here later” work, `schedule_task` also accepts
`in_thread: true` with `runAt`; that resumes the Slack thread where it was
created instead of starting a new channel post.

Use `update_scheduled_task` with an existing `id` to edit `prompt`,
`cron`, `runAt`, `timezone`, `quiet` or `run_if_missed` in place.
Omitted settings, attribution, run history and compatible thread targeting stay
unchanged. Supplying `cron` replaces a one-shot's `runAt`; supplying
`runAt` replaces its `cron`. Supplying both is rejected. When switching
to one-shot, explicitly set `run_if_missed: false` if catch-up was enabled.
Thread-targeted tasks cannot become recurring or quiet. A timezone-only edit
changes cron interpretation but does not move a one-shot's stored absolute time;
new timestamps use the same parsing as creation (include an explicit UTC offset
to avoid ambiguity). Edits must satisfy the same validation and minimum interval
as creation, but are allowed at the channel's schedule-count limit. Invalid edits
leave the stored task and active timer unchanged; successful edits return the
updated schedule and next run time.

```yaml
schedules:
  enabled: true
  timezone: Australia/Sydney   # set this — the UTC default surprises people
  maxPerChannel: 20
  minIntervalMinutes: 5        # refuses anything more frequent
```

Set `schedules: false` on a channel to turn it off there.

Two things worth knowing:

- **Scheduled work runs in the channel that created it.** There is no
  cross-channel scheduling, by design — otherwise a task made in one channel
  could act with another channel's tools and credentials. By default it posts
  back to the channel; thread check-backs only resume the current thread when
  the agent explicitly schedules them with `in_thread: true`.
- **Missed runs are opt-in.** If the harness is off overnight, cron tasks do not
  replay by default, so you do not get a burst of backlogged reminders when it
  comes back. For important cron tasks, `run_if_missed: true` runs one catch-up
  execution at startup when the latest scheduled time was missed. One-shots
  whose time passed while it was down are dropped.
- **Every outcome is recorded.** `data/channels/<channel>/schedule-runs.jsonl`
  is an append-only ledger of start/end times, status, errors and the Slack
  permalink for visible runs. Agent-declared failures are failures here too, so
  the task's `lastError` is cleared only after a completed run.
- **A scheduled run gets the same context as a person talking to the channel** —
  the same model, tools, env file, connectors and memory. A job that can do
  something by hand can do it on a timer. If a run seems to have less than the
  channel does, the line the scheduler logs when it fires names the config entry
  it matched, the tools it got and the env layers it loaded. `config=(defaults)`
  there means the channel's entry was not matched at all.

The minimum interval exists because an agent asked for "check often" will
happily reach for `* * * * *`, which on a metered API is an expensive mistake.

Definitions live in `data/channels/<id>/schedules.json`, so they survive
restarts and can be edited or deleted by hand.

## Models

The harness is provider-agnostic and defaults to `deepseek-v4-pro`. Only models
whose provider has working credentials are ever listed or offered.

### Secrets: global and per-channel

**OpenBao (optional):** import secrets from KV v2 in three explicit scopes: channel, global-channel, and main-process-only. Manage them through Admin → Secrets and restart (opt-in private write credential) or `npm run secrets -- openbao set/list/remove …`; values are never exported to `.env` or configuration APIs. Main-process Slack/model credentials are delivered directly, not inherited by channels. See [OpenBao setup, policies, precedence, isolation and rotation](docs/openbao.md). The Managed environment backend and commands below still manage legacy environment storage.

Two different kinds of legacy credential, with two different scopes:

**Provider credentials** (the LLM keys) are the operator's and belong to the
whole harness — one `auth.json`, shared by every channel. See below.

**Connector credentials** are not. The GitHub token `#engineering` uses should
not be reachable from `#home`, or connector isolation is decorative. So env
values resolve in layers, most specific winning:

```
process environment  <  global env file  <  channel env file  <  harness runtime vars
```

```yaml
envFile: ./secrets/global.env        # shared by every channel

channels:
  engineering:
    envFile: ./secrets/engineering.env   # overrides the global bundle
```

A channel with no `envFile` picks up `data/channels/<id>/env` if that file
exists, so you can drop secrets next to the channel's state without touching
config at all.

`${VAR}` in a connector definition is expanded **per channel**, so one
catalogue entry can serve several channels on different tokens:

```yaml
connectors:
  github:
    transport: http
    url: https://api.example.com/mcp
    headers: { Authorization: "Bearer ${GITHUB_TOKEN}" }
```

`#engineering` and `#ops` can both enable `github` and authenticate as
different identities, purely from their own env files.

The harness also adds reserved per-channel runtime vars after env files are
loaded, so they cannot be spoofed by a secret file and resolve differently for
each channel:

- `HARNESS_CHANNEL_ID`
- `HARNESS_CHANNEL_NAME` when Slack has a name for the channel
- `HARNESS_CHANNEL_ROOT`
- `HARNESS_CHANNEL_WORKSPACE`
- `HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS`

Use them when a connector needs a host path for this specific channel, for
example forcing `workspace-mcp` Gmail downloads into the attachable workspace:

```yaml
connectors:
  google_workspace:
    transport: stdio
    command: uvx
    args: [workspace-mcp, --tool-tier, extended, --tools, gmail, drive, calendar]
    env:
      WORKSPACE_ATTACHMENT_DIR: "${HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS}"
```

### Connector-downloaded PDFs

When a stdio connector is configured with `WORKSPACE_ATTACHMENT_DIR` set to the
exact `${HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS}` path above, Gmail- or
attachment-named connector tools are watched for new PDFs. The harness extracts
each new regular PDF to a sibling `receipt.pdf.txt` using the normal
`pdftotext` → bundled pdf.js → safe parser fallback pipeline, then adds that
text path to the connector result for the agent to read.

Agents also have `extract_local_pdf` for a staged `attachments/receipt.pdf`.
It can write `receipt.pdf.txt` (default) or `receipt.pdf.md`, but it cannot
read arbitrary workspace or host files: only regular PDFs directly in the
channel attachment directory are accepted. Sources are preserved, and a pre-existing output is reused only when its
harness-written fingerprint matches the current PDF and extracted text; otherwise
it is left untouched. Symlinks are refused, and the shared 12 MiB
attachment limit applies. No shell command is exposed or run on the agent's
behalf.

For a remote Linux file tree over SFTP, use the reviewed, key-only connector recipe in
[`docs/sftp-mcp.md`](docs/sftp-mcp.md). It requires a dedicated SFTP-only chroot;
a connector-level path prefix is not enough to constrain read operations.

Stdio MCP connectors are started with the invoking channel workspace as their
working directory. That means connector tools that write relative paths, such as
export commands, put those files inside the same workspace the agent can read,
attach, and jail-check. This is a convenience boundary, not a connector sandbox:
a stdio connector is still a trusted host process with the configured channel
environment.

The bundle also becomes the environment for `bash` in that channel, so `gh` and
friends pick up the channel's token rather than the harness's.

Channel env files live in the channel's directory but **outside its tool jail**,
so the agent can use its secrets without being able to read them back out and
paste them into Slack. (`bash`, if enabled, can still read anything the process
can — that trade-off is unchanged.)

`!env` lists the variable names available in a channel. It never prints values.

Operators can add, replace, list and remove channel env-file secrets without
opening the file in an editor. The command resolves Slack IDs, known channel
names and `#name`, creates the env file with `0600` permissions when needed,
and still prints names only:

```bash
printf '%s' "$TOKEN" | npm run secrets -- set engineering GITHUB_TOKEN
npm run secrets -- list engineering
npm run secrets -- remove engineering GITHUB_TOKEN
```

### OAuth for remote HTTP MCP connectors

HTTP MCP connectors can use OAuth when the remote server expects the MCP host to
authorize as a user. The connector keeps OAuth tokens in the channel's private
state by default, or in `oauth.tokenFile` if you choose one. Client IDs and
secrets can come from the channel/global env bundle just like headers.

```yaml
connectors:
  google-calendar:
    transport: http
    description: Google Calendar remote MCP
    url: https://calendarmcp.googleapis.com/mcp/v1
    oauth:
      clientId: ${GOOGLE_CALENDAR_MCP_CLIENT_ID}
      clientSecret: ${GOOGLE_CALENDAR_MCP_CLIENT_SECRET}
      # Exact HTTPS URL of the hosted docs/oauth-complete.html page.
      redirectUrl: https://oauth-complete.example.org/
      # A pending Slack completion expires after 10 minutes by default (60–3600).
      manualCompletionTtlSeconds: 600
      # scope: optional permission boundary; omitted uses server-advertised scopes
      # tokenFile: optional; relative paths resolve from the repo root

channels:
  admin:
    share:
      connectors: [google-calendar]
```

#### Cross-device Slack initiation with the console callback (opt-in)

For **HTTP MCP connectors using the harness OAuth provider**, a user can run
`!connector-auth connect <connector>` in an enabled Slack channel, open a private
link on another device, compare a browser challenge with an ephemeral approval
prompt in that same Slack thread, and approve the matching browser. Only the
initiating Slack user can approve; simply visiting the console (or logging into
Cloudflare Access) cannot start provider consent. After provider consent, the
harness exchanges the authorization code server-side and reports success or a
sanitized failure in the originating thread. Nothing needs to be copied from the
browser into Slack.

You can also initiate directly from the **channel's web page**: choose **Connect**
next to a supported connector, then **Request Slack approval** in that browser.
This creates only a short-lived browser pairing request and a public prompt in
the corresponding Slack channel. It does not assume a Slack user, discover/register
an OAuth client, generate OAuth state/PKCE, or start provider consent yet. The
first allowed Slack user who confirms **their own matching browser challenge**
becomes the authorizing user; later clicks cannot take over that session. Completion
is posted in the new prompt's Slack thread. A visitor's proxy login/email and
browser-supplied user IDs are never accepted as Slack identity. The visible
pairing challenge is not an authorization code or credential; the browser cookie
remains private. Unsupported/unconfigured connectors have no Connect action.

The web request selects only a known channel and enabled connector name;
server-side resolution supplies its configuration, callback and store path.
GETs and link previews do not create requests. Posting a request requires an
explicit button click and same-origin JSON POST; it issues a private browser cookie for polling/callback and requires later
Slack confirmation, with the same expiry/global capacity/channel-connector
serialization as Slack initiation. Authenticated console visitors can request
pairing prompts, not consent: keep console access restricted to trusted users.

Configure this explicitly (the example is not installation-local configuration):

```yaml
webConsole:
  enabled: true
  host: 127.0.0.1
  port: 3012
  baseUrl: https://console.example.org/harness
  oauth:
    # Must be EXACTLY the console base URL path + /oauth/callback.
    callbackUrl: https://console.example.org/harness/oauth/callback
    ttlSeconds: 600             # 60–900 seconds, from either initiation path

connectors:
  calendar:
    transport: http
    url: https://mcp.example.org/mcp
    oauth:
      consoleCallback: true    # New connect command is disabled otherwise.
      redirectUrl: https://console.example.org/harness/oauth/callback
      clientId: ${CALENDAR_MCP_CLIENT_ID}   # Omit only if provider supports DCR.
      # clientSecret: ${CALENDAR_MCP_CLIENT_SECRET}
      # tokenEndpointAuthMethod: none
      scope: mcp:read           # Review provider-specific scopes.

channels:
  admin:
    share:
      connectors: [calendar]
```

Register that **exact HTTPS callback** with each provider/pre-registered client.
Do not infer it from `Host`, forwarding headers, proxy identity, or user input.
The connector `redirectUrl` must match `webConsole.oauth.callbackUrl` exactly;
the new command never silently overrides a localhost/manual redirect. Cached DCR
registrations for a previous URI must be reset by an operator after reviewing
registration/scopes (see recovery below: operator reset, then Slack/web Connect, not ordinary CLI auth). Dynamic registration can work only
where the provider permits this public URI. Restart after changing console OAuth
settings; ordinary connector/user permission reloads are rechecked before
consent and before saving credentials.

**Scope and compatibility:** HTTP MCP authorization uses the existing MCP SDK
for discovery, client registration, S256 PKCE and code exchange. Providers must
support that authorization-code/PKCE flow and GET query callbacks, with HTTPS
consent endpoints; discovery/token HTTP redirects are rejected. This is **not**
a generic interceptor for third-party stdio connectors' localhost callbacks.
Those require connector-specific changes (configurable public redirect, PKCE/state,
and a harness credential-store integration), or their existing host login. It
does not implement Slack user-token login or model subscription login: those
retain their existing CLI/store paths.

HTTP MCP credentials remain **channel + connector scoped**, shared with all
users allowed in that channel, not personal credentials keyed by Slack user.
The initiating user is bound to the consent flight and its notification only.
Use a dedicated restricted channel for personal/provider accounts. The new flow
rejects custom `oauth.tokenFile` paths so aliases cannot cross channel boundaries.
An authorization is serialized per channel/connector; other users cannot replace
its pending flight. A concurrent runtime refresh/manual login/reset causes the
final save to fail rather than overwrite newer credentials. Fresh grants replace
old tokens atomically with `0600` permissions and never inherit a previous
account's refresh token. Retry the original request after completion; an already
open connector session may need `!reset` to reconnect.

**Proxy/browser safety:**

- Keep the listener private/loopback behind an authenticated HTTPS reverse proxy,
  such as Cloudflare Access. Protect the **whole console**, including `/oauth/*`;
  do not exempt the callback or expose the origin port directly. The provider
  returns through the user's already-authenticated browser, not a webhook.
  Authenticate at the console *before* starting consent; if Access reauthenticates
  or drops the callback query/fragment/cookie, restart the flow. Forward the
  configured path prefix unchanged, and the public `Host` (see
  [Host checking](#host-checking-and-reverse-proxies)); other hosts get 421. Proxy and Slack identities are deliberately
  independent; do not use email/header matching as authorization.
- Disable query-string logging, request-body capture, analytics, tracing and URL
  capture for OAuth routes **at every layer**, including CDN, Access, proxy and
  APM. The callback's initial query necessarily contains a provider code/state;
  the harness never logs it, redirects immediately to a fixed query-free result
  page, and never echoes provider errors/codes/tokens. Callback processing cannot
  undo upstream logging. The private connect capability is a fragment removed
  immediately by the page, not a server query parameter. Do not share links or
  approve a challenge from another browser.
- Browser binding uses a Secure/HttpOnly/SameSite=Lax cookie plus exact-Origin
  checks on POSTs. The console connect page has no third-party scripts, denies
  framing, uses a restrictive CSP, and sends `no-store`/`no-referrer`. Keep the
  same browser/profile through consent. Only one connect flow should be active
  in a browser at a time; its single cookie can be replaced by another flow.
- Prefer a **fresh dedicated console origin**; serve untrusted artifacts on a
  separate origin at the proxy. When OAuth is enabled on the shared listener,
  artifact documents get `CSP: sandbox allow-scripts allow-downloads; worker-src
  'none'`, with no same-origin/top-navigation/popup privilege. This is an explicit
  security consequence of OAuth opt-in: module imports, forms and origin-dependent
  artifact features may stop working. Download/open them separately if needed.
  Clear any previously installed service workers/site data before reusing an
  existing artifact origin; a pre-existing malicious same-origin worker/script
  is outside this flow's trust boundary. Never run untrusted non-sandboxed code
  on the console origin or strip the artifact sandbox header at the proxy.

Provisional web pairings, state, verifier and browser/link capabilities live only in bounded server memory
(maximum 100 pending flights), expire within 15 seconds of their TTL even if idle,
and are invalidated by restart. OAuth state is created only after a web request acquires an allowed Slack authorizer,
is single-use and tied to the exact user,
channel, connector, browser, redirect URI and config snapshot. Cancellation,
provider denial, duplicate callbacks, issuer mismatch (when `iss` is supplied),
expiry and failed exchange cannot persist a grant. The initiating user can cancel
from the Slack prompt at any unfinished phase, including consent/token exchange;
cancellation prevents a late local save but does not revoke a provider-side grant. Network operations have a
60-second upper bound and cannot commit after cancellation/expiry. A dropped
Slack notification is not retried durably; check `!connectors`/retry your request,
or start again after expiry if no completion appears.

Existing `!connector-auth start/complete` and the localhost CLI callback remain
unchanged for connectors configured with their existing redirects. Choosing the
console callback for a connector is an explicit migration: its old manual/static
completion page is no longer that connector's callback; Slack manual start/complete
commands direct those opted-in connectors to `connect` instead. Keep other connectors
on localhost/manual auth where public redirect registration is unsupported;
there is no automatic fallback or callback URL takeover.

#### Static redirect page and manual Slack completion

The legacy manual flow does not need a browser-reachable callback endpoint. Host
[`docs/oauth-complete.html`](docs/oauth-complete.html) at a stable HTTPS URL and
register that *exact* URL with the OAuth provider as its redirect URI. The page
is a self-contained static file: it has no backend, forms, analytics, external
assets, or network requests. It reads `code` and `state`, puts them in a
versioned copyable payload, then removes query parameters from the address bar.

Deploy the file unchanged to any static HTTPS host (for example a dedicated
Cloudflare Pages or GitHub Pages site). Configure that host not to add analytics
and not to retain URL query strings in access logs. If the file is changed,
update its inline-script/style CSP hashes too. Do *not* point this manual flow at the console callback: that endpoint accepts only browser-paired console sessions.

Start and finish authorization in the enabled Slack channel:

```
!connector-auth start google-calendar
!connector-auth complete google-calendar oauth-result-v1.<payload-from-page>
```

`start` creates a fresh PKCE verifier and a one-time, short-lived state session
in the channel's private OAuth store, then posts the provider authorization URL.
After approval, paste only the payload displayed by the completion page into
that channel. The harness validates the state and expiry, consumes the session
before exchanging the code with its saved verifier, and never echoes the
payload, authorization code, provider error, or tokens. Treat the payload as a
one-time password and delete the Slack message after the confirmation.

The host CLI supports the same flow when needed:

```bash
npm run connector-auth -- admin google-calendar
npm run connector-auth -- --result oauth-result-v1.<payload-from-page> admin google-calendar
```

A localhost callback is still supported by the CLI; it also validates state
before exchanging the code.

An explicit `oauth.scope` takes precedence over both server-advertised scopes and
`WWW-Authenticate` scope challenges, in the CLI and runtime. The harness will not
silently request extra permissions to satisfy a challenge. If the server needs
more scopes, an operator must review the configuration and reauthorize. Existing
tokens are not downscoped by editing the config: revoke a previously broad grant
in the provider's connected-app settings, then reset and reauthorize.

#### Recovering a rejected or stale OAuth client

A browser rejection before consent does not reach the SDK's automatic
invalid-client recovery. Rerunning auth ordinarily reuses the saved client;
changing the configured callback or scope does not update its registration.
For example, Redbark restricts a client registered with multiple scopes to its
registered set: requesting all advertised scopes with an older read-only client
can fail before consent. This is distinct from a revoked or unknown client.

First confirm the effective connector scope and exact registered redirect URI
privately. Do not paste authorization URLs, OAuth files, token values, client
secrets, PKCE verifiers, or state into Slack or issue reports. If desired, an
operator may privately back up **only** the selected connector's store with
restrictive permissions before resetting. The default store is
`<dataDir>/channels/<channelId>/agent/oauth-connectors/<connector>.json`;
`oauth.tokenFile` overrides it (relative paths resolve from the repository root).
An override may intentionally share state; check its consumers first. Avoid
concurrent connector use/authorization while resetting and completing auth.

```bash
npm run connector-auth -- --config /path/to/harness.yaml --reset CHANNEL CONNECTOR
# For legacy manual/static/localhost connectors ONLY:
npm run connector-auth -- --config /path/to/harness.yaml CHANNEL CONNECTOR
```

For `oauth.consoleCallback: true`, follow the same operator `--reset` with
`!connector-auth connect CONNECTOR` in the enabled Slack channel, or **Connect**
on that channel's web page. Ordinary CLI start and `--result` explicitly refuse
these connectors before any discovery/manual state creation: the console callback
never displays a copyable manual payload. Do not migrate the callback and then
follow a localhost/manual completion recipe.

`--reset` is operator-only and exits without starting OAuth. It clears the cached
client, tokens, discovery, authorization URL, pending state and PKCE verifier for
that resolved connector store; it does not change config, clear other stores or
revoke server-side grants. A configured static `clientId`/`clientSecret` remains
configured after reset; fix its provider registration rather than expecting
reset to create a new identity. With dynamic registration, the next run discovers
the provider and registers a fresh client using the configured scope/callback.
Use a fresh authorization URL and verify the requested permissions before
consenting. If a fresh client with the correct scope and callback still fails,
ask the provider for a sanitized OAuth error or server request ID—do not send the
full URL. A healthy API-key connection does not validate an OAuth registration.

#### Cloudflare API MCP

Cloudflare provides an official remote API MCP server at
`https://mcp.cloudflare.com/mcp`. Configure it as an HTTP connector and enable
it only in a dedicated channel. The harness uses OAuth with dynamic client
registration, so do not put a Cloudflare global API key in configuration.

```yaml
connectors:
  cloudflare-api:
    transport: http
    description: Manage Cloudflare through Cloudflare's official remote API MCP server
    url: https://mcp.cloudflare.com/mcp
    oauth:
      redirectUrl: https://oauth-complete.example.org/
      clientName: Home Harness Cloudflare

channels:
  cloudflare:
    description: Manage the Cloudflare account.
    respondToRootMessages: true
    preferences: |
      Use the cloudflare-api connector for Cloudflare account actions.
      Explain the intended change and obtain explicit confirmation before making
      production, destructive, or security-sensitive changes.
    share:
      connectors: [cloudflare-api]
```

After the harness has seen the Slack `#cloudflare` channel, use
`!connector-auth start cloudflare-api` in that channel and finish with the
payload from the static completion page. Grant only the Cloudflare permissions
the channel needs; OAuth tokens are stored in channel-private state. Cloudflare's
API MCP server exposes `search` and `execute`, so authorization scopes—not a
broad API token—are the access boundary.

### Credentials

Two ways to authenticate, and you can mix them:

**API key (pay per token).** Put it in `.env` — `DEEPSEEK_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, … The scripts load `.env` automatically.

**Subscription (OAuth).** Several providers authenticate with a plan you
already pay for, instead of a metered key:

| Provider id | Subscription | Models |
|---|---|---|
| `openai-codex` | ChatGPT Plus/Pro | `gpt-5.4` … `gpt-5.6-*`, codex |
| `anthropic` | Claude Pro/Max | Claude models |
| `github-copilot` | GitHub Copilot | GPT, Claude and Gemini models |
| `xai`, `kimi-coding` | their own plans | — |

Sign in with the harness itself — no other tool required:

```bash
npm run login                     # pick from a list
npm run login -- openai-codex     # straight to ChatGPT
npm run login -- --list           # what am I signed in to?
npm run login -- --logout openai-codex
```

It offers **browser** or **device-code** login. Device code is the one you
want on a headless Pi: it prints a URL and a short code to enter on your
phone or laptop, and no browser is needed on the box itself.

Credentials are written to the harness's own store (`<dataDir>/auth.json`, or
wherever `authPath` points), so nothing else needs installing and the harness
owns its own credentials.

Then set the model, with the provider prefix — `openai-codex/gpt-5.4` is your
subscription, `openai/gpt-5.4` is the metered API:

```yaml
defaults:
  model: openai-codex/gpt-5.4
```

`npm run doctor` shows each provider and whether it resolved via `API key`,
`subscription/OAuth`, or a configured local provider.

### Local OpenAI-compatible servers

Add local or private Chat Completions servers such as Ollama, LM Studio, vLLM,
llama.cpp, or TurboFieldfare under `modelProviders`. The harness uses Pi's
`openai-completions` adapter. Local servers often ignore the API key, but the
dummy value marks the provider configured.

`baseUrl` is the API prefix, not the full Chat Completions endpoint. Pi appends
`/chat/completions` and preserves the prefix exactly: include `/v1` when the
server requires it. Provider registration does not validate the route or run a
completion request. A successful registration can therefore still be followed
by an HTTP 404 on the first turn.

```yaml
modelProviders:
  turbofieldfare:
    name: TurboFieldfare
    baseUrl: http://127.0.0.1:8080/v1
    apiKey: local
    compat:
      supportsReasoningEffort: false
      supportsStrictMode: false
      supportsUsageInStreaming: true
    models:
      - id: gemma-4-26b-a4b-it
        name: Gemma 4 26B-A4B IT
        reasoning: false
        contextWindow: 16384
        maxTokens: 4096

defaults:
  model: turbofieldfare/gemma-4-26b-a4b-it
```

Keep unauthenticated servers on loopback (`127.0.0.1`) or behind your own
authenticated proxy. Channels can still restrict access with their normal
`models` allowlists, e.g. `models: [turbofieldfare/*]`.

Credentials are **account-level, not per-channel** — a single `auth.json`
shared by every channel, defaulting to `<dataDir>/auth.json`. Channels are
isolated from each other, but they all run on the operator's one key or
subscription, and an OAuth token needs to refresh in exactly one place.

> Worth checking the provider's terms before pointing a subscription at an
> always-on Slack bot. Subscription OAuth is intended for that vendor's own
> CLI; driving unattended automation through it may be outside what the plan
> allows, and rate limits are built for one person at a keyboard rather than a
> channel full of them. An API key is the unambiguous option.

The agent can manage its own model. It has two tools:

- `list_models` — what it can run on, with context window, reasoning support
  and price.
- `switch_model` — move itself to another model for the rest of the
  conversation, e.g. escalating to a reasoning model for a hard problem or
  dropping to a cheap one for routine chatter.

A switch is remembered per thread and survives the session being evicted, so
an idle conversation resumes on the model it switched to rather than silently
reverting. Humans set the channel default with `!model <id>`.

Keep the agent on a leash with a per-channel allowlist:

```yaml
channels:
  engineering:
    model: openai/gpt-5.4
    models: [deepseek-v4-pro, openai/gpt-5.4, openai/o4-mini]   # may switch within these

  private-notes:
    model: deepseek-v4-flash
    models: [deepseek-v4-flash]        # pinned; cannot switch away
```

Entries may be a bare id (`gpt-5.4`), `provider/id`, or `provider/*` for a
whole provider. An empty list means anything the harness has credentials for.
Bare ids resolve to the provider that has credentials, so short names stay
unambiguous in practice.

## Configuration

Everything lives in `config/harness.yaml`; see
[`config/harness.example.yaml`](config/harness.example.yaml) for a commented
example.

```yaml
defaults:
  model: deepseek-v4-pro
  models: []                                        # models the agent may switch to
  tools: [read, write, edit, ls, find, grep, sqlite, charts, slides, file_ops, web] # file_ops, no bash/exec
  exec:
    commands: {}           # selected CLIs, exposed only when `exec` is in tools
  web:
    search:
      provider: none       # none | brave | tavily | searxng
      apiKey: ""           # ${VAR} is resolved from the channel's secrets
    downloadMaxBytes: 20971520    # bounded binary/PDF staging in the workspace
    allowPrivateHosts: false   # the local network is off limits by default
  context:
    threadBackfill: 50     # messages read when tagged into a running thread
    channelBackfill: 0     # recent channel messages on a new top-level mention
    dmBackfill: 20         # recent DM history at the top level of a DM
  recentConversations:
    enabled: true          # rolling prompt list; not durable memory
    debounceSeconds: 60    # summarise after a handled thread goes quiet
    maxThreads: 10         # newest updated thread summaries to inject
    model: deepseek-v4-flash
  share:
    knowledge: true        # read the account knowledge base
    memoryRead: true       # read account memory
    memoryWrite: false     # but do not write to it
    documents: true        # search and read the document library
    documentsAdd: true     # and file attachments into it
    skillCollections: []   # no shared skill collections ({ name, mode: ro|rw }, ro by default)
    connectors: []         # nothing from the catalogue
    delegateTo: []         # strings or { channel, reason } task-transfer targets; completion returns to source
    sharedToolsPublish: false  # publish executable scripts to data/shared/bin/
    sharedTools: {}            # shared-bin tools THIS channel may run, by name, with its own argv allowlist

connectors:                # a catalogue. Defining a connector does NOT enable it.
  github:
    transport: http
    url: https://api.example.com/mcp
    headers: { Authorization: "Bearer ${GITHUB_MCP_TOKEN}" }

channels:
  engineering:
    model: openai/gpt-5.4
    models: [deepseek-v4-pro, openai/gpt-5.4]              # may switch within these
    tools: [read, write, edit, ls, find, grep, sqlite, web, bash]   # bash enabled here only
    requires:
      binaries: [gh, jq]        # refuse to run without these
      env: [GH_TOKEN]
    share:
      skillCollections: [software-development]   # data/shared/skills/software-development/, read-only
      connectors: [github]      # from the catalogue above
      memoryWrite: true         # trusted to update the account brain

  life-admin:
    share:
      delegateTo:
        - channel: engineering           # task runs there; its completion returns to this thread
          reason: technical work needing bash and deploy context

  ops:
    share:
      channelMemoryRead: [engineering]   # explicit, one-way visibility
```

Channels are keyed by name or by Slack channel ID. IDs win, and survive a
channel rename.

A name is matched against what Slack reports for the channel, which the harness
learns the first time it is spoken to there and then remembers in
`data/channels/index.json` — that is what lets a scheduled task or the overnight
pass, neither of which has a Slack message behind it, still find an entry keyed
by name. The registry only retains Slack conversation IDs (`C…`, `D…`, or `G…`),
never config aliases; on startup it automatically removes legacy name-as-ID
cache entries (such as `{ id: "qa", name: "qa" }`) without changing any channel
workspace or environment. Keying by ID skips the lookup entirely and is the
safer choice for a channel whose config really matters.

### Being opinionated about tooling

A channel can declare what the host must provide. Missing requirements are
caught at startup (account level) or before the first message (channel level),
rather than by the model halfway through a task:

```yaml
requires:
  binaries: [gh, git, jq]
  env: [GH_TOKEN]
  onMissing: fail      # or "warn"
```

`npm run doctor` reports the same checks for every channel, plus a summary of
what each one can see. The Docker image ships `git`, `gh`, `jq` and `ripgrep`.

## Where state lives

Plain files — no database. Back up `data/` with `tar` and you have everything.
The one exception is the skills the harness ships with, which live in the repo
next to the code:

```
skills/<name>/SKILL.md      built in, on in every channel, read-only to all
admin-skills/<name>/SKILL.md  built in, on ONLY in the `admin: true` channel (how to administer the install)
data/
  shared/
    knowledge/*.md            account brain (markdown you write)
    skills/<collection>/<skill>/SKILL.md   skill collections (you curate; assigned per channel)
    global-bin/<name>         your tools: on PATH for every channel, read-only in containers
    audit/skill-writes.jsonl  provenance of every write to a collection or another channel's skills
    library/<name>/           skills channels published (they curate)
    bin/<name>                executables channels published; outside every jail
    bin/.meta/<name>.json     provenance for each one: publisher, version, sha256
    documents/<id>/           filed documents: metadata, text, and the original
    documents/INDEX.md        the shelf, rendered for review — regenerated, don't edit
    memory/MEMORY.md          account memory
    feedback/feedback.jsonl   what the harness could not do, one line per report
    feedback/FEEDBACK.md      the same, rendered for review — regenerated, don't edit
    feedback/feedback.digest.json  how far the digest has got
  channels/<slack-id>/
    workspace/                the agent's cwd, and its filesystem sandbox
    workspace/bin/            on PATH for bash and exec — drop CLI tools in here
    workspace/attachments/    text of files attached here — staging, last 40, then pruned
    attachments/              those files as uploaded, plus a manifest; outside the jail
    memory/MEMORY.md          channel memory
    memory/MEMORY.archive.md  entries dropped while consolidating
    memory/DREAMS.md          journal of the nightly pass
    skills/<name>/SKILL.md    channel-private skills, including its own
    sessions/<thread>/        presence marker: the bot is in this thread (no transcript inside)
    durable/                  this channel's conversation store (SQLite): main conversation + one fork per thread
    lists.sqlite              dedicated channel lists database; one physical table per list
    recent-conversations.json last few thread ids and one-line summaries
    dreams/log.jsonl          one line per consolidation run, kept forever
    dreams/<stamp>.jsonl      recent dream transcripts, for debugging
    agent/                    pi's per-channel config
```

Thread sessions (a thread's tools and connectors) are held in memory while a
thread is active and evicted after 30 minutes idle; the conversation lives in
`durable/`, so a later reply just picks up where it left off. Only one process
may own a channel's `durable/` directory at a time (it is locked), so do not run
two harnesses against the same data directory.

For memory pressure or unexpected connector/process multiplication, enable
`HARNESS_MEMORY_SAMPLE_SECONDS=60` (with `LOG_LEVEL=info`) to log harness memory,
visible descendant RSS/process counts, cumulative direct async process starts,
and attributed connector lifecycle events. See [the investigation and capture guide](docs/memory-investigation.md)
for measurement scopes, a repeatable local experiment, and what remains unproven.

## How isolation is enforced

- **Filesystem.** Every file-touching tool call is resolved to an absolute real
  path and checked against the channel's allowed roots, with reads and writes
  allowlisted separately. Symlinks are resolved first, so a link planted in a
  workspace cannot be used to step outside it.
- **Workspace symlinks.** Symlinks stay blocked by default, including a link
  the agent creates itself. An operator can allow an *absolute, narrow* target
  tree with `workspace.symlinkTargets`; the target is usable only when the
  requested path starts inside that channel's workspace and crosses a symlink.
  Listing `/srv/project` does **not** make a direct read of `/srv/project`
  legal. The setting permits both reads and writes through such a link, so do
  not list a broad parent, a secrets directory, or a directory containing
  channel state.
- **Memory.** The model gets a `scope` argument rather than a path. Writing to
  account memory requires `share.memoryWrite` and is refused otherwise.
- **Connectors.** Each channel opens its own MCP clients, so a stdio connector
  is a separate process per channel with no shared session or credentials.
  Stdio connectors start in the channel workspace so relative outputs stay
  inside the normal file-tool jail, but they are trusted host processes rather
  than sandboxes.
- **The web.** `fetch_url` reads text and `download_url` stages bounded binary
  files in the calling channel workspace. Both are credential-free GETs,
  bounded per channel by host lists and caps, and refused for private addresses
  on every redirect hop. Text enters only that channel's conversation; binary
  bytes stay in its workspace.
- **Skills and knowledge.** Resolved per channel from that channel's directory
  plus whatever the config names, and the skills the harness itself ships,
  which are readable everywhere and writable nowhere. Nothing is auto-discovered
  from the host, and a channel writes skills only into its own directory —
  never the operator's catalogue.
- **Feedback.** Written only through `report_limitation`, which stamps the
  channel on the report, and never readable back — the log is outside every
  channel's jail in both directions, so one channel cannot file in another's
  name or read what another filed.
- **The library.** Readable but never writable through the file tools:
  publishing goes through a tool that checks the permission and records who
  published what. Installing copies the skill into the installing channel, so
  a published skill is inert until another channel's agent takes it.
- **The shared tool bin.** Not in any channel's jail at all — not even
  readable — unlike the library. The only way in is `publish_shared_tool`,
  gated on `share.sharedToolsPublish`; the only way to run something is a
  `shared__<name>` tool built from that channel's own `share.sharedTools`
  entry, with that channel's own argv allowlist. Publishing exposes nothing
  by itself, not even to the publisher: naming a tool executable in some
  channel is always a separate, explicit config decision.
- **Documents.** The same shape, and the same reason. Filing goes through
  `add_document`, which stamps the filing channel on the entry and derives the
  bytes, the checksum and the extraction itself rather than believing the tool
  call. An attachment's original is staged outside the jail, so the record
  cannot be edited between arriving and being filed, and the stored text is
  extracted from that original rather than from the copy in the workspace.

### Workspace symlink targets

The normal jail resolves every symlink and blocks it if the destination leaves
that channel's workspace. If you have intentionally linked a checked-out
project or another trusted host directory into one workspace, opt in **for
that channel** (or deliberately in `defaults`) with the smallest absolute
parent that contains it:

```yaml
channels:
  engineering:
    workspace:
      symlinkTargets:
        - /Users/you/projects/my-service
```

Then create the link yourself, for example:

```bash
ln -s /Users/you/projects/my-service \
  data/channels/C01ABC/workspace/home-services
```

Only a path addressed through `workspace/home-services/...` is allowed. A tool
call directly to `/Users/you/projects/my-service/...` remains
blocked, and a link to a sibling directory not on the list remains blocked.
The channel can write through an allowed link; treat every file below the
listed target as available to that channel. `symlinkTargets` entries must be
absolute paths (`~` is not expanded) and a channel's list replaces rather than
extends a defaults list, so it can narrow access. This applies to the
path-taking file tools (including workspace file ops, upload, document
filing, charts and image output), not `bash`: Docker bash only mounts the
workspace, while host bash is
an intentionally broader capability and must not be used as a filesystem jail.

### On `exec`

`exec` is the middle ground between no shell and `bash`: selected command-line
tools, configured per channel, run without a shell. The harness starts the
configured executable directly with argv, so there are no pipes, redirects,
glob expansion, command substitution or `; another-command` surprises.

```yaml
channels:
  project-admin:
    tools: [read, write, edit, ls, find, grep, sqlite, web, exec]
    exec:
      commands:
        acli:
          description: Limited Atlassian CLI access.
          command: /usr/local/bin/acli
          args: []
          # Authenticate at runtime as the service user first; see docs/bundled-clis.md.
          timeoutSeconds: 30
          maxOutputBytes: 200000
          allowArgs:
            - [jira, workitem, view, "*"]
            - [jira, workitem, search, "**"]
```

Each command becomes one tool named `cli__<name>`; the example above exposes
`cli__acli`. The agent supplies `args` as an array of argv tokens. Those args
must match one of `allowArgs` before anything is spawned, unless the operator
explicitly sets `allowAllArgs: true` on that command (default: `false`):

- a literal token matches itself (including an explicitly allowlisted option);
- `*` matches exactly one positional token, never a token beginning with `-`;
- a final `**` matches the remaining positional tokens, never tokens beginning
  with `-`;
- an empty `allowArgs` means the command accepts no agent-supplied args, only
  its fixed `args`;
- `allowArgs: [["**"]]` permits zero or more positional tokens, **not flags**:
  `mycli a b c` is allowed, but `mycli --help` and `mycli a b c --json` are denied.
  To permit selected flags, list them literally in a pattern; there is no
  separate flag allowlist. Denials explain this distinction.

The command runs in the channel workspace with the channel's environment, plus
any command-specific `env`. `workspace/bin` is first on `PATH`, but only the
configured `command` is run — putting a new binary there does not expose it
until the config names it. Output is capped, and timeout kills the process.

### Discover and request connectors or CLI tools

Slack channels can search safe account-catalog metadata and request existing or new capabilities through three tools. Requests go to the configured admin channel; verified humans approve concrete changes before the admin harnessConfigurator can apply them. New capabilities need separate provisioning-plan and enablement approvals, with provisioning performed by an already-authorized administrator—not an autonomous installer. See [setup, lifecycle, safeguards and recovery](docs/capability-requests.md).

### Shared CLI registry

For an operator-reviewed host CLI that several channels may use, define it once
at top-level `cliTools`, then allowlist its name _per channel_ under
`exec.shared`. A registry entry is only a definition: it does not expose a tool
to any channel, including channels that have `exec` enabled. A channel needs
both `exec` in `tools` and its own explicit `exec.shared` entry.

```yaml
cliTools:
  deploy-status:
    description: Read deployment status for one named environment.
    command: /usr/local/bin/deploy-status
    args: []
    env:
      DEPLOY_TOKEN: ${DEPLOY_TOKEN}
    timeoutSeconds: 30
    maxOutputBytes: 200000
    allowArgs:
      - [--environment, staging]
      - [--environment, production]

channels:
  release:
    tools: [read, exec]
    exec:
      shared: [deploy-status]

  general:
    tools: [read, exec]
    # No exec.shared entry: cli__deploy-status is not available here.
```

`release` receives `cli__deploy-status`, with exactly the registry's fixed
arguments and argument policy; `general` receives nothing. The registry's `env`
values are expanded against the consuming channel's environment, so a single
reviewed command can use a channel-specific token without putting that token in
shared YAML. Unknown, duplicate, or locally colliding names are rejected while
the config loads. Shared tools cannot be placed under `defaults.exec.shared`:
that would make authority ambient instead of explicit.

#### Explicit whole-CLI access (including flags)

For a fully trusted executable, opt in with `allowAllArgs: true`:

```yaml
cliTools:
  mycli:
    command: /usr/local/bin/mycli
    allowAllArgs: true
    timeoutSeconds: 30
    maxOutputBytes: 200000

channels:
  trusted-ops:
    tools: [exec]
    exec:
      shared: [mycli]
```

This exposes only `cli__mycli` in `trusted-ops`. It permits `mycli --help`,
`mycli a b c`, `mycli a b c --json`, and no supplied arguments. The opt-in
**overrides `allowArgs`**, even if patterns are also configured. It is also
available on per-channel `exec.commands.<name>` entries and applies to job exec
phases using that command. Omit it or set it to `false` to retain allowlist
restrictions. It does not enable other executables or shared-bin tools.

**Trust all capabilities of the executable before enabling this.** Arbitrary
arguments can select destructive subcommands, read/write host files, load plugins
or config, or execute other programs if the CLI supports that. These CLIs run on
the host, not in the bash sandbox. Prefer an absolute executable path and retain
restrictive patterns when whole-CLI trust is inappropriate. The configured
executable and fixed `args` prefix, direct execution without a shell, channel
selection and environment isolation, timeout, and output cap remain unchanged.

This is distinct from the [shared tool bin](#the-shared-tool-bin): the registry
is for operator-defined executables and keeps the ordinary `cli__<name>` tool
shape; the bin is for a trusted channel to publish a reviewable script and uses
`shared__<name>`.

`exec` is for "the agent may perform these CLI-backed operations". If a task
really needs ad-hoc command chaining, temporary files, `jq`, pipes or several
CLIs cooperating, give that trusted channel Docker-sandboxed `bash` instead.

### QA browser automation with Playwright CLI

The official harness image bundles [Playwright CLI](https://www.npmjs.com/package/@playwright/cli)
and Chromium. Enable it for a trusted QA channel with the `exec` tool and a
named `playwright` command; the complete restrictive example is the `qa`
channel in `config/harness.example.yaml`. It exposes `cli__playwright` and
pins the executable to `/app/node_modules/.bin/playwright-cli`, so a script the
agent writes into `workspace/bin` cannot replace it.

This uses the per-channel `exec` model, not the shared tool bin: Playwright is a
reviewed, image-owned dependency, rather than a script authored by one channel
for another to run. Its policy deliberately enumerates ordinary browser actions
(open/goto, page inspection, clicks, typing, screenshots and PDFs) and omits
`**`, `eval`, `run-code`, config/profile loading, file upload/drop, storage
state loading, browser attachment and global session controls. Keep that list
narrow when extending it. The command also has a fixed `-s=harness-qa` session
rather than using the CLI's process-global default, and a read-only image global
config that selects bundled Chromium.

`exec` runs in the harness container, not a channel's Docker `bash` sandbox.
Browser navigation is therefore a real network-capable QA action; do not enable
it for an untrusted channel or use it to browse with personal credentials. A
normal image rebuild is needed after merging because Chromium is downloaded
while `Dockerfile.harness` builds. The example declares `playwright-cli` in
`requires`, so a misbuilt image fails loudly before serving QA.

### On `bash`

`bash` cannot be confined by path-checking, so it is **off by default** and
opt-in per channel. Once enabled there are four ways to run it:

```yaml
channels:
  engineering:
    tools: [read, write, edit, ls, find, grep, sqlite, web, bash]
    sandbox:
      mode: docker          # or "kiri" / "macos-container" (see below) / "host"
      network: none         # "bridge" if commands need the internet
      memory: 512m
      cpus: 1
      timeoutSeconds: 120
      reuse: true           # one lazy persistent container per thread
      idleSeconds: 86400    # 24h since last completed bash command
      readOnlyRoot: false   # /repos in the container writable layer
```

**`mode: host`** (default) runs commands directly. Simple, but a channel with
bash can reach anything the harness process can — including other channels'
directories and the credential store.

**`mode: macos-container`** uses Apple Containers on native Apple Silicon / macOS 26+
with `container` 1.6.1+ (compatible 1.x). It requires explicit `pidsLimit: null`
(no PID limit) and `readOnlyRoot: true` (bounded `/repos` tmpfs, lost on stop),
plus an image containing util-linux `/usr/bin/setpriv`. Offline networking,
channel/skill mounts, per-thread reuse, one-shots and whole-container cancellation
are supported. Unsupported settings fail closed; there is no host fallback.
See [Apple setup, security differences and verification](docs/apple-containers.md)
before selecting this backend. The Docker details below retain their defaults.

**`mode: kiri`** uses the native Kiri CLI (0.2.1+ server), whose container
commands target Kiri’s Docker-compatible socket regardless of the Docker context.
It retains Docker-style isolation/resource settings and separate lifecycle state;
interrupted or failed executions are conservatively protected until a confirmed
container stop. Requires Kiri setup, its Docker CLI and host `tar`. Live Kiri
verification was unavailable in the factory environment; see [Kiri setup,
source-verified contracts and opt-in smoke test](docs/kiri-sandbox.md).

**`mode: docker`** gives each stable thread its **own lazy, long-lived container**,
with **only that channel's workspace mounted at `/workspace`**. Commands
`docker exec` into it; subsequent turns, session eviction and normal harness
restarts reuse it. Set `reuse: false` for a throwaway container per command
(including teardown of its background descendants). Host mode is unchanged.
Other channels, `data/`, the credential store and the harness source are not
mounted. Threads in one channel still share `/workspace`: this is not a
thread-private durable filesystem.

Clone repositories under **`/repos`**, never under `/workspace` or a Docker
volume. The default `readOnlyRoot: false` keeps `/repos` in the container's
writable layer: clones survive reuse, stopped-container starts and harness
restarts, but vanish with container deletion. Save durable outputs, attachments,
reports and reusable scripts under `/workspace`; host file tools and Slack
uploads cannot read `/repos`. Repositories should use `cd /repos/<repo> && ...`
within each bash call. This is guidance, not a Git-clone interceptor: an agent
with writable `/workspace` could still clone there if it ignores the guidance.

**Security/default change:** formerly the root filesystem defaulted to
read-only. Writable root now permits changes to any image paths the configured
user owns, not just `/repos`; it does not grant host access or extra Linux
capabilities. `cap-drop: ALL`, `no-new-privileges`, non-root default image user,
network-off default and resource limits remain. Explicit `readOnlyRoot: true`
is honored: `/tmp` gets 64 MiB tmpfs and `/repos` gets 256 MiB, mode 1777 tmpfs,
**not a Docker volume**. These remain across a normal harness restart while the
container runs, but are lost on container stop/reboot (including timeout or
cancellation) and count against its memory budget. Choose this mode if its
stronger root protection is worth volatile, bounded clones.

Images must supply `/bin/sh`, `bash`, `sleep`, `mkdir`, `chmod`, and Linux `stat`
(GNU or BusyBox, supporting `stat -c '%u'`), and must not
declare `VOLUME` (images with anonymous-volume declarations are rejected before
creation). The supplied images provision writable `/repos`; new writable-root
containers also get trusted directory setup for custom images/users. With all
capabilities still dropped, root creates `/repos` only if absent and discovers
its numeric owner; a separate setup exec as that UID applies mode 1777. Setup
uses a fixed system-tool PATH, never the channel's writable `workspace/bin`. This
supports non-root-owned image directories without granting root `CAP_FOWNER`
or adding capabilities to agent commands. Read-only-root uses Docker's tmpfs
permissions and performs no root or owner setup exec. Already-ready containers
are validated only, never chmodded again (including after a harness restart).
Before preparation, `/repos` must be a real directory (or absent), never a
symlink/non-directory or durable mount redirect. The Linux mount table and
canonical `/workspace`/`/repos` paths are checked; the only permitted `/repos`
mount is the configured read-only-root tmpfs. Writability is verified as the
configured user. These read-only checks also run before every reused-container
command; a modified path is refused, never repaired with privileged setup.
That setup never executes agent commands as root. Image entrypoints are bypassed
in favor of a single idle `sleep` process. A repository directory is never bound,
mounted as a named/anonymous volume, or exported separately from the container.

Build the sandbox image first (it ships `git`, `gh`, `acli`, `linear`, `go`, `gofmt`,
`jq`, `ripgrep`). Both `Dockerfile.harness` and `Dockerfile.sandbox` bundle the official
Atlassian ACLI and [schpet's Linear CLI](https://github.com/schpet/linear-cli)
for Linux amd64/arm64, pinned and SHA-256-verified at build time. Credentials
are supplied only at runtime; installing a CLI does not authorize its use.
Both images also include Go **1.27.2** on PATH, SHA-256-pinned for amd64/arm64,
with `GOTOOLCHAIN=local` to avoid automatic toolchain downloads. Pure-Go
builds/tests work without installing a compiler; cgo requires a custom image.
See [bundled Go behavior, upgrades, and offline smoke tests](docs/bundled-go.md)
and [bundled CLI authentication, upgrades, and smoke tests](docs/bundled-clis.md).

```bash
docker build -f Dockerfile.sandbox -t seneschal-sandbox:latest .
```

### When the harness itself runs in Docker Compose

The normal Compose service intentionally has _no_ Docker socket. Enable the
separate, explicit override before using `sandbox.mode: docker`:

```bash
export HARNESS_DOCKER_DATA_DIR="$(pwd)/data"  # absolute host path

docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
```

`HARNESS_DOCKER_DATA_DIR` must be the absolute host path to the same `data/`
directory that the service sees at `/app/data`. Docker resolves a bind source
on the daemon host, not inside the harness container; the override supplies
that mapping and the harness translates it to each
`<data>/channels/<id>/workspace` source. The channel receives it as a
_writable_ `/workspace` bind mount — it does not receive the rest of `data/`,
the repository, or the Docker socket. `npm run doctor` prints the exact source
path when the channel's Slack ID is known; for an unseen name-keyed channel it
prints an explicit Slack-ID template instead.

The image entrypoint reads the mounted socket's actual group (including Docker
Desktop's group remapping), then drops to the unprivileged service user with
that one supplementary group before the harness starts. On a rootless/remote
Docker daemon, set the data variable for that daemon's host filesystem instead.

> The Docker socket is effectively host-root authority for the harness
> process. This is an intentional opt-in for a trusted, single-owner harness;
> it is not suitable for a multi-tenant or untrusted deployment. The socket is
> mounted only into the harness, never a channel sandbox.

Every Dockerfile in the repo is named for what it builds, and none of them is
the default `Dockerfile`:

| File | Builds | Built by |
| --- | --- | --- |
| `Dockerfile.harness` | the harness service itself | `docker compose up -d` |
| `Dockerfile.sandbox` | the default image `bash` runs in | you, by hand |
| `Dockerfile.home-assistant` | a sandbox for a Home Assistant channel | you, by hand |

Sandbox images named by `sandbox.image` are referenced by tag, so the harness
never builds those — it only checks at startup that the tag exists, and `npm
run doctor` reports any that do not.

### A channel that brings its own Dockerfile

Rather than building a tag by hand and naming it in the config, drop a
`Dockerfile` in the channel's directory:

```
data/channels/C01ABC/
  Dockerfile      ← the image this channel's bash runs in
  env             ← this channel's secrets
  workspace/      ← the jail root, and the build context
```

The harness builds it on the first `bash` command, tags it
`harness-channel-<id>:latest`, and rebuilds when the file changes — replacing
the running container, since it is now out of date. Nothing to configure beyond
`sandbox.mode: docker`, `kiri` or `macos-container`; a Dockerfile here wins over `sandbox.image`.

Three things worth knowing:

- **The build context is `workspace/`, not the channel directory.** So a `COPY`
  can pick up something the agent produced, and cannot bake `env` — the
  channel's tokens — into an image layer.
- **Only the Dockerfile is fingerprinted.** Editing a file it `COPY`s will not
  trigger a rebuild by itself; touch the Dockerfile or delete the image.
- **The whole workspace is sent to the daemon on a build.** A channel that has
  cloned a repo or built a venv is carrying a lot of it, which on a Pi is worth
  avoiding: put a `.dockerignore` in `workspace/` if builds start to drag.
- **It sits beside `workspace/`, not inside it**, which puts it outside the
  jail. The agent can write its own scripts and skills; it cannot rewrite the
  definition of its own container, or `FROM` its way to a different one.

Give a channel its own image to build up tools the others do not have — the
image is per channel:

```yaml
channels:
  engineering:
    sandbox: { mode: docker, image: harness-engineering:latest }
```

```bash
docker build -f Dockerfile.engineering -t harness-engineering:latest .
```

Containers are named `harness-<channel-id>-<thread-id>`, created on first bash
use. Slack timestamp IDs stay readable; unsafe/truncated identity parts gain a
stable hash to avoid sanitization collisions. Missing/empty identity fails
closed, never falls back to channel-only reuse:

- Normal channel threads and delegated tasks use their target Slack root timestamp.
- DMs follow the same rule: explicit replies reuse their root; an unthreaded new
  DM starts a distinct session using that message timestamp, not a channel-wide container.
- Visible schedules use each posted Slack thread; in-thread check-backs reuse
  their original thread. Quiet schedules use `scheduled-<task-id>` across runs,
  independently of their fresh per-run transcripts. Dreams use their explicit
  dedicated pseudo-thread key.

`docker exec -it harness-C01ABC-1700000000.000100 bash` drops you into that thread.
The resolved image ID and effective creation configuration (mount source,
network, limits, user, root mode, lifecycle version) are fingerprinted before
reuse. An idle stale container is replaced; a stale container with commands or
services still running is refused, rather than silently adopted or killed.
Matching stopped containers are restarted with their writable layer intact.
Legacy channel-only containers and containers belonging to another installation
are never adopted/deleted. Remove or rename those manually after inspection.

#### Idle lifecycle and background services

`idleSeconds` defaults to **86400 (24 hours)** and can be overridden globally in
`defaults.sandbox` or per channel. A startup sweep and a one-minute background
sweep collect inactive owned containers. Idle means time since the last completed
bash command, **not** the last Slack message. Running execs, background services
and orphaned descendants from a lost CLI/harness prevent cleanup regardless of
elapsed time. When a restart discovers that an interrupted command has finished,
its idle clock starts at that recovery observation. Stop background services
explicitly when finished; they can keep a container alive indefinitely.

Host-only `<dataDir>/sandboxes/` stores a persistent random installation ID,
atomic per-container activity records and cross-process leases. Immutable Docker
ownership/config labels must agree before adoption or deletion. Preserve this
directory across restarts, do not mount it into agents, and do not copy its
installation ID into a second deployment. One data directory is supported on a
single host/PID namespace, **not shared NFS or concurrent Compose replicas**.
Leases include process start identity (not PID alone), recover after a dead
process/reaper, and serialize creation, commands and GC. Initialization completion
is atomically recorded against the exact container ID before agent dispatch.
Matching labels alone do not prove readiness: an owned quiescent creation
interrupted before that commit is recreated, and an active incomplete creation
is refused. Privileged setup is never blindly rerun in an already-used container. Docker exec IDs and the
actual process list protect work left running after a crash; inspection failures
fail closed. Corrupt metadata/leases require operator inspection, not forced
cleanup. Do not start out-of-band `docker exec` commands during GC: they are not
participants in the harness's host-side lease protocol.

Graceful shutdown stops the sweep and cancels active foreground commands but
**does not delete persistent containers**. Timeout/abort stops the entire thread
container to reliably terminate descendants, not just the Docker CLI; its
writable layer remains and the next command restarts it. This also stops any
background services in that thread. If stop cannot be confirmed, activity remains
protected and cleanup defers until Docker proves it quiescent. Workspace files
are preserved by all replacement/cleanup paths. Images are never deleted by GC.

Resource limits are **per container**, so many active threads multiply memory,
CPU/pid budgets and writable-layer disk usage. Background services can defeat
idle collection; inspect `docker stats`/disk usage and stop unwanted services.
There is no total-container quota or disk-layer size limit in this change.

Note `network: none` blocks the internet, so `gh`, `curl` and `npm install`
will fail. Use `bridge` for channels that need it.

#### `bin/` is on the PATH

(The operator's [global bin](#skills-and-tools-who-sees-what) follows it on
`PATH`, and your skills and assigned collections are mounted under `/skills`.)

Every channel's workspace has a `bin/` directory, and it is first on `PATH` for
that channel's shell and restricted `exec` tools. On the host it is
`data/channels/<id>/workspace/bin`; Docker `bash` sees the same directory
mounted at `/workspace/bin`. Anything executable there can be run by name from
any directory when the channel has `bash`, or named as an
`exec.commands.<name>.command` when it should be exposed without a shell:

```bash
cp ~/deploy-staging data/channels/C01ABC/workspace/bin/
chmod +x data/channels/C01ABC/workspace/bin/deploy-staging
```

The agent can then just run `deploy-staging`. Nothing to configure and no
restart: the directory is read at the moment the command runs.

It works in the other direction too. `bin/` is inside the workspace, so it is
inside the jail, which means the agent can write its own scripts there — a
wrapper around a command it had to work out once, kept for next time. That is
the shell equivalent of `save_skill`, and the system prompt says so: a tool in
`bin/`, a skill describing when to reach for it.

Being first on `PATH` is deliberate — it is how a channel overrides a tool the
host or the sandbox image ships. It also means a channel with `bash` can shadow
any command *its own* shell runs, which is worth knowing but is not a new
capability: a channel that can write files and run them could already do this
the long way round.

Secrets are passed to the container by *name*, not value, so tokens never
appear in the `docker run` command line where `ps` could read them. The
harness's own Slack tokens are not forwarded at all.

Three honest caveats:

- **`network: none` constrains `bash`, not the channel.** Connectors and the
  web tools run in the harness process, so a channel with either reaches the
  network regardless of the sandbox setting — as it must, or a Home Assistant
  channel could not work. The sandbox setting governs what *shell commands* can
  reach. Narrow a connector with `allowTools`, and the web tools with
  `web.allowHosts` or by dropping `web` from the channel's tools, rather than
  expecting the sandbox to contain either.
- **A container is not a VM.** Kernel-level escapes exist. This raises the bar
  a great deal over host mode; it is not a hostile-multi-tenant boundary.
- **If the harness itself runs in Docker**, use the explicit
  `docker-compose.sandbox.yml` override above. It mounts the daemon socket only
  into the trusted harness process and maps the host `data/` path correctly;
  the socket remains effectively root on the host.

This is deliberately not the security model of a multi-tenant cloud service. It
is designed to keep channels from bleeding into each other by accident, and to
make deliberate sharing explicit and visible.

## Public feature website

The standalone product website lives in `website/`. Build it with
`node website/build.mjs` and preview with `node website/preview.mjs`.
It is published at <https://denwilliams.github.io/seneschal/>. See
[website content, validation and publishing](docs/website.md) for the GitHub
Pages setup and the Cloudflare Pages fallback.
Feature authors and reviewers follow
[`website-update`](factory-skills/website-update/SKILL.md) to keep it current.

## Development

```bash
npm run dev        # watch mode
npm test           # unit tests (isolation, jail, formatting)
npm run typecheck
npm run doctor     # validate config + host tooling
```

## License

MIT. See [LICENSE](LICENSE).
