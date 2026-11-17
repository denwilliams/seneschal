import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageTools } from "./image-tools.ts";
import type { ImageGenerationConfig } from "./image-generation.ts";

const config: ImageGenerationConfig = {
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-image-tool-"));
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(other, { recursive: true });
  const [tool] = createImageTools({
    config,
    channelLabel: "#ops",
    jail: { readRoots: [workspace], writeRoots: [workspace], cwd: workspace },
    deps: {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    },
  });
  return { workspace, other, tool: tool as any };
}

test("generate_image writes inside the workspace and tells the agent to upload it", async () => {
  const { workspace, tool } = setup();

  const result = await tool.execute("id", { prompt: "a tiny robot", output_path: "robot" });

  assert.deepEqual(readFileSync(join(workspace, "robot.png")), Buffer.from("png"));
  assert.match(result.content[0].text, /Generated robot\.png/);
  assert.match(result.content[0].text, /Use upload_file/);
});

test("generate_image refuses paths outside the channel jail", async () => {
  const { other, tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { prompt: "a tiny robot", output_path: join(other, "robot.png") }),
    /outside this channel's workspace/,
  );
});

test("generate_image refuses to overwrite an existing file", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "robot.png"), "old");

  await assert.rejects(
    () => tool.execute("id", { prompt: "a tiny robot", output_path: "robot.png" }),
    /already exists/,
  );
});

test("image tools are available when credentials come from an auth provider", () => {
  const tools = createImageTools({
    config: { ...config, apiKey: "", authProvider: "openai-codex" },
    channelLabel: "#ops",
    jail: { readRoots: ["/tmp"], writeRoots: ["/tmp"], cwd: "/tmp" },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "generate_image");
});

test("image tools are absent without configured credentials", () => {
  const tools = createImageTools({
    config: { ...config, apiKey: "" },
    channelLabel: "#ops",
    jail: { readRoots: ["/tmp"], writeRoots: ["/tmp"], cwd: "/tmp" },
  });
  assert.deepEqual(tools, []);
});
