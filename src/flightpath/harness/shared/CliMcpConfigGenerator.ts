import * as path from "path";
import type { McpServerConfig } from "../../../types/FlightPathTypes";
import { PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";

/**
 * MCP configuration format
 */
export type McpConfigFormat = "json-file" | "toml-inline";

/**
 * Internal MCP harness server configuration options (harness-specific format)
 */
export interface McpHarnessServerConfig {
  /** Server type (e.g., "stdio", "local") */
  type?: string;
  /** Tools pattern (e.g., ["*"] to allow all tools) */
  tools?: string[];
}

/**
 * Harness-specific formatting options for user-defined MCP server entries.
 * Allows each harness to map transport values to its own type field syntax
 * and add required fields (e.g., "tools").
 */
export interface McpUserServerHarnessConfig {
  /** type field value for stdio servers (e.g., "local" for Copilot, "stdio" for Claude) */
  stdioType?: string;
  /**
   * Maps FlightPath transport values to the harness-specific type field value for remote servers.
   * e.g., { "streamable-http": "http", "sse": "sse" } for Copilot CLI.
   * If not provided, the transport value is used as-is.
   */
  remoteTypeMap?: Record<string, string>;
  /** Tools array to add to every server entry (e.g., ["*"] for Copilot CLI) */
  tools?: string[];
}

export interface McpConfigOptions {
  /** Path to MCP server script (e.g., out/mcp-server.js) */
  serverPath: string;
  /** Workspace root directory */
  workspaceRoot: string;
  /** Additional server configuration fields */
  serverConfig?: McpHarnessServerConfig;
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

export interface InlineTomlMcpServerOptions {
  defaultToolsApprovalMode?: "auto" | "prompt" | "approve";
  enabledTools?: string[];
  disabledTools?: string[];
}

/**
 * Shared MCP server configuration utilities (harness-agnostic)
 *
 * Provides generic helpers for generating MCP configurations.
 * Each harness integration calls the appropriate methods directly.
 */
export class CliMcpConfigGenerator {
  private static quoteInlineTomlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private static formatInlineTomlStringArray(values: string[]): string {
    return `[${values.map((value) => this.quoteInlineTomlString(value)).join(",")}]`;
  }

  private static formatInlineTomlEnv(env: Record<string, string>): string {
    return `{${Object.entries(env)
      .map(([key, value]) => `${key}=${this.quoteInlineTomlString(value)}`)
      .join(",")}}`;
  }

  /**
   * Generate inline TOML configuration for a stdio MCP server entry.
   *
   * Used by Codex CLI, which accepts repeated `-c key=value` overrides.
   */
  static generateInlineTomlStdioServerConfig(
    serverName: string,
    command: string,
    args?: string[],
    env?: Record<string, string>,
    options?: InlineTomlMcpServerOptions
  ): string {
    const parts = [`command=${this.quoteInlineTomlString(command)}`];

    if (args && args.length > 0) {
      parts.push(`args=${this.formatInlineTomlStringArray(args)}`);
    }

    if (env && Object.keys(env).length > 0) {
      parts.push(`env=${this.formatInlineTomlEnv(env)}`);
    }

    if (options?.defaultToolsApprovalMode) {
      parts.push(
        `default_tools_approval_mode=${this.quoteInlineTomlString(options.defaultToolsApprovalMode)}`
      );
    }

    if (options?.enabledTools && options.enabledTools.length > 0) {
      parts.push(
        `enabled_tools=${this.formatInlineTomlStringArray(options.enabledTools)}`
      );
    }

    if (options?.disabledTools && options.disabledTools.length > 0) {
      parts.push(
        `disabled_tools=${this.formatInlineTomlStringArray(options.disabledTools)}`
      );
    }

    return `mcp_servers.${serverName}={${parts.join(",")}}`;
  }

  /**
   * Compute the path for a file-based MCP config in .flightpath/temp/.
   *
   * Single source of truth for all file-based MCP config paths. Both
   * getMcpConfigArgs (write) and getMcpConfigFilePath (cleanup) must use
   * this method to guarantee the paths always match.
   *
   * @param workingFilePath Active working file for this workflow (used as filename suffix)
   * @param workspaceRoot Workspace root directory
   * @param filenamePrefix Harness-specific prefix (e.g., "mcp-config", "mcp-config-claude")
   * @returns Absolute path to the config file
   */
  static getConfigFilePath(
    workingFilePath: string | undefined,
    workspaceRoot: string,
    filenamePrefix: string
  ): string {
    const configSuffix = workingFilePath
      ? path.basename(workingFilePath, ".flightpath.json")
      : "default";
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      `${filenamePrefix}-${configSuffix}.json`
    );
  }

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
    serverConfig?: McpHarnessServerConfig,
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
   * Generate JSON MCP configuration including user-defined MCP servers.
   *
   * Merges the FlightPath built-in server with any user-defined McpServerConfig objects.
   *
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @param userServers User-defined MCP server configs to merge in
   * @param serverConfig Optional harness server configuration fields (type, tools, etc.)
   * @param workingFilePath Active working file path
   * @param additionalEnv Additional environment variables for FlightPath server
   * @param userServerConfig Optional harness-specific formatting for user server entries
   * @returns JSON config string
   */
  static generateJsonConfigWithUserServers(
    serverPath: string,
    workspaceRoot: string,
    userServers: McpServerConfig[],
    serverConfig?: McpHarnessServerConfig,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServerConfig?: McpUserServerHarnessConfig
  ): string {
    // Parse the base config with the flightpath server
    const baseConfig = JSON.parse(
      this.generateJsonConfig(
        serverPath,
        workspaceRoot,
        serverConfig,
        workingFilePath,
        additionalEnv
      )
    );

    // Merge user-defined servers
    for (const server of userServers) {
      baseConfig.mcpServers[server.id] = this.buildUserServerEntry(
        server,
        userServerConfig
      );
    }

    return JSON.stringify(baseConfig, null, 2);
  }

  /**
   * Generate JSON MCP configuration with ONLY user-defined servers (no FlightPath server).
   *
   * Used when the workflow specifies user-defined MCP servers but does NOT include "flightpath"
   * in the mcpServers list. Generates a config with just the user's servers.
   *
   * @param userServers User-defined MCP server configs
   * @param userServerConfig Optional harness-specific formatting for user server entries
   * @returns JSON config string
   */
  static generateUserServersOnlyConfig(
    userServers: McpServerConfig[],
    userServerConfig?: McpUserServerHarnessConfig
  ): string {
    const mcpServers: any = {};
    for (const server of userServers) {
      mcpServers[server.id] = this.buildUserServerEntry(
        server,
        userServerConfig
      );
    }
    return JSON.stringify({ mcpServers }, null, 2);
  }

  /**
   * Build the harness-formatted entry object for a single user-defined MCP server.
   *
   * Applies harness-specific type mapping and adds required fields (e.g., tools).
   */
  private static buildUserServerEntry(
    server: McpServerConfig,
    userServerConfig?: McpUserServerHarnessConfig
  ): Record<string, unknown> {
    const entry: Record<string, unknown> = {};

    if (server.url) {
      // Remote server
      entry.url = server.url;
      const rawTransport = server.transport ?? "streamable-http";
      entry.type =
        userServerConfig?.remoteTypeMap?.[rawTransport] ?? rawTransport;
      if (server.headers) entry.headers = server.headers;
    } else {
      // stdio server
      entry.command = server.command;
      if (userServerConfig?.stdioType) entry.type = userServerConfig.stdioType;
      if (server.args) entry.args = server.args;
      if (server.env) entry.env = server.env;
    }

    if (userServerConfig?.tools) entry.tools = userServerConfig.tools;

    if (server.autoApprove !== undefined) {
      entry.autoApprove = server.autoApprove;
    }

    return entry;
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

    const env: Record<string, string> = {
      FLIGHTPATH_WORKSPACE: escapedWorkspaceRoot,
    };
    if (workingFilePath) {
      env.FLIGHTPATH_WORKING_FILE = workingFilePath.replace(/\\/g, "/");
    }
    if (additionalEnv) {
      Object.assign(env, additionalEnv);
    }

    return this.generateInlineTomlStdioServerConfig(
      serverName,
      "node",
      [escapedServerPath],
      env
    );
  }
}
