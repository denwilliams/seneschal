import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ModelRuntime, defineTool } from "@earendil-works/pi-coding-agent";
import { defaultPiAuthPath, resolveAuthPath } from "../credentials.ts";
import { DurableChannelStore } from "./channel-store.ts";
import { ThreadToolBindings, adaptPiTools } from "./pi-tool-adapter.ts";
import { TurnEventAdapter, type TurnEvent } from "../turn-events.ts";

/**
 * Opt-in: talks to a REAL model and costs a few hundred tokens. Run with, for example,
 *   HARNESS_LIVE_MODEL=openai-codex/gpt-6-luna npm test -- ...live.test.ts
 * Credentials come from HARNESS_AUTH_PATH or the default `pi` login (read through ModelRuntime, never copied).
 * Not every catalog model is usable on every login (a ChatGPT-account Codex login refuses some).
 */
const ref = process.env.HARNESS_LIVE_MODEL;

test("a real model: streamed turn, a real tool call, and a thread forked after a trunk digest", { skip: !ref, timeout: 150_000 }, async (t) => {
  const [provider, ...rest] = ref!.split("/");
  const runtime = await ModelRuntime.create({ authPath: process.env.HARNESS_AUTH_PATH ? resolveAuthPath(undefined, tmpdir()) : defaultPiAuthPath(), refreshOnCreate: false });
  const root = await mkdtemp(join(tmpdir(), "live-"));
  await mkdir(join(root, "workspace"));
  let echoed = "";
  const definitions = [defineTool({
    name: "echo", label: "echo", description: "Echo back the given text. Use it when asked to.", parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params: { text: string }) => { echoed = params.text; return { content: [{ type: "text" as const, text: `echoed:${params.text}` }], details: undefined }; },
  })];
  const bindings = new ThreadToolBindings();
  const store = await DurableChannelStore.open({
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "CLIVE", models: runtime,
    model: { provider: provider!, modelId: rest.join("/") }, allowedModels: [ref!], instructions: "You are a terse test assistant.",
    tools: adaptPiTools(definitions, bindings),
  });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  async function turn(thread: string, text: string) {
    bindings.bind(await store.conversationIdFor(thread), { tools: new Map(definitions.map((d) => [d.name, d])) });
    const adapter = new TurnEventAdapter(); const events: TurnEvent[] = [];
    const watch = await store.watch(thread);
    watch.start(async (batch) => { events.push(...adapter.feed(batch)); });
    const result = await store.wait(await store.submit(thread, { requestId: `${thread}-${Date.now()}`, content: text, userId: "U1" }));
    await watch.stop();
    return { text: result.text, events };
  }

  const greeting = await turn("t1", "Say hello in exactly three words.");
  assert.ok(greeting.text.trim().length > 0, "a streamed answer came back");
  const ends = greeting.events.filter((e) => e.type === "assistant_message_end") as { message: { usage?: { totalTokens?: number } } }[];
  assert.ok(ends.length > 0 && (ends.at(-1)!.message.usage?.totalTokens ?? 0) > 0, "usage is readable from the final message");

  const tool = await turn("t2", "Call the echo tool with text 'ping', then reply with the single word DONE.");
  assert.equal(echoed, "ping", "the model's tool call reached the thread's bound tool");
  assert.match(tool.text, /done/i);

  await store.appendMainContext("slack.thread.digest", "[recent thread t1] the secret codeword is PELICAN");
  const forked = await turn("t3", "What is the secret codeword mentioned in your context? Answer with one word.");
  assert.match(forked.text, /pelican/i, "a thread forked after the digest inherits the channel's shared context");
});
