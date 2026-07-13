import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import type { McpServerConfig } from "../../../types/CtrlYokeTypes";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { retryWithBackoff } from "../../../utils/RetryUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import { resolveCliCommand } from "./CliLauncherResolver";
import { CLI_VERSION_CHECK_TIMEOUT_MS } from "./interfaces/ICliProvider";

const execFileAsync = promisify(execFile);

const WINDOWS_FILE_LOCK_ERROR = "being used by another process";

interface CliVersionCommandOptions {
  timeoutMs?: number;
  retryWindowsFileLockErrors?: boolean;
}

interface GetCliVersionOptions extends CliVersionCommandOptions {
  parseVersion?: (stdout: string) => string | undefined;
}

/**
 * Per-harness formatting knobs for {@link CliProviderUtils.buildSettingsJsonMcpEntries}.
 *
 * Defaults reproduce Qwen output (`url` + `type` for remote servers,
 * `trust: true` for auto-approved servers). Antigravity's `mcp_config.json`
 * schema uses `serverUrl` and recognizes neither `type` nor `trust`.
 */
export interface SettingsJsonMcpEntryOptions {
  /** Key used for a remote server's URL. Default `"url"`; Antigravity uses `"serverUrl"`. */
  remoteUrlKey?: "url" | "serverUrl";
  /** Whether to emit a `type` field for remote servers. Default `true`. */
  includeRemoteType?: boolean;
  /** Whether to emit a `trust` field for auto-approved/orchestrator servers. Default `true`. */
  includeTrust?: boolean;
}

/**
 * Shared CLI provider utilities
 *
 * Contains common logic used by all CLI providers (Copilot, Claude, Codex)
 * to avoid code duplication across provider implementations.
 *
 * **Single source of truth for:**
 * - Workspace directory resolution (`getWorkspaceDirs`)
 * - MCP configuration injection (`buildMcpConfigBlock`)
 * - Session resume decision (`shouldResumeSession`)
 * - Process environment construction (`buildProcessEnv`)
 * - Shell-aware CLI version checks (`checkCliAvailability`, `getCliVersion`)
 */
export class CliProviderUtils {
  /**
   * Execute a CLI version command through the same launcher resolution path used
   * for runtime prompt execution.
   */
  static async runVersionCommand(
    versionCommand: string,
    options: CliVersionCommandOptions = {}
  ): Promise<string> {
    const execute = async (): Promise<string> => {
      const [commandName, ...commandArgs] = parseArgString(versionCommand);
      if (!commandName) {
        throw new Error("Version command is empty");
      }

      const resolved = await resolveCliCommand(commandName, commandArgs);
      const timeoutMs = options.timeoutMs ?? CLI_VERSION_CHECK_TIMEOUT_MS;
      Log.debug(
        `[runVersionCommand] spawning: ${resolved.displayCommand} (kind=${resolved.launcherKind}, timeout=${timeoutMs}ms)`
      );
      const { stdout } = await execFileAsync(resolved.command, resolved.args, {
        encoding: "utf8",
        timeout: timeoutMs,
      });
      return typeof stdout === "string" ? stdout.trim() : String(stdout).trim();
    };

    if (!options.retryWindowsFileLockErrors) {
      return execute();
    }

    const result = await retryWithBackoff(
      async () => {
        try {
          return await execute();
        } catch (error) {
          if (String(error).includes(WINDOWS_FILE_LOCK_ERROR)) {
            return null;
          }
          throw error;
        }
      },
      { maxAttempts: 4, delays: [200, 500, 1000] }
    );

    if (result === undefined) {
      throw new Error(`Version command failed: ${versionCommand}`);
    }
    return result;
  }

  /**
   * Check whether a CLI is available by running its version command.
   */
  static async checkCliAvailability(
    versionCommand: string,
    options: CliVersionCommandOptions = {}
  ): Promise<boolean> {
    try {
      await CliProviderUtils.runVersionCommand(versionCommand, options);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a CLI version string, with optional provider-specific parsing.
   */
  static async getCliVersion(
    versionCommand: string,
    options: GetCliVersionOptions = {}
  ): Promise<string | undefined> {
    try {
      const stdout = await CliProviderUtils.runVersionCommand(
        versionCommand,
        options
      );
      const parsed = options.parseVersion?.(stdout) ?? stdout;
      return parsed || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Determine whether to resume a session for this prompt execution.
   *
   * Single source of truth for the resume decision across all CLI providers.
   * A session is resumed only when:
   * 1. The `resumeSession` property is explicitly true for this prompt, AND
   * 2. A session ID from a prior turn is available to resume.
   *
   * This prevents accidentally resuming a session when `resumeSession` is
   * false (or unset) just because a stale session ID is present in state.
   *
   * @param resolvedResumeSession - Resolved value of the `resumeSession` property
   * @param sessionId - Session ID from a prior turn, if any
   * @returns true only when both conditions are satisfied
   */
  static shouldResumeSession(
    resolvedResumeSession: boolean | undefined,
    sessionId: string | undefined
  ): boolean {
    return (resolvedResumeSession ?? false) && !!sessionId;
  }

  /**
   * Get workspace directories for --add-dir arguments
   *
   * Collects every workspace-folder root plus any user-configured additional
   * directories from `permissions.allowedDirs`. Workspace roots stay
   * distinct from configured directories so future external-root policy can
   * decide explicitly which roots a harness may receive.
   *
   * @param workspaceRoot - Primary workspace root for resolving relative paths
   * @param workspaceRoots - Every open workspace-folder root
   * @returns Array of absolute directory paths
   *
   * @remarks
   * Previously duplicated across CopilotCliProvider, ClaudeCliProvider, and CodexCliProvider.
   * CodexCliProvider was missing the `cliAdditionalDirs` support — now fixed.
   */
  static getWorkspaceDirs(
    workspaceRoot: string,
    workspaceRoots: readonly string[] = []
  ): string[] {
    const workspaceDirs: string[] = [];
    const directoryKeys = new Set<string>();
    const isWindows = process.platform === "win32";
    const addDirectory = (directory: string): void => {
      const absolutePath = path.resolve(directory);
      const key = isWindows ? absolutePath.toLowerCase() : absolutePath;
      if (!directoryKeys.has(key)) {
        directoryKeys.add(key);
        workspaceDirs.push(absolutePath);
      }
    };

    // Keep the primary root first for deterministic behavior, then include
    // every other workspace folder for multi-root windows.
    addDirectory(workspaceRoot);
    workspaceRoots.forEach(addDirectory);

    // Add configured allowed directories
    const allowedDirs = ConfigurationUtils.getCliAllowedDirs();
    allowedDirs.forEach((dir: string) => {
      addDirectory(path.isAbsolute(dir) ? dir : path.join(workspaceRoot, dir));
    });

    return workspaceDirs;
  }

  /**
   * Build MCP configuration block for dynamic queue extension
   *
   * Common logic for checking whether MCP config should be injected and
   * calling the provider's getMcpConfigArgs. Each provider still defines
   * its own getMcpConfigArgs (for format-specific config generation), but
   * the decision logic and PromptIdentity check are shared here.
   *
   * @param workflowContext - Workflow context with resolved properties
   * @param workspaceRoot - Workspace root directory
   * @param extensionPath Extension installation directory
   * @param getMcpConfigArgs - Provider-specific MCP config args generator
   * @returns CLI arguments to add, or empty array if MCP not needed
   */
  static async buildMcpConfigBlock(
    workflowContext:
      | {
          promptIndex: number;
          allPrompts: unknown[];
          filePath?: string;
          resolvedProperties?: ResolvedProperties;
          workingFilePath?: string;
        }
      | undefined,
    workspaceRoot: string | undefined,
    extensionPath: string,
    getMcpConfigArgs: (
      mcpServerPath: string | undefined,
      workspaceRoot: string,
      workingFilePath?: string,
      additionalEnv?: Record<string, string>,
      userServers?: McpServerConfig[]
    ) => Promise<string[] | null>
  ): Promise<string[]> {
    if (!workflowContext || !workspaceRoot) {
      return [];
    }

    const mcpServers = workflowContext.resolvedProperties?.mcpServers;

    // A McpServerConfig object with id === "ctrlyoke" is treated as the built-in
    // ctrlyoke server — it may carry a deniedTools list for per-tool access control.
    const ctrlyokeServerObj = (mcpServers ?? []).find(
      (s): s is McpServerConfig =>
        typeof s === "object" && s !== null && s.id === "ctrlyoke"
    );
    const hasCtrlYokeServer =
      (mcpServers != null && mcpServers.includes("ctrlyoke")) ||
      !!ctrlyokeServerObj;

    // Extract user-defined server configs (objects with id !== "ctrlyoke")
    const userServers = (mcpServers ?? []).filter(
      (s): s is McpServerConfig =>
        typeof s === "object" && s !== null && s.id !== "ctrlyoke"
    );

    // Trigger MCP config if "ctrlyoke" is listed OR user-defined servers are present
    if (!hasCtrlYokeServer && userServers.length === 0) {
      return [];
    }

    // Only include the ctrlyoke server path when "ctrlyoke" is in the list
    const mcpServerPath = hasCtrlYokeServer
      ? path.join(extensionPath, "out/mcp-server.js")
      : undefined;

    // ctrlyoke-specific env vars — only relevant when the ctrlyoke server is included
    const additionalEnv: Record<string, string> | undefined = hasCtrlYokeServer
      ? (() => {
          const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
          return {
            CTRLYOKE_MAX_QUEUE_SIZE: dynamicQueueConfig.maxQueueSize.toString(),
            CTRLYOKE_UNLIMITED_MODE:
              dynamicQueueConfig.unlimitedMode.toString(),
            CTRLYOKE_DIAGNOSTIC_LOGS:
              ConfigurationUtils.isDiagnosticLogsEnabled().toString(),
          };
        })()
      : undefined;

    const mcpArgs = await getMcpConfigArgs(
      mcpServerPath,
      workspaceRoot,
      workflowContext.workingFilePath,
      additionalEnv,
      userServers.length > 0 ? userServers : undefined
    );

    if (mcpArgs) {
      Log.debug("🔧 MCP server config added for dynamic queue extension");
      return mcpArgs;
    }

    return [];
  }

  /**
   * Build a process environment object for spawning CLI harness processes.
   *
   * Single source of truth for env construction: spreads `process.env` and
   * conditionally injects `CTRLYOKE_DIAGNOSTIC_LOGS` when diagnostic
   * logging is enabled. Providers may modify the returned object before use
   * (e.g. Claude deletes `CLAUDECODE`).
   */
  static buildProcessEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (ConfigurationUtils.isDiagnosticLogsEnabled()) {
      env.CTRLYOKE_DIAGNOSTIC_LOGS = "true";
    }
    return env;
  }

  // ============================================================
  // SETTINGS.JSON MCP HELPERS (Qwen Code CLI / Antigravity CLI)
  // ============================================================

  /**
   * Build MCP server entries for settings.json-style MCP config files.
   *
   * Both CLIs auto-discover MCP from `.{tool}/settings.json` using the `mcpServers` key.
   * Config per server: { command: string, args?: string[], env?: Record<string, string>, trust?: boolean }
   *
   * @param mcpServerPath ctrlyoke MCP server path (undefined if ctrlyoke server not requested)
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow
   * @param additionalEnv Extra environment variables for the ctrlyoke MCP server
   * @param userServers User-defined MCP server configurations
   * @returns Object of server entries keyed by server name
   */
  static buildSettingsJsonMcpEntries(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[],
    options?: SettingsJsonMcpEntryOptions
  ): Record<string, unknown> {
    // Defaults reproduce Qwen semantics; Antigravity overrides the
    // remote-URL key (serverUrl) and drops the type/trust fields its schema
    // doesn't recognize.
    const remoteUrlKey = options?.remoteUrlKey ?? "url";
    const includeRemoteType = options?.includeRemoteType ?? true;
    const includeTrust = options?.includeTrust ?? true;

    const mcpServers: Record<string, unknown> = {};

    // ctrlyoke server (when included in mcpServers list)
    if (mcpServerPath) {
      const normalizedServerPath = mcpServerPath.replace(/\\/g, "/");
      const normalizedWorkspace = workspaceRoot.replace(/\\/g, "/");

      const env: Record<string, string> = {
        CTRLYOKE_WORKSPACE: normalizedWorkspace,
      };
      if (workingFilePath) {
        env["CTRLYOKE_WORKING_FILE"] = workingFilePath.replace(/\\/g, "/");
      }
      if (additionalEnv) {
        Object.assign(env, additionalEnv);
      }

      const ctrlyokeEntry: Record<string, unknown> = {
        command: "node",
        args: [normalizedServerPath],
        env,
      };
      if (includeTrust) {
        // ctrlyoke is the orchestrator — auto-approve its tools
        ctrlyokeEntry.trust = true;
      }
      mcpServers["ctrlyoke"] = ctrlyokeEntry;
    }

    // User-defined MCP servers
    if (userServers) {
      for (const server of userServers) {
        const entry: Record<string, unknown> = {};
        if (server.url) {
          entry[remoteUrlKey] = server.url;
          if (includeRemoteType) {
            entry.type = server.transport ?? "streamable-http";
          }
          if (server.headers) entry.headers = server.headers;
        } else {
          entry.command = server.command;
          if (server.args) entry.args = server.args;
          if (server.env) entry.env = server.env;
        }
        if (includeTrust && server.autoApprove === true) {
          entry.trust = true;
        }
        mcpServers[server.id] = entry;
      }
    }

    return mcpServers;
  }
}
