import { describe, expect, it } from "vitest";
import { MCP_TRANSPORTS } from "@root/types/DashboardConstants";
import type { McpServerConfig } from "@root/types/CtrlYokeTypes";
import {
  getMcpServerDetailRows,
  getMcpServerSummary,
} from "@utils/mcpServerDisplay";

describe("mcpServerDisplay", () => {
  describe("getMcpServerDetailRows", () => {
    it("formats all server details", () => {
      const config: McpServerConfig = {
        id: "example",
        command: "node",
        args: ["server.js", "--quiet"],
        url: "https://example.test/mcp",
        transport: MCP_TRANSPORTS.SSE,
        env: { TOKEN: "secret", MODE: "test" },
        headers: { Authorization: "secret" },
        autoApprove: ["read", "list"],
      };

      expect(getMcpServerDetailRows(config)).toEqual([
        { label: "id", value: "example" },
        { label: "command", value: "node" },
        { label: "args", value: "server.js --quiet" },
        { label: "url", value: "https://example.test/mcp" },
        { label: "transport", value: MCP_TRANSPORTS.SSE },
        { label: "env", value: "TOKEN, MODE" },
        { label: "headers", value: "Authorization" },
        { label: "autoApprove", value: "read, list" },
      ]);
    });

    it("hides default streamable-http and formats boolean auto-approval", () => {
      expect(
        getMcpServerDetailRows({
          id: "remote",
          url: "https://example.test/mcp",
          transport: MCP_TRANSPORTS.STREAMABLE_HTTP,
          autoApprove: false,
        })
      ).toEqual([
        { label: "id", value: "remote" },
        { label: "command", value: null },
        { label: "args", value: null },
        { label: "url", value: "https://example.test/mcp" },
        { label: "transport", value: null },
        { label: "env", value: null },
        { label: "headers", value: null },
        { label: "autoApprove", value: "false" },
      ]);
    });
  });

  describe("getMcpServerSummary", () => {
    it("prefers a URL", () => {
      expect(
        getMcpServerSummary({ id: "remote", url: "https://example.test/mcp" })
      ).toBe("https://example.test/mcp");
    });

    it("joins a command and its arguments", () => {
      expect(
        getMcpServerSummary({ id: "local", command: "node", args: ["mcp.js"] })
      ).toBe("node mcp.js");
    });

    it("returns a command without adding an empty argument suffix", () => {
      expect(getMcpServerSummary({ id: "local", command: "node" })).toBe(
        "node"
      );
    });

    it("returns undefined when the server has no URL or command", () => {
      expect(getMcpServerSummary({ id: "stored" })).toBeUndefined();
      expect(
        getMcpServerSummary({ id: "args-only", args: ["--flag"] })
      ).toBeUndefined();
    });
  });
});
