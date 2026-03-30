/**
 * Test MCP Server
 *
 * A minimal MCP server with a single tool `test_mcp` that returns "passed".
 * Use this to verify MCP server attachment is working in FlightPath workflows.
 *
 * Usage (mcpServers in workflow):
 *   mcpServers:
 *     - id: test-mcp
 *       command: node
 *       args: [".flightpath/scripts/test-mcp-server.js"]
 */

"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const server = new McpServer({ name: "test-mcp", version: "1.0.0" });

server.tool(
  "test_mcp",
  "Test tool that confirms MCP server attachment is working.",
  {},
  async () => ({
    content: [{ type: "text", text: "passed" }],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`test-mcp-server error: ${err}\n`);
  process.exit(1);
});
