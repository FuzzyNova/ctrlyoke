import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { ICliProvider, HarnessConfig, CLI_VERSION_CHECK_TIMEOUT_MS } from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { ClaudeResponseParser } from "./ClaudeResponseParser";
import { ClaudeNotificationMonitor } from "./ClaudeNotificationMonitor";
import { ClaudeToolPermissionMapper } from "./ClaudeToolPermissionMapper";
import { ClaudeLogParser } from "./ClaudeLogParser";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { ConfigurationUtils, PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";
import { getClaudeModelName, MODEL_NONE } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import type { PromptItem } from "../../../types/FlightPathTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";

const execAsync = promisify(exec);

/**
 * Claude CLI Harness
 *
 * Implements all Claude-specific logic using composition pattern:
 * - Log file monitoring and Stop hook for completion detection
 * - Stream-json output parsing with real-time content extraction
 * - Tool permission conversion with Anthropic tool name format (Bash, Write)
 * - MCP server configuration with "type": "stdio"
 * - Session discovery via log file analysis
 *
 * This provider aggregates four specialized components:
 * - ClaudeResponseParser: Parses stream-json output and tool calls
 * - ClaudeNotificationMonitor: Monitors Stop hook notifications
 * - ClaudeToolPermissionMapper: Converts permissions to CLI arguments
 * - CliMcpConfigGenerator: Generates MCP configuration files (shared)
 *
 * Usage:
 * ```typescript
 * const provider = new ClaudeCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class ClaudeCliProvider implements ICliProvider {
  readonly config: HarnessConfig = {
    name: "claude",
    displayName: "Claude Code CLI",
    terminalName: "Claude",
    installHint: "Install via: npm install -g @anthropic-ai/claude-code",
    shouldStreamHeadlessOutput: true,

    // Claude uses Stop hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new ClaudeResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new ClaudeNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new ClaudeToolPermissionMapper();
  readonly logParser = new ClaudeLogParser();

  /**
   * Build complete CLI arguments array for Claude CLI execution
   *
   * Handles all Claude-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Print mode and output format (-p, --output-format stream-json, --verbose)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (-r resume with explicit session ID only, no -c flag)
   * - Tool permissions (headless mode only)
   * - Stop hook settings (interactive mode only)
   *
   * @param prompt The prompt item with model/agent/session settings
   * @param isInteractive Whether this is interactive TUI or headless mode
   * @param context Extension context for accessing scripts/paths
   * @param workspaceRoot Workspace root directory
   * @param sessionId Current session ID for resumption (if any)
   * @param workflowContext Optional workflow context for MCP configuration
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

    // MCP configuration (when dynamic queue extension is enabled)
    const mcpArgs = await CliProviderUtils.buildMcpConfigBlock(
      workflowContext,
      workspaceRoot,
      extensionPath,
      (serverPath, wsRoot, workingFile, additionalEnv, userServers) =>
        this.getMcpConfigArgs(serverPath, wsRoot, workingFile, additionalEnv, userServers)
    );
    if (mcpArgs.length > 0) {
      args.push(...mcpArgs);
      // Auto-approve FlightPath MCP tools (FlightPath is the orchestrator)
      // Claude uses mcp__servername pattern to match all tools from a server
      args.push("--allowed-tools", "mcp__flightpath");
      Log.debug("🔧 FlightPath MCP tools auto-approved");
    }

    // Note: Headless-specific flags (-p, --output-format, --verbose) are added by
    // buildHeadlessArgs() to ensure correct positioning after the prompt argument.
    // Don't add them here to avoid duplication.

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling is done via buildPromptSections() → createCategorizedPromptFiles().
    // AgentExpander reads the agent file and injects <agentInstructions> into the prompt.
    // This fixes the previously broken Claude CLI --agent flag (GitHub issue #9930).

    // Add workspace directories
    if (workspaceRoot) {
      const workspaceDirs = CliProviderUtils.getWorkspaceDirs(workspaceRoot);
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Session management: Resume with explicit session ID only
    // NOTE: We don't use the `-c` flag (continue most recent session) because:
    // 1. It's global across all projects, not workspace-specific
    // 2. Could accidentally resume a session from a different project
    // 3. No guarantee which session it will resume if user has multiple Claude instances
    // Instead, we only resume when resumeSession is true AND we have an explicit session ID.
    const shouldResume = CliProviderUtils.shouldResumeSession(
      resolvedResumeSession,
      sessionId
    );
    Log.debug(
      `🔍 Session check (resolved): resumeSession=${resolvedResumeSession}, sessionId=${sessionId ?? "none"}, shouldResume=${shouldResume}`
    );
    if (shouldResume) {
      args.push("-r", sessionId!);
      Log.debug(`✅ Added resume flag: -r ${sessionId}`);
    } else if (resolvedResumeSession && !sessionId) {
      Log.debug(`⚠️ Resume requested but no session ID available`);
    } else {
      Log.debug(`🆕 Starting new session`);
    }

    // Extra CLI flags from additionalArgs (injected before tool permission args).
    // IMPORTANT: Must come before tool permissions — Claude's --disallowedTools is variadic
    // and will consume any flags that follow it.
    const appendTokens = parseArgString(
      workflowContext?.resolvedProperties?.additionalArgs ?? ""
    );
    if (appendTokens.length > 0) {
      args.push(...appendTokens);
      Log.info(`Extra CLI args applied (${appendTokens.length} tokens)`);
    }

    // Tool permissions (only for headless mode - interactive mode lets user approve interactively)
    // IMPORTANT: This MUST come after session management because --disallowedTools is variadic
    // and will consume any flags after it (including -r <sessionId>)
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
      // Interactive mode: Configure stop hook for completion detection
      if (workspaceRoot) {
        const hookSettingsPath = await this.buildStopHookSettings(
          extensionPath,
          workspaceRoot
        );
        args.push("--settings", hookSettingsPath);
        Log.debug(`🔔 Configured stop hook for completion detection`);
      }
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods

    return args;
  }

  /**
   * Validate model is supported by Claude CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string | undefined {
    const defaultModel = ConfigurationUtils.getClaudeCliModel();

    if (!requestedModel) {
      // Return full model name for default
      const fullName = getClaudeModelName(defaultModel);
      return fullName || defaultModel;
    }

    if (requestedModel === MODEL_NONE) {
      return undefined;
    }

    // Try to look up the model in our comprehensive map
    const fullModelName = getClaudeModelName(requestedModel);
    if (fullModelName) {
      return fullModelName;
    }

    // Model not recognized - warn user and fallback
    const supportedFormats =
      "aliases (sonnet, opus, haiku), generic names (claude-sonnet-4.5), or full names";
    const message = `Model "${requestedModel}" not recognized for Claude CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);
    Log.warn(`   Accepted formats: ${supportedFormats}`);

    const defaultFullName = getClaudeModelName(defaultModel);
    return defaultFullName || defaultModel;
  }

  /**
   * Write stop hook settings JSON to a temp file and return its path.
   * Claude CLI's --settings flag requires a file path, not inline JSON.
   */
  private async buildStopHookSettings(
    extensionPath: string,
    workspaceRoot: string
  ): Promise<string> {
    const fs = require("fs/promises");

    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "flightpath-claude-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot
    );

    // Extract JSON string from hook config (type guard for json-string variant)
    if (hookConfig.type !== "json-string") {
      throw new Error("Unexpected hook config type for Claude CLI");
    }

    const tempDir = path.join(workspaceRoot, PATH_CONSTANTS.FLIGHTPATH_DIR, PATH_CONSTANTS.TEMP_DIR);
    await fs.mkdir(tempDir, { recursive: true });
    const settingsPath = path.join(tempDir, "claude-hook-settings.json");
    await fs.writeFile(settingsPath, hookConfig.config, "utf-8");
    return settingsPath;
  }

  /**
   * Build CLI arguments for headless mode
   *
   * Claude CLI expects the prompt as the FIRST positional argument (right after command name).
   * This is critical because variadic flags like --disallowedTools will consume any args after them.
   *
   * Format: claude "prompt" -p --output-format stream-json --verbose [other args]
   *
   * Handles both direct prompts and file references (e.g., "@.flightpath/temp/prompt.md")
   *
   * @param baseArgs Base arguments array
   * @param prompt Prompt text or file reference
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return [
      `"${prompt}"`,
      "-p", // Print mode (non-interactive)
      "--output-format",
      "stream-json", // JSON streaming for parsing
      "--verbose", // Include detailed information
      ...baseArgs,
    ];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * Claude interactive mode: claude "prompt text" [args...] (no -p flag = interactive)
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
   * Generate MCP server configuration arguments for Claude CLI
   *
   * Claude CLI uses --mcp-config <file> format.
   * Config file format: JSON with "type": "stdio".
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @param workingFilePath Active working file for this workflow (sets FLIGHTPATH_WORKING_FILE)
   * @returns CLI arguments array with --mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string,
    workingFilePath?: string,
    additionalEnv?: Record<string, string>,
    userServers?: import("../../../types/FlightPathTypes").McpServerConfig[]
  ): Promise<string[] | null> {
    try {
      const fs = require("fs/promises");

      // Generate MCP config JSON using shared utility
      // Claude CLI requires "type": "stdio"
      const configJson = userServers && userServers.length > 0
        ? CliMcpConfigGenerator.generateJsonConfigWithUserServers(
            mcpServerPath,
            workspaceRoot,
            userServers,
            { type: "stdio" },
            workingFilePath,
            additionalEnv
          )
        : CliMcpConfigGenerator.generateJsonConfig(
            mcpServerPath,
            workspaceRoot,
            { type: "stdio" },
            workingFilePath,
            additionalEnv
          );

      // Write to temp directory — use unique name per execution to avoid parallel workflow collisions
      const configPath = this.getMcpConfigFilePath(
        workingFilePath,
        workspaceRoot
      )!;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, configJson, "utf-8");

      // Return --mcp-config <file> argument
      return ["--mcp-config", configPath];
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return null;
    }
  }

  /**
   * Return the path of the MCP config file this provider writes.
   * Used by CliIntegration to delete the file after the workflow finishes.
   */
  getMcpConfigFilePath(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): string {
    return CliMcpConfigGenerator.getConfigFilePath(
      workingFilePath,
      workspaceRoot,
      "mcp-config-claude"
    );
  }

  /**
   * Unset CLAUDECODE so Claude CLI doesn't refuse to start inside an active session.
   */
  getInteractiveSpawnEnv(): NodeJS.ProcessEnv {
    const env = CliProviderUtils.buildProcessEnv();
    delete env.CLAUDECODE;
    return env;
  }

  /**
   * Check if Claude CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("claude --version", { timeout: CLI_VERSION_CHECK_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Claude CLI version string
   *
   * @returns Version string if available, undefined if error
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("claude --version", { timeout: CLI_VERSION_CHECK_TIMEOUT_MS });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
