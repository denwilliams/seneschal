import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelRuntimes } from "../agent/channel-runtime.ts";
import { isSubagentRunKey } from "../agent/durable/channel-store.ts";
import { recoverChannel, type RecoveryOutcome } from "../agent/recovery.ts";
import { buildThreadToolSet, runtimeTemplate, type CreateThreadSessionOptions } from "../agent/session.ts";
import { ChannelTimelineLog } from "../agent/timeline.ts";
import { SOFTWARE_FACTORY_WORKFLOW } from "../factory/workflow/definition.ts";
import { fixture, held, reach, reply, respond, type Fixture } from "../factory/workflow/test-support.ts";
import { emptyIntakeRepo, type IntakeRepoData } from "../factory/workflow/intake-docs.ts";
import { factoryLabels, LabelKeeper } from "../factory/workflow/labels.ts";
import { FakeLabels } from "../factory/workflow/test-support.ts";
import { appSubagentHost, ensureChannelLabels, factoryRunProblem } from "./factory-wiring.ts";

/**
 * The pieces the app hands its channel runtimes for software factory workflow runs, run as the app runs them: the subagent host
 * (what lets a background run start its roles with no turn above it) and the recovery gate's question about a live run. The app
 * itself needs a Slack connection to build, so these are the same functions it calls, in their own module.
 */

async function open(f: Fixture) {
  const modelRuntime = await f.ready;
  const spend: { runKey: string; channel: string }[] = [];
  const control = { current: () => undefined, set: async () => { throw new Error("no session"); } };
  let outcome: RecoveryOutcome | undefined;
  const runtimes: ChannelRuntimes = new ChannelRuntimes({
    modelRuntime,
    subagentHost: appSubagentHost({
      harnessName: () => "Test", botUserId: () => "UBOT", defaultTimezone: () => "UTC",
      onSubagentMessage: (channel) => ({ runKey }) => { spend.push({ runKey, channel: channel.ref.id }); },
    }),
    gate: async (runtime) => {
      outcome = await recoverChannel(runtime, {
        isEphemeral: (key) => isSubagentRunKey(key), speakerAllowed: () => true, factoryProblem: factoryRunProblem(runtime.channel),
        bind: async () => { throw new Error("nothing here is a live conversation"); },
      });
    },
  });
  const probe = (): CreateThreadSessionOptions => ({ channel: f.channel, threadKey: "channel-runtime", harnessName: "Test", slackChannelLabel: "#factory", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1" });
  const lease = await runtimes.acquire(f.channel, async () => runtimeTemplate(probe(), await buildThreadToolSet(probe(), control)));
  const runtime = lease.runtime;
  lease.release();
  f.toRelease.push(async () => { await runtimes.closeAll(); });
  const start = (repo: string) => runtime.store.startFactoryRun({
    definition: SOFTWARE_FACTORY_WORKFLOW, repo, issue: 7, issueTitle: "Login fails", issueUrl: `https://github.com/${repo}/issues/7`,
    by: { source: "operator", threadKey: "1.1", userId: "U1" },
  });
  return { runtime, runtimes, start, spend, outcome: () => outcome! };
}

test("the app's subagent host runs a workflow run's roles with no turn above them, on the channel's timeline and with their spend accounted", async (t) => {
  const f = fixture(t);
  const app = await open(f);
  const coder = held(reply.implement());
  f.faux.setResponses([respond(reply.triage()), coder.factory]);
  const { runId } = await app.start("acme/app");
  await coder.reached;
  const run = await reach(app.runtime, runId, ["running"]);
  assert.deepEqual(run.stages.slice(0, 2).map((s) => [s.name, s.status]), [["triage", "success"], ["implement", "in_progress"]]);
  const events = new ChannelTimelineLog(f.channel.paths.root).read();
  assert.deepEqual(events.filter((e) => e.kind === "run.start").map((e) => [e.actor, e.threadKey]), [["github_triage", `sub-parent-${runId}`], ["coder", `sub-parent-${runId}`]]);
  assert.ok(app.spend.some((entry) => entry.channel === "C1" && entry.runKey.startsWith("sub-")), "a stage's model calls are accounted like the channel's own");
  await app.runtime.store.abortFactoryRun(runId, "test over");
  coder.release();
  await reach(app.runtime, runId, ["aborted"]);
});

test("the app's recovery question: a run for a repository the factory no longer lists is aborted, one for a listed repository carries on", async (t) => {
  const f = fixture(t);
  const first = await open(f);
  const cut = held(reply.triage());
  f.faux.setResponses([cut.factory]);
  const { runId } = await first.start("acme/app");
  await cut.reached;
  const problem = factoryRunProblem(f.channel);
  const stored = (await first.runtime.store.factoryRun(runId))!;
  assert.equal(problem(stored), undefined, "acme/app is the factory's repository");
  assert.equal(problem({ ...stored, repo: "ACME/APP" }), undefined, "spelled any way");
  assert.equal(problem({ ...stored, repo: "other/repo" }), "other/repo is no longer one of this factory's repositories");
  assert.match(factoryRunProblem({ ...f.channel, agents: f.channel.agents.filter((agent) => agent.name !== "reviewer") })(stored)!, /no `reviewer` subagent/);
  assert.match(factoryRunProblem({ ...f.channel, factory: undefined })(stored)!, /not a software factory/);
  cut.release();
});

// ── The factory's GitHub labels ──────────────────────────────────────────────────────────────────────────

function labelRig() {
  const audit: { event: string; fields: Record<string, unknown> }[] = [];
  const keeper = new LabelKeeper({ now: () => 1_700_000_000_000, audit: (_channelId, event, fields) => audit.push({ event, fields }) });
  const records = new Map<string, IntakeRepoData>();
  let changed = 0;
  const store = { mutateFactoryIntake: async (repo: string, change: (data: IntakeRepoData) => void) => { const data = records.get(repo) ?? emptyIntakeRepo(repo); change(data); records.set(repo, data); } };
  return { keeper, audit, records, store, changed: () => changed, bump: () => { changed++; } };
}

test("a factory that files issues or watches for them has its labels made, and the outcome is kept in its intake record for the console", async (t) => {
  for (const options of [{ issues: { create: true } }, { intake: { enabled: true } }] as const) {
    const f = fixture(t, options);
    const rig = labelRig();
    const api = new FakeLabels();
    const outcomes = await ensureChannelLabels(rig.keeper, f.channel, { api, store: rig.store, changed: rig.bump });
    assert.equal(outcomes.length, 1);
    assert.deepEqual(api.made.map((label) => label.name), factoryLabels(f.channel.factory!));
    const record = rig.records.get(outcomes[0]!.repo)!;
    assert.deepEqual([record.labels!.error, record.labels!.created.length, record.labels!.checkedAt], ["", api.made.length, 1_700_000_000_000]);
    assert.equal(rig.changed(), 1, "the console is told");
    assert.deepEqual(rig.audit.map((line) => line.event), ["labels_created"]);
    await ensureChannelLabels(rig.keeper, f.channel, { api, store: rig.store, changed: rig.bump });
    assert.equal(api.listCalls, 1, "once per process");
  }
});

test("a factory that does neither is left alone, and is checked afresh when it starts to", async (t) => {
  const on = fixture(t, { issues: { create: true } });
  const off = fixture(t, {});
  assert.equal(off.channel.ref.id, on.channel.ref.id, "the same channel, with and without filing");
  const rig = labelRig();
  const api = new FakeLabels();
  await ensureChannelLabels(rig.keeper, on.channel, { api });
  assert.deepEqual(await ensureChannelLabels(rig.keeper, off.channel, { api }), []);
  assert.equal(api.listCalls, 1, "no call for the channel that does not want labels");
  await ensureChannelLabels(rig.keeper, on.channel, { api });
  assert.equal(api.listCalls, 2, "turned off and on again: checked again");
});

test("a channel whose team cannot run the workflow gets no labels: it can neither file nor poll", async (t) => {
  const f = fixture(t, { issues: { create: true } });
  const api = new FakeLabels();
  assert.deepEqual(await ensureChannelLabels(labelRig().keeper, { ...f.channel, agents: [] }, { api }), []);
  assert.equal(api.listCalls, 0);
});

test("a failure to reach GitHub is recorded and audited, never thrown, and a missing store only loses the record", async (t) => {
  const f = fixture(t, { issues: { create: true } });
  const rig = labelRig();
  const api = new FakeLabels();
  api.listError = "HTTP 403: Resource not accessible by personal access token";
  const outcomes = await ensureChannelLabels(rig.keeper, f.channel, { api, store: rig.store });
  assert.match(outcomes[0]!.error, /HTTP 403/);
  assert.match(rig.records.get(outcomes[0]!.repo)!.labels!.error, /HTTP 403/);
  assert.deepEqual(rig.audit.map((line) => line.event), ["labels_failed"]);
  const noStore = labelRig();
  const quiet = new FakeLabels();
  assert.equal((await ensureChannelLabels(noStore.keeper, f.channel, { api: quiet })).length, 1, "no store open: still checked");
  const broken = labelRig();
  const throwing = { mutateFactoryIntake: async () => { throw new Error("store closed"); } };
  assert.equal((await ensureChannelLabels(broken.keeper, f.channel, { api: new FakeLabels(), store: throwing })).length, 1, "a store that cannot record does not fail the check");
});
