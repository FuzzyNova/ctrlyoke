import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { QwenResponseParser } from "./QwenResponseParser";
import { QwenNotificationMonitor } from "./QwenNotificationMonitor";
import { QwenToolPermissionMapper } from "./QwenToolPermissionMapper";
import { QwenLogParser } from "./QwenLogParser";
import { ConfigurationUtils, PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import type { PromptItem } from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

/**
 * Qwen Code CLI Harness
 *
 * Implements all Qwen Code-specific logic using composition pattern:
 * - Process exit detection (headless) + log file monitoring (interactive) for completion
 * - Stream-json output parsing with real-time content extraction
 * - Mode-based tool permission conversion (plan, default, auto-edit, yolo)
 * - Session discovery via log file analysis
 *
 * This provider aggregates four specialized components:
 * - QwenResponseParser: Parses stream-json output and tool calls
 * - QwenNotificationMonitor: Monitors process exit and log files
 * - QwenToolPermissionMapper: Converts permissions to CLI arguments
 * - QwenLogParser: Parses log files for sessions and completion
 *
 * Qwen Code CLI features:
 * - Uses stream-json output format (NDJSON - one JSON object per line)
 * - Session ID from system init or result event
 * - Mode-based permissions (--approval-mode, -y for YOLO)
 * - Supports --continue flag for session continuation
 * - Log files in ~/.qwen/projects/<workspace>/chats/<session-id>.jsonl
 *
 * Usage:
 * ```typescript
 * const provider = new QwenCliProvider();
 * const integration = new CliIntegration(provider, platform, registerWithContext);
 * ```
 */
export class QwenCliProvider implements ICliProvider {
  readonly config: HarnessConfig = {
    name: "qwen",
    displayName: "Qwen Code CLI",
    terminalName: "Qwen Code",
    installHint: "Install via: npm install -g @qwen-code/qwen-code",
    shouldStreamHeadlessOutput: true,

    // Qwen uses log file monitoring for completion detection in interactive mode
    // Process exit is primary for headless mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new QwenResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new QwenNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new QwenToolPermissionMapper();
  readonly logParser = new QwenLogParser();

  /**
   * Build complete CLI arguments array for Qwen Code CLI execution
   *
   * Handles all Qwen-specific arguments including:
   * - Output format (--output-format stream-json for headless)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (--continue for resumption)
   * - Tool permissions (--approval-mode, -y, --allowed-tools, --exclude-tools)
   * - Extra CLI flags from additionalArgs
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param extensionPath Extension installation directory
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for resolved properties
   * @returns Complete CLI arguments array (without prompt - that's handled separately)
   */
  async buildCliArgs(
    _prompt: PromptItem,
    isInteractive: boolean,
    extensionPath: string,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workingFilePath?: string;
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    // Note: Headless-specific flags (--output-format) are added by
    // buildHeadlessArgs() to ensure correct positioning after the prompt argument.

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via prompt prepending in HarnessIntegration.buildPromptText()
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.

    // Add workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(workspaceRoot);
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Session management: Resume with explicit session ID
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );
    if (shouldResume) {
      args.push("--continue", sessionId!);
      Log.debug(`✅ Added continue flag: --continue ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(`🆕 Starting new session`);
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args)
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    // Tool permissions (headless only) / interactive hook setup
    if (!isInteractive) {
      const permissionConfig = {
        mode: ConfigurationUtils.getCliToolPermissions(),
        allowedTools: ConfigurationUtils.getCliAllowedTools(),
        deniedTools: ConfigurationUtils.getCliDeniedTools(),
      };
      const toolPermissionArgs =
        this.toolPermissionMapper.buildArgs(permissionConfig);
      args.push(...toolPermissionArgs);
    } else {
      // Interactive mode: enable experimental hooks and write Stop hook to .qwen/settings.json
      args.push("--experimental-hooks");
      if (workspaceRoot) {
        await this.buildInteractiveHookSettings(extensionPath, workspaceRoot);
        Log.debug(`🔔 Configured Stop hook for Qwen completion detection`);
      }
    }

    Log.debug(`🔧 Qwen CLI arguments: ${JSON.stringify(args)}`);

    return args;
  }

  /**
   * Merge FlightPath hooks into .qwen/settings.json and pre-trust them in
   * ~/.qwen/trusted_hooks.json so Qwen doesn't prompt the user for approval.
   *
   * Backs up the original settings file to .flightpath/temp/qwen-settings-backup.json
   * so cleanupWorkspaceArtifacts() can restore it after the workflow completes.
   * If the backup already exists (multi-prompt workflow), skips the backup step.
   */
  private async buildInteractiveHookSettings(
    extensionPath: string,
    workspaceRoot: string
  ): Promise<void> {
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "flightpath-qwen-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected hook config type for Qwen CLI");
    }

    const qwenDir = path.join(workspaceRoot, ".qwen");
    const settingsPath = path.join(qwenDir, "settings.json");
    const tempDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR
    );
    const backupPath = path.join(tempDir, "qwen-settings-backup.json");

    // Read existing settings (if any)
    let existingSettings: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Back up the original only once (skip if backup already exists for this workflow run)
    try {
      await fs.access(backupPath);
      // Backup exists — already set up by a prior prompt in this workflow
    } catch {
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(
        backupPath,
        JSON.stringify(existingSettings, null, 2),
        "utf-8"
      );
    }

    // Merge FlightPath hooks section into the settings (overwrite hooks key only)
    const mergedSettings = {
      ...existingSettings,
      hooks: (hookConfig.config as Record<string, unknown>)["hooks"],
    };
    await fs.mkdir(qwenDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(mergedSettings, null, 2),
      "utf-8"
    );

    // Pre-trust the hook commands in ~/.qwen/trusted_hooks.json
    // Key format: "${name}:${command}" where name defaults to ""
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");
    const hookCommand = `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`;
    const hookKey = `:${hookCommand}`;

    const globalQwenDir = path.join(os.homedir(), ".qwen");
    const trustedHooksPath = path.join(globalQwenDir, "trusted_hooks.json");

    let trustedHooks: Record<string, string[]> = {};
    try {
      const content = await fs.readFile(trustedHooksPath, "utf-8");
      trustedHooks = JSON.parse(content);
    } catch {
      // File doesn't exist — start fresh
    }

    if (!trustedHooks[workspaceRoot]) {
      trustedHooks[workspaceRoot] = [];
    }
    if (!trustedHooks[workspaceRoot].includes(hookKey)) {
      trustedHooks[workspaceRoot].push(hookKey);
    }

    await fs.mkdir(globalQwenDir, { recursive: true });
    await fs.writeFile(
      trustedHooksPath,
      JSON.stringify(trustedHooks, null, 2),
      "utf-8"
    );
  }

  /**
   * Restore .qwen/settings.json from the backup created by buildInteractiveHookSettings().
   * Called by CliIntegration.cleanupWorkflowArtifacts() after workflow completion.
   */
  async cleanupWorkspaceArtifacts(workspaceRoot: string): Promise<void> {
    const backupPath = path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMP_DIR,
      "qwen-settings-backup.json"
    );
    const settingsPath = path.join(workspaceRoot, ".qwen", "settings.json");

    try {
      const backup = await fs.readFile(backupPath, "utf-8");
      const backupSettings = JSON.parse(backup);

      if (Object.keys(backupSettings).length === 0) {
        // Original settings file didn't exist — remove the one we created
        await fs.unlink(settingsPath).catch(() => {});
      } else {
        await fs.writeFile(settingsPath, backup, "utf-8");
      }
      await fs.unlink(backupPath).catch(() => {});
    } catch {
      // Backup doesn't exist (headless run or no interactive session started)
    }
  }

  /**
   * Validate model is supported by Qwen CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    const defaultModel = ConfigurationUtils.getQwenCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check for "none" sentinel value (skip --model flag)
    if (requestedModel === "none") {
      return undefined;
    }

    // For now, accept any model string - Qwen CLI will validate
    // Future enhancement: maintain a list of known Qwen models
    return requestedModel;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Qwen CLI expects the prompt as a positional argument.
   * Format: qwen "prompt" --output-format stream-json [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.flightpath/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote special characters
    // --output-format stream-json enables structured JSON output for reliable parsing
    return [
      `"${prompt}"`,
      "--output-format",
      "stream-json",
      "--verbose",
      ...baseArgs,
    ];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * Qwen interactive mode: qwen "prompt text" [args...] (no --output-format = interactive)
   * Note: buildCliArgs() already filtered out headless-only flags when isInteractive=true
   *
   * @param baseArgs Base arguments array (from buildCliArgs with isInteractive=true)
   * @param promptText The prompt text to include
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[], promptText: string): string {
    return `${this.config.name} "${promptText.replace(/"/g, '\\"')}" ${baseArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Qwen Code CLI
   *
   * Qwen accepts @path format for file references (same as Copilot).
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path")
   */
  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration arguments (not yet supported by Qwen CLI)
   *
   * Qwen Code CLI does not currently support MCP server configuration.
   * Returns null to indicate MCP is not supported.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow
   * @returns null (MCP not supported)
   */
  async getMcpConfigArgs(
    _mcpServerPath: string,
    _workspaceRoot: string,
    _workingFilePath?: string,
    _additionalEnv?: Record<string, string>
  ): Promise<string[] | null> {
    // MCP not supported by Qwen CLI yet
    return null;
  }

  /**
   * Check if Qwen Code CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("qwen --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Qwen Code CLI version string
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("qwen --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
