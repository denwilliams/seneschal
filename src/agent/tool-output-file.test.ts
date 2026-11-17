import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-output-publication-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const other = join(root, "other-channel");
  mkdirSync(workspace);
  mkdirSync(other);
  mkdirSync(join(workspace, "out"));
  const info = statSync(workspace, { bigint: true });
  const request = { workspace, path: "out/result.json", dev: String(info.dev), ino: String(info.ino), data: "private result\n" };
  // Mutations run inside the helper at exact syscall boundaries, not with
  // timing-dependent sleeps. No fault hooks exist in production code.
  const run = (fault = "", overrides = {}) => {
    const helper = new URL(import.meta.url.endsWith(".ts") ? "./tool-output-file.ts" : "./tool-output-file.js", import.meta.url);
    const script = `import fs from "node:fs";
      import assert from "node:assert/strict";
      import { join } from "node:path";
      import { publishToolOutput } from ${JSON.stringify(helper.href)};
      const request = JSON.parse(fs.readFileSync(0, "utf8"));
      const workspace = request.workspace;
      const other = ${JSON.stringify(other)};
      const replace = (moveOutside = false) => {
        fs.renameSync(join(workspace, "out"), join(moveOutside ? other : workspace, "moved"));
        fs.symlinkSync(other, join(workspace, "out"));
      };
      ${fault}
      try { publishToolOutput(request); process.stdout.write(JSON.stringify({ saved: true })); }
      catch (error) { process.stdout.write(JSON.stringify({ saved: false, error: error.message })); }
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      input: JSON.stringify({ ...request, ...overrides }), encoding: "utf8", env: {}, timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const assertClean = () => {
    assert.deepEqual(readdirSync(other), []);
    assert.ok(!readdirSync(workspace).some((name) => name.startsWith(".tool-output-")));
  };
  return { workspace, other, request, run, assertClean };
}

test("publisher creates nested directories and a private complete file, without changing caller cwd", (t) => {
  const f = fixture(t);
  const cwd = process.cwd();
  assert.equal(f.run("", { path: "new/deep/result.json" }).saved, true);
  assert.equal(process.cwd(), cwd);
  const path = join(f.workspace, "new/deep/result.json");
  assert.equal(readFileSync(path, "utf8"), f.request.data);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  f.assertClean();
});

for (const moveOutside of [false, true]) {
  test(`parent replaced ${moveOutside ? "and moved outside" : "with an external symlink"} during staging cannot redirect private writes`, (t) => {
    const f = fixture(t);
    const status = f.run(`const write = fs.writeFileSync;
      fs.writeFileSync = (...args) => { replace(${moveOutside}); return write(...args); };`);
    assert.equal(status.saved, false);
    assert.deepEqual(readdirSync(join(moveOutside ? f.other : f.workspace, "moved")), []);
    assert.deepEqual(readdirSync(f.other), moveOutside ? ["moved"] : []);
    assert.ok(!readdirSync(f.workspace).some((name) => name.startsWith(".tool-output-")));
  });
}

test("a parent replaced between no-follow open and chdir fails before publication", (t) => {
  const f = fixture(t);
  const status = f.run(`const chdir = process.chdir;
    process.chdir = (path) => { if (path === "out") replace(); chdir(path); };`);
  assert.equal(status.saved, false);
  assert.match(status.error, /changed/);
  assert.deepEqual(readdirSync(join(f.workspace, "moved")), []);
  f.assertClean();
});

test("retargeting an entered directory cannot redirect leaf publication or its cleanup", (t) => {
  const f = fixture(t);
  const status = f.run(`const link = fs.linkSync;
    fs.linkSync = (source, target) => {
      assert.equal(target, "result.json", "publication must use a single anchored leaf");
      replace();
      link(source, target);
      assert.equal(fs.existsSync(join(other, "result.json")), false);
      assert.equal(fs.readFileSync(join(workspace, "moved/result.json"), "utf8"), request.data);
    };`);
  assert.equal(status.saved, false);
  assert.match(status.error, /changed/);
  assert.deepEqual(readdirSync(join(f.workspace, "moved")), []);
  f.assertClean();
});

test("moving an already anchored parent outside at link is detected and cleaned up", (t) => {
  const f = fixture(t);
  const status = f.run(`const link = fs.linkSync;
    fs.linkSync = (source, target) => { replace(true); link(source, target); };`);
  assert.equal(status.saved, false);
  assert.match(status.error, /changed/);
  assert.deepEqual(readdirSync(f.other), ["moved"]);
  assert.deepEqual(readdirSync(join(f.other, "moved")), []);
  assert.ok(!readdirSync(f.workspace).some((name) => name.startsWith(".tool-output-")));
});

test("a destination raced in at link is never overwritten or removed", (t) => {
  const f = fixture(t);
  const status = f.run(`const link = fs.linkSync;
    fs.linkSync = (source, target) => { fs.writeFileSync(target, "keep"); link(source, target); };`);
  assert.equal(status.saved, false);
  assert.match(status.error, /EEXIST/);
  assert.equal(readFileSync(join(f.workspace, "out/result.json"), "utf8"), "keep");
  f.assertClean();
});

test("a destination symlink raced in at link is never followed", (t) => {
  const f = fixture(t);
  const status = f.run(`const link = fs.linkSync;
    fs.linkSync = (source, target) => { fs.symlinkSync(join(other, "leak.json"), target); link(source, target); };`);
  assert.equal(status.saved, false);
  assert.match(status.error, /EEXIST/);
  f.assertClean();
});

test("a different workspace inode is refused before staging", (t) => {
  const f = fixture(t);
  const status = f.run("", { ino: "0" });
  assert.equal(status.saved, false);
  assert.match(status.error, /changed/);
  assert.deepEqual(readdirSync(f.workspace), ["out"]);
  f.assertClean();
});

test("publisher rejects malformed relative paths before writing", (t) => {
  const f = fixture(t);
  for (const path of ["../other-channel/leak.json", "out/../leak.json", "out//leak.json", "/tmp/leak.json", ".", ""]) {
    assert.equal(f.run("", { path }).saved, false, path);
  }
  assert.deepEqual(readdirSync(f.workspace), ["out"]);
  f.assertClean();
});
