import type { McpServerConfig } from "../../../types/CtrlYokeTypes";
import type { ToolPermissionConfig } from "../shared/interfaces/IToolPermissionMapper";
import type { SettingsJsonPermissionPolicy } from "../shared/SettingsJsonMcpTracker";

export interface OpenCodeLocalMcpServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
}

export interface OpenCodeRemoteMcpServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
}

export type OpenCodeMcpServer =
  | OpenCodeLocalMcpServer
  | OpenCodeRemoteMcpServer;

export type OpenCodeMcpEntries = Record<string, OpenCodeMcpServer>;

/** The ctrlyoke-owned settings delivered through OpenCode's inline config. */
export interface OpenCodeInlineConfig {
  permission?: SettingsJsonPermissionPolicy;
  mcp?: OpenCodeMcpEntries;
  plugin: string[];
}

export interface OpenCodeInlineConfigBuildOptions {
  extensionPath: string;
  toolPermissions?: ToolPermissionConfig | null;
  mcpServerPath?: string;
  workspaceRoot?: string;
  workingFilePath?: string;
  additionalEnv?: Record<string, string>;
  userServers?: McpServerConfig[];
}

/**
 * Build OpenCode MCP entries without performing any file or tracker I/O.
 *
 * The entry construction is shared by the pure builder and the prompt
 * accumulator so the inline representation cannot drift between call paths.
 */
export function buildOpenCodeMcpEntries(
  mcpServerPath: string | undefined,
  workspaceRoot: string | undefined,
  workingFilePath?: string,
  additionalEnv?: Record<string, string>,
  userServers: McpServerConfig[] = []
): OpenCodeMcpEntries {
  if (mcpServerPath && !workspaceRoot) {
    throw new Error(
      "OpenCode MCP entries require a workspace root when the ctrlyoke server is enabled"
    );
  }

  const mcpEntries: OpenCodeMcpEntries = {};

  if (mcpServerPath && workspaceRoot) {
    const env: Record<string, string> = {
      CTRLYOKE_WORKSPACE: workspaceRoot.replace(/\\/g, "/"),
    };
    if (workingFilePath) {
      env["CTRLYOKE_WORKING_FILE"] = workingFilePath.replace(/\\/g, "/");
    }
    if (additionalEnv) {
      Object.assign(env, additionalEnv);
    }

    mcpEntries.ctrlyoke = {
      type: "local",
      command: ["node", mcpServerPath.replace(/\\/g, "/")],
      environment: env,
    };
  }

  for (const server of userServers) {
    if (server.url) {
      const entry: OpenCodeRemoteMcpServer = {
        type: "remote",
        url: server.url,
      };
      if (server.headers) {
        entry.headers = server.headers;
      }
      mcpEntries[server.id] = entry;
      continue;
    }

    const entry: OpenCodeLocalMcpServer = {
      type: "local",
      command: [server.command ?? "", ...(server.args ?? [])],
    };
    if (server.env) {
      entry.environment = server.env;
    }
    mcpEntries[server.id] = entry;
  }

  return mcpEntries;
}
