import { existsSync } from "node:fs";
import { extname } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkPath, type JailConfig } from "./jail.ts";
import {
  defaultImagePath,
  generateImage,
  imageGenerationConfigured,
  type ImageGenerationConfig,
  type ImageGenerationDeps,
} from "./image-generation.ts";

export interface ImageToolsContext {
  config: ImageGenerationConfig;
  channelLabel: string;
  jail: JailConfig;
  deps?: ImageGenerationDeps;
}

function extFor(format: "png" | "jpeg" | "webp"): string {
  return format === "jpeg" ? ".jpg" : `.${format}`;
}

function ensureExtension(path: string, format: "png" | "jpeg" | "webp"): string {
  return extname(path) ? path : `${path}${extFor(format)}`;
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function createImageTools(ctx: ImageToolsContext): ToolDefinition[] {
  if (!imageGenerationConfigured(ctx.config)) return [];

  const tool = defineTool({
    name: "generate_image",
    label: "Generate an AI image",
    description:
      "Generate a prompt-based AI image with the channel's configured image model and write it as a PNG/JPEG/WebP file in the workspace. " +
      "Use this for AI art or prompt-based image generation, not for charts that can be rendered deterministically. " +
      "After it succeeds, use upload_file to attach the generated file to Slack. " +
      "Do not include private or sensitive information in image prompts.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Detailed prompt for the image model. Avoid private or sensitive information.",
      }),
      output_path: Type.Optional(
        Type.String({
          description:
            "Where to write the image, relative to the workspace. Defaults to generated/image-<timestamp>.png. The extension controls the file type when present.",
        }),
      ),
      size: Type.Optional(
        Type.String({ description: `Image size. Defaults to ${ctx.config.size}.` }),
      ),
      quality: Type.Optional(
        Type.String({ description: `Provider-specific quality. Defaults to ${ctx.config.quality}.` }),
      ),
      output_format: Type.Optional(
        Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], {
          description: `Output format. Defaults to ${ctx.config.outputFormat}.`,
        }),
      ),
    }),
    execute: async (
      _id,
      params: {
        prompt: string;
        output_path?: string;
        size?: string;
        quality?: string;
        output_format?: "png" | "jpeg" | "webp";
      },
    ) => {
      const format = params.output_format ?? ctx.config.outputFormat;
      const rawPath = ensureExtension(params.output_path?.trim() || defaultImagePath(new Date(), format), format);
      const decision = checkPath(ctx.jail, rawPath, "write");
      if (!decision.allowed) {
        throw new Error(decision.reason ?? `${rawPath} is outside this channel's workspace.`);
      }
      if (existsSync(decision.resolved)) {
        throw new Error(`${rawPath} already exists. Pick a new output_path rather than overwriting it.`);
      }

      const generated = await generateImage(
        ctx.config,
        {
          prompt: params.prompt,
          outputPath: decision.resolved,
          ...(params.size ? { size: params.size } : {}),
          ...(params.quality ? { quality: params.quality } : {}),
          ...(params.output_format ? { outputFormat: params.output_format } : {}),
        },
        ctx.deps,
      );

      const rel = rawPath;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Generated ${rel} (${describeSize(generated.bytes)}, ${generated.mimeType}) using ${generated.model}. ` +
              `Use upload_file with path \`${rel}\` to show it in ${ctx.channelLabel}.` +
              (generated.revisedPrompt ? ` Revised prompt: ${generated.revisedPrompt}` : ""),
          },
        ],
        details: generated,
      };
    },
  });

  return [tool] as ToolDefinition[];
}
