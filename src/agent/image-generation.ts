import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { isIP } from "node:net";
import { isPrivateAddress } from "./web.ts";

/**
 * Prompt-to-image generation, deliberately narrower than a browser or a shell.
 *
 * The tool calls a configured image API, writes the returned bytes into this
 * channel's workspace, and lets the existing upload_file tool handle Slack.
 * API keys live in the channel env bundle and are never passed to the model.
 */

export interface ImageGenerationConfig {
  provider: "none" | "openai";
  baseUrl: string;
  apiKey: string;
  /** Optional model provider id whose configured credentials should be used, e.g. openai-codex. */
  authProvider: string;
  model: string;
  size: string;
  quality: string;
  outputFormat: "png" | "jpeg" | "webp";
  responseFormat: "auto" | "b64_json" | "url";
  timeoutSeconds: number;
  maxBytes: number;
  maxPromptChars: number;
}

export interface ImageRequestAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}

export interface ImageGenerationDeps {
  fetchImpl?: typeof fetch;
  /** Resolve a hostname to every address it has. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Resolve credentials from the harness model runtime, for subscription/OAuth providers like openai-codex. */
  resolveAuth?: (providerId: string, signal: AbortSignal) => Promise<ImageRequestAuth | undefined>;
}

export interface GenerateImageInput {
  prompt: string;
  outputPath: string;
  size?: string;
  quality?: string;
  outputFormat?: "png" | "jpeg" | "webp";
}

export interface GeneratedImage {
  path: string;
  mimeType: string;
  bytes: number;
  model: string;
  revisedPrompt?: string;
}

export class ImageGenerationError extends Error {}

export function imageGenerationConfigured(config: ImageGenerationConfig): boolean {
  return (
    config.provider !== "none" &&
    (config.apiKey.trim().length > 0 || config.authProvider.trim().length > 0)
  );
}

function ensureConfigured(config: ImageGenerationConfig): void {
  if (config.provider === "none") {
    throw new ImageGenerationError("AI image generation is not configured for this channel.");
  }
  if (!imageGenerationConfigured(config)) {
    throw new ImageGenerationError(
      "AI image generation is enabled but has no API key or auth provider. Set images.apiKey, or set images.authProvider to a logged-in provider such as openai-codex.",
    );
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/generations`;
}

function extFor(format: string): string {
  return format === "jpeg" ? ".jpg" : `.${format}`;
}

export function mimeFor(format: string): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function normaliseOutputPath(path: string, format: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new ImageGenerationError("generate_image needs an output path.");
  return extname(trimmed) ? trimmed : `${trimmed}${extFor(format)}`;
}

function parseGenerationResponse(raw: unknown): { b64?: string; url?: string; revisedPrompt?: string } {
  const obj = raw as any;
  const first = obj?.data?.[0];
  if (!first || typeof first !== "object") {
    throw new ImageGenerationError("The image API returned no image data.");
  }

  const b64 = typeof first.b64_json === "string" ? first.b64_json : undefined;
  const url = typeof first.url === "string" ? first.url : undefined;
  const revisedPrompt = typeof first.revised_prompt === "string" ? first.revised_prompt : undefined;
  if (!b64 && !url) {
    throw new ImageGenerationError("The image API response had neither b64_json nor url for the image.");
  }
  return { ...(b64 ? { b64 } : {}), ...(url ? { url } : {}), ...(revisedPrompt ? { revisedPrompt } : {}) };
}

async function readBinaryCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new ImageGenerationError(
        `The generated image is over this channel's ${Math.round(maxBytes / 1024 / 1024)}MB limit.`,
      );
    }
    return buf;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new ImageGenerationError(
          `The generated image is over this channel's ${Math.round(maxBytes / 1024 / 1024)}MB limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

async function assertPublicHttps(
  url: URL,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<void> {
  if (url.protocol !== "https:") {
    throw new ImageGenerationError("The image API returned a non-HTTPS image URL, so it was refused.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) {
    throw new ImageGenerationError("The image API returned a local-network image URL, so it was refused.");
  }
  const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => []);
  if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address))) {
    throw new ImageGenerationError("The image API returned an image URL that resolves locally, so it was refused.");
  }
}

async function fetchReturnedImage(
  rawUrl: string,
  maxBytes: number,
  signal: AbortSignal,
  deps: ImageGenerationDeps,
): Promise<{ bytes: Buffer; mimeType?: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveHost = deps.resolveHost ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageGenerationError("The image API returned an invalid image URL.");
  }

  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicHttps(url, resolveHost);
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ImageGenerationError("The generated image URL redirected without a location.");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      throw new ImageGenerationError(`The generated image URL returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      throw new ImageGenerationError(`The generated image URL returned ${contentType}, not an image.`);
    }
    return { bytes: await readBinaryCapped(response, maxBytes), ...(contentType ? { mimeType: contentType.split(";")[0] } : {}) };
  }
  throw new ImageGenerationError("The generated image URL redirected too many times.");
}

async function resolveRequestAuth(
  config: ImageGenerationConfig,
  deps: ImageGenerationDeps,
  signal: AbortSignal,
): Promise<{ apiKey?: string; headers?: Record<string, string>; baseUrl: string }> {
  const providerId = config.authProvider.trim();
  const runtimeAuth = providerId ? await deps.resolveAuth?.(providerId, signal) : undefined;
  const apiKey = config.apiKey.trim() || runtimeAuth?.apiKey;
  const rawHeaders = runtimeAuth?.headers ?? {};
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  if (!apiKey && Object.keys(headers).length === 0) {
    throw new ImageGenerationError(
      providerId
        ? `No usable credentials are configured for image auth provider "${providerId}". Run \`npm run login -- ${providerId}\` or set images.apiKey.`
        : "No usable image API credentials are configured.",
    );
  }

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    baseUrl: config.baseUrl || runtimeAuth?.baseUrl || "https://api.openai.com/v1",
  };
}

export async function generateImage(
  config: ImageGenerationConfig,
  input: GenerateImageInput,
  deps: ImageGenerationDeps = {},
): Promise<GeneratedImage> {
  ensureConfigured(config);
  const prompt = input.prompt.trim();
  if (!prompt) throw new ImageGenerationError("generate_image needs a prompt.");
  if (prompt.length > config.maxPromptChars) {
    throw new ImageGenerationError(
      `The prompt is ${prompt.length} characters, over this channel's ${config.maxPromptChars} character limit.`,
    );
  }

  const outputFormat = input.outputFormat ?? config.outputFormat;
  const outputPath = normaliseOutputPath(input.outputPath, outputFormat);
  const body: Record<string, unknown> = {
    model: config.model,
    prompt,
    n: 1,
    size: input.size ?? config.size,
  };
  const quality = input.quality ?? config.quality;
  if (quality) body.quality = quality;
  if (outputFormat) body.output_format = outputFormat;
  if (config.responseFormat !== "auto") body.response_format = config.responseFormat;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(config.timeoutSeconds * 1000);
  const requestAuth = await resolveRequestAuth(config, deps, signal);
  const headers = new Headers(requestAuth.headers);
  if (requestAuth.apiKey) headers.set("authorization", `Bearer ${requestAuth.apiKey}`);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  let response: Response;
  try {
    response = await fetchImpl(endpoint(requestAuth.baseUrl), {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ImageGenerationError(
      `The image API request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 1000);
    try {
      const parsed = JSON.parse(text) as any;
      detail = parsed?.error?.message ?? parsed?.message ?? detail;
    } catch {
      // Keep the raw body prefix.
    }
    throw new ImageGenerationError(`The image API returned HTTP ${response.status}: ${detail}`);
  }

  let parsed: { b64?: string; url?: string; revisedPrompt?: string };
  try {
    parsed = parseGenerationResponse(JSON.parse(text));
  } catch (err) {
    if (err instanceof ImageGenerationError) throw err;
    throw new ImageGenerationError("The image API returned invalid JSON.");
  }

  const image = parsed.b64
    ? { bytes: Buffer.from(parsed.b64, "base64"), mimeType: mimeFor(outputFormat) }
    : await fetchReturnedImage(parsed.url!, config.maxBytes, signal, deps);
  if (image.bytes.byteLength === 0) {
    throw new ImageGenerationError("The image API returned an empty image.");
  }
  if (image.bytes.byteLength > config.maxBytes) {
    throw new ImageGenerationError(
      `The generated image is over this channel's ${Math.round(config.maxBytes / 1024 / 1024)}MB limit.`,
    );
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, image.bytes);

  return {
    path: outputPath,
    mimeType: image.mimeType ?? mimeFor(outputFormat),
    bytes: image.bytes.byteLength,
    model: config.model,
    ...(parsed.revisedPrompt ? { revisedPrompt: parsed.revisedPrompt } : {}),
  };
}

export function defaultImagePath(now = new Date(), format: "png" | "jpeg" | "webp" = "png"): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `generated/image-${stamp}${extFor(format)}`;
}

