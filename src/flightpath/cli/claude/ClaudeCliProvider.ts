import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import * as path from "path";
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { ClaudeResponseParser } from "./ClaudeResponseParser";
import { ClaudeNotificationMonitor } from "./ClaudeNotificationMonitor";
import { ClaudeToolPermissionMapper } from "./ClaudeToolPermissionMapper";
import { CliMcpConfigGenerator } from "../shared/CliMcpConfigGenerator";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { getClaudeModelName } from "../../../utils/ModelConstants";
import { Log } from "../../../utils/Log";

const execAsync = promisify(exec);

/**
 * Claude CLI Provider
 *
 * Implements all Claude-specific logic using composition pattern:
 * - TUI patterns and completion detection (escapeIndicator, chromePatterns)
 * - Stop hook configuration for reliable completion detection
 * - Stream-json output parsing with real-time content extraction
 * - Tool permission conversion with Anthropic tool name format (Bash, Write)
 * - MCP server configuration with "type": "stdio"
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
  readonly config: ProviderConfig = {
    name: "claude",
    displayName: "Claude Code CLI",
    installHint: "Install via: npm install -g @anthropic-ai/claude-code",
    escapeIndicator: "esc to interrupt",
    screenEndPattern: /─{20,}\r?\n\s*(?:⏵⏵|⏸|[>❯])\s*/g,
    chromePatterns: [
      // Claude-specific box drawing and separators
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing characters (8+ in a row = UI chrome)
      /^[─═]{20,}$/, // Long horizontal separators
      /Claude Code v[\d.]+/i, // Header with version

      // Claude ASCII logo (distinctive characters)
      /▐▛███▜▌/, // Logo line 1
      /▝▜█████▛▘/, // Logo line 2

      // Claude welcome and info sections (UI chrome)
      /^Welcome back/i, // Welcome message
      /^Recent activity/i, // Activity header
      /^No recent activity/i, // Empty activity
      /^What's new/i, // Release notes header
      /\/release-notes for more/i, // Navigation hint
      /^Added .* support for/i, // Feature announcements
      /^Added .* tool for/i, // Tool announcements
      /Claude Pro ·.*Organization/i, // Status line with model and account

      // Claude spinner/thinking indicator (UI chrome)
      /^[✻✽✢✶·*]\s*$/, // Spinner alone (any Claude spinner character including *)
      /^[✻✽✢✶·*]\s+.*\((esc to interrupt|ctrl\+c to interrupt).*\)/, // Spinner + text + interrupt hint

      // Claude approval prompts (UI chrome)
      /^Do you want to proceed\?/i, // Approval question
      /^Esc to cancel$/i, // Cancel hint (exact match - distinctive)
      /^❯\s*\d+\./, // Selected option indicator
      /^\s*\d+\.\s+Yes, and don't ask again/i, // Option 2
      /^\s*\d+\.\s+Type here to tell Claude/i, // Option 3

      // Claude UI hints and mode indicators
      /ctrl\+b to run in background/i, // Background hint
      /^[>❯]\s*$/, // Empty prompt line (> or ❯)
      /^\s*⏵⏵\s*$/, // Mode indicator alone (wraps on narrow terminals)
      /^\s*⏸\s*$/, // Pause indicator alone
      /⏵⏵.*\(shift\+tab to cycle\)/, // Mode indicator with full text (accept edits, etc.)
      /⏸.*\(shift\+tab to cycle\)/, // Pause/plan mode indicator with full text
      /^accept edits on \(shift\+tab to cycle\)/i, // Mode text continuation (when wrapped)
      /^\s*\?\s+for shortcuts/i, // Shortcuts hint
    ],
    shouldStreamHeadlessOutput: true,

    // Claude uses Stop hook for reliable completion detection in interactive mode
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new ClaudeResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new ClaudeNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new ClaudeToolPermissionMapper();

  /**
   * Build complete CLI arguments array for Claude CLI execution
   *
   * Handles all Claude-specific arguments including:
   * - MCP configuration (when dynamic queue extension enabled)
   * - Print mode and output format (-p, --output-format stream-json, --verbose)
   * - Model selection (with validation and fallback)
   * - Workspace directories (--add-dir)
   * - Session management (-r resume, -c continue)
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
    prompt: any,
    isInteractive: boolean,
    context: vscode.ExtensionContext,
    workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: any[];
      filePath?: string;
      resolvedProperties?: any; // ResolvedProperties from PropertyResolver
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // Use resolved properties if available (from PropertyResolver three-tier precedence)
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedAgent = workflowContext?.resolvedProperties?.agent;
    const resolvedNewChatSession =
      workflowContext?.resolvedProperties?.newChatSession;

    // MCP configuration (when dynamic queue extension is enabled)
    if (workflowContext && workspaceRoot) {
      const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
      const allowDynamicExtension =
        workflowContext?.resolvedProperties?.allowDynamicExtension ??
        dynamicQueueConfig.enabled;

      if (allowDynamicExtension) {
        const {
          shouldInjectExtensionInstructions,
        } = require("../../../utils/PromptIdentity");
        const shouldInject = shouldInjectExtensionInstructions(
          prompt,
          workflowContext.promptIndex,
          workflowContext.allPrompts,
          dynamicQueueConfig.dynamicExtensionOnLastPrompt,
          allowDynamicExtension
        );

        if (shouldInject) {
          const mcpServerPath = context.asAbsolutePath("out/mcp-server.js");
          const mcpArgs = await this.getMcpConfigArgs(
            mcpServerPath,
            workspaceRoot
          );
          if (mcpArgs) {
            args.push(...mcpArgs);
            // Auto-approve FlightPath MCP tools (FlightPath is the orchestrator)
            // Claude uses mcp__servername pattern to match all tools from a server
            args.push("--allowed-tools", "mcp__flightpath");
            Log.info(
              "🔧 MCP server config added for dynamic queue extension (FlightPath tools auto-approved)"
            );
          }
        }
      }
    }

    // Only add print mode for headless (non-interactive) execution
    // Interactive mode should allow user input, so we skip -p
    if (!isInteractive) {
      args.push("-p");

      // Always use stream-json format with verbose flag for headless mode
      args.push("--output-format", "stream-json");
      args.push("--verbose");
    }

    // Model selection with validation - use resolved property if available
    const model = this.validateAndGetModel(resolvedModel);
    args.push("--model", model);

    // Agent handling - use resolved property if available
    // NOTE: Claude CLI agent support is currently BROKEN (as of v2.1.7):
    // - Agents in .claude/agents/ are NOT automatically loaded (GitHub issue #9930)
    // - The --agent flag does not load agents from .claude/agents/
    // - The --agents JSON flag is intended for "subagents" (different concept)
    // - Workaround requires reading agent file and using --append-system-prompt
    //
    // Keeping minimal code for future when this is fixed
    if (resolvedAgent) {
      Log.warn(
        `⚠️ Claude CLI agent support is currently non-functional (known bug #9930). Agent "${resolvedAgent}" will be ignored.`
      );
      Log.warn(`   See: https://github.com/anthropics/claude-code/issues/9930`);
    }

    // Add workspace directories
    if (workspaceRoot) {
      const workspaceDirs = this.getWorkspaceDirs(workspaceRoot);
      workspaceDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    // Session management - use resolved property if available
    const shouldStartNewSession = resolvedNewChatSession ?? false;
    Log.debug(
      `🔍 Session check (resolved): newChatSession=${resolvedNewChatSession}, shouldStartNewSession=${shouldStartNewSession}, sessionId=${sessionId}`
    );
    if (!shouldStartNewSession && sessionId) {
      args.push("-r", sessionId);
      Log.debug(`✅ Added resume flag: -r ${sessionId}`);
    } else if (!shouldStartNewSession) {
      args.push("-c");
      Log.debug(`✅ Added continue flag: -c`);
    } else {
      Log.debug(
        `🆕 Starting new session (resolved shouldStartNewSession=${shouldStartNewSession})`
      );
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
        const hookSettings = this.buildStopHookSettings(context, workspaceRoot);
        // Wrap JSON in single quotes for shell safety (PowerShell/bash)
        args.push("--settings", `'${hookSettings}'`);
        Log.debug(`🔔 Configured stop hook for completion detection`);
      }
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods

    return args;
  }

  /**
   * Get workspace directories for --add-dir arguments
   */
  private getWorkspaceDirs(workspaceRoot: string): string[] {
    const workspaceDirs: string[] = [];

    // Add primary workspace folder
    if (vscode.workspace.workspaceFolders) {
      vscode.workspace.workspaceFolders.forEach((folder) => {
        workspaceDirs.push(folder.uri.fsPath);
      });
    }

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
   * Validate model is supported by Claude CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = ConfigurationUtils.getClaudeCliModel();

    if (!requestedModel) {
      // Return full model name for default
      const fullName = getClaudeModelName(defaultModel);
      return fullName || defaultModel;
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

    vscode.window.showWarningMessage(`FlightPath: ${message}`);

    const defaultFullName = getClaudeModelName(defaultModel);
    return defaultFullName || defaultModel;
  }

  /**
   * Build settings JSON string with Stop hook configuration
   */
  private buildStopHookSettings(
    context: vscode.ExtensionContext,
    workspaceRoot: string
  ): string {
    const scriptPath = path.join(
      context.extensionPath,
      "out",
      "scripts",
      "flightpath-claude-stop-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot
    );

    // Extract JSON string from hook config (type guard for json-string variant)
    if (hookConfig.type === "json-string") {
      return hookConfig.config;
    }
    throw new Error("Unexpected hook config type for Claude CLI");
  }

  /**
   * Build CLI arguments for headless mode with file reference
   *
   * Claude CLI expects the prompt as the FIRST positional argument (right after command name).
   * This is critical because variadic flags like --disallowedTools will consume any args after them.
   *
   * Format: claude "@path/to/file" -p --output-format stream-json --verbose [other args]
   *
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return [
      `"${promptFileRef}"`,
      "-p", // Print mode (non-interactive)
      "--output-format",
      "stream-json", // JSON streaming for parsing
      "--verbose", // Include detailed information
      ...baseArgs,
    ];
  }

  /**
   * Build CLI arguments for headless mode with direct prompt
   *
   * Simple prompts: pass as FIRST positional argument.
   * Format: claude "your question here" -p --output-format stream-json --verbose [other args]
   *
   * @param baseArgs Base arguments array
   * @param promptText Prompt text
   * @returns Complete arguments array
   */
  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    // Note: Quotes handle spaces and special chars
    return [
      `"${promptText}"`,
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
   * Filters out headless-only flags for interactive mode.
   *
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string {
    // Filter out headless-only flags for interactive mode
    const interactiveArgs = baseArgs.filter(
      (arg, i, arr) =>
        arg !== "-p" &&
        arg !== "--output-format" &&
        arr[i - 1] !== "--output-format"
    );
    return `${this.config.name} ${interactiveArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Claude CLI
   *
   * Claude uses @ prefix for file references (same as Copilot).
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path/to/file.ts")
   */
  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration arguments for Claude CLI
   *
   * Claude CLI uses --mcp-config <file> format.
   * Config file format: JSON with "type": "stdio".
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array with --mcp-config, or null if MCP not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      const fs = require("fs/promises");
      const path = require("path");

      // Generate MCP config JSON using shared utility
      // Claude CLI requires "type": "stdio"
      const configJson = CliMcpConfigGenerator.generateJsonConfig(
        mcpServerPath,
        workspaceRoot,
        { type: "stdio" }
      );

      // Write to temp directory
      const tempDir = path.join(workspaceRoot, ".flightpath", "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const configPath = path.join(tempDir, "mcp-config-claude.json");
      await fs.writeFile(configPath, configJson, "utf-8");

      // Return --mcp-config <file> argument
      return ["--mcp-config", configPath];
    } catch (error) {
      // MCP config generation failed - return null to continue without MCP
      return null;
    }
  }

  /**
   * Check if Claude CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("claude --version");
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
      const { stdout } = await execAsync("claude --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
