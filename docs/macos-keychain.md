# Native macOS Keychain secrets

Opt-in alternative to dotenv files and service-backed secret managers. The **main
process must run natively on macOS 13.5+**, on Intel or Apple Silicon, with the
project's supported Node (22.19+). No service, bridge, root helper, Touch ID, or
Keychain password in harness config is required. This does not replace OpenBao or
Infisical. When OpenBao is also configured, both backends must succeed; Keychain
imports override OpenBao imports, which override permitted legacy environment
values. Per-channel imports override global-channel imports within each backend.
Keychain also takes precedence for overlapping main-process Slack names and
model-provider bindings. Prefer distinct names across backends. Doctor and runtime
share the same channel visibility policy; neither backend exposes main-only
values or falls back after a failed required lookup.

## Host bash: keep using .env

By default, Keychain is **unavailable with host bash** because it runs as the
harness OS user. In strict mode, bash-enabled channels require Docker, Apple
Containers (`macos-container`), or [Kiri (`kiri`)](kiri-sandbox.md) to use Keychain; host CLI (`exec`) and shared-tool
execution must also be disabled. Trusted mixed deployments can explicitly accept
the risk below.
Admin → Secrets and restart shows the unavailable backend and the reason, while
leaving environment storage usable. Existing `.env` files do not need container
isolation. The environment form saves to managed storage for the next restart;
it does not edit your `.env` file.

Leave the optional top-level `keychain` section unconfigured when using only
`.env`. Merely offering Keychain in Admin does not enable it. An explicitly
configured `keychain` section rejects unsafe host execution unless the operator
explicitly accepts the risk, even with empty import lists. Selecting environment
storage is not an override or a migration: configured Keychain imports continue to fail closed, never silently
fall back to same-name environment values. Plan any deliberate migration before
removing imports; this warning does not change existing secret ownership.

## Trusted mixed deployments: explicit risk acceptance

The operator-only boolean `keychain.acceptHostExecutionRisk` defaults to
`false` (omitting it is also strict). Set it to `true` **only when every
same-user host execution route is trusted**: host bash (including runtime grants),
`exec` and executable shared tools/scripts are then permitted without removing
Keychain or stripping those tools from other channels. Runtime grants and channel
configuration agents cannot enable this switch; edit the host-managed YAML.

**This is risk acceptance, not isolation.** Host execution runs as the Keychain
owner and may invoke the private helper directly, reading secrets outside its
configured channel scopes, including container channels' and main-process secrets.
Container channels do not isolate their secrets from the host. Do not enable this
for mutually untrusted channels or untrusted host commands/scripts.

Example fragment (merge into your host config, replace the helper path):

```yaml
keychain:
  helperPath: /Users/harness/.local/libexec/harness-keychain/helper
  acceptHostExecutionRisk: true
  adminWrites: true
  channels:
    CCONTAINER: [GITHUB_TOKEN]
defaults:
  tools: [read, bash]
  sandbox: { mode: docker } # or macos-container
channels:
  CCONTAINER: {}
  CHOST:
    sandbox: { mode: host }
    envFile: /Users/harness/secrets/host.env
```

`CHOST` retains its ordinary dotenv environment; only `CCONTAINER` imports
`GITHUB_TOKEN` through the resolver. No additional secrets are automatically
imported, no backend is switched, and missing/denied imports still fail closed.
Global-channel imports, if configured, still apply to **every** channel. Names
managed by Keychain remain scrubbed from legacy environments unless explicitly
imported. Helper installation, platform checks, Admin-write authorization, scoped
imports, cache rules, and argv/metadata protections are unchanged.

Startup logs, `doctor`, config-reload warnings and Admin → Secrets show the
accepted-risk warning. Admin availability still respects macOS and `adminWrites`;
the switch does not make an unsupported host or unsafe helper usable.

To restore strict mode, remove host `exec`/shared-tool execution policies and
move bash-enabled channels to Docker/Apple Containers (or remove their bash tools
and host bash runtime grants), then remove the switch or set it to `false` and
reload/restart. A strict config with host execution is rejected rather than
silently disabling tools. Stop/reset existing host sessions when restoring the
boundary; config changes cannot revoke code already running. No live deployment
configuration is changed by this feature.

## Install and select

Run as the **same OS user** that runs the harness. Install Xcode Command Line Tools
(`xcode-select --install`) once. Build the small Security.framework helper from the
reviewed source. Install **outside the repository, data directory, workspace,
shared collections and global bin**; never publish it as a CLI tool or MCP server.

```sh
install -d -m 700 "$HOME/.local/libexec/harness-keychain"
xcrun clang -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations \
  -mmacosx-version-min=13.5 native/keychain/main.c \
  -framework Security -framework CoreFoundation \
  -o "$HOME/.local/libexec/harness-keychain/helper"
chmod 700 "$HOME/.local/libexec/harness-keychain/helper"
codesign --force --sign - "$HOME/.local/libexec/harness-keychain/helper"
```

The helper and every ancestor must be owned by this user or root, with no group
or world write permission and no symlink components. The runtime refuses an
unsafe or agent-visible installation. Keep it at a stable path. Rebuilding or
ad-hoc re-signing may invalidate Keychain ACL trust; use a stable signing identity
for managed deployments, or reauthorize only this helper after reviewing updates.
Never use “allow all applications” or broadly authorize node, shells, `security`,
or unrelated apps to read these items. New generic-password items trust only the
helper executable, using `SecAccessCreate` with its `SecTrustedApplication`.

In host-managed YAML (replace the home path with your actual absolute path):

```yaml
keychain:
  helperPath: /Users/harness/.local/libexec/harness-keychain/helper
  namespace: home                  # distinct per deployment / OS user
  adminWrites: true                # default false; reads still work when false
  timeoutMs: 3000                  # 100–10000, per helper operation
  cache:
    ttlMs: 60000                   # 0 disables; maximum 3600000
    maxEntries: 256                # 0 disables; maximum 4096
    maxBytes: 4194304               # UTF-8 value bytes; 0 disables; maximum 64 MiB
  globalChannel: [SHARED_API_KEY]
  channels:
    C0123456789: [GITHUB_TOKEN]
  mainProcess: [SLACK_BOT_TOKEN, SLACK_APP_TOKEN, OPENAI_API_KEY]
  providerKeys:
    openai: OPENAI_API_KEY          # memory-only SDK credentials, not auth.json
```

Enable web Admin using the existing [Admin access protections](secret-admin.md):
loopback or an **administrator-authenticating reverse proxy**, TLS off loopback,
and no request-body logging. `x-console-admin` and origin/Host checks prevent
accidental/cross-site writes; **the header is not authentication**. Protect the
entire Admin API and UI at the proxy; there is no new built-in login system.

Admin → Secrets and restart → Add or replace a secret → Storage backend →
**macOS Keychain**. Submit a name, new value and scope, selecting a known channel
ID for per-channel items. Confirm replacement explicitly. The same form replaces
values and offers an explicitly confirmed delete. Values clear after every
submission, including failures; no values are fetched, prepopulated, listed, or
stored in browser storage. Admin read-back describes only backends and channel
choices. No secret enters YAML, managed-env storage, `.env`, audit or timeline.
Set the import **names** in host YAML separately; provisioning does not authorize
an import. For initial setup, enable `keychain` with empty import lists and start
with existing working Slack/model credentials, provision the items in Admin, then
add their import names and restart. Importing an absent startup credential prevents
startup (including Admin); the helper does not silently fall back to your old key.
Channel configuration agents cannot edit `keychain` or its allowlists.

Standalone `doctor` uses the same scoped channel imports and memory-only model
keys; `connector-auth` validates the host and resolves only the selected channel.
The legacy `secrets` CLI remains dotenv-only for unmanaged names and refuses
writes/removals of Keychain-managed names rather than putting them on disk. Use
Admin for Keychain management; the smoke CLI below is dummy-only.

## Scopes and collisions

Service: `ai.slack-harness.keychain.v1.<namespace>`.
Accounts: `channel/<Slack-ID>/<NAME>`, `global-channel/<NAME>`,
`main-process/<NAME>`. Only these dedicated generic-password items are touched;
no arbitrary Keychain lookup/enumeration API is exposed to agents.

- **Channel:** the listed names for exactly that Slack ID, not its display name.
- **Global channel:** listed names available to every channel.
- **Main process:** never imported into channel environments; Slack credentials
  are requested during startup, model keys via the SDK memory-only API.
- Reads are exact. Missing, locked or denied entries **fail**, never fall through
  to another scope, provider, legacy file or process environment. A failed global
  import also fails if a channel has its own same-name item.
- Precedence is explicit channel import > global-channel import > legacy env.
  All Keychain-managed names are first removed from legacy env (including other
  channels' and main-only names). A same-name channel/global import must be
  explicitly configured to make a main-scope name channel-visible. Scopes remain
  separate items; this is not a fallback. This follows #222's scope conventions.
  No cross-provider collision order is introduced while #222/#223 are unmerged.
- Per-channel placeholder expansion cannot fall back to ambient main-only values.
  Put credentials in connector/CLI **env** or HTTP headers, not subprocess command
  or argument templates (these are rejected if they contain imported secrets).
  Secret values are not expanded into model-visible descriptions.

Docker and `macos-container` receive only the resolved channel environment, by
name-only `--env NAME` arguments. Neither gets the helper, login Keychain, an
unlock credential, other channels' imports or main-only values. Host bash,
including runtime grants, is refused in strict mode when Keychain is configured:
it would run as the Keychain owner. The explicit risk-acceptance switch above
relaxes this policy, not the scoped environment import rules.

**Host CLI and shared-script execution are also refused in strict mode** whenever
Keychain is configured, even for Docker/Apple Container channels: remove `exec`
from channel and default `tools`, and remove execution allowlists under `share.sharedTools`.
This includes account-wide CLI selections (`exec.shared`), absolute executable
paths and hash-pinned shared scripts. Those routes run on the host, not in the
channel sandbox; argv allowlists cannot prevent a planted `workspace/bin/gh`,
an interpreter or a script dependency from running with the Keychain owner's
identity. Config validation and effective channel resolution both fail closed.
Use `bash` with `sandbox.mode: docker` or `macos-container` for agent-controlled
commands instead, installing the tools and channel credentials in that sandbox.
Unselected `cliTools` definitions and shared-tool publishing alone remain inert
and are allowed. Without Keychain, existing host CLI/shared-tool behavior is
unchanged.

Operator-configured host MCP integrations remain trusted code with that OS
identity; do not configure agent-writable executables, commands that load
untrusted workspace code, or a Keychain tool. This change does not sandbox MCP
servers. Apple Containers has its own newer macOS requirements; see
[setup](apple-containers.md).

## Cache and failure behavior

Reads happen on demand when resolving a channel environment or requesting a main
credential, not by enumerating Keychain at boot. One bounded FIFO cache in the
main process uses provider + service/namespace + scope + channel ID + name keys.
Authorization against current import allowlists happens **before every hit**.
Expiry uses a monotonic clock; expired entries are purged lazily on the next read,
and never returned after a failed refresh. Setting any of `ttlMs`, `maxEntries`
or `maxBytes` to 0 disables cache reads/writes. Defaults retain at most 256 values
and 4 MiB of UTF-8 value bytes (at most 16 KiB each). FIFO eviction satisfies both
bounds; a valid value larger than `maxBytes` is returned without caching. Byte
limits cover value payloads, not JS object/string overhead or consumer copies.

Writes/deletes through this process invalidate the exact entry immediately, even
on failure. A global entry is shared across authorized channel callers, so one
invalidation covers them all; other scopes remain independent. External edits or
ACL changes become visible at expiry, not instantly. A still-valid hit may mask an
external lock/revocation until its TTL. Disable caching when that is unacceptable.
Config reload uses a new config/client/cache; old caches are garbage-collectible.

**Existing sessions/clients retain their resolved credentials** independently of
the lookup cache. After rotation, reload/reset affected channel sessions; restart
to replace main-process Slack/model clients. Cache TTL is not a remote revocation
mechanism for long-running consumers. Writes do not pretend to live-update them.

For HTTP connector OAuth, configured static client secrets (including Keychain
placeholders) stay in resolved process memory. Current configured client information
overrides any old client copy in the OAuth state file and is not copied there.
Consent and refresh still persist OAuth tokens, discovery and
pending PKCE state in the existing channel-private store; this is not a Keychain
backend for provider-issued tokens or dynamic client registrations. Legacy static
client copies are removed on the next state write, not proactively migrated; rotate
previously exposed credentials and review old backups separately.

The helper disables interaction (`SecKeychainSetUserInteractionAllowed(false)`):
no prompt hangs, Keychain unlock API or password handling. Missing entries,
denials, locked/interaction-required Keychains, unsupported platforms and helper
failures have fixed redacted diagnostics. Each lookup has a hard process timeout
(default 3 seconds) and capped output; no retry or stale-on-error behavior.
The synchronous resolver waits for each helper operation, so initial imports can
block the main event loop for up to `number of imports × timeoutMs` on failures
that occur late in a bundle. Keep imports small. No decrypted cache is persisted.

## OS user, GUI and launchd

The OS user's default Keychain and search list are used; this is normally their
login Keychain, **not** the system Keychain or another user's login Keychain.
No special entitlement, sudo, administrator privilege or accessibility access is
needed; only read/update/delete of this helper's dedicated generic-password items.

A logged-in GUI session often already has an unlocked login Keychain. A launchd
LaunchAgent under that user can access it only if the session, unlock state and
item ACL allow noninteractive access. A boot-time LaunchDaemon/service account
may have no usable default Keychain and will fail closed. Configure and unlock
that account's Keychain using trusted macOS UI/tools **outside** the harness.
When an ACL requires approval, use Keychain Access in an interactive session to
authorize only the reviewed helper; do not disable Keychain locking globally.
Never store the user's login/Keychain password in YAML, launchd environment,
stdin scripts, `.env`, browser storage or the harness. Touch ID is neither assumed
nor required; a Touch-ID-only item is not suitable for unattended lookups.

This reduces plaintext secrets on disk. It does not protect against a compromised
main process, trusted host integration, same-user malware, swap or crash dumps.
The native helper disables its own core dumps, but the Node process/OS can still
retain secrets. Caching increases decrypted residency; JS strings cannot be
reliably zeroized. Set a short TTL or disable it based on measured benefit.

## Tests and real macOS smoke / timing

Automated tests mock transport, Keychain reads and process results. They cover
scope/cache isolation, expiry, FIFO bounds, disable, writes/deletes, authorization,
redaction, Admin HTTP protections, and both sandbox environment argument builders.
**They are not evidence of real Keychain compatibility.** Linux cannot compile
Security.framework or exercise Keychain; run the following on a Mac before rollout:

```sh
node --experimental-strip-types src/cli/keychain-smoke.ts \
  "$HOME/.local/libexec/harness-keychain/helper"
```

This opt-in script uses a fresh `smoke_<UUID>` namespace and random **dummy-only**
values. It tests create/read/update/delete, all three scopes, channel cache
isolation, invalidation and missing entries; cleans up its items in `finally`;
and prints only timing/metadata. It reports 20 uncached helper+Keychain round-trip
median/p95 and 1000 authorized cache-hit mean. Record macOS, CPU, Node version and
results; do not assume Keychain itself is slow or equate subprocess cost with
Security.framework cost. No real-Mac timing has been measured by the Linux CI run.

Also manually verify on a dedicated test account/Keychain (not your live login):

1. Submit dummy values through Admin for C1, C2, global and main; replace/delete.
   Confirm GET/config read-back and network responses contain no stored values.
2. Verify C1/C2 containers in both sandbox modes have only their allowed dummy
   values; no Keychain/helper mounts. A main-only placeholder must fail.
3. Set cache TTL to 0, lock the **test** Keychain in Keychain Access, then resolve:
   receive the locked/interaction-required error within the timeout, without a
   prompt or legacy fallback. Unlock outside the harness and verify recovery.
4. Deny helper access to a dummy item; verify bounded failure. Authorize only the
   helper and retry. Repeat from the real launchd user/session, not just Terminal.
5. With a short TTL, prime a dummy cache entry then lock/deny it. A valid hit may
   work until expiry; after expiry it must fail, never return stale data. Restart
   to verify the cache is empty and no decrypted cache file was written.

If cleanup fails while locked/denied, remove only the printed smoke namespace's
items in Keychain Access once authorized. Rollback: remove the `keychain` config
block, restore required credentials through your previous backend, restart, and
optionally remove this deployment's dedicated items/helper. No automatic migration
or deletion of existing secrets occurs.
