import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { FEEDBACK_KINDS, FeedbackLog, KIND_DESCRIPTIONS, type FeedbackKind } from "./feedback.ts";

/**
 * The tool for "I could not do that, and here is why".
 *
 * Shaped to be used honestly rather than often. The failure mode of a feedback
 * channel is not silence, it is noise — an agent that files every mild
 * inconvenience produces a file nobody reads, which is worse than no file at
 * all. So the description spends most of its words on what *not* to send, the
 * summary is one line so items can be matched against each other, and the reply
 * says plainly that nothing has been fixed, because an agent that thinks it has
 * just solved the problem will tell someone so.
 *
 * The channel is stamped on the report here rather than passed by the model:
 * the count of distinct channels is the number that decides what gets built,
 * and it is worth nothing if a channel can choose what to write in it.
 */

export interface FeedbackToolsContext {
  channel: ResolvedChannel;
  /** Who is speaking on this turn, for attribution. */
  currentUserId: () => string;
  /**
   * Optional closing-the-loop side effect when a reviewer resolves an item.
   * The feedback log itself is still the record; notification failures are best-effort.
   */
  resolution?: {
    announceResolved: boolean;
    notify: (channelId: string, text: string) => Promise<void>;
  };
}

export function createFeedbackTools(ctx: FeedbackToolsContext): ToolDefinition[] {
  const { channel } = ctx;
  const label = channel.ref.name ? `#${channel.ref.name}` : channel.ref.isDm ? "a DM" : channel.ref.id;

  const tools: ToolDefinition[] = [];

  const report = defineTool({
    name: "report_limitation",
    label: "Report a limitation",
    description:
      "Tell the operator that the harness got in your way: a tool you needed and did not have, data you could not reach, " +
      "a permission that blocked you, something you were expected to know that nobody had written down. " +
      "Reports go to a file the operator reviews, and repeated reports across channels are what decide what gets built next — " +
      "so file the wall you actually hit, once, in words that would match another channel hitting the same one.\n\n" +
      "Do not use this for: something you got wrong yourself; a capability you can simply ask for with `request_access`; " +
      "a person being unhappy with an answer; or anything you have already reported in this conversation. " +
      "Never include secrets, credentials, or private details of this conversation — the file is read outside this channel.",
    parameters: Type.Object({
      summary: Type.String({
        description:
          "One sentence naming the limitation, general enough that another channel hitting it would phrase it the same way. " +
          'Say what was missing, not what you were doing: "cannot read PDFs that people paste", not "could not read Bob\'s datasheet".',
      }),
      kind: Type.Union(
        FEEDBACK_KINDS.map((k) => Type.Literal(k)) as any,
        {
          description: Object.entries(KIND_DESCRIPTIONS)
            .map(([k, d]) => `"${k}": ${d}`)
            .join("; "),
        },
      ),
      detail: Type.Optional(
        Type.String({
          description:
            "What you were trying to do, what actually happened, and what would have unblocked you. A few sentences. " +
            "This is the part that makes the report actionable, so include it unless the summary genuinely says everything.",
        }),
      ),
    }),
    execute: async (_id, params: { summary: string; kind: FeedbackKind; detail?: string }) => {
      const log = new FeedbackLog(channel.shared);
      const userId = ctx.currentUserId();
      const result = log.report({
        summary: params.summary,
        kind: params.kind,
        ...(params.detail ? { detail: params.detail } : {}),
        channelId: channel.ref.id,
        channelLabel: label,
        ...(userId ? { userId } : {}),
      });

      const { entry, repeat, reopened, otherChannels } = result;
      const lines = [
        repeat
          ? `Added to a report already on file — that is ${entry.reports} time(s) now${
              otherChannels > 0
                ? `, including ${otherChannels} other channel(s)`
                : ""
            }.`
          : "Filed for the operator to review.",
        reopened ? "It had been marked resolved, so it is open again." : "",
        "Nothing has changed yet: this is a note for whoever maintains the harness, not a fix. " +
          "Carry on with what you can actually do here, and say plainly what you could not.",
      ].filter(Boolean);

      return {
        content: [{ type: "text" as const, text: lines.join(" ") }],
        details: { id: entry.id, reports: entry.reports, kind: entry.kind, repeat },
      };
    },
  });

  tools.push(report);

  if (channel.feedback.isReviewer) {
    const resolve = defineTool({
      name: "resolve_feedback",
      label: "Resolve feedback",
      description:
        "Close an existing harness feedback item after a human operator explicitly asks you to resolve it. " +
        "Use this only in the feedback review channel, only for item ids the operator named or approved, " +
        "and never to hide a limitation you merely believe is fixed. Resolving appends to the shared feedback log, " +
        "regenerates the review file, and reporting the limitation again reopens it.",
      parameters: Type.Object({
        id: Type.String({
          description: "The feedback item id to close, as shown in FEEDBACK.md, !feedback, or !feedback all.",
        }),
        note: Type.Optional(
          Type.String({
            description:
              "Optional short reason or pointer to the fix, such as a merged PR number. Do not include secrets or private details.",
          }),
        ),
      }),
      execute: async (_id, params: { id: string; note?: string }) => {
        const id = params.id.trim();
        if (!id) throw new Error("Provide a feedback id to resolve.");

        const note = params.note?.trim();
        const log = new FeedbackLog(channel.shared);
        const entry = log.resolve(id, ctx.currentUserId() || "an operator", note);
        if (!entry) {
          return {
            content: [{ type: "text" as const, text: `No feedback with id \`${id}\`. Check FEEDBACK.md or !feedback all.` }],
            details: { id, resolved: false, told: [] as string[] },
          };
        }

        const told: string[] = [];
        if (ctx.resolution?.announceResolved) {
          for (const c of entry.channels) {
            if (c.id === channel.ref.id) continue;
            try {
              await ctx.resolution.notify(
                c.id,
                `*Fixed:* ${entry.summary}\n_You ran into this and it was reported from here. ` +
                  `An operator has now closed it${note ? ` — ${note}` : ""}. ` +
                  `If it happens again, say so and I'll reopen it._`,
              );
              told.push(c.label);
            } catch {
              // Closing the item is the durable act; a stale Slack channel must not undo it.
            }
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Closed \`${entry.id}\` — ${entry.summary}`,
                told.length > 0 ? `_Told ${told.join(", ")}._` : "",
                "Reporting it again reopens it.",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: { id: entry.id, resolved: true, told },
        };
      },
    });

    tools.push(resolve);
  }

  return tools;
}
