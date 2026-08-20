import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { McpServerConfig } from "@root/types/CtrlYokeTypes";
import {
  EMPTY_MCP_SERVER_FORM_STATE,
  findLiteralCredentialEnvKeys,
  McpServerForm,
  mcpServerFormStateToServer,
  serverToMcpServerFormState,
} from "@components/shared/McpServerForm";
import { useSecretRegistryStore } from "@store/secretRegistryStore";

afterEach(() => {
  cleanup();
  useSecretRegistryStore.getState().resetSecretRegistry();
});

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

  it("persists headers authored in the remote form", () => {
    const form = {
      ...EMPTY_MCP_SERVER_FORM_STATE,
      id: "remote",
      activeTab: "remote" as const,
      url: "https://example.test/mcp",
      headers: { Authorization: "${secret:API_TOKEN}" },
    };

    expect(mcpServerFormStateToServer(form)).toEqual({
      id: "remote",
      url: "https://example.test/mcp",
      transport: "streamable-http",
      headers: { Authorization: "${secret:API_TOKEN}" },
    });
  });

  it("wires the shared editor to remote headers", () => {
    const onChange = vi.fn();
    render(
      createElement(McpServerForm, {
        value: {
          ...EMPTY_MCP_SERVER_FORM_STATE,
          id: "remote",
          activeTab: "remote",
          url: "https://example.test/mcp",
        },
        onChange,
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
        submitLabel: "Save",
      })
    );

    fireEvent.change(
      screen.getByLabelText("headers (KEY=VALUE, one per line)"),
      {
        target: { value: "Authorization=${secret:API_TOKEN}" },
      }
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: "${secret:API_TOKEN}" },
      })
    );
  });

  it.each([
    { autoApprove: true, expected: true },
    { autoApprove: ["tool_a", "tool_b"], expected: ["tool_a", "tool_b"] },
  ])("round-trips autoApprove $autoApprove", ({ autoApprove, expected }) => {
    const server: McpServerConfig = {
      id: "server",
      command: "node",
      autoApprove,
    };

    expect(
      mcpServerFormStateToServer(serverToMcpServerFormState(server))
    ).toEqual(server);
    expect(expected).toEqual(autoApprove);
  });

  it("does not flatten an existing auto-approve tool list when another field changes", () => {
    const form = serverToMcpServerFormState({
      id: "server",
      command: "node",
      autoApprove: ["tool_a", "tool_b"],
    });

    const updatedForm = { ...form, description: "Updated description" };

    expect(mcpServerFormStateToServer(updatedForm)).toEqual({
      id: "server",
      description: "Updated description",
      command: "node",
      autoApprove: ["tool_a", "tool_b"],
    });
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
      env: { TOKEN: "secret" },
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
        env: { TOKEN: "secret" },
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

  it("offers a picker that inserts a secret interpolation", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "API_TOKEN",
        scope: "workspace",
        state: "managed-and-set",
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    const onChange = vi.fn();
    render(
      createElement(McpServerForm, {
        value: {
          ...EMPTY_MCP_SERVER_FORM_STATE,
          id: "server",
          command: "node",
        },
        onChange,
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
        submitLabel: "Save",
      })
    );

    fireEvent.change(screen.getByLabelText("Insert secret reference"), {
      target: { value: "API_TOKEN" },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { API_TOKEN: "${secret:API_TOKEN}" },
      })
    );
  });

  it("warns when an env field looks like a pasted literal credential", () => {
    expect(
      findLiteralCredentialEnvKeys({
        API_TOKEN: "ghp_12345678901234567890",
        SAFE_VALUE: "ordinary text",
      })
    ).toEqual(["API_TOKEN"]);

    render(
      createElement(McpServerForm, {
        value: {
          ...EMPTY_MCP_SERVER_FORM_STATE,
          id: "server",
          command: "node",
          env: { API_TOKEN: "ghp_12345678901234567890" },
        },
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
        submitLabel: "Save",
      })
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "looks like a pasted credential"
    );
  });
});
