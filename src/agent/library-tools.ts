import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import {
  installFromLibrary,
  installedFromLibrary,
  listLibrary,
  publishToLibrary,
  readLibrarySkill,
  unpublishFromLibrary,
} from "./library.ts";

/**
 * Tools for the shared skill library.
 *
 * The shape follows what the library is for. Reading is browsing a shelf, so
 * listing and reading are separate calls: the description is what decides
 * whether a skill is worth a look, and the body is what decides whether it is
 * worth installing. Installing is a copy into this channel, which is a
 * deliberate act and says so. Publishing is gated, and when it is not allowed
 * the error points at the way to ask rather than at a config file the agent
 * cannot edit.
 */

export interface LibraryToolsContext {
  channel: ResolvedChannel;
  /** Re-scan this channel's skills, so an install is live from the next turn. */
  reload: () => Promise<void>;
}

export function createLibraryTools(ctx: LibraryToolsContext): ToolDefinition[] {
  const { channel } = ctx;
  if (!channel.library.canRead && !channel.library.canPublish) return [];

  const shared = channel.shared;
  const tools: ToolDefinition[] = [];

  const list = defineTool({
    name: "list_library_skills",
    label: "Browse the skill library",
    description:
      "List skills other channels have published to the shared library. " +
      "Use this when you are about to work out how to do something from scratch — another channel may have already written it down. " +
      "Listing shows names and descriptions only; read one before installing it.",
    parameters: Type.Object({}),
    execute: async () => {
      const entries = listLibrary(shared);
      const installed = installedFromLibrary(channel);
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The shared library is empty — no channel has published a skill yet.",
            },
          ],
          details: { count: 0 },
        };
      }
      const lines = entries.map((e) => {
        const mine = installed[e.name];
        const state = !mine
          ? ""
          : mine.version < e.version
            ? ` [installed here at v${mine.version}, v${e.version} available]`
            : " [installed here]";
        return `- ${e.name} (from ${e.publishedBy}, v${e.version})${state}\n    ${e.description}${
          e.note ? `\n    Publisher's note: ${e.note}` : ""
        }`;
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `${entries.length} skill(s) in the shared library:\n\n${lines.join("\n")}`,
          },
        ],
        details: { count: entries.length },
      };
    },
  });

  const read = defineTool({
    name: "read_library_skill",
    label: "Read a library skill",
    description:
      "Read the full instructions of a library skill without installing it. " +
      "Do this before installing anything: a library skill was written by another channel for its own situation, and it may not fit yours.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the skill, as shown by list_library_skills." }),
    }),
    execute: async (_id, params: { name: string }) => {
      const skill = readLibrarySkill(shared, params.name);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# ${skill.name}`,
              `_Published by ${skill.publishedBy}, v${skill.version}, ${skill.updatedAt.slice(0, 10)}._`,
              skill.note ? `_Publisher's note: ${skill.note}_` : "",
              "",
              skill.description,
              "",
              "---",
              "",
              skill.instructions,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: { name: skill.name, version: skill.version },
      };
    },
  });

  const install = defineTool({
    name: "install_library_skill",
    label: "Install a library skill",
    description:
      "Copy a library skill into this channel so you can use it. " +
      "Read it first and judge whether it actually applies here — installing means following those instructions in future. " +
      "The copy is yours: you can refine it with `save_skill` or drop it with `delete_skill`, and doing so does not affect the published version.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the library skill to install." }),
      replace: Type.Optional(
        Type.Boolean({
          description:
            "Overwrite a skill of the same name that this channel wrote itself. Only pass true if you mean to lose your own version.",
        }),
      ),
    }),
    execute: async (_id, params: { name: string; replace?: boolean }) => {
      const result = installFromLibrary(
        shared,
        channel,
        params.name,
        params.replace ? { replace: true } : {},
      );
      await ctx.reload();
      return {
        content: [
          {
            type: "text" as const,
            text:
              (result.replacedVersion
                ? `Updated \`${result.entry.name}\` from v${result.replacedVersion} to v${result.entry.version}.`
                : `Installed \`${result.entry.name}\` from ${result.entry.publishedBy}.`) +
              " It is available from your next message onwards, and it is now this channel's own skill.",
          },
        ],
        details: { name: result.entry.name, version: result.entry.version, path: result.path },
      };
    },
  });

  if (channel.library.canRead) tools.push(list, read, install);

  // Publishing is offered even when it is not currently allowed, so the agent
  // finds the door rather than the wall: the tool exists and explains how to
  // ask. Without it, "share this with the other channels" is answered by an
  // agent that has no idea sharing is a thing that can happen here.
  const publish = defineTool({
    name: "publish_skill",
    label: "Publish a skill",
    description:
      "Publish one of this channel's own skills to the shared library, so other channels can find and install it. " +
      "Use this when you have worked out something general — a procedure that would help a channel that is not this one. " +
      "Do not publish anything channel-specific, and never publish a skill containing secrets, credentials, or private details from this channel's conversations: the library is readable across the account.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of one of this channel's own skills." }),
      note: Type.Optional(
        Type.String({
          description:
            "One line on why another channel would want this, and what it assumes. Shown beside the skill in the library.",
        }),
      ),
    }),
    execute: async (_id, params: { name: string; note?: string }) => {
      if (!channel.library.canPublish) {
        throw new Error(
          "This channel cannot publish to the shared library. Publishing writes instructions other " +
            "channels may follow, so it needs a human: ask with `request_access` for `skillPublish` if " +
            "that is offered here, or an operator can set `share.libraryPublish: true` for this channel.",
        );
      }
      const entry = publishToLibrary(shared, channel, {
        name: params.name,
        ...(params.note ? { note: params.note } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Published \`${entry.name}\` to the shared library as v${entry.version}. ` +
              "Other channels can now find it, but nothing changes for them until one of them installs it.",
          },
        ],
        details: { name: entry.name, version: entry.version },
      };
    },
  });

  const unpublish = defineTool({
    name: "unpublish_skill",
    label: "Withdraw a published skill",
    description:
      "Remove a skill this channel published from the shared library, when it turned out to be wrong or too specific. " +
      "Channels that already installed it keep their copy — this only takes it off the shelf.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the published skill to withdraw." }),
    }),
    execute: async (_id, params: { name: string }) => {
      const removed = unpublishFromLibrary(shared, channel, params.name);
      if (!removed) throw new Error(`The library has no skill called \`${params.name}\`.`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Withdrew \`${params.name}\` from the shared library. Channels that installed it keep their copy.`,
          },
        ],
        details: { name: params.name },
      };
    },
  });

  tools.push(publish);
  if (channel.library.canPublish) tools.push(unpublish);

  return tools;
}
