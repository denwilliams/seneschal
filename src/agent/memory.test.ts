import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { createMemoryTools } from "./memory.ts";

function channelForMemoryTools() {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-tools-"));
  const config = HarnessConfigSchema.parse({ channels: { eng: {} } });
  const { channel } = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "eng", isDm: false },
    new ChannelRegistry(dataDir),
  );
  assert.ok(channel);
  return channel;
}

test("remember describes durable-learning triggers and keeps transcripts out of memory", () => {
  const remember = createMemoryTools(channelForMemoryTools()).find((tool) => tool.name === "remember") as any;
  assert.ok(remember);

  assert.match(remember.description, /user correction or teaching/i);
  assert.match(remember.description, /agent mistake and its remedy/i);
  assert.match(remember.description, /lengthy or iterative work/i);
  assert.match(remember.description, /important decision or outcome/i);
  assert.match(remember.description, /not chat transcripts/i);
  assert.match(remember.description, /save repeatable steps as a skill/i);
  assert.match(remember.parameters.properties.text.description, /One concise durable fact/i);
  assert.match(remember.parameters.properties.text.description, /not a chat transcript or status update/i);
  assert.match(remember.parameters.properties.text.description, /repeatable procedures with save_skill/i);
});
