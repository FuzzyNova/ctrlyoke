import { Log } from "../../../utils/Log";

/**
 * MCP configuration format
 */
export type McpConfigFormat = "json-file" | "toml-inline";

/**
 * MCP server configuration options
 */
export interface McpServerConfig {
  /** Server type (e.g., "stdio", "local") */
  type?: string;
  /** Tools pattern (e.g., ["*"] to allow all tools) */
  tools?: string[];
}

/**
 * MCP configuration options
 */
export interface McpConfigOptions {
  /** Path to MCP server script (e.g., out/mcp-server.js) */
  serverPath: string;
  /** Workspace root directory */
  workspaceRoot: string;
  /** Additional server configuration fields */
  serverConfig?: McpServerConfig;
  /** Config format */
  format: McpConfigFormat;
}

/**
 * MCP configuration result
 */
export interface McpConfigResult {
  /** CLI arguments to pass */
  args: string[];
  /** Config file path (for file-based formats) */
  configPath?: string;
}

/**
 * Shared MCP server configuration utilities (provider-agnostic)
 *
 * Provides generic helpers for generating MCP configurations.
 * Each provider integration calls the appropriate methods directly.
 */
export class CliMcpConfigGenerator {
  /**
   * Generate JSON MCP configuration
   *
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @param serverConfig Optional server configuration fields (type, tools, etc.)
   * @returns JSON config string
   */
  static generateJsonConfig(
    serverPath: string,
    workspaceRoot: string,
    serverConfig?: McpServerConfig
  ): string {
    // Normalize paths (forward slashes work on Windows and Unix)
    const normalizedServerPath = serverPath.replace(/\\/g, "/");
    const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, "/");

    const mcpServers: any = {
      flightpath: {
        command: "node",
        args: [normalizedServerPath],
        env: {
          FLIGHTPATH_WORKSPACE: normalizedWorkspaceRoot,
        },
      },
    };

    // Add optional server configuration fields
    if (serverConfig) {
      if (serverConfig.type) {
        mcpServers.flightpath.type = serverConfig.type;
      }
      if (serverConfig.tools) {
        mcpServers.flightpath.tools = serverConfig.tools;
      }
    }

    const config = { mcpServers };
    return JSON.stringify(config, null, 2);
  }

  /**
   * Generate inline TOML configuration
   *
   * Used by providers that support inline TOML config (e.g., Codex).
   * Format: mcp_servers.{serverName}={command='node',args=['path'],env={VAR='value'}}
   *
   * Note: Uses single quotes inside TOML to avoid PowerShell escaping issues
   *
   * @param serverName MCP server name (e.g., "flightpath")
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @returns TOML config string
   */
  static generateInlineTomlConfig(
    serverName: string,
    serverPath: string,
    workspaceRoot: string
  ): string {
    // Normalize paths (forward slashes)
    const escapedServerPath = serverPath.replace(/\\/g, "/");
    const escapedWorkspaceRoot = workspaceRoot.replace(/\\/g, "/");

    // Build inline TOML config
    return (
      `mcp_servers.${serverName}={command='node',` +
      `args=['${escapedServerPath}'],` +
      `env={FLIGHTPATH_WORKSPACE='${escapedWorkspaceRoot}'}}`
    );
  }
}
