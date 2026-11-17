import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildConsole2, isUpToDate, needsInstall, type Run } from "./build-console2.ts";

function app() {
  const root = mkdtempSync(join(tmpdir(), "console2-build-"));
  const appDir = join(root, "web", "console2");
  const apiTypes = join(root, "src", "console2", "api-types.ts");
  mkdirSync(join(appDir, "src"), { recursive: true });
  mkdirSync(join(root, "src", "console2"), { recursive: true });
  writeFileSync(join(appDir, "package.json"), "{}");
  writeFileSync(join(appDir, "package-lock.json"), "{}");
  writeFileSync(join(appDir, "src", "App.tsx"), "x");
  writeFileSync(apiTypes, "export {};");
  const at = (path: string, secondsAgo: number) => { const t = new Date(Date.now() - secondsAgo * 1000); utimesSync(path, t, t); };
  const install = () => { mkdirSync(join(appDir, "node_modules"), { recursive: true }); writeFileSync(join(appDir, "node_modules", ".package-lock.json"), "{}"); };
  const build = () => { mkdirSync(join(appDir, "dist"), { recursive: true }); writeFileSync(join(appDir, "dist", "index.html"), "<html>"); };
  return { root, appDir, apiTypes, at, install, build, done: () => rmSync(root, { recursive: true, force: true }) };
}

const recorder = (statuses: Record<string, number> = {}) => {
  const calls: string[] = [];
  const run: Run = (command, args) => { const key = `${command} ${args[0]}`; calls.push(key); return statuses[key] ?? 0; };
  return { calls, run };
};

test("nothing to do where web/console2 is not present (the image's compile stage)", () => {
  const f = app();
  rmSync(join(f.appDir, "package.json"));
  const { calls, run } = recorder();
  assert.equal(buildConsole2({ appDir: f.appDir, apiTypes: f.apiTypes, run }), "missing");
  assert.deepEqual(calls, []);
  f.done();
});

test("SKIP_CONSOLE2_BUILD=1 skips everything", () => {
  const f = app();
  const { calls, run } = recorder();
  assert.equal(buildConsole2({ appDir: f.appDir, apiTypes: f.apiTypes, run, env: { SKIP_CONSOLE2_BUILD: "1" } }), "skipped");
  assert.deepEqual(calls, []);
  f.done();
});

test("a fresh checkout installs its dependencies, then builds", () => {
  const f = app();
  const { calls, run } = recorder();
  assert.equal(buildConsole2({ appDir: f.appDir, apiTypes: f.apiTypes, run }), "built");
  assert.deepEqual(calls, ["npm ci", "npm run"]);
  f.done();
});

test("installed dependencies are not reinstalled; a stale build is rebuilt", () => {
  const f = app();
  f.install(); f.build();
  f.at(join(f.appDir, "dist", "index.html"), 100);
  f.at(join(f.appDir, "src", "App.tsx"), 10); // edited after the last build
  const { calls, run } = recorder();
  assert.equal(buildConsole2({ appDir: f.appDir, apiTypes: f.apiTypes, run }), "built");
  assert.deepEqual(calls, ["npm run"]);
  f.done();
});

test("an up-to-date build is left alone", () => {
  const f = app();
  f.install(); f.build();
  for (const path of [join(f.appDir, "package.json"), join(f.appDir, "package-lock.json"), join(f.appDir, "src", "App.tsx"), f.apiTypes, join(f.appDir, "node_modules", ".package-lock.json")]) f.at(path, 100);
  const { calls, run } = recorder();
  assert.equal(buildConsole2({ appDir: f.appDir, apiTypes: f.apiTypes, run }), "up-to-date");
  assert.deepEqual(calls, []);
  f.done();
});

test("a change to the API types the app imports triggers a rebuild", () => {
  const f = app();
  f.install(); f.build();
  for (const path of [join(f.appDir, "package.json"), join(f.appDir, "package-lock.json"), join(f.appDir, "src", "App.tsx"), join(f.appDir, "node_modules", ".package-lock.json")]) f.at(path, 100);
  f.at(join(f.appDir, "dist", "index.html"), 50);
  assert.equal(isUpToDate(f.appDir, f.apiTypes), false, "api-types.ts was written just now");
  f.at(f.apiTypes, 200);
  assert.equal(isUpToDate(f.appDir, f.apiTypes), true);
  f.done();
});

test("tests, build output and the mock do not count as inputs", () => {
  const f = app();
  f.build();
  for (const path of [join(f.appDir, "package.json"), join(f.appDir, "package-lock.json"), join(f.appDir, "src", "App.tsx"), f.apiTypes]) f.at(path, 100);
  f.at(join(f.appDir, "dist", "index.html"), 50);
  writeFileSync(join(f.appDir, "src", "thing.test.ts"), "x");
  mkdirSync(join(f.appDir, "mock")); writeFileSync(join(f.appDir, "mock", "server.mjs"), "x");
  mkdirSync(join(f.appDir, "e2e")); writeFileSync(join(f.appDir, "e2e", "smoke.spec.ts"), "x");
  assert.equal(isUpToDate(f.appDir, f.apiTypes), true);
  f.done();
});

test("a lockfile newer than the installed dependencies means reinstall", () => {
  const f = app();
  f.install();
  f.at(join(f.appDir, "node_modules", ".package-lock.json"), 100);
  f.at(join(f.appDir, "package-lock.json"), 10);
  assert.equal(needsInstall(f.appDir), true);
  f.at(join(f.appDir, "package-lock.json"), 200);
  assert.equal(needsInstall(f.appDir), false);
  f.done();
});

test("a failed install or build is reported, never thrown, and a failed install does not try to build", () => {
  const f = app();
  const lines: string[] = [];
  const noInstall = recorder({ "npm ci": 1 });
  assert.equal(buildConsole2({ appDir: f.appDir, apiTypes: f.apiTypes, run: noInstall.run, log: (l) => lines.push(l) }), "failed");
  assert.deepEqual(noInstall.calls, ["npm ci"]);
  assert.match(lines.join("\n"), /could not install/);
  const badBuild = recorder({ "npm run": 2 });
  f.install();
  assert.equal(buildConsole2({ appDir: f.appDir, apiTypes: f.apiTypes, run: badBuild.run, log: (l) => lines.push(l) }), "failed");
  assert.match(lines.join("\n"), /build failed/);
  f.done();
});
