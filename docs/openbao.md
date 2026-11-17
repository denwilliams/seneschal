# OpenBao secrets (KV v2)

OpenBao is an optional alternative to dotenv storage. Existing env/.env support remains available when OpenBao is not configured. Use **Admin → Secrets and restart** or the **host secret CLI** to manage OpenBao secrets. There is no value-read-back command or API. YAML contains only connection settings and names to import, never stored values.

If native macOS Keychain is also configured, both backends must succeed: there is no failure fallback. Channel resolution and doctor first filter legacy scoped/auth names, then overlay OpenBao imports, then Keychain imports. Within each backend, per-channel imports override global-channel imports. Keychain also takes precedence for overlapping main-process Slack names and model-provider bindings. Prefer distinct import names across backends. An explicitly channel-visible import from either backend remains usable even when the other backend has a main-only name with the same spelling.

## Setup and bootstrap

1. Run a trusted OpenBao service, initialize/unseal it, and enable a **KV v2** mount (`bao secrets enable -path=secret kv-v2`). Use HTTPS with normal certificate verification. HTTP is accepted only for loopback development. `address` is an origin, without a path, credentials, query, or fragment. TLS trust can be configured using Node's normal host CA configuration; TLS verification cannot be disabled by this integration.
2. Provision a least-privilege, read-only **runtime token** with the policy below. Use an OpenBao Agent auto-auth token sink or a host supervisor/secret mount to supply it in an absolute owner-only (`0600` or `0400`) regular file. The process must own it. Symlinks, hard links, group/world-readable files, files inside the repository or data directory, and oversized/empty tokens are refused. Keep its private parent directory outside every workspace, shared collection, knowledge root, backup directory, and container mount. Never put a root token in the harness. The YAML stores the file's path, not the credential.
3. Bootstrap the secrets using an **operator write token**, then run the harness with the runtime token file. The CLI uses the same YAML connection settings; point `HARNESS_CONFIG` at a separate operator configuration with its own private token file when provisioning. Never give either token to a channel or export it into a channel environment. The integration does not use `BAO_TOKEN`/`VAULT_TOKEN` or pass a credential to a sandbox.
4. Add the names you want to import to the configuration, then start/restart the harness. `npm run doctor` uses the same imports and fails closed on errors. Keep `.env` only for legacy/bootstrap settings you still need; no OpenBao value is copied there.

```yaml
openbao:
  address: https://bao.example.net
  tokenFile: /run/secrets/harness-openbao-token
  # Optional: enable write-only web Admin saves with a separate provisioning token
  # adminTokenFile: /run/secrets/harness-openbao-admin-token
  mount: secret
  prefix: harness
  timeoutMs: 5000
  globalChannel: [SEARCH_KEY]
  channels:
    C123ABC: [GITHUB_TOKEN, SEARCH_KEY] # durable Slack IDs, never names
    C456DEF: [GITHUB_TOKEN]
  mainProcess: [SLACK_BOT_TOKEN, SLACK_APP_TOKEN, MODEL_API_KEY]
  providerKeys:
    openai: MODEL_API_KEY # SDK provider ID -> imported main-process name

defaults:
  sandbox:
    mode: docker # or macos-container / kiri; required wherever bash is enabled
connectors:
  example:
    transport: http
    url: https://mcp.example.net
    headers:
      Authorization: Bearer ${GITHUB_TOKEN}
channels:
  C123ABC:
    share:
      connectors: [example]
```

`mainProcess` is delivered directly to main-process consumers, never expanded into the shared configuration or `process.env`. `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are consumed by the Slack client. `providerKeys` injects imported names into the Pi SDK's **memory-only** runtime API-key store for built-in or configured provider IDs, without modifying `auth.json`. Account-level `requires.env` checks can also use these private imports without exporting their values. Other imported main-process names remain private and unused unless a host-side consumer is added; `${NAME}` in connector/tool environments cannot retrieve them. For a configured model server, use its provider ID in `providerKeys`, not an interpolated main-process key in `modelProviders.*.apiKey`.

When either scoped backend is configured, connector descriptions, restricted CLI
descriptions and argument-policy metadata, and shared-tool argument policies stay literal:
`${NAME}` is not expanded there, including for non-secret variables. Supply
credentials through connector HTTP headers or connector/CLI/shared-tool **env**
values instead. Imported secrets in subprocess command or argument templates are
rejected without echoing their values; fixed CLI arguments also appear in tool
descriptions. With neither backend configured, legacy interpolation is unchanged.

### Unattended macOS LaunchDaemon (no Keychain)

This backend works with `keychain` **omitted**. It does not run `security`, unlock a login keychain, need an interactive login, or authenticate using the daemon's environment. OpenBao itself must be initialized/unsealed and reachable before imports can succeed.

- Run the harness under a dedicated, unprivileged `UserName`, not root. Install supported Node and container tooling for that account. Disable channel `exec`/shared tools and use `sandbox.mode: macos-container` or `docker` for bash; a LaunchDaemon must be able to reach the chosen container runtime without a logged-in desktop session.
- Create a private directory such as `/Library/Application Support/HomeHarness/private` owned by that account with mode `0700`. Put the runtime token in a regular file there, mode `0600`, owned by that same account. Use the **canonical** path in YAML (on macOS, `/var/...` is often a symlink to `/private/var/...`; symlink paths are refused). Keep both runtime and optional Admin tokens outside the checkout, data directory, backups and every configured external read/mount root. Do not put token contents in a plist, `.env`, shell command line, or YAML.
- Prefer a separately supervised **OpenBao Agent auto-auth** process using an operator-configured machine identity (for example AppRole with separately secured RoleID/SecretID files), a `file` token sink at `tokenFile`, and renewal enabled. Secure the Agent credentials just as tightly, outside all channel-accessible roots. Agent login/renewal is not implemented by the harness. Do **not** enable an auto-authenticated Agent proxy accessible to channels. Alternatively, supply/renew a scoped token with your host supervisor; expiring static tokens require operator rotation before the next import/restart. Keep the OpenBao unseal/recovery material offline, never in the harness.
- A minimal illustrative plist fragment (replace paths/account; no credentials) is:

```xml
<key>Label</key><string>net.example.home-harness</string>
<key>UserName</key><string>harness</string>
<key>WorkingDirectory</key><string>/opt/home-harness</string>
<key>ProgramArguments</key><array>
  <string>/opt/homebrew/bin/node</string><string>/opt/home-harness/dist/index.js</string>
</array>
<key>EnvironmentVariables</key><dict>
  <key>HARNESS_CONFIG</key><string>/opt/home-harness/config/harness.yaml</string>
  <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
```

Build before loading the daemon. Run `npm run doctor` as the daemon account with that same config/path first; then verify startup and `/health` using your existing service supervision. This fragment is not an installer and changes no live service. Keep logs private. If the token is absent/expired, OpenBao is sealed, or a required path is inaccessible, startup exits with a sanitized error instead of using `.env`; launchd may retry at its throttle interval. Recover by unsealing/restoring service, renewing/replacing the owner-only token file, and restarting. Never grant a broader token to bypass an import error. For rotation, write a new private file and atomically rename it over the old one (no symlink), then reload channels or restart as below. Admin writes reread their separate credential on each request.

### Host trust boundary

By default, OpenBao-enabled configurations refuse host bash (including runtime grants), host CLI execution (`exec`), and selected host shared tools (`share.sharedTools`). The operator-only boolean **`openbao.acceptHostExecutionRisk` defaults to `false`**. Only a literal `true` relaxes these execution guards, including host exec/shared tools in container channels and runtime bash grants. Channel agents, including privileged agents, cannot edit this setting through configuration tools; runtime grants cannot enable it.

**Enabling it trusts all same-user host execution:** host tools may read the runtime/provisioning token file or process memory, obtain backend credentials, and access backend secrets outside configured channel scopes, up to the credentials' backend permissions. Container channels do not isolate their secrets from the host. Import scopes remain useful delivery controls, **not an OS-enforced boundary against host execution**. Keychain risk acceptance never accepts OpenBao risk; if both backends are configured, both must explicitly accept host-execution risk or the unaccepted backend still blocks its protected routes.

Example mixed deployment (operator-managed YAML, not a live-deployment recommendation):

```yaml
openbao:
  address: https://bao.example.net
  tokenFile: /Users/harness/.config/harness/runtime-token
  acceptHostExecutionRisk: true
  channels: { C123ABC: [GITHUB_TOKEN] }
  mainProcess: [SLACK_BOT_TOKEN, SLACK_APP_TOKEN]
defaults:
  tools: [read, bash]
  sandbox: { mode: docker } # macos-container is also supported
channels:
  C123ABC: {} # container channel gets its explicit import
  CHOST:
    sandbox: { mode: host }
    tools: [read, bash, exec] # exec remains subject to its command allowlist
    exec:
      commands:
        version: { command: /usr/bin/uname, allowArgs: [[-s]] }
```

The host channel above gets no automatic OpenBao imports, but its OS identity can still access the credentials. Startup logs, `npm run doctor`, configuration reload warnings and Admin backend metadata report accepted risk separately from Admin-write availability. The override does not enable Admin writes without `adminTokenFile`, export additional secrets/credentials, relax token-file or TLS checks, bypass missing/denied-secret failures, or change dotenv, scoped import and main-process-only delivery rules.

**Return to strict mode:** remove/disable host bash, host exec and selected shared-tool execution in defaults and channel overrides (move bash to Docker/Apple Containers; revoke host bash runtime grants). Set `openbao.acceptHostExecutionRisk: false` or remove it, then reload configuration; restart to retire in-flight work immediately. Configurations still selecting forbidden host tools are rejected, and runtime host bash grants are blocked on resolution. Container bash gets only the resolved channel environment.

Operator-configured stdio connectors and external read/mount roots are still **operator-reviewed trusted code/capabilities**, not an OS security boundary; do not allow them to read host credentials, inspect the harness process, run arbitrary interpreters, mount host directories, or contact a privileged OpenBao proxy. Do not mount the token file, host `/proc`, Docker socket, or harness filesystem into channel containers. Restrict backend network access so channels cannot reach an auto-authenticated agent listener. OpenBao cannot make an already privileged host tool safe.

## Add/manage secrets

### Web Admin

Accepted host-execution risk is shown as a warning, not an unavailable backend. Strict-mode violations are rejected during configuration/runtime validation; accepting risk alone does not enable Admin writes.

Set `openbao.adminTokenFile` to an owner-only provisioning credential file with create/update permissions on the scopes an administrator may manage. It has the same path/permission checks as the runtime token. Without it, OpenBao remains available for imports/CLI but its Admin selector is disabled. The runtime token can remain read-only. The writer reads its file on each save, so rotating that credential does not require restarting.

In **Admin → Secrets and restart → Add or replace a secret**, select **OpenBao** under **Storage backend**, select **Global to all channels**, **Per channel** (then a known channel), or **Main process only**, enter a name and new value, and confirm replacement. The server validates backend, name and scope, checks the selected channel against known/configured IDs, then writes via the OpenBao API. Success does not edit import lists or apply running credentials: add the name to the matching YAML import and reload/restart as described below. The value is cleared after every submission, never prepopulated, returned by GET, or retained in browser storage. Server-side errors never contain provider exception text. Deletion remains an explicit host CLI operation.

This uses the existing externally authenticated **full Admin** trust boundary: the console has no internal login/roles. Keep all Admin routes behind an authenticating proxy/VPN and never expose the unauthenticated listener to untrusted users. The request still requires the Admin service, allowed Host/origin/Fetch Metadata, JSON, custom `x-console-admin` header, rate limits and body bounds. A non-Admin process cannot write backend secrets. Protect request bodies from proxy/access logging. The provider-neutral writer registry/API and form are also the extension point for other backend integrations; no backend credential is sent to the browser.

### Host CLI

Values come from stdin (or the existing `SECRET_VALUE` facility), not argv. Avoid shell tracing, terminal history containing literal secrets, and pipelines that log stdin. Examples use placeholders, not credentials:

```sh
# Scope is always explicit. These commands run on the operator host.
printf '%s' "$NEW_SECRET" | npm run secrets -- openbao set channel C123ABC GITHUB_TOKEN
printf '%s' "$NEW_SECRET" | npm run secrets -- openbao set global-channel SEARCH_KEY
printf '%s' "$NEW_SECRET" | npm run secrets -- openbao set main-process SLACK_BOT_TOKEN
npm run secrets -- openbao list channel C123ABC
npm run secrets -- openbao list global-channel
npm run secrets -- openbao list main-process
# WARNING: permanently removes metadata and ALL versions, not just the latest.
npm run secrets -- openbao remove channel C123ABC GITHUB_TOKEN
```

List returns **names only**. Set creates a KV v2 version containing `{ "value": "…" }`; replacing a name is last-write-wins, as with the existing CLI. Limits: uppercase environment names, 128 characters per name, 16 KiB non-empty UTF-8 values, no NULs. Runtime/control variables and `BAO_`, `VAULT_`, `HARNESS_OPENBAO_` authentication names cannot be imported or stored through this CLI. Add a new secret's name to its matching import list yourself; set does not edit YAML. Remove its import before deleting it. Existing `npm run secrets -- set CHANNEL KEY` still writes the legacy dotenv store; it does **not** target OpenBao.

## Scope/path mapping and resolution

Each secret has a separate KV v2 document:

| Scope | Logical path under the KV mount | Delivered to |
| --- | --- | --- |
| Channel | `harness/channels/C123ABC/NAME` | That ID only |
| Global-channel | `harness/global-channel/NAME` | All channels, including unconfigured channels and DMs |
| Main-process | `harness/main-process/NAME` | Explicit main-process Slack/model consumers only |

With mount `secret`, reads use `/v1/secret/data/<logical-path>`; metadata listing/deletion uses `/v1/secret/metadata/<logical-path>`. `prefix` replaces `harness`. Separate deployment prefixes and policies prevent cross-deployment access.

Resolution, lowest to highest: **process environment < global env file < channel env file < imported global-channel secrets < imported secrets for this channel < harness-generated runtime facts**. Same-name imports in two channel scopes are independent. If `TOKEN` exists in main-process and a channel-visible scope, the channel receives only the explicitly imported channel-visible value, never the main-process value. All names managed by OpenBao (including another channel’s imports) and bootstrap-auth names are filtered out of legacy channel layers before explicitly visible imports are added; expansion has no fallback to the unfiltered process environment. A channel without a per-channel import gets only imported global-channel values plus allowed legacy values. Unimported backend names are never fetched or exposed.

Every configured import is **required**, even when a higher-priority scope would shadow it. Missing/deleted/wrong-shaped values fail initialization. An authentication/authorization error, timeout, redirect, network failure, invalid response or unavailable backend also fails initialization; there is no scope, environment or stale-cache fallback for a new startup/configuration. Only CLI listing of an absent scope directory returns an empty name list. Error messages never include response bodies, values, credentials, request URLs or transport exception text.

## Least-privilege policy examples

Runtime reads only explicitly imported paths; it does not list the mount or discover other channel scopes. Prefer one exact path per imported name:

```hcl
# Runtime: no write, delete, list, sys, auth or token-management permissions.
path "secret/data/harness/main-process/SLACK_BOT_TOKEN" { capabilities = ["read"] }
path "secret/data/harness/main-process/SLACK_APP_TOKEN" { capabilities = ["read"] }
path "secret/data/harness/main-process/MODEL_API_KEY" { capabilities = ["read"] }
path "secret/data/harness/global-channel/SEARCH_KEY" { capabilities = ["read"] }
path "secret/data/harness/channels/C123ABC/GITHUB_TOKEN" { capabilities = ["read"] }
path "secret/data/harness/channels/C123ABC/SEARCH_KEY" { capabilities = ["read"] }
path "secret/data/harness/channels/C456DEF/GITHUB_TOKEN" { capabilities = ["read"] }
```

A separate provisioning token can have create/update on the specific scope data paths, list on each scope directory, and delete on that scope's metadata paths if permanent removal is desired. Example **one-channel operator** policy (repeat only for the scopes the operator may administer):

```hcl
path "secret/data/harness/channels/C123ABC/*" { capabilities = ["create", "update"] }
path "secret/metadata/harness/channels/C123ABC" { capabilities = ["list"] }
path "secret/metadata/harness/channels/C123ABC/*" { capabilities = ["delete"] }
```

No read-value permission is required for CLI set/list/remove. If the KV mount enforces CAS-required writes, provision with `bao` and CAS or adjust that policy; this CLI's set uses ordinary KV v2 writes and does not implement compare-and-swap. Enforce the backend's audit policy so request bodies (including the `value` field) and authentication tokens are hashed/redacted, never exempted from audit hashing. The harness does not control external backend/proxy logging.

## Lifecycle, rotation and rollback

Imports are fetched sequentially at startup into one atomic, private in-memory snapshot (maximum 256 names per scope). No values are persisted or attached to the config object. There is no background refresh, disk cache or automatic retry. The bootstrap token/client is only needed during import/CLI operations, not during channel turns. Renew/rotate the token using OpenBao Agent or your supervisor before the next reload; the file is re-read on each initialization.

A config reload imports a complete new snapshot before publishing it, then existing active turns finish on their old channel snapshot. A failed reload leaves the previous running config/snapshot untouched and reports failure; it does not report the new config as applied. Newly resolved channels use the refreshed channel/global values. **Slack/model clients are initialized at process startup, so changes to main-process imports or provider bindings require a supervised restart**, even after a successful channel reload. Old turn/client values remain in memory until their consumers are disposed; revoke compromised credentials at the backend/provider too. Backend revocation is not pushed to existing consumers.

Rollback: restore the previous OpenBao KV version and restart (or reload channel imports), or restore the previous YAML and legacy env configuration and restart. Disabling `openbao` never exports its values into legacy storage. Keep old required secrets until all running consumers have retired. Tests use a local synthetic KV v2 HTTP server plus real channel resolution, subprocess environment delivery and the SDK credential API; no production OpenBao is required to run the test suite.

## Optional live smoke check

Against a disposable, already initialized/unsealed KV v2 service, provision **synthetic** values at one path in each scope using a separate operator token, configure the exact three imports and private runtime token file, and run `npm run doctor`. Verify an isolated channel sees its channel override and the global value, a second channel cannot read the first channel's name, and neither sees the main-only name. Exercise a write in each scope through authenticated Admin, then confirm GET returns metadata only. Revoke the runtime token or seal the test service and confirm a fresh doctor/start fails without environment fallback; restore access and restart to recover. Do not use production secrets for this check. Automated tests use a local KV v2 protocol fixture; they do not establish real-service TLS, policy provisioning or launchd availability.
