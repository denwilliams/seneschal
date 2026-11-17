// Synthetic MCP server for lifecycle tests and the bounded memory investigation.
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
const server = new Server({ name: "memory-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => {
  if (process.env.FIXTURE_FAIL_LIST === "1") throw new McpError(ErrorCode.InternalError, "synthetic discovery failure");
  return { tools: [{ name: "payload", description: "Synthetic 64 KiB output", inputSchema: { type: "object", properties: {} } }] };
});
server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "x".repeat(65536) }] }));
await server.connect(new StdioServerTransport());
