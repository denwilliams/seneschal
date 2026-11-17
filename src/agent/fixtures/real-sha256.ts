import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Make the fixture's PATH resolve `sha256sum` to a REAL checksum tool that understands `--check --strict`.
 *
 * Linux has GNU coreutils' `sha256sum`, so the test's recording stub is simply removed. macOS ships a BSD
 * `sha256sum` that prints usage for those flags, so a small shim over `shasum -a 256` (same check semantics,
 * same "FAILED" output) takes its place. Either way the installer is checked against a real digest, which is the
 * point of the test.
 */
export function useRealSha256(bin: string): void {
  const stub = join(bin, "sha256sum");
  rmSync(stub, { force: true });
  const probe = spawnSync("sh", ["-c", "printf x | sha256sum --check --strict 2>&1"], { env: { ...process.env, PATH: process.env.PATH }, encoding: "utf8" });
  const gnu = !/usage:/i.test(`${probe.stdout}${probe.stderr}`);
  if (!gnu) writeFileSync(stub, '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
}
