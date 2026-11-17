import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { createThreadSession } from "./session.ts";

/**
 * The shell tool, run the way a channel really runs it: through the Durable adapter, which hands a tool no Pi session.
 * Pi's stock bash tool expects one by default (to expose it to the shell as PI_SESSION_ID), and a scripted tool that
 * merely returns text cannot show that. Only running a command can.
 */
test("bash runs a command through the Durable adapter, for the channel agent and for a subagent", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bash-durable-"));
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = HarnessConfigSchema.parse({
    agentSets: { team: { agents: { shell: { description: "Runs commands.", tools: ["bash"], model: "fixture/model" } } } },
    channels: { ops: { model: "fixture/model", agentSet: "team", tools: ["bash"] } },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "ops", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const runtimes = new ChannelRuntimes({ modelRuntime });
  const session = await createThreadSession({
    channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#ops", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1",
  });
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); rmSync(dataDir, { recursive: true, force: true }); });

  const results: string[] = [];
  const capture = (context: { messages: { role: string; content?: unknown }[] }) => {
    for (const m of context.messages) if (m.role === "toolResult") results.push(JSON.stringify(m.content));
    return undefined;
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo from-the-channel-agent" }, { id: "b1" }), { stopReason: "toolUse" }),
    (context) => { capture(context); return fauxAssistantMessage(fauxToolCall("run_subagent", { agent: "shell", task: "run a command" }, { id: "s1" }), { stopReason: "toolUse" }); },
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo from-the-subagent" }, { id: "b2" }), { stopReason: "toolUse" }),
    (context) => { capture(context); return fauxAssistantMessage("STATUS: done\nran it"); },
    (context) => { capture(context); return fauxAssistantMessage("finished"); },
  ]);
  await session.session.prompt("run things", { requestId: "r1", userId: "U1" });

  const all = results.join("\n");
  assert.match(all, /from-the-channel-agent/, "the channel agent's shell ran");
  assert.match(all, /from-the-subagent/, "the subagent's shell ran");
  assert.doesNotMatch(all, /getSessionId|Cannot read properties/, "no tool call failed on a missing Pi session");
});
