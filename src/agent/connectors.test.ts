import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConnectors } from "./connectors.ts";
import { createSaveToolOutputTool } from "./tool-output.ts";
import { FileConnectorOAuthProvider } from "./connectorOAuth.ts";
import { oauthTestDiscovery } from "./connectorOAuth-fixture.ts";
import type { EnabledConnector } from "../workspace/resolve.ts";

function tempRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "connectors-")));
}

test("stdio connectors start in the invoking channel workspace", async () => {
  const root = tempRoot();
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const serverPath = join(root, "cwd-server.mjs");

  writeFileSync(
    serverPath,
    `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(new URL("../../package.json", import.meta.url).href)});
const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { StdioServerTransport } = await import(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"));

const server = new McpServer({ name: "cwd-test", version: "1.0.0" });
server.registerTool("cwd", { description: "Return cwd", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: process.cwd() }],
}));
await server.connect(new StdioServerTransport());
`,
  );

  const connector: EnabledConnector = {
    name: "local",
    origin: "channel",
    config: {
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: {},
    },
  };

  const session = await openConnectors([connector], "C123", {}, root, workspace);
  try {
    assert.deepEqual(session.failures, []);
    const tool = session.tools.find((t) => t.name === "local__cwd");
    assert.ok(tool, "cwd tool should be exposed");
    const result = await tool.execute(
      "call-1",
      {},
      undefined as never,
      undefined as never,
      undefined as never,
    );
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, realpathSync(workspace));
  } finally {
    await session.close();
  }
});


test("connector saves retain raw MCP text, structured/non-text content, pagination and errors", async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const serverPath = join(root, "export-server.mjs");
  const raw = {
    content: [
      { type: "text", text: "Exact 原文\n" + "x".repeat(100_000) },
      { type: "image", data: "AAEC", mimeType: "image/png" },
      { type: "audio", data: "AQID", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "test://file", text: "embedded text" } },
      { type: "resource_link", uri: "test://remote", name: "remote" },
    ],
    structuredContent: { rows: [{ balance: 123 }], nextCursor: "page-2" },
    _meta: { truncated: true },
  };
  writeFileSync(serverPath, `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(new URL("../../package.json", import.meta.url).href)});
const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { StdioServerTransport } = await import(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"));
const server = new McpServer({ name: "export-test", version: "1.0.0" });
server.registerTool("export", { inputSchema: {} }, async () => (${JSON.stringify(raw)}));
server.registerTool("failed", { inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "denied" }], _meta: { reason: "not authorized" } }));
server.registerTool("hidden", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "never callable" }] }));
await server.connect(new StdioServerTransport());
`);
  const session = await openConnectors([{ name: "local", origin: "channel", config: {
    transport: "stdio", command: process.execPath, args: [serverPath], env: {}, allowTools: ["export", "failed"],
  } }], "C123", {}, root, workspace);
  t.after(() => session.close());
  assert.deepEqual(session.failures, []);
  const save = createSaveToolOutputTool({ tools: session.tools, jail: { cwd: workspace, readRoots: [workspace], writeRoots: [workspace] } });
  const invoke = (name: string, path: string) => save.execute("call-export", { tool: name, arguments: {}, path }, undefined, undefined, {} as never);
  const result = await invoke("local__export", "export.json");
  assert.ok(!result.isError);
  const saved = JSON.parse(readFileSync(join(workspace, "export.json"), "utf8"));
  assert.equal(saved.representation, "mcp");
  assert.deepEqual(saved.result, raw);
  assert.equal(saved.completeness.status, "reported_incomplete");
  assert.ok(!JSON.stringify(result).includes("Exact 原文"));
  const failed = await invoke("local__failed", "error.json");
  assert.equal(failed.isError, true);
  const receipt = JSON.parse((failed.content[0] as { text: string }).text);
  assert.equal(receipt.saved, true);
  assert.equal(receipt.toolSucceeded, false);
  const savedError = JSON.parse(readFileSync(join(workspace, "error.json"), "utf8"));
  assert.equal(savedError.result.isError, true);
  assert.equal(savedError.result._meta.reason, "not authorized");
  const hidden = await invoke("local__hidden", "hidden.json");
  assert.equal(hidden.isError, true);
  assert.equal(JSON.parse((hidden.content[0] as { text: string }).text).toolExecuted, false);
});

test("Gmail attachment downloads expose a staged PDF text path", async () => {
  const root = tempRoot();
  const workspace = join(root, "workspace");
  const attachmentDir = join(workspace, "attachments");
  mkdirSync(attachmentDir, { recursive: true });
  const serverPath = join(root, "gmail-download-server.mjs");
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Length 47 >>\nstream\nBT (The paid amount is 42 dollars today.) Tj ET\nendstream\nendobj\ntrailer\n%%EOF\n",
    "latin1",
  ).toString("base64");

  writeFileSync(
    serverPath,
    `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(new URL("../../package.json", import.meta.url).href)});
const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { StdioServerTransport } = await import(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"));
const server = new McpServer({ name: "gmail-download-test", version: "1.0.0" });
server.registerTool("gmail_download_attachment", { description: "Download an attachment", inputSchema: {} }, async () => {
  mkdirSync(process.env.WORKSPACE_ATTACHMENT_DIR, { recursive: true });
  writeFileSync(join(process.env.WORKSPACE_ATTACHMENT_DIR, "receipt.pdf"), Buffer.from(${JSON.stringify(pdf)}, "base64"));
  return { content: [{ type: "text", text: "Saved receipt.pdf" }] };
});
await server.connect(new StdioServerTransport());
`,
  );

  const connector: EnabledConnector = {
    name: "google_workspace",
    origin: "channel",
    config: {
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
      env: { WORKSPACE_ATTACHMENT_DIR: attachmentDir },
    },
  };

  const session = await openConnectors([connector], "C123", {}, root, workspace, attachmentDir);
  try {
    assert.deepEqual(session.failures, []);
    const tool = session.tools.find((t) => t.name === "google_workspace__gmail_download_attachment");
    assert.ok(tool);
    const result = await tool.execute("call-1", {}, undefined as never, undefined as never, undefined as never);
    assert.equal(result.content[0]?.type, "text");
    assert.match(result.content[0]?.text ?? "", /PDF text extracted to `attachments\/receipt\.pdf\.txt`/);
    assert.match(readFileSync(join(attachmentDir, "receipt.pdf.txt"), "utf8"), /paid amount is 42 dollars/i);
  } finally {
    await session.close();
  }
});

for (const consoleCallback of [true, false]) {
  for (const scope of ["mcp:read", undefined]) {
    test(`runtime ${consoleCallback ? "console" : "legacy"} auth-required guidance routes correctly (${scope ? "scoped" : "SDK default"})`, async (t) => {
      const root = tempRoot();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const oauth = { consoleCallback, clientId: "synthetic-client", manualCompletionTtlSeconds: 600, scope,
        redirectUrl: consoleCallback ? "https://console.example.org/harness/oauth/callback" : "https://completion.example.org/" };
      new FileConnectorOAuthProvider({ connectorName: "calendar", channelRoot: root, oauth }).saveDiscoveryState(oauthTestDiscovery);
      const originalFetch = globalThis.fetch;
      const originalError = console.error;
      const logged: string[] = [];
      let requests = 0;
      console.error = (...args) => { logged.push(args.join(" ")); };
      globalThis.fetch = async (url) => {
        assert.equal(String(url), "https://mcp.example.org/mcp", "no provider/network requests allowed");
        requests++;
        return new Response(null, { status: 401 });
      };
      t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });
      const session = await openConnectors([{ name: "calendar", origin: "channel", config: {
        transport: "http", url: "https://mcp.example.org/mcp", headers: {}, oauth,
      } }], "C123", {}, root, root);
      t.after(() => session.close());
      assert.ok(requests > 0);
      assert.equal(session.failures.length, 1);
      const failure = session.failures[0]!.error;
      const output = logged.join("\n");
      if (consoleCallback) {
        assert.match(failure, /!connector-auth connect/);
        assert.match(output, /!connector-auth connect/);
        assert.doesNotMatch(failure + output, /npm run connector-auth/);
      } else {
        assert.match(failure, /npm run connector-auth -- C123 calendar/);
        assert.match(output, /npm run connector-auth -- C123 calendar/);
        assert.doesNotMatch(failure + output, /!connector-auth connect/);
      }
      assert.doesNotMatch(output, /https:\/\/login|state=|code_challenge=/);
    });
  }
}
