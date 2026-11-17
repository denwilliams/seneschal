# Kiri sandbox (opt-in)

Select `sandbox.mode: kiri` for both channel bash and delegated/factory-role bash.
Host, Docker and Apple Containers defaults are unchanged. This adapter targets
**Kiri 0.2.1**, checking the server's `Kiri` version component (0.2.1+), not its
Docker compatibility version (27.5.1). Newer releases still need operator testing.

## Setup

1. Install [Kiri](https://github.com/libracoder/kiri) with its bundled Docker CLI,
   open Kiri once to finish setup, and start it (or run `kiri daemon`). The native
   `kiri` executable must be on the **harness process user's PATH**, not just in
   your interactive shell. The harness also needs standard `tar` on PATH.
2. As that user, verify `kiri version`, `kiri info`, and `kiri ps`. Missing CLI,
   unavailable daemon, malformed version output or an unverified server fail
   closed with setup guidance. There is no automatic Docker-context or host
   execution fallback, and the adapter never changes your Docker context.
3. Build an image with bash and Linux stat/mkdir/chmod, for example:

   ```sh
   kiri build -f Dockerfile.sandbox -t seneschal-sandbox:latest .
   ```

   Set up Kiri's BuildKit builder through its setup UI if necessary. A channel's
   own Dockerfile is built on first use with only its workspace as build context,
   just as for Docker. Images declaring `VOLUME` are refused.
4. Configure the existing account defaults or channel override mechanism:

   ```yaml
   channels:
     engineering:
       tools: [read, write, edit, ls, find, grep, bash]
       sandbox:
         mode: kiri
         image: seneschal-sandbox:latest
         network: none        # bridge for outbound network
         reuse: true
         pidsLimit: 256
         memory: 512m
         cpus: 1
         readOnlyRoot: false  # persistent container-local /repos
   ```

   Reload/restart the harness to apply changed bash routing. `npm run doctor`
   reports runtime availability and mount/image setup. If the harness itself is
   containerized, it needs the Kiri CLI and access to Kiri's socket/identity;
   `HARNESS_DOCKER_DATA_DIR` remains the required host data-path translation.
   Selecting Kiri alone does not expose host paths or grant socket access.

## Transport and verified contracts

We inspected the [v0.2.1 source](https://github.com/libracoder/kiri/tree/b249eccc2ed708ce10d7feeb82b6c0869b112443),
not a live operator installation. Test fixtures are small **source-derived**
examples, not captured inspection output:

- `crates/kiri/src/main.rs` and `docker.rs`: native `kiri run`, `exec`, `inspect`,
  `start`, `stop`, `rm`, `top`, `image`, `build` and `version` dispatch the bundled
  (or discovered) Docker CLI against Kiri's socket. On Unix Kiri sets
  `DOCKER_HOST` and removes `DOCKER_CONTEXT`. Thus this is a **native CLI adapter
  using Kiri's Docker compatibility**, not invented raw CLI commands, a generic
  Docker-context adapter, or `kiri raw run` (which boots a separate guest).
- `daemon/api.rs`, `container_json`: `Id`, `State.Running`, `Config.Labels` are
  present; `ExecIDs` is omitted. This verifies upstream behavior only: it does
  **not** establish the cause of the original `Invalid Docker container
  inspection` incident, whose actual host response was not captured.
- `daemon/ops.rs`, `top`: returns fixed `UID PID PPID C STIME TTY TIME CMD`
  columns, ignoring Docker ps arguments. `kiri-init/src/linux/cgroup.rs` obtains
  process rows from the container cgroup, not guest-controlled shell output.
  Only a recognized table with exactly one process is idle evidence. Malformed
  tables, extra processes and CLI failures cannot authorize idle deletion.
- `daemon/api.rs`, `image_inspect`: omits **Labels and Volumes**, although create
  honors image volumes. `kiri-image/src/archive.rs`, `save`: exports the OCI
  config at `blobs/sha256/<config digest>`. The adapter saves a private temporary
  image archive and reads just that member with `tar -xOf` (no filesystem
  extraction), verifies its SHA-256 against the inspected image ID, rejects
  volumes and reads Dockerfile labels there. It caches up to 100 immutable
  configs in memory. The first check per image/process can require substantial
  temporary disk space and image-export time; the archive is removed afterward.
  Export/tar/digest/schema errors prevent execution rather than assuming safe
  missing metadata.

## Isolation, activity and recovery

The Docker-compatible arguments retain workspace/assigned-skill/global-bin mount
checks, read-only shared mounts, private mount propagation, resource limits,
capability dropping and no-new-privileges. Secrets are supplied by environment
name on exec, never their values in argv; the idle container does not persist
channel secrets. No other channel tree or harness credentials are mounted.
Writable `/repos` survives reuse and stop/start; `readOnlyRoot: true` uses bounded
tmpfs and loses `/repos` on stop. Durable outputs belong in `/workspace`.

Kiri names are `harness-kiri-<hash(channel, thread)>`; one-shots add a unique
suffix. Records, leases, installation identity and backend labels live in
`data/sandboxes/kiri/`, separate from Docker and Apple. Containers are never
adopted across backends. Main and factory subagents use the same adapter and
existing parent-thread sandbox identity rules. Only bash and its descendants
are sandboxed, not all agent tools/orchestration.

**Missing ExecIDs is unknown pending activity, not an empty execution list.**
As with Apple Containers, a durable in-flight record protects commands across
harness crashes. Failed/lost exec clients mark activity uncertain; successful
later commands cannot erase it. Automatic replacement and idle cleanup protect
that running container even if top shows only the idle process. After deliberately
stopping/cancelling the entire container and confirming it is stopped, recovery
can clear uncertainty. Cancellation stops the whole thread process tree, not
just the CLI. One-shot completion stops/removes descendants; removal is not forced.
Do not delete activity records to bypass protections. Errors may conservatively
retain a container until an operator stops it.

## Verification and live-test limitation

Regression coverage includes schemas, native CLI command selection, malformed
inspection/version/image responses, lifecycle/reuse/start/stop/removal,
ownership/activity recovery, cancellation, secret/mount boundaries, console
status, and actual main-agent plus factory-role subagent bash routing with a
faux model and source-derived runtime fixtures. Docker/Apple tests remain enabled.

**Live verification blocker:** neither `kiri` nor `docker` was available in the
factory execution container. No live Kiri main-agent or subagent execution was
claimed. Before relying on this provider on the operator's host, run:

```sh
HARNESS_TEST_KIRI=1 node --experimental-strip-types --test --test-timeout=1100000 src/agent/sandbox-kiri.live.test.ts
```

This opt-in smoke builds a disposable Debian image in Kiri and uses a faux model
(no Slack/model credentials) to invoke **real main-agent and factory-role bash**,
checks isolation/secret delivery and shared-thread `/repos` reuse, cancels a
process tree, verifies stopped state and restart persistence, and tests one-shot
removal. It creates/removes only its uniquely named fixtures. Record host OS,
`kiri version`, command/result and check results; do not publish private inspect
output, paths or environment values. Also exercise a real Slack main-agent and
factory run on that host before declaring production support verified.

### Rendered documentation evidence

Regenerate synthetic console (light/dark/mobile) and public-site evidence with:

```sh
SCREENSHOTS=1 npm run e2e --prefix web/console2 -- e2e/execution-kiri.spec.ts
node website/screenshots-kiri.mjs
python3 web/console2/scripts/shrink-pngs.py docs/screenshots/kiri # requires Pillow
```

## Rollback

Stop/cancel active or uncertain Kiri work deliberately first, retain valuable
`/repos` outputs in `/workspace`, then restore the prior `docker` or
`macos-container` configuration and image in that runtime's separate store.
Kiri containers/records remain separate; inspect them with `kiri` and remove
obsolete owned containers after a confirmed stop. No context or host-execution
fallback occurs when changing providers.
