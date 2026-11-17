#!/bin/sh
# Pass via stdin to either image with --network none and a non-root user.
# Proves the installed toolchain works without module/toolchain downloads.
set -eu
[ "${GOTOOLCHAIN:-}" = local ] || { echo 'Image must default GOTOOLCHAIN=local' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo 'Run Go smoke tests as a non-root user' >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$work/home"
command -v go
command -v gofmt
# Use a fresh HOME (including empty build/module caches) and discard inherited config.
# No forced GOROOT: go must discover the copied distribution itself.
run_go() {
  env -i HOME="$work/home" PATH="$PATH" GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off CGO_ENABLED=0 go "$@"
}
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Unsupported Go smoke architecture' >&2; exit 1 ;;
esac
run_go version | grep -Fx "go version go1.27.2 linux/$arch"
cd "$work"
cat > go.mod <<'MOD'
module harness.example/smoke

go 1.27.2
MOD
cat > main.go <<'GO'
package main

import "fmt"

func greeting() string { return "bundled Go works" }
func main() { fmt.Println(greeting()) }
GO
cat > main_test.go <<'GO'
package main

import "testing"

func TestGreeting(t *testing.T) {
	if got := greeting(); got != "bundled Go works" {
		t.Fatalf("unexpected greeting: %q", got)
	}
}
GO
env -i HOME="$work/home" PATH="$PATH" gofmt -w main.go main_test.go
run_go test -count=1 ./...
run_go build -o "$work/go-smoke" .
"$work/go-smoke" | grep -Fx 'bundled Go works'
printf '%s\n' 'Non-root Go version/format/test/build smoke passed (offline, fresh caches).'
