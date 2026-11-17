#!/bin/sh
# Pass via stdin to either image with --network none and a non-root user.
# No authentication or API calls: help/version must work without credentials.
set -eu
[ "$(id -u)" -ne 0 ] || { echo 'Run CLI smoke tests as a non-root user' >&2; exit 1; }
home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
trap 'exit 1' HUP INT TERM
for cli in gh acli linear; do
  command -v "$cli"
  env -i HOME="$home" PATH="$PATH" "$cli" --version
  env -i HOME="$home" PATH="$PATH" "$cli" --help >/dev/null
done
env -i HOME="$home" PATH="$PATH" acli --version | grep -Fx 'acli version 1.3.39-stable'
env -i HOME="$home" PATH="$PATH" linear --version | grep -Fx 'linear 3.0.0'
env -i HOME="$home" PATH="$PATH" acli jira workitem --help >/dev/null
env -i HOME="$home" PATH="$PATH" acli jira auth login --help >/dev/null
env -i HOME="$home" PATH="$PATH" linear issue --help >/dev/null
env -i HOME="$home" PATH="$PATH" linear auth login --help >/dev/null
# Wrangler: the pinned version, its help, and a real bundle of a trivial Worker. `--dry-run` compiles and checks
# without uploading, so it needs neither credentials nor a network, and it proves Node, esbuild and the
# platform packages all work in this image.
command -v wrangler
env -i HOME="$home" PATH="$PATH" WRANGLER_SEND_METRICS=false wrangler --version | grep -Fx '4.151.1'
env -i HOME="$home" PATH="$PATH" WRANGLER_SEND_METRICS=false wrangler deploy --help >/dev/null
env -i HOME="$home" PATH="$PATH" WRANGLER_SEND_METRICS=false wrangler rollback --help >/dev/null
worker="$home/worker"
mkdir -p "$worker/src"
printf '%s\n' 'export default { fetch() { return new Response("ok"); } };' > "$worker/src/index.js"
printf '%s\n' 'name = "smoke-worker"' 'main = "src/index.js"' 'compatibility_date = "2026-01-01"' > "$worker/wrangler.toml"
( cd "$worker" && env -i HOME="$home" PATH="$PATH" WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --outdir "$worker/out" >/dev/null )
test -s "$worker/out/index.js"
printf '%s\n' 'Non-root gh/acli/linear/wrangler smoke passed (no credentials required).'
