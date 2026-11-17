import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Models } from "@earendil-works/pi-ai";
import type { TaskInspection } from "@earendil-works/pi-durable";
import { modelPolicy } from "./model-policy.ts";

function fixture() {
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "revoked" }, { id: "allowed" }] });
  const models = createModels(); models.setProvider(faux.provider);
  return { models, faux, revoked: models.getModel("fixture", "revoked")!, allowed: models.getModel("fixture", "allowed")! };
}
function task(kind: string, checkpoint: object, version = 1): TaskInspection {
  return { record: { kind, version, state: { status: "pending", checkpoint } }, state: { kind: "pending", migrates: false } } as TaskInspection;
}

test("all actual Models dispatch operations reject revoked models before underlying invocation", async () => {
  const f = fixture(); let invoked = 0;
  const operations = ["stream", "complete", "streamSimple", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "generateImages", "classify"] as const;
  const tracked: Models = new Proxy(f.models, { get(target, key) {
    if (operations.includes(key as typeof operations[number])) return () => { invoked++; throw new Error("underlying provider invoked"); };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const policy = modelPolicy(tracked, ["fixture/allowed"]);
  for (const operation of operations) {
    assert.throws(() => Reflect.apply(policy.models[operation], policy.models, [f.revoked, {}]), /not allowed/);
  }
  assert.equal(invoked, 0);
  assert.throws(() => policy.models.streamDeferred(f.allowed, { provider: "fixture", modelId: "revoked", api: "faux", id: "pending" }), /not allowed/);
  assert.throws(() => policy.models.fetchDeferred(f.allowed, { provider: "other", modelId: "allowed", api: "faux", id: "pending" }), /not allowed/);
  assert.equal(invoked, 0);
  f.faux.setResponses([fauxAssistantMessage("allowed")]);
  await policy.models.streamSimple(f.allowed, { messages: [] }).result();
  // Even legitimate transports cannot re-enter an opaque Models implementation.
  assert.equal(invoked, 0);
  assert.equal(f.faux.state.callCount, 1);
});

test("provider access is guarded too; allowed facade calls preserve the credential owner", async () => {
  const f = fixture(); const policy = modelPolicy(f.models, ["fixture/allowed"]);
  for (const provider of [policy.models.getProvider("fixture")!, ...policy.models.getProviders()]) {
    assert.throws(() => provider.streamSimple(f.revoked, { messages: [] } as never), /not allowed/);
  }
  const other = fauxProvider({ provider: "other", models: [{ id: "revoked" }] });
  f.models.setProvider(other.provider);
  assert.throws(() => policy.models.getProvider("other")!.streamSimple(f.allowed, { messages: [] } as never), /Provider\/model mismatch/);
  assert.equal(other.state.callCount, 0);
  assert.equal(f.faux.state.callCount, 0);
  f.faux.setResponses([fauxAssistantMessage("allowed")]);
  const result = await policy.models.completeSimple(f.allowed, { messages: [] });
  assert.equal(result.content[0]?.type, "text");
  assert.equal(f.faux.state.callCount, 1);
});

test("all pinned generation/poll/compaction checkpoints and deferred handles are validated", () => {
  const f = fixture(); const policy = modelPolicy(f.models, ["fixture/allowed"]);
  const model = { provider: "fixture", modelId: "revoked" };
  for (const [kind, phase] of [["pi.generation", "request"], ["pi.generation", "poll"], ["pi.compaction", "summarize"], ["pi.compaction", "retry"]]) {
    assert.throws(() => policy.checkCheckpoint(task(kind!, { phase, model })), /not allowed/);
    assert.throws(() => policy.checkCheckpoint(task(kind!, { phase })), /Missing pinned model/);
  }
  assert.throws(() => policy.checkCheckpoint(task("pi.generation", { phase: "poll", model: { provider: "fixture", modelId: "allowed" }, handle: model })), /not allowed/);
  for (const kind of ["pi.generation", "pi.compaction"]) {
    assert.throws(() => policy.checkCheckpoint(task(kind, { phase: "new-upstream-phase" })), /Unsupported/);
    assert.throws(() => policy.checkCheckpoint(task(kind, { phase: "prepare" }, 99)), /Unsupported/);
  }
  for (const phase of ["prepare", "tools", "retry"]) policy.checkCheckpoint(task("pi.generation", { phase }));
  policy.checkCheckpoint(task("pi.compaction", { phase: "select" }));
});

test("generation v2 recovery accepts known phases and checks sleeping deferred retries before dispatch", () => {
  const f = fixture(); const policy = modelPolicy(f.models, ["fixture/allowed"]);
  const allowed = { provider: "fixture", modelId: "allowed" };
  const revoked = { provider: "fixture", modelId: "revoked" };
  for (const phase of ["prepare", "tools", "finish", "drain"]) policy.checkCheckpoint(task("pi.generation", { phase }, 2));
  policy.checkCheckpoint(task("pi.generation", { phase: "request", model: allowed }, 2));
  assert.throws(() => policy.checkCheckpoint(task("pi.generation", { phase: "request", model: revoked }, 2)), /not allowed/);
  const retry = (poll: object) => {
    const value = task("pi.generation", { phase: "retry", until: 9999, poll }, 2);
    return { ...value, record: { ...value.record, state: { status: "sleeping", until: 9999, checkpoint: { phase: "retry", poll } } } } as TaskInspection;
  };
  policy.checkCheckpoint(retry({ model: allowed, handle: allowed }));
  assert.throws(() => policy.checkCheckpoint(retry({ model: revoked, handle: revoked })), /not allowed/);
  assert.throws(() => policy.checkCheckpoint(retry({ model: allowed, handle: revoked })), /not allowed/);
  assert.throws(() => policy.checkCheckpoint(retry({})), /Missing pinned model/);
});
