import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { modelPolicy } from "./model-policy.ts";
import { DurableChannelStore } from "./channel-store.ts";
import { Harness, configure, createRegistry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "durable-routing-"));
  await mkdir(join(root, "workspace"));
  const models = await ModelRuntime.create({ modelsPath: null, authPath: join(root, "auth.json"), refreshOnCreate: false });
  const backing = fauxProvider({ provider: "backing", models: [{ id: "allowed" }, { id: "forbidden" }], tokensPerSecond: 1_000_000 });
  models.registerNativeProvider(backing.provider);
  let target = "forbidden";
  const reasons: string[] = [];
  models.registerVirtualModel({ provider: "alias", id: "auto", name: "auto", route: (request) => {
    reasons.push(request.reason);
    return { model: models.getModel("backing", target)!, thinkingLevel: "off", state: "retained" };
  } });
  await models.refresh({ allowNetwork: false });
  const open = new Set<DurableChannelStore>();
  t.after(async () => { for (const runtime of open) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const alias = models.getModel("alias", "auto")!;
  const allowed = ["alias/auto", "backing/allowed"];
  return { root, models, alias, allowed, backing, reasons,
    route: (id: string) => { target = id; },
    open: async (allowlist = allowed) => {
      const runtime = await DurableChannelStore.open({ models, allowedModels: allowlist,
        model: { provider: "alias", modelId: "auto" }, channelId: "C1", workspace: join(root, "workspace"), storageDir: join(root, "store"),
      }); open.add(runtime); return runtime;
    }, close: async (runtime: DurableChannelStore) => { await runtime.close(); open.delete(runtime); },
  };
}
const context = { messages: [] };
const input = { requestId: "event-1", userId: "U1", content: "hello" };

test("allowed aliases never grant backing permissions: facade completion/streaming and Durable invoke zero forbidden calls", async (t) => {
  const f = await fixture(t); const policy = modelPolicy(f.models, f.allowed);
  f.backing.setResponses([fauxAssistantMessage("forbidden response must never be requested")]);
  let authCalls = 0;
  const getAuth = f.models.getAuth.bind(f.models);
  f.models.getAuth = ((...args: Parameters<typeof getAuth>) => { authCalls++; return getAuth(...args); }) as typeof getAuth;
  for (const stream of [policy.models.streamSimple(f.alias, context), policy.models.stream(f.alias, context)]) {
    const result = await stream.result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /not allowed|physical catalog/);
  }
  const complete = await policy.models.completeSimple(f.alias, context);
  assert.equal(complete.stopReason, "error"); assert.match(complete.errorMessage!, /backing\/forbidden/);
  assert.equal((await policy.models.complete(f.alias, context)).stopReason, "error");
  const runtime = await f.open();
  // Private channel context the forbidden alias must never receive.
  await runtime.appendMainContext("slack.test", "private imported marker");
  await assert.rejects(runtime.wait(await runtime.submit("thread", input)), /unanswered/);
  assert.equal(f.backing.state.callCount, 0);
  assert.equal(authCalls, 0, "forbidden dispatch must precede any credential refresh/network access");
});

test("alias AND exact backing pair are required; authorized routing still works and leaves raw runtime untouched", async (t) => {
  const f = await fixture(t); f.route("allowed");
  assert.throws(() => modelPolicy(f.models, ["backing/allowed"]).models.streamSimple(f.alias, context), /alias\/auto/);
  const denied = await modelPolicy(f.models, ["alias/auto"]).models.completeSimple(f.alias, context);
  assert.equal(denied.stopReason, "error"); assert.match(denied.errorMessage!, /backing\/allowed/);
  assert.equal(f.backing.state.callCount, 0);
  const original = f.models.streamSimple;
  f.backing.setResponses([fauxAssistantMessage("streamed"), fauxAssistantMessage("completed"), fauxAssistantMessage("durable")]);
  const policy = modelPolicy(f.models, f.allowed);
  const events = []; const stream = policy.models.streamSimple(f.alias, context);
  for await (const event of stream) events.push(event.type);
  assert.ok(events.includes("done"));
  assert.equal((await stream.result()).model, "allowed");
  assert.equal((await policy.models.completeSimple(f.alias, context)).model, "allowed");
  const runtime = await f.open();
  assert.equal((await runtime.wait(await runtime.submit("thread", input))).text, "durable");
  assert.equal(f.backing.state.callCount, 3);
  assert.equal(f.models.streamSimple, original);
});

test("every reroute/retry validates the newly resolved physical pair and preserves router state", async (t) => {
  const f = await fixture(t);
  const guarded = modelPolicy(f.models, f.allowed).models as ModelRuntime;
  for (const reason of ["direct", "user", "continuation", "retry"] as const) {
    f.route("allowed");
    const route = await guarded.resolveModel(f.alias, [], { reason, thinkingLevel: "off", state: "input" });
    assert.equal(route.model.id, "allowed"); assert.equal(route.state, "retained");
    f.route("forbidden");
    await assert.rejects(guarded.resolveModel(f.alias, [], { reason, thinkingLevel: "off", state: route.state,
      failed: fauxAssistantMessage("failed", { stopReason: "error" }),
    }), /not allowed: backing\/forbidden/);
  }
  // The same immutable policy observes the next route, not a cached allowed result.
  f.route("allowed"); f.backing.setResponses([fauxAssistantMessage("first")]);
  assert.equal((await guarded.completeSimple(f.alias, context)).stopReason, "stop");
  f.route("forbidden");
  assert.equal((await guarded.completeSimple(f.alias, context)).stopReason, "error");
  assert.equal(f.backing.state.callCount, 1);
  assert.deepEqual(f.reasons.slice(0, 8), ["direct", "direct", "user", "user", "continuation", "continuation", "retry", "retry"]);
});

test("reopen under revoked backing policy cannot dispatch a previously legitimate alias", async (t) => {
  const f = await fixture(t); f.route("allowed"); f.backing.setResponses([fauxAssistantMessage("before restart")]);
  let runtime = await f.open();
  await runtime.wait(await runtime.submit("thread", input)); await f.close(runtime);
  runtime = await f.open(["alias/auto"]);
  await runtime.resume(); // alias admission remains allowed; routing is checked per dispatch.
  await assert.rejects(runtime.wait(await runtime.submit("thread", { ...input, requestId: "event-2" })), /unanswered/);
  assert.equal(f.backing.state.callCount, 1);
  assert.equal((await runtime.transcript("thread")).messages.filter((message) => message.role === "assistant").length, 1);
});

test("unrouted aliases fail closed for deferred operations and direct provider access", async (t) => {
  const f = await fixture(t); const policy = modelPolicy(f.models, f.allowed);
  const handle = { provider: "alias", modelId: "auto", api: "pi-virtual", id: "pending" };
  assert.equal((await policy.models.streamDeferred(f.alias, handle).result()).stopReason, "error");
  assert.equal((await policy.models.fetchDeferred(f.alias, handle)).stopReason, "error");
  await assert.rejects(policy.models.cancelDeferred(f.alias, handle), /physical catalog/);
  for (const provider of [policy.models.getProvider("alias")!, ...policy.models.getProviders().filter((p) => p.id === "alias")]) {
    assert.throws(() => provider.streamSimple(f.alias, context as never), /physical catalog/);
    assert.throws(() => provider.stream(f.alias, context as never), /physical catalog/);
  }
  assert.equal(f.backing.state.callCount, 0);
});

test("authorization is rechecked after asynchronous header hooks, including misleading catalog API changes", async (t) => {
  const f = await fixture(t); f.route("allowed");
  const policy = modelPolicy(f.models, f.allowed);
  const model = f.models.getModel("backing", "allowed")!;
  const result = await policy.models.completeSimple(model, context, { transformHeaders: async (headers) => {
    // An async extension must not smuggle in a fresh routing layer below authorization.
    f.models.registerVirtualModel({ provider: "backing", id: "new", name: "new", route: () => ({ model: f.models.getModel("backing", "forbidden")!, thinkingLevel: "off" }) });
    model.api = "pi-virtual";
    return headers;
  } });
  assert.equal(result.stopReason, "error");
  assert.equal(f.backing.state.callCount, 0);
});

test("allowed virtual alias to forbidden HTTP transport causes zero requests; allowed transport retains auth and options", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const requests: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    calls++;
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: ' + JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "physical",
      choices: [{ index: 0, delta: { role: "assistant", content: "network answer" }, finish_reason: "stop" }],
    }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  f.models.registerProvider("network", { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "backing-key", headers: { "X-Backing": "backing-header" }, models: [{ id: "physical", name: "physical", maxTokens: 8, contextWindow: 10000, reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  f.models.registerVirtualModel({ provider: "alias", id: "auto", name: "auto", route: () => ({ model: f.models.getModel("network", "physical")!, thinkingLevel: "off" }) });
  await f.models.refresh({ allowNetwork: false });
  const alias = f.models.getModel("alias", "auto")!;
  assert.equal((await modelPolicy(f.models, ["alias/auto"]).models.completeSimple(alias, context)).stopReason, "error");
  const runtime = await f.open(["alias/auto"]);
  const submission = await runtime.submit("thread", input);
  const settled = await submission.wait(BACKGROUND_CONTEXT); assert.equal(settled.status, "unanswered");
  assert.equal(calls, 0);
  const allowed = modelPolicy(f.models, ["alias/auto", "network/physical"]);
  const result = await allowed.models.completeSimple(alias, context, { apiKey: "alias-key", headers: { "X-Alias": "secret" }, maxTokens: 20 });
  assert.equal(result.stopReason, "stop", result.errorMessage); assert.equal(calls, 1);
  assert.equal(requests[0]!.headers.authorization, "Bearer backing-key");
  assert.equal(requests[0]!.headers["x-backing"], "backing-header");
  assert.equal(requests[0]!.headers["x-alias"], undefined);
  assert.equal(requests[0]!.body.model, "physical");
  assert.equal(requests[0]!.body.max_tokens ?? requests[0]!.body.max_completion_tokens, 8);
});

for (const permitBacking of [false, true]) {
  test(`real Durable compaction via ModelRuntime ${permitBacking ? "permits authorized" : "blocks forbidden"} backing dispatch`, async (t) => {
    const f = await fixture(t);
    if (permitBacking) f.route("allowed");
    f.backing.setResponses([fauxAssistantMessage("compact summary")]);
    const harness = await Harness.open(new MemoryStorage(), {
      models: modelPolicy(f.models, f.allowed).models, registry: createRegistry(),
      settings: { compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false } },
    }, BACKGROUND_CONTEXT);
    t.after(() => harness.close(BACKGROUND_CONTEXT));
    const id = await harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, { model: { provider: "alias", modelId: "auto" } });
      await tx.appendEntry(conversation.id, { kind: "fixture.history", model: [{ role: "user", content: "old private history", timestamp: 1 }] });
      await tx.appendEntry(conversation.id, { kind: "fixture.history", model: [{ role: "user", content: "recent question", timestamp: 2 }] });
      return conversation.id;
    }, BACKGROUND_CONTEXT);
    const conversation = await harness.conversation(id, BACKGROUND_CONTEXT); assert.ok(conversation);
    const taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    assert.equal(settled.state.outcome.status, permitBacking ? "completed" : "failed");
    assert.equal(f.backing.state.callCount, permitBacking ? 1 : 0);
    assert.equal(settled.kind, "pi.compaction");
    const messages = JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages);
    if (permitBacking) assert.match(messages, /compact summary/);
    else assert.doesNotMatch(messages, /compact summary/);
  });
}


test("interrupted alias checkpoint and switched alias cannot dispatch a newly forbidden route after reopen", { timeout: 10000 }, async (t) => {
  const f = await fixture(t); f.route("allowed");
  let began!: () => void; const started = new Promise<void>((resolve) => { began = resolve; });
  f.backing.setResponses([async (_context, options) => {
    began();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("interrupted", { stopReason: "aborted" });
  }]);
  let runtime = await f.open();
  await runtime.submit("thread", input); await started;
  await f.close(runtime);
  f.route("forbidden");
  f.models.registerVirtualModel({ provider: "alias", id: "other", name: "other", route: () => ({
    model: f.models.getModel("backing", "forbidden")!, thinkingLevel: "off",
  }) });
  await f.models.refresh({ allowNetwork: false });
  runtime = await f.open([...f.allowed, "alias/other"]);
  assert.equal((await runtime.inspect()).scheduling, "paused");
  assert.ok((await runtime.inspect()).tasks.some((task) => task.record.kind === "pi.generation"));
  await runtime.setModel("thread", { provider: "alias", modelId: "other" });
  await runtime.resume(); await runtime.waitForIdle();
  assert.equal(f.backing.state.callCount, 1, "the reopened pinned alias request must never call its new forbidden target");
  await assert.rejects(runtime.wait(await runtime.submit("thread", { ...input, requestId: "switched" })), /unanswered/);
  assert.equal(f.backing.state.callCount, 1, "switching to another allowed alias cannot authorize the backing target");
});

test("Durable automatic retry reroutes afresh and blocks a forbidden fallback", { timeout: 10000 }, async (t) => {
  const f = await fixture(t); f.route("allowed");
  f.backing.setResponses([async () => {
    f.route("forbidden");
    return fauxAssistantMessage("temporary failure", { stopReason: "error", errorMessage: "503 service unavailable" });
  }, fauxAssistantMessage("forbidden fallback")]);
  const runtime = await f.open();
  await assert.rejects(runtime.wait(await runtime.submit("thread", input)), /unanswered/);
  assert.equal(f.backing.state.callCount, 1);
  assert.equal(f.reasons.length, 2, "the retry resolved a new target rather than reusing the prior authorization");
});

test("allowed physical deferred fetch/cancel work; virtual or forbidden handles never reach providers", async (t) => {
  const f = await fixture(t); const policy = modelPolicy(f.models, f.allowed);
  const model = f.models.getModel("backing", "allowed")!;
  f.backing.setResponses([fauxAssistantMessage("deferred answer"), fauxAssistantMessage("cancelled")]);
  const deferred = await policy.models.completeSimple(model, context, { deferred: true });
  assert.equal(deferred.stopReason, "deferred"); assert.ok(deferred.deferred);
  const answer = await policy.models.fetchDeferred(model, deferred.deferred);
  assert.equal(answer.stopReason, "stop");
  assert.equal(f.backing.state.deferredFetchCount, 1);
  const pending = await policy.models.completeSimple(model, context, { deferred: true }); assert.ok(pending.deferred);
  await policy.models.cancelDeferred(model, pending.deferred);
  assert.equal(f.backing.state.cancelledDeferred.length, 1);
  assert.throws(() => policy.models.fetchDeferred(model, { ...pending.deferred!, modelId: "forbidden" }), /not allowed/);
  assert.equal(f.backing.state.deferredFetchCount, 1);
});
