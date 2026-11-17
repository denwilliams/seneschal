import assert from "node:assert/strict";
import { test } from "node:test";
import { readFactoryRepository, type FactoryGitHubReader } from "./tools.ts";

const date = "2026-10-08T12:00:00Z";
test("collection uses bounded read-only pagination and retains deployment/merge payloads", async () => {
  const calls: string[][] = [];
  const reader: FactoryGitHubReader = async <T>(_env: Record<string, string>, args: string[]): Promise<T> => {
    calls.push(args);
    if (args[0] !== "api") return [] as T;
    if (args[1]?.includes("/deployments?")) return [{ id: 3, created_at: date, environment: "staging" }] as T;
    return Array.from({ length: 100 }, () => ({ type: "PullRequestEvent", created_at: date, payload: { action: "closed", pull_request: { merged: true } } })) as T;
  };
  const result = await readFactoryRepository("acme/widget", {}, reader);
  assert.equal(result.activity.length, 301);
  assert.equal(result.activity[0]!.merged, true);
  assert.equal(result.activity[300]!.type, "Deployment");
  assert.equal(calls.filter((args) => args[1]?.includes("/events?")).length, 3);
  assert.equal(calls.filter((args) => args[1]?.includes("/deployments?")).length, 1);
  assert.ok(calls.every((args) => args[0] === "api" || (args[1] === "list" && ["issue", "pr"].includes(args[0] ?? ""))));
  assert.ok(calls.every((args) => !args.includes("--method") && !args.includes("-f")));
  assert.match(result.activityCoverage!, /up to 300/);
  assert.match(result.activityCoverage!, /not a complete activity history/);
});

test("deployment errors don't erase other GitHub data and are visible as missing coverage", async () => {
  const reader: FactoryGitHubReader = async <T>(_env: Record<string, string>, args: string[]): Promise<T> => {
    if (args[1]?.includes("/deployments?")) throw new Error("sensitive stderr");
    if (args[0] === "issue") return [{ number: 1, title: "Bug" }] as T;
    if (args[1]?.includes("/events?")) return [{ type: "PushEvent", created_at: date }] as T;
    return [] as T;
  };
  const result = await readFactoryRepository("acme/widget", {}, reader);
  assert.equal(result.issues.length, 1);
  assert.equal(result.activity.length, 1);
  assert.match(result.activityCoverage!, /Deployment data unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /sensitive stderr/);
  assert.equal(result.error, undefined);
});

test("core collection errors are sanitized rather than implying a successful empty snapshot", async () => {
  const reader: FactoryGitHubReader = async () => { throw new Error("token or private host output"); };
  const result = await readFactoryRepository("acme/widget", {}, reader);
  assert.match(result.error!, /GitHub data unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /private host output/);
});
