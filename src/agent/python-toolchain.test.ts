import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const smoke = join(root, "scripts/smoke-python.sh");

// Inspect final runtime stages: Python in a builder alone is not sufficient.
test("both final Docker images install Python 3 alongside the existing Go toolchain", () => {
  for (const name of ["Dockerfile.harness", "Dockerfile.sandbox"]) {
    const runtime = readFileSync(join(root, name), "utf8").split(/^FROM .*$/m).at(-1)!;
    assert.match(runtime, /apt-get install -y --no-install-recommends \\\n\s+[^\n]*\bpython3\b/);
    assert.match(runtime, /COPY --from=service-clis \/usr\/local\/go\/ \/usr\/local\/go\//);
  }
});

test("final-image CI runs Python and Go offline as each image's normal non-root user", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/bundled-clis.yml"), "utf8"));
  for (const event of ["pull_request", "push"]) {
    assert.ok(workflow.on[event].paths.includes("scripts/smoke-python.sh"));
    assert.ok(workflow.on[event].paths.includes("src/agent/python-toolchain.test.ts"));
  }
  assert.deepEqual(workflow.jobs.smoke.strategy.matrix.image, ["harness", "sandbox"]);
  const step = workflow.jobs.smoke.steps.find((step: { name?: string }) => step.name?.startsWith("Smoke as non-root"));
  assert.match(step.run, /user=sandbox/);
  assert.match(step.run, /if \[ '\$\{\{ matrix.image \}\}' = harness \]; then user=node; fi/);
  for (const language of ["python", "go"]) {
    assert.ok(step.run.includes(`docker run --rm -i --network none --user "$user" --entrypoint /bin/sh \\\n  bundled-cli-smoke -s < scripts/smoke-${language}.sh`));
  }
});

test("Python smoke clears inherited configuration, executes stdin, propagates errors and refuses root", () => {
  const dir = mkdtempSync(join(tmpdir(), "python-smoke-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: "/should-not-be-used", PYTHONPATH: "/bogus", GH_TOKEN: "sentinel" };
  try {
    writeFileSync(join(bin, "id"), "#!/bin/sh\nprintf '1000\\n'\n", { mode: 0o755 });
    writeFileSync(join(bin, "python3"), `#!/bin/sh
set -eu
[ -z "\${GH_TOKEN:-}" ] && [ -z "\${PYTHONPATH:-}" ]
[ "$HOME" != /should-not-be-used ] && [ -d "$HOME" ]
[ "$#" = 2 ] && [ "$1" = -I ] && [ "$2" = - ]
cat
`, { mode: 0o755 });
    const result = spawnSync("sh", [smoke], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /assert sys.version_info.major == 3/);
    writeFileSync(join(bin, "python3"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    assert.equal(spawnSync("sh", [smoke], { env }).status, 42);
    writeFileSync(join(bin, "id"), "#!/bin/sh\nprintf '0\\n'\n", { mode: 0o755 });
    const asRoot = spawnSync("sh", [smoke], { env, encoding: "utf8" });
    assert.notEqual(asRoot.status, 0);
    assert.match(asRoot.stderr, /non-root user/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python smoke executes with a real Python 3 interpreter", (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) return t.skip("Python 3 is not installed on this test host");
  const dir = mkdtempSync(join(tmpdir(), "python-real-smoke-"));
  try {
    // The CI host may be root; the image job separately checks the actual runtime UID.
    writeFileSync(join(dir, "id"), "#!/bin/sh\nprintf '1000\\n'\n", { mode: 0o755 });
    const result = spawnSync("sh", [smoke], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Non-root Python 3 execution smoke passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
