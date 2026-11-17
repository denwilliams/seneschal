import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRuntimes } from "./channel-runtime.ts";
import { createThreadSession } from "./session.ts";
import { defaultPiAuthPath } from "./credentials.ts";
import type { ChannelDelegator } from "./delegation-tools.ts";

/**
 * Opt-in, costs a few cents. A channel can hand work to its OWN subagents (run_subagent) or to ANOTHER channel's assistant
 * (transfer_to_channel), and a model can mix them up. This asks for clearly one or the other and records which tool it
 * reaches for first. The subagents here do nothing (no tools, instructed to reply at once), so only the choice is measured.
 *
 *   HARNESS_LIVE_MODEL=openai-codex/<model> node --experimental-strip-types --test src/agent/subagent-vs-transfer.live.test.ts
 */
const ref = process.env.HARNESS_LIVE_MODEL;
const ROUNDS = Number(process.env.HARNESS_LIVE_ROUNDS ?? 2);

const CASES: { say: string; expect: "run_subagent" | "transfer_to_channel"; agent?: string }[] = [
  { say: "Ask the reviewer to look over PR #3.", expect: "run_subagent", agent: "reviewer" },
  { say: "Get the coder to fix the typo in the README.", expect: "run_subagent", agent: "coder" },
  { say: "Have the triage agent sort the new issues.", expect: "run_subagent", agent: "github_triage" },
  { say: "Hand this to the engineering channel: find out why last night's deploy failed.", expect: "transfer_to_channel" },
  { say: "Can you get the engineering channel's assistant to look at the failing build?", expect: "transfer_to_channel" },
  { say: "This belongs in #engineering. Pass it over: check the staging database disk usage.", expect: "transfer_to_channel" },
];

/**
 * The wording a person actually uses: it borrows the other feature's vocabulary ("transfer" to a teammate, "delegate" to
 * another channel) or names a role and a channel in one breath. The right answer is still decided by WHO is meant.
 */
const HARD: typeof CASES = [
  { say: "Transfer this to the reviewer: please check PR #3.", expect: "run_subagent", agent: "reviewer" },
  { say: "Delegate the typo fix in the README to the coder.", expect: "run_subagent", agent: "coder" },
  { say: "Hand off the deploy to the deployer, staging only.", expect: "run_subagent", agent: "cloudflare_deployer" },
  { say: "Delegate this to engineering: why did last night's deploy fail?", expect: "transfer_to_channel" },
  { say: "Send this over to the engineering team, they'll know about the failing build.", expect: "transfer_to_channel" },
  { say: "Can the engineering channel's agent look at this build failure instead of us?", expect: "transfer_to_channel" },
  { say: "Who on the team should check the staging disk usage? Just get that person to do it.", expect: "run_subagent" },
  { say: "Pass this to the other assistant: check the staging database disk usage.", expect: "transfer_to_channel" },
];
const SET = process.env.HARNESS_LIVE_CASES === "hard" ? HARD : process.env.HARNESS_LIVE_CASES === "all" ? [...CASES, ...HARD] : CASES;

test("a channel agent picks run_subagent for its team and transfer_to_channel for another channel", { skip: !ref, timeout: 20 * 60_000 }, async (t) => {
  delete process.env.NODE_TEST_CONTEXT;
  const dataDir = mkdtempSync(join(tmpdir(), "vs-live-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ authPath: defaultPiAuthPath(), refreshOnCreate: false });
  const quiet = (description: string) => ({ description, tools: [], model: ref!, timeoutSeconds: 60, instructions: "Reply immediately, using no tools, with exactly: STATUS: done\nNEXT: none\nok" });
  const config = HarnessConfigSchema.parse({
    agentSets: { team: { agents: {
      github_triage: quiet("Triages GitHub issues."), coder: quiet("Implements one ready issue and opens a PR."),
      reviewer: quiet("Reviews a pull request."), cloudflare_deployer: { ...quiet("Deploys an approved change to Cloudflare."), requireApproval: true },
    } } },
    channels: {
      factory: {
        model: ref, models: [ref], agentSet: "team", tools: ["read"],
        share: { delegateTo: [{ channel: "engineering", reason: "technical work needing bash, secrets and deploy context" }] },
      },
    },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "factory", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const transfers: string[] = [];
  const delegator: ChannelDelegator = { transfer: async (input) => { transfers.push(input.target); return { targetChannelLabel: "#engineering", threadTs: "9.9" }; } };

  const results: { say: string; expect: string; got: string; target?: string }[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const [index, c] of SET.entries()) {
      const runtimes = new ChannelRuntimes({ modelRuntime });
      const session = await createThreadSession({
        channel, threadKey: `${round}.${index}`, threadTs: `${round}.${index}`, harnessName: "Factory", slackChannelLabel: "#factory",
        botUserId: "UBOT", modelRuntime, runtimes, initialUserId: "U1", delegator,
      });
      const tools: string[] = [];
      let subagent: string | undefined;
      session.session.subscribe((event) => { if (event.type === "tool_start") tools.push(event.toolName); });
      transfers.length = 0;
      try { await session.session.prompt(c.say, { requestId: `r-${round}-${index}`, userId: "U1" }); }
      finally { await session.dispose(); await runtimes.closeAll(); }
      const first = tools.find((name) => name === "run_subagent" || name === "transfer_to_channel") ?? "neither";
      results.push({ say: c.say, expect: c.expect, got: first, ...(transfers[0] ? { target: transfers[0] } : {}) });
      void subagent;
    }
  }
  const correct = results.filter((r) => r.got === r.expect).length;
  console.log(["", `# subagent vs transfer: ${correct}/${results.length} chose the right tool`, ...results.map((r) => `${r.got === r.expect ? "ok  " : "MISS"} expected ${r.expect.padEnd(19)} got ${r.got.padEnd(19)} | ${r.say}`)].join("\n"));
  assert.equal(correct, results.length, `wrong tool chosen ${results.length - correct} time(s)`);
});
