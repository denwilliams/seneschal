import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore, RecoveryBlockedError, isSubagentRunKey } from "./durable/channel-store.ts";
import { ThreadToolBindings, adaptPiTools, type BoundThreadTools } from "./durable/pi-tool-adapter.ts";
import type { ChannelRuntime } from "./channel-runtime.ts";
import { recoverChannel, type RecoveryDeps } from "./recovery.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

const channel = { ref: { id: "C1", name: "ops", isDm: false } } as unknown as ResolvedChannel;
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

/** A tool whose behaviour is chosen per binding, so the same schema can hang before a crash and finish after. */
function tools(behaviour: "hang" | "finish", speaker: string, onStart?: () => void): ToolDefinition[] {
  return [defineTool({
    name: "deploy", label: "deploy", description: "an external effect", parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      onStart?.();
      if (behaviour === "finish") return text(`deployed as ${speaker}`);
      await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("closed"))));
      return text("unreachable");
    },
  })];
}
const bound = (definitions: ToolDefinition[]): BoundThreadTools => ({ tools: new Map(definitions.map((tool) => [tool.name, tool])) });

async function scenario(t: TestContext, threadKey = "100.1", user = "U1") {
  const root = await mkdtemp(join(tmpdir(), "recovery-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const base = {
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model", "fixture/other"],
  };
  const open = async (allowed = base.allowedModels) => {
    const bindings = new ThreadToolBindings();
    const store = await DurableChannelStore.open({ ...base, allowedModels: allowed, tools: adaptPiTools(tools("finish", "template"), bindings) });
    opened.push(store);
    const runtime: ChannelRuntime = { channel, store, bindings, disposers: [], jobs: { version: 0 } };
    return runtime;
  };
  const opened: DurableChannelStore[] = [];
  t.after(async () => { for (const store of opened) await store.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });

  // Real interrupted work: turns whose tool call is in flight when the process closes. All of them are
  // started inside ONE store session, because opening a store and submitting anything starts every ready task.
  async function interrupt(entries: { key?: string; speaker?: string; requestId?: string; model?: string; subagent?: boolean; steeringUser?: string; legacySteeringUser?: string }[] = [{}]) {
    const first = await open();
    const started: Promise<void>[] = [];
    for (const entry of entries) {
      const key = entry.key ?? threadKey, speaker = entry.speaker ?? user;
      let signal!: () => void; started.push(new Promise<void>((resolve) => { signal = resolve; }));
      faux.setResponses([fauxAssistantMessage(fauxToolCall("deploy", {}, { id: `c-${key}` }), { stopReason: "toolUse" })]);
      if (entry.subagent) {
        first.store.setThreadProfile(key, { tools: ["deploy"] });
        await first.store.openSubagentRun(key, { model: { provider: "fixture", modelId: "model" } });
      }
      first.bindings.bind(await first.store.conversationIdFor(key), bound(tools("hang", speaker, signal)));
      first.store.setThreadProfile(key, { tools: ["deploy"] });
      if (entry.model) await first.store.setModel(key, { provider: "fixture", modelId: entry.model });
      await first.store.submit(key, { requestId: entry.requestId ?? `${key}-1`, content: "please deploy", userId: speaker });
      await started.at(-1);
      if (entry.steeringUser || entry.legacySteeringUser) {
        await first.store.submit(key, {
          requestId: "steering-1", content: "use the safer approach", userId: entry.steeringUser ?? speaker,
          steeringFor: entry.requestId ?? `${key}-1`,
        });
        if (entry.legacySteeringUser) {
          // Reproduce a receipt written by the previous implementation. New admission
          // refuses this shape; restart must refuse it too, before binding or running tools.
          const requestDoc = defineDocFamily<any, any>({
            kind: "slack.request", version: 1, scope: "conversation", checkpointWhen: () => false, history: "latest", fork: "initial",
            family: true, initial: (seed) => ({ ...seed }),
          });
          const id = await first.store.conversationIdFor(key);
          await (first.store as any).harness.commit(async (tx: any) => {
            (await tx.doc(requestDoc, id, "steering-1", {})).userId = entry.legacySteeringUser;
          }, BACKGROUND_CONTEXT);
        }
      }
    }
    await Promise.all(started);
    await first.store.close();
    opened.splice(opened.indexOf(first.store), 1);
  }
  const deps = (overrides: Partial<RecoveryDeps> = {}): RecoveryDeps & { binds: number } => {
    const state = { binds: 0 };
    return Object.assign(state, {
      isEphemeral: () => false,
      speakerAllowed: () => true,
      async bind(input: { threadKey: string; conversationId: Parameters<ChannelRuntime["bindings"]["bind"]>[0]; userId: string }) {
        state.binds++;
        const rebuilt = bound(tools("finish", input.userId));
        rebuilt.tools.get("deploy");
        (await runtimeRef.current).bindings.bind(input.conversationId, rebuilt);
        (await runtimeRef.current).store.setThreadProfile(input.threadKey, { tools: ["deploy"] });
        return { dispose: async () => undefined };
      },
      ...overrides,
    });
  };
  const runtimeRef: { current: Promise<ChannelRuntime> } = { current: Promise.resolve(undefined as never) };
  return { faux, open, interrupt, deps, runtimeRef };
}

const toolResults = async (store: DurableChannelStore, thread: string) =>
  (await store.transcript(thread)).messages.filter((m) => m.role === "toolResult")
    .map((m) => (m.content as { text: string }[]).map((c) => c.text).join(""));

test("interrupted work resumes only after its tools are rebuilt for the original speaker, and the effect is not repeated", async (t) => {
  const s = await scenario(t, "100.1", "U-original");
  await s.interrupt();
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  s.faux.setResponses([fauxAssistantMessage("I was interrupted; checking before redoing it.")]);
  const outcome = await recoverChannel(runtime, s.deps());
  assert.equal(outcome.resumed, true);
  assert.deepEqual(outcome.recovered, ["100.1"]);
  await runtime.store.waitForIdle();
  const results = await toolResults(runtime.store, "100.1");
  assert.equal(results.length, 1);
  assert.match(results[0]!, /interrupt/i, "an in-flight external effect is reported as interrupted, never silently repeated");
  assert.ok(!results[0]!.includes("deployed as"), "the tool must not have been re-run");
});

test("a speaker who is no longer allowed blocks the channel: nothing runs, even for another thread", async (t) => {
  const s = await scenario(t);
  await s.interrupt();
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  s.faux.setResponses([fauxAssistantMessage("must never be generated")]);
  const outcome = await recoverChannel(runtime, s.deps({ speakerAllowed: () => false }));
  assert.equal(outcome.resumed, false);
  assert.match(outcome.blocked[0]!.reason, /no longer allowed/);
  assert.equal((await runtime.store.inspect()).scheduling, "paused");
  await assert.rejects(
    runtime.store.submit("an-unrelated-thread", { requestId: "x", content: "hello", userId: "U9" }),
    RecoveryBlockedError,
  );
  assert.equal(s.faux.state.callCount, 1, "only the original pre-crash generation ever ran");
  assert.equal((await runtime.store.blocked()).length, 1, "the reason is kept for an operator");
});

test("tools that can no longer be built (revoked permission, removed connector) refuse the recovery", async (t) => {
  const s = await scenario(t);
  await s.interrupt();
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  const outcome = await recoverChannel(runtime, s.deps({ bind: async () => { throw new Error("connector github is no longer configured"); } }));
  assert.equal(outcome.resumed, false);
  assert.match(outcome.blocked[0]!.reason, /could not rebuild tools: connector github/);
  assert.equal((await runtime.store.inspect()).scheduling, "paused");
});

test("a turn from several people cannot be bound to one speaker, so it is blocked", async (t) => {
  const s = await scenario(t);
  await s.interrupt([{ key: "100.1", speaker: "U1", requestId: "r-a" }]);
  const first = await s.open();
  // A second person's request queued behind it, in the same conversation, before the process stopped.
  first.bindings.bind(await first.store.conversationIdFor("100.1"), bound(tools("hang", "U2")));
  await first.store.submit("100.1", { requestId: "r-b", content: "me too", userId: "U2" }).catch(() => undefined);
  await first.store.close();
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  const outcome = await recoverChannel(runtime, s.deps());
  assert.equal(outcome.resumed, false);
  assert.match(outcome.blocked[0]!.reason, /several people|no recorded speaker/);
});

test("an interrupted scheduled run is abandoned while a real thread's work still resumes", async (t) => {
  const s = await scenario(t, "100.1", "U1");
  await s.interrupt([
    { key: "scheduled-abc-1", speaker: "U1", requestId: "sched-1" },
    { key: "100.1", speaker: "U1", requestId: "live-1" },
  ]);
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  s.faux.setResponses([fauxAssistantMessage("carried on")]);
  const outcome = await recoverChannel(runtime, s.deps({ isEphemeral: (key) => key.startsWith("scheduled-") }));
  assert.equal(outcome.resumed, true);
  assert.deepEqual(outcome.abandoned, ["scheduled-abc-1"]);
  assert.deepEqual(outcome.recovered, ["100.1"]);
  await runtime.store.waitForIdle();
  assert.equal((await runtime.store.liveRoutes()).length, 0, "nothing is left half-run");
});

test("a model that is no longer allowed keeps the channel paused rather than dispatching", async (t) => {
  const s = await scenario(t);
  await s.interrupt([{ model: "other" }]);
  // The channel's default stays allowed (a store will not even open otherwise); the thread's own model is revoked.
  const runtime = await s.open(["fixture/model"]); s.runtimeRef.current = Promise.resolve(runtime);
  const outcome = await recoverChannel(runtime, s.deps());
  assert.equal(outcome.resumed, false);
  assert.match(outcome.blocked[0]!.reason, /resume refused: .*not allowed/i);
  assert.equal((await runtime.store.inspect()).scheduling, "paused");
});

test("an operator can discard everything interrupted; the channel then works again", async (t) => {
  const s = await scenario(t);
  await s.interrupt();
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  await recoverChannel(runtime, s.deps({ speakerAllowed: () => false }));
  await assert.rejects(runtime.store.submit("other", { requestId: "x", content: "hi", userId: "U" }), RecoveryBlockedError);
  assert.equal(await runtime.store.discardInterrupted(), 1);
  assert.equal((await runtime.store.blocked()).length, 0);
  s.faux.setResponses([fauxAssistantMessage("back to normal")]);
  runtime.bindings.bind(await runtime.store.conversationIdFor("other"), bound(tools("finish", "U")));
  assert.equal((await runtime.store.wait(await runtime.store.submit("other", { requestId: "y", content: "hi", userId: "U" }))).text, "back to normal");
});

test("a channel with nothing interrupted just resumes", async (t) => {
  const s = await scenario(t);
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  const outcome = await recoverChannel(runtime, s.deps());
  assert.deepEqual({ ...outcome, blocked: outcome.blocked.length }, { resumed: true, recovered: [], requests: [], abandoned: [], blocked: 0, factoryRuns: { resumed: [], aborted: [] }, jobs: { resumed: [], aborted: [] } });
});

test("an interrupted subagent run is abandoned, never resumed, while the thread that started it still recovers", async (t) => {
  const s = await scenario(t, "100.1", "U1");
  await s.interrupt([
    { key: "sub-run-1", speaker: "U1", requestId: "sub-1", subagent: true },
    { key: "100.1", speaker: "U1", requestId: "live-1" },
  ]);
  const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
  s.faux.setResponses([fauxAssistantMessage("carried on")]);
  const deps = s.deps({ isEphemeral: (key) => isSubagentRunKey(key) });
  const outcome = await recoverChannel(runtime, deps);
  assert.equal(outcome.resumed, true);
  assert.deepEqual(outcome.abandoned, ["sub-run-1"]);
  assert.deepEqual(outcome.recovered, ["100.1"]);
  assert.equal(deps.binds, 1, "tools are rebuilt for the thread, and never for the subagent run");
  await runtime.store.waitForIdle();
  assert.equal((await runtime.store.liveRoutes()).length, 0);
  assert.deepEqual((await runtime.store.listThreads()).map((thread) => thread.threadKey), ["100.1"], "a run is not a thread");
});

for (const steeringAllowed of [true, false]) {
  test(`recovery groups same-author steering under one original reply and revalidates its author (allowed=${steeringAllowed})`, async (t) => {
    const s = await scenario(t, "100.1", "U-owner");
    await s.interrupt([{ steeringUser: "U-owner" }]);
    const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
    s.faux.setResponses([fauxAssistantMessage("Resumed with steering.")]);
    const binds: string[] = [];
    const deps = s.deps({ speakerAllowed: () => steeringAllowed });
    const bind = deps.bind;
    deps.bind = async (input) => { binds.push(input.userId); return bind(input); };
    const outcome = await recoverChannel(runtime, deps);
    assert.equal(outcome.resumed, steeringAllowed);
    if (!steeringAllowed) {
      assert.match(outcome.blocked[0]!.reason, /steering author/);
      assert.deepEqual(binds, []);
      return;
    }
    assert.deepEqual(binds, ["U-owner"], "steering must not rebind tools to another author");
    assert.deepEqual(outcome.requests.map((request) => request.requestId), ["100.1-1"]);
    assert.deepEqual(await runtime.store.awaitRequest(outcome.requests[0]!.conversationId, "100.1-1"), { text: "Resumed with steering." });
    assert.deepEqual(await runtime.store.requestOutcome("100.1", "100.1-1"), { status: "answered", text: "Resumed with steering." });
    const calls = s.faux.state.callCount;
    assert.equal(await runtime.store.steeringParent("100.1", "steering-1"), "100.1-1");
    await runtime.store.waitForIdle();
    assert.equal(s.faux.state.callCount, calls, "redelivery cannot replay already-consumed steering after restart");
  });
}

for (const steeringAllowed of [true, false]) {
  test(`recovery refuses legacy cross-author steering before tool binding (channel allowed=${steeringAllowed})`, async (t) => {
    const s = await scenario(t, "100.1", "U-owner");
    await s.interrupt([{ legacySteeringUser: "U-steerer" }]);
    const runtime = await s.open(); s.runtimeRef.current = Promise.resolve(runtime);
    const calls = s.faux.state.callCount;
    const deps = s.deps({ speakerAllowed: (id) => id === "U-owner" || steeringAllowed });
    const outcome = await recoverChannel(runtime, deps);
    assert.equal(outcome.resumed, false);
    assert.match(outcome.blocked[0]!.reason, /cross-author steering|steering author/);
    assert.equal(deps.binds, 0, "neither person's credentials/approval principal may be bound");
    assert.equal(s.faux.state.callCount, calls, "no tool/model execution on unsafe recovery");
    await assert.rejects(runtime.store.steeringParent("100.1", "steering-1"), /paused|Cross-author/);
  });
}
