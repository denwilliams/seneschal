import { createHash, randomBytes } from "node:crypto";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { HarnessConfig, HttpConnectorOAuthConfig } from "../config/schema.ts";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";

export interface ConsoleOAuthTarget {
  userId: string;
  channelId: string;
  threadTs: string;
  connectorName: string;
  channelRoot: string;
  connectorUrl: string;
  oauth: HttpConnectorOAuthConfig;
}
export interface BrowserPairing {
  id: string;
  phrase: string;
  target: ConsoleOAuthTarget;
}
/** A browser has requested pairing but no Slack identity/OAuth state exists yet. */
export type BrowserOAuthTarget = Omit<ConsoleOAuthTarget, "userId" | "threadTs">;
export interface WebBrowserPairing { id: string; phrase: string; target: BrowserOAuthTarget; }
interface WebRequest extends WebBrowserPairing {
  expiresAt: number;
  browserHash: string;
  revision: string;
  threadTs?: string;
}
export const CONSOLE_OAUTH_ACTION = "harness_connector_oauth";
const opaque = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new Error("Authorization unavailable, expired, or already used. Start again in Slack.");

/** One consent flight, isolated from runtime refresh and manual/CLI pending state. */
class PendingProvider implements OAuthClientProvider {
  private client?: OAuthClientInformationMixed;
  private discovery?: OAuthDiscoveryState;
  private verifier?: string;
  private grant?: OAuthTokens;
  authorizationUrl?: URL;
  private readonly file: FileConnectorOAuthProvider;
  private readonly stateValue: string;
  private readonly check: () => void;
  constructor(file: FileConnectorOAuthProvider, stateValue: string, check: () => void) {
    this.file = file; this.stateValue = stateValue; this.check = check;
    this.client = file.clientInformation();
    this.discovery = file.discoveryState();
    // DCR registrations made for a former localhost/static redirect cannot be reused.
    if (this.client && "redirect_uris" in this.client && !this.client.redirect_uris?.includes(String(file.redirectUrl))) {
      throw new Error("Cached registration uses another redirect URI; ask an operator to reset this connector.");
    }
  }
  get redirectUrl(): string | URL { this.check(); return this.file.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata { this.check(); return this.file.clientMetadata; }
  state(): string { this.check(); return this.stateValue; }
  clientInformation() { this.check(); return this.client; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.check(); this.client = value; }
  discoveryState() { this.check(); return this.discovery; }
  saveDiscoveryState(value: OAuthDiscoveryState) { this.check(); this.discovery = value; }
  // Explicit connect always requires fresh consent, not another channel user's existing token.
  tokens() { this.check(); return this.grant; }
  saveTokens(value: OAuthTokens) { this.check(); this.grant = value; }
  saveCodeVerifier(value: string) { this.check(); this.verifier = value; }
  codeVerifier(): string { this.check(); if (!this.verifier) throw invalid(); return this.verifier; }
  redirectToAuthorization(value: URL) {
    this.check();
    // Never redirect a browser to an unsafe scheme or inconsistent SDK flow.
    if (value.protocol !== "https:" || value.username || value.password || value.hash
      || value.searchParams.get("state") !== this.stateValue
      || value.searchParams.get("redirect_uri") !== String(this.redirectUrl)
      || value.searchParams.get("code_challenge_method") !== "S256"
      || !value.searchParams.get("code_challenge")
      || ["client_secret", "access_token", "refresh_token", "id_token", "code"].some((key) => value.searchParams.has(key))) throw invalid();
    this.authorizationUrl = value;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    this.check();
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "tokens") this.grant = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
  issuer(): string | undefined { return this.discovery?.authorizationServerMetadata?.issuer; }
  commit(revision: string) {
    this.check();
    if (!this.grant || !this.client) throw invalid();
    this.file.commitAuthorization(revision, { clientInformation: this.client, tokens: this.grant, discoveryState: this.discovery });
  }
}

type Phase = "link" | "pairing" | "approved" | "preparing" | "consent" | "exchanging";
interface Flight {
  id: string;
  target: ConsoleOAuthTarget;
  expiresAt: number;
  linkHash?: string;
  browserHash?: string;
  phrase?: string;
  phase: Phase;
  state: string;
  revision: string;
  provider: PendingProvider;
  controller: AbortController;
}

export interface ConsoleOAuthHooks {
    pairing: (pairing: BrowserPairing) => Promise<void>;
    notify: (target: ConsoleOAuthTarget, message: string) => Promise<void>;
    /** Recheck effective channel/user/connector permissions and exact config before consent and commit. */
    allowed: (target: ConsoleOAuthTarget) => boolean;
    /** Resolve only known console channels and enabled connector names; never browser-supplied config/scope. */
    browserTarget?: (channelId: string, connectorName: string) => BrowserOAuthTarget | undefined;
    /** Public Slack prompt starts a new thread; returned timestamp binds all later notifications. */
    webPairing?: (pairing: WebBrowserPairing) => Promise<string>;
    authorize?: typeof auth;
    now?: () => number;
}

/** Bounded process-local state. Restart deliberately invalidates unfinished links. */
export class ConsoleConnectorOAuth {
  readonly callbackUrl: string;
  readonly prefix: string;
  readonly origin: string;
  readonly ttlSeconds: number;
  private readonly flights = new Map<string, Flight>();
  private readonly webRequests = new Map<string, WebRequest>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private readonly hooks: ConsoleOAuthHooks;
  constructor(config: NonNullable<HarnessConfig["webConsole"]["oauth"]>, hooks: ConsoleOAuthHooks) {
    this.hooks = hooks;
    this.callbackUrl = config.callbackUrl;
    const callback = new URL(config.callbackUrl);
    if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash
      || !callback.pathname.endsWith("/oauth/callback") || !Number.isInteger(config.ttlSeconds) || config.ttlSeconds < 60 || config.ttlSeconds > 900) throw new Error("Invalid console OAuth callback configuration.");
    this.prefix = callback.pathname.slice(0, -"/callback".length);
    this.origin = callback.origin;
    this.ttlSeconds = config.ttlSeconds;
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref();
  }
  private now() { return this.hooks.now?.() ?? Date.now(); }
  private check(flight: Flight) {
    if (this.closed || flight.controller.signal.aborted || this.flights.get(flight.id) !== flight
      || this.now() >= flight.expiresAt || !this.hooks.allowed(flight.target)
      || flight.target.oauth.redirectUrl !== this.callbackUrl) throw invalid();
  }
  private report(flight: Flight, message: string) {
    // Neither provider errors nor Slack SDK error objects may reach a logger.
    void this.hooks.notify(flight.target, message).catch(() => {});
  }
  private finish(flight: Flight, message: string) {
    if (!this.flights.delete(flight.id)) return;
    flight.controller.abort();
    this.report(flight, message);
  }
  private finishWeb(request: WebRequest, message: string) {
    if (!this.webRequests.delete(request.id)) return;
    this.reportWeb(request, message);
  }
  private reportWeb(request: WebRequest, message: string) {
    if (request.threadTs) void this.hooks.notify({ ...request.target, userId: "", threadTs: request.threadTs }, message).catch(() => {});
  }
  private checkCapacity(target: BrowserOAuthTarget) {
    const pending = [...this.flights.values(), ...this.webRequests.values()];
    if (pending.some((f) => f.target.channelId === target.channelId && f.target.connectorName === target.connectorName)) {
      throw new Error("An authorization for this channel/connector is already pending. Finish, cancel, or wait for it to expire.");
    }
    if (pending.length >= 100) throw new Error("Too many pending authorizations. Try again after existing sessions expire.");
  }
  private file(target: BrowserOAuthTarget): FileConnectorOAuthProvider {
    if (this.closed || !/^[A-Za-z0-9._-]+$/.test(target.connectorName) || !target.oauth.consoleCallback || target.oauth.redirectUrl !== this.callbackUrl) throw invalid();
    if (target.oauth.tokenFile) throw new Error("Console OAuth requires the default channel-private token store; custom tokenFile is not supported.");
    return new FileConnectorOAuthProvider({ connectorName: target.connectorName, channelRoot: target.channelRoot, oauth: target.oauth });
  }
  /** A web visitor requests pairing only. State/PKCE/consent cannot exist until Slack authenticates the approver. */
  async startBrowser(channelId: string, connectorName: string): Promise<{ browser: string; phrase: string }> {
    this.sweep();
    const resolved = this.hooks.browserTarget?.(channelId, connectorName);
    if (!resolved || !this.hooks.webPairing || resolved.channelId !== channelId || resolved.connectorName !== connectorName) throw invalid();
    const target = structuredClone(resolved);
    const file = this.file(target);
    this.checkCapacity(target);
    const browser = opaque();
    const request: WebRequest = { id: opaque(), phrase: randomBytes(5).toString("hex").toUpperCase(), target,
      browserHash: digest(browser), revision: file.credentialRevision(), expiresAt: this.now() + this.ttlSeconds * 1000 };
    // Reserve before awaiting Slack to serialize web/Slack races for the credential scope.
    this.webRequests.set(request.id, request);
    try {
      request.threadTs = await this.hooks.webPairing(request);
      if (!request.threadTs || this.closed || this.webRequests.get(request.id) !== request || this.now() >= request.expiresAt) {
        this.reportWeb(request, "Browser pairing expired or was cancelled before delivery. Start again from the channel page.");
        throw invalid();
      }
      return { browser, phrase: request.phrase };
    } catch {
      this.finishWeb(request, "Could not deliver the browser pairing prompt. Start again from the channel page.");
      throw invalid();
    }
  }
  sweep(): void {
    for (const request of this.webRequests.values()) {
      if (this.now() >= request.expiresAt) this.finishWeb(request, "Browser pairing expired. Start again from the channel page.");
    }
    for (const flight of this.flights.values()) {
      if (this.now() >= flight.expiresAt) this.finish(flight, "Authorization expired. Run `!connector-auth connect` again with the connector name.");
    }
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const request of this.webRequests.values()) this.finishWeb(request, "Browser pairing cancelled because the harness stopped.");
    for (const flight of this.flights.values()) this.finish(flight, "Authorization cancelled because the harness stopped. Start again after restart.");
  }
  start(target: ConsoleOAuthTarget): string {
    target = structuredClone(target);
    this.sweep();
    if (this.closed || !target.userId || !/^[A-Za-z0-9._-]+$/.test(target.connectorName) || !target.oauth.consoleCallback || target.oauth.redirectUrl !== this.callbackUrl
      || !this.hooks.allowed(target)) throw new Error("Console OAuth is not enabled for this connector with the exact configured callback.");
    // Credentials are channel/connector scoped, not per-user. Serialize consent for that scope.
    this.checkCapacity(target);
    const file = this.file(target);
    const id = opaque(); const link = opaque();
    const flight: Flight = { id, target: structuredClone(target), expiresAt: this.now() + this.ttlSeconds * 1000,
      linkHash: digest(link), phase: "link", state: opaque(), revision: file.credentialRevision(),
      provider: undefined!, controller: new AbortController() };
    flight.provider = new PendingProvider(file, flight.state, () => this.check(flight));
    this.flights.set(id, flight);
    // Fragment never reaches listener/proxy logs. Slack receives this privately, with unfurls disabled.
    return `${this.origin}${this.prefix}/connect#${link}`;
  }
  cancelUnclaimed(target: Pick<ConsoleOAuthTarget, "channelId" | "connectorName" | "userId">): void {
    const flight = [...this.flights.values()].find((f) => f.phase === "link" && f.target.userId === target.userId
      && f.target.channelId === target.channelId && f.target.connectorName === target.connectorName);
    if (flight) this.finish(flight, "Private connect link delivery failed. Start again.");
  }
  async claim(link: string): Promise<{ browser: string; phrase: string }> {
    this.sweep();
    const flight = [...this.flights.values()].find((f) => f.linkHash === digest(link) && f.phase === "link");
    if (!flight) throw invalid();
    this.check(flight);
    const browser = opaque();
    delete flight.linkHash;
    flight.browserHash = digest(browser);
    flight.phrase = randomBytes(5).toString("hex").toUpperCase();
    flight.phase = "pairing";
    try {
      await this.hooks.pairing({ id: flight.id, phrase: flight.phrase, target: flight.target });
      this.check(flight);
      return { browser, phrase: flight.phrase };
    } catch {
      this.finish(flight, "Could not pair the browser with Slack. Start a new authorization.");
      throw invalid();
    }
  }
  decide(id: string, userId: string, channelId: string, approve: boolean): boolean {
    this.sweep();
    const request = this.webRequests.get(id);
    if (request) {
      if (!userId || channelId !== request.target.channelId || !request.threadTs) return false;
      const target: ConsoleOAuthTarget = { ...request.target, userId, threadTs: request.threadTs };
      // The first allowed clicker confirming their own browser becomes the initiator.
      // Proxy identity and browser-supplied user IDs are never consulted.
      if (!this.hooks.allowed(target)) return false;
      if (!approve) { this.finishWeb(request, "Browser pairing denied or cancelled. Start again when ready."); return true; }
      try {
        const file = this.file(target);
        const promoted: Flight = { id, target, expiresAt: request.expiresAt, browserHash: request.browserHash,
          phrase: request.phrase, phase: "approved", state: opaque(), revision: request.revision,
          provider: undefined!, controller: new AbortController() };
        promoted.provider = new PendingProvider(file, promoted.state, () => this.check(promoted));
        this.webRequests.delete(id);
        this.flights.set(id, promoted);
        return true;
      } catch { this.finishWeb(request, "Could not authorize browser pairing. Ask an operator to check callback registration; start again."); return false; }
    }
    const flight = this.flights.get(id);
    if (!flight || userId !== flight.target.userId || channelId !== flight.target.channelId) return false;
    // Cancellation is allowed throughout consent and exchange, including after approval.
    // Removing/aborting first prevents an ignored fetch/late SDK response from committing.
    if (!approve) { this.finish(flight, "Browser pairing denied or cancelled. No local credentials were saved by this flight; provider-side grants were not revoked."); return true; }
    if (flight.phase !== "pairing") return false;
    try { this.check(flight); } catch { this.finish(flight, "Authorization is no longer enabled. Start again after configuration is corrected."); return false; }
    flight.phase = "approved";
    return true;
  }
  private browserFlight(browser: string): Flight {
    this.sweep();
    const flight = [...this.flights.values()].find((f) => f.browserHash === digest(browser));
    if (!flight) throw invalid();
    this.check(flight);
    return flight;
  }
  async poll(browser: string): Promise<{ status: "waiting" | "opening"; authorizationUrl?: string }> {
    this.sweep();
    // Unauthenticated web requests have neither OAuth state nor a provider yet.
    if ([...this.webRequests.values()].some((r) => r.browserHash === digest(browser))) return { status: "waiting" };
    const flight = this.browserFlight(browser);
    if (flight.phase === "pairing") return { status: "waiting" };
    if (flight.phase !== "approved") throw invalid();
    // Consume Slack approval before starting async discovery. Poll/consent cannot race or replay.
    flight.phase = "preparing";
    try {
      const result = await this.authorize(flight);
      this.check(flight);
      if (result !== "REDIRECT" || !flight.provider.authorizationUrl) throw invalid();
      flight.phase = "consent";
      return { status: "opening", authorizationUrl: flight.provider.authorizationUrl.toString() };
    } catch {
      this.finish(flight, "Could not start provider consent. Check callback registration, PKCE support, and client configuration; then start again.");
      throw invalid();
    }
  }
  private async authorize(flight: Flight, code?: string) {
    const signal = flight.controller.signal;
    // Overall bounded network wait, and a provider guard prevents late writes after abort/expiry.
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(60_000, flight.expiresAt - this.now())));
    const combined = AbortSignal.any([signal, timeout]);
    const operation = (this.hooks.authorize ?? auth)(flight.provider, {
      serverUrl: flight.target.connectorUrl,
      scope: flight.target.oauth.scope,
      resourceMetadataUrl: flight.target.oauth.resourceMetadataUrl ? new URL(flight.target.oauth.resourceMetadataUrl) : undefined,
      ...(code ? { authorizationCode: code } : {}),
      fetchFn: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([combined, init.signal]) : combined, redirect: "error" }),
    });
    // Even an SDK/test implementation ignoring fetch cancellation cannot hold a flight open.
    return new Promise<Awaited<ReturnType<typeof auth>>>((resolve, reject) => {
      const aborted = () => { flight.controller.abort(); reject(invalid()); };
      combined.addEventListener("abort", aborted, { once: true });
      operation.then(resolve, reject).finally(() => combined.removeEventListener("abort", aborted)).catch(() => {});
      if (combined.aborted) aborted();
    });
  }
  /** Validate browser + state first. Unknown visitors do not consume another user's state. */
  callback(browser: string, query: URLSearchParams): boolean {
    let flight: Flight;
    try { flight = this.browserFlight(browser); } catch { return false; }
    if (flight.phase !== "consent" || query.getAll("state").length !== 1 || digest(query.get("state") ?? "") !== digest(flight.state)) return false;
    // Consume before any await, including denied/malformed responses. The URI is immutable server config.
    flight.phase = "exchanging";
    const code = query.get("code"); const error = query.get("error"); const issuer = query.get("iss");
    const malformed = query.getAll("code").length > 1 || query.getAll("error").length > 1 || query.getAll("iss").length > 1
      || (issuer !== null && issuer !== flight.provider.issuer()) || !code || code.length > 8192 || error !== null;
    if (malformed) {
      this.finish(flight, error !== null ? "Authorization denied or cancelled by the provider. Start again when ready." : "Invalid provider response. Start a new authorization.");
      return true;
    }
    void this.exchange(flight, code);
    return true;
  }
  private async exchange(flight: Flight, code: string) {
    try {
      const result = await this.authorize(flight, code);
      this.check(flight);
      if (result !== "AUTHORIZED") throw invalid();
      flight.provider.commit(flight.revision);
      this.finish(flight, "Authorization complete. Credentials saved for this channel's connector. Retry your request; existing connector sessions may need `!reset`.");
    } catch {
      this.finish(flight, "Authorization could not be saved. The session may have expired, permissions or credentials changed, or the provider rejected exchange. Start again; ask an operator to check registration if it persists.");
    }
  }
}
