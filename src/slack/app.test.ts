import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  THREAD_MENTION_PROMPT,
  HarnessApp,
  buildDelegationNotification,
  buildDelegationPrompt,
  buildDelegationCompletionPrompt,
  formatDelegationCompletion,
  finishAgentReply,
  finishNoResponseAgentFailure,
  reportDelegatedRun,
  routeDelegationCompletion,
  scheduledRunResult,
  shouldResumeWaitingTask,
  buildSendToAssistantPrompt,
  modalOriginalMessagePreview,
  sendToAssistantTargetRef,
  promptForIncomingMessage,
  shortcutAllowedByDefault,
  shouldHandleMessageEvent,
  shouldRenderNoResponseForAgentError,
  configReloadWarnings,
  preserveActiveArtifactConfig,
} from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { TaskRunTracker, TaskStatusStore } from "../tasks/store.ts";


test("config reload warns about restart-only settings", () => {
  const previous = HarnessConfigSchema.parse({});
  const next = HarnessConfigSchema.parse({
    authPath: "./other-auth.json",
    modelProviders: {
      local: {
        baseUrl: "http://localhost:11434/v1",
        models: [{ id: "llama3" }],
      },
    },
    schedules: { maxPerChannel: 99 },
    dreams: { cron: "0 4 * * *" },
    backups: { cron: "30 3 * * *" },
    feedback: { digestChannel: "#admin" },
  });

  const warnings = configReloadWarnings(previous, next, "/data/current", "/data/next");

  assert.deepEqual(warnings, [
    "dataDir changed to /data/next; this process keeps using /data/current until restart.",
    "authPath changed; restart to move the credential store.",
    "modelProviders changed; restart to register provider additions/removals.",
    "top-level schedules settings changed; restart to rebuild existing schedule timers/limits.",
    "top-level dreams settings changed; restart to rebuild overnight timers.",
    "backups settings changed; restart to rebuild the backup timer.",
    "feedback digest timer settings changed; restart to rebuild the digest timer.",
  ]);
});

test("web server reload keeps agent guidance on the server's active configuration until restart", () => {
  const active = HarnessConfigSchema.parse({ webConsole: { enabled: true, artifacts: true, baseUrl: "https://files.example.test/old" } });
  const loaded = HarnessConfigSchema.parse({ webConsole: { enabled: true, artifacts: true, baseUrl: "https://files.example.test/new" }, channels: { eng: { description: "new config still applies" } } });
  const effective = preserveActiveArtifactConfig(active, loaded);

  assert.deepEqual(effective.webConsole, active.webConsole);
  assert.equal(effective.channels.eng?.description, "new config still applies");
  assert.deepEqual(
    configReloadWarnings(active, loaded, "/data", "/data"),
    ["web console settings changed; restart to rebind the web server."],
  );
});

test("changing only webConsole.artifacts or webConsole.historyLimit asks for a restart", () => {
  const base = HarnessConfigSchema.parse({ webConsole: { enabled: true, baseUrl: "https://console.example.test" } });
  for (const change of [{ artifacts: true }, { historyLimit: 5 }]) {
    const next = HarnessConfigSchema.parse({ webConsole: { enabled: true, baseUrl: "https://console.example.test", ...change } });
    assert.deepEqual(configReloadWarnings(base, next, "/data", "/data"), ["web console settings changed; restart to rebind the web server."], JSON.stringify(change));
  }
});

test("config reload accepts ordinary channel config changes without restart warnings", () => {
  const previous = HarnessConfigSchema.parse({ channels: { admin: { tools: ["read"] } } });
  const next = HarnessConfigSchema.parse({ channels: { admin: { tools: ["read", "write"] } } });

  assert.deepEqual(configReloadWarnings(previous, next, "/data", "/data"), []);
});


test("codex usage exhaustion renders as no response instead of an error", () => {
  assert.equal(
    shouldRenderNoResponseForAgentError(new Error("You have reached your usage limit."), "openai-codex/gpt-5.5"),
    true,
  );
  assert.equal(
    shouldRenderNoResponseForAgentError(new Error("429 rate_limit_exceeded: quota exhausted"), "openai-codex/gpt-5.5"),
    true,
  );
});

test("non-usage model errors still surface normally", () => {
  assert.equal(
    shouldRenderNoResponseForAgentError(new Error("Maximum context length exceeded"), "openai-codex/gpt-5.5"),
    false,
  );
  assert.equal(
    shouldRenderNoResponseForAgentError(new Error("quota exhausted"), "deepseek/deepseek-v4"),
    false,
  );
});

test("plain channel root messages require the channel opt-in", () => {
  const base = {
    isDm: false,
    inActiveThread: false,
    isRootMessage: true,
    mentionsBot: false,
  };

  assert.equal(shouldHandleMessageEvent({ ...base, respondToRootMessages: false }), false);
  assert.equal(shouldHandleMessageEvent({ ...base, respondToRootMessages: true }), true);
});

test("root message opt-in does not replace mention and active-thread handling", () => {
  assert.equal(
    shouldHandleMessageEvent({
      isDm: false,
      inActiveThread: false,
      isRootMessage: true,
      mentionsBot: true,
      respondToRootMessages: true,
    }),
    false,
    "app_mention handles tagged channel messages",
  );
  assert.equal(
    shouldHandleMessageEvent({
      isDm: false,
      inActiveThread: true,
      isRootMessage: false,
      mentionsBot: false,
      respondToRootMessages: false,
    }),
    true,
    "plain replies in active threads still continue the conversation",
  );
  assert.equal(
    shouldHandleMessageEvent({
      isDm: true,
      inActiveThread: false,
      isRootMessage: true,
      mentionsBot: false,
      respondToRootMessages: false,
    }),
    true,
    "DMs still reach the agent without channel opt-in",
  );
});


test("mention-only thread messages become a weigh-in prompt", () => {
  assert.equal(
    promptForIncomingMessage({
      text: "<@U123>",
      botUserId: "U123",
      threadTs: "1710000000.000001",
    }),
    THREAD_MENTION_PROMPT,
  );

  assert.equal(
    promptForIncomingMessage({
      text: "<@U123>",
      botUserId: "U123",
    }),
    "",
    "top-level mention-only messages still do not invite channel backfill",
  );

  assert.equal(
    promptForIncomingMessage({
      text: "",
      botUserId: "U123",
      threadTs: "1710000000.000001",
    }),
    "",
    "plain empty thread events still do not start a turn",
  );

  assert.equal(
    promptForIncomingMessage({
      text: "<@U123> what do you think?",
      botUserId: "U123",
      threadTs: "1710000000.000001",
    }),
    "what do you think?",
  );
});

test("message shortcut is gated by defaults.allowUsers", () => {
  assert.equal(shortcutAllowedByDefault(undefined, "U1"), true);
  assert.equal(shortcutAllowedByDefault(["U1"], "U1"), true);
  assert.equal(shortcutAllowedByDefault(["U2"], "U1"), false);
});

test("message shortcut modal shows the original message without making it the instruction input", () => {
  assert.equal(modalOriginalMessagePreview("  hello  ", false), "hello");
  assert.equal(modalOriginalMessagePreview("", true), "_No message text; attachments are selected below._");
  assert.equal(modalOriginalMessagePreview("x".repeat(4000)).length, 2900);
  assert.equal(modalOriginalMessagePreview("x".repeat(4000)).endsWith("…"), true);
});

test("message shortcut target falls back to configured default", () => {
  assert.deepEqual(sendToAssistantTargetRef("C123", "#admin"), { ref: "C123", fromDefault: false });
  assert.deepEqual(sendToAssistantTargetRef("  ", " #admin "), { ref: "#admin", fromDefault: true });
  assert.equal(sendToAssistantTargetRef(undefined, ""), undefined);
});

test("message shortcut prompt carries source and attachment context", () => {
  const prompt = buildSendToAssistantPrompt({
    submittedBy: "U1",
    instructions: "Summarise this",
    source: {
      channelId: "C1",
      channelName: "elsewhere",
      messageTs: "123.456",
      messageText: "original",
      messageUserId: "U2",
      files: [{ name: "photo.png", mimetype: "image/png" }],
    },
    sourcePermalink: "https://slack.example/archives/C1/p123456",
    includeFiles: true,
  });

  assert.match(prompt, /Submitted by: <@U1>/);
  assert.match(prompt, /Original author: <@U2>/);
  assert.match(prompt, /Original message: https:\/\/slack\.example\/archives\/C1\/p123456/);
  assert.match(prompt, /Original attachments: 1 file\(s\) included with this turn\./);
  assert.match(prompt, /Original message text \(copied unchanged\):\noriginal/);
  assert.match(prompt, /Additional instructions:\nSummarise this/);
});


test("delegation briefing card names the target and shows a task summary", () => {
  const notification = buildDelegationNotification({
    requestedBy: "U1",
    targetChannelLabel: "#qa",
    sourceChannelLabel: "#admin",
    sourceThreadPermalink: "https://slack.example/archives/C1/p123456",
    task: "Review PR #48 for SQLite tool support.",
    context: "Check isolation, the Docker image, and RETURNING truncation.",
  });

  assert.equal(
    notification,
    [
      ":arrow_forward: *Task transferred to #qa*.",
      "*Summary:* Review PR #48 for SQLite tool support.",
      "From #admin by <@U1>.",
      "*Context:* Check isolation, the Docker image, and RETURNING truncation.",
      "Source: https://slack.example/archives/C1/p123456",
      "Discuss it in this thread.",
    ].join("\n"),
  );
});

test("delegation briefing card shortens long multiline tasks", () => {
  const task = `  Review the release candidate\n\n${"with every relevant configuration edge case ".repeat(10)} `;
  const notification = buildDelegationNotification({
    requestedBy: "U1",
    targetChannelLabel: "#engineering",
    sourceChannelLabel: "#admin",
    task,
  });
  const [, summary = ""] = notification.split("\n");

  assert.match(notification, /Task transferred to #engineering/);
  assert.equal(summary.startsWith("*Summary:* "), true);
  assert.equal(summary.includes("\n"), false);
  assert.equal(summary.endsWith("…"), true);
  assert.ok(summary.length <= "*Summary:* ".length + 280);
  assert.doesNotMatch(notification, /Context:|Source:/);
});

test("delegation briefing card does not split emoji while truncating", () => {
  const notification = buildDelegationNotification({
    requestedBy: "U1",
    targetChannelLabel: "#engineering",
    sourceChannelLabel: "#admin",
    task: `${"a".repeat(278)}😀more task details`,
  });

  assert.equal(notification.split("\n")[1], `*Summary:* ${"a".repeat(278)}😀…`);
});

test("delegation prompt explains that the initial outcome returns to the source", () => {
  const prompt = buildDelegationPrompt({
    requestedBy: "U1",
    sourceChannelLabel: "#life-admin",
    sourceThreadPermalink: "https://slack.example/archives/C1/p123456",
    task: "Check whether the backup job is failing.",
    context: "The life-admin assistant does not have shell access.",
  });

  assert.match(prompt, /transferred to this channel assistant/);
  assert.match(prompt, /Requested by: <@U1>/);
  assert.match(prompt, /Source thread: https:\/\/slack\.example\/archives\/C1\/p123456/);
  assert.match(prompt, /result or failure will be posted automatically to the source thread/);
  assert.match(prompt, /Check whether the backup job is failing\./);
  assert.match(prompt, /life-admin assistant does not have shell access/);
});


test("delegation completion returns the target result with a thread link", () => {
  const message = formatDelegationCompletion({
    status: "completed",
    targetChannelLabel: "#qa",
    targetPermalink: "https://slack.example/archives/CQA/p123456",
    text: "PR reviewed: three blocking issues remain.",
  });

  assert.match(message, /Delegated task completed/);
  assert.match(message, /<https:\/\/slack\.example\/archives\/CQA\/p123456\|#qa>/);
  assert.match(message, /PR reviewed: three blocking issues remain\./);
});

test("delegation completion reports failure without exposing another posting capability", () => {
  const message = formatDelegationCompletion({
    status: "failed",
    targetChannelLabel: "#qa",
    error: "The target model was unavailable.",
  });

  assert.match(message, /Delegated task failed in #qa/);
  assert.match(message, /Error: The target model was unavailable\./);
  assert.match(message, /delegated thread/i);
});

test("delegation completion marks direct target publication without an empty result", () => {
  const message = formatDelegationCompletion({
    status: "completed",
    targetChannelLabel: "#qa",
    postedDirectly: true,
  });

  assert.match(message, /published its deliverable directly/i);
  assert.doesNotMatch(message, /Result:/);
});

test("a failed scheduled agent outcome preserves its Slack output permalink", () => {
  assert.deepEqual(
    scheduledRunResult(
      { status: "failed", error: "model unavailable" },
      "https://example.slack.com/archives/C1/p123",
    ),
    {
      status: "failed",
      error: "model unavailable",
      slackOutputUrl: "https://example.slack.com/archives/C1/p123",
    },
  );
  assert.deepEqual(scheduledRunResult({ status: "completed" }), { status: "completed" });
});

test("a scheduled failure before channel resolution is retained in task history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-scheduled-task-"));
  try {
    const taskStore = new TaskStatusStore(dir);
    const harness = {
      app: { client: {} },
      taskStore,
      async resolveBackgroundChannel() { return { rejected: "not configured" }; },
    };
    const result = await (HarnessApp.prototype as any).runScheduledTask.call(harness, {
      id: "task-1", channelId: "C1", prompt: "check https://example.test/report?token=secret", createdBy: "U1",
    });
    assert.deepEqual(result, { status: "failed", error: "Channel unavailable: not configured." });
    assert.equal(taskStore.all()[0]!.status, "failed");
    assert.equal(taskStore.all()[0]!.summary, "check https://example.test/report");
    (harness as any).resolveBackgroundChannel = async () => ({ channel: { ref: { id: "C1" }, schedulesEnabled: false } });
    const disabled = await (HarnessApp.prototype as any).runScheduledTask.call(harness, {
      id: "task-2", channelId: "C1", prompt: "check", createdBy: "U1",
    });
    assert.deepEqual(disabled, { status: "failed", error: "Scheduling is disabled in C1." });
    assert.equal(taskStore.all()[1]!.status, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("visible scheduled wait resumes and closes the same record on an ordinary reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-visible-scheduled-task-"));
  try {
    const tasks = new TaskStatusStore(dir);
    // A visible schedule starts before Slack gives us the root timestamp, then
    // replaces that synthetic key when its post succeeds.
    const scheduled = new TaskRunTracker(tasks, { channelId: "C1", threadKey: "scheduled-task-1", summary: "Check CI", kind: "scheduled" });
    scheduled.start("scheduled");
    scheduled.setThreadKey("123.456");
    scheduled.setStatus("waiting", "Waiting for CI");

    assert.equal(shouldResumeWaitingTask(tasks, "C1", "123.456"), true);
    const reply = new TaskRunTracker(tasks, { channelId: "C1", threadKey: "123.456", summary: "CI is green" });
    assert.equal(reply.start().id, scheduled.current()!.id);
    reply.finish("completed");

    assert.equal(tasks.all().length, 1);
    assert.equal(tasks.all()[0]!.status, "closed_successfully");
    assert.equal(tasks.all()[0]!.threadKey, "123.456");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runAgentTurn resumes a waiting task for an ordinary Slack reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-agent-turn-task-"));
  try {
    const taskStore = new TaskStatusStore(dir);
    const existing = taskStore.start({ channelId: "C1", threadKey: "123.456", summary: "Wait for CI", kind: "review" });
    taskStore.update(existing.id, "waiting", "Waiting for CI");
    let tracker: TaskRunTracker | undefined;
    const thread = {
      currentUserId: "",
      store: { steeringParent: async () => undefined, deliveryState: async () => undefined, recordDelivery: async () => ({}) },
      setTaskTracker(value: TaskRunTracker | undefined) { tracker = value; },
      setSubagentProgress() {},
      session: {
        async model() { return undefined; },
        subscribe() { return () => {}; },
        async prompt() {},
        getLastAssistantText() { return "CI is green."; },
      },
    };
    const harness = {
      taskStore,
      pendingThread: new Map(), pendingUser: new Map(),
      pool: { get() { return thread; } },
      config: { ui: { ackEmoji: "hourglass", showToolActivity: false, toolActivityAfterMs: 1 }, schedules: { timezone: "UTC" } },
      opts: { botToken: "token" }, botUserId: "UBOT", resumedRequests: new Set<string>(),
    };
    const client = {
      reactions: { add: async () => {}, remove: async () => {} },
      chat: { postMessage: async () => ({ ts: "reply-ts" }), update: async () => {} },
    };
    const result = await (HarnessApp.prototype as any).runAgentTurn.call(
      harness,
      client,
      { ref: { id: "C1", name: "ops" }, model: "model", context: {}, documents: { canAdd: false }, schedulesEnabled: false },
      "123.456", "123.456",
      { channelId: "C1", userId: "U1", text: "CI is green", ts: "123.457" },
      "CI is green",
    );
    assert.equal(result.status, "completed");
    assert.equal(tracker, undefined, "tracker is cleared after the turn");
    assert.equal(taskStore.all().length, 1);
    assert.equal(taskStore.get(existing.id)?.status, "closed_successfully");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ordinary thread replies resume waiting task records", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-waiting-task-"));
  try {
    const tasks = new TaskStatusStore(dir);
    const record = tasks.start({ channelId: "C1", threadKey: "123.456", summary: "Await CI", kind: "review" });
    tasks.update(record.id, "waiting", "Waiting for CI");
    assert.equal(shouldResumeWaitingTask(tasks, "C1", "123.456"), true);
    assert.equal(shouldResumeWaitingTask(tasks, "C1", "other-thread"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a visible scheduled Slack-post failure creates exactly one failed record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-scheduled-post-failure-"));
  try {
    const taskStore = new TaskStatusStore(dir);
    const harness = {
      app: { client: {} }, taskStore,
      async resolveBackgroundChannel() { return { channel: { ref: { id: "C1" }, schedulesEnabled: true, configKey: "ops", tools: [], envSources: [] } }; },
      async post() { throw new Error("chat.postMessage failed"); },
    };
    const result = await (HarnessApp.prototype as any).runScheduledTask.call(harness, { id: "task-1", channelId: "C1", prompt: "check CI", createdBy: "U1" });
    assert.deepEqual(result, { status: "failed", error: "chat.postMessage failed" });
    assert.equal(taskStore.all().length, 1);
    assert.equal(taskStore.all()[0]!.status, "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a visible scheduled task uses its Slack thread key for later continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-scheduled-task-"));
  try {
    const taskStore = new TaskStatusStore(dir);
    const harness = {
      app: { client: {} }, taskStore,
      async resolveBackgroundChannel() { return { channel: { ref: { id: "C1", name: "ops" }, schedulesEnabled: true, configKey: "ops", tools: [], envSources: [] } }; },
      async post() { return { ts: "123.456", permalink: "https://example.slack.com/archives/C1/p123456" }; },
      async runAgent(_client: unknown, _channel: unknown, threadKey: string, _threadTs: string, _message: unknown, _prompt: string, options: any) {
        assert.equal(threadKey, "123.456");
        options.taskTracker.setStatus("waiting", "Waiting for CI");
        return { status: "completed" };
      },
    };
    await (HarnessApp.prototype as any).runScheduledTask.call(harness, { id: "task-1", channelId: "C1", prompt: "check CI", createdBy: "U1" });
    assert.equal(taskStore.all()[0]!.threadKey, "123.456");
    assert.equal(taskStore.all()[0]!.status, "waiting");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ["visible", "thread", "quiet"] as const) {
  test(`${mode} scheduled executions pass the saved timezone and refresh time after startup`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const dir = mkdtempSync(join(tmpdir(), "harness-scheduled-time-"));
    try {
      const prompts: string[] = [];
      const config = HarnessConfigSchema.parse({ ui: { showToolActivity: false }, schedules: { timezone: "UTC" } });
      const channel = {
        ref: { id: "C1", name: "ops" }, model: "model", context: {}, documents: { canAdd: false },
        paths: { sessions: join(dir, "sessions") }, schedulesEnabled: true, tools: [], envSources: [],
      };
      const thread = {
        currentUserId: "", setTaskTracker() {}, setSubagentProgress() {},
        store: { steeringParent: async () => undefined, deliveryState: async () => undefined, recordDelivery: async () => ({}) },
        session: {
          async model() {
            // Visible/thread startup finishes on a different date from dispatch.
            t.mock.timers.tick(60_000);
            return undefined;
          },
          subscribe() { return () => {}; },
          async prompt(text: string) { prompts.push(text); },
          getLastAssistantText() { return "Done."; },
        },
        async dispose() {},
      };
      const client = {
        reactions: { add: async () => {}, remove: async () => {} },
        chat: { postMessage: async () => ({ ts: "reply-ts" }), update: async () => {} },
      };
      const harness = {
        config, app: { client }, taskStore: new TaskStatusStore(dir),
        pendingThread: new Map(), pendingUser: new Map(), pool: { get() { return thread; } },
        opts: { botToken: "token", modelRuntime: {} }, botUserId: "UBOT", resumedRequests: new Set<string>(),
        async resolveBackgroundChannel() { return { channel }; },
        async post() { return { ts: "123.456" }; },
        async scheduledOutputPermalink() { return undefined; },
        runAgent(...args: any[]) { return (HarnessApp.prototype as any).runAgentTurn.call(this, ...args); },
        runQuietScheduledTask: (HarnessApp.prototype as any).runQuietScheduledTask,
        baseSessionOptions() { return {}; },
        async createQuietScheduledThread() {
          // Quiet runs have a separate session startup, but the same freshness rule.
          t.mock.timers.tick(60_000);
          return thread;
        },
      };
      const task = {
        id: "task-1", channelId: "C1", prompt: "Report today's appointments and tomorrow's.",
        timezone: "Asia/Kathmandu", createdBy: "U1", createdAt: "2020-01-01T00:00:00Z",
        cron: "0 9 * * *", runIfMissed: true,
        ...(mode === "quiet" ? { quiet: true } : {}),
        ...(mode === "thread" ? { thread: { threadKey: "old-thread", threadTs: "123.456" } } : {}),
      };
      for (const day of [1, 3]) {
        t.mock.timers.setTime(new Date(`2026-01-0${day}T23:59:00Z`).getTime());
        const result = await (HarnessApp.prototype as any).runScheduledTask.call(harness, task);
        assert.equal(result.status, "completed", result.error);
        const prompt = prompts.at(-1)!;
        assert.ok(prompt.includes(`Execution timestamp (UTC): 2026-01-0${day + 1}T00:00:00.000Z`));
        assert.ok(prompt.includes(`Local date/time: 2026-01-0${day + 1}T05:45:00+05:45 [Asia/Kathmandu]`));
        assert.ok(prompt.includes("Task timezone: Asia/Kathmandu (UTC+05:45)"));
        assert.doesNotMatch(prompt, /2020-01-01/);
        assert.ok(prompt.endsWith(`Task:\n${task.prompt}`));
      }
      assert.equal(prompts.length, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("a quiet scheduled run keeps its published output link when the prompt then fails", async () => {
  let sessionInput: any;
  let disposed = false;
  const harness = {
    config: { name: "Harness", schedules: { timezone: "UTC" } },
    botUserId: "UBOT",
    opts: { modelRuntime: {} },
    scheduler: {},
    runtimes: {},
    baseSessionOptions() { return {}; },
    async createQuietScheduledThread(input: any) {
      sessionInput = input;
      return {
        currentUserId: "",
        session: {
          subscribe() { return () => {}; },
          async prompt() {
            await input.poster.post({ channelId: "C1", text: "The backup failed." });
            throw new Error("model stream interrupted");
          },
        },
        async dispose() {
          disposed = true;
        },
      };
    },
    async post() {
      return { ts: "123.456", permalink: "https://example.slack.com/archives/C1/p123456" };
    },
    async upload() {
      return {};
    },
  };

  const result = await (HarnessApp.prototype as any).runQuietScheduledTask.call(
    harness,
    { ref: { id: "C1", name: "ops" }, schedulesEnabled: true },
    { id: "task-1", prompt: "check the backup", timezone: "UTC", createdBy: "U1" },
  );

  assert.equal(sessionInput.initialUserId, "U1");
  assert.equal(sessionInput.sandboxThreadKey, "scheduled-task-1");
  assert.match(sessionInput.threadKey, /^scheduled-task-1-\d+$/);
  assert.equal(disposed, true);
  assert.deepEqual(result, {
    status: "failed",
    error: "model stream interrupted",
    slackOutputUrl: "https://example.slack.com/archives/C1/p123456",
  });
});

test("a target reply delivery error remains a completed delegated task", () => {
  const message = formatDelegationCompletion({
    status: "completed",
    targetChannelLabel: "#qa",
    text: "All checks passed.",
    deliveryError: "channel_not_found",
  });

  assert.match(message, /Delegated task completed in #qa/);
  assert.match(message, /Slack could not publish.*final reply/i);
  assert.match(message, /Delivery error: channel_not_found/);
  assert.match(message, /All checks passed/);
  assert.doesNotMatch(message, /Delegated task failed/);
});

test("a final Slack reply failure does not turn a completed run into a task failure", async () => {
  let discarded = false;
  const result = await finishAgentReply(
    {
      async close() { throw new Error("channel_not_found"); },
      async discard() { discarded = true; },
    },
    "The target completed its work.",
    false,
  );

  assert.deepEqual(result, { deliveryError: "channel_not_found" });
  assert.equal(discarded, false);
});

test("a direct-publication cleanup failure remains a delivery error", async () => {
  let closed = false;
  const result = await finishAgentReply(
    {
      async close() { closed = true; },
      async discard() { throw new Error("channel_not_found"); },
    },
    undefined,
    true,
  );

  assert.deepEqual(result, { deliveryError: "channel_not_found" });
  assert.equal(closed, false);
});

test("a no-response render failure preserves the original agent failure", async () => {
  const result = await finishNoResponseAgentFailure(
    {
      async close() { throw new Error("channel_not_found"); },
      async discard() {},
    },
    "You have reached your usage limit.",
  );

  assert.deepEqual(result, {
    status: "failed",
    error: "You have reached your usage limit.",
    deliveryError: "channel_not_found",
  });
});

test("delegation completion is routed only to the originating channel and thread", async () => {
  const posts: Array<{ channelId: string; threadTs?: string; text: string }> = [];

  const callback = await routeDelegationCompletion(
    {
      async post(input) {
        posts.push(input);
        return { ts: "456.789" };
      },
    },
    {
      sourceChannelId: "CADMIN",
      sourceThreadTs: "123.456",
      sourceUserId: "U1",
      status: "completed",
      targetChannelLabel: "#qa",
      text: "Review complete.",
    },
  );

  assert.equal(callback.ts, "456.789");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.channelId, "CADMIN");
  assert.equal(posts[0]?.threadTs, "123.456");
  assert.match(posts[0]?.text ?? "", /Review complete\./);
});


test("delegation completion prompt resumes the source agent without a Slack event", () => {
  const prompt = buildDelegationCompletionPrompt({
    status: "completed",
    targetChannelLabel: "#qa",
    text: "Changes requested: validate symlink targets before resolving paths.",
  });

  assert.match(prompt, /delegated task has reported its outcome/i);
  assert.match(prompt, /take any appropriate next step without waiting for another mention/i);
  assert.match(prompt, /Harness notification/);
  assert.match(prompt, /Changes requested: validate symlink targets/i);
});

test("delegation completion posts then directly wakes its source thread", async () => {
  const posts: any[] = [];
  const runs: any[][] = [];
  const source = { ref: { id: "CENGINEERING" } };
  const harness = {
    app: { client: { marker: "Slack client" } },
    async post(input: any) {
      posts.push(input);
      return { ts: "456.789" };
    },
    async resolveBackgroundChannel(channelId: string) {
      assert.equal(channelId, "CENGINEERING");
      return { channel: source };
    },
    async runAgent(...args: any[]) {
      runs.push(args);
      return { status: "completed" };
    },
  };

  await (HarnessApp.prototype as any).postDelegationCompletion.call(harness, {
    sourceChannelId: "CENGINEERING",
    sourceThreadTs: "123.456",
    sourceUserId: "U1",
    status: "completed",
    targetChannelLabel: "#qa",
    text: "Changes requested: add coverage for bot-authored callbacks.",
  });

  const [post] = posts;
  const [run] = runs;
  assert.ok(post);
  assert.ok(run);
  assert.equal(post.threadTs, "123.456");
  assert.equal(run[0], harness.app.client);
  assert.equal(run[1], source);
  assert.equal(run[2], "123.456");
  assert.equal(run[3], "123.456");
  assert.deepEqual(run[4], {
    channelId: "CENGINEERING",
    userId: "U1",
    text: ":white_check_mark: *Delegated task completed in #qa.*\nResult:\nChanges requested: add coverage for bot-authored callbacks.",
    ts: "456.789",
  });
  assert.match(run[5], /take any appropriate next step without waiting for another mention/i);
});


test("delegated initial runs report one success or failure callback", async () => {
  const route = {
    sourceChannelId: "CADMIN",
    sourceThreadTs: "123.456",
    sourceUserId: "U1",
    targetChannelLabel: "#qa",
  };
  const completions: any[] = [];
  const report = async (completion: any) => { completions.push(completion); };

  await reportDelegatedRun(Promise.resolve({ status: "completed", text: "Done." }), route, report);
  await reportDelegatedRun(Promise.reject(new Error("target unavailable")), route, report);

  assert.deepEqual(completions.map((completion) => completion.status), ["completed", "failed"]);
  assert.equal(completions[0]?.text, "Done.");
  assert.equal(completions[1]?.error, "target unavailable");
});

test("delegation completion caps the returned result before source posting", () => {
  const text = "x".repeat(12_100);
  const message = formatDelegationCompletion({
    status: "completed",
    targetChannelLabel: "#qa",
    text,
  });

  assert.ok(message.length < 12_200);
  assert.ok(message.endsWith("…"));
});

test("runAgentTurn keeps its config snapshot across asynchronous Slack startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-turn-config-snapshot-"));
  try {
    const turnConfig = HarnessConfigSchema.parse({ ui: { showToolActivity: false } });
    const thread = {
      currentUserId: "", setTaskTracker() {}, setSubagentProgress() {},
      store: { steeringParent: async () => undefined, deliveryState: async () => undefined, recordDelivery: async () => ({}) },
      session: {
        async model() { return undefined; }, subscribe() { return () => {}; },
        async prompt() {}, getLastAssistantText() { return "Done."; },
      },
    };
    const harness = {
      taskStore: new TaskStatusStore(dir), pendingThread: new Map(), pendingUser: new Map(),
      pool: { get() { return thread; } }, config: turnConfig,
      opts: { botToken: "token" }, botUserId: "UBOT", resumedRequests: new Set<string>(),
    };
    const client = {
      reactions: { add: async () => {}, remove: async () => {} },
      chat: {
        postMessage: async () => {
          // A reload may happen while posting the initial placeholder. Any
          // later dynamic config read would mix generations during startup.
          harness.config = new Proxy(turnConfig, { get() { throw new Error("Read live config during old turn"); } });
          return { ts: "reply-ts" };
        },
        update: async () => {},
      },
    };
    const result = await (HarnessApp.prototype as any).runAgentTurn.call(
      harness, client,
      { ref: { id: "C1" }, model: "model", context: {}, documents: { canAdd: false }, schedulesEnabled: false },
      "123.456", "123.456", { channelId: "C1", userId: "U1", ts: "123.457" }, "hello", undefined, turnConfig,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Done.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("console OAuth approval/commit re-resolves actual channel user and connector boundaries after reload", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "console-oauth-permissions-"));
  try {
    const config = HarnessConfigSchema.parse({
      channels: { CTARGET: { allowUsers: ["UINITIATOR"], connectors: { calendar: { transport: "http", url: "https://mcp.example.org/mcp", oauth: {
        clientId: "synthetic-client", redirectUrl: "https://console.example.org/oauth/callback", consoleCallback: true,
      } } } } },
    });
    const registry = new ChannelRegistry(dataDir);
    const channel = resolveChannel(config, dataDir, { id: "CTARGET", isDm: false }, registry).channel!;
    const connector = channel.connectors[0]!;
    assert.equal(connector.config.transport, "http");
    if (connector.config.transport !== "http") assert.fail("fixture must be HTTP");
    const target = { userId: "UINITIATOR", channelId: "CTARGET", threadTs: "123.456", connectorName: "calendar", channelRoot: channel.paths.root,
      connectorUrl: connector.config.url, oauth: connector.config.oauth! };
    const harness = { config, registry, opts: { dataDir } };
    const allowed = () => (HarnessApp.prototype as any).consoleOAuthAllowed.call(harness, target);
    assert.equal(allowed(), true);
    assert.equal((HarnessApp.prototype as any).consoleOAuthAllowed.call(harness, { ...target, channelId: "COTHER" }), false);
    assert.equal((HarnessApp.prototype as any).consoleOAuthAllowed.call(harness, { ...target, userId: "UOTHER" }), false);
    assert.equal((HarnessApp.prototype as any).consoleOAuthAllowed.call(harness, { ...target, channelRoot: "/other-scope" }), false);
    config.channels.CTARGET!.allowUsers = ["UOTHER"];
    assert.equal(allowed(), false);
    config.channels.CTARGET!.allowUsers = ["UINITIATOR"];
    const actual = config.channels.CTARGET!.connectors!.calendar!;
    assert.equal(actual.transport, "http");
    if (actual.transport !== "http") assert.fail("fixture must be HTTP");
    actual.oauth!.clientId = "synthetic-changed-client";
    assert.equal(allowed(), false, "pending flight config is immutable, including client credentials");
    actual.oauth!.clientId = "synthetic-client";
    assert.equal(allowed(), true);
    config.channels.CTARGET!.connectors = {};
    assert.equal(allowed(), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("console OAuth external callback stays on active server config until restart", () => {
  const active = HarnessConfigSchema.parse({ webConsole: { enabled: true, baseUrl: "https://console.example.test", oauth: { callbackUrl: "https://console.example.test/oauth/callback" } } });
  const loaded = HarnessConfigSchema.parse({ webConsole: { enabled: true, baseUrl: "https://new.example.test", oauth: { callbackUrl: "https://new.example.test/oauth/callback" } } });
  assert.deepEqual(preserveActiveArtifactConfig(active, loaded).webConsole, active.webConsole);
  assert.ok(configReloadWarnings(active, loaded, "/data", "/data").includes("web console settings changed; restart to rebind the web server."));
});

test("web OAuth lookup accepts only known console channels and explicitly supported connector scopes", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "web-oauth-lookup-"));
  try {
    const callbackUrl = "https://console.example.org/oauth/callback";
    const config = HarnessConfigSchema.parse({ webConsole: { enabled: true, baseUrl: "https://console.example.org", oauth: { callbackUrl } },
      channels: { CTARGET: { allowUsers: ["UINITIATOR"], connectors: { calendar: { transport: "http", url: "https://mcp.example.org/mcp", oauth: {
        clientId: "synthetic-client", redirectUrl: callbackUrl, consoleCallback: true,
      } } } } } });
    const registry = new ChannelRegistry(dataDir);
    const harness = { config, registry, opts: { dataDir }, taskStore: new TaskStatusStore(dataDir), connectorOAuth: { callbackUrl },
      consoleSource: function () { return HarnessApp.prototype.consoleSource.call(this as never); } };
    const lookup = (id = "CTARGET", name = "calendar") => (HarnessApp.prototype as any).consoleOAuthBrowserTarget.call(harness, id, name);
    const target = lookup();
    assert.equal(target.channelId, "CTARGET");
    assert.equal(target.connectorName, "calendar");
    assert.equal(Object.hasOwn(target, "userId"), false, "web visitors cannot assert Slack identity");
    assert.equal(lookup("CUNKNOWN"), undefined, "unseen/unconfigured channels cannot receive pairing spam");
    assert.equal(lookup("CTARGET", "not-enabled"), undefined);
    const connector = config.channels.CTARGET!.connectors!.calendar!;
    if (connector.transport !== "http") assert.fail("fixture must be HTTP");
    connector.oauth!.tokenFile = "shared.json";
    assert.equal(lookup(), undefined);
    connector.oauth!.tokenFile = undefined;
    connector.oauth!.redirectUrl = "https://another.example.org/oauth/callback";
    assert.equal(lookup(), undefined);
    connector.oauth!.redirectUrl = callbackUrl;
    connector.oauth!.consoleCallback = false;
    assert.equal(lookup(), undefined);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// --- postToChannel: the allowlist re-check behind post_to_channel -----------

function crossPostHarness(opts: { channels?: Array<{ id: string; name: string }>; postError?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cross-post-"));
  const posted: Array<Record<string, unknown>> = [];
  const listed: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        if (opts.postError) throw Object.assign(new Error("slack"), { data: { error: opts.postError } });
        posted.push(args);
        return { ts: "1.2" };
      },
      getPermalink: async () => ({ permalink: "https://slack/p/1.2" }),
    },
    conversations: {
      list: async (args: Record<string, unknown>) => {
        listed.push(args);
        return { channels: opts.channels ?? [], response_metadata: {} };
      },
    },
  };
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    app: { client },
    registry: new ChannelRegistry(dir),
    postTargetIds: new Map<string, string>(),
    channelName: async () => "announcements",
  });
  const post = (input: { target: string; allowed: Array<{ channel: string }>; source?: string }) =>
    (harness as any).postToChannel({
      sourceChannelId: input.source ?? "C1",
      allowedTargets: input.allowed,
      target: input.target,
      text: "Invoice received.",
    }) as Promise<{ channelLabel: string; ts: string; permalink?: string }>;
  return { post, posted, listed, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("postToChannel posts top-level to the id of the configured entry", async () => {
  const h = crossPostHarness();
  try {
    const result = await h.post({ target: "C2", allowed: [{ channel: "C2" }] });
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0]!.channel, "C2");
    assert.equal(h.posted[0]!.text, "Invoice received.");
    assert.equal("thread_ts" in h.posted[0]!, false);
    assert.equal(result.channelLabel, "#announcements");
    assert.equal(result.permalink, "https://slack/p/1.2");
  } finally {
    h.cleanup();
  }
});

test("postToChannel refuses a target that is not in the allowlist, even a lookalike", async () => {
  const h = crossPostHarness();
  try {
    for (const target of ["C3", "#other", "c2"]) {
      await assert.rejects(() => h.post({ target, allowed: [{ channel: "C2" }] }), /only configured to post to: C2/);
    }
    await assert.rejects(() => h.post({ target: "C2", allowed: [] }), /\(none\)/);
    assert.equal(h.posted.length, 0);
    assert.equal(h.listed.length, 0);
  } finally {
    h.cleanup();
  }
});

test("postToChannel refuses the originating channel and direct messages", async () => {
  const h = crossPostHarness();
  try {
    await assert.rejects(() => h.post({ target: "C2", allowed: [{ channel: "C2" }], source: "C2" }), /post_message/);
    await assert.rejects(() => h.post({ target: "D9", allowed: [{ channel: "D9" }] }), /direct messages/);
    assert.equal(h.posted.length, 0);
  } finally {
    h.cleanup();
  }
});

test("postToChannel resolves a configured name by listing channels once, and matches #name", async () => {
  const h = crossPostHarness({ channels: [{ id: "C7", name: "finance" }, { id: "C8", name: "announcements" }] });
  try {
    await h.post({ target: "#announcements", allowed: [{ channel: "announcements" }] });
    await h.post({ target: "announcements", allowed: [{ channel: "announcements" }] });
    assert.deepEqual(h.posted.map((p) => p.channel), ["C8", "C8"]);
    assert.equal(h.listed.length, 1);
  } finally {
    h.cleanup();
  }
});

test("postToChannel does not post when a configured name cannot be found", async () => {
  const h = crossPostHarness({ channels: [{ id: "C7", name: "finance" }] });
  try {
    await assert.rejects(() => h.post({ target: "ghost", allowed: [{ channel: "ghost" }] }), /could not find Slack channel ghost/);
    assert.equal(h.posted.length, 0);
  } finally {
    h.cleanup();
  }
});

test("postToChannel tells the model how to fix a bot that is not in the channel", async () => {
  const h = crossPostHarness({ postError: "not_in_channel" });
  try {
    await assert.rejects(() => h.post({ target: "C2", allowed: [{ channel: "C2" }] }), /chat:write\.public/);
  } finally {
    h.cleanup();
  }
});
