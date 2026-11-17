import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { WebClient } from "@slack/web-api";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { REPO_ROOT } from "../config/load.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { TaskStatusStore } from "../tasks/store.ts";
import { ChannelRuntimes } from "../agent/channel-runtime.ts";
import { createThreadSession } from "../agent/session.ts";
import { defaultPiAuthPath } from "../agent/credentials.ts";
import { prepareTrial, TRIAL_REPO } from "../agent/fixtures/factory-trial.ts";

/**
 * Opt-in, costs a few cents: the real factory team on a real model, driven through the app's own turn handler into a fake Slack
 * thread, printing what a person would see. Run with HARNESS_LIVE_MODEL=<provider/model>.
 */
const ref = process.env.HARNESS_LIVE_MODEL;

test("what a person sees in the thread while the factory team works, with a real model", { skip: !ref, timeout: 20 * 60_000 }, async (t) => {
  delete process.env.NODE_TEST_CONTEXT;
  const dataDir = mkdtempSync(join(tmpdir(), "progress-live-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ authPath: defaultPiAuthPath(), refreshOnCreate: false });
  const example = parse(readFileSync(join(REPO_ROOT, "config", "harness.example.yaml"), "utf8")).agentSets as { software_factory: { agents: Record<string, { model?: string; connectors?: string[] }> } };
  for (const agent of Object.values(example.software_factory.agents)) { agent.model = ref!; delete agent.connectors; }
  const config = HarnessConfigSchema.parse({
    agentSets: example,
    channels: { general: { model: ref, models: [ref], agentSet: "software_factory", tools: ["read", "write", "edit", "ls", "find", "grep", "bash"],
      preferences: `The repository ${TRIAL_REPO} is checked out at ./repo in your workspace, and \`gh\` on your PATH works on it. Run git and npm test from ./repo.` } },
    ui: { showToolActivity: false },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  Object.assign(channel.env, prepareTrial(channel.paths.workspace).env);

  // A Slack thread with real ordering, so the order printed is the order a person would read.
  const thread: { ts: string; text: string }[] = [];
  let n = 0;
  const client = {
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      postMessage: async (a: { text: string }) => { const ts = `200.${String(++n).padStart(3, "0")}`; thread.push({ ts, text: a.text }); return { ok: true, ts }; },
      update: async (a: { ts: string; text: string }) => { const m = thread.find((x) => x.ts === a.ts); if (!m) throw Object.assign(new Error("message_not_found"), { data: { error: "message_not_found" } }); m.text = a.text; return { ok: true }; },
      delete: async (a: { ts: string }) => { const i = thread.findIndex((x) => x.ts === a.ts); if (i >= 0) thread.splice(i, 1); return { ok: true }; },
    },
    conversations: { replies: async () => ({ ok: true, messages: thread }) },
  } as unknown as WebClient;

  const runtimes = new ChannelRuntimes({ modelRuntime });
  const session = await createThreadSession({ channel, threadKey: "1.1", harnessName: "Test", slackChannelLabel: "#general", botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1" });
  t.after(async () => { await session.dispose(); await runtimes.closeAll(); });
  const harness = {
    taskStore: new TaskStatusStore(dataDir), pool: { get: () => session }, pendingThread: new Map(), pendingUser: new Map(), resumedRequests: new Set<string>(),
    config: { ui: { ackEmoji: "hourglass", showToolActivity: false }, schedules: { timezone: "UTC" } }, opts: { botToken: "synthetic" }, botUserId: "UBOT",
  };
  await (HarnessApp.prototype as any).runAgentTurn.call(
    harness, client, channel, "1.1", "1.1", { channelId: "C1", userId: "U1", ts: "1.2" },
    `Work through the open issues in ${TRIAL_REPO}: triage them, build what is ready, and have it reviewed. Do not merge.`, { requestId: "slack:C1:1.2" },
  );
  console.log(["", "# The thread, top to bottom", ...thread.map((m, i) => `--- message ${i + 1} ---\n${m.text}`)].join("\n"));
  assert.ok(thread.length >= 4, "a hand-off, a closing line for each subagent run, and the answer");
  assert.ok(thread.some((m) => /Handing this to \*github_triage\*/.test(m.text)));
  assert.doesNotMatch(thread.at(-1)!.text, /Handing this to|finished \(/, "the answer is last, not a progress post");
});
