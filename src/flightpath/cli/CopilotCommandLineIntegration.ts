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
import { CliResponseParser } from "./shared/CliResponseParser";
import { CliToolPermissionMapper } from "./shared/CliToolPermissionMapper";
import {
  CliNotificationMonitor,
  NotificationResult,
} from "./shared/CliNotificationMonitor";

/**
 * GitHub Copilot CLI Integration
 *
 * CLI-specific features:
 * - Interactive mode: sessionEnd hook for completion detection
 * - Headless mode: Log-based session ID tracking (fallback)
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

  protected getScreenEndPattern(): RegExp {
    return /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi;
  }

  protected getTuiChromePatterns(): RegExp[] {
    return [
      // Copilot-specific box drawing and separators (UI chrome only)
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing characters (8+ in a row = UI chrome)
      /^[─═]{50,}$/, // Very long horizontal separators (50+ = UI chrome)
      /^│\s*│$/, // Empty box sides

      // Copilot welcome and version info (UI chrome)
      /^Welcome to GitHub Copilot CLI/i, // Welcome header
      /Version.*·.*Commit/i, // Version line (distinctive parts)
      /check for mistakes/i, // Description line (distinctive ending)

      // Copilot status bullets (UI chrome, very specific text)
      /^●\s+Logged in as user:/i, // Login status
      /^●\s+Connected to.*MCP Server/i, // Connection status
      /^●\s+Model changed to:/i, // Model change notification

      // Copilot spinner/thinking indicator (UI chrome - just the spinner character alone)
      /^\s*[·∙◉◎●]\s*$/, // Spinner alone (U+00B7 middle dot, U+2219 bullet operator, or filled circles)

      // Copilot spinner with status text and cancel hint (UI chrome)
      // Allow optional leading whitespace (left after zero-width char stripping)
      // Note: Only filters lines that are JUST chrome (no content before the spinner)
      /^\s*[·∙◉◎●]\s+.*\(Esc to cancel/i, // Pure chrome: "∙ Thinking (Esc to cancel)"

      // Copilot status bar (UI chrome - path + branch + model display)
      /\[⎇\s+\w+\*?\].*gpt-.*\(\d+x\)/i, // Look for distinctive parts: branch indicator, model, and multiplier

      // Copilot bottom navigation bar (already in screenEndPattern, but keep for safety)
      /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand/i, // Bottom status bar

      // Copilot prompt hints (UI chrome)
      /Enter @ to mention files/i, // Prompt hint (distinctive part)
      /^>\s*$/, // Empty prompt line

      // Copilot approval prompts (UI chrome)
      /^Do you want to run this command\?/i, // Approval question
      /Confirm with number keys.*Cancel with Esc/i, // Confirmation hint
      /^❯\s*\d+\./, // Selected option indicator (any option)
      /No, and tell Copilot what to do differently/i, // Option text
    ];
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

  protected buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    // Simple prompts: pass directly with --prompt flag
    // Format: copilot --prompt "your question here" [other args]
    // Note: Quotes handle spaces and special chars
    return ["--prompt", `"${promptText}"`, ...baseArgs];
  }

  protected buildInteractiveTuiCommand(baseArgs: string[]): string {
    return `${this.getCliName()} ${baseArgs.join(" ")}`;
  }

  public getIntegrationMode(): string {
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

      // Interactive mode: Ensure hook configuration file exists
      if (isInteractive) {
        await this.ensureHookConfigFile();
        Log.debug("🔔 Configured sessionEnd hook for completion detection");
      }

      // Build CLI arguments (without prompt - handled by execution methods)
      const args = await this.buildCliArgs(
        prompt,
        isInteractive,
        workflowContext
      );

      // Store full command for debugging (will be updated by execution methods)
      this.lastCliCommand = `${this.getCliName()} -p "<prompt>" ${args.join(" ")}`;

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Execute based on mode
      if (isInteractive) {
        const success = await this.executeInTerminal(
          args,
          promptText,
          workflowContext
        );

        if (success) {
          // Extract session ID from logs (hooks don't provide it)
          const sessionId = await this.extractSessionIdFromLogs();
          if (sessionId) {
            this.sessionId = sessionId;
            Log.debug(`💾 Session ID extracted: ${sessionId}`);
          }
          await this.updateWorkflowProgress();
        }

        return success;
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
   * Generate MCP server configuration for Copilot CLI.
   * Returns --additional-mcp-config @<tempfile> argument.
   * Config file is generated once and cached for reuse across all prompts.
   */
  protected async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      // Use shared file generation (cached after first call)
      // Copilot CLI uses "type": "local" and requires "tools" field
      const configPath = await this.generateMcpConfigFile(
        mcpServerPath,
        workspaceRoot,
        { type: "local", tools: ["*"] }
      );

      // Return --additional-mcp-config @file argument
      return ["--additional-mcp-config", `@${configPath}`];
    } catch (error) {
      Log.error("Failed to generate MCP config for Copilot CLI", error);
      return null;
    }
  }

  /**
   * Build CLI arguments for Copilot command (without prompt - handled separately)
   * @param prompt The prompt item
   * @param isInteractive Whether this is interactive mode (skips tool permissions)
   * @param workflowContext Optional workflow context for MCP config generation
   */
  private async buildCliArgs(
    prompt: PromptItem,
    isInteractive: boolean = false,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // MCP configuration (when dynamic queue extension is enabled)
    if (workflowContext) {
      const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
      if (dynamicQueueConfig.enabled) {
        const {
          shouldInjectExtensionInstructions,
        } = require("../../utils/PromptIdentity");
        const shouldInject = shouldInjectExtensionInstructions(
          prompt,
          workflowContext.promptIndex,
          workflowContext.allPrompts,
          dynamicQueueConfig.dynamicExtensionOnLastPrompt
        );

        if (shouldInject) {
          const mcpServerPath =
            this.context.asAbsolutePath("out/mcp-server.js");
          const workspaceRoot = this.getWorkspaceRoot();
          if (workspaceRoot) {
            const mcpArgs = await this.getMcpConfigArgs(
              mcpServerPath,
              workspaceRoot
            );
            if (mcpArgs) {
              args.push(...mcpArgs);
              // Auto-approve FlightPath MCP tools (FlightPath is the orchestrator)
              args.push("--allow-tool", "flightpath");
              Log.info(
                "🔧 MCP server config added for dynamic queue extension (FlightPath tools auto-approved)"
              );
            }
          }
        }
      }
    }

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
    // Check prompt's explicit setting first, then fall back to global setting
    const shouldStartNewSession =
      ConfigurationUtils.shouldStartNewSessionForPrompt(prompt.newChatSession);
    if (!shouldStartNewSession && this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // Note: Prompt is NOT included here - it's handled separately by the execution methods
    // This allows using temp file approach for interactive mode and direct args for headless mode

    Log.debug(`🔧 CLI arguments: ${JSON.stringify(args)}`);

    return args;
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
   * Parse CLI output into a structured result (delegated to shared utility)
   */
  private parseCliOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult {
    return CliResponseParser.parseCopilotText(stdout, stderr, exitCode);
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
   * Get tool permission arguments based on configuration (delegated to shared utility)
   */
  private getToolPermissionArgs(): string[] {
    const mode = ConfigurationUtils.getCliToolPermissions();
    const allowedTools = ConfigurationUtils.getCliAllowedTools();
    const deniedTools = ConfigurationUtils.getCliDeniedTools();

    return CliToolPermissionMapper.buildCopilotArgs({
      mode,
      allowedTools,
      deniedTools,
    });
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
   * Extract session ID from process log files in log directory
   *
   * NOTE: Only used for HEADLESS mode as a fallback.
   * Interactive mode uses sessionEnd hook for session ID extraction.
   *
   * Log format (as of CLI v0.0.377+): process-{timestamp}-{pid}.log
   * Session ID appears in log lines: "Flushed X events to session {GUID}"
   * Requires --log-level debug or higher to capture session ID
   * Returns the session ID from the most recently modified log file
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

      // Filter for process log files (process-{timestamp}-{pid}.log)
      const processFiles = files.filter((file) =>
        file.match(/^process-\d+-\d+\.log$/i)
      );

      if (processFiles.length === 0) {
        return undefined;
      }

      // Get file stats to find most recent
      const fileStats = await Promise.all(
        processFiles.map(async (file) => {
          const filePath = path.join(this.logDirectory!, file);
          const stats = await fs.stat(filePath);
          return { file, filePath, mtime: stats.mtime };
        })
      );

      // Sort by modification time (most recent first)
      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Read the most recent log file and search for session ID
      const logContent = await fs.readFile(fileStats[0].filePath, "utf-8");

      // Pattern: "Flushed X events to session {GUID}"
      // Example: "2026-01-12T20:11:10.385Z [DEBUG] Flushed 3 events to session 4f59192e-65ed-4fdb-aed7-ce69a263dd7b"
      const match = logContent.match(
        /Flushed \d+ events to session ([a-f0-9\-]+)/i
      );

      if (match && match[1]) {
        return match[1];
      }

      return undefined;
    } catch (error) {
      Log.error("❌ Failed to extract session ID from logs", error);
      return undefined;
    }
  }

  /**
   * Execute Copilot CLI in interactive terminal with dual monitoring:
   * - Screen-based TUI output extraction
   * - sessionEnd hook completion detection
   *
   * This overrides BaseCliIntegration's executeInTerminal to add
   * Copilot's sessionEnd hook notification monitoring for reliable completion.
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    try {
      const result = await this.withInteractiveTuiExecution(
        args,
        promptText,
        workflowContext,
        async ({
          terminal,
          execution,
          promptWithInstruction,
          tuiProcessor,
          timeoutMs,
        }) => {
          const tuiAbortController = new AbortController();
          const startTime = new Date();

          Log.info(
            "⏳ Starting Copilot TUI processing with sessionEnd hook monitoring..."
          );
          const tuiPromise = tuiProcessor.processStream(
            execution,
            terminal,
            promptWithInstruction,
            timeoutMs,
            this.lastSanitizedPrompt,
            tuiAbortController
          );

          // Monitor for completion notification (wildcard mode - no session ID)
          const notifyPromise = this.monitorNotificationFile(
            undefined, // Copilot hooks don't provide session ID - use wildcard monitoring
            startTime,
            timeoutMs
          );

          const notifyResult = await Promise.race([
            notifyPromise,
            tuiPromise.then((tuiResult) => ({
              completed: tuiResult.success,
              error: tuiResult.errorMessage,
            })),
          ]);

          if (notifyResult.completed) {
            Log.debug(
              "🛑 sessionEnd hook detected completion - aborting TUI stream"
            );
            tuiAbortController.abort();
            // Note: Hook doesn't provide session ID - extracted from logs in sendPrompt
          }

          const tuiResult = await tuiPromise;

          if (!notifyResult.completed) {
            this.lastFailureReason =
              notifyResult.error || "Completion detection failed";
            Log.error(`❌ Copilot execution failed: ${this.lastFailureReason}`);
            return { success: false, errorMessage: this.lastFailureReason };
          }

          if (!tuiResult.success && tuiResult.errorMessage) {
            this.lastFailureReason = tuiResult.errorMessage;
            Log.warn(
              `⚠️ TUI processor detected error: ${tuiResult.errorMessage}`
            );
          }

          return { success: true };
        }
      );

      return result.success;
    } catch (error) {
      this.lastFailureReason =
        error instanceof Error ? error.message : String(error);
      Log.error(`❌ Copilot execution error: ${this.lastFailureReason}`);
      return false;
    }
  }

  // ============================================================
  // COPILOT-SPECIFIC: HOOK-BASED COMPLETION DETECTION
  // ============================================================

  /**
   * Get path to FlightPath's Copilot hook handler script.
   * This script is called by Copilot CLI when sessionEnd events occur.
   */
  private getHookScriptPath(): string {
    return path.join(
      this.context.extensionPath,
      "out",
      "scripts",
      "flightpath-copilot-hook.js"
    );
  }

  /**
   * Get path to workspace .github/hooks directory
   */
  private getHooksDirectory(): string | undefined {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return undefined;
    }
    return path.join(workspaceRoot, ".github", "hooks");
  }

  /**
   * Create .github/hooks/flightpath.json with sessionEnd hook configuration
   */
  private async ensureHookConfigFile(): Promise<void> {
    const hooksDir = this.getHooksDirectory();
    if (!hooksDir) {
      throw new Error("Cannot determine workspace root for hooks directory");
    }

    // Ensure .github/hooks directory exists
    await fs.mkdir(hooksDir, { recursive: true });

    const hookFilePath = path.join(hooksDir, "flightpath.json");
    const scriptPath = this.getHookScriptPath();
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Cannot determine workspace root for notification path");
    }

    const notifyDir = CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "copilot"
    );

    const hookConfig = CliNotificationMonitor.buildCopilotHookConfig(
      scriptPath,
      notifyDir
    );

    // Write hook configuration file
    await fs.writeFile(
      hookFilePath,
      JSON.stringify(hookConfig, null, 2),
      "utf-8"
    );

    Log.debug(`📁 Created hook config: ${hookFilePath}`);
  }

  /**
   * Monitor notification file for completion (delegated to shared utility)
   */
  private async monitorNotificationFile(
    sessionId: string | undefined,
    startTime: Date,
    timeoutMs: number
  ): Promise<NotificationResult> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        completed: false,
        error: "Cannot determine workspace root for notification monitoring",
      };
    }

    const notifyDir = CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "copilot"
    );

    return CliNotificationMonitor.monitorForCompletion(
      { directory: notifyDir, timeoutMs },
      sessionId,
      startTime,
      () => this.isCancelling
    );
  }
}
