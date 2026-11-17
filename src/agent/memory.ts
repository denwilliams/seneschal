import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { MemoryFile } from "./memory-store.ts";

/**
 * Memory is markdown on disk, one file per scope. The model gets an explicit
 * scope argument rather than a path, so "remember this" cannot accidentally
 * become "write to the account brain": writing to `account` scope requires
 * `share.memoryWrite` for the channel, and is refused otherwise.
 *
 * The bookkeeping behind these tools lives in `memory-store.ts`: repeating a
 * fact strengthens the entry that already says it rather than adding a second
 * copy, and a recall aimed at a topic records which entries were reached for.
 * Neither changes how the tools are used — they are what lets the nightly
 * consolidation pass tell a fact that matters from one that has just been
 * sitting there.
 */

export function createMemoryTools(channel: ResolvedChannel): ToolDefinition[] {
  const foreign = channel.memory.foreignFiles;

  const scopeEnum = Type.Union(
    [
      Type.Literal("channel"),
      ...(channel.memory.sharedFile ? [Type.Literal("account")] : []),
      ...foreign.map((f) => Type.Literal(`channel:${f.channel}`)),
    ] as any,
    {
      description: `Which memory to use. "channel" is this channel's private memory${
        channel.memory.sharedFile ? `, "account" is shared across the whole account` : ""
      }${foreign.length > 0 ? `, and channel:<name> reads another channel's shared memory` : ""}.`,
    },
  );

  const resolveScope = (scope: string): { path: string; writable: boolean; label: string } => {
    if (scope === "channel") {
      return { path: channel.memory.channelFile, writable: true, label: "channel memory" };
    }
    if (scope === "account") {
      if (!channel.memory.sharedFile) throw new Error("Account memory is not available to this channel.");
      return {
        path: channel.memory.sharedFile,
        writable: channel.memory.canWriteShared,
        label: "account memory",
      };
    }
    const name = scope.startsWith("channel:") ? scope.slice("channel:".length) : "";
    const match = foreign.find((f) => f.channel === name);
    if (!match) throw new Error(`Memory scope "${scope}" is not available to this channel.`);
    return { path: match.path, writable: false, label: `memory of #${name}` };
  };

  const recall = defineTool({
    name: "recall",
    label: "Recall",
    description:
      "Read stored memory. Use this when you need background on this channel's ongoing work, preferences, or previously agreed facts. " +
      "Prefer passing `about` with what you are trying to remember: it filters to the entries that matter, and it is how the memory learns " +
      "which facts earn their place. Omit it only when you genuinely want everything.",
    parameters: Type.Object({
      scope: scopeEnum,
      about: Type.Optional(
        Type.String({
          description:
            "What you are trying to remember, in a few words — a topic, a name, a system. Omit to read the whole file.",
        }),
      ),
    }),
    execute: async (_id, params: { scope: string; about?: string }) => {
      const { path, writable, label } = resolveScope(params.scope);
      const file = new MemoryFile(path);

      const about = params.about?.trim();
      if (about) {
        const hits = file.search(about);
        if (hits.length > 0) {
          // Only for a scope we own: recording usage in another channel's
          // directory would be writing across the isolation boundary.
          if (writable) file.markUsed(hits.map((h) => h.id));
          return {
            content: [
              {
                type: "text" as const,
                text: `# ${label} — about "${about}"\n\n${hits.map((h) => `- ${h.text}`).join("\n")}`,
              },
            ],
            details: { scope: params.scope, path, matched: hits.length },
          };
        }
      }

      const content = file.read();
      return {
        content: [
          {
            type: "text" as const,
            text: content.trim()
              ? `# ${label}${about ? ` (nothing matched "${about}", so here is everything)` : ""}\n\n${content}`
              : `${label} is empty.`,
          },
        ],
        details: { scope: params.scope, path, matched: 0 },
      };
    },
  });

  const remember = defineTool({
    name: "remember",
    label: "Remember",
    description:
      "Append one concise, durable fact to memory. Capture a learning promptly after a user correction or teaching, an agent mistake and its remedy, an important decision or outcome, or lengthy or iterative work reveals a reusable preference or process (save repeatable steps as a skill). " +
      "Keep facts, not chat transcripts, turn-by-turn status, or one-off details. Saying something you already know is not wasted — it strengthens the entry rather than duplicating it, and a fact stated with more detail refines the one already there.",
    parameters: Type.Object({
      text: Type.String({
        description:
          "One concise durable fact to keep for later, not a chat transcript or status update; write repeatable procedures with save_skill instead.",
      }),
      scope: Type.Optional(scopeEnum),
    }),
    execute: async (_id, params: { text: string; scope?: string }) => {
      const scope = params.scope ?? "channel";
      const { path, writable, label } = resolveScope(scope);
      if (!writable) {
        throw new Error(
          scope === "account"
            ? "This channel cannot write to account memory. Enable share.memoryWrite in the harness config to allow it."
            : `${label} is read-only from this channel.`,
        );
      }
      if (!params.text.trim()) throw new Error("There is nothing to remember.");

      const result = new MemoryFile(path).append(params.text);
      const text = result.reinforced
        ? result.replaced
          ? `Already knew that; refined the entry and strengthened it (learned ${result.entry.stats.strength}× now).`
          : `Already knew that — strengthened the entry instead of duplicating it (learned ${result.entry.stats.strength}× now).`
        : `Saved to ${label}.`;

      return {
        content: [{ type: "text" as const, text }],
        details: { scope, path, reinforced: result.reinforced },
      };
    },
  });

  const forget = defineTool({
    name: "forget",
    label: "Forget",
    description:
      "Rewrite this channel's memory file with corrected content. Read it with recall first, then pass the full replacement text. " +
      "Anything you leave out is moved to the archive file rather than destroyed, so consolidating is safe.",
    parameters: Type.Object({
      content: Type.String({ description: "Full replacement content for the memory file." }),
    }),
    execute: async (_id, params: { content: string }) => {
      const file = new MemoryFile(channel.memory.channelFile);
      const result = file.rewrite(params.content);
      return {
        content: [
          {
            type: "text" as const,
            text:
              result.dropped.length > 0
                ? `Channel memory rewritten. ${result.dropped.length} entr${
                    result.dropped.length === 1 ? "y was" : "ies were"
                  } dropped and moved to the archive.`
                : "Channel memory rewritten.",
          },
        ],
        details: { path: file.path, dropped: result.dropped.length },
      };
    },
  });

  return [recall, remember, forget] as ToolDefinition[];
}
