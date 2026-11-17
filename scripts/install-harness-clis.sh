#!/bin/sh
# Shared by both Dockerfiles. Run in a disposable Debian Bookworm build stage.
# No vendor install scripts, credentials, or unversioned URLs are used.
set -eu

arch="${1:-$(dpkg --print-architecture)}"
prefix="${2:-/usr/local}"
acli_version=1.3.39
linear_version=3.0.0
case "$arch" in
  amd64)
    linear_target=x86_64-unknown-linux-gnu
    acli_sha=92a424beb1cd187521fb0b20165e20c600cb12dbd8d06a2bfdeec50b9e62d19b
    linear_sha=5064a63a7e6a8b5893a550e138c0a7ba373aad65d425dde6b2b66b50a6c10289
    ;;
  arm64)
    linear_target=aarch64-unknown-linux-gnu
    acli_sha=bfd6f5be1feee2de8f2f5bf817c77bed8876e0f7972dfcff29b4e94875e968f8
    linear_sha=f6580185f3a07c558c64de44506d7ae56c13615c7d2139e5cd22ff3b03822fcd
    ;;
  *) echo "Unsupported CLI architecture: $arch (expected amd64 or arm64)" >&2; exit 1 ;;
esac

# Trap cleanup on download, digest, or extraction failure as well as success.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location --retry 3 \
  "https://acli.atlassian.com/linux/deb/pool/stable/a/ac/acli_${acli_version}-stable_linux_${arch}.deb" \
  -o "$work/acli.deb"
curl --proto '=https' --tlsv1.2 --fail --show-error --silent --location --retry 3 \
  "https://github.com/schpet/linear-cli/releases/download/v${linear_version}/linear-${linear_target}.tar.xz" \
  -o "$work/linear.tar.xz"
# Check both downloads before extracting or installing either executable.
printf '%s  %s\n' "$acli_sha" "$work/acli.deb" "$linear_sha" "$work/linear.tar.xz" \
  | sha256sum --check --strict

dpkg-deb --extract "$work/acli.deb" "$work/acli"
tar -xJf "$work/linear.tar.xz" -C "$work"
install -d "$prefix/bin" "$prefix/share/doc/linear"
install -m 0755 "$work/acli/usr/bin/acli" "$prefix/bin/acli"
install -m 0755 "$work/linear-${linear_target}/linear" "$prefix/bin/linear"
install -m 0644 "$work/linear-${linear_target}/LICENSE" \
  "$work/linear-${linear_target}/THIRD_PARTY_LICENSES.md" "$prefix/share/doc/linear/"
