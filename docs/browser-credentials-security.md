# Browser credentials: security plan and blocking prerequisite

**Status: not implemented.** This is the security investigation for
[issue #10](https://github.com/denwilliams/seneschal/issues/10), not setup
instructions for an available credential manager. Do not enter website passwords
in chat, ordinary secret imports or CLI commands to approximate this feature.
The missing isolated browser interface is tracked in
[issue #11](https://github.com/denwilliams/seneschal/issues/11).

## Findings in the current implementation

- `Dockerfile.sandbox` installs `camoufox-cli@0.7.6` and runs it as the same
  `sandbox` user that runs arbitrary channel bash. The browser binary being
  image-owned does not protect browser runtime state from that user.
- The upstream CLI provides `eval`, DOM inspection, screenshots and `cookies`
  list/import/export. Its daemon accepts JSON commands on a session-named Unix
  socket. A session name is a selector, not authorization. Tabs intentionally
  share cookies. Restricting a new wrapper's command list does not stop the
  channel shell from invoking the CLI, speaking the socket protocol or reading
  its own browser files. Container isolation from *other* channels does not
  isolate the browser from the channel that owns that container.
- `src/config/openbao.ts` loads ordinary imports into a startup snapshot;
  `openBaoChannelEnvironment` deliberately delivers selected imports to channel
  tools. This is appropriate for tool credentials, not for passwords that must
  be hidden from those same tools. Startup-cached imports also cannot implement
  immediate per-login revocation. A different secret namespace and retrieval
  lifecycle are necessary.
- `src/config/openbao-policy.ts` documents and permits an explicit
  `acceptHostExecutionRisk` override. Same-user host tools can read harness
  memory and credential files. That override must **not** waive the new browser
  boundary. A host-process wrapper is not an isolation mechanism.
- `src/console2/secrets.ts`, `src/config/scoped-secrets.ts` and the artifact
  listener implement the existing full-operator Admin boundary. Authentication
  must cover the APIs as well as the HTML, via configured server-side Cloudflare
  Access validation or an authenticating perimeter. Host/origin checks,
  Fetch Metadata and `x-console-admin` are CSRF controls, not authentication.
  There are no channel-member Admin roles to reuse. Ordinary secret
  administration is not a protected browser or a human-login handoff.
- There is no harness-owned isolated Camoufox broker, channel-authenticated
  browser-control transport or channel-bound human MFA/passkey handoff in the
  current integration. `--headed` alone provides none of those properties.

### Reproducible evidence

Inside a freshly built sandbox image containing the pinned CLI and browser:

```sh
# Run from this checkout; only synthetic data and an ephemeral loopback site.
# Choose a private scratch directory outside retained artifacts.
mkdir -p /workspace/tmp
TMPDIR=/workspace/tmp node scripts/probe-camoufox-boundary.mjs
```

The opt-in probe creates a random, disposable session and password, supplies the
password through the daemon socket (not a command-line argument), and shows that
an ordinary CLI `eval` can recover it. It also shows that ordinary CLI `cookies`
can recover a synthetic **HttpOnly** cookie which `document.cookie` cannot read.
It prints conclusions, not values. It uses a private temporary HOME/config,
never opens an existing profile, and closes only its own session. It does not
use OpenBao, a real website, real credentials or a persistent browser profile.
Missing CLI/browser support or failed assertions are failures, not evidence of
security. This is a proof of the existing missing boundary, **not** an acceptance
suite or a recommendation to put passwords through the socket.

## Threat model for implementation

### Trusted

- Operators admitted by the authenticated full-Admin perimeter; broker and
  harness supervisors, their protected configuration and credentials, and the
  operating-system/container isolation infrastructure.
- OpenBao, TLS trust roots and the dedicated broker implementation.
- The exact approved credential-recipient origins, including their delivered
  scripts, to receive the password. A compromised recipient can retain or misuse
  the password; no form-filling mechanism can hide it from its intended server.

### Untrusted

- Models, tool arguments/results, channel shell/file/exec/shared tools and
  channel-controlled connectors, workspace files, prompts and website content.
- All other channels and all origins not explicitly approved by an operator.
- Arbitrary pages, frames, redirects, popups and downloads, even if the initial
  login URL is approved. Origin approval does not authorize arbitrary account
  actions or waive existing factory approvals.

### Protected assets and exclusions

Protect usernames/passwords, broker/OpenBao authentication, cookies (including
HttpOnly), storage, tokens in URLs/DOM, profiles, caches, screenshots, recordings,
crash dumps and human-control capabilities from agents and general tools.
No secret-bearing browser material may enter tool-output files, transcripts,
logs, workspace/shared mounts or normal data backups. Cookie encryption at rest
alone is not sufficient if tools can read its key or ask the browser to export.

A fully compromised operator, broker, intended recipient or isolation host is
outside this boundary. Host execution as the harness/broker identity cannot be
silently treated as untrusted while retaining access to that identity's memory
or files. Disable the feature in unsafe deployments, including explicit legacy
host-risk acceptance; do not report it as securely available there.

## Required boundary change (#11)

A separately isolated broker must own the browser, secret retrieval and session
state. General channel tools must not have its OS identity, process inspection,
filesystem mounts, debugging sockets, broker authentication or arbitrary browser
control. The approved deployment must enforce this rather than relying on a
configuration field asserting that it is isolated. A separate process, hidden
session name, filesystem mode under the same user or filtered CLI response is
not sufficient. Channel connectors and all host tool routes need the same audit.

The authenticated harness-to-broker transport derives channel identity from the
running channel context, never an agent-supplied channel ID. Agent operations are
a closed list: list safe labels/approved-origin metadata, request login by label,
and read coarse status. No eval, selector/program input, screenshots, DOM,
network traces, raw error messages, cookies, profile paths or token-bearing URLs
are returned. Reuse does not mean exporting cookies to the sandbox CLI. Any
future authenticated browsing operations need a separate capability review.

Enforce exact HTTPS origins (scheme, host and port), no wildcard/subdomain
inheritance or URL userinfo. Check the top-level destination, form recipient and
all relevant frames immediately before supplying credentials, with navigation
races handled fail-closed. Enforce all redirects and outbound browser traffic,
not just the initial `goto`: WebSockets, workers, service workers, downloads,
popups, DNS rebinding, IP literals, private/link-local destinations and non-HTTP
protocols must not bypass the approved-origin/egress boundary. Disable unsupported
primitives. OpenBao/broker management endpoints must not be browser destinations.

Human control must be an authenticated, channel/browser-bound, short-lived
handoff, with explicit expiry, replay protection, cancellation and no access to
other contexts. Only the trusted human path may receive browser images or input
capabilities. Completing MFA continues the **same isolated context**. Passkeys
require a verified Camoufox/WebAuthn and authenticator transport path; neither
headless flags nor a documentation-only instruction to complete a passkey on a
different browser proves this. #11 must implement and test a supported path and
state its hardware/browser prerequisites before #10 can be called complete.

## Lifecycle integration after the prerequisite

1. Add a channel-selected **Browser credentials** Admin section behind the
   existing authenticated full-Admin boundary. Validate known channel IDs,
   methods, same-origin/Fetch Metadata, custom JSON-write header and body bounds;
   disabled/non-Admin processes fail closed. Full operators may select any known
   channel; this is not a new channel-membership permission model.
2. Keep credentials in a dedicated OpenBao KV v2 namespace outside ordinary
   `channels/...` environment imports, with least-privilege separate runtime and
   provisioning policies. Store labels, approved origins and secret values there,
   never in YAML, environment, workspace files or local storage. Broker retrieval
   is fresh on every login, not a startup cache. No plaintext fallback.
3. Expose only an allowlisted metadata projection to the agent. The Admin form
   accepts new username/password values, never reads existing values back,
   requires explicit replacement and clears sensitive input after every submit
   (including failure). Do not echo provider/parser exceptions. Disable proxy/APM
   request-body capture; password managers/extensions remain trusted human-side
   components, not a model-readable interface.
4. Bind credentials and sessions to server-derived channel identity. Serialize
   login, replacement, revocation and clear operations per affected context.
   Revocation must prevent later retrievals and handle in-flight fills explicitly
   (cancel/recheck before supplying a value); replacement must not leave a stale
   credential cache. A failed clear must not report success or resurrect state
   through an in-flight login.
5. Retain authenticated state only inside the protected broker. Clear closes
   active contexts and destroys all retained local state, including pending human
   handoffs. Define persistence across broker restarts explicitly; memory-only
   retention is acceptable if documented honestly. Remote website sessions are
   **not** invalidated by deleting a stored password or clearing a local profile;
   use the website's own session-revocation/logout facilities for that.
6. On broker/OpenBao outage or missing isolation, refuse login with a sanitized
   status. Never fall back to the general CLI. Recovery/rollback must retire
   active protected contexts and human handoffs before restoring a prior version;
   disabling the feature never exports retained state into a channel.

## Acceptance evidence required before closing #10

| #10 criterion | Required evidence | Current result |
| --- | --- | --- |
| 1: write-only console lifecycle | Real Admin authorization, channel targeting, CSRF, replace/revoke and non-readback tests against synthetic OpenBao | Not implemented |
| 2: controlled login | Broker retrieves/fills without values in model context, argv, environment, logs or results; negative shell/DOM/debug/profile extraction tests | Existing CLI fails the boundary probe |
| 3: destinations/frames/redirects | Malicious fixtures, redirect-while-filling race, nested frames, form action and egress tests | Not implemented |
| 4: channel/session isolation | Real OS-boundary shell attacks, forged channel identifiers and cross-channel session access tests | Broker missing (#11) |
| 5: revoke/clear | Fresh lookup, in-flight revoke/clear races, pending handoff cancellation, local destruction and remote-session warning | Not implemented |
| 6: human MFA/passkeys/reuse | Authenticated expiring/replay-resistant channel handoff and a real supported authenticator path | Browser interface missing (#11) |
| 7: negative tests/setup | Adversarial integration suite, leak sentinels, installation and operational recovery docs, console screenshots | Only the synthetic risk probe is supplied here |

This plan deliberately adds no credential-write UI, stored secrets, login tool or
feature-availability claim. The public website and private console are unchanged:
security planning is not a delivered browser capability. Review the prerequisite
boundary independently, then implement and review the full lifecycle against
this matrix. Keep #10 open until all seven criteria have evidence.
