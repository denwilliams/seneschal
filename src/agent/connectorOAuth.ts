import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { HttpConnectorOAuthConfig } from "../config/schema.ts";
import { REPO_ROOT } from "../config/load.ts";

interface AuthorizationSession {
  state: string;
  expiresAt: string;
}

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  authorizationUrl?: string;
  authorizationSession?: AuthorizationSession;
  updatedAt?: string;
}

export interface ManualAuthorizationResult {
  state: string;
  code?: string;
  error?: string;
}

export class ManualAuthorizationError extends Error {
  constructor(message: "expired" | "invalid" | "denied") {
    super(message);
    this.name = "ManualAuthorizationError";
  }
}

export interface ConnectorOAuthProviderOptions {
  connectorName: string;
  channelRoot: string;
  oauth: HttpConnectorOAuthConfig;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  /** Injectable only for deterministic expiry tests. */
  now?: () => Date;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveTokenFile(connectorName: string, channelRoot: string, raw?: string): string {
  if (!raw) return join(channelRoot, "agent", "oauth-connectors", `${safeName(connectorName)}.json`);
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

function readJson(path: string): StoredOAuthState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StoredOAuthState;
  } catch {
    return {};
  }
}

function writeJson(path: string, state: StoredOAuthState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: "wx" });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best effort: some filesystems ignore POSIX permissions.
  }
  renameSync(tmp, path);
}

/**
 * File-backed OAuth provider for one HTTP MCP connector in one channel.
 *
 * The SDK performs discovery, PKCE, token refresh and token exchange. This class
 * supplies static client metadata (when configured) and keeps the verifier and
 * tokens in channel-private state so OAuth credentials do not cross channels.
 */
export class FileConnectorOAuthProvider implements OAuthClientProvider {
  readonly storePath: string;
  private readonly connectorName: string;
  private readonly oauth: HttpConnectorOAuthConfig;
  private readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  private readonly now: () => Date;

  constructor(options: ConnectorOAuthProviderOptions) {
    this.connectorName = options.connectorName;
    this.oauth = options.oauth;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.now = options.now ?? (() => new Date());
    this.storePath = resolveTokenFile(options.connectorName, options.channelRoot, options.oauth.tokenFile);
  }

  /** Static credentials belong to the resolved config, never the OAuth state file.
   * Also remove legacy copies whenever any state is next persisted. DCR clients
   * still need their registration (including any issued secret) across restarts.
   */
  private writeState(state: StoredOAuthState): void {
    const persisted = { ...state };
    if (this.oauth.clientId) delete persisted.clientInformation;
    writeJson(this.storePath, persisted);
  }

  get redirectUrl(): string | URL {
    return this.oauth.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.oauth.redirectUrl],
      client_name: this.oauth.clientName ?? `Seneschal ${this.connectorName}`,
      ...(this.oauth.scope ? { scope: this.oauth.scope } : {}),
      ...(this.oauth.tokenEndpointAuthMethod
        ? { token_endpoint_auth_method: this.oauth.tokenEndpointAuthMethod }
        : {}),
    };
  }

  state(): string {
    const state = randomBytes(32).toString("base64url");
    // Config parsing supplies this default; retain it here for old callers that
    // construct a provider directly during an upgrade.
    const ttlSeconds = this.oauth.manualCompletionTtlSeconds ?? 600;
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
    const stored = readJson(this.storePath);
    // Starting a new authorization intentionally supersedes any older pending
    // result. Remove the prior verifier before the SDK generates and saves the
    // new one, so a concurrent completion cannot pair new state with old PKCE.
    delete stored.codeVerifier;
    this.writeState({ ...stored, authorizationSession: { state, expiresAt } });
    return state;
  }

  /**
   * Validate and consume a manual authorization result before token exchange.
   * The state session is removed synchronously first, making it one-time even
   * if a second Slack event arrives while the token request is in flight.
   */
  consumeManualAuthorizationResult(result: ManualAuthorizationResult): void {
    const stored = readJson(this.storePath);
    const session = stored.authorizationSession;
    if (!session) throw new ManualAuthorizationError("invalid");

    if (this.now().getTime() >= Date.parse(session.expiresAt)) {
      delete stored.authorizationSession;
      delete stored.codeVerifier;
      this.writeState(stored);
      throw new ManualAuthorizationError("expired");
    }

    const expected = Buffer.from(session.state);
    const received = Buffer.from(result.state);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new ManualAuthorizationError("invalid");
    }

    delete stored.authorizationSession;
    delete stored.authorizationUrl;
    if (result.error || !result.code) {
      delete stored.codeVerifier;
      this.writeState(stored);
      throw new ManualAuthorizationError("denied");
    }
    this.writeState(stored);
  }

  /** Cancel only the pending authorization created by a now-abandoned flight. */
  cancelAuthorizationSession(expectedState: string): void {
    const stored = readJson(this.storePath);
    if (stored.authorizationSession?.state !== expectedState) return;
    delete stored.authorizationSession;
    delete stored.authorizationUrl;
    delete stored.codeVerifier;
    this.writeState(stored);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // Current static config wins over old registrations or pre-fix disk copies,
    // so a newly resolved Keychain value is not shadowed after rotation.
    if (!this.oauth.clientId) return readJson(this.storePath).clientInformation;
    return {
      client_id: this.oauth.clientId,
      ...(this.oauth.clientSecret ? { client_secret: this.oauth.clientSecret } : {}),
      ...(this.oauth.tokenEndpointAuthMethod
        ? { token_endpoint_auth_method: this.oauth.tokenEndpointAuthMethod }
        : {}),
    };
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    const state = readJson(this.storePath);
    this.writeState({ ...state, clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return readJson(this.storePath).tokens;
  }

  /** Optimistic concurrency guard for an isolated console consent flight. */
  credentialRevision(): string {
    return createHash("sha256").update(existsSync(this.storePath) ? readFileSync(this.storePath) : "missing").digest("hex");
  }

  /** Commit a complete grant atomically; never inherit another account's refresh token. */
  commitAuthorization(expectedRevision: string, grant: {
    clientInformation: OAuthClientInformationMixed;
    tokens: OAuthTokens;
    discoveryState?: OAuthDiscoveryState;
  }): void {
    if (this.credentialRevision() !== expectedRevision) throw new Error("Connector credentials changed during authorization; retry.");
    this.writeState(grant);
  }

  saveTokens(tokens: OAuthTokens): void {
    const state = readJson(this.storePath);
    this.writeState({
      ...state,
      tokens: {
        ...tokens,
        refresh_token: tokens.refresh_token ?? state.tokens?.refresh_token,
      },
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const state = readJson(this.storePath);
    this.writeState({ ...state, authorizationUrl: authorizationUrl.toString() });
    await this.onAuthorizationUrl?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    const state = readJson(this.storePath);
    this.writeState({ ...state, codeVerifier });
  }

  codeVerifier(): string {
    const verifier = readJson(this.storePath).codeVerifier;
    if (!verifier) {
      throw new Error(`OAuth code verifier missing for connector "${this.connectorName}"; start auth again.`);
    }
    return verifier;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    const state = readJson(this.storePath);
    this.writeState({ ...state, discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readJson(this.storePath).discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      this.writeState({});
      return;
    }
    const state = readJson(this.storePath);
    if (scope === "client") delete state.clientInformation;
    if (scope === "tokens") delete state.tokens;
    if (scope === "verifier") delete state.codeVerifier;
    if (scope === "discovery") delete state.discoveryState;
    this.writeState(state);
  }
}
