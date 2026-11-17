import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../util/log.ts";

/**
 * The `gh` footer guard (docs/FACTORY_WORKFLOW_DESIGN.md section 21): a small shell script installed as `gh` in the operator's global
 * bin. That directory is on the PATH of every route a channel's agent runs commands through (the bash tool on the host and in the
 * container, the exec tool, shared tools) and is mounted read-only into every container, so one file covers them all. The script does
 * nothing unless the session's environment carries the footer (`footerEnv`), and then it runs the real `gh` with the footer added to
 * whatever text is being written.
 */

const SCRIPT_URL = new URL("./gh-footer-shim.sh", import.meta.url);
/** First lines of the shipped script say this; a file without it in the global bin is somebody else's `gh` and is left alone. */
export const SHIM_MARK = "# harness-managed: gh-footer-shim";

export type ShimInstall =
  | { status: "installed" | "current"; path: string }
  /** The operator keeps their own `gh` in the global bin. It is not touched, and the footer is not guaranteed in the shell. */
  | { status: "conflict" | "failed"; path: string; reason: string };

const done = new Map<string, ShimInstall>();

/** Put the script in `<globalBin>/gh`, or leave it if it is already this version. Once per process and directory. */
export function installGhShim(globalBin: string): ShimInstall {
  const known = done.get(globalBin);
  if (known && (known.status === "conflict" || known.status === "failed" || existsSync(known.path))) return known;
  const path = join(globalBin, "gh");
  try {
    const source = readFileSync(SCRIPT_URL, "utf8");
    mkdirSync(globalBin, { recursive: true });
    let result: ShimInstall;
    if (!existsSync(path)) {
      writeFileSync(path, source, { mode: 0o755 });
      result = { status: "installed", path };
    } else {
      const existing = readFileSync(path, "utf8");
      if (existing === source) result = { status: "current", path };
      else if (existing.split("\n", 3).some((line) => line.startsWith(SHIM_MARK))) {
        writeFileSync(path, source, { mode: 0o755 });
        result = { status: "installed", path };
      } else result = { status: "conflict", path, reason: `${path} is not the harness's footer guard, so it was left as it is` };
    }
    if (result.status === "installed" || result.status === "current") chmodSync(path, 0o755);
    done.set(globalBin, result);
    if (result.status === "conflict") logger.warn(`factory footer guard not installed: ${result.reason}. Comments the agent writes through gh there are not given the footer automatically.`);
    return result;
  } catch (error) {
    const result: ShimInstall = { status: "failed", path, reason: error instanceof Error ? error.message : String(error) };
    done.set(globalBin, result);
    logger.warn(`factory footer guard not installed: ${result.reason}. Comments the agent writes through gh are not given the footer automatically.`);
    return result;
  }
}

/** For tests: forget what was installed, so the next call looks at the disk again. */
export function forgetGhShim(): void { done.clear(); }
