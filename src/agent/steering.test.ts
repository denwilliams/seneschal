import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnSteering, type SteeringInput } from "./steering.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const input = (id: string): SteeringInput => ({ requestId: id, userId: "U1", messageTs: "1.2", prepare: async () => ({ text: id }) });

test("startup inputs are admitted in order, once each, without waiting for earlier answers", async () => {
  const turn = new TurnSteering();
  const a = turn.offer(input("a"));
  const duplicate = turn.offer(input("a"));
  const b = turn.offer(input("b"));
  const first = deferred<{ text: string }>();
  const second = deferred<{ text: string }>();
  const seen: string[] = [];
  turn.start(async (item) => {
    seen.push(item.requestId);
    return { completion: item.requestId === "a" ? first.promise : second.promise };
  });
  assert.deepEqual(await Promise.all([a, duplicate, b]), [true, true, true]);
  assert.deepEqual(seen, ["a", "b"]);
  const done = turn.finish();
  second.resolve({ text: "second" }); first.resolve({ text: "first" });
  assert.equal(await done, "second", "arrival order wins, not wait resolution order");
  assert.equal(await turn.offer(input("late")), false);
  assert.equal(await turn.offer(input("a")), true, "a retry remains consumed after close");
});

test("an arrival during the completion wait is drained before atomically closing", async () => {
  const turn = new TurnSteering();
  const first = deferred<{ text: string }>();
  turn.start(async (item) => ({ completion: item.requestId === "a" ? first.promise : Promise.resolve({ text: "late steering" }) }));
  await turn.offer(input("a"));
  const done = turn.finish();
  await turn.offer(input("boundary"));
  first.resolve({ text: "original" });
  assert.equal(await done, "late steering");
  assert.equal(await turn.offer(input("after")), false);
});

test("startup failure and unsupported admission explicitly return input to fallback", async () => {
  const startup = new TurnSteering();
  const pending = startup.offer(input("a"));
  startup.close();
  assert.equal(await pending, false);
  const unsupported = new TurnSteering();
  unsupported.start(async () => { throw new Error("unavailable"); });
  assert.equal(await unsupported.offer(input("b")), false);
  assert.equal(await unsupported.finish(), undefined);
});

test("completion failure is surfaced, not retried as another input", async () => {
  const turn = new TurnSteering();
  turn.start(async () => ({ completion: Promise.reject(new Error("model failed")) }));
  assert.equal(await turn.offer(input("a")), true);
  await assert.rejects(turn.finish(), /model failed/);
  assert.equal(await turn.offer(input("a")), true);
});

test("failure cancellation waits for in-flight admission before aborting native work", async () => {
  const turn = new TurnSteering();
  const admitted = deferred<void>(), completed = deferred<{ text: string }>();
  let nativeAbort = false;
  turn.start(async () => { await admitted.promise; return { completion: completed.promise }; });
  const accepted = turn.offer(input("a"));
  await Promise.resolve();
  const cancelled = turn.cancel(async () => { nativeAbort = true; completed.resolve({ text: "aborted" }); });
  assert.equal(nativeAbort, false);
  admitted.resolve();
  assert.equal(await accepted, true);
  await cancelled;
  assert.equal(nativeAbort, true);
  assert.equal(await turn.offer(input("late")), false);
});
