import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentTurnOutcome } from "./turn-outcome.ts";
import { Type } from "typebox";
import { HarnessConfigSchema } from "../config/schema.ts";
import { registerConfiguredModelProviders } from "./model-providers.ts";

// No network: fetch is injected and every request/response is synthetic.
async function providerFixture(baseUrl: string, run: (runtime: ModelRuntime) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "provider-contract-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models.json"), refreshOnCreate: false,
    });
    const config = HarnessConfigSchema.parse({ modelProviders: {
      synthetic: { baseUrl, compat: { supportsReasoningEffort: false, supportsStrictMode: false },
        models: [{ id: "test-model", contextWindow: 8192, maxTokens: 2048 }] },
    } });
    registerConfiguredModelProviders(runtime, config.modelProviders);
    await run(runtime);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const prefix of ["", "/v1", "/custom/api"]) {
  test(`configured provider preserves base URL path '${prefix}' and surfaces HTTP failure`, async () => {
    await providerFixture(`https://provider.example.test${prefix}`, async (runtime) => {
      const model = runtime.getModel("synthetic", "test-model")!;
      let captured: any;
      const events: string[] = [];
      const stream = runtime.streamSimple(model, {
        systemPrompt: "Be concise.",
        messages: [{ role: "user", content: "Reply briefly.", timestamp: 1 }],
        tools: [{ name: "synthetic_tool", description: "A test tool.", parameters: Type.Object({ value: Type.String() }) }],
      }, {
        maxRetries: 0,
        fetch: async (input, init) => {
          assert.equal(String(input), `https://provider.example.test${prefix}/chat/completions`);
          assert.equal(init?.method, "POST");
          captured = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ message: "Route unavailable" }), {
            status: 404, headers: { "content-type": "application/json" },
          });
        },
      });
      for await (const event of stream) events.push(event.type);
      const message = await stream.result();
      assert.equal(captured.stream, true);
      assert.deepEqual(captured.stream_options, { include_usage: true });
      assert.equal(captured.max_completion_tokens, 2048);
      assert.equal(captured.tools[0].function.name, "synthetic_tool");
      assert.equal(captured.tools[0].function.strict, undefined);
      assert.equal(captured.reasoning_effort, undefined);
      assert.deepEqual(events, ["error"]);
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage!, /404/);
      assert.deepEqual(message.content, []);
    });
  });
}

test("configured provider consumes standard Chat Completions SSE deltas", async () => {
  await providerFixture("https://provider.example.test/v1", async (runtime) => {
    const model = runtime.getModel("synthetic", "test-model")!;
    const stream = runtime.streamSimple(model, {
      messages: [{ role: "user", content: "Reply briefly.", timestamp: 1 }],
    }, {
      fetch: async () => new Response([
        'data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(""), { headers: { "content-type": "text/event-stream" } }),
    });
    const events = [];
    for await (const event of stream) events.push(event);
    assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "Hello"));
    const message = await stream.result();
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, [{ type: "text", text: "Hello" }]);
  });
});

test("the real SDK agent resolves prompt after HTTP failure; the harness detects the outcome", async () => {
  await providerFixture("https://provider.example.test/v1", async (runtime) => {
    const outcome = new AgentTurnOutcome();
    const agent = new Agent({
      initialState: { model: runtime.getModel("synthetic", "test-model")!, systemPrompt: "Be concise.", tools: [] },
      streamFn: (model, context, options) => runtime.streamSimple(model, context, {
        ...options, maxRetries: 0,
        fetch: async () => new Response(JSON.stringify({ message: "Route unavailable" }), {
          status: 404, headers: { "content-type": "application/json" },
        }),
      }),
    });
    agent.subscribe((event) => {
      if (event.type === "message_end") outcome.observe(event.message);
    });
    await assert.doesNotReject(() => agent.prompt("Reply briefly."));
    assert.throws(() => outcome.assertCompleted(), /404/);
  });
});
