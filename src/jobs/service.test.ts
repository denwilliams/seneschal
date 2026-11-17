import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessConfigSchema } from "../config/schema.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { JobDefinitionSchema, hashDefinition } from "./definition.ts";
import { emptyRun, type JobRunData } from "./docs.ts";
import { createJobService, JobError, type JobStore } from "./service.ts";

const release = {
  description: "Review the release candidate",
  input: { branch: { default: "main", description: "what to review" }, ticket: {} },
  phases: [{ name: "plan", kind: "exec", command: "git", args: ["log", "--oneline", "${input.branch}"] }, { name: "note", kind: "state", op: "set", path: "/last", value: "${input.ticket}" }],
};

function setup(over: { tools?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "job-service-"));
  const config = HarnessConfigSchema.parse({
    channels: { C1: { tools: over.tools ?? ["read", "exec"], exec: { commands: { git: { command: "/usr/bin/git", allowArgs: [["log", "--oneline", "*"]] } } }, jobs: { release, broken: { phases: [{ name: "x", kind: "exec", command: "nope" }] } } } },
  });
  const entry = config.channels.C1!;
  const channel = { ref: { id: "C1" }, tools: entry.tools, exec: { commands: entry.exec!.commands, shared: [] }, jobs: entry.jobs, shared: { audit: join(dir, "audit") } } as unknown as ResolvedChannel;
  const runs = new Map<string, JobRunData>();
  const calls: unknown[] = [];
  const store: JobStore = {
    startJob: async (input) => { calls.push(["start", input]); const runId = `run_${runs.size + 1}`; runs.set(runId, { ...emptyRun(runId), job: input.name, hash: input.hash, input: input.input, by: input.by }); return { runId }; },
    jobRun: async (id) => runs.get(id),
    listJobRuns: async () => [...runs.values()],
    decideJob: async (id, decision, by) => { calls.push(["decide", id, decision, by]); },
    abortJob: async (id, reason) => { calls.push(["abort", id, reason]); return runs.get(id)?.status === "completed" ? "terminal" : "marked"; },
  };
  const auditFile = join(dir, "audit", "jobs.jsonl");
  const service = createJobService({ channel, store: () => store, threadKey: "100.1", currentUserId: () => "U7" });
  return { service, runs, calls, store, channel, audit: () => readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("list shows each job with its inputs and phases, and flags one the channel's rules would refuse", () => {
  const s = setup();
  const [rel, broken] = s.service.list();
  assert.equal(rel!.name, "release");
  assert.equal(rel!.description, "Review the release candidate");
  assert.deepEqual(rel!.inputs.map((i) => [i.name, i.required, i.default]), [["branch", false, "main"], ["ticket", true, undefined]]);
  assert.deepEqual(rel!.phases, [{ name: "plan", kind: "exec" }, { name: "note", kind: "state" }]);
  assert.equal(rel!.available, true);
  assert.equal(broken!.available, false);
  assert.match(broken!.problem!, /there is no command "nope"/);
  s.done();
});

test("start resolves inputs, pins the definition by hash, records who started it, and writes an audit line", async () => {
  const s = setup();
  const { runId } = await s.service.start("release", { ticket: "T-9" });
  const [, started] = s.calls[0] as [string, { name: string; hash: string; input: Record<string, string>; by: unknown }];
  assert.deepEqual(started.input, { branch: "main", ticket: "T-9" }, "the default was applied");
  assert.equal(started.hash, hashDefinition(JobDefinitionSchema.parse(release)));
  assert.deepEqual(started.by, { source: "agent", threadKey: "100.1", userId: "U7" });
  const [line] = s.audit();
  assert.deepEqual([line.event, line.runId, line.job, line.threadKey, line.userId, line.channelId], ["start", runId, "release", "100.1", "U7", "C1"]);
  s.done();
});

test("start refuses, in words the agent can act on: unknown job, a job the channel cannot run, bad inputs", async () => {
  const s = setup();
  await assert.rejects(s.service.start("nope", {}), (e: unknown) => e instanceof JobError && /no job "nope".*"release", "broken"/.test(e.message));
  await assert.rejects(s.service.start("broken", {}), /cannot run in this channel right now: phase "x": there is no command "nope"/);
  await assert.rejects(s.service.start("release", {}), /input "ticket" is required/);
  await assert.rejects(s.service.start("release", { ticket: "t", extra: "x" }), /has no input "extra"/);
  assert.equal(s.calls.length, 0, "nothing was started by any of those");
  s.done();
});

test("a job stops being startable the moment the channel loses the permission it needs", async () => {
  const s = setup({ tools: ["read"] });
  await assert.rejects(s.service.start("release", { ticket: "t" }), /does not have the exec tool/);
  assert.equal(s.service.list()[0]!.available, false);
  s.done();
});

test("check returns one run or the recent ones, and says when a run does not exist", async () => {
  const s = setup();
  const { runId } = await s.service.start("release", { ticket: "t" });
  assert.equal((await s.service.check(runId))[0]!.runId, runId);
  assert.equal((await s.service.check()).length, 1);
  await assert.rejects(s.service.check("run_nope"), /no run run_nope/);
  s.done();
});

test("decide and abort pass through with the person's id, and both are audited", async () => {
  const s = setup();
  const { runId } = await s.service.start("release", { ticket: "t" });
  await s.service.decide(runId, "retry");
  await s.service.abort(runId);
  assert.deepEqual(s.calls.slice(1), [["decide", runId, "retry", "U7"], ["abort", runId, "aborted by U7"]]);
  assert.deepEqual(s.audit().map((l) => l.event), ["start", "decide", "abort"]);
  assert.equal(s.audit()[1].decision, "retry");
  s.done();
});

test("aborting a run that already finished is said plainly, and an unknown run is refused", async () => {
  const s = setup();
  const { runId } = await s.service.start("release", { ticket: "t" });
  s.runs.get(runId)!.status = "completed";
  await assert.rejects(s.service.abort(runId), /already finished \(completed\)/);
  await assert.rejects(s.service.abort("run_nope"), /no run run_nope/);
  s.done();
});

test("without a store the service fails closed", async () => {
  const s = setup();
  const closed = createJobService({ channel: s.channel, store: () => undefined, threadKey: "t", currentUserId: () => "u" });
  await assert.rejects(closed.start("release", { ticket: "t" }), /not available in this session/);
  await assert.rejects(closed.check(), /not available/);
  assert.equal(closed.list().length, 2, "listing needs no store");
  s.done();
});

test("an audit line that cannot be written does not stop the job", async () => {
  const s = setup();
  // A path whose parent is a regular file fails the same way everywhere (ENOTDIR). Do not use a path under /proc: on Linux a
  // recursive mkdir there never returns, which hangs the whole test run.
  const dir = mkdtempSync(join(tmpdir(), "job-audit-blocker-"));
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  const noisy = createJobService({ channel: s.channel, store: () => s.store, threadKey: "t", currentUserId: () => "u", auditFile: join(blocker, "audit", "jobs.jsonl") });
  assert.ok((await noisy.start("release", { ticket: "t" })).runId);
  rmSync(dir, { recursive: true, force: true });
  s.done();
});
