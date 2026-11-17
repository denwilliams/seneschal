import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DurableChannelStore } from "./channel-store.ts";
import { ThreadToolBindings, adaptPiTools, type BoundThreadTools } from "./pi-tool-adapter.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

function speakerTools(speaker: string): ToolDefinition[] {
  return [
    defineTool({ name: "whoami", label: "whoami", description: "who is speaking", parameters: Type.Object({}),
      execute: async () => text(`speaker=${speaker}`) }),
    defineTool({ name: "read", label: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params: { path: string }) => text(`opened ${params.path}`) }),
    defineTool({ name: "boom", label: "boom", description: "always fails", parameters: Type.Object({}),
      execute: async () => { throw new Error("kaboom"); } }),
  ];
}
const bound = (speaker: string, jail?: BoundThreadTools["jail"]): BoundThreadTools => ({
  tools: new Map(speakerTools(speaker).map((tool) => [tool.name, tool])), ...(jail ? { jail } : {}),
});

async function fixture(t: TestContext, rebuild?: ConstructorParameters<typeof ThreadToolBindings>[0]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adapter-")));
  await mkdir(join(root, "workspace")); await mkdir(join(root, "elsewhere"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const models = createModels(); models.setProvider(faux.provider);
  const bindings = new ThreadToolBindings(rebuild);
  const store = await DurableChannelStore.open({
    storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
    model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
    tools: adaptPiTools(speakerTools("template"), bindings),
  });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, faux, bindings, store };
}
const toolResults = async (store: DurableChannelStore, thread: string) =>
  (await store.transcript(thread)).messages.filter((m) => m.role === "toolResult")
    .map((m) => ({ text: (m.content as { text: string }[]).map((c) => c.text).join(""), isError: (m as { isError?: boolean }).isError }));
async function run(f: Awaited<ReturnType<typeof fixture>>, thread: string, calls: ReturnType<typeof fauxToolCall>[]) {
  f.faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  await f.store.wait(await f.store.submit(thread, { requestId: `${thread}-1`, content: "go", userId: "U" }));
}

test("a store-wide registration dispatches to the tool set bound to the CALLING conversation", async (t) => {
  const f = await fixture(t);
  f.bindings.bind(await f.store.conversationIdFor("alice-thread"), bound("alice"));
  f.bindings.bind(await f.store.conversationIdFor("bob-thread"), bound("bob"));
  await run(f, "alice-thread", [fauxToolCall("whoami", {}, { id: "c1" })]);
  await run(f, "bob-thread", [fauxToolCall("whoami", {}, { id: "c2" })]);
  assert.deepEqual((await toolResults(f.store, "alice-thread")).map((r) => r.text), ["speaker=alice"]);
  assert.deepEqual((await toolResults(f.store, "bob-thread")).map((r) => r.text), ["speaker=bob"]);
});

test("a conversation with no binding fails closed with an error result, never ambient authority", async (t) => {
  const f = await fixture(t);
  await run(f, "orphan", [fauxToolCall("whoami", {}, { id: "c1" })]);
  const [result] = await toolResults(f.store, "orphan");
  assert.equal(result?.isError, true);
  assert.match(result!.text, /not available in this conversation/);
});

test("an unbound conversation is rebuilt through the recovery hook, which may refuse it", async (t) => {
  let asked: unknown;
  const f = await fixture(t, async (id) => { asked = id; return bound("restored"); });
  await run(f, "recovered", [fauxToolCall("whoami", {}, { id: "c1" })]);
  assert.equal(asked, await f.store.conversationIdFor("recovered", false));
  assert.deepEqual((await toolResults(f.store, "recovered")).map((r) => r.text), ["speaker=restored"]);
  const refused = await fixture(t, async () => undefined);
  await run(refused, "denied", [fauxToolCall("whoami", {}, { id: "c2" })]);
  assert.equal((await toolResults(refused.store, "denied"))[0]?.isError, true);
});

test("the jail is enforced for file tools, and an allowed path is rewritten to its checked real path", async (t) => {
  const f = await fixture(t);
  const workspace = join(f.root, "workspace");
  await writeFile(join(workspace, "ok.txt"), "x");
  await symlink(join(f.root, "elsewhere"), join(workspace, "escape"));
  const jail = { readRoots: [workspace], writeRoots: [workspace], cwd: workspace };
  f.bindings.bind(await f.store.conversationIdFor("jailed"), bound("alice", jail));
  await run(f, "jailed", [
    fauxToolCall("read", { path: "ok.txt" }, { id: "a" }),
    fauxToolCall("read", { path: "/etc/passwd" }, { id: "b" }),
    fauxToolCall("read", { path: "escape/secret.txt" }, { id: "c" }),
  ]);
  const results = await toolResults(f.store, "jailed");
  assert.ok(!results[0]?.isError);
  assert.equal(results[0]?.text, `opened ${join(workspace, "ok.txt")}`);
  assert.equal(results[1]?.isError, true); assert.match(results[1]!.text, /outside this channel/);
  assert.equal(results[2]?.isError, true, "a symlink out of the workspace must not be followed");
});

test("a throwing tool becomes an error result the model sees, and the turn still completes", async (t) => {
  const f = await fixture(t);
  f.bindings.bind(await f.store.conversationIdFor("boom"), bound("alice"));
  await run(f, "boom", [fauxToolCall("boom", {}, { id: "c1" })]);
  const [result] = await toolResults(f.store, "boom");
  assert.equal(result?.isError, true);
  assert.match(result!.text, /kaboom/);
});

test("unbinding only removes the binding its owner installed", () => {
  const bindings = new ThreadToolBindings();
  const first = bound("first"), second = bound("second");
  const id = 1 as unknown as ConversationId;
  bindings.bind(id, first); bindings.bind(id, second);
  bindings.unbind(id, first);
  assert.equal(bindings.has(id), true, "a stale session must not unbind its successor");
  bindings.unbind(id, second);
  assert.equal(bindings.has(id), false);
});
