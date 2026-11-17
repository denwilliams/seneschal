import { auth, extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HttpConnectorOAuthConfig } from "../config/schema.ts";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";

const authFailure = (consoleCallback?: boolean) => new Error(consoleCallback
  ? "Connector OAuth authentication failed; use !connector-auth connect in this Slack channel or Connect on its channel web page to authorize again."
  : "Connector OAuth authentication failed; run connector-auth to authorize again.");
// Abort reasons can contain user/provider data; do not forward signal.reason.
const abortFailure = () => new DOMException("Connector OAuth operation canceled.", "AbortError");
function checkAbort(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortFailure();
}

/** Observe cancellation even when a custom fetch ignores the supplied signal. */
function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(abortFailure()); };
    signal.addEventListener("abort", aborted, { once: true });
    // Always observe the promise, including late failures after cancellation.
    promise.then((value) => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) reject(abortFailure()); else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", aborted);
      reject(signal.aborted ? abortFailure() : error);
    });
    if (signal.aborted) aborted();
  });
}

async function discardResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Never log private response/cancel errors. */ }
}

interface AuthFlight {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
}

/**
 * The SDK transport has no scope override: it prefers challenges/advertised
 * scopes to clientMetadata.scope. For explicitly scoped connectors, perform
 * OAuth here and give the transport no authProvider, so it cannot upscope.
 * OAuth discovery/token requests use the bare fetch, never MCP headers/tokens.
 */
export function createScopedConnectorOAuthFetch(options: {
  provider: FileConnectorOAuthProvider;
  connectorUrl: string;
  oauth: HttpConnectorOAuthConfig;
  fetch?: FetchLike;
  authorize?: typeof auth;
}): FetchLike {
  const fetchFn = options.fetch ?? fetch;
  const endpoint = new URL(options.connectorUrl).href;
  let pendingAuth: AuthFlight | undefined;

  function startAuth(resourceMetadataUrl?: URL): AuthFlight {
    const controller = new AbortController();
    const signal = controller.signal;
    let createdState: string | undefined;
    // The SDK can catch an aborted refresh and continue toward consent. Guard
    // every provider access as well as fetch, preventing any post-abort writes.
    const guardedProvider = new Proxy(options.provider, {
      get(target, property) {
        checkAbort(signal);
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          checkAbort(signal);
          const result: unknown = Reflect.apply(value, target, args);
          if (property === "state") createdState = result as string;
          checkAbort(signal);
          return result;
        };
      },
    });
    const oauthFetch: FetchLike = (url, init) => {
      checkAbort(signal);
      const combinedSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
      const response = fetchFn(url, { ...init, signal: combinedSignal }).then(async (response) => {
        if (combinedSignal.aborted) { await discardResponse(response); throw abortFailure(); }
        return response;
      });
      return waitWithAbort(response, combinedSignal);
    };
    const flight: AuthFlight = { controller, waiters: 0, settled: false, promise: undefined! };
    // Defer start until the first waiter has registered, even for sync test hooks.
    flight.promise = Promise.resolve().then(async () => {
      try {
        checkAbort(signal);
        const result = await (options.authorize ?? auth)(guardedProvider, {
          serverUrl: options.connectorUrl,
          scope: options.oauth.scope,
          resourceMetadataUrl: options.oauth.resourceMetadataUrl
            ? new URL(options.oauth.resourceMetadataUrl) : resourceMetadataUrl,
          fetchFn: oauthFetch,
        });
        checkAbort(signal);
        if (result !== "AUTHORIZED") throw new UnauthorizedError();
      } catch (error) {
        if (signal.aborted) throw abortFailure();
        if (error instanceof UnauthorizedError) throw new UnauthorizedError();
        throw authFailure(options.oauth.consoleCallback);
      } finally {
        // Only discard this flight's pending state, never a newer manual flow.
        try {
          if (signal.aborted && createdState) options.provider.cancelAuthorizationSession(createdState);
        } catch {
          throw authFailure(options.oauth.consoleCallback);
        } finally {
          flight.settled = true;
          if (pendingAuth === flight) pendingAuth = undefined;
        }
      }
    });
    pendingAuth = flight;
    return flight;
  }

  async function joinAuth(flight: AuthFlight, signal?: AbortSignal | null): Promise<void> {
    checkAbort(signal);
    flight.waiters++;
    try { await waitWithAbort(flight.promise, signal); } finally {
      if (--flight.waiters === 0 && !flight.settled) {
        // A canceled waiter must not terminate OAuth for surviving callers.
        flight.controller.abort();
        if (pendingAuth === flight) pendingAuth = undefined;
      }
    }
  }

  return async (url, init) => {
    checkAbort(init?.signal);
    // Never attach the connector's bearer token to discovery or redirected URLs.
    if (new URL(url).href !== endpoint) return fetchFn(url, init);
    const request = async () => {
      checkAbort(init?.signal);
      const headers = new Headers(init?.headers);
      const tokens = options.provider.tokens();
      if (tokens && !headers.has("authorization")) headers.set("authorization", `Bearer ${tokens.access_token}`);
      const response = await fetchFn(url, { ...init, headers });
      if (init?.signal?.aborted) { await discardResponse(response); throw abortFailure(); }
      return response;
    };
    const response = await request();
    const challenge = extractWWWAuthenticateParams(response);
    if (response.status !== 401 && !(response.status === 403 && challenge.error === "insufficient_scope")) return response;
    await discardResponse(response);
    checkAbort(init?.signal);
    const flight = pendingAuth ?? startAuth(challenge.resourceMetadataUrl);
    await joinAuth(flight, init?.signal);
    // One retry only; never let the SDK's generic error path read a private
    // second rejection body when authProvider is deliberately disabled.
    const retried = await request();
    if (retried.status === 401 || retried.status === 403) {
      await discardResponse(retried);
      throw authFailure(options.oauth.consoleCallback);
    }
    return retried;
  };
}
