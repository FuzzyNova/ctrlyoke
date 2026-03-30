import * as path from "path";
import * as fs from "fs";
import type { McpServerConfig } from "../../../types/FlightPathTypes";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

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
 */
export class CliProviderUtils {
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
   * Collects all VS Code workspace folders plus any user-configured
   * additional directories from `flightpath.cliAdditionalDirs` setting.
   *
   * @param workspaceRoot - Primary workspace root for resolving relative paths
   * @returns Array of absolute directory paths
   *
   * @remarks
   * Previously duplicated across CopilotCliProvider, ClaudeCliProvider, and CodexCliProvider.
   * CodexCliProvider was missing the `cliAdditionalDirs` support — now fixed.
   */
  static getWorkspaceDirs(workspaceRoot: string): string[] {
    const workspaceDirs: string[] = [];

    // Add primary workspace folder
    workspaceDirs.push(workspaceRoot);

    // Add configured allowed directories
    const allowedDirs = ConfigurationUtils.getCliAllowedDirs();
    allowedDirs.forEach((dir: string) => {
      const absolutePath = path.isAbsolute(dir)
        ? dir
        : path.join(workspaceRoot, dir);
      if (!workspaceDirs.includes(absolutePath)) {
        workspaceDirs.push(absolutePath);
      }
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
    const hasFlightpathServer =
      mcpServers != null && mcpServers.includes("flightpath");

    // Extract user-defined server configs (objects, not strings)
    const userServers = (mcpServers ?? []).filter(
      (s): s is McpServerConfig => typeof s === "object"
    );

    // Trigger MCP config if "flightpath" is listed OR user-defined servers are present
    if (!hasFlightpathServer && userServers.length === 0) {
      return [];
    }

    // Only include the FlightPath server path when "flightpath" is in the list
    const mcpServerPath = hasFlightpathServer
      ? path.join(extensionPath, "out/mcp-server.js")
      : undefined;

    // FlightPath-specific env vars — only relevant when the FlightPath server is included
    const additionalEnv: Record<string, string> | undefined =
      hasFlightpathServer
        ? (() => {
            const dynamicQueueConfig =
              ConfigurationUtils.getDynamicQueueConfig();
            return {
              FLIGHTPATH_MAX_QUEUE_SIZE:
                dynamicQueueConfig.maxQueueSize.toString(),
              FLIGHTPATH_UNLIMITED_MODE:
                dynamicQueueConfig.unlimitedMode.toString(),
              FLIGHTPATH_DIAGNOSTIC_LOGS:
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
   * conditionally injects `FLIGHTPATH_DIAGNOSTIC_LOGS` when diagnostic
   * logging is enabled. Providers may modify the returned object before use
   * (e.g. Claude deletes `CLAUDECODE`).
   */
  static buildProcessEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (ConfigurationUtils.isDiagnosticLogsEnabled()) {
      env.FLIGHTPATH_DIAGNOSTIC_LOGS = "true";
    }
    return env;
  }

  // ============================================================
  // SETTINGS.JSON MCP HELPERS (Gemini CLI / Qwen Code CLI)
  // ============================================================

  /**
   * Build MCP server entries for settings.json format (Gemini CLI and Qwen Code CLI).
   *
   * Both CLIs auto-discover MCP from `.{tool}/settings.json` using the `mcpServers` key.
   * Config per server: { command: string, args?: string[], env?: Record<string, string>, trust?: boolean }
   *
   * @param mcpServerPath FlightPath MCP server path (undefined if FlightPath server not requested)
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow
   * @param additionalEnv Extra environment variables for the FlightPath MCP server
   * @param userServers User-defined MCP server configurations
   * @returns Object of server entries keyed by server name
   */
  static buildSettingsJsonMcpEntries(
    mcpServerPath: string | undefined,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: McpServerConfig[]
  ): Record<string, unknown> {
    const mcpServers: Record<string, unknown> = {};

    // FlightPath server (when included in mcpServers list)
    if (mcpServerPath) {
      const normalizedServerPath = mcpServerPath.replace(/\\/g, "/");
      const normalizedWorkspace = workspaceRoot.replace(/\\/g, "/");

      const env: Record<string, string> = {
        FLIGHTPATH_WORKSPACE: normalizedWorkspace,
      };
      if (workingFilePath) {
        env["FLIGHTPATH_WORKING_FILE"] = workingFilePath.replace(/\\/g, "/");
      }
      if (additionalEnv) {
        Object.assign(env, additionalEnv);
      }

      mcpServers["flightpath"] = {
        command: "node",
        args: [normalizedServerPath],
        env,
        trust: true, // FlightPath is the orchestrator — auto-approve its tools
      };
    }

    // User-defined MCP servers
    if (userServers) {
      for (const server of userServers) {
        const entry: Record<string, unknown> = {
          command: server.command,
        };
        if (server.args) {
          entry.args = server.args;
        }
        if (server.env) {
          entry.env = server.env;
        }
        if (server.autoApprove === true) {
          entry.trust = true;
        }
        mcpServers[server.id] = entry;
      }
    }

    return mcpServers;
  }

  // ============================================================
  // SETTINGS.JSON HOOKS HELPERS (Gemini CLI / Qwen Code CLI)
  // ============================================================

  /**
   * Read a tool's settings.json and back up just the `hooks` section.
   *
   * Used by interactive hook setup to safely merge FlightPath hooks into
   * an existing settings.json. Only the hooks key is backed up so MCP
   * entries managed by SettingsJsonMcpTracker are not overwritten on restore.
   *
   * @param settingsPath Full path to the settings.json file
   * @param backupPath Full path to the hooks backup file
   * @returns Current settings object (may include MCP entries from prior steps)
   */
  static async readSettingsAndBackupHooks(
    settingsPath: string,
    backupPath: string
  ): Promise<Record<string, unknown>> {
    // Read existing settings (if any)
    let existingSettings: Record<string, unknown> = {};
    try {
      const content = await fs.promises.readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Back up only the hooks section, only once per workflow run
    try {
      await fs.promises.access(backupPath);
      // Backup already exists — skip
    } catch {
      const hooksBackup = existingSettings.hooks ?? null;
      await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.promises.writeFile(
        backupPath,
        JSON.stringify(hooksBackup),
        "utf-8"
      );
    }

    return existingSettings;
  }

  /**
   * Restore only the `hooks` key in a tool's settings.json from backup.
   *
   * Unlike full-file restore, this preserves all other settings keys (including
   * `mcpServers` managed by SettingsJsonMcpTracker). If the backup is `null`
   * (no hooks existed before), the hooks key is deleted from settings.json.
   *
   * @param settingsPath Full path to the settings.json file
   * @param backupPath Full path to the hooks backup file
   */
  static async restoreHooksFromBackup(
    settingsPath: string,
    backupPath: string
  ): Promise<void> {
    try {
      const backupContent = await fs.promises.readFile(backupPath, "utf-8");
      const backupHooks = JSON.parse(backupContent);

      // Read current settings (may have MCP entries we must not touch)
      let settings: Record<string, unknown> = {};
      try {
        settings = JSON.parse(
          await fs.promises.readFile(settingsPath, "utf-8")
        );
      } catch {
        // Settings file gone — nothing to restore into
        await fs.promises.unlink(backupPath).catch(() => {});
        return;
      }

      if (backupHooks === null) {
        // No hooks existed before — remove the key
        delete settings.hooks;
      } else {
        settings.hooks = backupHooks;
      }

      await fs.promises.writeFile(
        settingsPath,
        JSON.stringify(settings, null, 2),
        "utf-8"
      );
      await fs.promises.unlink(backupPath).catch(() => {});
    } catch {
      // Backup doesn't exist — no-op
    }
  }

  /**
   * Get the standard backup path for a tool's hooks backup.
   *
   * @param workspaceRoot Workspace root directory
   * @param backupFileName Backup filename (e.g., 'gemini-hooks-backup.json')
   * @returns Full path to the backup file
   */
  static getHooksBackupPath(
    workspaceRoot: string,
    backupFileName: string
  ): string {
    return path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      backupFileName
    );
  }
}
