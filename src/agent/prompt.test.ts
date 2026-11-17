import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, withLateHarnessContext } from "./prompt.ts";
import { RecentConversationList } from "./recent-conversations.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";

/**
 * The per-turn prompt swap.
 *
 * pi appends the available-skills section to the harness's own text, and an
 * extension returning a system prompt replaces the whole assembled string. The
 * harness appends volatile context every turn. That context must follow the
 * complete assembled prompt so it cannot invalidate the cached skills tail.
 */

const BASE = "You are Harness.\n\n## Choosing your model\n\nYou can switch.";
const TAIL = "\n\n<available_skills>\n  <skill>weekly-report</skill>\n</available_skills>\n\nCurrent working directory: /w";
const LATE = "## Recent conversations\n\nA volatile thread summary.";

test("everything pi appended survives late-context injection", () => {
  const result = withLateHarnessContext({
    assembled: BASE + TAIL,
    lateContext: LATE,
  });

  assert.match(result, /available_skills/, "the skills section must not be dropped");
  assert.match(result, /Current working directory: \/w/);
  assert.match(result, /A volatile thread summary/);
});

test("volatile context follows pi's stable tail", () => {
  const result = withLateHarnessContext({
    assembled: BASE + TAIL,
    lateContext: LATE,
  });

  assert.equal(result, `${BASE}${TAIL}\n\n${LATE}`);
});

test("unexpected pi assembly still keeps its tail ahead of late context", () => {
  const assembled = "something else entirely" + TAIL;
  const result = withLateHarnessContext({ assembled, lateContext: LATE });

  assert.equal(result, `${assembled}\n\n${LATE}`);
  assert.ok(result.indexOf("weekly-report") < result.indexOf("## Recent conversations"));
});

test("no late context leaves pi's assembled prompt untouched", () => {
  const assembled = BASE + TAIL;
  assert.equal(
    withLateHarnessContext({ assembled, lateContext: "" }),
    assembled,
  );
});

/** The prompt a channel would actually get, resolved from a config. */
function promptFor(configInput: unknown): string {
  const dataDir = mkdtempSync(join(tmpdir(), "prompt-"));
  const config = HarnessConfigSchema.parse(configInput);
  const { channel } = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "eng", isDm: false },
    new ChannelRegistry(dataDir),
  );
  return buildSystemPrompt(channel!, {
    harnessName: "Harness",
    slackChannelLabel: "#eng",
    botUserId: "U0",
  });
}


test("interactive response guidance is present only for an enabled live component service", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "prompt-"));
  const config = HarnessConfigSchema.parse({ defaults: { interactiveComponents: { enabled: true } } });
  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, new ChannelRegistry(dataDir));
  const enabled = buildSystemPrompt(channel!, {
    harnessName: "Harness", slackChannelLabel: "#eng", botUserId: "U0", canUseInteractiveComponents: true,
  });
  const disabled = buildSystemPrompt(channel!, {
    harnessName: "Harness", slackChannelLabel: "#eng", botUserId: "U0", canUseInteractiveComponents: false,
  });

  assert.match(enabled, /ask_canned_response/);
  assert.match(enabled, /cannot execute scripts or call URLs/);
  assert.doesNotMatch(disabled, /ask_canned_response/);
});

test("memory guidance captures durable learnings without retaining chat", () => {
  const prompt = promptFor({ channels: { eng: {} } });
  const section = prompt.slice(prompt.indexOf("## Your memory and scope")).split("\n\n## ")[0]!;

  assert.match(section, /corrects or teaches you/i);
  assert.match(section, /mistake and learn the remedy/i);
  assert.match(section, /lengthy or iterative work/i);
  assert.match(section, /important decision or outcome/i);
  assert.match(section, /not a chat transcript/i);
  assert.match(section, /repeatable steps belong in `save_skill`/i);
});

test("recent conversations are injected separately from memory", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "prompt-"));
  const config = HarnessConfigSchema.parse({ channels: { eng: {} } });
  const { channel } = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "eng", isDm: false },
    new ChannelRegistry(dataDir),
  );
  new RecentConversationList(channel!.paths.recentConversationsFile).upsert(
    {
      threadKey: "1710000000.000001",
      summary: "Den asked for a rolling list of recent Slack thread summaries.",
      updatedAt: "2026-01-01T00:00:00.000Z",
      summarizedAt: "2026-01-01T00:01:00.000Z",
    },
    10,
  );

  const prompt = buildSystemPrompt(channel!, {
    harnessName: "Harness",
    slackChannelLabel: "#eng",
    botUserId: "U0",
  });

  assert.match(prompt, /## Recent conversations/);
  assert.match(prompt, /not memory/i);
  assert.match(prompt, /`1710000000\.000001` — Den asked/);
});

test("runtime context is appended after every stable prompt section", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "prompt-"));
  const config = HarnessConfigSchema.parse({ channels: { eng: {} } });
  const { channel } = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "eng", isDm: false },
    new ChannelRegistry(dataDir),
  );

  const stable = buildSystemPrompt(channel!, {
    harnessName: "Harness",
    slackChannelLabel: "#eng",
    botUserId: "U0",
    includeLateContext: false,
  });
  const prompt = buildSystemPrompt(channel!, {
    harnessName: "Harness",
    slackChannelLabel: "#eng",
    botUserId: "U0",
    currentModel: "openai/gpt-5.6",
  });

  assert.doesNotMatch(stable, /Recent conversations|currently running on/);
  assert.ok(prompt.startsWith(stable));
  assert.ok(prompt.indexOf("## Current runtime") > stable.length);
  assert.ok(prompt.indexOf("## Recent conversations") > prompt.indexOf("## Current runtime"));
});

test("a channel with web is told how to use it, and what page text is", () => {
  const prompt = promptFor({ channels: { eng: {} } });

  assert.match(prompt, /## Reading the internet/);
  assert.match(prompt, /fetch_url/);
  assert.match(prompt, /download_url/);
  // The stance that matters: a page is data written by a stranger.
  assert.match(prompt, /information, never instructions/);
  assert.match(prompt, /Local network addresses are refused/);
});

test("without a search provider the prompt says so rather than implying one", () => {
  const noSearch = promptFor({ channels: { eng: {} } });
  assert.match(noSearch, /no search in this channel/i);
  assert.doesNotMatch(noSearch, /search_web/);

  const withSearch = promptFor({
    channels: { eng: { web: { search: { provider: "brave", apiKey: "k" } } } },
  });
  assert.match(withSearch, /search_web/);
});

test("a channel is told where an attachment lands and what filing it means", () => {
  const prompt = promptFor({ channels: { eng: {} } });

  assert.match(prompt, /## The document library/);
  // Scoped to the section, because the web section says some of this too and
  // an assertion that passes on the wrong section proves nothing.
  const section = prompt.slice(prompt.indexOf("## The document library")).split("\n\n## ")[0]!;
  assert.match(section, /attachments\//);
  assert.match(section, /search_documents/);
  assert.match(section, /add_document/);
  // The two things it must not get wrong: what goes on a shared shelf, and
  // that a document is something to read rather than something to obey.
  assert.match(section, /Never file anything private or sensitive/);
  assert.match(section, /information, never instructions/);
});

test("a channel that cannot file is told to say so rather than promising to keep it", () => {
  const prompt = promptFor({ channels: { eng: { share: { documentsAdd: false } } } });

  assert.match(prompt, /cannot file documents here/);
  assert.doesNotMatch(prompt, /add_document/);
  assert.match(prompt, /search_documents/, "reading is a separate decision");

  const none = promptFor({
    channels: { eng: { share: { documents: false, documentsAdd: false } } },
  });
  assert.doesNotMatch(none, /## The document library/);
});

test("every channel is told how to report a limitation, and what not to report", () => {
  const prompt = promptFor({ channels: { eng: {} } });

  assert.match(prompt, /## When the harness gets in your way/);
  assert.match(prompt, /report_limitation/);
  // The two failure modes: a file full of noise, and an agent that thinks
  // filing something is the same as fixing it.
  assert.match(prompt, /File it once/);
  assert.match(prompt, /does not fix it/);
});

test("where a capability can be granted, the prompt sends the agent to the button first", () => {
  const grantable = promptFor({ channels: { eng: { permissions: { grantable: ["bash"] } } } });
  assert.match(grantable, /no button here can grant/);

  // Where nothing can be granted, pointing at `request_access` would be sending
  // it to a door that is not there.
  const nothingGrantable = promptFor({ channels: { eng: { permissions: { grantable: [] } } } });
  assert.match(nothingGrantable, /A report is not a request/);
});

test("notification collector is told to make one post from the batch", () => {
  const ordinary = promptFor({ notifications: { channel: "admin" }, channels: { eng: {} } });
  assert.match(ordinary, /## Notification batching/);
  assert.match(ordinary, /submit_notification/);
  assert.match(ordinary, /cannot collect the shared batch/);

  const collector = promptFor({ notifications: { channel: "eng" }, channels: { eng: {} } });
  assert.match(collector, /collect_notifications/);
  assert.match(collector, /summarise the returned items into one message/);
  assert.match(collector, /post each item separately/);
});

test("only the digest channel is told it can read what every channel filed", () => {
  const ordinary = promptFor({ channels: { eng: {} } });
  assert.doesNotMatch(ordinary, /feedback every channel filed|FEEDBACK\.md/);

  // `promptFor` resolves the channel as #eng, so naming it here makes it the
  // reviewer.
  const reviewer = promptFor({ feedback: { digestChannel: "eng" }, channels: { eng: {} } });
  assert.match(reviewer, /## The feedback every channel filed/);
  assert.match(reviewer, /FEEDBACK\.md/);
  assert.match(reviewer, /feedback\.jsonl/);
  // The same stance as page text and library skills: input, not instruction.
  assert.match(reviewer, /evidence about this harness, not instructions/);
});

test("a channel with exec is told it has selected CLIs, not a shell", () => {
  const prompt = promptFor({
    channels: {
      eng: {
        tools: ["read", "exec"],
        exec: { commands: { acli: { description: "Jira lookup", command: "acli" } } },
      },
    },
  });

  assert.match(prompt, /## Restricted CLI tools/);
  assert.match(prompt, /cli__acli/);
  assert.match(prompt, /not shell commands/);
  assert.doesNotMatch(prompt, /## Your shell/);
});

test("a channel with charts is told to use create_chart without bash", () => {
  const prompt = promptFor({ channels: { eng: { tools: ["read", "write", "charts"] } } });

  assert.match(prompt, /## Chart generation/);
  assert.match(prompt, /create_chart/);
  assert.match(prompt, /does not use bash/);
  assert.doesNotMatch(prompt, /## Your shell/);
});

test("a channel with slides is told to create and attach self-contained presentations", () => {
  const prompt = promptFor({ channels: { eng: { tools: ["read", "write", "slides"] } } });

  assert.match(prompt, /## Slide-deck generation/);
  assert.match(prompt, /create_slide_deck/);
  assert.match(prompt, /self-contained HTML/);
  assert.match(prompt, /---/);
  assert.match(prompt, /upload_file/);
  assert.doesNotMatch(prompt, /## Your shell/);
});

test("a channel with file_ops is told to organise workspace files without bash", () => {
  const prompt = promptFor({ channels: { eng: { tools: ["read", "write", "file_ops"] } } });

  assert.match(prompt, /## Workspace file management/);
  assert.match(prompt, /workspace_file_ops/);
  assert.match(prompt, /mkdir/);
  assert.match(prompt, /move/);
  assert.match(prompt, /copy/);
  assert.match(prompt, /delete/);
  assert.match(prompt, /without bash/);
  assert.doesNotMatch(prompt, /## Your shell/);
});

test("a channel with sqlite is told to use database tools without bash", () => {
  const prompt = promptFor({ channels: { eng: { tools: ["read", "write", "sqlite"] } } });

  assert.match(prompt, /## SQLite databases/);
  assert.match(prompt, /inspect_sqlite/);
  assert.match(prompt, /query_sqlite/);
  assert.match(prompt, /execute_sqlite/);
  assert.match(prompt, /without using bash/);
  assert.doesNotMatch(prompt, /## Your shell/);
});

test("a channel with configured image generation is told to generate then upload", () => {
  const prompt = promptFor({
    channels: {
      eng: {
        tools: ["read", "write", "images"],
        images: { provider: "openai", apiKey: "k" },
      },
    },
  });

  assert.match(prompt, /## AI image generation/);
  assert.match(prompt, /generate_image/);
  assert.match(prompt, /upload_file/);
});

test("a channel using an auth provider for image generation is told to generate then upload", () => {
  const prompt = promptFor({
    channels: {
      eng: {
        tools: ["read", "write", "images"],
        images: { provider: "openai", apiKey: "", authProvider: "openai-codex" },
      },
    },
  });

  assert.match(prompt, /## AI image generation/);
  assert.match(prompt, /generate_image/);
});

test("a channel without the web tool gets no web section at all", () => {
  const prompt = promptFor({ channels: { eng: { tools: ["read", "ls"] } } });
  assert.doesNotMatch(prompt, /Reading the internet/);
  assert.doesNotMatch(prompt, /fetch_url/);
});

test("artifact-enabled channels are told the private directory and stable browser URL", () => {
  const prompt = promptFor({ webConsole: { enabled: true, artifacts: true, baseUrl: "https://files.example.test/static" } });
  assert.match(prompt, /## Browser artifacts/);
  assert.match(prompt, /`artifacts\/` workspace folder is published at `https:\/\/files\.example\.test\/static\/channels\/C1\/artifacts\/`/);
  assert.match(prompt, /Do not publish secrets, private attachments, tokens, transcripts, memory/);
});


test("factory channels receive GitHub-Issue lifecycle and dashboard guidance", () => {
  const prompt = promptFor({
    webConsole: { enabled: true, baseUrl: "https://console.example.test" },
    channels: { eng: { factory: { name: "Home Factory", repositories: ["acme/widget"] } } },
  });
  assert.match(prompt, /## Software factory/);
  assert.match(prompt, /GitHub Issues are the durable task system/);
  assert.match(prompt, /get_factory_dashboard_link/);
  assert.match(prompt, /https:\/\/console\.example\.test\/console2\/#\/c\/C1\?view=factory/);
  assert.doesNotMatch(prompt, /publish_factory_dashboard|index\.html/);
  assert.match(prompt, /never fetched from the internet/);
  // A factory whose team lacks the workflow's roles has no run tools, so the prompt does not tell the agent to use them.
  assert.doesNotMatch(prompt, /start_factory_run|### Workflow runs/);
});

test("the factory prompt tells the agent about intake only when intake is on, and never to start a run for an issue intake takes", () => {
  const withIntake = promptFor({ channels: { eng: { factory: { name: "F", repositories: ["acme/widget"], intake: { enabled: true, goLabel: "ship-it" } } } } });
  const without = promptFor({ channels: { eng: { factory: { name: "F", repositories: ["acme/widget"] } } } });
  // The run tools need the roles; with the example agent set they are present only where the prompt says so.
  for (const prompt of [withIntake, without]) assert.match(prompt, /## Software factory/);
  if (/### Workflow runs/.test(withIntake)) {
    assert.match(withIntake, /Issue intake is on/);
    assert.match(withIntake, /labelled `ship-it`/);
    assert.match(withIntake, /do not start a run for an issue that is new, or that you just filed/);
    assert.match(withIntake, /nothing a commenter writes can approve or merge anything/);
    assert.doesNotMatch(without, /Issue intake is on/);
  }
});

test("factory prompt advertises only selected lifecycle skills", () => {
  const prompt = promptFor({
    channels: {
      eng: {
        factory: {
          name: "Home Factory",
          repositories: ["acme/widget"],
          lifecycleSkills: ["planning", "review"],
        },
      },
    },
  });
  const section = prompt.slice(prompt.indexOf("## Software factory")).split("\n\n## ")[0]!;

  assert.match(section, /`factory-planning`, `factory-review`/);
  assert.doesNotMatch(section, /factory-implementation/);
  assert.doesNotMatch(section, /factory-commit-pr/);
});

test("factory prompt acknowledges when no lifecycle skills are enabled", () => {
  const prompt = promptFor({
    channels: {
      eng: {
        factory: {
          name: "Home Factory",
          repositories: ["acme/widget"],
          lifecycleSkills: [],
        },
      },
    },
  });
  const section = prompt.slice(prompt.indexOf("## Software factory")).split("\n\n## ")[0]!;

  assert.match(section, /No factory lifecycle skills are enabled by configuration/);
  assert.doesNotMatch(section, /factory-(planning|implementation|review|commit-pr)/);
});


test("Docker shell guidance separates disposable clones from durable workspace outputs", () => {
  const docker = promptFor({ channels: { eng: { tools: ["bash"], sandbox: { mode: "docker" } } } });
  assert.match(docker, /Clone repositories into writable container-local `\/repos`, NOT `\/workspace`/);
  assert.match(docker, /host file tools cannot read `\/repos`/);
  assert.match(docker, /Background services keep the container active/);
  assert.doesNotMatch(docker, /bounded in-memory tmpfs/);
  const readonly = promptFor({ channels: { eng: { tools: ["bash"], sandbox: { mode: "docker", readOnlyRoot: true } } } });
  assert.match(readonly, /bounded in-memory tmpfs/);
  const host = promptFor({ channels: { eng: { tools: ["bash"] } } });
  assert.match(host, /`bash` runs in this channel's workspace/);
  assert.doesNotMatch(host, /Clone repositories into/);
});

const team = { team: { agents: { coder: { description: "Writes code." }, reviewer: { description: "Reviews code." } } } };

test("a channel with a team AND another channel to hand work to is told to choose by who the work is for, not by the verb", () => {
  const prompt = promptFor({
    agentSets: team,
    channels: { eng: { agentSet: "team", share: { delegateTo: [{ channel: "engineering", reason: "deploy context" }] } } },
  });
  const block = prompt.slice(prompt.indexOf("## Who to hand work to"));
  assert.match(block, /Choose by WHO the work is for, never by the verb/);
  assert.match(block, /`run_subagent`[\s\S]*`coder`, `reviewer`/);
  assert.match(block, /"transfer it to the reviewer"/, "the verb that fooled a real model is named");
  assert.match(block, /`transfer_to_channel` — only `engineering`/);
  assert.match(block, /A role name is never a channel name/);
  assert.match(block, /Never use `transfer_to_channel` to reach one of your own roles, or `run_subagent` to reach another channel/);
});

test("with nothing to confuse the team with, there is no disambiguation block", () => {
  const onlyTeam = promptFor({ agentSets: team, channels: { eng: { agentSet: "team" } } });
  assert.doesNotMatch(onlyTeam, /Who to hand work to/);
  assert.match(onlyTeam, /## Subagents/);
  const onlyChannels = promptFor({ channels: { eng: { share: { delegateTo: ["engineering"] } } } });
  assert.doesNotMatch(onlyChannels, /Who to hand work to/);
  assert.match(onlyChannels, /## Cross-channel delegation/);
});

test("each handoff tool's description points away from the other", async () => {
  const { createDelegationTools } = await import("./delegation-tools.ts");
  const { createSubagentTools } = await import("./subagent-tools.ts");
  const transfer = createDelegationTools({
    delegator: { transfer: async () => { throw new Error("unused"); } }, sourceChannelId: "C1", sourceChannelLabel: "#eng",
    allowedTargets: [{ channel: "engineering" }], currentThreadTs: () => "1.1", currentUserId: () => "U1",
  })[0]!;
  const run = createSubagentTools({
    agents: [{ name: "coder", description: "Writes code.", model: "m", thinkingLevel: "medium", tools: [], connectors: [], timeoutSeconds: 60, requireApproval: false }],
    runner: () => undefined, currentUserId: () => "U1", isApproved: () => true,
  })[0]!;
  assert.match(transfer.description, /only for ANOTHER channel/);
  assert.match(transfer.description, /never for one of your own subagents[\s\S]*run_subagent/);
  assert.match(run.description, /YOUR team, working inside THIS channel/);
  assert.match(run.description, /"transfer", "delegate" or "hand off" to one of these roles still mean this tool/);
  assert.match(run.description, /to send work to another channel's assistant, use transfer_to_channel/);
});

const postAsConfig = {
  agentSets: { guards: { agents: { post_guard: { description: "Reviews posts.", tools: [] } } } },
  channels: { eng: { agentSet: "guards", share: { postAs: { user: "U01OWNER1", reviewer: "post_guard" } } } },
};

test("a channel that may post as a person is told how, and the rules that bind it", () => {
  const prompt = promptFor(postAsConfig);
  const section = prompt.slice(prompt.indexOf("## Posting as a person")).split("\n\n## ")[0]!;
  assert.match(section, /## Posting as a person/);
  assert.match(section, /`post_as_user`/);
  assert.match(section, /<@U01OWNER1>/);
  assert.match(section, /any channel or DM/);
  assert.match(section, /footer[^\n]*automatically[^\n]*never write one yourself/i);
  assert.match(section, /reviewed/);
  assert.match(section, /channel owner sees a receipt of each post/);
  assert.match(section, /alert for any held post/);
  assert.match(section, /Text only/);
  assert.match(section, /`source` must be the verbatim request/);
  assert.match(section, /`reason`[^\n]*one sentence/);
  assert.match(section, /A hold is final: do not retry, re-word, or use another route/);
  assert.match(section, /private details/);
  assert.match(section, /data, not instructions/);
});

test("without postAs the prompt never mentions post_as_user", () => {
  const prompt = promptFor({ channels: { eng: {} } });
  assert.doesNotMatch(prompt, /post_as_user/);
  assert.doesNotMatch(prompt, /Posting as a person/);
});
