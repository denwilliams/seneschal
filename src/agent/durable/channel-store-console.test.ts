import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { TurnEventAdapter, type TurnEvent } from "../turn-events.ts";
import { transcriptEntries, type ViewLike } from "../../console2/transcript.ts";
import { DurableChannelStore, type ChannelStoreOptions } from "./channel-store.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "durable-console-"));
  await mkdir(join(root, "workspace"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const opts: ChannelStoreOptions = {
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
  };
  const stores: DurableChannelStore[] = [];
  t.after(async () => { for (const store of stores) await store.close(); await rm(root, { recursive: true, force: true }); });
  const store = await DurableChannelStore.open(opts);
  stores.push(store);
  return { store, faux };
}

const ask = (store: DurableChannelStore, thread: string, text: string) =>
  store.submit(thread, { requestId: `${thread}-${text}`, content: text, userId: "U1" }).then((submission) => store.wait(submission));

test("console reads never create a thread, a fork or a watch target", async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.consoleRoutes(), []);
  assert.equal(await store.consoleTranscript("100.1"), undefined);
  assert.equal(await store.consoleWatch("100.1"), undefined);
  assert.equal(await store.hasThread("100.1"), false, "looking must not fork");
  assert.deepEqual(await store.consoleRoutes(), []);
  assert.equal(await store.consoleTranscript(""), undefined);
  assert.equal(await store.consoleTranscript("x".repeat(500)), undefined);
  assert.equal((await store.consoleBusyThreads()).size, 0);
});

test("console lists threads and subagent runs, reads transcripts, and the trunk is `main`", async (t) => {
  const { store, faux } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("first reply")]);
  await ask(store, "100.1", "hello console");
  await store.openSubagentRun("sub-test-1", { model: { provider: "fixture", modelId: "model" } });
  const routes = await store.consoleRoutes();
  assert.deepEqual(routes.map((route) => route.threadKey).sort(), ["100.1", "sub-test-1"]);
  const thread = routes.find((route) => route.threadKey === "100.1")!;
  assert.ok(thread.forkedFromEntry > 0);
  assert.ok(thread.lastActivityAt > 0);
  assert.equal((await store.listThreads()).length, 1, "listThreads is unchanged: it still leaves runs out");

  const read = (await store.consoleTranscript("100.1"))!;
  assert.equal(read.forkedFromEntry, thread.forkedFromEntry);
  assert.equal(read.model?.modelId, "model");
  const entries = transcriptEntries(read.view as unknown as ViewLike, { redacted: false, forkedFromEntry: read.forkedFromEntry });
  const said = entries.filter((entry) => !entry.inherited);
  assert.deepEqual(said.map((entry) => [entry.role, entry.text]), [["user", "hello console"], ["assistant", "first reply"]]);
  assert.ok(entries.some((entry) => entry.inherited), "the trunk's marker is shown as inherited");

  const main = (await store.consoleTranscript("main"))!;
  assert.equal(main.forkedFromEntry, 0);
  assert.ok(!transcriptEntries(main.view as unknown as ViewLike, { redacted: false, forkedFromEntry: 0 }).some((entry) => entry.text === "hello console"), "threads never write into the trunk");
});

test("console watch streams a live turn without disturbing it, and stops cleanly", async (t) => {
  const { store, faux } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("warm up")]);
  await ask(store, "200.1", "warm up");
  const stream = (await store.consoleWatch("200.1"))!;
  assert.ok(stream);
  const adapter = new TurnEventAdapter();
  const seen: TurnEvent[] = [];
  stream.start(async (events) => { seen.push(...adapter.feed(events)); });
  faux.setResponses([fauxAssistantMessage("watched reply")]);
  await ask(store, "200.1", "second");
  assert.ok(seen.some((event) => event.type === "assistant_message_end"), "the assistant message is delivered");
  await stream.stop();
  assert.equal((await store.consoleBusyThreads()).size, 0, "idle once the turn is done");
});
