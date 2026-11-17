import { existsSync, readFileSync } from "node:fs";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  estimateTokens,
  formatSkillsForPrompt,
  type ToolDefinition,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ToolName } from "../config/schema.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { loadAvailableSkills, presentSkills } from "./skills.ts";
import { createMemoryTools } from "./memory.ts";
import { createSkillTools } from "./skills.ts";
import { createLibraryTools } from "./library-tools.ts";
import { createDocumentTools } from "./document-tools.ts";
import { createFeedbackTools } from "./feedback-tools.ts";
import { createNotificationTools } from "./notification-tools.ts";
import { createModelTools } from "./model-tools.ts";
import { createScheduleTools } from "./schedule-tools.ts";
import { createCrossChannelPostTools, createPostTools } from "./post-tools.ts";
import { createPostAsTools } from "./post-as-tools.ts";
import { createInteractiveTools } from "./interactive-tools.ts";
import { createFileTools } from "./file-tools.ts";
import { createWorkspaceFileTools } from "./workspace-file-tools.ts";
import { createKnowledgeTools } from "./knowledge-tools.ts";
import { createLocalPdfTools } from "./local-pdf.ts";
import { createWebTools } from "./web-tools.ts";
import { createChartTools } from "./chart-tools.ts";
import { createSlideTools } from "./slide-tools.ts";
import { createListTools } from "./list-tools.ts";
import { createSqliteTools } from "./sqlite-tools.ts";
import { createImageTools } from "./image-tools.ts";
import { createExecTools } from "./exec-tools.ts";
import { createSharedToolTools } from "./shared-tool-tools.ts";
import { createPermissionTools } from "./permission-tools.ts";
import { createSlackTools } from "./slack-tools.ts";
import { createDelegationTools } from "./delegation-tools.ts";
import { defaultSlackUserTokenPath, SlackUserTokenStore } from "./slack-user-tokens.ts";
import { resolveModel } from "./model.ts";

export interface ContextUsageOptions {
  channel: ResolvedChannel;
  threadKey: string;
  harnessName: string;
  slackChannelLabel: string;
  botUserId: string;
  modelRuntime: ModelRuntime;
  /** The model this thread is actually on (a conversation can have switched); defaults to the channel's. */
  currentModel?: string;
  defaultTimezone?: string;
  /** Normal Slack turns have these; tests/headless callers can turn them off. */
  canPost?: boolean;
  canUpload?: boolean;
  canDelegate?: boolean;
  canRequestPermissions?: boolean;
}

interface CountedPart {
  label: string;
  chars: number;
  tokens: number;
  note?: string;
}

function textTokens(text: string): number {
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as any);
}

function count(label: string, text: string, note?: string): CountedPart {
  return { label, chars: text.length, tokens: textTokens(text), ...(note ? { note } : {}) };
}

function formatCount(n: number): string {
  return n.toLocaleString("en-AU");
}

function percent(part: number, whole: number | undefined): string {
  if (!whole || whole <= 0) return "";
  return `, ${(part / whole * 100).toFixed(1)}% of window`;
}

function fileText(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

function toolPayload(tool: AnyToolDefinition): Record<string, unknown> {
  const t = tool as AnyToolDefinition & {
    promptSnippet?: unknown;
    promptGuidelines?: unknown;
  };
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    ...(t.promptSnippet ? { promptSnippet: t.promptSnippet } : {}),
    ...(t.promptGuidelines ? { promptGuidelines: t.promptGuidelines } : {}),
  };
}

function builtinTool(name: ToolName, cwd: string): AnyToolDefinition | undefined {
  switch (name) {
    case "read":
      return createReadToolDefinition(cwd);
    case "write":
      return createWriteToolDefinition(cwd);
    case "edit":
      return createEditToolDefinition(cwd);
    case "ls":
      return createLsToolDefinition(cwd);
    case "find":
      return createFindToolDefinition(cwd);
    case "grep":
      return createGrepToolDefinition(cwd);
    case "bash":
      return createBashToolDefinition(cwd);
    default:
      return undefined;
  }
}

/** The tool schemas a fresh session in this channel would be offered (connector tools aside). */
export function contextToolDefinitions(opts: ContextUsageOptions): AnyToolDefinition[] {
  const { channel } = opts;
  const cwd = channel.paths.workspace;
  const jail = {
    readRoots: channel.jail.readRoots,
    writeRoots: channel.jail.writeRoots,
    workspaceSymlinkRoots: channel.jail.workspaceSymlinkRoots,
    cwd,
  };
  const currentThreadTs = () => "0000000000.000000";
  const currentUserId = () => "U00000000";
  const noop = async () => undefined;

  const tools: AnyToolDefinition[] = [];

  for (const name of channel.tools) {
    const builtin = builtinTool(name, cwd);
    if (builtin) tools.push(builtin);
  }

  tools.push(...createMemoryTools(channel));
  tools.push(...createSkillTools({ channel, reload: noop }));
  tools.push(...createLibraryTools({ channel, reload: noop }));
  tools.push(...createSharedToolTools({ channel, cwd }));
  tools.push(...createDocumentTools({ channel, jail, currentUserId }));
  tools.push(...createKnowledgeTools({ channel }));
  tools.push(...createFeedbackTools({ channel, currentUserId }));
  tools.push(...createNotificationTools({ channel, currentUserId }));
  tools.push(
    ...createModelTools({
      control: { current: () => undefined, set: async () => undefined },
      allow: channel.models,
      modelRuntime: opts.modelRuntime,
    }),
  );

  if (channel.schedulesEnabled) {
    tools.push(
      ...createScheduleTools({
        service: {
          create: () => {
            throw new Error("context report stub");
          },
          update: () => undefined,
          list: () => [],
          cancel: () => false,
        },
        channelId: channel.ref.id,
        currentUserId,
        defaultTimezone: opts.defaultTimezone ?? "UTC",
        currentThread: () => ({ threadKey: opts.threadKey, threadTs: currentThreadTs() }),
      }),
    );
  }

  if (channel.interactiveComponents.enabled) {
    tools.push(
      ...createInteractiveTools({
        service: { present: async () => ({ ts: "0000000000.000000" }) },
        channelId: channel.ref.id,
        channelLabel: opts.slackChannelLabel,
        currentThreadTs,
      }),
    );
  }

  if (opts.canPost ?? true) {
    tools.push(
      ...createPostTools({
        poster: { post: async () => ({ ts: "0000000000.000000" }) },
        channelId: channel.ref.id,
        channelLabel: opts.slackChannelLabel,
        currentThreadTs,
      }),
      ...createCrossChannelPostTools({
        poster: {
          postToChannel: async () => ({ channelLabel: "#target", ts: "0000000000.000000" }),
        },
        sourceChannelId: channel.ref.id,
        allowedTargets: channel.postTo.targets,
      }),
      // Empty unless this channel has `share.postAs`.
      ...createPostAsTools({
        poster: { postAsUser: async () => ({ status: "held", reason: "" }) },
        sourceChannelId: channel.ref.id,
        postAs: channel.postAs,
        currentThreadTs,
        verifySource: async () => false,
      }),
    );
  }

  if (opts.canUpload ?? true) {
    tools.push(
      ...createFileTools({
        uploader: { upload: async () => ({}) },
        channelId: channel.ref.id,
        channelLabel: opts.slackChannelLabel,
        currentThreadTs,
        jail,
      }),
    );
  }

  if (channel.tools.includes("file_ops")) tools.push(...createWorkspaceFileTools({ jail }));
  tools.push(...createLocalPdfTools({ workspace: cwd, attachmentDir: channel.paths.attachmentText }));

  if (channel.tools.includes("web")) {
    tools.push(
      ...createWebTools({
        policy: {
          maxBytes: channel.web.maxBytes,
          maxChars: channel.web.maxChars,
          downloadMaxBytes: channel.web.downloadMaxBytes,
          timeoutSeconds: channel.web.timeoutSeconds,
          maxRedirects: channel.web.maxRedirects,
          allowHosts: channel.web.allowHosts,
          blockHosts: channel.web.blockHosts,
          allowPrivateHosts: channel.web.allowPrivateHosts,
          userAgent: channel.web.userAgent,
        },
        search: channel.web.search,
        workspace: cwd,
      }),
    );
  }

  if (channel.tools.includes("charts")) {
    tools.push(...createChartTools({ channelLabel: opts.slackChannelLabel, jail }));
  }
  if (channel.tools.includes("slides")) {
    tools.push(...createSlideTools({ channelLabel: opts.slackChannelLabel, jail, canUpload: opts.canUpload ?? true }));
  }
  tools.push(...createListTools(channel.paths.root));
  if (channel.tools.includes("sqlite")) tools.push(...createSqliteTools({ jail }));
  if (channel.tools.includes("images")) {
    tools.push(
      ...createImageTools({
        config: channel.images,
        channelLabel: opts.slackChannelLabel,
        jail,
        deps: { resolveAuth: async () => undefined },
      }),
    );
  }
  if (channel.tools.includes("exec")) {
    tools.push(...createExecTools({ config: channel.exec, cwd, binDir: channel.paths.bin, globalBinDir: channel.globalBin, env: channel.env }));
  }
  if (opts.canRequestPermissions ?? true) {
    tools.push(
      ...createPermissionTools({
        service: {
          grantable: () => channel.permissions.grantable as any,
          active: () => channel.grants,
          request: async () => undefined,
        },
        channelId: channel.ref.id,
        requestable: channel.requestable,
      }),
    );
  }
  if (channel.tools.includes("slack")) {
    tools.push(
      ...createSlackTools({
        userTokens: new SlackUserTokenStore(defaultSlackUserTokenPath(channel.shared), channel.env),
        currentUserId,
      }),
    );
  }
  if (opts.canDelegate ?? true) {
    tools.push(
      ...createDelegationTools({
        delegator: {
          transfer: async () => ({ targetChannelLabel: "#target", threadTs: "0000000000.000000" }),
        },
        sourceChannelId: channel.ref.id,
        sourceChannelLabel: opts.slackChannelLabel,
        allowedTargets: channel.delegation.targets,
        currentThreadTs,
        currentUserId,
      }),
    );
  }

  // MCP connector tools are discovered only by opening the connector session.
  // Do not connect from a bang command; show the connector prompt text and count
  // the known connectors separately instead.
  return tools;
}

function splitPromptSections(prompt: string): CountedPart[] {
  const chunks = prompt.split(/\n\n(?=## )/g);
  return chunks.map((chunk, index) => {
    const first = chunk.split("\n", 1)[0] ?? "";
    const label = first.startsWith("## ") ? first.slice(3) : index === 0 ? "Identity and base instructions" : first;
    return count(label, chunk);
  });
}

export function buildContextUsageReport(opts: ContextUsageOptions): string {
  const { channel } = opts;
  const effectiveModel = opts.currentModel ?? channel.model;
  let modelRef = effectiveModel;
  let contextWindow: number | undefined;
  try {
    const model = resolveModel(effectiveModel, opts.modelRuntime) as { provider?: string; id?: string; contextWindow?: number };
    if (model.provider && model.id) modelRef = `${model.provider}/${model.id}`;
    if (typeof model.contextWindow === "number") contextWindow = model.contextWindow;
  } catch {
    // Leave modelRef as configured and context window unknown.
  }

  const systemPrompt = buildSystemPrompt(channel, {
    harnessName: opts.harnessName,
    slackChannelLabel: opts.slackChannelLabel,
    botUserId: opts.botUserId,
    currentModel: modelRef,
    canPost: opts.canPost ?? true,
    canUseInteractiveComponents: channel.interactiveComponents.enabled,
    canUpload: opts.canUpload ?? true,
  });
  const system = count("System prompt", systemPrompt);
  const promptSections = splitPromptSections(systemPrompt);

  const skills = presentSkills(channel, loadAvailableSkills(channel));
  const skillList = formatSkillsForPrompt(skills);
  const skillsPart = count("Available skills list", skillList, `${skills.length} skill(s); bodies load only when a skill is read`);

  const tools = contextToolDefinitions(opts);
  const toolsPayload = JSON.stringify(tools.map(toolPayload));
  const toolPart = count(
    "Tool definitions",
    toolsPayload,
    `${tools.length} measured tool(s); connector tool schemas are dynamic and not opened by this command`,
  );

  const freshParts = [system, skillsPart, toolPart].filter((p) => p.chars > 0 || p.label === "Tool definitions");
  const freshTotal = freshParts.reduce((sum, p) => sum + p.tokens, 0);

  const memoryTexts = [
    fileText(channel.memory.channelFile),
    fileText(channel.memory.sharedFile),
    ...channel.memory.foreignFiles.map((f) => fileText(f.path)),
  ].filter(Boolean);
  const memoryChars = memoryTexts.reduce((sum, text) => sum + text.length, 0);
  const memoryTokens = memoryTexts.reduce((sum, text) => sum + textTokens(text), 0);

  const skillBodyTokens = skills.reduce((sum, skill) => sum + textTokens(fileText(skill.filePath)), 0);
  const skillBodyChars = skills.reduce((sum, skill) => sum + fileText(skill.filePath).length, 0);

  const promptSectionLines = promptSections
    .sort((a, b) => b.tokens - a.tokens)
    .map((p) => `   • ${p.label}: ${formatCount(p.tokens)}`)
    .join("\n");

  const lines = [
    `*Fresh context estimate for ${channel.ref.name ? `#${channel.ref.name}` : channel.ref.id}*`,
    `Model: \`${modelRef}\`${contextWindow ? ` (${formatCount(contextWindow)} token window)` : " (context window unknown)"}`,
    `Fresh-start overhead: *${formatCount(freshTotal)} tokens*${percent(freshTotal, contextWindow)}.`,
    "",
    "*Measured fresh context*",
    ...freshParts.map((p) => `• ${p.label}: ${formatCount(p.tokens)} tokens (${formatCount(p.chars)} chars)${p.note ? ` — ${p.note}` : ""}`),
    channel.connectors.length > 0
      ? `• MCP connector schemas: not measured by this command (${channel.connectors.length} connector(s)); connector metadata is counted inside the system prompt`
      : "",
    "",
    "*System-prompt sections*",
    promptSectionLines || "   _No system prompt sections._",
    "",
    "*Available but not automatically loaded*",
    `• Memory files: 0 fresh tokens (${formatCount(memoryTokens)} if recalled in full)`,
    `• Skill bodies: 0 fresh tokens (${formatCount(skillBodyTokens)} if all read in full)`,
    `• Documents/library contents: 0 fresh tokens until searched/read`,
    `• Slack backfill: up to thread ${channel.context.threadBackfill}, channel ${channel.context.channelBackfill}, DM ${channel.context.dmBackfill} message(s); content is dynamic and not counted here`,
  ];

  if (skillBodyChars === 0 && memoryChars === 0) {
    lines.push("", "_Token counts use pi-coding-agent's conservative chars/4 estimator; provider billing is recorded separately by `!usage`._");
  } else {
    lines.push("", "_Token counts use pi-coding-agent's conservative chars/4 estimator. Memory and skill-body figures are potential, not part of a fresh prompt._");
  }

  return lines.join("\n");
}
