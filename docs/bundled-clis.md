# Bundled service CLIs

`Dockerfile.harness` (host-mode bash / configured `exec`) and
`Dockerfile.sandbox` (Docker-mode bash) both retain GitHub `gh` and add:

| Command | Distribution | Pinned version |
| --- | --- | --- |
| `acli` | **Atlassian's official ACLI**, not a third-party Jira client | `1.3.39-stable` |
| `linear` | **schpet/linear-cli**, not an official Linear product | `3.0.0` |
| `wrangler` | **Cloudflare's official CLI**, from the `wrangler` npm package, with Node (see [Wrangler](#wrangler-cloudflares-cli)) | `4.151.1` |

The shared `scripts/install-harness-clis.sh` selects Linux amd64 or arm64 from
**the target image's** `dpkg --print-architecture`. Unsupported architectures
fail before downloading. Both runtime images use Debian Bookworm (glibc);
these binaries are not intended for Alpine/musl. They live in
`/usr/local/bin`, already on PATH for both the harness's `node` service user
and the sandbox's unprivileged `sandbox` user. Linear's license and bundled
third-party notices are kept under `/usr/local/share/doc/linear`.
Build-only extraction utilities remain in a disposable stage. Both images also
ship a [pinned Go toolchain](bundled-go.md), with its own installer and offline
build/test smoke.

## Integrity and upgrades

Both versioned downloads must match hard-coded, per-architecture SHA-256
checksums **before extraction or installation**. There is no `latest` URL,
`curl | sh`, build-time login, credential build argument, or secret in an image
layer. The existing `gh` installation is unchanged (GitHub's signed APT repo).

Upstream sources checked on 2026-10-10:

- [Official Atlassian Linux installation documentation](https://developer.atlassian.com/cloud/acli/guides/install-linux/).
  ACLI uses versioned `.deb` files from `https://acli.atlassian.com/linux/deb/`.
  The pinned digests come from the vendor's
  [amd64 Packages index](https://acli.atlassian.com/linux/deb/dists/stable/main/binary-amd64/Packages)
  and [arm64 Packages index](https://acli.atlassian.com/linux/deb/dists/stable/main/binary-arm64/Packages).
- [schpet/linear-cli v3.0.0 release](https://github.com/schpet/linear-cli/releases/tag/v3.0.0),
  with Linux glibc archives and upstream
  [sha256.sum](https://github.com/schpet/linear-cli/releases/download/v3.0.0/sha256.sum).

These are reviewable integrity pins, not a claim of independently verified
vendor signatures or reproducible builds. To upgrade, change the versions and
**both** architecture digests in the shared installer, verify them against
upstream metadata and downloaded files, update this document and smoke version
assertions, and run the regression tests and all four Docker smoke jobs.
Atlassian documents a six-month support window; revisit the pin regularly.
Do not make version/checksum overrides accept arbitrary build arguments.

## Wrangler (Cloudflare's CLI)

`wrangler` is how the software factory's `cloudflare_deployer` subagent deploys Workers and Pages projects (see the
README's *Subagents* section and the `cloudflare-deploy` skill). It is baked into **both** images, because
`sandbox.mode: host` runs `bash` in the harness image and `sandbox.mode: docker` runs it in the sandbox image.

It is distributed differently from the other CLIs, so it has its own pin and its own installer step:

- **One exact version, locked.** `scripts/wrangler/package.json` names `wrangler` at an exact version (never a range
  or a tag), and `scripts/wrangler/package-lock.json` locks the whole dependency tree. The build runs
  `npm ci --omit=dev --ignore-scripts`: `npm ci` refuses to deviate from the lockfile and verifies every package
  against its `sha512` integrity hash, and `--ignore-scripts` means no dependency's install script runs at build
  time (workerd and esbuild come as prebuilt, platform-specific optional packages, resolved for the target
  architecture, including under buildx emulation).
- **A build stage, not the runtime image.** Installation happens in a disposable `node:<pinned>-bookworm-slim` stage;
  only `/opt/wrangler` is copied into the final image and symlinked to `/usr/local/bin/wrangler`. npm's cache is
  cleaned in the stage.
- **Node in the sandbox image.** Wrangler needs Node, which the sandbox image does not otherwise carry. It gets the
  single `node` binary copied from the same pinned official image the harness runs on (both Dockerfiles share one
  `NODE_VERSION`, enforced by a test). The final image has no npm, corepack or package manager. This adds roughly
  the size of the Node binary to the sandbox image.
- **No telemetry.** `WRANGLER_SEND_METRICS=false` is set in both images.
- **No credentials in the image.** The channel supplies them at runtime (below). A test fails the build if either
  Dockerfile sets a Cloudflare credential variable.

### Authentication

Supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the deploying channel's own env file
(`envFile`, or `data/channels/<id>/env`), the same mechanism as `GH_TOKEN`. Wrangler reads them from the
environment, so no `wrangler login` and no OAuth browser flow is involved, and nothing is written to the image.

Create an **API token scoped to deploying and nothing else**: *Workers Scripts: Edit* on **one account** (add
*Workers Routes* or *Cloudflare Pages: Edit* only if the project needs them), with no DNS, zone or account-settings
permissions. Never use the Global API Key. Prefer one token per environment (a staging token in the staging
channel's env file) so that an approval for staging cannot reach production. The deployer role also requires a
person's approval in Slack before it runs at all (`requireApproval`), and its skill forbids the wrangler
commands that reach beyond a deploy (`delete`, `secret`, `d1`, `kv`, `r2`, `queues`, `login`/`logout`).
Those are guidance enforced by the model following a skill; **the token's scope is the real boundary**.

### Upgrading

Change the version in `scripts/wrangler/package.json`, regenerate the lock with
`cd scripts/wrangler && npm install --package-lock-only --ignore-scripts`, update the version asserted in
`scripts/smoke-harness-clis.sh`, and run the tests and the Docker smoke jobs. The packaging test fails if the manifest,
the lockfile and the smoke script disagree. Check the new version's engine requirement against `NODE_VERSION`.

## Camoufox is not a protected credential browser

The sandbox image also includes `camoufox-cli@0.7.6`. It runs with the channel
shell's authority and exposes JavaScript evaluation, screenshots and cookie
export. Do not use a password-filling wrapper or ordinary OpenBao imports to
claim passwords/sessions are hidden from that channel's tools. The isolated
credential/session manager requested in issue #10 is **not implemented**; see
[the security investigation and broker prerequisite](browser-credentials-security.md).

## Runtime authentication only

CLI installation does **not** enable `bash`/`exec`, broaden command allowlists,
pass host credentials into a sandbox, or grant Jira/Linear access. Keep existing
per-channel tool policy and sandbox environment injection. `exec` runs in the
harness environment, not a channel's Docker image; configure allowed argv
explicitly. Avoid sharing a service-user login across mutually untrusted channels.

- `gh`: supply `GH_TOKEN` at runtime through the existing secret/env mechanism,
  or authenticate interactively outside the image build.
- `linear`: supply `LINEAR_API_KEY` at runtime. This is the recommended headless
  container approach; it needs no system keyring. Optional `LINEAR_TEAM_ID` and
  `LINEAR_WORKSPACE` select project defaults. See upstream
  [authentication documentation](https://github.com/schpet/linear-cli/blob/v3.0.0/docs/authentication.md).
- `acli`: perform runtime Jira authentication as the **same non-root user** who
  will run commands, using the official stdin-token flow:

  ```sh
  # Values below are supplied privately at runtime, never in Dockerfile/ARG.
  printf '%s' "$ATLASSIAN_API_TOKEN" | acli jira auth login \
    --site "$ATLASSIAN_SITE" --email "$ATLASSIAN_EMAIL" --token
  ```

  `ATLASSIAN_*` above are shell inputs, not automatically recognized ACLI
  environment variables. `ACLI_TOKEN` alone is not the documented Jira login
  mechanism. See [official Jira authentication](https://developer.atlassian.com/cloud/acli/reference/commands/jira-auth-login/).

Never print tokens or enable shell tracing for authentication. Runtime login
may write credential/config files beneath the user's HOME. Default Docker
homes are container-local: replacing/removing a sandbox can lose that state.
If persistence is required, use a private per-channel HOME/config directory
inside its workspace with restrictive permissions, and keep the same HOME
for login and later invocations. Never place it under `artifacts/`, commit it,
copy it into an image, or mount a whole host home/shared credential store into
a sandbox. Prefer environment-based keys where supported.

## Smoke tests

The normal `npm test` suite has offline installer regressions for both target
architectures, unsupported architectures, download/digest/extraction failures,
real SHA-256 rejection of substituted downloads, and credential-free smoke
execution. It does **not** substitute for Docker builds.

On a Docker host, build and smoke both images as their non-root user with no
network or credentials. Override the harness entrypoint so it does not start
Slack or require config:

```sh
docker build -f Dockerfile.harness -t harness-cli-smoke .
docker run --rm -i --network none --user node --entrypoint /bin/sh \
  harness-cli-smoke -s < scripts/smoke-harness-clis.sh

docker build -f Dockerfile.sandbox -t sandbox-cli-smoke .
docker run --rm -i --network none --user sandbox --entrypoint /bin/sh \
  sandbox-cli-smoke -s < scripts/smoke-harness-clis.sh
```

The smoke script checks PATH, exact pinned versions, `gh`, Jira work-item and
Linear issue help, auth-command help, and wrangler: its pinned version, its `deploy`/`rollback` help, and a real offline
bundle of a trivial Worker (`wrangler deploy --dry-run`), which proves Node, esbuild and the platform packages work in
that image. It refuses root and clears inherited
environment variables, using a disposable HOME. It never logs in or calls a
service API. `.github/workflows/bundled-clis.yml` runs these builds/tests on
native GitHub-hosted amd64 and arm64 runners (both images, four jobs); it does
not push images, deploy, merge, or alter the running harness. Each job also
runs `scripts/smoke-go.sh` to verify the bundled Go toolchain offline.

For local binary-only checks without Docker, run the installer with
`sh scripts/install-harness-clis.sh "$(dpkg --print-architecture)" /tmp/cli-check`,
then prepend `/tmp/cli-check/bin` to PATH and run the smoke script as non-root.
This verifies downloads and native execution, not the final image wiring.
