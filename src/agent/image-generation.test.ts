import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage, type ImageGenerationConfig } from "./image-generation.ts";

const baseConfig: ImageGenerationConfig = {
  provider: "openai",
  baseUrl: "https://api.openai.test/v1",
  apiKey: "secret-key",
  authProvider: "",
  model: "gpt-image-1",
  size: "1024x1024",
  quality: "auto",
  outputFormat: "png",
  responseFormat: "auto",
  timeoutSeconds: 10,
  maxBytes: 1024 * 1024,
  maxPromptChars: 1000,
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("calls an OpenAI-compatible image API and writes returned base64 bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-image-"));
  const out = join(dir, "fox.png");
  const png = Buffer.from("not a real png");
  const { impl, calls } = fakeFetch((_url, init) => {
    assert.equal((init.headers as Headers).get("authorization"), "Bearer secret-key");
    return new Response(
      JSON.stringify({ data: [{ b64_json: png.toString("base64"), revised_prompt: "a tidy fox" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await generateImage(baseConfig, { prompt: "fox", outputPath: out }, { fetchImpl: impl });

  assert.equal(calls[0]!.url, "https://api.openai.test/v1/images/generations");
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.model, "gpt-image-1");
  assert.equal(body.prompt, "fox");
  assert.equal(body.size, "1024x1024");
  assert.equal(body.output_format, "png");
  assert.deepEqual(readFileSync(out), png);
  assert.equal(result.path, out);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.revisedPrompt, "a tidy fox");
});

test("can use model runtime credentials such as openai-codex instead of an image API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-image-auth-"));
  const out = join(dir, "fox.png");
  const png = Buffer.from("codex png");
  const { impl, calls } = fakeFetch((_url, init) => {
    assert.equal((init.headers as Headers).get("authorization"), "Bearer codex-token");
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await generateImage(
    { ...baseConfig, apiKey: "", authProvider: "openai-codex" },
    { prompt: "fox", outputPath: out },
    {
      fetchImpl: impl,
      resolveAuth: async (providerId) => {
        assert.equal(providerId, "openai-codex");
        return { apiKey: "codex-token" };
      },
    },
  );

  assert.equal(calls[0]!.url, "https://api.openai.test/v1/images/generations");
  assert.deepEqual(readFileSync(out), png);
});

test("can save an image returned as a public URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-image-url-"));
  const out = join(dir, "cat.webp");
  const bytes = Buffer.from("webp bytes");
  const { impl, calls } = fakeFetch((url) => {
    if (url === "https://api.openai.test/v1/images/generations") {
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/image.webp" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://cdn.example.test/image.webp") {
      return new Response(bytes, { status: 200, headers: { "content-type": "image/webp" } });
    }
    throw new Error(`unexpected URL ${url}`);
  });

  const result = await generateImage(
    { ...baseConfig, outputFormat: "webp" },
    { prompt: "cat", outputPath: out },
    { fetchImpl: impl, resolveHost: async () => ["93.184.216.34"] },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(readFileSync(out), bytes);
  assert.equal(result.mimeType, "image/webp");
});

test("refuses local-network image URLs returned by a provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-image-local-"));
  const { impl } = fakeFetch(() =>
    new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/image.png" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await assert.rejects(
    () =>
      generateImage(
        baseConfig,
        { prompt: "cat", outputPath: join(dir, "cat.png") },
        { fetchImpl: impl, resolveHost: async () => ["192.168.1.20"] },
      ),
    /resolves locally/,
  );
});

test("prompt length is capped before calling the API", async () => {
  const { impl, calls } = fakeFetch(() => assert.fail("should not call API"));

  await assert.rejects(
    () =>
      generateImage(
        { ...baseConfig, maxPromptChars: 3 },
        { prompt: "too long", outputPath: "/tmp/nope.png" },
        { fetchImpl: impl },
      ),
    /over this channel's 3 character limit/,
  );
  assert.equal(calls.length, 0);
});
