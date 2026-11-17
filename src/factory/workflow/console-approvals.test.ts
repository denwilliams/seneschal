import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleMergeApprovals, MERGE_VERIFICATION_MS } from "./console-approvals.ts";
import { emptyFactoryRun } from "./docs.ts";

function fixture() {
  let now = 1000;
  let allowed = true;
  let failPost = false;
  const run = emptyFactoryRun("fr_test");
  Object.assign(run, { status: "waiting", wait: { kind: "merge", since: 999 }, pr: { reviewedHead: "abc123", number: 12 } });
  const posted: { id: string; challenge: string; channelId: string }[] = [];
  const manager = new ConsoleMergeApprovals({
    now: () => now, run: async (channel, id) => channel === "C1" && id === run.runId ? run : undefined,
    allowed: (_channel, _run, user) => allowed && user === "U1",
    post: async (value) => { if (failPost) throw Error("delivery failed"); posted.push(value); },
  });
  return { manager, run, posted, expire: () => { now += MERGE_VERIFICATION_MS; }, revoke: () => { allowed = false; }, fail: () => { failPost = true; } };
}

test("only the matching browser gets a run-scoped identity from an authorized Slack confirmation; verification is not a decision", async () => {
  const f = fixture();
  const { browser, challenge } = await f.manager.request("C1", "fr_test");
  assert.equal(challenge, f.posted[0]!.challenge);
  assert.notEqual(browser, f.posted[0]!.id, "Slack never receives the browser bearer cookie");
  assert.equal((await f.manager.status(browser, "C1", "fr_test")).view.state, "pending");
  for (const [id, user, channel] of [[browser, "U1", "C1"], [f.posted[0]!.id, "U2", "C1"], [f.posted[0]!.id, "U1", "C2"]]) {
    assert.equal(await f.manager.confirm(id!, user!, channel!), false);
  }
  assert.equal(await f.manager.confirm(f.posted[0]!.id, "U1", "C1"), true);
  assert.equal(await f.manager.confirm(f.posted[0]!.id, "U1", "C1"), false, "one-use Slack callback");
  assert.deepEqual((await f.manager.status(browser, "C1", "fr_test")).identity, { userId: "U1", runId: "fr_test", head: "abc123", since: 999 });
  assert.equal((await f.manager.status("forged", "C1", "fr_test")).identity, undefined);
  assert.equal((await f.manager.status(browser, "C2", "fr_test")).identity, undefined);
  assert.equal((await f.manager.status(browser, "C1", "fr_other")).identity, undefined);
  assert.equal(f.run.status, "waiting");
});

test("expiry, permission revocation, changed reviewed commit, a new wait and completion invalidate verification", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.expire(), (f: ReturnType<typeof fixture>) => f.revoke(),
    (f: ReturnType<typeof fixture>) => { f.run.pr.reviewedHead = "different"; },
    (f: ReturnType<typeof fixture>) => { f.run.wait.since++; }, (f: ReturnType<typeof fixture>) => { f.run.status = "completed"; }]) {
    const f = fixture();
    const { browser } = await f.manager.request("C1", "fr_test");
    await f.manager.confirm(f.posted[0]!.id, "U1", "C1");
    mutate(f);
    assert.deepEqual(await f.manager.status(browser, "C1", "fr_test"), { view: { state: "unverified" } });
    assert.equal(await f.manager.confirm(f.posted[0]!.id, "U1", "C1"), false);
  }
});

test("only a merge wait with a reviewed head can request verification, and failed Slack delivery leaves no usable challenge", async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.manager.request("C1", "fr_test"), /could not be delivered/);
  f.run.wait.kind = "deploy";
  await assert.rejects(f.manager.request("C1", "fr_test"), /not waiting for merge approval/);
  await assert.rejects(f.manager.request("C2", "fr_test"), /not waiting for merge approval/);
});
