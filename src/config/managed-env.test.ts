import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { loadManagedEnvironment, SecretAdmin } from "./managed-env.ts";

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "managed-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "env.json") };
}
test("write-only atomic store, explicit overwrites, restart precedence and fresh-process startup", (t) => {
  const { file } = setup(t);
  const inherited = { EXAMPLE_KEY: "inherited-sensitive", PATH: "/private/path" };
  const admin = new SecretAdmin(file, undefined, inherited);
  assert.throws(() => admin.save("EXAMPLE_KEY", "new-sensitive", false), /confirm replacement/);
  const secret = 'new-sensitive\nquotes: " \\ dollar: ${NOT_EXPANDED}';
  admin.save("EXAMPLE_KEY", secret, true);
  admin.save("SECOND_KEY", "second-sensitive", false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).EXAMPLE_KEY, secret);
  assert.equal(inherited.EXAMPLE_KEY, "inherited-sensitive");
  const snapshot = admin.snapshot();
  assert.ok(!JSON.stringify(snapshot).includes("sensitive"));
  assert.deepEqual(snapshot.variables.find((v) => v.name === "EXAMPLE_KEY"), { name: "EXAMPLE_KEY", set: true, source: "managed", pendingRestart: true, protected: false });
  assert.ok(snapshot.variables.find((v) => v.name === "PATH")?.protected);
  const freshEnv = { ...inherited };
  loadManagedEnvironment(file, freshEnv);
  assert.equal(freshEnv.EXAMPLE_KEY, secret);
  assert.ok(new SecretAdmin(file, undefined, freshEnv).snapshot().variables.every((v) => !v.pendingRestart));
  // A genuinely fresh Node process loads before both import-time consumers and config expansion.
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    await import('./src/config/managed-env-bootstrap.ts');
    const { parseConfigText } = await import('./src/config/load.ts');
    const { readFileSync } = await import('node:fs');
    const expected = JSON.parse(readFileSync(process.env.HARNESS_MANAGED_ENV_FILE, 'utf8'));
    if (process.env.EXAMPLE_KEY !== expected.EXAMPLE_KEY || parseConfigText('name: \\u0024{SECOND_KEY}').name !== expected.SECOND_KEY) process.exit(3);
  `], { cwd: process.cwd(), env: { ...process.env, HARNESS_MANAGED_ENV_FILE: file, EXAMPLE_KEY: "old-value" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});
test("protected names and invalid input never write or leak submitted data", (t) => {
  const { file } = setup(t);
  const admin = new SecretAdmin(file, undefined, {});
  for (const name of ["HARNESS_MANAGED_ENV_FILE", "HARNESS_ALLOW_RESTART", "NODE_OPTIONS", "PATH", "LD_PRELOAD", "GIT_CONFIG_COUNT", "BASH_ENV", "HTTP_PROXY", "bad-name", "__proto__", "secret-value\n"]) {
    assert.throws(() => admin.save(name, "submitted-secret", false), (e: Error) => !e.message.includes("submitted-secret") && !e.message.includes(name));
  }
  for (const value of ["", "nul\0secret", "x".repeat(16385)]) assert.throws(() => admin.save("EXAMPLE_KEY", value, false));
  assert.throws(() => new SecretAdmin().save("EXAMPLE_KEY", "secret", false), /not enabled/);
  assert.throws(() => admin.assertOutsideData(join(file, "..")), /unavailable/);
});
test("private storage: malformed/oversize files, symlinks, hard links and permissions fail closed", (t) => {
  const { dir, file } = setup(t);
  const admin = new SecretAdmin(file, undefined, {});
  for (const text of ['{"EXAMPLE_KEY": "secret", broken}', '{"NODE_OPTIONS":"secret"}', '{"EXAMPLE_KEY":2}', '[]', 'x'.repeat(1024 * 1024 + 1)]) {
    writeFileSync(file, text, { mode: 0o600 });
    assert.throws(() => admin.snapshot(), (e: Error) => /storage is unavailable/.test(e.message) && !e.message.includes("secret"));
    assert.throws(() => loadManagedEnvironment(file, {}), /unavailable/);
  }
  writeFileSync(file, '{}'); chmodSync(file, 0o644);
  assert.throws(() => admin.save("EXAMPLE_KEY", "secret", false), /unavailable/);
  chmodSync(file, 0o600);
  const other = join(dir, "other"); linkSync(file, other);
  assert.throws(() => admin.snapshot(), /unavailable/); rmSync(other); rmSync(file);
  symlinkSync(other, file);
  assert.ok(lstatSync(file).isSymbolicLink());
  assert.throws(() => admin.snapshot(), /unavailable/);
  // Node 24.13.0 on Linux can leave dangling symlinks behind after rmSync.
  // Unlink the entry itself so the later directory fixture starts with an absent path.
  unlinkSync(file);
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  const linked = join(dir, "linked"); symlinkSync(dir, linked);
  assert.throws(() => new SecretAdmin(join(linked, "env.json")).snapshot(), /unavailable/);
  chmodSync(dir, 0o755);
  assert.throws(() => admin.snapshot(), /unavailable/);
  chmodSync(dir, 0o700);
  mkdirSync(file, { mode: 0o700 });
  assert.throws(() => admin.snapshot(), /unavailable/);
});
test("private storage is refused inside data reached through symlink aliases", (t) => {
  const { dir, file } = setup(t);
  const alias = join(dir, "data-alias");
  symlinkSync(dir, alias);
  assert.throws(() => new SecretAdmin(file).assertOutsideData(alias), /unavailable/);
  assert.throws(() => new SecretAdmin(join(dir, "new", "env.json")).assertOutsideData(join(alias, "new")), /unavailable/);
  new SecretAdmin(file).assertOutsideData(join(dir, "separate-data"));
  assert.throws(() => new SecretAdmin(file).assertOutsideData("/"), /unavailable/);
});
test("restart is opt-in, reserved once, deferred, and recovers from synchronous failure", () => {
  assert.throws(() => new SecretAdmin().prepareRestart(), /unavailable/);
  let called = 0;
  const admin = new SecretAdmin(undefined, () => { called++; }, {});
  const begin = admin.prepareRestart();
  assert.equal(called, 0);
  assert.ok(admin.snapshot().restart.pending);
  assert.throws(() => admin.prepareRestart(), /already requested/);
  begin(); begin(); assert.equal(called, 1);
  const failure = new SecretAdmin(undefined, () => { throw new Error("sensitive error"); }, {});
  failure.prepareRestart()();
  assert.equal(failure.snapshot().restart.pending, false);
});
