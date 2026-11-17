import http from "node:http";
import { loadConfig, REPO_ROOT } from "../config/load.ts";
import { initializeOpenBao, OpenBaoError } from "../config/openbao.ts";
import { ensureSharedDirs } from "../workspace/paths.ts";
import { KeychainError, validateKeychainHost } from "../config/keychain.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import {
  completeManualConnectorOAuth,
  encodeManualAuthorizationPayload,
  manualAuthorizationErrorMessage,
  startManualConnectorOAuth,
  resetManualConnectorOAuth,
} from "../agent/manualConnectorOAuth.ts";
import { parseConnectorAuthArgs } from "./connector-auth-args.ts";

function usage(exitCode = 2): never {
  console.error(`Usage: npm run connector-auth -- [--config config/harness.yaml] [--result PAYLOAD | --reset] [--no-wait] <channel> <connector>

Starts or completes manual/localhost OAuth for a configured HTTP MCP connector in one channel.
For consoleCallback connectors, use Slack !connector-auth connect or the channel web page; CLI only supports --reset.
For a static completion page, start auth, then pass its copied payload with --result.
--reset clears only this connector's local OAuth state and exits (no server revocation).
It discards the cached client, tokens, discovery and pending PKCE/state; then rerun auth.

Examples:
  npm run connector-auth -- admin google-calendar
  npm run connector-auth -- --result oauth-result-v1.… admin google-calendar`);
  process.exit(exitCode);
}

function isSlackId(value: string): boolean {
  return /^[CDG][A-Z0-9]{2,}$/.test(value);
}

function canListenFor(url: URL): boolean {
  return url.protocol === "http:" && !!url.port && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

async function waitForLocalCallback(redirectUrl: URL): Promise<{ code?: string; state?: string; error?: string }> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const received = new URL(req.url ?? "/", redirectUrl.origin);
      if (received.pathname !== redirectUrl.pathname) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const code = received.searchParams.get("code") ?? undefined;
      const state = received.searchParams.get("state") ?? undefined;
      const error = received.searchParams.get("error") ?? undefined;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      if (code && state) {
        res.end("Authorization received. You can close this tab and return to the terminal.\n");
      } else {
        res.statusCode = 400;
        res.end("Authorization was not completed. Return to the terminal and start again.\n");
      }
      server.close(() => resolve({ code, state, error }));
    });
    server.once("error", reject);
    server.listen(Number(redirectUrl.port), redirectUrl.hostname, () => {
      console.error(`Waiting for OAuth callback on ${redirectUrl.toString()}`);
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) usage(0);
  let args;
  try { args = parseConnectorAuthArgs(process.argv.slice(2)); } catch { usage(); }
  const channelKeyRaw = args.positional[0]!;
  const connectorName = args.positional[1]!;
  const channelKey = channelKeyRaw.startsWith("#") ? channelKeyRaw.slice(1) : channelKeyRaw;

  const { config, dataDir } = loadConfig(args.config);
  ensureSharedDirs(dataDir);
  validateKeychainHost(config, dataDir);
  await initializeOpenBao(config, { forbiddenRoots: [dataDir, REPO_ROOT] });
  const registry = new ChannelRegistry(dataDir);
  const channelId = registry.resolveId(channelKey);
  if (!channelId) throw new Error(`Unknown channel "${channelKeyRaw}". Use a Slack channel ID, or a name the harness has seen.`);
  const channelName = registry.nameFor(channelId) ?? (isSlackId(channelKey) ? undefined : channelKey);
  const resolved = resolveChannel(config, dataDir, { id: channelId, name: channelName, isDm: channelId.startsWith("D") }, registry);
  if (!resolved.channel) throw new Error(resolved.rejected ?? `Could not resolve channel ${channelKeyRaw}`);

  const connector = resolved.channel.connectors.find((c) => c.name === connectorName);
  if (!connector) throw new Error(`Connector "${connectorName}" is not enabled in ${channelName ?? channelId}.`);
  if (connector.config.transport !== "http") throw new Error(`Connector "${connectorName}" is not an HTTP connector.`);
  if (!connector.config.oauth) throw new Error(`Connector "${connectorName}" has no oauth config.`);
  const options = {
    connectorName,
    channelRoot: resolved.channel.paths.root,
    connectorUrl: connector.config.url,
    oauth: connector.config.oauth,
  };

  try {
    if (args.reset) {
      resetManualConnectorOAuth(options);
      console.error(`Local OAuth state cleared for ${channelName ?? channelId}/${connectorName}. Server grants were not revoked. ${connector.config.oauth.consoleCallback
        ? "Use !connector-auth connect in that Slack channel, or its web page Connect action, to authorize again." : "Rerun connector-auth to authorize again."}`);
      return;
    }
    if (connector.config.oauth.consoleCallback) {
      console.error("This connector uses the browser-paired console callback. CLI manual start/result is not supported. Use !connector-auth connect in the enabled Slack channel, or Connect on its web page. Operator --reset remains supported.");
      process.exitCode = 1;
      return;
    }
    if (args.result) {
      await completeManualConnectorOAuth({ ...options, payload: args.result });
      console.error(`OAuth tokens saved for ${channelName ?? channelId}/${connectorName}.`);
      return;
    }

    const started = await startManualConnectorOAuth(options);
    if (started.status === "authorized") {
      console.error(`${connectorName} is already authorized for ${channelName ?? channelId}.`);
      return;
    }
    console.error("Open this URL to authorize the connector:");
    console.error(started.authorizationUrl!.toString());

    const redirectUrl = new URL(connector.config.oauth.redirectUrl);
    if (args.noWait || !canListenFor(redirectUrl)) {
      console.error("After approving, copy the completion-page payload and rerun with --result PAYLOAD.");
      return;
    }
    const callback = await waitForLocalCallback(redirectUrl);
    const payload = encodeManualAuthorizationPayload({
      state: callback.state ?? "",
      ...(callback.code ? { code: callback.code } : { error: callback.error ?? "authorization_failed" }),
    });
    await completeManualConnectorOAuth({ ...options, payload });
    console.error(`OAuth tokens saved for ${channelName ?? channelId}/${connectorName}.`);
  } catch (error) {
    // The copied payload and provider response must never reach terminal logs.
    console.error(manualAuthorizationErrorMessage(error));
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof KeychainError || error instanceof OpenBaoError ? error.message : "Connector authorization setup failed; check channel and connector configuration on the host.");
  process.exitCode = 1;
});
