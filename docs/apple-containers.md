# Apple Containers sandbox (opt-in)

Use `sandbox.mode: macos-container` to run bash with Apple's [`container`](https://github.com/apple/container) runtime instead of Docker. Host and Docker defaults are unchanged. This implementation targets **container 1.6.1**, with compatible newer **1.x** client/server versions accepted; unknown major versions are refused. CLI contracts were checked against the [1.6.1 source](https://github.com/apple/container/tree/1.6.1), not the old unmerged harness PR #16.

## Requirements and setup

- Native harness installation on **Apple Silicon, macOS 26 or newer**. Intel Macs, remote runtimes, and running this backend from inside Docker/Compose are not supported. Do not set `HARNESS_DOCKER_DATA_DIR` for Apple: mounts use native host paths.
- Install Apple's official `container` release, put it on the harness service's PATH, and run `container system start` as the same macOS user that runs the harness. Install the Linux kernel when prompted. Both the CLI and running service must be version 1.6.1 or a compatible newer 1.x release.
- Build a native Linux/arm64 image. It must contain bash, `/bin/sh`, Linux `/proc`, and **util-linux `/usr/bin/setpriv` with `--no-new-privs` support**. The bundled Dockerfile includes these requirements. Images and their startup profiles must be operator-trusted; do not configure `LD_*` environment variables in the image or channel.

From the repository root:

```sh
container system status --format json
container build --platform linux/arm64 -f Dockerfile.sandbox -t seneschal-sandbox:latest .
```

In the harness YAML (under `defaults.sandbox` or a channel's `sandbox`):

```yaml
channels:
  engineering:
    tools: [read, write, edit, ls, find, grep, bash]
    sandbox:
      mode: macos-container
      image: seneschal-sandbox:latest
      network: none       # genuinely offline; bridge attaches Apple's default network
      memory: 1g          # per-thread VM memory
      cpus: 1            # whole VM CPUs, not Docker's fractional CPU quota
      pidsLimit: null     # explicit acceptance: Apple has no cgroup PID-limit flag
      readOnlyRoot: true # required: protects the no-new-privileges launcher
      reuse: true
      timeoutSeconds: 120
      idleSeconds: 86400
      # user: "501:20"   # if necessary, use your Mac's numeric `id -u`:`id -g`
```

Run `npm run doctor` using the same configuration/environment as the service. Doctor reports unsupported configuration, missing/incompatible services and missing images. Runtime checks repeat before dispatch; failures never fall back to the host or Docker. A missing image-provided launcher fails before agent code can run, with diagnostics mentioning `setpriv`.

A channel's operator-managed `data/channels/<id>/Dockerfile` still overrides `sandbox.image`, is built on first use with `container build`, and is rebuilt when its contents change. **Only the workspace is the build context**, not the channel root or its secret env file. Build-time networking is separate from runtime `network: none`. As with Docker, changing a copied context file alone does not invalidate the Dockerfile fingerprint; edit the Dockerfile or delete its image to force a rebuild.

## Boundaries and intentional differences

- Each thread gets its own lightweight VM/container. Only its channel workspace is writable at `/workspace`; the channel's own skills, explicitly assigned collections and global bin use the same fixed `/skills/...` and `/global/bin` mounts as Docker. Read-only collections and global bin remain read-only. `/repos` is never a host bind or named volume. Apple's VirtioFS mounts do not use Docker's mount-propagation flag; the VM boundary separates host and guest mount namespaces.
- All Linux capabilities are dropped. Every init/exec uses immutable `/usr/bin/setpriv --no-new-privs`; preparation also checks `NoNewPrivs` and the capability bounding set. `LD_*` forwarding is rejected to protect this launcher. Secrets are inherited by name, never placed in argv; harness Slack tokens and host-only paths are not forwarded.
- **No PID limit is enforced.** Selecting Apple alone does not silently discard the default `pidsLimit: 256`: commands fail until the operator explicitly sets `pidsLimit: null`. Keep Docker if you need a cgroup PID limit. `null` is also an explicit opt-out for Docker; its default stays 256.
- **A read-only root is required.** Put tools in the operator-managed image, not runtime package installs. `/tmp` (64 MiB) and `/repos` (256 MiB, mode 1777) are bounded tmpfs. They survive command reuse but are lost whenever the container stops/reboots, **including cancellation or a harness shutdown that cancels active commands**. Save durable results under `/workspace`. Programs needing writable homes/caches may need a per-command `HOME` under `/tmp`. Fractional CPU counts are refused; memory/CPU are VM allocations.
- `network: none` passes Apple's explicit `--network none`. `bridge` selects its `default` network, allowing networking; it is not a firewall between channels or against the host. No host sockets, SSH agent, ports, named volumes, or Rosetta are enabled. Image `VOLUME` metadata is ignored by Apple 1.6.1, not auto-mounted; if a compatible CLI reports volumes, the harness rejects them. Repository path/mount validation runs before each command.
- Apple names are `harness-apple-<hash(channel, thread)>`, bounded to Apple's 63-character limit. One-shots use unique `harness-apple-once-...` names. Docker names stay unchanged. Ownership labels, leases and activity records prevent cross-runtime adoption/cleanup: Apple state is under `data/sandboxes/macos-container/`, separate from existing Docker records.
- Images are pinned by digest using a verified local digest-qualified image alias (Apple does not look up a locally built image by digest alone). These aliases remain in Apple's image store after container expiry; remove unused aliases with `container image delete <reference@sha256:...>` when no longer needed. Readiness is tied to Apple's container name, creation date and a fresh per-creation nonce label, since its ID is just its name. Configuration/image changes replace only safe idle owned containers. Normal completion uses daemon cgroup process statistics to protect background processes; missing/unknown statistics are never treated as idle.
- Apple has no Docker-equivalent pending-exec enumeration. **A crash-interrupted or unsuccessful/lost exec is conservatively retained**, even when statistics show only the idle process; later commands cannot clear that uncertainty. To unblock replacement/idle cleanup, confirm the old work can be discarded, then use `container stop --time 0 <owned-name>` (or cancel an active harness command). A confirmed stopped container can be restarted/replaced; its tmpfs repos are gone. Normal successful commands remain eligible for idle expiry. Shutdown stops cleanup timers and cancels active commands, but does not delete reusable containers. One-shots stop/delete all descendants on completion.

## Verification

Automated tests use fake Apple 1.6.1 inspect/image/status/stats responses and mocked process boundaries. They cover configuration/backend selection, native CLI arguments, offline networking, mounts, environment forwarding, restricted image builds, digest and creation identity, reuse, uncertainty, ownership, runtime-scoped cleanup, cancellation and timeout units. Docker regression tests remain enabled. These are **not proof of Apple-host operation**.

For a real Mac, run the opt-in smoke test after setup:

```sh
HARNESS_TEST_APPLE_CONTAINER=1 node --experimental-strip-types --test src/agent/sandbox-apple.live.test.ts
```

It builds a disposable image and exercises real mounts, offline networking, capabilities/no-new-privileges, read-only root, container-local repos, reuse, one-shot cleanup and whole-container cancellation. It requires package-download access for the image build and removes its containers/image afterward. If skipped, no Apple-host verification was performed. Before production use also check workspace ownership with your service user's UID/GID, image rebuilds and idle expiry using your real configuration.

## Rollback

Stop/cancel any active Apple work deliberately first, then select `mode: docker` with your prior Docker settings (normally `pidsLimit: 256`, `readOnlyRoot: false`) and build the image in Docker's separate image store. Existing Docker thread containers are not adopted by Apple or vice versa. Keep `/workspace` outputs; copy anything valuable out of Apple `/repos` before stopping it. Remove obsolete owned Apple containers manually with `container delete <name>` after stopping them, or let safe idle cleanup expire them. Do not delete lifecycle records to bypass ownership/activity checks.
