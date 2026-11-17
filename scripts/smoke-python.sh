#!/bin/sh
# Pass via stdin to either final image with --network none and its runtime user.
# Exercise the interpreter, not just its presence on disk; no extra packages needed.
set -eu
[ "$(id -u)" -ne 0 ] || { echo 'Run Python smoke tests as a non-root user' >&2; exit 1; }
command -v python3
home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
trap 'exit 1' HUP INT TERM
env -i HOME="$home" PATH="$PATH" python3 -I - <<'PY'
import sys

assert sys.version_info.major == 3, sys.version
print("Non-root Python 3 execution smoke passed (offline, no extra packages).")
PY
