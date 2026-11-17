#!/bin/sh
# Shared by the harness/runtime and default sandbox images. Disposable build stage.
# Pins and digests: https://go.dev/dl/?mode=json (checked 2026-10-11).
set -eu

arch="${1:-$(dpkg --print-architecture)}"
prefix="${2:-/usr/local}"
go_version=1.27.2
case "$arch" in
  amd64) go_sha=ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5 ;;
  arm64) go_sha=94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8 ;;
  *) echo "Unsupported Go architecture: $arch (expected amd64 or arm64)" >&2; exit 1 ;;
esac
# Never unpack on top of an existing toolchain (upstream installation guidance).
[ ! -e "$prefix/go" ] && [ ! -L "$prefix/go" ] || {
  echo "Go destination already exists: $prefix/go" >&2; exit 1;
}
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location --retry 3 \
  "https://go.dev/dl/go${go_version}.linux-${arch}.tar.gz" -o "$work/go.tar.gz"
printf '%s  %s\n' "$go_sha" "$work/go.tar.gz" | sha256sum --check --strict
# Keep the complete distribution: compiler/linker tools, stdlib source, licenses.
# Extract to temporary storage first so failed extraction cannot install a partial Go.
tar -xzf "$work/go.tar.gz" -C "$work"
install -d "$prefix"
mv "$work/go" "$prefix/go"
# Debian login shells reset PATH but preserve /usr/local/bin. Keep image-owned
# links here so actual agent bash -lc commands can find Go after /etc/profile.
install -d "$prefix/bin"
ln -s ../go/bin/go "$prefix/bin/go"
ln -s ../go/bin/gofmt "$prefix/bin/gofmt"
