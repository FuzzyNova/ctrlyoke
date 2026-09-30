import * as path from "path";
import * as fs from "fs/promises";
import type { McpServerConfig } from "../../../types/CtrlYokeTypes";
import { isValidSecretName } from "../../../platform/SecretKey";
import { PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";
import type { PreparedMutation } from "./interfaces/PreparedMutation";
import {
  CTRLYOKE_ENV_VARS,
  MCP_SECRET_CONFIG_MODES,
} from "../../../types/DashboardConstants";
import { quoteTomlBasicString } from "./InlineToml";

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

/** The shared stdio entry shape used to launch ctrlyoke's MCP server. */
export interface McpStdioServerEntry {
  command: "node";
  args: string[];
  env: Record<string, string>;
}

interface McpConfigServerEntry extends Record<string, unknown> {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  tools?: string[];
  url?: string;
  headers?: Record<string, string>;
  autoApprove?: boolean | string[];
}

interface McpJsonConfig {
  mcpServers: Record<string, McpConfigServerEntry>;
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
   * Maps ctrlyoke transport values to the harness-specific type field value for remote servers.
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
  /** Root exported as CTRLYOKE_WORKSPACE; defaults to workspaceRoot. */
  stateRoot?: string;
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

/**
 * Provider-owned handling for `${secret:NAME}` values in process-consumed MCP
 * maps. The provider chooses its native reference syntax; the generator only
 * applies that strategy consistently to env and header values.
 */
export type McpSecretConfigOptions =
  | {
      mode: typeof MCP_SECRET_CONFIG_MODES.REFERENCE;
      referenceToken: (name: string) => string;
    }
  | {
      mode: "substitute";
      resolvedValues: Readonly<Record<string, string>>;
      restrictivePermissions?: boolean;
    };

export function transformMcpSecretMap(
  values: Record<string, string>,
  options?: McpSecretConfigOptions
): Record<string, string> {
  if (!options) return values;

  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\$\{secret:([^}]+)\}/gu, (_match, name: string) => {
        if (!isValidSecretName(name)) {
          throw new Error(`Invalid secret interpolation name "${name}"`);
        }
        if (options.mode === MCP_SECRET_CONFIG_MODES.REFERENCE) {
          return options.referenceToken(name);
        }
        const resolved = options.resolvedValues[name];
        if (resolved === undefined) {
          throw new Error(`Missing resolved secret "${name}"`);
        }
        return resolved;
      }),
    ])
  );
}

export interface InlineTomlMcpServerOptions {
  defaultToolsApprovalMode?: "auto" | "prompt" | "approve";
  enabledTools?: string[];
  disabledTools?: string[];
  /** Codex-native environment names forwarded from the parent process. */
  envVars?: string[];
  /** Codex-native remote header-to-environment mapping. */
  envHttpHeaders?: Record<string, string>;
  /** Codex-native Authorization bearer-token environment name. */
  bearerTokenEnvVar?: string;
}

/**
 * Shared MCP server configuration utilities (harness-agnostic)
 *
 * Provides generic helpers for generating MCP configurations.
 * Each harness integration calls the appropriate methods directly.
 */
export class CliMcpConfigGenerator {
  /**
   * Describe a file write without performing it. The returned mutation is
   * owned by the caller and may be applied immediately before process start.
   */
  static createFileMutation(
    filePath: string,
    content: string,
    description = "Write generated MCP configuration",
    options?: { restrictivePermissions?: boolean }
  ): PreparedMutation {
    return {
      path: filePath,
      intendedContent: content,
      description,
      apply: async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          filePath,
          content,
          options?.restrictivePermissions
            ? { encoding: "utf-8", mode: 0o600 }
            : "utf-8"
        );
        if (options?.restrictivePermissions) {
          // chmod is meaningful on POSIX and harmlessly best-effort on Windows.
          await fs.chmod(filePath, 0o600).catch(() => undefined);
        }
      },
      restore: async () => {
        await fs.unlink(filePath).catch(() => undefined);
      },
    };
  }

  private static quoteInlineTomlString(value: string): string {
    return quoteTomlBasicString(value);
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
    options?: InlineTomlMcpServerOptions,
    secretOptions?: McpSecretConfigOptions
  ): string {
    const parts = [`command=${this.quoteInlineTomlString(command)}`];

    if (args && args.length > 0) {
      parts.push(`args=${this.formatInlineTomlStringArray(args)}`);
    }

    if (env && Object.keys(env).length > 0) {
      parts.push(
        `env=${this.formatInlineTomlEnv(
          this.transformSecretMap(env, secretOptions)
        )}`
      );
    }

    if (options?.envVars && options.envVars.length > 0) {
      parts.push(
        `env_vars=${this.formatInlineTomlStringArray(options.envVars)}`
      );
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
   * Generate inline TOML configuration for a streamable HTTP MCP server entry.
   *
   * Codex models remote MCP servers with `url` plus optional `http_headers`.
   */
  static generateInlineTomlRemoteServerConfig(
    serverName: string,
    url: string,
    headers?: Record<string, string>,
    options?: InlineTomlMcpServerOptions,
    secretOptions?: McpSecretConfigOptions
  ): string {
    const parts = [`url=${this.quoteInlineTomlString(url)}`];

    if (headers && Object.keys(headers).length > 0) {
      parts.push(
        `http_headers=${this.formatInlineTomlEnv(
          this.transformSecretMap(headers, secretOptions)
        )}`
      );
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

    if (
      options?.envHttpHeaders &&
      Object.keys(options.envHttpHeaders).length > 0
    ) {
      parts.push(
        `env_http_headers=${this.formatInlineTomlEnv(options.envHttpHeaders)}`
      );
    }
    if (options?.bearerTokenEnvVar) {
      parts.push(
        `bearer_token_env_var=${this.quoteInlineTomlString(options.bearerTokenEnvVar)}`
      );
    }

    return `mcp_servers.${serverName}={${parts.join(",")}}`;
  }

  /**
   * Compute the path for a file-based MCP config in .ctrlyoke/temp/.
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
      ? path.basename(workingFilePath, ".ctrlyoke.json")
      : "default";
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      `${filenamePrefix}-${configSuffix}.json`
    );
  }

  /**
   * Build the shared ctrlyoke MCP stdio entry.
   *
   * Format-specific generators may add their own fields around this base
   * entry, but the server path and ctrlyoke environment must stay identical.
   */
  static buildCtrlyokeStdioServerEntry(
    serverPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    stateRoot?: string
  ): McpStdioServerEntry {
    const normalizedWorkspaceRoot = (stateRoot ?? workspaceRoot).replace(
      /\\/g,
      "/"
    );
    const env: Record<string, string> = {
      CTRLYOKE_WORKSPACE: normalizedWorkspaceRoot,
      CTRLYOKE_EXECUTION_ROOT: workspaceRoot.replace(/\\/g, "/"),
    };
    if (workingFilePath) {
      env[CTRLYOKE_ENV_VARS.WORKING_FILE] = workingFilePath.replace(/\\/g, "/");
    }
    if (additionalEnv) {
      Object.assign(env, additionalEnv);
    }

    return {
      command: "node",
      args: [serverPath.replace(/\\/g, "/")],
      env,
    };
  }

  /**
   * Generate JSON MCP configuration
   *
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @param serverConfig Optional server configuration fields (type, tools, etc.)
   * @param workingFilePath Active working file path (sets CTRLYOKE_WORKING_FILE for precise targeting)
   * @returns JSON config string
   */
  static generateJsonConfig(
    serverPath: string,
    workspaceRoot: string,
    serverConfig?: McpHarnessServerConfig,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    stateRoot?: string,
    _secretOptions?: McpSecretConfigOptions
  ): string {
    const ctrlyokeEntry: McpConfigServerEntry = {
      ...this.buildCtrlyokeStdioServerEntry(
        serverPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv,
        stateRoot
      ),
    };
    const mcpServers: Record<string, McpConfigServerEntry> = {
      ctrlyoke: ctrlyokeEntry,
    };

    // Add optional server configuration fields
    if (serverConfig) {
      if (serverConfig.type) {
        mcpServers.ctrlyoke.type = serverConfig.type;
      }
      if (serverConfig.tools) {
        mcpServers.ctrlyoke.tools = serverConfig.tools;
      }
    }

    const config = { mcpServers };
    return JSON.stringify(config, null, 2);
  }

  /**
   * Generate JSON MCP configuration including user-defined MCP servers.
   *
   * Merges the ctrlyoke built-in server with any user-defined McpServerConfig objects.
   *
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @param userServers User-defined MCP server configs to merge in
   * @param serverConfig Optional harness server configuration fields (type, tools, etc.)
   * @param workingFilePath Active working file path
   * @param additionalEnv Additional environment variables for ctrlyoke server
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
    userServerConfig?: McpUserServerHarnessConfig,
    stateRoot?: string,
    secretOptions?: McpSecretConfigOptions
  ): string {
    // Parse the base config with the ctrlyoke server
    const baseConfig = JSON.parse(
      this.generateJsonConfig(
        serverPath,
        workspaceRoot,
        serverConfig,
        workingFilePath,
        additionalEnv,
        stateRoot
      )
    ) as McpJsonConfig;

    // Merge user-defined servers
    for (const server of userServers) {
      baseConfig.mcpServers[server.id] = this.buildUserServerEntry(
        server,
        userServerConfig,
        secretOptions
      );
    }

    return JSON.stringify(baseConfig, null, 2);
  }

  /**
   * Generate JSON MCP configuration with ONLY user-defined servers (no ctrlyoke server).
   *
   * Used when the workflow specifies user-defined MCP servers but does NOT include "ctrlyoke"
   * in the mcpServers list. Generates a config with just the user's servers.
   *
   * @param userServers User-defined MCP server configs
   * @param userServerConfig Optional harness-specific formatting for user server entries
   * @returns JSON config string
   */
  static generateUserServersOnlyConfig(
    userServers: McpServerConfig[],
    userServerConfig?: McpUserServerHarnessConfig,
    secretOptions?: McpSecretConfigOptions
  ): string {
    const mcpServers: Record<string, McpConfigServerEntry> = {};
    for (const server of userServers) {
      mcpServers[server.id] = this.buildUserServerEntry(
        server,
        userServerConfig,
        secretOptions
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
    userServerConfig?: McpUserServerHarnessConfig,
    secretOptions?: McpSecretConfigOptions
  ): McpConfigServerEntry {
    const entry: McpConfigServerEntry = {};

    if (server.url) {
      // Remote server
      entry.url = server.url;
      const rawTransport = server.transport ?? "streamable-http";
      entry.type =
        userServerConfig?.remoteTypeMap?.[rawTransport] ?? rawTransport;
      if (server.headers) {
        entry.headers = this.transformSecretMap(server.headers, secretOptions);
      }
    } else {
      // stdio server
      entry.command = server.command;
      if (userServerConfig?.stdioType) entry.type = userServerConfig.stdioType;
      if (server.args) entry.args = server.args;
      if (server.env) {
        entry.env = this.transformSecretMap(server.env, secretOptions);
      }
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
   * Format: mcp_servers.{serverName}={command="node",args=["path"],env={VAR="value"}}
   *
   * @param serverName MCP server name (e.g., "ctrlyoke")
   * @param serverPath Path to MCP server script
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file path (sets CTRLYOKE_WORKING_FILE for precise targeting)
   * @returns TOML config string
   */
  static generateInlineTomlConfig(
    serverName: string,
    serverPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    stateRoot?: string,
    secretOptions?: McpSecretConfigOptions
  ): string {
    const ctrlyokeEntry = this.buildCtrlyokeStdioServerEntry(
      serverPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      stateRoot
    );

    return this.generateInlineTomlStdioServerConfig(
      serverName,
      ctrlyokeEntry.command,
      ctrlyokeEntry.args,
      ctrlyokeEntry.env,
      undefined,
      secretOptions
    );
  }

  private static transformSecretMap(
    values: Record<string, string>,
    options?: McpSecretConfigOptions
  ): Record<string, string> {
    return transformMcpSecretMap(values, options);
  }
}
