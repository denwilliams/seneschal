import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const installer = join(root, "scripts/install-go.sh");
const smoke = join(root, "scripts/smoke-go.sh");
import { goAgentSmokeCommand } from "../cli/smoke-go-image.ts";
import { buildExecArgs, buildRunArgs } from "./sandbox.ts";
import { SandboxSchema } from "../config/schema.ts";
import { useRealSha256 } from "./fixtures/real-sha256.ts";

const version = "1.27.2";
const pins = [
  { arch: "amd64", sha: "ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5" },
  { arch: "arm64", sha: "94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8" },
];

// Run the actual installer offline, tracing downloaded/verified/extracted inputs.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bundled-go-"));
  const bin = join(dir, "bin");
  const prefix = join(dir, "installed");
  const trace = join(dir, "trace");
  mkdirSync(bin);
  writeFileSync(trace, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_TRACE: trace, TMPDIR: dir };
  function command(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\nprintf '%s\\n' '${name}' "$@" >> "$TEST_TRACE"\n${body}\n`, { mode: 0o755 });
  }
  command("dpkg", "printf '%s\\n' arm64");
  command("curl", `
    [ "\${TEST_FAIL_DOWNLOAD:-0}" = 0 ] || exit 22
    while [ "$1" != -o ]; do shift; done
    printf 'untrusted download' > "$2"
  `);
  command("sha256sum", `cat >> "$TEST_TRACE"; [ "\${TEST_FAIL_DIGEST:-0}" = 0 ]`);
  command("tar", `
    mkdir -p "$4/go/bin" "$4/go/src" "$4/go/pkg/tool"
    printf 'stdlib fixture' > "$4/go/src/fixture.go"
    printf 'license fixture' > "$4/go/LICENSE"
    printf '#!/bin/sh\\n' > "$4/go/bin/go"
    printf '#!/bin/sh\\n' > "$4/go/bin/gofmt"
    chmod 755 "$4/go/bin/go" "$4/go/bin/gofmt"
    [ "\${TEST_FAIL_EXTRACT:-0}" = 0 ] || exit 2
  `);
  return {
    dir, bin, prefix, trace, env, command,
    run(arch = "", extra: Record<string, string> = {}) {
      return spawnSync("sh", [installer, arch, prefix], { env: { ...env, ...extra }, encoding: "utf8" });
    },
    log: () => readFileSync(trace, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

for (const pin of pins) {
  test(`Go installer: ${pin.arch} pins official HTTPS URL/digest and keeps complete distribution`, () => {
    const f = fixture();
    try {
      const result = f.run(pin.arch);
      assert.equal(result.status, 0, result.stderr);
      const log = f.log();
      assert.ok(log.includes(`https://go.dev/dl/go${version}.linux-${pin.arch}.tar.gz`));
      assert.ok(log.includes("--proto\n=https\n--tlsv1.2"));
      assert.ok(log.includes(`${pin.sha}  `));
      assert.ok(log.includes("sha256sum\n--check\n--strict"));
      assert.ok(log.indexOf("sha256sum") < log.indexOf("tar\n"));
      assert.equal(spawnSync("test", ["-x", join(f.prefix, "go/bin/go")]).status, 0);
      assert.ok(existsSync(join(f.prefix, "go/src/fixture.go")));
      assert.ok(existsSync(join(f.prefix, "go/pkg/tool")));
      assert.ok(existsSync(join(f.prefix, "go/LICENSE")));
      assert.equal(readlinkSync(join(f.prefix, "bin/go")), "../go/bin/go");
      assert.equal(readlinkSync(join(f.prefix, "bin/gofmt")), "../go/bin/gofmt");
      for (const path of log.match(/\/[^\n ]+\/go\.tar\.gz/g) ?? []) assert.ok(!existsSync(path));
    } finally { f.cleanup(); }
  });
}

test("Go installer: default uses target dpkg architecture", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    assert.ok(f.log().includes("dpkg\n--print-architecture"));
    assert.ok(f.log().includes(`go${version}.linux-arm64.tar.gz`));
  } finally { f.cleanup(); }
});

test("Go installer: unsupported architectures fail before download", () => {
  const f = fixture();
  try {
    const result = f.run("riscv64");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported Go architecture/);
    assert.equal(f.log(), "");
    assert.ok(!existsSync(f.prefix));
  } finally { f.cleanup(); }
});

test("Go installer: never extracts over an existing distribution", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.prefix, "go"), { recursive: true });
    writeFileSync(join(f.prefix, "go/sentinel"), "preserve");
    const result = f.run("arm64");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destination already exists/);
    assert.equal(f.log(), "");
    assert.equal(readFileSync(join(f.prefix, "go/sentinel"), "utf8"), "preserve");
  } finally { f.cleanup(); }
});

for (const failure of ["TEST_FAIL_DOWNLOAD", "TEST_FAIL_DIGEST", "TEST_FAIL_EXTRACT"]) {
  test(`Go installer: ${failure} fails closed and cleans temporary files`, () => {
    const f = fixture();
    try {
      assert.notEqual(f.run("amd64", { [failure]: "1" }).status, 0);
      assert.ok(!existsSync(f.prefix));
      if (failure !== "TEST_FAIL_EXTRACT") assert.ok(!f.log().includes("tar\n"));
      for (const path of f.log().match(/\/[^\n ]+\/go\.tar\.gz/g) ?? []) assert.ok(!existsSync(path));
    } finally { f.cleanup(); }
  });
}

test("Go installer: real SHA-256 rejects substituted downloads before extraction", () => {
  const f = fixture();
  try {
    useRealSha256(f.bin);
    const result = f.run("arm64");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAILED/);
    assert.ok(!f.log().includes("tar\n"));
    assert.ok(!existsSync(f.prefix));
  } finally { f.cleanup(); }
});

test("both runtime Dockerfiles copy complete Go and put it on PATH without auto-downloads", () => {
  for (const name of ["Dockerfile.harness", "Dockerfile.sandbox"]) {
    const dockerfile = readFileSync(join(root, name), "utf8");
    const runtime = dockerfile.split(name === "Dockerfile.harness" ? "FROM node:${NODE_VERSION}-bookworm-slim AS runtime" : "FROM debian:bookworm-slim\n")[1]!;
    assert.match(dockerfile, /COPY scripts\/install-go.sh \/tmp\/install-go.sh\nRUN sh \/tmp\/install-go.sh/);
    assert.match(runtime, /COPY --from=service-clis \/usr\/local\/go\/ \/usr\/local\/go\//);
    assert.match(runtime, /ENV PATH=\/usr\/local\/go\/bin:\$\{PATH\} \\\n    GOTOOLCHAIN=local/);
    assert.doesNotMatch(dockerfile, /FROM --platform=\$BUILDPLATFORM/);
  }
  const workflow = readFileSync(join(root, ".github/workflows/bundled-clis.yml"), "utf8");
  assert.match(workflow, /github.event_name == 'pull_request' && '\["ubuntu-24.04"\]' \|\| '\["ubuntu-24.04","ubuntu-24.04-arm"\]'/);
  assert.match(workflow, /image: \[harness, sandbox\]/);
  assert.match(workflow, /--network none --user "\$user" --entrypoint \/bin\/sh \\\n\s+bundled-cli-smoke -s < scripts\/smoke-go.sh/);
  assert.match(workflow, /node dist\/cli\/smoke-go-image.js bundled-cli-smoke "\$user"/);
  for (const script of ["install-go.sh", "smoke-go.sh"]) {
    assert.equal(workflow.split(`- 'scripts/${script}'`).length - 1, 2);
  }
});

test("Go smoke clears inherited config, uses fresh caches, tests/builds/runs, and refuses root", () => {
  const f = fixture();
  try {
    f.command("id", "printf '1000\\n'");
    f.command("uname", "printf 'aarch64\\n'");
    // env -i clears the trace variable, so bake a temporary path into these fixtures.
    writeFileSync(join(f.bin, "go"), `#!/bin/sh
set -eu
[ -z "\${GH_TOKEN:-}" ]
[ -z "\${GOROOT:-}" ]
[ -z "\${GOFLAGS:-}" ]
[ -z "\${GOCACHE:-}" ]
[ -d "$HOME" ] && [ "$HOME" != /should-not-be-used ]
[ "$GOTOOLCHAIN" = local ] && [ "$GOPROXY" = off ] && [ "$GOSUMDB" = off ]
printf '%s\\n' "go $*" >> '${f.trace}'
case "$1" in
  version) printf 'go version go${version} linux/arm64\\n' ;;
  test) [ -f main_test.go ] && [ -f go.mod ] ;;
  build) printf '#!/bin/sh\\nprintf "bundled Go works\\\\n"\\n' > "$3"; chmod +x "$3" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(f.bin, "gofmt"), `#!/bin/sh\n[ -z "\${GH_TOKEN:-}" ] || exit 1\nprintf 'gofmt %s\\n' "$*" >> '${f.trace}'\n`, { mode: 0o755 });
    const env = { ...f.env, HOME: "/should-not-be-used", GH_TOKEN: "sentinel", GOROOT: "/bogus", GOFLAGS: "-broken", GOCACHE: "/bogus", GOTOOLCHAIN: "local" };
    const result = spawnSync("sh", [smoke], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Non-root Go version\/format\/test\/build smoke passed/);
    assert.ok(f.log().includes("go test -count=1 ./..."));
    assert.ok(f.log().includes("go build -o "));
    assert.ok(f.log().includes("gofmt -w main.go main_test.go"));
    const autoResult = spawnSync("sh", [smoke], { env: { ...env, GOTOOLCHAIN: "auto" }, encoding: "utf8" });
    assert.notEqual(autoResult.status, 0);
    assert.match(autoResult.stderr, /Image must default GOTOOLCHAIN=local/);
    f.command("id", "printf '0\\n'");
    const rootResult = spawnSync("sh", [smoke], { env, encoding: "utf8" });
    assert.notEqual(rootResult.status, 0);
    assert.match(rootResult.stderr, /non-root user/);
  } finally { f.cleanup(); }
});


test("Go image integration smoke uses both real login-shell builders without repairing PATH", () => {
  const opts = {
    config: SandboxSchema.parse({ mode: "docker", user: "sandbox", network: "none" }),
    workspace: "/data/workspace", dataDir: "/data", dockerDataDir: "/data", env: {},
    channelId: "go-smoke", threadKey: "smoke",
  };
  for (const args of [buildExecArgs(opts, "reused", goAgentSmokeCommand), buildRunArgs(opts, "throwaway", goAgentSmokeCommand)]) {
    assert.equal(args.at(-2), "-lc");
    assert.equal(args.at(-1), `export PATH="/workspace/bin:/global/bin:$PATH"\n${goAgentSmokeCommand}`);
    assert.ok(!args.includes("GOTOOLCHAIN"), "the default must come from the image, not injected env");
  }
  assert.match(goAgentSmokeCommand, /\[ "\$GOTOOLCHAIN" = local \]/);
  assert.match(goAgentSmokeCommand, /command -v go\ncommand -v gofmt/);
  assert.doesNotMatch(goAgentSmokeCommand, /export PATH|export GOROOT/);
});
