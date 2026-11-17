import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { narrowChannelForAgent } from "../workspace/subagents.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { buildSubagentPrompt } from "./subagents.ts";

for (const mode of ["host", "docker", "macos-container", "kiri"] as const) {
  for (const bash of [false, true]) {
    test(`${mode} ${bash ? "shell" : "file-only"} agents and subagents get workspace tmp instructions`, (t) => {
      const dataDir = mkdtempSync(join(tmpdir(), "tmp-instructions-"));
      t.after(() => rmSync(dataDir, { recursive: true, force: true }));
      const tools = bash ? ["read", "write", "bash"] : ["read", "write"];
      const config = HarnessConfigSchema.parse({
        agentSets: { team: { agents: { coder: { description: "Writes code", tools } } } },
        channels: { eng: { tools, sandbox: { mode }, agentSet: "team" } },
      });
      const channel = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, new ChannelRegistry(dataDir)).channel!;
      const agent = channel.agents[0]!;
      const prompts = [
        buildSystemPrompt(channel, { harnessName: "Test", slackChannelLabel: "#eng", botUserId: "U0" }),
        buildSubagentPrompt(narrowChannelForAgent(channel, agent), agent, { harnessName: "Test", channelLabel: "#eng", toolNames: tools }),
      ];
      for (const prompt of prompts) {
        assert.match(prompt, /Put temporary\/scratch files in this workspace's `tmp\/` directory/);
        assert.ok(prompt.includes(`With file tools, use \`${join(channel.paths.workspace, "tmp")}/\``));
        assert.match(prompt, /Files in `tmp\/` are disposable/);
        assert.match(prompt, /Keep retained outputs, attachments, published `artifacts\/`, and reusable `bin\/` tools outside `tmp\/`/);
        assert.match(prompt, /No automatic cleanup is performed/);
        assert.match(prompt, /Do not move or delete existing workspace files unless asked/);
        if (bash && mode !== "host") {
          assert.match(prompt, /With container `bash`, use `\/workspace\/tmp\/`/);
        } else {
          assert.doesNotMatch(prompt, /With container `bash`, use/);
        }
      }
    });
  }
}
