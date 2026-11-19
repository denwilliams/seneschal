# Configuration

Everything is in `config/harness.yaml`. The authoritative, commented reference is
`config/harness.example.yaml`; the README's **Configuration** section explains it. If you can
read them, read the relevant part before giving a key name or default.

## Shape

```yaml
defaults:        # applies to every channel unless the channel overrides it
channels:        # keyed by Slack channel ID (preferred) or name
  C0123456789:
    model: ...
    models: [...]          # models the agent may switch to
    tools: [...]           # what the channel can do (bash/exec are opt-in)
    allowUsers: [U…]       # who may talk to the bot here (absent = anyone)
    admin: true            # at most ONE channel
    share: { ... }         # what it may see from outside itself
    permissions: { ... }   # what it may ask a human to grant at runtime
    envFile: ...           # channel secrets
connectors:      # a catalogue — defining one does NOT enable it for any channel
cliTools:        # account-wide CLI pool — a channel must name each in exec.shared
```

Keying by **ID** survives a rename; a name key is matched against what Slack reports.

## Channel isolation is the default

A channel sees its own memory, skills, workspace, connectors and conversation store, and
nothing else, until config says so. When a request is "let channel A use X", the answer is
almost always one explicit `share:` / `connectors:` / `exec.shared` entry on A — not a wider
default. Prefer the narrowest entry that works.

## Things people commonly ask for

- **Give a channel a knowledge base:** add the name to that channel's `share.knowledgeBases` (read-only wikis, declared
  under the top-level `knowledgeBases`, which is edited on the host). Only names already declared can be linked; the channel
  also gets the `librarian` subagent.

- **Change a model:** `model:` (default) and `models:` (allowed switches) on the channel.
  Use fully qualified names (`provider/model`) when two providers share a name. The store
  enforces the allowlist when it calls the provider. Some models in the catalogue are refused
  by some logins (a ChatGPT-account Codex login refuses several): if a model errors with
  "not supported", pick another rather than retrying.
- **Enable bash:** add `bash` to the channel's `tools` (a deliberate choice; `sandbox.mode`
  decides whether it runs on the host or in a container). It is also grantable at runtime
  only if `permissions.grantable` lists it.
- **Restrict who can talk to a channel:** `allowUsers: [U…]`.
- **Connectors:** define under `connectors:`, then list the name in the channel's
  `share.connectors`. Credentials come from that channel's env, never another's.
- **Secrets:** channel env file (`envFile:` or `data/channels/<id>/env`) layered over the
  global `envFile:`. Set with `npm run secrets` on the host; never in Slack.
- **Skill collections:** put skills in `data/shared/skills/<collection>/<skill>/SKILL.md`
  (a skill belongs to exactly one collection), then assign per channel:
  ```yaml
  share:
    skillCollections:
      - software-development               # read-only (default)
      - { name: ops-runbooks, mode: rw }    # this channel's agent may edit it
  ```
  `rw` lets that channel change what **every channel holding the collection** runs. Use it
  rarely and say so when recommending it. The old `share.skills: [...]` key was removed and
  now fails config validation — migrate with `npm run migrate-skills` and `skillCollections`.
- **Global tools:** drop an executable in `data/shared/global-bin/` (on every channel's PATH,
  read-only in containers). Optional per-channel tools come from the `cliTools` pool via
  `exec.shared`.
- **Backups:** `backups: { enabled, cron, directory, keepLast }` — see `data-and-recovery.md`.
- **Dreams / recent conversations / schedules:** their own top-level or `defaults:` blocks;
  read the README sections *Dreaming*, *Recent conversations*, *Scheduling*.

## Changing the config from here

`admin_config_get` reads any part of the file (literal secrets are hidden; `${VAR}` references are
shown). `admin_config_edit` changes it, in place, as one batch of edits: each is a `path` (keys from
the top, e.g. `["channels", "engineering", "model"]`) with a `value`, or `remove: true`. The batch is
validated as a whole, backed up (`data/config-backups/`), recorded (`data/shared/audit/config-edits.jsonl`),
reloaded, and rolled back automatically if the reload is refused. A list is replaced, not appended
to: read the current one and send the whole new one. A channel can be named by its key, its name or
`#name`.

Always read first, change the smallest thing, and tell the person exactly what changed (the tool's
result lists each path, before and after, and the backup to undo it).

**Refused, with a reason you pass on** (these are edited on the host): this channel's own entry and
`admin` or `configurators` anywhere (configuration roles confer administration authority); `dataDir`, `documentsDir` (document-library storage on the host), `authPath`, `keychain`, `envFile` (global or per channel), `openbao` (secret scopes, backend and host credentials), `cliTools`, `knowledgeBases`,
`modelProviders`, `requires`, `webConsole`, `backups`,
`allowUnconfiguredChannels`, `allowDirectMessages`; `defaults.tools/sandbox/exec/jobs/workspace/web/images/permissions/share/allowUsers`;
per channel `sandbox`, `exec`, `jobs`, `workspace`, `web`, `images`, `permissions`, `requires` (`jobs` defines what a channel runs unattended, so it is the operator's to change); `slackProfile` (authorizes writes to one person's public Slack status and photo; channel-only, never in defaults or granted through this editor);
`factory.merge` and `factory.repositoryRules` (who may approve a merge, and when a pull request merges without a person: the operator's to change) `factory.issues` (whether the channel may file GitHub issues: the operator's to change), `factory.autonomy` and `factory.autoRetries` (how much the factory may do without a person), `factory.reviewRounds` and `factory.maxLiveRuns` (how much model time a factory may use: the operator's to change) and `factory.intake` (whether the harness polls the repositories and starts runs for new issues by itself: the operator's to change), `factory.jira` (Jira scope, trusted account IDs and workflow status mappings: the operator's to change); `factory.commitAuthor` (attribution for future coder commits: the operator's to change); `factory.deploy` (selection of the active deployer or read-only Actions monitor: the operator's to change); the rest of `factory` is yours to edit;
`share.memoryWrite/channelMemoryRead/delegateTo/postTo/postAs/libraryPublish/sharedToolsPublish/sharedTools`. Of those, a channel's `sandbox`, `share.delegateTo`, `share.postAs` and a shell (`bash`/`exec`) added to its tools can be asked for with approval (below). Also refused: a
shell added to a channel's tools without it; a read-write skill collection; emptying or removing
a channel's `allowUsers` (replace it with a list of real Slack IDs); switching off `requireApproval`.

### Changes that need a person's click

Four of the refused settings (and removing a channel's `exec`) can still be made with `admin_config_request_approval`: a channel's `sandbox`,
its `share.delegateTo`, its `share.postAs` (and the reviewer role that guards it, see below), and `bash`/`exec` added to its `tools`. This is how a channel is moved onto an agent set
whose roles need a shell (a software factory, for example). It takes the same `edits` as `admin_config_edit`, writes
nothing, and posts a message in this thread showing every change (was/now) with Approve and Deny buttons. Only the
people in this channel's `allowUsers` can approve; the change is checked again, in full, when they click. Put the
whole migration in ONE request so one click applies it. Then tell the person you have asked and stop: do not retry,
and do not try another route to the same change. Never for this channel itself, and nothing else on the refused list.
The request expires after 30 minutes. If this channel has no `allowUsers`, nobody can approve and the tool says so.

### Posting as a user (`share.postAs`)

`share.postAs` lets one channel's agent post to Slack as a real person, with the `post_as_user` tool.
It is a channel setting only. `defaults.share.postAs` is refused, so nothing inherits it. It needs a
person's click, like `delegateTo`: ask with `admin_config_request_approval` and never `admin_config_edit`.

```yaml
share:
  postAs:
    user: U01234567          # the person the posts are made as
    reviewer: post_guard     # a role in this channel's agent set
    maxPerHour: 10           # optional, 1 to 100, default 10
    rules: |
      Never share finance figures or salaries.
      Calendar availability is fine; never commit to dates.
    privateLinkHosts: [wiki.example.com]   # optional
```

- `user`: a Slack user id such as `U01234567`. Their user token must be stored on the host:
  `printf '%s' "$TOKEN" | npm run slack-user-token -- set U01234567`. There is no fallback to the bot
  token. The token needs the scopes `chat:write`, `im:write`, `users:read`, `channels:read`,
  `groups:read`, `im:read` and `mpim:read`. You cannot see or set a token; tell the person to do it on the host.
  `!status` shows whether a token is stored for them (presence only, not its scopes).
- `reviewer`: the name of a role in the channel's `agentSet`. The role must have **no tools and no connectors**,
  or the config is refused. A channel with no `agentSet`, or a set without that role, is refused too.
- `maxPerHour`: posts per hour for the whole channel. Default 10, at most 100. A post over the cap is held, not dropped.
- `rules`: what the person is willing to share, in plain words. The reviewer applies it on top of the harness's own checks.
- `privateLinkHosts`: extra hostnames whose links always hold a post. It adds to the built-in list of
  document hosts (Google Docs, Drive, Sheets and Slides, Notion, Atlassian, SharePoint, Dropbox, Box,
  OneDrive, Confluence, and Slack message permalinks); it does not replace it.

Every post carries a footer `Sent by <@app> on behalf of <@U…>` (the app is this Slack app, shown by its own name), leaves a receipt in this channel, and
is held for the person to **Unblock & send** or Dismiss if a check or the reviewer objects. Only the
`postAs.user` can click those buttons, and a held post expires after 30 minutes. Before the reviewer,
fixed checks hold a draft with a private document link, something shaped like a credential, or a
broadcast (`@channel`, `@here`, `@everyone` or a user-group mention).

**Defining the reviewer role.** Add a role to the channel's agent set. The harness runs it as a
one-shot call, so it never has tools, memory or skills, whatever you write. Give it short
instructions and a `timeoutSeconds` (a reviewer that times out holds the post). Its `model` is
optional and defaults to the channel's model (its `thinkingLevel` likewise).

```yaml
agentSets:
  guards:
    description: Reviews drafts before they are sent as a person.
    agents:
      post_guard:
        description: Decides whether a draft may be sent now or must be held.
        tools: []
        instructions: |
          You protect the person you review for. Hold anything you are unsure about.
        timeoutSeconds: 30
```

Then point the channel at it with `agentSet: guards`. If the channel is not on an agent set yet, put
the `agentSet` change and `postAs` in one approval request so one click applies both.

**Editing the reviewer needs the click too.** Once a channel has `postAs`, its reviewer role is part of
that power: changing any of the role's settings (`instructions`, `model`, `timeoutSeconds`, ...), removing
the role or its agent set, changing the channel's `agentSet`, or changing the channel `model` or
`thinkingLevel` the role inherits is refused by `admin_config_edit`. Ask with `admin_config_request_approval`.
Other roles in the same set are edited as usual.

**Writing good `rules`.** The reviewer reads them next to every draft, so make each line something it can check.

- Be specific. Name the kind of content ("finance figures", "salaries", "customer names"), not a mood.
- Write about content, not tone. The reviewer judges what a message gives away or promises, not how polite it is.
- Say what is allowed as well as what is not. A clear "fine" saves the person a click.
- Keep it short. Three or four lines work better than a page.

Examples:

- `Never share finance figures or salaries.`
- `Calendar availability is fine; never commit to dates.`
- `Never forward attachments or links to documents.`
- `Anything addressed to a customer must be held.`

### Adding a connector from here

You can define **remote** connectors (`transport: http`) and give them to channels. You cannot define
`stdio` connectors: those run a command on the host, so a person adds them.

1. Read what exists: `admin_config_get` with `["connectors"]`, and the channels that should get it.
2. Choose a short lowercase name (`github`, `linear`, `google-calendar`). **Its secrets must be named
   for it**: a connector `github` may reference only `${GITHUB_…}` variables, `google-calendar` only
   `${GOOGLE_CALENDAR_…}`. Credentials are always `${VAR}` references, never literal values.
3. One `admin_config_edit` with all of it, so it lands together:
   - `["connectors", "github"]` = `{ transport: "http", url: "https://…", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } }`
     (optionally `allowTools` to expose only some of its tools; OAuth connectors use `oauth` with
     `clientId`/`clientSecret` as `${GITHUB_…}` references and a `redirectUrl`),
   - `["channels", "engineering", "share", "connectors"]` = the channel's whole list, now including `github`.
4. **Tell the person what only they can do**: set `GITHUB_TOKEN` on the host (`npm run secrets`, or the
   channel's env file). You cannot see or set it. Until it is set the connector will fail to start in
   that channel; `!connectors` in that channel shows its state.
5. Confirm with `!connectors` in the channel, and say how to undo (remove the two settings, or restore
   the backup).

## Applying a change

1. Edit `config/harness.yaml` on the host (keep it in git if it is; otherwise copy it first). For what
   `admin_config_edit` allows you can skip this and the next step: it edits and reloads for you.
2. In Slack: `!reload`. A rejected file leaves the previous config active and prints why.
3. Confirm with `!status` in the affected channel and, on the host, `npm run doctor`.

What a reload does and does not do: future turns use the new config; idle sessions are
rebuilt; a turn already running finishes on the old one; each channel's conversation store
is retired once its sessions finish and re-opened with the new tool list and model
allowlist on the next message. Changes to the Slack app (scopes, tokens) or to `.env` need a
**restart**, not a reload.

## Validation errors you will see

- `at most one channel may set admin: true` — two channels have it.
- `share.skills` removed / replaced by `share.skillCollections`.
- unknown name in `exec.shared` — no matching `cliTools` entry.
- unknown collection name — the directory does not exist under `data/shared/skills/`
  (it is skipped with a warning, never created; `npm run doctor` flags it).
