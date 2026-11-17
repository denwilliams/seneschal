import { auth, type AuthResult } from "@modelcontextprotocol/sdk/client/auth.js";
import type { HttpConnectorOAuthConfig } from "../config/schema.ts";
import {
  FileConnectorOAuthProvider,
  type ManualAuthorizationResult,
  ManualAuthorizationError,
} from "./connectorOAuth.ts";

const PAYLOAD_PREFIX = "oauth-result-v1.";
const MAX_CODE_LENGTH = 8192;
const MAX_STATE_LENGTH = 256;

export interface ManualConnectorOAuthOptions {
  connectorName: string;
  channelRoot: string;
  connectorUrl: string;
  oauth: HttpConnectorOAuthConfig;
  /** Injectable for tests. */
  authorize?: typeof auth;
}

export interface StartedManualConnectorOAuth {
  status: "authorized" | "redirect";
  authorizationUrl?: URL;
}

function resourceMetadataUrl(oauth: HttpConnectorOAuthConfig): URL | undefined {
  return oauth.resourceMetadataUrl ? new URL(oauth.resourceMetadataUrl) : undefined;
}

/**
 * Decode the only authorization-result format accepted from Slack. Keeping the
 * code in a compact base64url envelope prevents URL/query parsing variations
 * and gives the command a single, easy-to-redact argument shape.
 */
export function encodeManualAuthorizationPayload(result: ManualAuthorizationResult): string {
  const value = result.code
    ? { version: 1, state: result.state, code: result.code }
    : { version: 1, state: result.state, error: result.error ?? "authorization_failed" };
  return `${PAYLOAD_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function parseManualAuthorizationPayload(payload: string): ManualAuthorizationResult {
  if (!payload.startsWith(PAYLOAD_PREFIX) || payload.length > 16_384) {
    throw new ManualAuthorizationError("invalid");
  }

  let parsed: unknown;
  try {
    const raw = Buffer.from(payload.slice(PAYLOAD_PREFIX.length), "base64url").toString("utf8");
    parsed = JSON.parse(raw);
  } catch {
    throw new ManualAuthorizationError("invalid");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManualAuthorizationError("invalid");
  }
  const value = parsed as Record<string, unknown>;
  const allowed = new Set(["version", "state", "code", "error"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.version !== 1 ||
    typeof value.state !== "string" ||
    value.state.length === 0 ||
    value.state.length > MAX_STATE_LENGTH
  ) {
    throw new ManualAuthorizationError("invalid");
  }

  const codeProvided = Object.hasOwn(value, "code");
  const errorProvided = Object.hasOwn(value, "error");
  const hasCode = typeof value.code === "string" && value.code.length > 0 && value.code.length <= MAX_CODE_LENGTH;
  const hasError = typeof value.error === "string" && value.error.length > 0 && value.error.length <= 256;
  if (
    (!codeProvided && !errorProvided) ||
    (codeProvided && !hasCode) ||
    (errorProvided && !hasError) ||
    hasCode === hasError
  ) {
    throw new ManualAuthorizationError("invalid");
  }

  return {
    state: value.state,
    ...(hasCode ? { code: value.code as string } : { error: value.error as string }),
  };
}

export function manualAuthorizationErrorMessage(error: unknown): string {
  if (!(error instanceof ManualAuthorizationError)) return "OAuth completion failed. Start a new authorization and try again.";
  if (error.message === "expired") return "That authorization session expired. Start a new authorization and try again.";
  if (error.message === "denied") return "Authorization was denied or cancelled. Start again when ready.";
  return "That authorization result is invalid, already used, or belongs to a different authorization. Start again.";
}

export async function startManualConnectorOAuth(
  options: ManualConnectorOAuthOptions,
): Promise<StartedManualConnectorOAuth> {
  let authorizationUrl: URL | undefined;
  const provider = new FileConnectorOAuthProvider({
    connectorName: options.connectorName,
    channelRoot: options.channelRoot,
    oauth: options.oauth,
    onAuthorizationUrl: (url) => {
      authorizationUrl = url;
    },
  });
  const result = await (options.authorize ?? auth)(provider, {
    serverUrl: options.connectorUrl,
    scope: options.oauth.scope,
    resourceMetadataUrl: resourceMetadataUrl(options.oauth),
  });
  if (result === "AUTHORIZED") return { status: "authorized" };
  if (!authorizationUrl) throw new Error("OAuth authorization URL was not returned.");
  return { status: "redirect", authorizationUrl };
}

/** Validate one-time state before allowing the SDK to exchange the PKCE code. */
export async function completeManualConnectorOAuth(
  options: ManualConnectorOAuthOptions & { payload: string },
): Promise<AuthResult> {
  const result = parseManualAuthorizationPayload(options.payload);
  const provider = new FileConnectorOAuthProvider({
    connectorName: options.connectorName,
    channelRoot: options.channelRoot,
    oauth: options.oauth,
  });
  provider.consumeManualAuthorizationResult(result);
  return await (options.authorize ?? auth)(provider, {
    serverUrl: options.connectorUrl,
    authorizationCode: result.code!,
    scope: options.oauth.scope,
    resourceMetadataUrl: resourceMetadataUrl(options.oauth),
  });
}

/** Operator-only recovery: discard this connector's client, tokens and pending flow. */
export function resetManualConnectorOAuth(options: Omit<ManualConnectorOAuthOptions, "authorize">): void {
  new FileConnectorOAuthProvider({
    connectorName: options.connectorName,
    channelRoot: options.channelRoot,
    oauth: options.oauth,
  }).invalidateCredentials("all");
}
