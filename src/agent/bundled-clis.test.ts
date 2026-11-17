import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { useRealSha256 } from "./fixtures/real-sha256.ts";

const root = resolve(import.meta.dirname, "../..");
const installer = join(root, "scripts/install-harness-clis.sh");
const smoke = join(root, "scripts/smoke-harness-clis.sh");

// Exercise the real shell installer offline. Downloads/extraction are fixtures;
// success tests record the verification inputs; mismatch tests use real SHA-256.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bundled-clis-"));
  const bin = join(dir, "bin");
  const trace = join(dir, "trace");
  const prefix = join(dir, "installed");
  mkdirSync(bin);
  writeFileSync(trace, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_TRACE: trace, TMPDIR: dir };
  function command(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\nprintf '%s\\n' '${name}' \"$@\" >> \"$TEST_TRACE\"\n${body}\n`, { mode: 0o755 });
  }
  command("dpkg", "printf '%s\\n' arm64");
  command("curl", `
    [ "\${TEST_FAIL_DOWNLOAD:-0}" = 0 ] || exit 22
    while [ "$1" != -o ]; do shift; done
    printf 'untrusted download' > "$2"
  `);
  command("sha256sum", `cat >> "$TEST_TRACE"; [ "\${TEST_FAIL_DIGEST:-0}" = 0 ]`);
  command("dpkg-deb", `
    mkdir -p "$3/usr/bin"
    printf 'acli fixture' > "$3/usr/bin/acli"
  `);
  command("tar", `
    [ "\${TEST_FAIL_EXTRACT:-0}" = 0 ] || exit 2
    for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
      mkdir -p "$4/linear-$target"
      for file in linear LICENSE THIRD_PARTY_LICENSES.md; do
        printf 'linear fixture' > "$4/linear-$target/$file"
      done
    done
  `);
  return {
    dir, bin, prefix, command,
    run(arch?: string, extraEnv: Record<string, string> = {}) {
      return spawnSync("sh", [installer, arch ?? "", prefix], { env: { ...env, ...extraEnv }, encoding: "utf8" });
    },
    log: () => readFileSync(trace, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const pins = [
  { arch: "amd64", target: "x86_64", acli: "92a424beb1cd187521fb0b20165e20c600cb12dbd8d06a2bfdeec50b9e62d19b", linear: "5064a63a7e6a8b5893a550e138c0a7ba373aad65d425dde6b2b66b50a6c10289" },
  { arch: "arm64", target: "aarch64", acli: "bfd6f5be1feee2de8f2f5bf817c77bed8876e0f7972dfcff29b4e94875e968f8", linear: "f6580185f3a07c558c64de44506d7ae56c13615c7d2139e5cd22ff3b03822fcd" },
];
for (const pin of pins) {
  test(`bundled CLIs: ${pin.arch} uses pinned vendor URLs/digests and installs executable files`, () => {
    const f = fixture();
    try {
      const result = f.run(pin.arch);
      assert.equal(result.status, 0, result.stderr);
      const log = f.log();
      assert.ok(log.includes(`https://acli.atlassian.com/linux/deb/pool/stable/a/ac/acli_1.3.39-stable_linux_${pin.arch}.deb`));
      assert.ok(log.includes(`https://github.com/schpet/linear-cli/releases/download/v3.0.0/linear-${pin.target}-unknown-linux-gnu.tar.xz`));
      assert.ok(log.includes(`${pin.acli}  `));
      assert.ok(log.includes(`${pin.linear}  `));
      assert.ok(log.includes("sha256sum\n--check\n--strict"));
      assert.ok(log.indexOf("sha256sum") < log.indexOf("dpkg-deb"));
      assert.ok(log.indexOf("sha256sum") < log.indexOf("tar\n"));
      assert.equal(readFileSync(join(f.prefix, "bin/acli"), "utf8"), "acli fixture");
      assert.equal(readFileSync(join(f.prefix, "bin/linear"), "utf8"), "linear fixture");
      assert.ok(existsSync(join(f.prefix, "share/doc/linear/LICENSE")));
      assert.ok(existsSync(join(f.prefix, "share/doc/linear/THIRD_PARTY_LICENSES.md")));
      assert.equal(spawnSync("test", ["-x", join(f.prefix, "bin/linear")]).status, 0);
      // Installer's temporary download paths must have been removed.
      for (const path of log.match(/\/[^\n ]+\/acli\.deb/g) ?? []) assert.ok(!existsSync(path));
    } finally { f.cleanup(); }
  });
}

test("bundled CLIs: default architecture comes from target-image dpkg, not build host", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    assert.ok(f.log().includes("dpkg\n--print-architecture"));
    assert.ok(f.log().includes("acli_1.3.39-stable_linux_arm64.deb"));
  } finally { f.cleanup(); }
});

test("bundled CLIs: unsupported architectures fail before download/install", () => {
  const f = fixture();
  try {
    const result = f.run("riscv64");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported CLI architecture/);
    assert.equal(f.log(), "");
    assert.ok(!existsSync(f.prefix));
  } finally { f.cleanup(); }
});

for (const failure of ["TEST_FAIL_DOWNLOAD", "TEST_FAIL_DIGEST", "TEST_FAIL_EXTRACT"]) {
  test(`bundled CLIs: ${failure} fails closed without installing`, () => {
    const f = fixture();
    try {
      assert.notEqual(f.run("amd64", { [failure]: "1" }).status, 0);
      assert.ok(!existsSync(f.prefix));
      for (const path of f.log().match(/\/[^\n ]+\/acli\.deb/g) ?? []) assert.ok(!existsSync(path));
    } finally { f.cleanup(); }
  });
}

test("bundled CLIs: real SHA-256 rejects substituted downloads before extraction", () => {
  const f = fixture();
  try {
    useRealSha256(f.bin);
    const result = f.run("arm64");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAILED/);
    assert.ok(!f.log().includes("dpkg-deb"));
    assert.ok(!f.log().includes("tar\n"));
    assert.ok(!existsSync(f.prefix));
  } finally { f.cleanup(); }
});

test("both Dockerfiles share the installer, preserve gh and copy global non-root CLI paths", () => {
  for (const name of ["Dockerfile.harness", "Dockerfile.sandbox"]) {
    const dockerfile = readFileSync(join(root, name), "utf8");
    assert.match(dockerfile, /FROM debian:bookworm-slim AS service-clis/);
    assert.match(dockerfile, /COPY scripts\/install-harness-clis.sh/);
    assert.match(dockerfile, /RUN sh \/tmp\/install-harness-clis.sh/);
    assert.match(dockerfile, /COPY --from=service-clis \/usr\/local\/bin\/ \/usr\/local\/bin\//);
    assert.match(dockerfile, /install -y --no-install-recommends gh/);
    assert.doesNotMatch(dockerfile, /FROM --platform=\$BUILDPLATFORM/);
    assert.doesNotMatch(dockerfile, /(?:ARG|ENV).*?(?:TOKEN|API_KEY)/);
  }
  assert.match(readFileSync(join(root, "Dockerfile.sandbox"), "utf8"), /USER sandbox/);
});

test("CLI smoke clears inherited credentials, uses disposable HOME and refuses root", () => {
  const f = fixture();
  try {
    f.command("id", "printf '1000\\n'");
    for (const cli of ["gh", "acli", "linear"]) {
      // env -i also clears TEST_TRACE: intentionally do not use command() here.
      const version = cli === "acli" ? "acli version 1.3.39-stable" : cli === "linear" ? "linear 3.0.0" : "gh version fixture";
      writeFileSync(join(f.bin, cli), `#!/bin/sh\nset -eu\n[ -z "\${GH_TOKEN:-}" ]\n[ -z "\${LINEAR_API_KEY:-}" ]\n[ -z "\${ATLASSIAN_API_TOKEN:-}" ]\n[ "$HOME" != /should-not-be-used ]\n[ "$1" = --version ] || [ "$1" = --help ] || [ "$1" = jira ] || [ "$1" = issue ] || [ "$1" = auth ]\nprintf '${version}\\n'\n`, { mode: 0o755 });
    }
    // wrangler too: it must see no inherited Cloudflare credential, report its pinned version, and be able to bundle a Worker
    // offline (`deploy --dry-run --outdir`), which the smoke script checks by looking for the output file.
    writeFileSync(join(f.bin, "wrangler"), [
      "#!/bin/sh", "set -eu",
      '[ -z "${CLOUDFLARE_API_TOKEN:-}" ]', '[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]', '[ "$HOME" != /should-not-be-used ]',
      '[ "${WRANGLER_SEND_METRICS:-}" = false ]',
      'case "$1" in',
      "  --version) printf '4.151.1\\n' ;;",
      '  deploy) case " $* " in *" --dry-run "*) while [ "$1" != --outdir ]; do shift; done; mkdir -p "$2"; printf "// bundled\\n" > "$2/index.js" ;; *" --help "*) : ;; *) exit 9 ;; esac ;;',
      "  *) : ;;",
      "esac", "",
    ].join("\n"), { mode: 0o755 });
    const env = { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, TEST_TRACE: join(f.dir, "trace"), HOME: "/should-not-be-used", GH_TOKEN: "sentinel", LINEAR_API_KEY: "sentinel", ATLASSIAN_API_TOKEN: "sentinel", CLOUDFLARE_API_TOKEN: "sentinel", CLOUDFLARE_ACCOUNT_ID: "sentinel" };
    const result = spawnSync("sh", [smoke], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Non-root gh\/acli\/linear\/wrangler smoke passed/);
    f.command("id", "printf '0\\n'");
    const rootResult = spawnSync("sh", [smoke], { env, encoding: "utf8" });
    assert.notEqual(rootResult.status, 0);
    assert.match(rootResult.stderr, /non-root user/);
  } finally { f.cleanup(); }
});
