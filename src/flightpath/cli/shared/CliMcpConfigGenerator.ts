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
 * Shared MCP server configuration utilities (harness-agnostic)
 *
 * Provides generic helpers for generating MCP configurations.
 * Each harness integration calls the appropriate methods directly.
 */
export class CliMcpConfigGenerator {
  /**
   * Generate JSON MCP configuration
   *
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @param serverConfig Optional server configuration fields (type, tools, etc.)
   * @param workingFilePath Active working file path (sets FLIGHTPATH_WORKING_FILE for precise targeting)
   * @returns JSON config string
   */
  static generateJsonConfig(
    serverPath: string,
    workspaceRoot: string,
    serverConfig?: McpServerConfig,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>
  ): string {
    // Normalize paths (forward slashes work on Windows and Unix)
    const normalizedServerPath = serverPath.replace(/\\/g, "/");
    const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, "/");

    const env: Record<string, string> = {
      FLIGHTPATH_WORKSPACE: normalizedWorkspaceRoot,
    };
    if (workingFilePath) {
      env["FLIGHTPATH_WORKING_FILE"] = workingFilePath.replace(/\\/g, "/");
    }
    if (additionalEnv) {
      Object.assign(env, additionalEnv);
    }

    const mcpServers: any = {
      flightpath: {
        command: "node",
        args: [normalizedServerPath],
        env,
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
   * Used by harnesses that support inline TOML config (e.g., Codex).
   * Format: mcp_servers.{serverName}={command='node',args=['path'],env={VAR='value'}}
   *
   * Note: Uses single quotes inside TOML to avoid PowerShell escaping issues
   *
   * @param serverName MCP server name (e.g., "flightpath")
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file path (sets FLIGHTPATH_WORKING_FILE for precise targeting)
   * @returns TOML config string
   */
  static generateInlineTomlConfig(
    serverName: string,
    serverPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>
  ): string {
    // Normalize paths (forward slashes)
    const escapedServerPath = serverPath.replace(/\\/g, "/");
    const escapedWorkspaceRoot = workspaceRoot.replace(/\\/g, "/");

    // Build inline TOML config
    let envPart = `FLIGHTPATH_WORKSPACE='${escapedWorkspaceRoot}'`;
    if (workingFilePath) {
      const escapedWorkingFile = workingFilePath.replace(/\\/g, "/");
      envPart += `,FLIGHTPATH_WORKING_FILE='${escapedWorkingFile}'`;
    }
    if (additionalEnv) {
      for (const [key, value] of Object.entries(additionalEnv)) {
        envPart += `,${key}='${value}'`;
      }
    }
    return (
      `mcp_servers.${serverName}={command='node',` +
      `args=['${escapedServerPath}'],` +
      `env={${envPart}}}`
    );
  }
}
