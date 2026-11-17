import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build webConsole2 (`web/console2/`) as part of `npm run build`, through the `postbuild` hook, so `npm start` (which runs
 * the build first) always serves a console that matches the code.
 *
 * It is a separate toolchain (Vite, React, shadcn), so this installs its dependencies on first use and skips the build when
 * nothing has changed since the last one. It never stops the harness from starting: the console is optional, and a machine
 * with no network that cannot install it still has a working harness. In that case it says so, and `/console2/` answers 503
 * saying it is not built. Set `CONSOLE2_BUILD_STRICT=1` to make a failure fatal (for CI), or `SKIP_CONSOLE2_BUILD=1` to skip.
 *
 * Where `web/console2` is not present (the harness image's compile stage copies only `src`; the app has its own stage) it
 * does nothing.
 */

export type BuildOutcome = "missing" | "skipped" | "up-to-date" | "built" | "failed";

/** Runs a command and returns its exit status. Injected so tests need no npm. */
export type Run = (command: string, args: string[], cwd: string) => number;

const IGNORED = new Set(["node_modules", "dist", "test-results", "playwright-report", "e2e", "e2e-real", "mock", ".git"]);

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.name.endsWith(".test.ts")) continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** Whether `dist` is newer than every file the build reads: the app's sources and configs, and the API types it imports. */
export function isUpToDate(appDir: string, apiTypes: string): boolean {
  const built = join(appDir, "dist", "index.html");
  if (!existsSync(built)) return false;
  const inputs = Math.max(newestMtime(appDir), existsSync(apiTypes) ? statSync(apiTypes).mtimeMs : 0);
  return statSync(built).mtimeMs >= inputs;
}

/** Dependencies are missing, or the lockfile changed since they were installed. */
export function needsInstall(appDir: string): boolean {
  const installed = join(appDir, "node_modules", ".package-lock.json");
  if (!existsSync(installed)) return true;
  const lock = join(appDir, "package-lock.json");
  return existsSync(lock) && statSync(lock).mtimeMs > statSync(installed).mtimeMs;
}

export function buildConsole2(input: { appDir: string; apiTypes: string; run: Run; env?: Record<string, string | undefined>; log?: (line: string) => void }): BuildOutcome {
  const log = input.log ?? (() => {});
  const env = input.env ?? {};
  if (!existsSync(join(input.appDir, "package.json"))) {
    log("console2: web/console2 is not here; nothing to build.");
    return "missing";
  }
  if (env.SKIP_CONSOLE2_BUILD === "1") {
    log("console2: skipped (SKIP_CONSOLE2_BUILD=1).");
    return "skipped";
  }
  if (!needsInstall(input.appDir) && isUpToDate(input.appDir, input.apiTypes)) {
    log("console2: up to date.");
    return "up-to-date";
  }
  if (needsInstall(input.appDir)) {
    log("console2: installing dependencies…");
    if (input.run("npm", ["ci", "--no-audit", "--no-fund"], input.appDir) !== 0) {
      log("console2: could not install its dependencies, so the web console was not built.");
      return "failed";
    }
  }
  log("console2: building…");
  if (input.run("npm", ["run", "build"], input.appDir) !== 0) {
    log("console2: the build failed, so the web console was not rebuilt.");
    return "failed";
  }
  log("console2: built.");
  return "built";
}

const run: Run = (command, args, cwd) => {
  const result = spawnSync(process.platform === "win32" && command === "npm" ? "npm.cmd" : command, args, { cwd, stdio: "inherit" });
  return result.status ?? 1;
};

// Run as a script (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outcome = buildConsole2({
    appDir: join(root, "web", "console2"), apiTypes: join(root, "src", "console2", "api-types.ts"),
    run, env: process.env, log: (line) => console.log(line),
  });
  if (outcome === "failed") {
    console.warn("console2: the harness itself is unaffected. Run `npm run console2:build` to see the error; `/console2/` answers 503 until it is built.");
    if (process.env.CONSOLE2_BUILD_STRICT === "1") process.exit(1);
  }
}
