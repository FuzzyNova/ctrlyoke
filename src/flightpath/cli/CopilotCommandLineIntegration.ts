import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotStatus } from "../base/CopilotIntegration";
import { BaseCliIntegration, CLI_EXECUTION_MODE } from "./BaseCliIntegration";
import {
  getCliSupportedModelIds,
  isCliModelSupported,
} from "../../utils/ModelRegistry";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

/**
 * Claude CLI tool names that need to be converted to Copilot format
 * Maps Claude tool names (case-insensitive) to Copilot permission patterns
 *
 * Copilot uses permission KINDS (categories), not individual tool names:
 * - shell(command:*?) - Controls powershell, write_powershell, read_powershell, stop_powershell
 * - write - Controls create and edit tools
 * - <mcp-server>(tool?) - Controls MCP server tools
 *
 * Note: Copilot's "view" tool (read files) doesn't require permission - it's always allowed.
 * Similarly, Glob/Grep/LS equivalents don't exist as restricted operations.
 */
const CLAUDE_TO_COPILOT_TOOL_MAP: Record<string, string | null> = {
  // Shell commands - Bash maps to shell category
  bash: "shell",

  // File modification tools - these map to "write" permission category
  write: "write",
  edit: "write",
  multiedit: "write",

  // Read-only tools - no Copilot permission needed (always allowed)
  // These are filtered out because Copilot doesn't restrict read operations
  read: null,
  glob: null,
  grep: null,
  ls: null,

  // Claude-specific tools with no Copilot equivalent
  webfetch: null,
  todowrite: null,
};

/**
 * Copilot CLI Integration
 *
 * Implements Copilot integration using the GitHub Copilot CLI.
 * Provides deterministic completion detection, structured output parsing,
 * and simpler architecture compared to chat window automation.
 *
 * Key advantages:
 * - No UI timing dependencies
 * - Command returns when complete (no polling needed)
 * - Structured output format (response vs. statistics)
 * - Model selection support
 * - Session management for multi-turn conversations
 */
export class CopilotCommandLineIntegration extends BaseCliIntegration {
  private logDirectory?: string;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel
  ) {
    super(context, outputChannel);
    this.initializeLogDirectory();
    this.initialize();
  }

  // ============================================================
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ============================================================

  /**
   * Get the CLI name for terminal/logging
   */
  protected getCliName(): string {
    return "copilot";
  }

  /**
   * Get the escape indicator for Copilot CLI.
   * This text appears while generating and disappears when complete.
   * The TUI shows "Esc to cancel" (capital E, no outer parentheses)
   */
  protected getEscapeIndicator(): string {
    return "Esc to cancel";
  }

  /**
   * Get the screen end pattern for Copilot CLI.
   * Copilot TUI screens end with the status bar: "Ctrl+c Exit · Ctrl+r Expand recent"
   */
  protected getScreenEndPattern(): RegExp {
    return /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi;
  }

  /**
   * Build headless args for Copilot CLI.
   * Copilot reads from stdin when not a TTY, so NO -p flag needed.
   */
  protected buildHeadlessArgs(baseArgs: string[]): string[] {
    // For headless mode with stdin, Copilot reads from stdin automatically
    // No -p flag needed - it detects non-TTY and reads stdin
    return [...baseArgs];
  }

  /**
   * Build interactive TUI command for Copilot CLI.
   * Starts the CLI in interactive mode without a prompt.
   */
  protected buildInteractiveTuiCommand(baseArgs: string[]): string {
    const cliName = this.getCliName();
    // Start in interactive mode - prompt will be sent via sendText
    return `${cliName} ${baseArgs.join(" ")}`;
  }

  /**
   * Get the integration mode for status reporting
   */
  protected getIntegrationMode(): string {
    return Provider.CopilotCli;
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   */
  protected hasFullPermissions(): boolean {
    const toolMode = ConfigurationUtils.getCliToolPermissions();
    const allowAllPaths = ConfigurationUtils.shouldAllowAllPaths();

    return toolMode === "allowAll" && allowAllPaths;
  }

  /**
   * Parse token counts from Copilot CLI statistics string
   * Example statistics: "Total usage est: 1234 prompt + 5678 completion = 6912 total tokens"
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    const match = statistics.match(/(\d+)\s+prompt\s+\+\s+(\d+)\s+completion/);
    if (match) {
      return {
        prompt: parseInt(match[1], 10),
        completion: parseInt(match[2], 10),
      };
    }
    return undefined;
  }

  // ============================================================
  // COPILOT-SPECIFIC CONFIGURATION
  // ============================================================

  /**
   * Initialize log directory for session ID tracking
   * Uses configured directory or falls back to OS temp directory + FlightPath subdirectory
   */
  private initializeLogDirectory(): void {
    // Check if user has configured a custom log directory
    const configuredDir = ConfigurationUtils.getCopilotCliLogDir();

    if (configuredDir) {
      this.logDirectory = configuredDir;
    } else {
      // Fallback: Create FlightPath-specific log directory in OS temp folder
      // Cross-platform: works on Windows (C:\Users\{user}\AppData\Local\Temp), macOS/Linux (/tmp)
      this.logDirectory = path.join(os.tmpdir(), "flightpath-copilot-logs");
    }
    this.log(`📁 Log directory set to: ${this.logDirectory}`);
  }

  /**
   * Initialize CLI integration by checking if copilot CLI is available
   */
  async initialize(): Promise<void> {
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    try {
      // Check if CLI is available by running --version
      const result = await this.spawnSimpleCommand(
        this.getCliName(),
        ["--version"],
        5000
      );

      if (result.exitCode === 0) {
        console.log("✅ Copilot CLI available:", result.stdout.trim());
        this.isAvailable = true;
        this.initializationStatus = CopilotStatus.Ready;
        this.statusChangeEmitter.fire(CopilotStatus.Ready);
      } else {
        console.error("❌ Copilot CLI not found or not working");
        this.isAvailable = false;
        this.initializationStatus = CopilotStatus.Unavailable;
        this.statusChangeEmitter.fire(CopilotStatus.Unavailable);
      }
    } catch (error) {
      console.error("❌ Error checking Copilot CLI:", error);
      this.isAvailable = false;
      this.initializationStatus = CopilotStatus.Unavailable;
      this.statusChangeEmitter.fire(CopilotStatus.Unavailable);
    }
  }

  /**
   * Send prompt to Copilot via CLI
   * Routes to interactive terminal or headless execution based on settings
   * @param needsCompletionDetection Ignored for CLI mode (completion is deterministic)
   * @param workflowContext Optional workflow context for dynamic queue instructions
   */
  async sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection: boolean = true,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    if (!this.isAvailable) {
      console.error(
        "❌ FlightPath: Cannot send prompt - Copilot CLI not available"
      );
      vscode.window.showErrorMessage(
        "FlightPath: Copilot CLI is not available. Please install it first."
      );
      return false;
    }

    const mode = this.getExecutionMode();

    // Warn if headless mode without full permissions
    if (mode === CLI_EXECUTION_MODE.HEADLESS && !this.hasFullPermissions()) {
      vscode.window.showWarningMessage(
        "Headless mode without full permissions: CLI will auto-deny tool/file access. Workflow may not make progress."
      );
    }

    try {
      // Build prompt text with dynamic queue instructions if applicable
      const promptText = workflowContext
        ? await this.buildPromptWithInstructions(
            prompt,
            workflowContext.promptIndex,
            workflowContext.allPrompts,
            workflowContext.filePath
          )
        : await this.buildPromptText(prompt);

      // Store the full prompt for dashboard display
      this.lastFullPrompt = promptText;

      // Log the prompt being sent
      this.logPrompt(promptText);

      // Build CLI arguments (without prompt - handled by execution methods)
      const args = this.buildCliArgs(prompt);

      // Store full command for debugging (will be updated by execution methods)
      this.lastCliCommand = `${this.getCliName()} -p "<prompt>" ${args.join(" ")}`;

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Route based on execution mode
      if (mode === CLI_EXECUTION_MODE.INTERACTIVE) {
        return await this.executeInteractive(args, promptText);
      } else {
        return await this.executeHeadless(args, promptText);
      }
    } catch (error) {
      console.error("❌ CLI execution error:", error);
      this.lastFailureReason =
        error instanceof Error
          ? error.message
          : "Failed to execute Copilot CLI";
      vscode.window.showErrorMessage(
        `FlightPath: Failed to execute Copilot CLI: ${error}`
      );
      return false;
    }
  }

  /**
   * Build CLI arguments for Copilot command (without prompt - handled separately)
   * @param prompt The prompt item
   */
  private buildCliArgs(prompt: PromptItem): string[] {
    const args: string[] = [];

    // Tool permissions
    const toolPermissions = this.getToolPermissionArgs();
    args.push(...toolPermissions);

    // Path permissions
    if (this.shouldAllowAllPaths()) {
      args.push("--allow-all-paths");
    }

    // Logging
    if (this.logDirectory) {
      args.push("--log-dir", this.logDirectory);
    }
    const logLevelArgs = this.getLogLevelArgs();
    args.push(...logLevelArgs);

    // Workspace directories
    const workspaceDirs = this.getWorkspaceDirs();
    workspaceDirs.forEach((dir) => {
      args.push("--add-dir", dir);
    });

    // Model
    const model = this.validateAndGetModel(prompt.model);
    if (model) {
      args.push("--model", model);
    }

    // Agent handling
    if (prompt.agent) {
      const agentName = prompt.agent.endsWith(".agent")
        ? prompt.agent
        : `${prompt.agent}.agent`;
      args.push("--agent", agentName);
      this.log(`🤖 Using agent: ${agentName}`);
    }

    // Session resumption
    if (prompt.newChatSession === false && this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // Note: Prompt is NOT included here - it's handled separately by the execution methods
    // This allows using temp file approach for interactive mode and direct args for headless mode

    return args;
  }

  /**
   * Execute in interactive terminal mode
   * Uses temp file approach via base class to avoid shell escaping issues
   */
  private async executeInteractive(
    args: string[],
    promptText: string
  ): Promise<boolean> {
    // Use base class executeInTerminal (buildArgsWithPrompt handles -p flag)
    const success = await this.executeInTerminal(args, promptText);

    if (success) {
      // Extract session ID for future resumption
      const sessionId = await this.extractSessionIdFromLogs();
      if (sessionId) {
        this.sessionId = sessionId;
        this.log(`💾 Session ID extracted: ${sessionId}`);
      }
      await this.updateWorkflowProgress();
    }

    return success;
  }

  /**
   * Execute in headless mode (background process)
   * Uses stdin to pass the prompt (no -p flag, no temp files)
   */
  private async executeHeadless(
    args: string[],
    promptText: string
  ): Promise<boolean> {
    return this.executeHeadlessWithStdin(
      args,
      promptText,
      async (result: { stdout: string; stderr: string; exitCode: number }) => {
        // Parse the CLI output
        const cliResult = this.parseCliOutput(
          result.stdout,
          result.stderr,
          result.exitCode
        );

        // Check if this was a cancellation
        if (this.isCancelling) {
          console.log("⏹️ Prompt execution cancelled by user");
          return false;
        }

        // Store the result for statistics retrieval
        this.lastResult = cliResult;

        // Extract and store session ID
        const sessionId = await this.extractSessionIdFromLogs();
        if (sessionId) {
          this.sessionId = sessionId;
          this.log(`💾 Session ID extracted: ${sessionId}`);
        }

        if (cliResult.success) {
          this.logResponse(cliResult.response, cliResult.statistics);
          this.responseCompleteEmitter.fire(cliResult.response);
          await this.updateWorkflowProgress();
          return true;
        } else {
          console.error("❌ Copilot CLI failed:", cliResult.error);
          this.lastFailureReason = `Copilot CLI error: ${cliResult.error}`;
          vscode.window.showErrorMessage(
            `FlightPath: Copilot CLI error: ${cliResult.error}`
          );
          return false;
        }
      }
    );
  }

  /**
   * Parse CLI output into a structured result
   */
  private parseCliOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult {
    // Handle agent-specific errors with helpful messages
    // Note: We don't have direct access to args here, so we can't check for agent
    // This will be handled by the caller if needed

    // Parse output to separate response from statistics
    const { response, statistics } = this.parseCliOutputParts(stdout);

    return {
      success: exitCode === 0,
      response,
      statistics,
      error: exitCode !== 0 ? stderr || undefined : undefined,
      exitCode,
    };
  }

  /**
   * Parse CLI output to separate response from statistics
   */
  private parseCliOutputParts(output: string): {
    response: string;
    statistics: string;
  } {
    // Split on statistics section (starts with "Total usage est:")
    // Use lookbehind to preserve the statistics marker
    const parts = output.split(/\n\n(?=Total usage est:)/);

    return {
      response: parts[0]?.trim() || "",
      statistics: parts[1]?.trim() || "",
    };
  }

  /**
   * Get configured AI model
   */
  private getConfiguredModel(): string {
    return ConfigurationUtils.getCliModel();
  }

  /**
   * Validate model is supported by CLI, fallback to default if not
   * Uses dynamically discovered models from 'copilot --help' output
   * Shows user-friendly warning when unsupported model requested
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = this.getConfiguredModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check if model is supported by CLI (using dynamically discovered models)
    if (isCliModelSupported(requestedModel)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const supportedModels = getCliSupportedModelIds();
    const message = `Model "${requestedModel}" not supported by Copilot CLI. Using default: ${defaultModel}`;
    this.log(`⚠️ ${message}`);

    vscode.window.showWarningMessage(
      `FlightPath: ${message}\n\nCLI-supported models: ${supportedModels.join(", ")}`
    );

    return defaultModel;
  }

  /**
   * Convert a tool pattern from Claude format to Copilot format
   * Returns the converted pattern, or null if the tool should be filtered out
   *
   * Examples:
   * - "Bash(git:*)" → "shell(git:*)"
   * - "bash" → "shell"
   * - "Write" → "write"
   * - "Edit" → "write" (closest equivalent)
   * - "Read" → null (no Copilot equivalent, filter out)
   * - "github(search)" → "github(search)" (MCP tools pass through)
   */
  private convertToolPatternToCopilotFormat(pattern: string): string | null {
    // Match pattern: toolName or toolName(args)
    const match = pattern.match(/^(\w+)(\(.+\))?$/);
    if (!match) {
      return pattern; // Return as-is if pattern doesn't match expected format (e.g., MCP tools)
    }

    const [, toolName, args] = match;
    const lowerToolName = toolName.toLowerCase();

    // Check if this is a Claude tool that needs conversion
    if (lowerToolName in CLAUDE_TO_COPILOT_TOOL_MAP) {
      const copilotTool = CLAUDE_TO_COPILOT_TOOL_MAP[lowerToolName];
      if (copilotTool === null) {
        // Tool has no Copilot equivalent, filter it out
        return null;
      }
      return args ? copilotTool + args : copilotTool;
    }

    // Not a Claude tool, pass through as-is (could be shell, write, or MCP tool)
    return pattern;
  }

  /**
   * Get tool permission arguments based on configuration
   * Supports "allowAll" mode (--allow-all-tools) or "custom" mode with specific allow/deny patterns
   *
   * Pattern syntax:
   * - shell(command:*?) - Match shell commands (e.g., shell(git:*), shell(npm test))
   * - write - Match file creation/modification tools
   * - <mcp-server>(tool?) - Match MCP server tools (e.g., github, github(search_repositories))
   *
   * Claude tools are automatically converted or filtered:
   * - Bash → shell, Write/Edit/MultiEdit → write
   * - Read/Glob/Grep/LS/WebFetch → filtered out (no Copilot equivalent)
   */
  private getToolPermissionArgs(): string[] {
    const mode = ConfigurationUtils.getCliToolPermissions();

    if (mode === "allowAll") {
      return ["--allow-all-tools"];
    }

    // Custom mode - use specific allow/deny patterns
    const args: string[] = [];
    const filteredTools: string[] = [];

    const allowedTools = ConfigurationUtils.getCliAllowedTools();
    const deniedTools = ConfigurationUtils.getCliDeniedTools();

    // Track which tools we've already added to avoid duplicates
    // (e.g., both "Edit" and "Write" map to "write")
    const addedAllowTools = new Set<string>();
    const addedDenyTools = new Set<string>();

    // Add allowed tool patterns (with conversion)
    allowedTools.forEach((tool) => {
      const converted = this.convertToolPatternToCopilotFormat(tool);
      if (converted === null) {
        filteredTools.push(tool);
      } else if (!addedAllowTools.has(converted)) {
        args.push("--allow-tool", converted);
        addedAllowTools.add(converted);
      }
    });

    // Add denied tool patterns (with conversion)
    deniedTools.forEach((tool) => {
      const converted = this.convertToolPatternToCopilotFormat(tool);
      if (converted === null) {
        filteredTools.push(tool);
      } else if (!addedDenyTools.has(converted)) {
        args.push("--deny-tool", converted);
        addedDenyTools.add(converted);
      }
    });

    // Log filtered tools for visibility
    if (filteredTools.length > 0) {
      this.log(
        `ℹ️ Filtered out tools not requiring Copilot permission: ${filteredTools.join(", ")} (read-only operations are always allowed)`
      );
    }

    // If no patterns specified in custom mode, log a warning
    if (args.length === 0) {
      this.log(
        "⚠️ Custom tool permissions mode enabled but no tools specified. Copilot will prompt for each tool."
      );
    }

    return args;
  }

  /**
   * Get log level arguments based on configuration
   */
  private getLogLevelArgs(): string[] {
    const logLevel = ConfigurationUtils.getCopilotCliLogLevel();

    if (logLevel !== "default") {
      return ["--log-level", logLevel];
    }

    return [];
  }

  /**
   * Check if all paths should be allowed (no interactive prompts)
   */
  private shouldAllowAllPaths(): boolean {
    return ConfigurationUtils.shouldAllowAllPaths();
  }

  /**
   * Get integration status
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message: "✅ Copilot CLI available",
        strategy: Provider.CopilotCli,
      };
    } else {
      return {
        available: false,
        message:
          "❌ Copilot CLI unavailable - please install GitHub Copilot CLI",
        strategy: Provider.CopilotCli,
      };
    }
  }

  /**
   * Extract session ID from log file name in log directory
   * Log files are named: session-{GUID}.log
   * Example: session-53b8fdf5-3aed-4dac-8953-822830d748e0.log
   * Returns the most recently created session log file's GUID
   */
  private async extractSessionIdFromLogs(): Promise<string | undefined> {
    if (!this.logDirectory) {
      return undefined;
    }

    try {
      // Ensure log directory exists
      await fs.mkdir(this.logDirectory, { recursive: true });

      // Read all files in log directory
      const files = await fs.readdir(this.logDirectory);

      // Filter for session log files (session-{GUID}.log)
      const sessionFiles = files.filter((file) =>
        file.match(/^session-[a-f0-9\-]+\.log$/i)
      );

      if (sessionFiles.length === 0) {
        return undefined;
      }

      // Get file stats to find most recent
      const fileStats = await Promise.all(
        sessionFiles.map(async (file) => {
          const filePath = path.join(this.logDirectory!, file);
          const stats = await fs.stat(filePath);
          return { file, mtime: stats.mtime };
        })
      );

      // Sort by modification time (most recent first)
      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Extract GUID from filename: session-{GUID}.log
      const match = fileStats[0].file.match(/^session-([a-f0-9\-]+)\.log$/i);
      if (match && match[1]) {
        return match[1];
      }

      return undefined;
    } catch (error) {
      console.error("❌ Failed to extract session ID from logs:", error);
      return undefined;
    }
  }
}
