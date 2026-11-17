import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeApprovedFix, prepareTrial, withoutNodeTestContext, wranglerCalls } from "./factory-trial.ts";

/** The trial environment itself must be right, or a live run would blame the model for the fixture's mistakes. */
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "trial-"));
  const trial = prepareTrial(workspace);
  const wrangler = (...args: string[]) => execFileSync(join(workspace, "bin", "wrangler"), args, { encoding: "utf8", cwd: trial.repo, env: { ...withoutNodeTestContext(), ...trial.env, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" } });
  const gh = (...args: string[]) => execFileSync(join(workspace, "bin", "gh"), args, { encoding: "utf8", env: { ...withoutNodeTestContext(), ...trial.env } });
  const git = (...args: string[]) => execFileSync("git", ["-C", trial.repo, ...args], { encoding: "utf8" });
  return { workspace, trial, gh, git, wrangler };
}

test("the repository really has the bug: the suite fails on main", () => {
  const { trial } = setup();
  assert.throws(() => execFileSync("npm", ["test", "--silent"], { cwd: trial.repo, stdio: "pipe", env: withoutNodeTestContext() }), "a failing test is the bug report");
});

test("issues can be listed, filtered by label, searched, viewed, labelled and commented on", () => {
  const { gh } = setup();
  const listed = JSON.parse(gh("issue", "list", "--repo", "acme/app", "--label", "status:triage", "--json", "number,title,labels"));
  assert.deepEqual(listed.map((i: { number: number }) => i.number), [1, 2]);
  assert.deepEqual(listed[0].labels, [{ name: "status:triage" }]);
  assert.deepEqual(JSON.parse(gh("issue", "list", "--search", "slugify", "--json", "number")).map((i: { number: number }) => i.number), [1]);
  assert.match(gh("issue", "view", "1", "--comments"), /Expected: `hello-world`/);

  gh("label", "create", "status:ready", "--color", "0e8a16");
  gh("issue", "edit", "1", "--add-label", "status:ready,type:bug,priority:p1", "--remove-label", "status:triage");
  gh("issue", "comment", "1", "--body", "Ready to build.");
  const one = JSON.parse(gh("issue", "view", "1", "--json", "number,labels,comments"));
  assert.deepEqual(one.labels.map((l: { name: string }) => l.name).sort(), ["priority:p1", "status:ready", "type:bug"]);
  assert.equal(one.comments[0].body, "Ready to build.");
  assert.deepEqual(JSON.parse(gh("issue", "list", "--label", "status:triage", "--json", "number")).map((i: { number: number }) => i.number), [2]);
});

test("a pull request is the branch against main: it can be created, viewed, diffed, reviewed and commented on", () => {
  const { trial, gh, git } = setup();
  git("checkout", "-q", "-b", "fix/1");
  writeFileSync(join(trial.repo, "src", "slug.js"), readFileSync(join(trial.repo, "src", "slug.js"), "utf8").replace("title.trim()", "title.trim().toLowerCase()"));
  git("commit", "-qam", "Lowercase slugs");
  const url = gh("pr", "create", "--title", "Lowercase slugs (fixes #1)", "--body", "Fixes #1").trim();
  assert.match(url, /^https:\/\/github\.example\/acme\/app\/pull\/\d+$/);
  const number = url.split("/").at(-1)!;
  assert.match(gh("pr", "diff", number), /\+\s+return title\.trim\(\)\.toLowerCase\(\)/);
  assert.equal(JSON.parse(gh("pr", "view", number, "--json", "headRefName,title")).headRefName, "fix/1");
  git("push", "-q", "-u", "origin", "fix/1");
  assert.match(git("ls-remote", "--heads", "origin"), /refs\/heads\/fix\/1/, "a branch can be pushed, as in a real checkout");
  gh("pr", "comment", number, "--body", "Looks good");
  assert.match(gh("pr", "review", number, "--request-changes", "--body", "Add a test"), /CHANGES_REQUESTED/);
  assert.match(gh("pr", "review", number, "--approve", "--body", "Now good"), /APPROVED/);
  const view = JSON.parse(gh("pr", "view", number, "--json", "reviews,comments"));
  assert.deepEqual(view.reviews.map((r: { state: string }) => r.state), ["CHANGES_REQUESTED", "APPROVED"]);
  assert.equal(view.comments[0].body, "Looks good");
  assert.doesNotThrow(() => execFileSync("npm", ["test", "--silent"], { cwd: trial.repo, stdio: "pipe", env: withoutNodeTestContext() }), "the fix makes the suite pass");
});

test("anything the stand-in does not model fails loudly instead of pretending", () => {
  const { gh } = setup();
  assert.throws(() => gh("repo", "delete", "acme/app"), /unsupported/);
});

test("the approved fix can be merged to main and pushed, as a person would, ready for the deployer", () => {
  const { trial, gh, git } = setup();
  const { sha, prNumber } = mergeApprovedFix(trial);
  assert.equal(git("rev-parse", "HEAD").trim(), sha);
  assert.match(git("ls-remote", "origin", "refs/heads/main"), new RegExp(sha));
  assert.match(git("log", "-1", "--format=%s"), /Merge PR #3/);
  const pr = JSON.parse(gh("pr", "view", String(prNumber), "--json", "state,reviews"));
  assert.equal(pr.state, "merged");
  assert.deepEqual(pr.reviews.map((r: { state: string }) => r.state), ["APPROVED"]);
  assert.deepEqual(JSON.parse(gh("issue", "view", "1", "--json", "labels")).labels, [{ name: "status:approved" }]);
});

test("the stand-in wrangler deploys what is checked out, records every call, and rolls back", () => {
  const { trial, git, wrangler } = setup();
  assert.equal(wrangler("--version").trim(), "4.151.1");
  assert.match(wrangler("whoami", "--json"), /"loggedIn":true/);
  assert.match(wrangler("deploy", "--env", "staging", "--dry-run", "--outdir", join(trial.repo, ".dry")), /dry-run/);
  assert.equal(existsSync(trial.wranglerState), false, "a dry run deploys nothing, so there is no state yet");
  const first = wrangler("deploy", "--env", "staging", "--strict", "--message", "m1");
  assert.match(first, /Current Version ID: ver-staging-1/);
  git("commit", "-q", "--allow-empty", "-m", "second");
  assert.match(wrangler("deploy", "--env", "staging"), /ver-staging-2/);
  assert.match(wrangler("deployments", "status", "--env", "staging"), /ver-staging-2/);
  assert.match(wrangler("rollback", "ver-staging-1", "--env", "staging", "--yes"), /rolled back to Worker Version ver-staging-1/);
  assert.match(wrangler("deployments", "status", "--env", "staging"), /ver-staging-1/);
  const calls = wranglerCalls(trial);
  assert.equal(calls.length, 8);
  assert.match(calls[3]!.head, /^[0-9a-f]{40}$/, "the commit checked out at each call is recorded");
  assert.notEqual(calls[3]!.head, calls[5]!.head, "and it changes when the checkout does");
  assert.ok(calls.every((c) => c.hasToken || c.argv[0] === "--version"));
});

test("the stand-in wrangler refuses what a deployer must never do, and nothing without credentials", () => {
  const { trial, workspace } = setup();
  const bare = (...args: string[]) => execFileSync(join(workspace, "bin", "wrangler"), args, { encoding: "utf8", cwd: trial.repo, stdio: "pipe", env: { ...withoutNodeTestContext(), ...trial.env } });
  assert.throws(() => bare("deploy", "--env", "staging"), /CLOUDFLARE_API_TOKEN/);
  for (const args of [["secret", "put", "X"], ["delete"], ["d1", "execute", "db"], ["whoami", "--install-skills"], ["deploy", "--env-file", ".env"]]) {
    assert.throws(() => bare(...args), (error: { status?: number }) => typeof error.status === "number" && error.status !== 0, args.join(" "));
  }
});
