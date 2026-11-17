import assert from "node:assert/strict";
import { test } from "node:test";
import { githubDeploymentActivity, githubEventActivity } from "./activity.ts";
import { activityKind } from "./timeline.ts";

const repository = "acme/widget";
const date = "2026-10-08T12:00:00Z";

test("GitHub payload mapping keeps issue/PR actions and links without inventing merges", () => {
  const issue = githubEventActivity(repository, { type: "IssuesEvent", created_at: date, actor: { login: "alice" }, payload: { action: "opened", issue: { number: 3, title: "Bug", html_url: `https://github.com/${repository}/issues/3` } } });
  assert.equal(issue.action, "opened");
  assert.equal(issue.actor, "alice");
  assert.match(issue.details!, /Issue #3 · Bug/);
  assert.equal(issue.url, `https://github.com/${repository}/issues/3`);
  for (const merged of [true, false, undefined]) {
    const pr = githubEventActivity(repository, { type: "PullRequestEvent", created_at: date, payload: { action: "closed", pull_request: { number: 4, merged, title: "Fix", html_url: `https://github.com/${repository}/pull/4` } } });
    assert.equal(activityKind(pr), merged === true ? "merged" : "pr");
  }
  assert.equal(activityKind(githubEventActivity(repository, { type: "PullRequestEvent", payload: { action: "merged" } })), "merged");
  assert.equal(activityKind(githubEventActivity(repository, { type: "PullRequestReviewEvent", payload: { action: "created", review: { state: "approved" } } })), "review");
});

test("current and legacy PushEvent payloads give useful refs/commit links but never deployments", () => {
  const head = "a".repeat(40);
  const current = githubEventActivity(repository, { type: "PushEvent", created_at: date, payload: { ref: "refs/heads/main", head } });
  assert.equal(current.url, `https://github.com/${repository}/commit/${head}`);
  assert.match(current.details!, /refs\/heads\/main · head aaaaaaa/);
  assert.equal(activityKind(current), "push");
  assert.doesNotMatch(current.details!, /commits/);
  const legacy = githubEventActivity(repository, { type: "PushEvent", payload: { size: 2, commits: [{ sha: head, message: "Fix bugs" }] } });
  assert.match(legacy.details!, /2 commits · Fix bugs/);
  const bad = githubEventActivity(repository, { type: "PushEvent", payload: { head: "../bad" } });
  assert.equal(bad.url, `https://github.com/${repository}`);
});

test("deployment records describe creation, never success, and releases remain releases", () => {
  const deployment = githubDeploymentActivity(repository, { id: 5, created_at: date, environment: "staging", ref: "main", creator: { login: "robot" } });
  assert.equal(deployment.createdAt, date);
  assert.equal(activityKind(deployment), "deployment");
  assert.match(deployment.details!, /Deployment #5 · staging · main · Creation record only; outcome not checked/);
  assert.equal(deployment.url, `https://github.com/${repository}/deployments`);
  assert.equal(activityKind(githubEventActivity(repository, { type: "ReleaseEvent", payload: { action: "published" } })), "release");
});

test("missing or unfamiliar event data remains generic", () => {
  const generic = githubEventActivity(repository, {});
  assert.equal(generic.type, "GitHub event");
  assert.equal(generic.createdAt, "");
  assert.equal(generic.url, `https://github.com/${repository}`);
});
