import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { BaseCliIntegration, CLI_EXECUTION_MODE } from "./BaseCliIntegration";
import {
  getCliSupportedModelIds,
  isCliModelSupported,
} from "../../utils/ModelRegistry";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";

/**
 * Maps Claude tool names to Copilot permission categories.
 * Copilot uses permission KINDS (shell, write, <mcp-server>) not individual tools.
 * Read-only tools (read, glob, grep, ls) map to null (always allowed in Copilot).
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
 * GitHub Copilot CLI Integration
 *
 * CLI-specific features:
 * - Log directory for session ID tracking
 * - Statistics parsing: "Total usage est: X prompt + Y completion"
 * - Tool permission conversion from Claude format
 */
export class CopilotCommandLineIntegration extends BaseCliIntegration {
  private logDirectory?: string;

  constructor(context: vscode.ExtensionContext) {
    super(context);
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

  protected getEscapeIndicator(): string {
    return "Esc to cancel";
  }

  protected getTuiChromePattern(): RegExp {
    // Copilot's status bar at the bottom: "Ctrl+c Exit · Ctrl+r Expand recent"
    return /Ctrl\+c Exit/i;
  }

  protected getScreenEndPattern(): RegExp {
    return /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi;
  }

  protected buildHeadlessArgs(
    baseArgs: string[],
    promptFileRef: string
  ): string[] {
    // Copilot requires --prompt flag to specify agents and pass file references
    // Format: copilot --prompt "@path/to/file" [other args]
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return ["--prompt", `"${promptFileRef}"`, ...baseArgs];
  }

  protected buildInteractiveTuiCommand(baseArgs: string[]): string {
    return `${this.getCliName()} ${baseArgs.join(" ")}`;
  }

  protected getIntegrationMode(): string {
    return Provider.CopilotCli;
  }

  protected getCliDisplayName(): string {
    return "Copilot CLI";
  }

  protected getInstallHint(): string {
    return "run: npm install -g @github/copilot";
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Full permissions require: allowAll tools mode, allowAllPaths, and NO deny patterns
   */
  protected hasFullPermissions(): boolean {
    const toolMode = ConfigurationUtils.getCliToolPermissions();
    const allowAllPaths = ConfigurationUtils.shouldAllowAllPaths();
    const deniedTools = ConfigurationUtils.getCliDeniedTools();

    // Full permissions only if allowAll mode, all paths allowed, and no deny patterns
    return toolMode === "allowAll" && allowAllPaths && deniedTools.length === 0;
  }

  /**
   * Parse token counts from Copilot CLI statistics string
   *
   * Format (as of 2025-12):
   * "Usage by model:
   *     capi-...-gpt-5-mini-... 25.7k input, 223 output, 6.1k cache read (Est. 1 Premium request)"
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    // Parse format: "25.7k input, 223 output"
    // The regex captures number (with optional decimal) and checks for k suffix separately
    const match = statistics.match(
      /([\d.]+)(k)?\s+input,\s+([\d.]+)(k)?\s+output/i
    );
    if (!match) {
      return undefined;
    }

    const parseValue = (
      numStr: string,
      hasSuffix: string | undefined
    ): number => {
      const num = parseFloat(numStr);
      // If suffix exists (captured as 'k'), multiply by 1000
      return hasSuffix ? Math.round(num * 1000) : num;
    };

    return {
      prompt: parseValue(match[1], match[2]),
      completion: parseValue(match[3], match[4]),
    };
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
    Log.info(`📁 Log directory set to: ${this.logDirectory}`);
  }

  // Uses base class initialize() method
  // Context expansion now handled by ContextExpander utility (no override needed)

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
      Log.error(
        "❌ FlightPath: Cannot send prompt - Copilot CLI not available"
      );
      vscode.window.showErrorMessage(
        "FlightPath: Copilot CLI is not available. Please install it first."
      );
      return false;
    }

    // Warn if headless mode without full permissions
    this.warnIfHeadlessWithoutPermissions();

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

      // Route based on execution mode
      const mode = this.getExecutionMode();
      const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;

      // Build CLI arguments (without prompt - handled by execution methods)
      const args = this.buildCliArgs(prompt, isInteractive);

      // Store full command for debugging (will be updated by execution methods)
      this.lastCliCommand = `${this.getCliName()} -p "<prompt>" ${args.join(" ")}`;

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Execute based on mode
      if (isInteractive) {
        return await this.executeInteractive(args, promptText, workflowContext);
      } else {
        return await this.executeHeadless(args, promptText, workflowContext);
      }
    } catch (error) {
      Log.error("❌ CLI execution error", error);
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
   * @param isInteractive Whether this is interactive mode (skips tool permissions)
   */
  private buildCliArgs(
    prompt: PromptItem,
    isInteractive: boolean = false
  ): string[] {
    const args: string[] = [];

    // Tool permissions (only for headless mode - interactive mode lets user approve interactively)
    if (!isInteractive) {
      const toolPermissions = this.getToolPermissionArgs();
      args.push(...toolPermissions);
    }

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
      Log.info(`🤖 Using agent: ${agentName}`);
    }

    // Session resumption
    if (prompt.newChatSession === false && this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // Note: Prompt is NOT included here - it's handled separately by the execution methods
    // This allows using temp file approach for interactive mode and direct args for headless mode

    Log.debug(`🔧 CLI arguments: ${JSON.stringify(args)}`);

    return args;
  }

  /**
   * Execute in interactive terminal mode
   * Uses temp file approach via base class to avoid shell escaping issues
   */
  private async executeInteractive(
    args: string[],
    promptText: string,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    // Use base class executeInTerminal (passes workflow context for temp file naming)
    const success = await this.executeInTerminal(
      args,
      promptText,
      workflowContext
    );

    if (success) {
      // Extract session ID for future resumption
      const sessionId = await this.extractSessionIdFromLogs();
      if (sessionId) {
        this.sessionId = sessionId;
        Log.debug(`💾 Session ID extracted: ${sessionId}`);
      }
      await this.updateWorkflowProgress();
    }

    return success;
  }

  /**
   * Execute in headless mode (background process)
   * Uses temp file parameter to pass the prompt (--prompt @file)
   */
  private async executeHeadless(
    args: string[],
    promptText: string,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    return this.executeHeadlessWithPromptFile(
      args,
      promptText,
      workflowContext,
      async (result: { stdout: string; stderr: string; exitCode: number }) => {
        // Parse the CLI output
        const cliResult = this.parseCliOutput(
          result.stdout,
          result.stderr,
          result.exitCode
        );

        // Check if this was a cancellation
        if (this.isCancelling) {
          Log.info("⏹️ Prompt execution cancelled by user");
          return false;
        }

        // Store the result for statistics retrieval
        this.lastResult = cliResult;

        // Extract and store session ID
        const sessionId = await this.extractSessionIdFromLogs();
        if (sessionId) {
          this.sessionId = sessionId;
          Log.debug(`💾 Session ID extracted: ${sessionId}`);
        }

        if (cliResult.success) {
          this.logResponse(cliResult.response, cliResult.statistics);
          this.responseCompleteEmitter.fire(cliResult.response);
          await this.updateWorkflowProgress();
          return true;
        } else {
          Log.error("❌ Copilot CLI failed", new Error(cliResult.error));
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
   * Validate model is supported by CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = ConfigurationUtils.getCliModel();

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
    Log.warn(`⚠️ ${message}`);

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
    const parsed = this.parseToolPattern(pattern);
    if (!parsed) {
      return pattern; // Return as-is (e.g., MCP tools)
    }

    const [toolName, args] = parsed;
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
   * Supports three modes:
   * - "dangerouslyAllowAll": --allow-all-tools with NO deny patterns (bypasses all restrictions)
   * - "allowAll": --allow-all-tools with deny patterns (safe automation, recommended)
   * - "custom": Specific allow patterns with deny patterns
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
    const args: string[] = [];
    const filteredTools: string[] = [];

    // Add allow mode first
    if (mode === "dangerouslyAllowAll" || mode === "allowAll") {
      args.push("--allow-all-tools");
    } else {
      // Custom mode - use specific allow patterns
      const allowedTools = ConfigurationUtils.getCliAllowedTools();
      const convertedAllowTools: string[] = [];

      allowedTools.forEach((tool) => {
        const converted = this.convertToolPatternToCopilotFormat(tool);
        if (converted === null) {
          filteredTools.push(tool);
        } else if (!convertedAllowTools.includes(converted)) {
          convertedAllowTools.push(converted);
        }
      });

      // Add all allowed tools as variadic arguments to single --allow-tool flag
      // Quote each pattern to handle spaces and special characters (shell: true in spawn)
      if (convertedAllowTools.length > 0) {
        const quotedTools = convertedAllowTools.map((tool) => `"${tool}"`);
        args.push("--allow-tool", ...quotedTools);
        Log.info(`✅ Allowed tools: ${convertedAllowTools.join(", ")}`);
      } else if (allowedTools.length > 0) {
        // No valid allow patterns after conversion
        Log.warn(
          "⚠️ Custom tool permissions mode enabled but no valid tools specified. Copilot will prompt for each tool."
        );
      }
    }

    // Add denied tool patterns (unless dangerouslyAllowAll mode)
    // In dangerouslyAllowAll mode, we skip deny patterns entirely
    if (mode !== "dangerouslyAllowAll") {
      const deniedTools = ConfigurationUtils.getCliDeniedTools();
      const convertedDenyTools: string[] = [];

      deniedTools.forEach((tool) => {
        const converted = this.convertToolPatternToCopilotFormat(tool);
        if (converted === null) {
          filteredTools.push(tool);
        } else if (!convertedDenyTools.includes(converted)) {
          convertedDenyTools.push(converted);
        }
      });

      // Add all denied tools as variadic arguments to single --deny-tool flag
      // Quote each pattern to handle spaces and special characters (shell: true in spawn)
      if (convertedDenyTools.length > 0) {
        const quotedTools = convertedDenyTools.map((tool) => `"${tool}"`);
        args.push("--deny-tool", ...quotedTools);
        Log.info(`🚫 Denied tools: ${convertedDenyTools.join(", ")}`);
      }
    }

    // Log filtered tools for visibility
    if (filteredTools.length > 0) {
      Log.info(
        `ℹ️ Filtered out tools not requiring Copilot permission: ${filteredTools.join(", ")} (read-only operations are always allowed)`
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

  // Uses base class getStatus() method

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
      Log.error("❌ Failed to extract session ID from logs", error);
      return undefined;
    }
  }
}
