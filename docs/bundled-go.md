# Bundled Go toolchain

`Dockerfile.harness` (host-mode bash / explicitly allowed `exec`) and
`Dockerfile.sandbox` (default Docker-mode bash) ship **Go 1.27.2** for Linux
**amd64 and arm64**. The complete official distribution lives in `/usr/local/go`;
`/usr/local/go/bin` is on the image's PATH, so `go` and `gofmt` work as the
non-root `node` / `sandbox` users without shell-profile setup. Image-owned
`/usr/local/bin/go` and `/usr/local/bin/gofmt` symlinks also survive Debian
login-shell PATH resets: Docker agent commands use `bash -lc` and then put
`/workspace/bin` first. The links preserve full-toolchain GOROOT discovery. The Node build
stage does not need Go. The purpose-specific `Dockerfile.home-assistant` remains
unchanged; custom channel images must supply their own development tooling.

## Version and integrity

We selected the latest stable Go release listed in the
[official download metadata](https://go.dev/dl/?mode=json), checked **2026-10-11**.
Like the bundled service CLIs, the shared `scripts/install-go.sh` pins a version
and per-architecture SHA-256 digests, verifies before extraction, and rejects
unsupported architectures before download. It selects the **target image's**
`dpkg --print-architecture`, including under buildx emulation, not the host CPU.
Downloads use versioned HTTPS URLs, not `latest` or a vendor installer script.

| Archive | SHA-256 |
| --- | --- |
| `go1.27.2.linux-amd64.tar.gz` | `ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5` |
| `go1.27.2.linux-arm64.tar.gz` | `94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8` |

The full toolchain, standard-library sources, and license remain in runtime;
download archives and installer utilities stay in a disposable build stage.
Following [upstream installation guidance](https://go.dev/doc/install), the
installer refuses to overlay an existing Go tree. These are upstream integrity
pins, not independently verified signatures or a reproducible-build claim.

To upgrade, change the version and **both** digests in `install-go.sh`, verify
against upstream metadata and downloaded archives, update this document and
version assertions in `smoke-go.sh` / `src/agent/go-toolchain.test.ts`, then run
`npm test`, `npm run typecheck`, `npm run build` and all four Docker smoke jobs.
Do not add arbitrary version/checksum build-argument overrides.

## Runtime behavior and limits

Images default to `GOTOOLCHAIN=local`: ordinary builds/tests use the installed
compiler without silently fetching another toolchain. A project requiring a
newer Go version fails clearly; upgrade the image or explicitly opt in to
`GOTOOLCHAIN=auto` through the existing runtime environment mechanism. Projects
may still download their **module dependencies** when network access is allowed;
those are distinct from toolchain downloads. No module or build cache is seeded
in the image.

Pure-Go builds/tests work out of the box. A C compiler, headers, and native
libraries are **not** added: projects using cgo need a suitable custom image.
Go's build/module caches and default `$HOME/go/bin` are writable user-owned
paths, not part of the installed toolchain. If using `go install`, prepend
`$(go env GOPATH)/bin` to your shell PATH to run installed third-party commands.
For read-only-root sandboxes or overridden users/HOME, configure a writable
HOME/cache (for example inside that channel's private workspace). Container-local
caches disappear on container replacement unless deliberately kept in workspace.
Installing Go does not enable bash/exec, expand command allowlists, inject secrets,
or change workspace/repository isolation.

## Verification

On a Docker host, build both images and run a non-root smoke without network:

```sh
docker build -f Dockerfile.harness -t harness-go-smoke .
docker run --rm -i --network none --user node --entrypoint /bin/sh \
  harness-go-smoke -s < scripts/smoke-go.sh

docker build -f Dockerfile.sandbox -t sandbox-go-smoke .
docker run --rm -i --network none --user sandbox --entrypoint /bin/sh \
  sandbox-go-smoke -s < scripts/smoke-go.sh

# Cover the actual reused + throwaway Docker agent bash -lc command builders:
npm ci && npm run build
node dist/cli/smoke-go-image.js harness-go-smoke node
node dist/cli/smoke-go-image.js sandbox-go-smoke sandbox
```

`smoke-go.sh` first checks that the image defaults to `GOTOOLCHAIN=local`
before explicitly configuring its hermetic helper. It verifies the exact
version and native architecture, formats a tiny
standard-library program, runs its test, builds it, and executes the binary.
It uses a disposable HOME with fresh caches, clears inherited environment/config,
sets `GOTOOLCHAIN=local`, `GOPROXY=off`, `GOSUMDB=off`, and tests pure Go with
`CGO_ENABLED=0`. No forced GOROOT masks errors in runtime copying/discovery.
The existing `.github/workflows/bundled-clis.yml` runs both service CLI and Go
smokes on native amd64/arm64 runners for both images (four jobs). Each job
also calls `smoke-go-image`: it uses the actual `buildCreateArgs`/`buildExecArgs`
and `buildRunArgs` implementations to execute both reused and throwaway
non-root, network-none login-shell paths. It checks the untouched image
`GOTOOLCHAIN` default and workspace-bin precedence, then performs the complete
fresh-cache Go smoke without a PATH/GOROOT repair. Temporary containers and
workspace files are cleaned up. It does not
publish images or deploy anything.

Offline Node regressions exercise the real shell installer with download fixtures
for both architectures, failures and cleanup, checksum rejection, existing-tree
protection, Docker/CI wiring, and smoke environment/commands. These do not replace
real Docker smoke tests.

Without Docker, a native binary-only check is possible as non-root:

```sh
sh scripts/install-go.sh "$(dpkg --print-architecture)" /tmp/go-check
PATH=/tmp/go-check/bin:$PATH GOTOOLCHAIN=local sh scripts/smoke-go.sh
```

That verifies downloads/native execution, not final image wiring. Installation
only takes effect in **rebuilt images and new/recreated containers**; it does not
modify existing sandboxes or the running harness.
