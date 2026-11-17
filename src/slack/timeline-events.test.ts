import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { GrantStore, channelHasGrant, subagentCapability } from "../agent/grants.ts";
import { ChannelActivityLog } from "../agent/activity.ts";
import { ChannelTimelineLog, closeInterruptedRuns } from "../agent/timeline.ts";

/** The app's own approval methods, driven for real: the request that is posted, and a person's click on its button. */
function appFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "timeline-events-"));
  const config = HarnessConfigSchema.parse({
    agentSets: { set: { agents: { deployer: { description: "Deploys.", requireApproval: true } } } },
    channels: { ops: { agentSet: "set" } },
  });
  const posted: { blocks?: unknown[]; text?: string }[] = [];
  const updates: unknown[] = [];
  const client = {
    chat: {
      postMessage: async (args: { blocks?: unknown[]; text?: string }) => { posted.push(args); return { ok: true, ts: "9.9" }; },
      update: async (args: unknown) => { updates.push(args); return { ok: true }; },
      postEphemeral: async () => ({ ok: true }),
    },
  };
  const registry = new ChannelRegistry(dataDir);
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    config, registry, opts: { dataDir }, botUserId: "UBOT",
    channelNames: new Map([["COPS", "ops"]]),
    pendingThread: new Map<string, string>(), pendingUser: new Map([["COPS", "U1"]]),
    grants: new GrantStore(dataDir),
    pool: { disposeChannel: async () => undefined },
    runtimes: { invalidate: async () => undefined },
    app: { client },
  });
  const log = () => new ChannelTimelineLog(join(dataDir, "channels", "COPS")).read();
  return { harness, client, posted, updates, log, dataDir };
}

/** The buttons of the approval message exactly as the app posted them. */
const buttonsOf = (message: { blocks?: unknown[] }): { action_id: string; value: string }[] =>
  (message.blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);

test("asking for an approval and a person's decision both land on the timeline, and the grant is real", async () => {
  const f = appFixture();
  await (HarnessApp.prototype as any).request.call(f.harness, {
    channelId: "COPS", capability: subagentCapability("deployer"), reason: "Deploy abc123 to staging, https://user:secret@example.com", minutes: 15,
  });
  assert.equal(f.posted.length, 1, "the approve/deny message went to Slack");
  const activity = () => new ChannelActivityLog(join(f.dataDir, "channels", "COPS"), "COPS").read();
  assert.equal(activity()[0]!.sourceTs, "9.9");
  assert.equal(activity()[0]!.interaction, "pending");
  const requested = f.log();
  assert.deepEqual(requested.map((e) => [e.kind, e.actor]), [["approval.requested", "channel"]]);
  assert.match(requested[0]!.title, /running the "deployer" subagent/);
  assert.match(requested[0]!.detail!, /Deploy abc123 to staging/);
  assert.doesNotMatch(JSON.stringify(requested), /secret/);

  // The click: the button value and action id come from the message the app actually posted.
  const approve = buttonsOf(f.posted[0]!)[0]!; // the first offered duration
  await (HarnessApp.prototype as any).decide.call(f.harness, f.client, { actions: [{ value: approve.value, action_id: approve.action_id }], user: { id: "U2" }, message: { ts: "9.9" } }, true);

  assert.equal(activity()[0]!.interaction, "resolved");
  const events = f.log();
  assert.deepEqual(events.map((e) => e.kind), ["approval.requested", "approval.decided"]);
  const decided = events[1]!;
  assert.equal(decided.status, "granted");
  assert.equal(decided.userId, "U2");
  assert.match(decided.title, /^Approved: running the "deployer" subagent/);
  assert.equal(channelHasGrant(join(f.dataDir, "channels", "COPS"), subagentCapability("deployer")), true, "the role is now allowed to run");
});

test("a denial is recorded as denied and grants nothing", async () => {
  const f = appFixture();
  await (HarnessApp.prototype as any).request.call(f.harness, { channelId: "COPS", capability: subagentCapability("deployer"), reason: "Deploy it" });
  const deny = buttonsOf(f.posted[0]!).at(-1)!; // Deny is always last
  await (HarnessApp.prototype as any).decide.call(f.harness, f.client, { actions: [{ value: deny.value, action_id: deny.action_id }], user: { id: "U2" }, message: { ts: "9.9" } }, false);
  const decided = f.log().find((e) => e.kind === "approval.decided")!;
  assert.equal(decided.status, "denied");
  assert.match(decided.title, /^Denied:/);
  assert.equal(channelHasGrant(join(f.dataDir, "channels", "COPS"), subagentCapability("deployer")), false);
});

test("runs a restart cut off are closed as interrupted, once, and finished runs are left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "interrupted-"));
  const log = new ChannelTimelineLog(dir);
  log.record({ kind: "run.start", actor: "coder", runKey: "sub-cut", threadKey: "1.1", title: "coder started", at: "2026-10-18T10:00:00.000Z" });
  log.record({ kind: "run.start", actor: "reviewer", runKey: "sub-fine", title: "reviewer started", at: "2026-10-18T10:00:01.000Z" });
  log.record({ kind: "run.end", actor: "reviewer", runKey: "sub-fine", title: "reviewer done", status: "done", at: "2026-10-18T10:00:02.000Z" });

  const closed = closeInterruptedRuns(log, ["sub-cut", "sub-fine", "sub-unknown"], Date.parse("2026-10-18T10:05:00.000Z"));
  assert.equal(closed, 2, "the finished run is not closed twice");
  const ends = log.read().filter((e) => e.kind === "run.end");
  const cut = ends.find((e) => e.runKey === "sub-cut")!;
  assert.equal(cut.status, "interrupted");
  assert.equal(cut.actor, "coder", "named from the run's own start");
  assert.equal(cut.threadKey, "1.1");
  assert.equal(cut.durationMs, 300_000);
  assert.equal(ends.find((e) => e.runKey === "sub-unknown")!.actor, "subagent");
  assert.equal(closeInterruptedRuns(log, ["sub-cut"]), 0, "running recovery again does not duplicate it");
});
