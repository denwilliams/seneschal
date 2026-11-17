import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { WebClient } from "@slack/web-api";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore } from "../agent/durable/channel-store.ts";
import { ThreadToolBindings, adaptPiTools } from "../agent/durable/pi-tool-adapter.ts";
import { recoverChannel } from "../agent/recovery.ts";
import type { ChannelRuntime } from "../agent/channel-runtime.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { deliverRecoveredRequest } from "./delivery.ts";

/**
 * The whole recovery path against a REAL crash: a process is SIGKILLed in the middle of a tool call (its effect has
 * already happened), a fresh process opens the store, the recovery gate rebuilds the thread's tools, the turn
 * resumes without repeating the effect, and the answer reaches Slack exactly once.
 */

function slack() {
  const thread: { ts: string; text: string; metadata?: unknown }[] = [];
  const client = {
    chat: {
      postMessage: async (args: { text: string; metadata?: unknown }) => { const m = { ts: `400.${thread.length + 1}`, text: args.text, ...(args.metadata ? { metadata: args.metadata } : {}) }; thread.push(m); return { ok: true, ts: m.ts }; },
      update: async (args: { ts: string; text: string }) => { thread.find((m) => m.ts === args.ts)!.text = args.text; return { ok: true }; },
    },
    conversations: { replies: async () => ({ ok: true, messages: thread }) },
  } as unknown as WebClient;
  return { client, thread };
}

async function killedMidTool(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "recovery-kill-"));
  await mkdir(join(root, "workspace"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = fork(fileURLToPath(new URL("../agent/durable/fixtures/crash-child.ts", import.meta.url)), [root, "tool"], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child, "message");          // the tool has run and its effect is recorded
  child.kill("SIGKILL"); await once(child, "exit");
  return root;
}

test("a process killed mid-tool is recovered by a fresh one: effect not repeated, answer delivered to Slack once", { timeout: 40_000 }, async (t) => {
  const root = await killedMidTool(t);
  assert.equal(readFileSync(join(root, "effects"), "utf8"), "executed\n", "the effect happened before the kill");

  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  let reran = 0;
  const tool = defineTool({ name: "mutation", label: "mutation", description: "Test mutation", parameters: Type.Object({}),
    execute: async () => { reran++; return { content: [{ type: "text" as const, text: "again" }], details: undefined }; } });
  const bindings = new ThreadToolBindings();
  const store = await DurableChannelStore.open({
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"], tools: adaptPiTools([tool], bindings),
  });
  t.after(() => store.close());
  const runtime: ChannelRuntime = { channel: { ref: { id: "C1" } } as unknown as ResolvedChannel, store, bindings, disposers: [], jobs: { version: 0 } };

  // The fresh process holds the store paused until the gate has run.
  assert.equal((await store.inspect()).scheduling, "paused");
  faux.setResponses([fauxAssistantMessage("The deploy may or may not have finished; I will check before redoing it.")]);
  const outcome = await recoverChannel(runtime, {
    isEphemeral: () => false, speakerAllowed: () => true,
    bind: async ({ threadKey, conversationId }) => {
      bindings.bind(conversationId, { tools: new Map([[tool.name, tool]]) });
      store.setThreadProfile(threadKey, { tools: ["mutation"] });
      return { dispose: async () => undefined };
    },
  });
  assert.equal(outcome.resumed, true);
  assert.deepEqual(outcome.requests.map((r) => r.requestId), ["event-1"]);

  const s = slack();
  const [request] = outcome.requests;
  await deliverRecoveredRequest({ store, client: s.client, channel: "C1", conversationId: request!.conversationId, threadKey: request!.threadKey, threadTs: "1.1", requestId: request!.requestId });
  assert.equal(s.thread.length, 1, "exactly one reply");
  assert.match(s.thread[0]!.text, /Resumed after a restart/);
  assert.match(s.thread[0]!.text, /may or may not have finished/);
  assert.equal(reran, 0, "the interrupted effect was never run again");
  assert.equal(readFileSync(join(root, "effects"), "utf8"), "executed\n", "one effect on disk, not two");
  assert.ok(existsSync(join(root, "store")));
});
