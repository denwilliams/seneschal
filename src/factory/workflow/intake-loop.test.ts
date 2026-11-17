import assert from "node:assert/strict";
import { test } from "node:test";
import { IntakeLoop, type IntakeTarget } from "./intake-loop.ts";
import type { IntakeOutcome } from "./intake.ts";

/** The poll loop with a clock the test drives: nothing here waits for real time. */

function rig(options: { targets?: IntakeTarget[]; outcome?: () => Promise<IntakeOutcome | undefined> | IntakeOutcome | undefined } = {}) {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const polls: string[] = [];
  const state = { targets: options.targets ?? [{ channelId: "C1", intervalSeconds: 120 }], gate: undefined as Promise<void> | undefined };
  const loop = new IntakeLoop({
    targets: () => state.targets,
    poll: async (channelId) => { polls.push(channelId); await state.gate; return options.outcome ? options.outcome() : { repos: [], failed: false }; },
    schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    random: () => 0.5,
  });
  const live = () => timers.filter((timer) => !timer.cancelled);
  /** Fire the newest live timer and wait for the poll it starts. */
  const fire = async () => { const timer = live().at(-1)!; timer.cancelled = true; timer.fn(); await loop.idle(); await new Promise((resolve) => setImmediate(resolve)); };
  return { loop, timers, polls, state, live, fire };
}

test("reconcile starts a loop for each channel with intake, polls soon, then every interval (jittered), and never overlaps", async () => {
  const r = rig();
  await r.loop.reconcile();
  assert.deepEqual(r.loop.channels(), ["C1"]);
  assert.equal(r.live().length, 1);
  assert.equal(r.live()[0]!.ms, 15_000, "the first poll is soon after start");
  await r.fire();
  assert.deepEqual(r.polls, ["C1"]);
  assert.equal(r.live().at(-1)!.ms, 120_000, "then the interval; the jitter here is exactly zero at the midpoint");
  r.loop.stop();
});

test("a poll asked for while one runs does not overlap: it runs once more straight after", async () => {
  const r = rig();
  await r.loop.reconcile();
  let release!: () => void;
  r.state.gate = new Promise<void>((resolve) => { release = resolve; });
  const firing = r.fire();
  await new Promise((resolve) => setImmediate(resolve));
  r.loop.pollNow("C1");
  r.loop.pollNow("C1");
  assert.deepEqual(r.polls, ["C1"], "still the first poll: nothing started beside it");
  r.state.gate = undefined;
  release();
  await firing;
  await r.loop.idle();
  await new Promise((resolve) => setImmediate(resolve));
  const next = r.live().at(-1)!;
  assert.equal(next.ms, 0, "one more poll is queued at once");
  await r.fire();
  assert.deepEqual(r.polls, ["C1", "C1"], "the two requests were one poll");
  r.loop.stop();
});

test("pollNow arms an immediate poll when idle, and ignores a channel without a loop", async () => {
  const r = rig();
  await r.loop.reconcile();
  r.loop.pollNow("C9");
  assert.equal(r.live().length, 1);
  r.loop.pollNow("C1");
  assert.equal(r.live().at(-1)!.ms, 0);
  await r.fire();
  assert.deepEqual(r.polls, ["C1"]);
  r.loop.stop();
});

test("a failing poll backs the channel off, doubling; a good one resets it", async () => {
  let failing = true;
  const r = rig({ outcome: () => ({ repos: [], failed: failing }) });
  await r.loop.reconcile();
  await r.fire();
  const first = r.live().at(-1)!.ms;
  await r.fire();
  const second = r.live().at(-1)!.ms;
  assert.equal(first, 240_000);
  assert.equal(second, 480_000);
  failing = false;
  await r.fire();
  assert.equal(r.live().at(-1)!.ms, 120_000);
  r.loop.stop();
});

test("a poll that throws is a failure like any other and never escapes", async () => {
  const r = rig({ outcome: () => { throw new Error("boom"); } });
  await r.loop.reconcile();
  await r.fire();
  assert.equal(r.live().at(-1)!.ms, 240_000);
  r.loop.stop();
});

test("reconcile on a config change: a channel losing intake stops, a new one starts, a new interval re-times", async () => {
  const r = rig({ targets: [{ channelId: "C1", intervalSeconds: 120 }, { channelId: "C2", intervalSeconds: 120 }] });
  await r.loop.reconcile();
  assert.deepEqual(r.loop.channels().sort(), ["C1", "C2"]);
  r.state.targets = [{ channelId: "C2", intervalSeconds: 300 }, { channelId: "C3", intervalSeconds: 60 }];
  const before = r.live().length;
  await r.loop.reconcile();
  assert.deepEqual(r.loop.channels().sort(), ["C2", "C3"]);
  assert.ok(r.live().length <= before + 1);
  // C1's timer was cancelled: only C2's (re-timed to 300 s) and C3's remain live.
  assert.deepEqual(r.live().map((timer) => timer.ms).sort((a, b) => a - b), [15_000, 300_000]);
  r.loop.pollNow("C1");
  assert.equal(r.polls.length, 0, "a channel that lost intake is not polled");
  r.loop.stop();
});

test("stop cancels everything: no timer stays live, and nothing polls afterwards", async () => {
  const r = rig({ targets: [{ channelId: "C1", intervalSeconds: 60 }, { channelId: "C2", intervalSeconds: 60 }] });
  await r.loop.reconcile();
  r.loop.stop();
  assert.equal(r.live().length, 0);
  assert.deepEqual(r.loop.channels(), []);
  r.loop.pollNow("C1");
  await r.loop.reconcile();
  assert.deepEqual([r.live().length, r.polls.length], [0, 0]);
});

test("a configuration that cannot be read leaves the loops as they were", async () => {
  const r = rig();
  await r.loop.reconcile();
  r.state.targets = undefined as unknown as IntakeTarget[];
  const loop = new IntakeLoop({ targets: () => { throw new Error("no config"); }, poll: async () => undefined, schedule: () => () => {} });
  await loop.reconcile();
  assert.deepEqual(loop.channels(), []);
  assert.deepEqual(r.loop.channels(), ["C1"]);
  r.loop.stop();
});
