import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore } from "./channel-store.ts";

test("a real 1.3 SQLite store migrates, preserves state and receipts, and never replays its interrupted unsafe tool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "durable-upgrade-"));
  const workspace = join(root, "workspace"), storageDir = join(root, "store");
  await mkdir(workspace); await mkdir(storageDir);
  const path = join(storageDir, "conversations.sqlite");
  const old = new DatabaseSync(path);
  const sql = await readFile(new URL("./fixtures/pi-durable-1.3.0.sql", import.meta.url), "utf8");
  old.exec(sql.replaceAll("__WORKSPACE__", workspace));
  assert.equal(old.prepare("SELECT version FROM durable_schema").get()!.version, 1);
  old.close();
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  let effects = 0;
  const options = { storageDir, workspace, channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
    tools: [{ name: "mutation", description: "Test mutation", parameters: Type.Object({}), execute: async () => {
      effects++; return { output: [{ type: "text" as const, text: "must not replay" }] };
    } }],
  };
  let store: DurableChannelStore | undefined;
  t.after(async () => { await store?.close(); await rm(root, { recursive: true, force: true }); });
  store = await DurableChannelStore.open(options);
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.equal(migrated.prepare("SELECT version FROM durable_schema").get()!.version, 2);
  migrated.close();
  assert.equal((await store.inspect()).scheduling, "paused");
  assert.equal(effects, 0); assert.equal(faux.state.callCount, 0);
  assert.equal((await store.stateSnapshot()).value.retained, "from 1.3.0");
  const completed = await store.submit("thread", { requestId: "old-complete", content: "old question", userId: "U1" });
  assert.equal((await store.wait(completed)).text, "old answer");
  faux.setResponses([fauxAssistantMessage("interrupted mutation needs review")]);
  const pending = await store.submit("thread", { requestId: "old-pending", content: "do mutation", userId: "U1" });
  assert.equal((await store.wait(pending)).text, "interrupted mutation needs review");
  assert.equal(effects, 0); assert.equal(faux.state.callCount, 1);
  await store.close(); store = await DurableChannelStore.open(options);
  const duplicate = await store.submit("thread", { requestId: "old-pending", content: "do mutation", userId: "U1" });
  assert.equal(duplicate.id, pending.id);
  assert.equal((await store.wait(duplicate)).text, "interrupted mutation needs review");
  assert.equal((await store.stateSnapshot()).value.retained, "from 1.3.0");
  assert.equal(effects, 0); assert.equal(faux.state.callCount, 1);
});
