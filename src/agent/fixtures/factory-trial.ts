import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A throwaway project for trying the software factory with a real model and nothing real at stake: a small git
 * repository with one genuine bug and a failing test, two issues (one clear, one hopelessly vague) and a stand-in `gh`
 * that keeps issues, labels, comments, pull requests and reviews in a JSON file. Nothing here talks to GitHub.
 */

export const TRIAL_REPO = "acme/app";

export interface TrialIssue { number: number; title: string; body: string; labels: string[] }

export const TRIAL_ISSUES: TrialIssue[] = [
  {
    number: 1,
    title: "slugify keeps capital letters",
    body: [
      "`slugify` in `src/slug.js` should lowercase its input.",
      "",
      "Steps: `slugify(\"Hello World\")`.",
      "Expected: `hello-world`. Actual: `Hello-World`.",
      "",
      "Acceptance: `npm test` passes, including the existing test in `test/slug.test.js`.",
    ].join("\n"),
    labels: ["status:triage"],
  },
  {
    number: 2,
    title: "make the app better",
    body: "it should be better and faster and nicer. please fix.",
    labels: ["status:triage"],
  },
];

/**
 * `node --test` marks its child processes with NODE_TEST_CONTEXT, and a nested `node --test` that inherits it reports
 * success without running a thing. Anything started from a test (including an agent's shell) must not see it.
 */
export function withoutNodeTestContext(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _ignored, ...rest } = env;
  return rest;
}

const run = (cwd: string, command: string, args: string[]) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface Trial {
  repo: string;
  statePath: string;
  /** Every wrangler invocation, one JSON object per line: arguments, directory, and the commit checked out at the time. */
  wranglerLog: string;
  wranglerState: string;
  /** Environment the stand-in `gh` needs; the harness's bash tool inherits it. */
  env: Record<string, string>;
}

/** Create the repository, the issue state and the `gh` stand-in inside a channel workspace. */
export function prepareTrial(workspace: string): Trial {
  const repo = join(workspace, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(repo, "src", "slug.js"), [
    "/** Turn a title into a URL slug. */",
    "export function slugify(title) {",
    "  return title.trim().replace(/[^A-Za-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(repo, "test", "slug.test.js"), [
    "import { test } from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { slugify } from \"../src/slug.js\";",
    "",
    "test(\"slugify lowercases and joins words with hyphens\", () => {",
    "  assert.equal(slugify(\"Hello World\"), \"hello-world\");",
    "});",
    "",
    "test(\"slugify trims separators from the ends\", () => {",
    "  assert.equal(slugify(\"  --a b--  \"), \"a-b\");",
    "});",
    "",
  ].join("\n"));
  // A deployable Worker, so the deployer has something real to deploy.
  writeFileSync(join(repo, "src", "worker.js"), "export default { fetch() { return new Response(\"hello\"); } };\n");
  writeFileSync(join(repo, "wrangler.toml"), [
    "name = \"app\"", "main = \"src/worker.js\"", "compatibility_date = \"2026-01-01\"", "",
    "[env.staging]", "name = \"app-staging\"", "",
    "[env.production]", "name = \"app\"", "",
  ].join("\n"));
  run(repo, "git", ["init", "-q", "-b", "main"]);
  run(repo, "git", ["config", "user.email", "factory@example.com"]);
  run(repo, "git", ["config", "user.name", "Factory Trial"]);
  run(repo, "git", ["add", "-A"]);
  run(repo, "git", ["commit", "-q", "-m", "Initial commit"]);
  // A real checkout has an origin to push branches to; a local bare repository stands in for it.
  const origin = join(workspace, ".origin.git");
  run(workspace, "git", ["init", "-q", "--bare", "-b", "main", origin]);
  run(repo, "git", ["remote", "add", "origin", origin]);
  run(repo, "git", ["push", "-q", "-u", "origin", "main"]);

  const state = join(workspace, ".gh-state.json");
  writeFileSync(state, JSON.stringify({
    labels: [],
    prs: [],
    issues: TRIAL_ISSUES.map((issue) => ({ ...issue, kind: "issues", state: "open", comments: [] })),
  }, null, 2));

  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "gh");
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "fake-gh.mjs"), shim);
  chmodSync(shim, 0o755);
  const here = dirname(fileURLToPath(import.meta.url));
  const wrangler = join(bin, "wrangler");
  copyFileSync(join(here, "fake-wrangler.mjs"), wrangler);
  chmodSync(wrangler, 0o755);
  const curl = join(bin, "curl");
  copyFileSync(join(here, "fake-curl.sh"), curl);
  chmodSync(curl, 0o755);
  const wranglerState = join(workspace, ".wrangler-state.json");
  const wranglerLog = join(workspace, ".wrangler-log.jsonl");
  writeFileSync(wranglerLog, "");
  return {
    repo, statePath: state, wranglerLog, wranglerState,
    env: {
      FAKE_GH_STATE: state, FAKE_GH_REPO: repo, FAKE_GH_NAME: TRIAL_REPO,
      FAKE_WRANGLER_STATE: wranglerState, FAKE_WRANGLER_LOG: wranglerLog,
    },
  };
}

export interface WranglerCall { argv: string[]; cwd: string; env: string | null; head: string; hasToken: boolean }

export function wranglerCalls(trial: Trial): WranglerCall[] {
  return readFileSync(trial.wranglerLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as WranglerCall);
}

/**
 * The state the deployer starts from: issue 1's fix is on a branch, its pull request was approved, and a person merged
 * it into main (and pushed). Returns the merge commit, which is what must end up deployed.
 */
export function mergeApprovedFix(trial: Trial): { sha: string; prNumber: number } {
  const git = (...args: string[]) => run(trial.repo, "git", args).trim();
  git("checkout", "-q", "-b", "fix/issue-1-slugify-lowercase");
  const file = join(trial.repo, "src", "slug.js");
  writeFileSync(file, readFileSync(file, "utf8").replace("title.trim()", "title.trim().toLowerCase()"));
  git("commit", "-qam", "Lowercase slugs (fixes #1)");
  git("push", "-q", "-u", "origin", "fix/issue-1-slugify-lowercase");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "Merge PR #3: lowercase slugs", "fix/issue-1-slugify-lowercase");
  git("push", "-q", "origin", "main");
  const sha = git("rev-parse", "HEAD");
  const state = JSON.parse(readFileSync(trial.statePath, "utf8"));
  state.prs.push({
    number: 3, kind: "pull", title: "Lowercase slugs (fixes #1)", body: "Fixes #1", head: "fix/issue-1-slugify-lowercase", base: "main",
    state: "merged", labels: [], comments: [], reviews: [{ state: "APPROVED", body: "VERDICT: APPROVED" }], mergedAt: new Date().toISOString(),
  });
  const issue = state.issues.find((i: { number: number }) => i.number === 1);
  issue.labels = issue.labels.filter((l: string) => !l.startsWith("status:")).concat("status:approved");
  writeFileSync(trial.statePath, JSON.stringify(state, null, 2));
  return { sha, prNumber: 3 };
}
