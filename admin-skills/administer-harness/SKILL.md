---
name: administer-harness
description: "How this Slack harness installation is configured, run, backed up, recovered and upgraded, and what to tell a person to run on the host. Use it when anyone in the admin channel asks to change config, add or remove a channel, tool, model, connector, secret or skill collection, check why a channel is paused or slow, restart or upgrade the service, take or restore a backup, or work out why something is not behaving. Read it before advising — never answer an administration question from memory."
---

# Administering this installation

You are in the **admin channel** (`admin: true` in `config/harness.yaml`; at most one channel
may have it). Be exact about what that gives you:

- You can read and write **other channels' own skills** with `admin_list_channel_skills`,
  `admin_read_channel_skill`, `admin_save_channel_skill` and `admin_delete_channel_skill`
  (every write is logged with your channel as the actor).
- You can **read and change the harness config** with `admin_config_get` and
  `admin_config_edit`: add and update remote MCP connectors, give them to channels, set models,
  who may use a channel, which team a channel has, and so on. Changes are made in place (comments
  and layout stay), validated, backed up, logged and reloaded as one step, and undone for you if
  the reload refuses them. A channel's `sandbox`, `share.delegateTo`, `share.postAs` (and any edit to the reviewer role that guards it) and a shell added to its tools
  go through `admin_config_request_approval` instead: it posts Approve/Deny buttons and nothing changes
  until an allowed person clicks. **Not everything**: see "What you cannot change" below, and
  `references/config.md` for how to do it well.
- You have this skill.
- You do **not** get host access, other channels' memory or workspaces, or secrets (you can
  neither see nor set a secret's value). Whether you can run a shell depends on the tools *this*
  channel was given: look at your own tool list before you promise to run anything.

What you cannot change is the config of **this channel itself** (it decides who controls the
harness), and the settings that move trust: where secrets live, anything that runs on the host
(shells, sandboxes, `exec`, `stdio` connectors, `cliTools`), model providers and their keys, what
the harness listens on, who may DM it, and who is admin. If a change is refused the reason says
why. Tell the person, and what they would do on the host. Never look for another way round it.

For those, and for anything on the host, **you tell a person exactly what to do**. Two kinds of
step, and you must always say which one each is:

| Who | What |
|---|---|
| A person types it **in Slack** | `!` commands. They are handled by the harness, not by you — you cannot run them. Tell the person the exact command. |
| A person runs it **on the host** | `npm run …`, editing `config/harness.yaml`, `docker compose …`, restarting the service. You cannot do these unless this channel has a shell, and even then confirm first. |

## Ground rules

1. **Never print or ask for a secret in Slack.** `!env` shows names only. Secrets are set on
   the host (`npm run secrets`, see `references/commands.md`). If someone pastes a token, tell
   them to rotate it.
2. **Back up before anything that cannot be undone** (see `references/data-and-recovery.md`).
   Say so out loud, once, before the step — not as boilerplate on every answer.
3. **Prefer the smallest reversible change**, and say how to undo it. A config edit is
   reversible (git, `!reload`); `!recovery discard`, deleting a channel directory, and
   `npm run migrate-skills` are not, or not cheaply.
4. **Verify, don't recall.** Config keys and defaults change between versions. For a key you
   are not certain of, read `config/harness.example.yaml` and the README section named in
   `references/config.md` rather than guessing. If you cannot read them from here, say so.
5. **One change at a time**, then confirm it worked with a command whose output you can ask the
   person to paste (`!status`, `!doctor`, `!reload`).
6. **One harness per data directory and per Slack app.** Two processes on the same `data/`
   fight over each channel's store lock; two on the same Slack app both reply.

## The shape of the installation

- **Config:** `config/harness.yaml` (path overridable with `HARNESS_CONFIG`). Slack and model
  credentials are in `.env`; provider logins are in the harness's own `auth.json`
  (`npm run login`). Per-channel secrets are in env files (`npm run secrets`).
- **State:** everything is files under `data/`. Layout in `references/data-and-recovery.md`.
- **Conversations:** one Pi Durable store per channel at `data/channels/<id>/durable/`. A
  channel's *main* conversation is its shared context; each Slack thread is a fork of it.
  The `sessions/<thread>/` folders only mark "the bot is in this thread".
- **Skills:** channel-private (`channels/<id>/skills`), shared **collections**
  (`data/shared/skills/<collection>/<skill>`, assigned per channel, read-only unless marked
  `rw`), the agent-published library, and built-ins in the repo.
- **Tools:** each channel's own `workspace/bin`, a global bin on every channel's PATH, and an
  opt-in pool of CLIs a channel must name in `exec.shared`.

## Common tasks

Look these up, don't improvise. Each entry points at the reference that has the steps.

| The person wants to… | Start here |
|---|---|
| Change a channel's model, tools, secrets, connectors, who may talk to it | `references/config.md` |
| See what a channel can do right now | `!status`, `!connectors`, `!skills`, `!grants`, `!doctor` (`references/commands.md`) |
| Apply a config change | `admin_config_edit` for what it allows (it reloads for you); for the rest, edit the YAML on the host, then `!reload` in Slack |
| Add an MCP connector and give it to channels | `references/config.md` → *Adding a connector from here* |
| Give a channel a skill, or share a set of skills | `references/config.md` (skill collections), or write it yourself with the admin skill tools |
| Understand cost / usage | `!usage channels 30d` in the **review** channel (`references/commands.md`) |
| A channel is "paused", or work was lost in a restart | `references/data-and-recovery.md` → *Recovery*, and `!recovery` |
| Back up, restore, move the data | `references/data-and-recovery.md` |
| Restart, upgrade, or run it in Docker | `references/data-and-recovery.md` → *Running it* and *Upgrading* |
| Something is slow, silent, duplicated or erroring | `references/runbook.md` |

## When you are unsure

Say what you checked, what you could not, and what the person can run to find out. A
confident wrong instruction here costs more than an honest "I can't see that from the admin
channel — please run `!doctor` and paste the output".
