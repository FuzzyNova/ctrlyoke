import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@root/types/CtrlYokeTypes";
import {
  EMPTY_MCP_SERVER_FORM_STATE,
  mcpServerFormStateToServer,
  serverToMcpServerFormState,
} from "@components/shared/McpServerForm";

describe("McpServerForm round trips", () => {
  it("preserves remote headers, denied tools, and auto-approve allowlists", () => {
    const server: McpServerConfig = {
      id: "remote",
      description: "Remote server",
      url: "https://example.test/mcp",
      transport: "sse",
      headers: { Authorization: "Bearer token" },
      deniedTools: ["dangerous_tool"],
      autoApprove: ["tool_a"],
    };

    expect(
      mcpServerFormStateToServer(serverToMcpServerFormState(server))
    ).toEqual(server);
  });

  it("drops remote-only fields when switching to stdio", () => {
    const form = {
      ...serverToMcpServerFormState({
        id: "server",
        url: "https://example.test/mcp",
        transport: "sse",
        headers: { Authorization: "Bearer token" },
        deniedTools: ["dangerous_tool"],
        autoApprove: true,
      }),
      activeTab: "stdio" as const,
      command: "node",
      args: "server.js",
      env: "TOKEN=secret",
    };

    expect(mcpServerFormStateToServer(form)).toEqual({
      id: "server",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "secret" },
      deniedTools: ["dangerous_tool"],
      autoApprove: true,
    });
  });

  it("drops stdio-only fields when switching to remote", () => {
    const form = {
      ...serverToMcpServerFormState({
        id: "server",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret" },
        deniedTools: ["dangerous_tool"],
        autoApprove: true,
      }),
      activeTab: "remote" as const,
      url: "https://example.test/mcp",
      transport: "streamable-http" as const,
    };

    expect(mcpServerFormStateToServer(form)).toEqual({
      id: "server",
      url: "https://example.test/mcp",
      transport: "streamable-http",
      deniedTools: ["dangerous_tool"],
      autoApprove: true,
    });
  });

  it("builds a new server without an original config", () => {
    expect(
      mcpServerFormStateToServer({
        ...EMPTY_MCP_SERVER_FORM_STATE,
        id: "new-server",
        command: "npx",
        args: "-y example-server",
        env: "TOKEN=secret",
        autoApprove: true,
      })
    ).toEqual({
      id: "new-server",
      command: "npx",
      args: ["-y", "example-server"],
      env: { TOKEN: "secret" },
      autoApprove: true,
    });
  });
});
