import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore, MAX_LIVE_JOBS, type ChannelStoreOptions } from "../agent/durable/channel-store.ts";
import { recoverChannel } from "../agent/recovery.ts";
import { hashDefinition, JobDefinitionSchema, resolveInputs, type JobDefinition } from "./definition.ts";
import type { JobRunData } from "./docs.ts";
import { makeJobTask, type ExecResult, type JobDeps } from "./task.ts";

const def = (value: unknown): JobDefinition => JobDefinitionSchema.parse(value);
const ok = (output = ""): ExecResult => ({ exitCode: 0, output, timedOut: false, truncated: false, aborted: false });
const fail = (code = 1, output = ""): ExecResult => ({ exitCode: code, output, timedOut: false, truncated: false, aborted: false });
const by = { source: "agent" as const, threadKey: "100.1", userId: "U1" };

interface Call { command: string; args: string[] }

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "jobs-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const calls: Call[] = [];
  const state = {
    script: ((): Promise<ExecResult> | ExecResult => ok()) as (call: Call, signal: AbortSignal) => Promise<ExecResult> | ExecResult,
    problem: undefined as string | undefined,
  };
  const deps: JobDeps = {
    phaseProblem: () => state.problem,
    exec: async ({ command, args, signal }) => { calls.push({ command, args }); return state.script({ command, args }, signal); },
  };
  const options = (): ChannelStoreOptions => ({
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"], jobTask: makeJobTask(() => deps),
  });
  const open = new Set<DurableChannelStore>();
  t.after(async () => { for (const store of open) await store.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  return {
    root, calls, state,
    open: async (resume = true) => { const store = await DurableChannelStore.open(options()); open.add(store); if (resume) await store.resume(); return store; },
    close: async (store: DurableChannelStore) => { await store.close(); open.delete(store); },
  };
}

// Like the job service: the inputs are resolved (defaults applied, extras refused) before a run starts.
const start = (store: DurableChannelStore, name: string, definition: JobDefinition, input: Record<string, string> = {}) =>
  store.startJob({ name, definition, hash: hashDefinition(definition), input: resolveInputs(definition, input), by });

async function until<T>(read: () => Promise<T | undefined>, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const reach = (store: DurableChannelStore, runId: string, ...statuses: JobRunData["status"][]) =>
  until(async () => { const run = await store.jobRun(runId); return run && statuses.includes(run.status) ? run : undefined; }, `run ${runId} to be ${statuses.join(" or ")}`);

const release = def({
  input: { branch: { default: "main" } },
  phases: [
    { name: "plan", kind: "exec", command: "git", args: ["log", "--oneline", "${input.branch}"] },
    { name: "record", kind: "state", op: "set", path: "/releases/last", value: { branch: "${input.branch}", log: "${phases.plan.result}", exit: "${phases.plan.exit}" } },
  ],
});

test("a job runs its exec and state phases in order, and the state it writes is the channel's", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.state.script = () => ok("abc1 first\nabc2 second");
  const { runId } = await start(store, "release", release, { branch: "dev" });
  const run = await reach(store, runId, "completed");
  assert.deepEqual(f.calls, [{ command: "git", args: ["log", "--oneline", "dev"] }]);
  assert.deepEqual(run.phases.map((p) => [p.name, p.kind, p.status, p.exit]), [["plan", "exec", "done", 0], ["record", "state", "done", -1]]);
  assert.equal(run.index, 2);
  assert.deepEqual(run.results.plan, { result: "abc1 first\nabc2 second", exit: 0 });
  assert.deepEqual((await store.readState("/releases/last")).value, { branch: "dev", log: "abc1 first\nabc2 second", exit: "0" });
  const snapshot = await store.stateSnapshot();
  assert.deepEqual([snapshot.changes[0]!.source, snapshot.changes[0]!.threadKey], ["job", "100.1"], "attributed to the job, and the thread that started it");
  assert.ok(run.endedAt >= run.startedAt && run.startedAt > 0);
  assert.equal(run.hash, hashDefinition(release), "the run is pinned to the definition it started with");
});

test("an input is one argument, however much shell it contains, and is never parsed as a reference", async (t) => {
  const f = await fixture(t); const store = await f.open();
  const nasty = "-rf; $(whoami) `id` && ${input.branch} | tee /etc/x";
  const { runId } = await start(store, "release", release, { branch: nasty });
  await reach(store, runId, "completed");
  assert.deepEqual(f.calls[0]!.args, ["log", "--oneline", nasty], "exactly one argv element, byte for byte");
});

test("a failing command fails the run and the phases after it do not run; `continue` keeps going", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.state.script = () => fail(2, "boom");
  const failing = await reach(store, (await start(store, "release", release)).runId, "failed");
  assert.match(failing.reason, /phase "plan" failed: exit 2/);
  assert.deepEqual(failing.phases.map((p) => p.status), ["failed", "pending"], "the state phase never ran");
  assert.equal((await store.stateSnapshot()).rev, 0);

  const tolerant = def({ phases: [{ name: "try", kind: "exec", command: "flaky", onFailure: "continue" }, { name: "after", kind: "exec", command: "next" }] });
  f.state.script = ({ command }) => (command === "flaky" ? fail(1) : ok());
  const run = await reach(store, (await start(store, "tolerant", tolerant)).runId, "completed");
  assert.deepEqual(run.phases.map((p) => p.status), ["failed", "done"]);
});

test("a timed-out or unstartable command is a failure, with the reason said", async (t) => {
  const f = await fixture(t); const store = await f.open();
  const one = def({ phases: [{ name: "x", kind: "exec", command: "slow" }] });
  f.state.script = () => ({ exitCode: null, output: "", timedOut: true, truncated: false, aborted: false });
  assert.match((await reach(store, (await start(store, "slow", one)).runId, "failed")).reason, /timed out/);
  f.state.script = () => ({ exitCode: null, output: "", timedOut: false, truncated: false, aborted: false, startError: "ENOENT" });
  assert.match((await reach(store, (await start(store, "missing", one)).runId, "failed")).reason, /could not start: ENOENT/);
  f.state.script = () => { throw new Error("runner exploded"); };
  assert.match((await reach(store, (await start(store, "boom", one)).runId, "failed")).reason, /could not start: runner exploded/);
});

test("a reference with no value fails the run before anything runs, and says which", async (t) => {
  const f = await fixture(t); const store = await f.open();
  const needsState = def({ phases: [{ name: "x", kind: "exec", command: "git", args: ["${state:/not/there}"] }] });
  const run = await reach(store, (await start(store, "needs", needsState)).runId, "failed");
  assert.match(run.reason, /state:\/not\/there.*has no value/);
  assert.equal(f.calls.length, 0, "nothing ran");
});

test("state read by a later phase is what an earlier phase wrote", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.updateState({ op: "set", path: "/jobs/cursor", value: 41, by });
  const chained = def({ phases: [
    { name: "a", kind: "state", op: "set", path: "/jobs/next", value: "after ${state:/jobs/cursor}" },
    { name: "b", kind: "exec", command: "echo", args: ["${state:/jobs/next}"] },
  ] });
  await reach(store, (await start(store, "chain", chained)).runId, "completed");
  assert.deepEqual(f.calls[0]!.args, ["after 41"]);
});

test("a state phase that is refused (a limit, a type) fails the run and changes nothing", async (t) => {
  const f = await fixture(t); const store = await f.open();
  await store.updateState({ op: "set", path: "/n", value: "text", by });
  const bad = def({ phases: [{ name: "a", kind: "state", op: "append", path: "/n", value: 1 }, { name: "b", kind: "exec", command: "never" }] });
  const run = await reach(store, (await start(store, "bad", bad)).runId, "failed");
  assert.match(run.reason, /not an array/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await store.readState("/n")).value, "text");
});

test("a phase the channel no longer permits fails the run instead of running", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.state.problem = "the command is no longer allowed here";
  const run = await reach(store, (await start(store, "release", release)).runId, "failed");
  assert.match(run.reason, /not permitted now: the command is no longer allowed here/);
  assert.equal(f.calls.length, 0);
});

test("the same job cannot run twice at once, and a channel has a cap on live runs", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.state.script = (_call, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ...ok(), aborted: true })));
  const first = await start(store, "release", release);
  await assert.rejects(start(store, "release", release), /already running/);
  const others = Array.from({ length: MAX_LIVE_JOBS - 1 }, (_, i) => def({ phases: [{ name: "x", kind: "exec", command: `c${i}` }] }));
  for (const [i, other] of others.entries()) await start(store, `other${i}`, other);
  await assert.rejects(start(store, "one-too-many", others[0]!), new RegExp(`${MAX_LIVE_JOBS} jobs are already running`));
  assert.equal((await store.liveJobs()).length, MAX_LIVE_JOBS);
  await store.abortJob(first.runId, "test cleanup");
});

test("a live job is not a conversation's work: it must not make the recovery gate see the main conversation as busy", async (t) => {
  const f = await fixture(t); const store = await f.open();
  f.state.script = (_call, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ...ok(), aborted: true })));
  const { runId } = await start(store, "release", release);
  await until(async () => (await store.jobRun(runId))?.phases[0]?.status === "running" ? true : undefined, "the exec phase to start");
  const inspection = await store.inspect();
  assert.ok(inspection.tasks.some((task) => task.record.kind === "slack.job"), "the job is a live task in the store");
  assert.deepEqual(await store.liveRoutes(), [], "yet liveRoutes, which the recovery gate reads, does not list it");
  assert.deepEqual((await store.liveJobs()).map((job) => job.runId), [runId]);
  await store.abortJob(runId, "test cleanup");
});

test("aborting a running job records why, kills the command, and ends the run", async (t) => {
  const f = await fixture(t); const store = await f.open();
  let killed = false;
  f.state.script = (_call, signal) => new Promise((resolve) => signal.addEventListener("abort", () => { killed = true; resolve({ ...ok(), aborted: true }); }));
  const { runId } = await start(store, "release", release);
  await until(async () => (await store.jobRun(runId))?.phases[0]?.status === "running" ? true : undefined, "the exec phase to start");
  assert.equal(await store.abortJob(runId, "aborted by U9: wrong branch"), "marked");
  const run = await reach(store, runId, "aborted");
  assert.equal(killed, true, "the running command was told to stop");
  assert.equal(run.reason, "aborted by U9: wrong branch");
  assert.equal(run.phases[1]!.status, "pending", "the later phase never started");
  assert.equal(await store.abortJob(runId, "again"), "terminal", "aborting a finished run is a no-op");
  assert.deepEqual(await store.liveJobs(), []);
});

/** Make a run reach `needs_decision` by stopping the harness while its exec phase runs, then reopening it. */
async function interrupted(t: TestContext) {
  const f = await fixture(t);
  const first = await f.open();
  f.state.script = (_call, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ...ok(), aborted: true })));
  const { runId } = await start(first, "release", release);
  await until(async () => (await first.jobRun(runId))?.phases[0]?.status === "running" ? true : undefined, "the exec phase to start");
  await f.close(first); // the command was mid-run: "started" is committed, its result is not
  f.calls.length = 0;
  f.state.script = () => ok("retried output");
  const second = await f.open();
  return { f, store: second, runId };
}

test("a phase interrupted by a restart is never repeated on its own: the run waits for a decision", async (t) => {
  const { f, store, runId } = await interrupted(t);
  const run = await reach(store, runId, "needs_decision");
  assert.match(run.reason, /interrupted.*Retry it, skip it, or abort the run/);
  assert.equal(run.phases[0]!.summary, "interrupted: waiting for a decision");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.calls.length, 0, "the command did NOT run again");
  assert.equal((await store.liveJobs()).length, 1, "and it is still a live job, waiting");
});

test("retry runs the interrupted phase again and the run goes on", async (t) => {
  const { f, store, runId } = await interrupted(t);
  await reach(store, runId, "needs_decision");
  await store.decideJob(runId, "retry", "U2");
  const run = await reach(store, runId, "completed");
  assert.equal(f.calls.length, 1, "exactly one more execution, because someone asked for it");
  assert.equal(run.results.plan!.result, "retried output");
  assert.deepEqual(run.phases.map((p) => p.status), ["done", "done"]);
});

test("skip moves past the interrupted phase without running it", async (t) => {
  const { f, store, runId } = await interrupted(t);
  await reach(store, runId, "needs_decision");
  await store.decideJob(runId, "skip", "U2");
  const run = await reach(store, runId, "failed", "completed");
  assert.equal(f.calls.length, 0);
  assert.equal(run.phases[0]!.status, "skipped");
  assert.match(run.phases[0]!.summary, /skipped by U2/);
  assert.match(run.reason + run.status, /failed|completed/);
});

test("abort at the decision ends the run, saying who and why", async (t) => {
  const { store, runId } = await interrupted(t);
  await reach(store, runId, "needs_decision");
  await store.decideJob(runId, "abort", "U2");
  const run = await reach(store, runId, "aborted");
  assert.match(run.reason, /aborted by U2 after an interruption/);
});

test("a decision is only accepted for a run that is waiting for one", async (t) => {
  const f = await fixture(t); const store = await f.open();
  const { runId } = await start(store, "release", release);
  await reach(store, runId, "completed");
  await assert.rejects(store.decideJob(runId, "retry", "U1"), /completed: there is nothing to decide/);
  await assert.rejects(store.decideJob("run_nope", "retry", "U1"), /no run/);
});

test("runs are listed newest first, and a missing run is undefined", async (t) => {
  const f = await fixture(t); const store = await f.open();
  const a = await start(store, "release", release);
  await reach(store, a.runId, "completed");
  await new Promise((r) => setTimeout(r, 5));
  const b = await start(store, "release", release);
  await reach(store, b.runId, "completed");
  assert.deepEqual((await store.listJobRuns()).map((r) => r.runId), [b.runId, a.runId]);
  assert.equal((await store.listJobRuns(1)).length, 1);
  assert.equal(await store.jobRun("run_missing"), undefined);
});

test("a store opened without the job task refuses to start jobs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jobs-none-"));
  await mkdir(join(root, "workspace"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const store = await DurableChannelStore.open({ storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models, model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"] });
  t.after(() => store.close());
  await assert.rejects(start(store, "release", release), /not available/);
});

test("SIGKILL while an exec phase is running: after the restart it does not run again, and waits for a decision", async (t) => {
  const f = await fixture(t);
  const child = fork(fileURLToPath(new URL("../agent/durable/fixtures/job-crash-child.ts", import.meta.url)), [f.root], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = ""; child.stderr?.on("data", (d) => { errors += d; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await Promise.race([
    new Promise<void>((resolve) => child.on("message", (m: { ready?: string }) => { if (m.ready === "deploying") resolve(); })),
    once(child, "exit").then(([code]) => { throw new Error(`child exited ${code}: ${errors}`); }),
    new Promise<never>((_r, reject) => { const timer = setTimeout(() => reject(new Error(`child timed out: ${errors}`)), 15000); timer.unref(); }),
  ]);
  child.kill("SIGKILL"); await once(child, "exit");
  const effects = () => (existsSync(join(f.root, "effects")) ? readFileSync(join(f.root, "effects"), "utf8").split("\n").filter(Boolean) : []);
  assert.deepEqual(effects(), ["echo", "deploy"], "the first phase ran, and the deploy had started");

  const store = await f.open();
  const runs = await store.listJobRuns();
  assert.equal(runs.length, 1);
  const runId = runs[0]!.runId;
  const run = await reach(store, runId, "needs_decision");
  assert.deepEqual(run.phases.map((p) => p.status), ["done", "running"]);
  assert.equal(run.index, 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(f.calls, [], "the restarted harness ran nothing: the deploy is not repeated on its own");
  await store.decideJob(runId, "abort", "U1");
  assert.equal((await reach(store, runId, "aborted")).status, "aborted");
});

// ── The recovery gate ─────────────────────────────────────────────────────────────────────────────────────────

/** A job that was running when the harness stopped, in a store that is open but not yet resumed, as the gate finds it. */
async function liveAtRestart(t: TestContext) {
  const f = await fixture(t);
  const before = await f.open();
  f.state.script = (_call, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ...ok(), aborted: true })));
  const { runId } = await start(before, "release", release);
  await until(async () => (await before.jobRun(runId))?.phases[0]?.status === "running" ? true : undefined, "the exec phase to start");
  await f.close(before);
  f.calls.length = 0;
  f.state.script = () => ok("must not be reached");
  const store = await f.open(false);
  const runtime = { store, channel: { ref: { id: "C1" } }, disposers: [] } as never;
  const deps = (jobProblem?: (d: JobDefinition) => string | undefined) => ({
    isEphemeral: () => false, speakerAllowed: () => true, bind: async () => { throw new Error("no conversation work in this test"); },
    ...(jobProblem ? { jobProblem } : {}),
  });
  return { f, store, runId, runtime, deps };
}

test("the gate does not pause a channel because a job was running, and the job carries on to wait for a decision", async (t) => {
  const { f, store, runId, runtime, deps } = await liveAtRestart(t);
  const outcome = await recoverChannel(runtime, deps(() => undefined));
  assert.deepEqual(outcome.blocked, [], "a job is not an unresumable conversation");
  assert.equal(outcome.resumed, true, "the scheduler was resumed");
  assert.deepEqual(outcome.jobs, { resumed: [runId], aborted: [] });
  const run = await reach(store, runId, "needs_decision");
  assert.match(run.reason, /interrupted/);
  assert.equal(f.calls.length, 0, "and the interrupted command was not repeated");
});

test("the gate aborts a job whose phase is no longer permitted, before anything can run it", async (t) => {
  const { f, store, runId, runtime, deps } = await liveAtRestart(t);
  const outcome = await recoverChannel(runtime, deps(() => "the exec tool was removed from this channel"));
  assert.deepEqual(outcome.jobs.resumed, []);
  assert.equal(outcome.jobs.aborted[0]!.runId, runId);
  assert.equal(outcome.resumed, true, "the rest of the channel still resumes");
  const run = await reach(store, runId, "aborted");
  assert.equal(run.reason, "no longer permitted after the restart: the exec tool was removed from this channel");
  assert.equal(f.calls.length, 0, "it never ran");
  assert.deepEqual(await store.liveJobs(), []);
});

test("the gate aborts a run whose pinned definition cannot be read, rather than trusting it", async (t) => {
  const { f, store, runId, runtime, deps } = await liveAtRestart(t);
  const { JobRunFamily, emptyRun } = await import("./docs.ts");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  await (store as unknown as { harness: { commit<T>(fn: (tx: never) => Promise<T>, c: unknown): Promise<T> } }).harness.commit(async (tx: any) => {
    (await tx.doc(JobRunFamily, runId, emptyRun(runId))).definition = "{ not json";
  }, BACKGROUND_CONTEXT);
  const outcome = await recoverChannel(runtime, deps(() => undefined));
  assert.match(outcome.jobs.aborted[0]!.reason, /missing or unreadable/);
  assert.equal((await reach(store, runId, "aborted")).status, "aborted");
  assert.equal(f.calls.length, 0);
});

test("a gate with no job step configured lets jobs resume on the channel's own rules", async (t) => {
  const { store, runId, runtime, deps } = await liveAtRestart(t);
  const outcome = await recoverChannel(runtime, deps());
  assert.deepEqual(outcome.jobs.resumed, [runId]);
  await reach(store, runId, "needs_decision");
});
