import type { ConsoleConnectorOAuth } from "../agent/consoleConnectorOAuth.ts";
import { existsSync, readFileSync } from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { SessionPool } from "../agent/session.ts";
import type { ChannelRuntime, ChannelRuntimes } from "../agent/channel-runtime.ts";
import type { RecoveryOutcome } from "../agent/recovery.ts";
import { checkRequirements, describeMissing } from "../config/requirements.ts";
import { isAllowed, listModels, resolveModel } from "../agent/model.ts";
import { legacyChannelModelOverride } from "../agent/model-state.ts";
import { ScheduleStore, nextRunOf } from "../agent/schedules.ts";
import { listSkills } from "../agent/skills.ts";
import { describeEntry, installedFromLibrary, listLibrary } from "../agent/library.ts";
import { describeDocument, listCategories, listDocuments } from "../agent/documents.ts";
import { DreamState, dreamLogDir, readDreamLog, readJournal } from "../agent/dream.ts";
import { FeedbackLog, describeFeedback } from "../agent/feedback.ts";
import { MemoryFile } from "../agent/memory-store.ts";
import { GrantStore, formatExpiry, type Capability } from "../agent/grants.ts";
import { imageGenerationConfigured } from "../agent/image-generation.ts";
import { defaultSlackUserTokenPath, SlackUserTokenStore } from "../agent/slack-user-tokens.ts";
import { escapeSlack } from "./subagent-progress.ts";
import { formatUsageReport, parseUsageWindow, UsageLog } from "../agent/usage.ts";
import { buildContextUsageReport } from "../agent/context-report.ts";
import {
  completeManualConnectorOAuth,
  manualAuthorizationErrorMessage,
  startManualConnectorOAuth,
} from "../agent/manualConnectorOAuth.ts";

/**
 * Bang-commands are handled without invoking the model. They are the operator's
 * view into what this channel actually has, which matters when the whole point
 * is that channels differ.
 */

export interface ConfigReloadResult {
  applied: boolean;
  configPath: string;
  warnings: string[];
  error?: string;
}

export interface CommandContext {
  channel: ResolvedChannel;
  threadKey: string;
  pool: SessionPool;
  /** The channel's Durable stores. Read-only commands only look at one that is already open. */
  runtimes: ChannelRuntimes;
  /** Run against the channel's store, opening it if necessary (for commands that change conversation state). */
  withRuntime: <T>(fn: (runtime: ChannelRuntime) => Promise<T>) => Promise<T>;
  /** Re-run the recovery gate for this channel's store (after a blocked interruption has been dealt with). */
  recover: () => Promise<RecoveryOutcome>;
  harnessName: string;
  botUserId?: string;
  dataDir: string;
  modelRuntime: ModelRuntime;
  /** Who typed the command, for the few that record who did something. */
  userId?: string;
  connectorOAuth?: ConsoleConnectorOAuth;
  /** Private links never belong in a public command reply/transcript. */
  privateReply?: (text: string) => Promise<void>;
  /**
   * The nightly consolidation pass, when it is switched on here. `run` is
   * deliberately fire-and-forget: a dream takes a model call and a rewrite of
   * memory, which is far too long to hold a Slack command open for.
   */
  dream?: { run: () => Promise<void>; forgetAfterDays: number };
  /**
   * The review loop around `report_limitation`. Present when the harness can
   * act on a resolution — tell the channels that reported it, and send the
   * digest early if someone asks for it.
   */
  feedback?: {
    announceResolved: boolean;
    /** Posts a one-liner into a channel that reported something now closed. */
    notify: (channelId: string, text: string) => Promise<void>;
    /** Sends the digest now rather than waiting for its cron. */
    digest: () => Promise<"posted" | "nothing-new" | "no-channel">;
  };
  /** Reloads harness.yaml and swaps in everything that is safe without a process restart. */
  reloadConfig?: () => Promise<ConfigReloadResult>;
  /** Default timezone used in schedule tool descriptions. */
  defaultTimezone?: string;
}

export function isCommand(text: string): boolean {
  return /^\s*!/.test(text);
}

/** The model a thread is on: its conversation's if the store is open, else the channel's default. */
async function effectiveModelLabel(ctx: CommandContext): Promise<string> {
  const runtime = ctx.runtimes.peek(ctx.channel.ref.id);
  const ref = await runtime?.store.effectiveModel(ctx.threadKey).catch(() => undefined);
  if (ref) return `${ref.provider}/${ref.modelId}`;
  return legacyChannelModelOverride(ctx.channel.paths) ?? ctx.channel.model;
}

export async function runCommand(text: string, ctx: CommandContext): Promise<string> {
  const [rawName, ...args] = text.trim().slice(1).split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  const { channel } = ctx;

  switch (name) {
    case "help":
      return [
        `*${ctx.harnessName}*`,
        "",
        "• `!status` — what this channel is configured with",
        "• `!reload` — reload `harness.yaml` for future turns (live sessions are rebuilt)",
        "• `!models` — models available here",
        "• `!usage [today|24h|7d|30d|all]` — token/cost usage for this channel (`!usage channels 30d` here in the review channel)",
        "• `!context` — fresh-conversation context estimate by prompt, skills and tools",
        "• `!model <id>` — set the channel default model (`!model reset` to clear)",
        "• `!memory` — show this channel's memory",
        "• `!dream` — the last consolidation pass (`!dream now` to run one)",
        "• `!skills` — skills available here",
        "• `!library` — skills other channels have published",
        "• `!docs` — documents filed in the account library (`!docs <category>` to narrow)",
        "• `!feedback` — limitations I have reported from this channel (`!feedback resolve <id>`)",
        "• `!schedules` — work scheduled in this channel",
        "• `!connectors` — connectors enabled here",
        "• `!connector-auth connect <connector>` — pair another device and authorize via the console (opt-in)",
        "• `!connector-auth start <connector>` — start manual OAuth for an HTTP connector",
        "• `!connector-auth complete <connector> <payload>` — finish the pasted OAuth result",
        "• `!slack` — Slack user-token search status for you in this channel",
        "• `!grants` — runtime permissions, and what can be requested",
        "• `!revoke <cap>` — take a runtime permission back",
        "• `!env` — names of secrets available here (never values)",
        "• `!reset` — start a fresh conversation in this thread",
        "• `!recovery` — see work a restart interrupted that could not be safely resumed (`retry`, `discard`)",
        "• `!doctor` — check required tools and env vars",
        "",
        "Otherwise just mention me, or talk to me in a thread I am already in.",
      ].join("\n");

    case "status": {
      const shared = channel.memory.sharedFile
        ? channel.memory.canWriteShared
          ? "read + write"
          : "read only"
        : "no access";
      return [
        `*Channel:* ${channel.ref.name ? `#${channel.ref.name}` : channel.ref.id}`,
        channel.configKey ? `*Config entry:* \`${channel.configKey}\`` : "*Config entry:* _none (defaults)_",
        channel.description ? `*Purpose:* ${channel.description}` : "",
        `*Model:* ${await effectiveModelLabel(ctx)} (thinking: ${channel.thinkingLevel})`,
        channel.models.length > 0
          ? `*Models allowed:* ${channel.models.map((m) => `\`${m}\``).join(", ")}`
          : "*Models allowed:* any the harness has credentials for",
        `*Tools:* ${channel.tools.join(", ") || "none"}`,
        channel.tools.includes("charts") ? "*Charts:* PNG bar, line and scatter charts" : "",
        channel.tools.includes("slides") ? "*Slides:* self-contained Markdown-to-HTML presentations" : "",
        channel.tools.includes("web")
          ? `*Web:* read pages + download public files${
              channel.web.search.provider !== "none" ? ` + search (${channel.web.search.provider})` : ", no search configured"
            }${channel.web.allowPrivateHosts ? ", local network allowed" : ""}`
          : "*Web:* no internet access",
        channel.tools.includes("images") && imageGenerationConfigured(channel.images)
          ? `*AI images:* ${channel.images.provider}/${channel.images.model} (${channel.images.size}, ${channel.images.outputFormat}${channel.images.authProvider ? `, auth: ${channel.images.authProvider}` : ""})`
          : channel.tools.includes("images")
            ? "*AI images:* enabled but not configured"
            : "",
        channel.tools.includes("slack")
          ? `*Slack search:* read-only user-token search${
              ctx.userId && new SlackUserTokenStore(defaultSlackUserTokenPath(channel.shared), channel.env).hasUser(ctx.userId)
                ? " (token stored for you)"
                : " (no token stored for you)"
            }`
          : "*Slack search:* disabled",
        channel.postAs
          ? `*Post as user:* configured for <@${channel.postAs.user}>, ${
              new SlackUserTokenStore(defaultSlackUserTokenPath(channel.shared), channel.env).hasUser(channel.postAs.user)
                ? "token stored"
                : "NO token stored for them"
            } (presence only: I cannot tell from here whether the token has the posting scopes). Cap ${channel.postAs.maxPerHour} per hour; reviewer role \`${escapeSlack(channel.postAs.reviewer.name.replace(/`/g, ""))}\``
          : "",
        `*History read in:* thread ${channel.context.threadBackfill}, ` +
          `channel ${channel.context.channelBackfill}, DM ${channel.context.dmBackfill} message(s)`,
        channel.grants.length > 0
          ? `*Granted at runtime:* ${channel.grants.map((g) => `\`${g.capability}\` (${formatExpiry(g)})`).join(", ")}`
          : "",
        `*Skills:* ${listSkills(channel).length}`,
        `*Skill library:* ${
          channel.library.canRead
            ? `${listLibrary(channel.shared).length} published, ${
                channel.library.canPublish ? "may publish" : "read only"
              }`
            : "no access"
        }`,
        `*Document library:* ${
          channel.documents.canRead
            ? `${listDocuments(channel.shared).length} filed, ${
                channel.documents.canAdd ? "may file" : "read only"
              }`
            : channel.documents.canAdd
              ? "may file, cannot read"
              : "no access"
        }`,
        `*Usage records:* ${new UsageLog(channel.shared).query({ channelId: channel.ref.id }).length}`,
        `*Overnight consolidation:* ${channel.dreamsEnabled ? "on" : "off"}`,
        `*Limitations reported:* ${
          new FeedbackLog(channel.shared).forChannel(channel.ref.id).filter((e) => e.status === "open")
            .length
        } open (\`!feedback\`)`,
        `*Connectors:* ${channel.connectors.map((c) => c.name).join(", ") || "none"}`,
        `*Exec commands:* ${Object.keys(channel.exec.commands).join(", ") || "none"}`,
        `*Account knowledge:* ${channel.knowledge.length} file(s)`,
        `*Account memory:* ${shared}`,
        `*Other channels' memory:* ${
          channel.memory.foreignFiles.map((f) => `#${f.channel}`).join(", ") || "none"
        }`,
        `*Workspace:* \`${channel.paths.workspace}\``,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "reload":
    case "config": {
      if (name === "config" && args[0] !== "reload") {
        return "Usage: `!reload` or `!config reload`.";
      }
      if (!ctx.reloadConfig) return "_Config reload is not available in this process._";
      const result = await ctx.reloadConfig();
      if (!result.applied) {
        return `:warning: Config reload failed; the previous config is still active.\n\`${result.configPath}\`\n${result.error ?? "Unknown error"}`;
      }
      return [
        `Reloaded config from \`${result.configPath}\`.`,
        "Future turns will use the new YAML; agent sessions are rebuilt as soon as safely possible.",
        result.warnings.length > 0 ? `_${result.warnings.join(" ")}_` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "memory": {
      const content = existsSync(channel.memory.channelFile)
        ? readFileSync(channel.memory.channelFile, "utf-8").trim()
        : "";
      if (!content) return "_This channel has no memory yet._";
      return content.length > 3000 ? `${content.slice(0, 3000)}\n\n_(truncated)_` : content;
    }

    case "skills": {
      const skills = listSkills(channel);
      if (skills.length === 0) {
        return [
          "_No skills are available in this channel yet._",
          "",
          "I write my own as I learn repeatable procedures, or an operator can add one to a shared skill collection and assign it to this channel in the config.",
        ].join("\n");
      }
      return [
        `*Skills available here (${skills.length}):*`,
        ...skills.map(
          (s) =>
            `• \`${s.name}\`${s.origin === "channel" ? "" : ` _(${s.collection ? `collection: ${s.collection}` : s.origin})_`} — ${s.description}`,
        ),
      ].join("\n");
    }

    case "dream": {
      if (!channel.dreamsEnabled) {
        return "_Overnight consolidation is disabled in this channel._";
      }

      if (args[0] === "now") {
        if (!ctx.dream) return "_Consolidation is not available right now._";
        // Not awaited: this takes a model call and a rewrite of memory.
        void ctx.dream.run();
        return "Consolidating now — this takes a minute. `!dream` will show the result, and it always lands in `memory/DREAMS.md`.";
      }

      const state = new DreamState(channel.paths.root).read();
      const memory = new MemoryFile(channel.memory.channelFile);
      const stale = memory.stale({ days: ctx.dream?.forgetAfterDays ?? 90 }).length;
      const journal = readJournal(channel, 1);

      // The last few runs including the skips, because "it did not run" is the
      // thing people actually come here to explain.
      const recent = readDreamLog(channel, 5)
        .reverse()
        .map((run) => {
          const when = run.at.slice(0, 16).replace("T", " ");
          const detail =
            run.status === "completed"
              ? `${run.conversations} conversation(s), ${run.entriesBefore} → ${run.entriesAfter} memories`
              : (run.reason ?? run.status);
          return `• ${when} — ${run.status}: ${detail}`;
        });

      return [
        "*Overnight consolidation*",
        state.lastDreamAt
          ? `_Last ran ${state.lastDreamAt.slice(0, 16).replace("T", " ")} (${state.runs} in total)._`
          : "_Has not run yet in this channel._",
        `_${memory.entries().length} memor${memory.entries().length === 1 ? "y" : "ies"}, ${stale} looking like clutter._`,
        state.lastError ? `:warning: Last error: ${state.lastError}` : "",
        "",
        journal || "_No journal entries yet._",
        ...(recent.length > 0 ? ["", "*Recent runs*", ...recent] : []),
        "",
        `_Run one now with_ \`!dream now\`_. Full logs:_ \`${dreamLogDir(channel)}\``,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "library": {
      if (!channel.library.canRead) {
        return "_This channel cannot see the shared skill library. Set `share.library: true` to change that._";
      }
      const entries = listLibrary(channel.shared);
      const installed = installedFromLibrary(channel);
      if (entries.length === 0) {
        return [
          "_The shared skill library is empty._",
          "",
          "A channel with `share.libraryPublish: true` (or a runtime `skillPublish` grant) can publish a skill it wrote, and every channel here can then install it.",
        ].join("\n");
      }
      return [
        `*Shared skill library (${entries.length}):*`,
        ...entries.map((e) => describeEntry(e, installed[e.name])),
        "",
        channel.library.canPublish
          ? "_This channel may publish its own skills here._"
          : "_This channel can install from the library but not publish to it._",
      ].join("\n");
    }

    case "docs":
    case "documents": {
      if (!channel.documents.canRead) {
        return "_This channel cannot see the document library. Set `share.documents: true` to change that._";
      }
      const all = listDocuments(channel.shared);
      if (all.length === 0) {
        return [
          "_The document library is empty._",
          "",
          "Attach a document here — PDF, Word, PowerPoint, Markdown, CSV, plain text — and I will read it, summarise it and file it so every channel can find it later.",
        ].join("\n");
      }

      // A category argument is how a shelf with two hundred things on it stays
      // readable in Slack, which cannot show two hundred of anything usefully.
      const wanted = args[0]?.trim().toLowerCase();
      const shown = wanted ? all.filter((e) => e.category === wanted) : all.slice(0, 15);
      if (wanted && shown.length === 0) {
        return `_Nothing is filed under \`${wanted}\`._\n\nCategories: ${listCategories(channel.shared)
          .map((c) => `\`${c.category}\` (${c.count})`)
          .join(", ")}`;
      }

      return [
        wanted
          ? `*Document library — ${wanted} (${shown.length}):*`
          : `*Document library (${all.length}${all.length > shown.length ? `, showing ${shown.length}` : ""}):*`,
        ...shown.map(describeDocument),
        "",
        wanted
          ? ""
          : `_Categories: ${listCategories(channel.shared)
              .map((c) => `\`${c.category}\` (${c.count})`)
              .join(", ")}. \`!docs <category>\` to narrow._`,
        channel.documents.canAdd
          ? "_This channel may file documents here._"
          : "_This channel can read the library but not file into it._",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "feedback": {
      // Scoped to this channel on purpose. The account-wide picture is the
      // point of the file, but a Slack channel is not where another channel's
      // agent should be quoted saying what it could not do — the review view
      // lives on disk, where only an operator is reading.
      const log = new FeedbackLog(channel.shared);

      if (args[0] === "resolve") {
        const id = args[1];
        if (!id) return "Usage: `!feedback resolve <id> [note]`. Ids are shown by `!feedback`.";
        const note = args.slice(2).join(" ");
        const entry = log.resolve(id, ctx.userId ?? "an operator", note);
        if (!entry) return `No feedback with id \`${id}\`. See \`!feedback\`, or the file itself.`;

        // Closing the loop is the point: a channel that reported a wall and
        // never heard back is one whose people learn that reporting is futile.
        // The channel doing the closing already sees this reply.
        const told: string[] = [];
        if (ctx.feedback?.announceResolved) {
          for (const c of entry.channels) {
            if (c.id === channel.ref.id) continue;
            try {
              await ctx.feedback.notify(
                c.id,
                `*Fixed:* ${entry.summary}\n_You ran into this and it was reported from here. ` +
                  `An operator has now closed it${note ? ` — ${note}` : ""}. ` +
                  `If it happens again, say so and I'll reopen it._`,
              );
              told.push(c.label);
            } catch {
              // A channel we can no longer post to is not a reason to fail the
              // resolution; the log already records it as closed.
            }
          }
        }

        return [
          `Closed \`${entry.id}\` — ${entry.summary}`,
          told.length > 0 ? `_Told ${told.join(", ")}._` : "",
          "_Reporting it again reopens it._",
        ]
          .filter(Boolean)
          .join("\n");
      }

      if (args[0] === "digest") {
        if (!channel.feedback.isReviewer) {
          return "_Only the channel the digest goes to can send one. Set `feedback.digestChannel` to this channel to change that._";
        }
        if (!ctx.feedback) return "_The digest is not available right now._";
        const outcome = await ctx.feedback.digest();
        return outcome === "posted"
          ? "Sent."
          : outcome === "nothing-new"
            ? "_Nothing has changed since the last digest, so there is nothing to send._"
            : "_No digest channel is configured, so there is nowhere to send it._";
      }

      // The whole account's reports, but only where an operator is the reader.
      if (args[0] === "all") {
        if (!channel.feedback.isReviewer) {
          return [
            "_This channel only sees what it reported itself._",
            "",
            "The account-wide view belongs to the channel named in `feedback.digestChannel`, which is where the digest is posted.",
          ].join("\n");
        }
        const all = log.open();
        if (all.length === 0) return "_Nothing is open across the whole account._";
        return [
          `*Open across the account (${all.length}), most reported first:*`,
          ...all.slice(0, 20).map(
            (e) =>
              `• \`${e.id}\` — ${e.summary}\n   _${e.kind}, ${e.reports}× from ${e.channels
                .map((c) => c.label)
                .join(", ")}_`,
          ),
          all.length > 20 ? `_…and ${all.length - 20} more in_ \`${log.reviewPath}\`_._` : "",
          "",
          "_Close one with_ `!feedback resolve <id> [note]`_, or send the digest now with_ `!feedback digest`_._",
        ]
          .filter(Boolean)
          .join("\n");
      }

      const mine = log.forChannel(channel.ref.id);
      const open = mine.filter((e) => e.status === "open");
      if (mine.length === 0) {
        return [
          "_I have not reported any limitations from this channel._",
          "",
          `When the harness gets in my way — a missing tool, data I cannot reach, a permission — I file it, and it lands in \`${log.reviewPath}\` for review.`,
        ].join("\n");
      }
      return [
        `*Limitations reported from this channel* (${open.length} open of ${mine.length})`,
        "",
        ...mine.slice(0, 15).map(describeFeedback),
        mine.length > 15 ? `_…and ${mine.length - 15} more._` : "",
        "",
        channel.feedback.isReviewer
          ? `_\`!feedback all\` shows every channel's, and \`!feedback digest\` sends the summary now. Close one with_ \`!feedback resolve <id>\`_._`
          : `_Every channel's reports, worst first:_ \`${log.reviewPath}\`_. Close one with_ \`!feedback resolve <id>\`_._`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "slack": {
      if (!channel.tools.includes("slack")) {
        return "_Slack search is disabled in this channel. Add `slack` to this channel's `tools` list to enable read-only user-token search._";
      }
      if (!ctx.userId) return "_I do not know which Slack user to check._";
      const store = new SlackUserTokenStore(defaultSlackUserTokenPath(channel.shared), channel.env);
      return store.hasUser(ctx.userId)
        ? `*Slack search:* enabled, with a stored user token for <@${ctx.userId}>. I can use \`search_slack\` when you ask me to find older Slack messages.`
        : `*Slack search:* enabled, but no user token is stored for <@${ctx.userId}>. Ask an operator to run \`npm run slack-user-token -- set ${ctx.userId}\` with a read-only Slack user token.`;
    }

    case "connectors": {
      if (channel.connectors.length === 0) return "_No connectors are enabled in this channel._";
      return [
        `*Connectors enabled here:*`,
        ...channel.connectors.map(
          (c) =>
            `• \`${c.name}\` (${c.origin})${c.config.description ? ` — ${c.config.description}` : ""}`,
        ),
      ].join("\n");
    }

    case "connector-auth": {
      const [action, connectorName, payload] = args;
      if (!action || !connectorName || (action !== "start" && action !== "complete" && action !== "connect") || (action === "complete" && !payload) || args.length !== (action === "complete" ? 3 : 2)) {
        return "Usage: `!connector-auth connect <connector>`, `!connector-auth start <connector>` or `!connector-auth complete <connector> <payload>`.";
      }
      const connector = channel.connectors.find((entry) => entry.name === connectorName);
      if (!connector) return `Connector \`${connectorName}\` is not enabled in this channel.`;
      if (connector.config.transport !== "http" || !connector.config.oauth) {
        return `Connector \`${connectorName}\` does not have HTTP OAuth configured.`;
      }

      if (action === "connect") {
        if (!ctx.connectorOAuth || !ctx.privateReply || !ctx.userId) return "Console OAuth is not configured. Ask an operator to enable the HTTPS console callback, or use the existing manual/CLI flow.";
        if (!connector.config.oauth.consoleCallback || connector.config.oauth.redirectUrl !== ctx.connectorOAuth.callbackUrl) {
          return "This connector has not opted in to the exact console callback. Ask an operator to configure and register it; existing manual/localhost authorization is unchanged.";
        }
        if (connector.config.oauth.tokenFile) return "Console OAuth requires the default channel-private token store; custom tokenFile is not supported.";
        try {
          const link = ctx.connectorOAuth.start({
            userId: ctx.userId, channelId: channel.ref.id, threadTs: ctx.threadKey,
            connectorName, channelRoot: channel.paths.root, connectorUrl: connector.config.url, oauth: connector.config.oauth,
          });
          try {
            await ctx.privateReply(`Open <${link}|this private connect link> on the device you want to authorize. It expires shortly; do not share it. Compare the browser challenge with the approval prompt in this Slack thread. Credentials will be shared with this channel's connector, not saved as personal credentials.`);
          } catch {
            ctx.connectorOAuth.cancelUnclaimed({ userId: ctx.userId, channelId: channel.ref.id, connectorName });
            throw new Error("Private delivery failed");
          }
          return "A private connect link was sent to you in this thread. Approve only your own matching browser challenge; completion will be reported here.";
        } catch {
          return "Could not start console authorization. An authorization may already be pending, the cached client may need an operator reset for the new redirect, or private delivery failed. Finish/cancel it or retry after expiry.";
        }
      }

      if (connector.config.oauth.consoleCallback) {
        return "This connector opted in to the console callback. Use `!connector-auth connect` with its name; console authorization codes must not be pasted into Slack.";
      }

      try {
        if (action === "start") {
          const started = await startManualConnectorOAuth({
            connectorName,
            channelRoot: channel.paths.root,
            connectorUrl: connector.config.url,
            oauth: connector.config.oauth,
          });
          if (started.status === "authorized") return `\`${connectorName}\` is already authorized in this channel.`;
          return [
            `Open this one-time authorization link for \`${connectorName}\`:`,
            started.authorizationUrl!.toString(),
            "After approval, copy the payload from the completion page and paste it here with `!connector-auth complete " + connectorName + " <payload>`. Do not share the payload; delete your Slack message after completion.",
          ].join("\n");
        }

        await completeManualConnectorOAuth({
          connectorName,
          channelRoot: channel.paths.root,
          connectorUrl: connector.config.url,
          oauth: connector.config.oauth,
          payload: payload!,
        });
        return `OAuth tokens saved for \`${connectorName}\`. The pasted authorization result was consumed.`;
      } catch (error) {
        // Never echo a pasted result, code, state, provider response, or token
        // error back into Slack or the Bolt error logger.
        return manualAuthorizationErrorMessage(error);
      }
    }

    case "context": {
      if (args.length > 1 || (args[0] && args[0] !== "fresh")) {
        return "Usage: `!context` or `!context fresh`.";
      }
      return buildContextUsageReport({
        channel,
        currentModel: await effectiveModelLabel(ctx),
        threadKey: ctx.threadKey,
        harnessName: ctx.harnessName,
        slackChannelLabel: channel.ref.name ? `#${channel.ref.name}` : "a direct message",
        botUserId: ctx.botUserId ?? "",
        modelRuntime: ctx.modelRuntime,
        defaultTimezone: ctx.defaultTimezone ?? "UTC",
      });
    }

    case "usage": {
      const wantsChannels = args[0]?.toLowerCase() === "channels";
      if (wantsChannels && !channel.feedback.isReviewer) {
        return "_Account-wide usage is only available in the review/admin channel. Use `!usage` here for this channel._";
      }
      if ((!wantsChannels && args.length > 1) || (wantsChannels && args.length > 2)) {
        return "Usage: `!usage [today|24h|7d|30d|all]` or `!usage channels [window]`.";
      }
      let window;
      try {
        window = parseUsageWindow(wantsChannels ? args[1] : args[0]);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const summary = new UsageLog(channel.shared).summarize({
        since: window.since,
        until: window.until,
        ...(wantsChannels ? {} : { channelId: channel.ref.id }),
      });
      return formatUsageReport({
        summary,
        window,
        scopeLabel: wantsChannels ? "all channels" : channel.ref.name ? `#${channel.ref.name}` : channel.ref.id,
      });
    }

    case "models": {
      const models = listModels({ catalog: ctx.modelRuntime, allow: channel.models, onlyAvailable: true });
      if (models.length === 0) {
        return [
          "_No models available._",
          "",
          "The harness has no provider credentials configured. Set one of `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or another provider key and restart.",
        ].join("\n");
      }
      const effective = await effectiveModelLabel(ctx);
      const byProvider = new Map<string, string[]>();
      for (const m of models) {
        const line = `• \`${m.ref}\`${m.ref.endsWith(`/${effective}`) || m.ref === effective ? "  ← current" : ""}${
          m.contextWindow ? ` — ${Math.round(m.contextWindow / 1000)}k ctx` : ""
        }${m.acceptsImages ? ", sees images" : ""}${
          m.cost ? `, $${m.cost.input}/$${m.cost.output} per Mtok` : ""
        }`;
        byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), line]);
      }
      return [
        `*Models available in this channel* (${models.length})`,
        ...[...byProvider.entries()].flatMap(([p, lines]) => [``, `*${p}*`, ...lines]),
        "",
        "_Set the channel default with_ `!model <id>`_. I can also switch myself mid-conversation._",
      ].join("\n");
    }

    case "model": {
      const target = args[0];

      if (!target) {
        const runtime = ctx.runtimes.peek(channel.ref.id);
        const channelModel = await runtime?.store.channelModel().catch(() => undefined);
        const override = channelModel?.overridden
          ? `${channelModel.model.provider}/${channelModel.model.modelId}`
          : legacyChannelModelOverride(channel.paths);
        return [
          `*Current model:* \`${await effectiveModelLabel(ctx)}\``,
          `*Configured default:* \`${channel.model}\``,
          override ? `*Channel override:* \`${override}\`` : "",
          channel.models.length > 0 ? `*Allowed here:* ${channel.models.map((m) => `\`${m}\``).join(", ")}` : "",
          "",
          "Use `!model <id>` to set the channel default, `!model reset` to clear it, or `!models` to list options.",
        ]
          .filter(Boolean)
          .join("\n");
      }

      if (target === "reset") {
        // The thread follows the channel default again, and the default follows config.
        await ctx.withRuntime(async ({ store }) => {
          await store.setChannelModel(null);
          await store.unpinThread(ctx.threadKey);
        });
        return `Cleared the override. Back to the configured default \`${channel.model}\`.`;
      }

      if (!isAllowed(target, channel.models, ctx.modelRuntime)) {
        return `:warning: \`${target}\` is not permitted in this channel. Use \`!models\` to see the allowed set.`;
      }
      let resolved;
      try {
        resolved = resolveModel(target, ctx.modelRuntime);
      } catch (err) {
        return `:warning: ${err instanceof Error ? err.message : String(err)}`;
      }

      await ctx.withRuntime(async ({ store }) => {
        await store.setChannelModel({ provider: resolved.provider, modelId: resolved.id });
        // The command applies where it was typed: this thread stops holding a model of its own.
        await store.unpinThread(ctx.threadKey);
      });
      return `Channel default set to \`${target}\`. This thread and new conversations here will use it.`;
    }

    case "env": {
      // Names only, never values — this is a Slack channel.
      const lines = [
        `*Secrets available to this channel*`,
        `_Sources:_ ${channel.envSources.join(" → ")}`,
        "",
        channel.envKeys.length > 0
          ? channel.envKeys.map((k) => `• \`${k}\``).join("\n")
          : "_No env file entries. Add secrets to_ `data/channels/" +
            channel.ref.id +
            "/env` _for this channel only._",
        "",
        "_Values are never shown here. Later sources override earlier ones._",
      ];
      return lines.join("\n");
    }

    case "schedules": {
      if (!channel.schedulesEnabled) return "_Scheduling is disabled in this channel._";
      const store = new ScheduleStore(ctx.dataDir);
      const tasks = store.list(channel.ref.id);
      const recentRuns = store.listRuns(channel.ref.id, 5);
      if (tasks.length === 0 && recentRuns.length === 0) return "_Nothing is scheduled in this channel._";
      return [
        `*Scheduled in this channel (${tasks.length}):*`,
        ...(tasks.length === 0 ? ["_No active schedules._"] : []),
        ...tasks.map((t) => {
          const next = nextRunOf(t);
          const when = t.cron ? `\`${t.cron}\`` : `once at ${t.runAt}`;
          const modes = [
            t.quiet ? "quiet" : "visible",
            t.runIfMissed ? "catch-up missed" : undefined,
          ]
            .filter(Boolean)
            .join(", ");
          return [
            `• \`${t.id}\` — ${when} (${t.timezone}, ${modes})`,
            `   ${t.prompt}`,
            `   next: ${next ? next.toISOString() : "never"}${
              t.lastError ? `  |  last error: ${t.lastError}` : ""
            }`,
          ].join("\n");
        }),
        ...(recentRuns.length > 0
          ? [
              "",
              "*Recent runs:*",
              ...recentRuns.map((run) =>
                [
                  `• \`${run.taskId}\` — ${run.status} (${run.startedAt} → ${run.endedAt})`,
                  run.error ? `  error: ${run.error}` : undefined,
                  run.slackOutputUrl ? `  <${run.slackOutputUrl}|Slack output>` : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
              ),
            ]
          : []),
        "",
        "_Ask me to make one quiet/visible, toggle missed-run catch-up, cancel one, or schedule something new._",
      ].join("\n");
    }

    case "grants": {
      const store = new GrantStore(ctx.dataDir);
      const active = store.active(channel.ref.id);
      const grantable = channel.permissions.grantable;
      return [
        "*Runtime permissions*",
        "",
        active.length > 0
          ? active
              .map(
                (g) =>
                  `• \`${g.capability}\` — ${formatExpiry(g)}, granted by <@${g.grantedBy}>`,
              )
              .join("\n")
          : "_Nothing granted beyond this channel's configuration._",
        "",
        grantable.length > 0
          ? `_Can be requested here:_ ${grantable.map((c) => `\`${c}\``).join(", ")}`
          : "_Nothing can be requested here; change `permissions.grantable` in the config._",
        channel.permissions.approvers.length > 0
          ? `_Approvers:_ ${channel.permissions.approvers.map((u) => `<@${u}>`).join(", ")}`
          : "_Anyone in this channel can approve._",
        "",
        "_Use_ `!revoke <capability>` _or_ `!revoke all`_._",
      ].join("\n");
    }

    case "revoke": {
      const store = new GrantStore(ctx.dataDir);
      const target = args[0];
      if (!target) return "Usage: `!revoke <capability>` or `!revoke all`. See `!grants`.";

      if (target === "all") {
        const count = store.revokeAll(channel.ref.id);
        await ctx.pool.disposeChannel(channel.ref.id);
        // Revoked tools must leave the store's registry, not just this thread's bindings.
        void ctx.runtimes.invalidate(channel.ref.id).catch(() => undefined);
        return count > 0 ? `Revoked ${count} grant(s).` : "Nothing was granted.";
      }
      const removed = store.revoke(channel.ref.id, target as Capability);
      if (!removed) return `\`${target}\` was not granted. See \`!grants\`.`;
      await ctx.pool.disposeChannel(channel.ref.id);
      void ctx.runtimes.invalidate(channel.ref.id).catch(() => undefined);
      return `Revoked \`${target}\`.`;
    }

    case "reset": {
      // Drop the live session first so no tool binding outlives the old conversation, then
      // re-fork the thread from the channel's main conversation. The old fork is kept.
      await ctx.pool.drop(channel.ref.id, ctx.threadKey);
      const had = await ctx.withRuntime(({ store }) => store.resetThread(ctx.threadKey));
      return had
        ? "Started a fresh conversation in this thread. Memory is untouched — use `!memory` to see what I still know."
        : "This thread had no conversation yet, so there was nothing to reset.";
    }

    case "recovery": {
      const action = args[0]?.toLowerCase();
      if (args.length > 1 || (action && action !== "retry" && action !== "discard")) {
        return "Usage: `!recovery`, `!recovery retry` or `!recovery discard`.";
      }
      if (action === "discard") {
        const count = await ctx.withRuntime(({ store }) => store.discardInterrupted());
        return count > 0
          ? `Discarded ${count} interrupted conversation(s) in this channel. Nothing from them will run. New messages work normally.`
          : "Nothing was interrupted, so there was nothing to discard.";
      }
      if (action === "retry") {
        const outcome = await ctx.recover();
        if (outcome.blocked.length > 0) {
          return [
            `Still paused: ${outcome.blocked.length} interrupted request(s) cannot be safely resumed.`,
            ...outcome.blocked.map((item) => `• thread \`${item.threadKey || "?"}\` — ${item.reason}`),
          ].join("\n");
        }
        return outcome.resumed
          ? `Resumed ${outcome.recovered.length} interrupted conversation(s)${outcome.abandoned.length > 0 ? `, dropped ${outcome.abandoned.length} interrupted scheduled run(s)` : ""}.`
          : "Nothing to resume.";
      }
      const blocked = await ctx.withRuntime(({ store }) => store.blocked());
      if (blocked.length === 0) return "_Nothing is waiting on recovery in this channel._";
      return [
        `*Paused: ${blocked.length} interrupted request(s) could not be safely resumed.* No one can use this channel until they are resolved.`,
        ...blocked.map((item) => `• thread \`${item.threadKey || "?"}\` — ${item.reason} (since ${new Date(item.since).toISOString()})`),
        "",
        "Fix the cause and `!recovery retry`, or `!recovery discard` to give up on them (nothing from them will run).",
      ].join("\n");
    }

    case "doctor": {
      const report = checkRequirements(channel.requires, channel.env);
      if (report.checks.length === 0) return "_No requirements declared for this channel._";
      const lines = report.checks.map(
        (c) => `${c.ok ? ":white_check_mark:" : ":x:"} ${c.kind}: \`${c.name}\``,
      );
      return [
        "*Requirements*",
        ...lines,
        report.ok ? "" : `\n${describeMissing(report)}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    default:
      return `Unknown command \`!${name}\`. Try \`!help\`.` + (args.length ? "" : "");
  }
}
