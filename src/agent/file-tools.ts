import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkPath, type JailConfig } from "./jail.ts";

/**
 * Publishing a file the agent made.
 *
 * The agent could already write files — it just had no way to hand one to
 * anybody, so a generated chart or report died in the channel workspace and
 * the best it could do was describe the thing it had built. This is the other
 * half: produce a file with the tools it already has, then attach it.
 *
 * Every upload is jailed. The path is resolved through symlinks and checked
 * against the channel's readable roots, exactly as `read` is, because an
 * unchecked upload path is a way to read a file out of another channel and
 * post it into this one — the isolation model in reverse. The channel's env
 * bundle lives outside those roots by design, so secrets are not reachable
 * from here either.
 *
 * Like `post_message`, this takes no channel argument: it posts where the
 * session is already working. A tool that accepted a channel id would let work
 * begun in one channel publish as the bot in another.
 */

/**
 * Slack accepts far larger files, but this runs on a home uplink and someone's
 * own budget. A cap turns "the agent uploaded a 400MB core dump" into an error
 * it can read and recover from.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * What Slack shows inline rather than as a card people have to click. Worth
 * telling the model, since "make me a chart" is only answered if the chart is
 * visible in the channel without a download.
 */
const PREVIEWS_INLINE = [".png", ".jpg", ".jpeg", ".gif"];

export interface FileUploader {
  upload(input: {
    channelId: string;
    /** Absolute path, already checked against the channel's jail. */
    path: string;
    filename: string;
    title?: string;
    comment?: string;
    altText?: string;
    /** Omit to post at channel level; pass a thread ts to attach in-thread. */
    threadTs?: string;
  }): Promise<{ permalink?: string }>;
}

export interface FileToolsContext {
  uploader: FileUploader;
  channelId: string;
  channelLabel: string;
  /** Thread the agent is currently working in, if any. */
  currentThreadTs: () => string | undefined;
  /** This channel's filesystem jail, applied to the upload path. */
  jail: JailConfig;
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function createFileTools(ctx: FileToolsContext): ToolDefinition[] {
  const upload = defineTool({
    name: "upload_file",
    label: "Attach a file",
    description:
      `Attach a file from your workspace to ${ctx.channelLabel}, so people can see or download it. ` +
      "Use this for anything that is better as a file than as a message: a chart or image you generated, " +
      "a report, a CSV, a log, a document. " +
      "Write the file first with your normal file tools, then attach it by path. " +
      "Slack previews PNG, JPEG and GIF inline — anything else (SVG, PDF, CSV, text) appears as a card " +
      "people click, so prefer PNG for a chart you want seen at a glance. " +
      "Say what the file shows in `comment` rather than repeating it in your reply.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to the file, relative to your workspace (or absolute within it). The file must already exist.",
      }),
      comment: Type.Optional(
        Type.String({
          description:
            "Message posted with the file, in Slack mrkdwn. This is what people read next to it.",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Title shown on the file in Slack. Defaults to the filename." }),
      ),
      alt_text: Type.Optional(
        Type.String({
          description: "Description of an image for screen readers. Set this whenever you attach one.",
        }),
      ),
      to_channel: Type.Optional(
        Type.Boolean({
          description:
            "Attach as a new top-level message in the channel instead of in the thread you are working in. " +
            "Defaults to false. Use true when publishing (a scheduled report, an announcement), not when answering someone.",
        }),
      ),
    }),
    execute: async (
      _id,
      params: {
        path: string;
        comment?: string;
        title?: string;
        alt_text?: string;
        to_channel?: boolean;
      },
    ) => {
      const raw = params.path?.trim();
      if (!raw) throw new Error("upload_file needs the path of a file to attach.");

      // The same check `read` gets, for the same reason: this channel's
      // readable roots and nothing else, with symlinks resolved first.
      const decision = checkPath(ctx.jail, raw, "read");
      if (!decision.allowed) {
        throw new Error(
          decision.reason ??
            `${raw} is outside this channel's workspace, so it cannot be attached.`,
        );
      }
      const path = decision.resolved;

      if (!existsSync(path)) {
        throw new Error(
          `There is no file at ${raw}. Create it first, then attach it by the path you wrote it to.`,
        );
      }
      const stat = statSync(path);
      if (stat.isDirectory()) {
        throw new Error(`${raw} is a directory. Attach a single file.`);
      }
      if (stat.size === 0) {
        throw new Error(`${raw} is empty, so there is nothing to attach.`);
      }
      if (stat.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `${raw} is ${describeSize(stat.size)}, over the ${describeSize(MAX_UPLOAD_BYTES)} upload limit. ` +
            "Attach something smaller — a summary, a chart of the data, or a trimmed extract.",
        );
      }

      const filename = basename(path);
      const threadTs = params.to_channel ? undefined : ctx.currentThreadTs();

      const result = await ctx.uploader.upload({
        channelId: ctx.channelId,
        path,
        filename,
        ...(params.title ? { title: params.title } : {}),
        ...(params.comment ? { comment: params.comment } : {}),
        ...(params.alt_text ? { altText: params.alt_text } : {}),
        ...(threadTs ? { threadTs } : {}),
      });

      const inline = PREVIEWS_INLINE.some((ext) => filename.toLowerCase().endsWith(ext));
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Attached ${filename} (${describeSize(stat.size)}) to ${ctx.channelLabel}` +
              `${threadTs ? " in this thread" : " as a new message"}. ` +
              (inline ? "It is visible in the channel now. " : "It appears as a file people can open. ") +
              "Do not describe its contents again in your reply.",
          },
        ],
        details: { filename, bytes: stat.size, permalink: result.permalink },
      };
    },
  });

  return [upload] as ToolDefinition[];
}
