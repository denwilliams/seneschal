import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { relative, resolve } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EnabledConnector } from "../workspace/resolve.ts";
import { logger } from "../util/log.ts";
import { createScopedConnectorOAuthFetch } from "./scopedConnectorOAuth.ts";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";
import { withToolOutputSource } from "./tool-output.ts";
import { changedAttachmentPdfs, extractLocalPdf, snapshotAttachmentPdfs, type LocalPdfContext } from "./local-pdf.ts";

/**
 * Connectors are MCP servers. The account config holds a catalogue of them;
 * a channel only gets the ones its config names. Each thread/subagent tool set opens
 * its own clients, so a stdio connector can have several concurrent processes in one
 * channel. There is no cross-channel session, cache, environment or credential sharing.
 */

export type ConnectorOwner = "thread" | "subagent" | "template" | "recovery" | "unspecified";
let instanceSequence = 0;
let ownedInstances = 0;

/** Scalar counters and per-owner events only; never retain clients, credentials, arguments, outputs or a history. */
function connectorTrace(entry: EnabledConnector, channelId: string, owner: ConnectorOwner) {
  const instanceId = ++instanceSequence;
  ownedInstances++;
  let finished = false;
  let pid: number | undefined;
  const event = (phase: "opening" | "ready" | "failed" | "closed", cleanupFailed = false) => {
    if (finished) return;
    if (phase === "failed" || phase === "closed") { finished = true; ownedInstances--; }
    const interval = Number(process.env.HARNESS_MEMORY_SAMPLE_SECONDS);
    if (Number.isInteger(interval) && interval >= 1 && interval <= 3600) logger.info(JSON.stringify({
      kind: "harness.connector", pid: process.pid, uptimeSeconds: process.uptime(),
      phase, instanceId, channelId, connector: entry.name,
      transport: entry.config.transport, owner, ...(pid ? { processPid: pid } : {}),
      instanceAttemptsStarted: instanceSequence, instancesOwned: ownedInstances, cleanupFailed,
    }));
  };
  event("opening");
  return { event, process: (client: Client) => {
    if (client.transport instanceof StdioClientTransport) pid = client.transport.pid ?? undefined;
  } };
}

export interface ConnectorSession {
  close(): Promise<void>;
  tools: ToolDefinition[];
  failures: { name: string; error: string }[];
}

function toolNameFor(connector: string, tool: string): string {
  // Namespaced so two connectors exposing "search" do not collide, and so the
  // model can see which system it is talking to.
  return `${connector}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

async function connect(
  entry: EnabledConnector,
  channelId: string,
  env: Record<string, string>,
  channelRoot: string,
  channelWorkspace: string,
): Promise<Client> {
  const client = new Client(
    { name: `seneschal/${channelId}`, version: "0.1.0" },
    { capabilities: {} },
  );

  if (entry.config.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: entry.config.command,
      args: entry.config.args,
      // The channel's bundle, not the raw process env: a stdio server started
      // for #engineering must not inherit #home's secrets.
      env: { ...env, ...entry.config.env },
      // Relative file paths used by the MCP server (for example export tools)
      // should resolve inside the invoking channel's workspace. The connector
      // itself is still a trusted host process, not a filesystem sandbox.
      cwd: channelWorkspace,
    });
    await client.connect(transport);
  } else {
    const oauth = entry.config.oauth;
    const authProvider = entry.config.oauth
      ? new FileConnectorOAuthProvider({
          connectorName: entry.name,
          channelRoot,
          oauth: entry.config.oauth,
          onAuthorizationUrl: (url) => {
            logger.warn(
              `OAuth authorization required for connector ${entry.name} in ${channelId}; ` +
                (oauth?.consoleCallback
                  ? "use !connector-auth connect in this Slack channel or Connect on its channel web page."
                  : `run npm run connector-auth -- ${channelId} ${entry.name}.`),
            );
          },
        })
      : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(entry.config.url), {
      requestInit: { headers: entry.config.headers },
      // Explicit scope is an operator permission boundary, not an SDK fallback.
      authProvider: entry.config.oauth?.scope ? undefined : authProvider,
      fetch: entry.config.oauth?.scope && authProvider
        ? createScopedConnectorOAuthFetch({ provider: authProvider, connectorUrl: entry.config.url, oauth: entry.config.oauth })
        : undefined,
    });
    try {
      await client.connect(transport);
    } catch (error) {
      if (authProvider && error instanceof UnauthorizedError) {
        throw new Error(
          entry.config.oauth?.consoleCallback
            ? "OAuth authorization required; use !connector-auth connect in this Slack channel or Connect on its channel web page, then retry (existing sessions may need !reset)."
            : `OAuth authorization required; run \`npm run connector-auth -- ${channelId} ${entry.name}\` and restart or retry.`,
        );
      }
      throw error;
    }
  }
  return client;
}

/** Convert an MCP JSON Schema into something typebox-shaped enough for pi. */
function asParameters(schema: unknown) {
  if (schema && typeof schema === "object" && (schema as any).type === "object") {
    return schema as any;
  }
  return Type.Object({});
}

export async function openConnectors(
  connectors: EnabledConnector[],
  channelId: string,
  env: Record<string, string>,
  channelRoot: string,
  channelWorkspace: string,
  attachmentDir?: string,
  owner: ConnectorOwner = "unspecified",
): Promise<ConnectorSession> {
  const clients: { client: Client; trace: ReturnType<typeof connectorTrace> }[] = [];
  const tools: ToolDefinition[] = [];
  const failures: { name: string; error: string }[] = [];

  for (const entry of connectors) {
    const trace = connectorTrace(entry, channelId, owner);
    let client: Client | undefined;
    try {
      client = await connect(entry, channelId, env, channelRoot, channelWorkspace);
      const connected = client;
      trace.process(connected);
      const listed = await connected.listTools();
      const connectorTools: ToolDefinition[] = [];
      // A connector may only opt into local PDF staging by being configured to
      // write to this exact, per-channel attachment directory. In particular,
      // a connector-provided path is never made into a filesystem capability.
      const configuredAttachmentDir =
        entry.config.transport === "stdio" ? entry.config.env.WORKSPACE_ATTACHMENT_DIR : undefined;
      const localPdf: LocalPdfContext | undefined =
        attachmentDir && configuredAttachmentDir && resolve(configuredAttachmentDir) === resolve(attachmentDir)
          ? { workspace: channelWorkspace, attachmentDir }
          : undefined;
      for (const tool of listed.tools) {
        if (entry.config.allowTools && !entry.config.allowTools.includes(tool.name)) continue;

        connectorTools.push(
          defineTool({
            name: toolNameFor(entry.name, tool.name),
            label: `${entry.name}: ${tool.name}`,
            description: tool.description ?? `${tool.name} via ${entry.name}`,
            parameters: asParameters(tool.inputSchema),
            execute: async (_id, params: Record<string, unknown>) => {
              // Gmail download tools normally save attachments under
              // WORKSPACE_ATTACHMENT_DIR. Take a bounded before/after snapshot
              // so their result can point the agent at text, not a raw PDF.
              const stagesPdf = Boolean(localPdf && /gmail|attachment/i.test(`${entry.name} ${tool.name}`));
              const before = stagesPdf && localPdf ? snapshotAttachmentPdfs(localPdf) : [];
              const result = await connected.callTool({
                name: tool.name,
                arguments: params ?? {},
              });
              const content = (result.content ?? []) as Array<Record<string, any>>;
              let text = content
                .filter((c) => c.type === "text")
                .map((c) => String(c.text))
                .join("\n");
              if (!result.isError && stagesPdf && localPdf) {
                const notes: string[] = [];
                for (const pdf of changedAttachmentPdfs(localPdf, before)) {
                  try {
                    const staged = await extractLocalPdf(localPdf, pdf.path);
                    const path = relative(channelWorkspace, staged.textPath) || staged.textPath;
                    notes.push(
                      staged.reused
                        ? `PDF text is already staged at \`${path}\`.`
                        : `PDF text extracted to \`${path}\` (${staged.extraction.text.length.toLocaleString()} characters). Read that text path rather than raw PDF bytes.`,
                    );
                  } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    notes.push(`Downloaded PDF ${pdf.path.split(/[\\/]/).pop()} could not be extracted: ${detail}`);
                  }
                }
                if (notes.length > 0) text = [text, ...notes].filter(Boolean).join("\n");
              }

              return withToolOutputSource({
                content: [{ type: "text" as const, text: text || (result.isError ? `${entry.name}.${tool.name} failed` : "(no output)") }],
                details: { connector: entry.name, tool: tool.name },
                ...(result.isError ? { isError: true } : {}),
              }, result);
            },
          }) as ToolDefinition,
        );
      }
      clients.push({ client: connected, trace });
      tools.push(...connectorTools);
      trace.event("ready");
      logger.info(
        `connector "${entry.name}" (${entry.origin}) ready for ${channelId}: ${listed.tools.length} tool(s)`,
      );
    } catch (err) {
      // Discovery failed, so no usable tools own this connection. Do not keep its server/process
      // alive for the entire warm session (or until a recovered channel store is retired).
      let cleanupFailed = false;
      await client?.close().catch(() => { cleanupFailed = true; });
      trace.event("failed", cleanupFailed);
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ name: entry.name, error });
      logger.warn(`connector "${entry.name}" failed for ${channelId}: ${error}`);
    }
  }

  return {
    tools,
    failures,
    close: async () => {
      await Promise.allSettled(clients.map(async ({ client, trace }) => {
        try { await client.close(); trace.event("closed"); }
        catch { trace.event("closed", true); }
      }));
    },
  };
}
