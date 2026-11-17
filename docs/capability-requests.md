# Discovering and requesting capabilities

Live Slack channel assistants receive exactly three tools for account capabilities:

- `search_capabilities({query?, kind?})`: read-only search of account `connectors` and `cliTools` by name/description. `kind` is `connector` (including connections) or `cli`. Results contain only name, kind, description and current-channel enablement. Commands, URLs, credentials and other channels' private definitions are not discovery results.
- `request_enable_capability({kind, name, reason})`: request a specific existing catalog entry for this channel.
- `request_new_capability({kind, name, reason})`: request a new connector or CLI under the exact eventual catalog name.

The requesting channel and speaker are bound by the host. Tool arguments cannot choose a destination, another channel, approvers, commands or configuration edits. A successful request means **pending**, not installed, created or enabled. Channel descriptions and catalog descriptions should be safe public metadata, never secrets.

## Host setup

Use the existing admin designation and configurator opt-in; no new catalog or destination configuration is required:

```yaml
channels:
  C0123ADMIN: # actual Slack channel ID, or a channel name resolvable by the bot
    admin: true
    allowUsers: [U0123HUMAN]
    configurators: { harness: true }
  C0456TEAM:
    tools: [read]
```

There must be exactly one admin channel, an explicit non-empty `allowUsers`, and its already-authorized `harnessConfigurator`. This is **operator-level authority**, not a permission the request grants. Configure it on the host only in a trusted admin channel. The bot must be able to post/update there and resolve Slack users (`users:read`, already required by the harness). An unavailable user lookup never approves anything. Missing setup returns an actionable error rather than choosing a destination. Requesting channels also need explicit `channels` entries; names must resolve to the same Slack IDs at request, approval and application.

## Existing capability flow

1. A channel requests the exact account name and a reason. The admin post identifies the requesting channel, speaker, capability and reason, plus the catalog entry (using existing credential redaction), its fingerprint, exact generated edits and persisted configuration revision.
2. An allowlisted **human** clicks the original admin post's Approve/Reject button. An agent message, a request, a bot/app user, a click elsewhere, or a replay is not approval. Current routing, configurator opt-in and approvers are checked again.
3. Approval updates the admin post with the concrete configurator handoff and posts status back to the requesting channel. **It does not start a model or write configuration automatically.** An authorized admin asks their assistant to run `harnessConfigurator` for that request ID.
4. Inside that subagent only, `config_capability_request({id, action: "apply"})` consumes approval and applies the stored batch through the existing configurator validation, alias protection, revision comparison, automatic backup, atomic save, reload and rollback safeguards. No caller-supplied edits or alternate target are accepted by this lifecycle tool.

Connectors add only the name to `channels.<requester>.share.connectors`. CLIs add only `exec.shared` and, if needed, `exec` to that channel's effective tools. The latter also exposes any local/default commands, so requests that would newly expose *other* commands are refused for an operator to reconcile first. No `bash`, arbitrary shell permission or configurator permission is granted. Private/local names cannot shadow the selected definition.

A configuration change before clicking or applying invalidates the old enablement approval. While still pending, the admin configurator can use `action: "prepare"` to post a fresh exact batch and obtain a new human decision. After an application failure or consumed approval, submit a fresh request rather than replaying it.

## New capability flow: two approvals

1. A new request starts `awaiting_plan` and authorizes no work. An authorized admin asks `harnessConfigurator` to call `config_capability_request({id, action: "plan", plan: "..."})` with concrete provisioning steps: what to make/provide/install, version/source, account catalog name, and necessary administrator actions. Do not put credentials in a plan.
2. The plan is shown in full in a separate admin post. A verified allowlisted human must approve this exact post before anyone acts on that plan. Rejection stops the workflow.
3. An **already-authorized administrator** performs exactly the approved provisioning and provides the account `connectors` or `cliTools` entry. This feature deliberately adds no autonomous installer, creation agent, host execution power or new permission for a configurator to run commands. Defining the entry does not enable it for the requester.
4. The admin configurator calls `config_capability_request({id, action: "prepare"})`. This is refused before provisioning approval or until the exact catalog name exists. It posts the concrete catalog entry and bounded enablement edits for a **second human approval**. The provisioning approval cannot be reused for enablement, and its old message cannot approve the new stage.
5. After that second approval, the same configurator `apply` handoff enables it for the original requesting channel only.

`action: "inspect"` returns current request state inside the admin harnessConfigurator. Ordinary roles, channel configurators and channel agents never receive this lifecycle tool. Existing independently enabled operator configurators retain their pre-existing authority; this feature does not attempt to replace host/operator administration with a global approval policy.

## Lifetime, outcomes and recovery

Each pending stage and the approved handoff expire after 30 minutes. State is process-local, limited to 100 live requests; a restart loses all request/approval authority and old buttons fail closed. Submit a fresh request after expiry/restart. Terminal states include `rejected`, `expired`, `applied`, `saved` (restart required), and `failed`. The admin configurator reports saved/applied separately. Delivery failures do not turn a successfully applied configuration into an application failure; inspect the request and persisted config before retrying an ambiguous operation.

To roll back enablement, have an authorized operator remove the selected connector/CLI allowlist entry, and remove `exec` only if it was added solely for that request. Alternatively restore the configurator's backup through the existing host recovery process and reload. Removing a channel's enablement does not uninstall a shared capability. No production install or Slack API smoke test is performed by the unit/integration suite.
