import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { PromptItem } from "../../types/FlightPathTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { TempFileManager } from "../../utils/TempFileManager";
import { CliProcessManager } from "../../utils/CliProcessManager";
import {
  TuiStreamProcessor,
  TuiStreamConfig,
  WorkflowContext,
} from "../../utils/TuiStreamProcessor";
import { Log } from "../../utils/Log";

/**
 * Execution mode for CLI integrations
 */
export type CliExecutionMode = "interactive" | "headless";

/**
 * Execution mode constants
 */
export const CLI_EXECUTION_MODE = {
  INTERACTIVE: "interactive" as const,
  HEADLESS: "headless" as const,
};

/**
 * Warning messages
 */
export const CLI_WARNING_MESSAGES = {
  HEADLESS_WITHOUT_PERMISSIONS:
    "Headless mode without full permissions: CLI will auto-deny tool/file access. Workflow may not make progress.",
} as const;

/**
 * Base class for CLI integrations (Copilot CLI and Claude CLI).
 *
 * Supports two execution modes:
 * - **Interactive:** TUI in VS Code terminal with file-based prompt passing
 * - **Headless:** Background process with temp file reference and streaming output
 *
 * All prompts are pre-expanded (context references resolved) before sending to CLI.
 * Delegates to CliProcessManager (spawning/terminal/cancellation).
 *
 * Subclasses provide CLI-specific: command building, output parsing, model validation,
 * tool permissions, and TUI patterns (escape indicator, screen boundaries).
 *
 * See docs/COPILOT_CLI_DESIGN.md and docs/CLAUDE_CLI_DESIGN.md for details.
 */
export abstract class BaseCliIntegration extends CopilotIntegration {
  protected sessionId?: string;
  protected initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  protected lastResult?: CopilotCliResult;
  protected lastCliCommand?: string;
  protected lastFullPrompt?: string;
  protected currentProcess?: ChildProcess;
  protected processManager: CliProcessManager;

  // Interactive terminal mode properties
  protected currentExecution?: vscode.TerminalShellExecution;

  // TUI completion detection - now using execution.read() instead of proposed API
  private readAbortController?: AbortController;

  // Track the sanitized prompt sent to terminal for filtering echo in response
  protected lastSanitizedPrompt?: string;

  // Cached MCP config file path (generated once per session, reused for all prompts)
  private cachedMcpConfigPath?: string;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.processManager = new CliProcessManager(
      this.getWorkspaceRoot() || "",
      (msg) => Log.debug(msg)
    );
  }

  /**
   * Get the configured execution mode (interactive or headless)
   */
  protected getExecutionMode(): CliExecutionMode {
    return ConfigurationUtils.getCliExecutionMode() as CliExecutionMode;
  }

  /**
   * Dispose the current terminal if it exists.
   * This does NOT clear the session ID - that's preserved for potential resume.
   *
   * Call this before starting a new CLI process in interactive mode to ensure
   * we get a fresh terminal. The old terminal output remains visible until
   * the user closes it or the new terminal opens.
   */
  protected disposeTerminalIfExists(): void {
    Log.debug("🗑️ Disposing existing terminal for fresh CLI session");
    this.processManager.disposeTerminal();
    this.currentExecution = undefined;
  }

  /**
   * Create a fresh VS Code terminal for interactive execution.
   * Always creates a new terminal, disposing any existing one first.
   */
  protected async createFreshTerminal(): Promise<vscode.Terminal> {
    this.disposeTerminalIfExists();
    return await this.processManager.createTerminal(
      `FlightPath: ${this.getCliName()}`,
      this.getWorkspaceRoot()
    );
  }

  /** || ""
   * Wait for shell integration to become available on a terminal
   * @param terminal The terminal to wait for
   * @param timeoutMs Maximum time to wait (default 5 seconds)
   */
  protected async waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number = 5000
  ): Promise<vscode.TerminalShellIntegration> {
    return await this.processManager.waitForShellIntegration(
      terminal,
      timeoutMs
    );
  }

  /**
   * Get the CLI-specific integration mode string (e.g., "copilot-cli")
   */
  public abstract getIntegrationMode(): string;

  /**
   * Get display name for status messages (e.g., "Copilot CLI", "Claude Code CLI")
   */
  protected abstract getCliDisplayName(): string;

  /**
   * Get installation hint for unavailable CLI
   */
  protected abstract getInstallHint(): string;

  /**
   * Parse token counts from statistics string
   */
  abstract parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined;

  /**
   * Get the CLI name for terminal/logging (e.g., "copilot" or "claude")
   */
  protected abstract getCliName(): string;

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Used to warn users when running headless without full permissions
   */
  protected abstract hasFullPermissions(): boolean;

  /**
   * Get the escape indicator pattern for TUI completion detection.
   * This text appears while the CLI is generating a response.
   * When it disappears, the response is complete.
   *
   * Copilot: "(esc to cancel)"
   * Claude: "(esc to interrupt)"
   */
  protected abstract getEscapeIndicator(): string;

  /**
   * Get the regex pattern that marks the end of a TUI screen.
   * Used to split the output buffer into complete screen frames.
   *
   * TUI apps redraw the entire screen each frame. This pattern identifies
   * where each complete screen ends so we can:
   * 1. Parse complete screens from the buffer
   * 2. Check each screen for completion indicators
   * 3. Extract meaningful content deltas
   *
   * Copilot: "Ctrl+c Exit · Ctrl+r Expand recent" (status bar)
   * Claude: Line of dashes followed by "> " prompt
   */
  protected abstract getScreenEndPattern(): RegExp;

  /**
   * Get the CLI-specific TUI chrome patterns for filtering.
   * Chrome refers to UI elements that should be filtered out from responses:
   * - Box borders and separators
   * - Status bars and keyboard shortcuts
   * - Thinking indicators and prompts
   * - Welcome messages and tips
   *
   * Each CLI has unique TUI chrome that varies by platform and version.
   * This method returns the complete set of patterns for this CLI.
   *
   * @returns Array of RegExp patterns to test against trimmed lines
   */
  protected abstract getTuiChromePatterns(): RegExp[];

  /**
   * Generate MCP server configuration arguments for dynamic queue extension.
   * Returns CLI-specific arguments to pass MCP server config.
   *
   * Only called when:
   * 1. Dynamic queue is enabled (flightpath.enableDynamicQueue)
   * 2. Current prompt has allowDynamicExtension enabled
   *
   * @param mcpServerPath Absolute path to the MCP server executable
   * @param workspaceRoot Workspace root directory (for FLIGHTPATH_WORKSPACE env var)
   * @returns Array of arguments to append to CLI command, or null if not supported
   */
  protected abstract getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null>;

  /**
   * Generate MCP config file (shared implementation for JSON-based CLIs).
   * Creates the file once and caches the path for reuse across all prompts.
   * The config content is static per session (server path and workspace root don't change).
   *
   * @param mcpServerPath Absolute path to the MCP server executable
   * @param workspaceRoot Absolute path to the workspace root
   * @param serverConfig Optional server configuration fields (type, tools, etc.)
   * @returns Absolute path to the generated config file
   */
  protected async generateMcpConfigFile(
    mcpServerPath: string,
    workspaceRoot: string,
    serverConfig?: { type?: string; tools?: string[] }
  ): Promise<string> {
    // Return cached path if already generated
    if (this.cachedMcpConfigPath) {
      return this.cachedMcpConfigPath;
    }

    const fs = require("fs/promises");
    const path = require("path");
    const { CliMcpConfigGenerator } = require("./shared/CliMcpConfigGenerator");

    // Generate MCP config JSON using shared utility
    const configJson = CliMcpConfigGenerator.generateJsonConfig(
      mcpServerPath,
      workspaceRoot,
      serverConfig
    );

    // Write to temp directory (reused for all prompts in this session)
    const tempDir = path.join(workspaceRoot, ".flightpath", "temp");
    await fs.mkdir(tempDir, { recursive: true });

    const configPath = path.join(tempDir, "mcp-config.json");
    await fs.writeFile(configPath, configJson, "utf-8");

    // Cache the path for reuse
    this.cachedMcpConfigPath = configPath;
    Log.debug(`📝 Generated MCP config file: ${configPath}`);

    return configPath;
  }

  /**
   * Build headless CLI arguments with temp file reference.
   * The prompt has been written to a temp file, and this method
   * should add the appropriate flag to reference it.
   *
   * @param baseArgs The base CLI arguments
   * @param promptFileRef The @-prefixed relative file reference (e.g., "@.flightpath/temp/prompt-123.md")
   * @returns Args array for headless mode with prompt file reference
   */
  protected abstract buildHeadlessArgs(
    baseArgs: string[],
    promptFileRef: string
  ): string[];

  /**
   * Determine if stdout should be streamed in real-time during headless execution.
   *
   * By default, returns true to stream output as it arrives.
   * Subclasses can override to return false if the raw output format is not
   * human-readable (e.g., JSON), and instead emit parsed content after completion.
   *
   * @returns true to stream stdout chunks in real-time, false to buffer until complete
   */
  protected shouldStreamHeadlessOutput(): boolean {
    return true;
  }

  /**
   * Process a stdout chunk before streaming to the dashboard.
   *
   * By default, passes the chunk through as-is.
   * Subclasses can override to parse/transform the chunk (e.g., extract content from JSON).
   *
   * @param chunk The raw stdout chunk
   * @returns The processed chunk to emit, or undefined to skip emission
   */
  protected processStreamingChunk(chunk: string): string | undefined {
    return chunk;
  }

  /**
   * Build interactive TUI command to start the CLI in interactive mode.
   * Should NOT include the prompt - it will be sent via sendText().
   *
   * @param baseArgs The base CLI arguments
   * @returns The command to start the interactive TUI
   */
  protected abstract buildInteractiveTuiCommand(baseArgs: string[]): string;

  /**
   * Format a file path reference for the CLI.
   * By default, prepends @ symbol for standard CLI file reference syntax.
   * Subclasses can override to use different syntax (e.g., Codex doesn't support @).
   *
   * @param relativeFilePath The relative file path (e.g., ".flightpath/temp/prompt.md")
   * @returns Formatted file reference (e.g., "@.flightpath/temp/prompt.md")
   */
  protected formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  /**
   * Create a temp file for the prompt and return file reference with instruction.
   * Returns both the temp file path (for cleanup) and the instructional prompt text
   * that tells the LLM to follow instructions in the file.
   *
   * Using "Follow instructions in" prefix helps LLMs (especially GPT-5) understand
   * that the file reference contains prompt instructions, not just a file to read.
   * This matches GitHub Copilot's /prompt.md syntax behavior.
   *
   * @param promptText The full prompt text to write to the file
   * @param workflowContext Optional workflow context for meaningful filename
   * @returns Object with tempFilePath for cleanup and promptWithInstruction for CLI
   */
  protected async createPromptFileWithReference(
    promptText: string,
    workflowContext?: WorkflowContext
  ): Promise<{ tempFilePath: string; promptWithInstruction: string }> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace root available for temp file");
    }

    const tempMgr = new TempFileManager(workspaceRoot);
    const tempFilePath = await tempMgr.createPromptFile(
      promptText,
      workflowContext?.filePath,
      workflowContext ? workflowContext.promptIndex + 1 : undefined
    );
    const relativeFilePath = tempMgr.getRelativePath(tempFilePath);
    const fileReference = this.formatFileReference(relativeFilePath);

    // Prepend instruction so LLMs understand the file contains the prompt
    // Add trailing space to prevent TUI file picker from activating when cursor is on the file path
    const promptWithInstruction = `Follow instructions in ${fileReference} `;

    Log.info(`📁 Temp file created: ${relativeFilePath}`);

    return { tempFilePath, promptWithInstruction };
  }

  protected async withInteractiveTuiExecution(
    args: string[],
    promptText: string,
    workflowContext: WorkflowContext | undefined,
    execute: (context: {
      terminal: vscode.Terminal;
      execution: vscode.TerminalShellExecution;
      promptWithInstruction: string;
      tuiProcessor: TuiStreamProcessor;
      timeoutMs: number;
      shouldShowOutput: boolean;
    }) => Promise<{ success: boolean; errorMessage?: string }>,
    tuiConfigOverrides?: Partial<TuiStreamConfig>
  ): Promise<{ success: boolean; errorMessage?: string }> {
    const tuiCommand = this.buildInteractiveTuiCommand(args);
    const displayCommand = `${this.getCliName()} [TUI mode] "<prompt>"`;

    const terminal = await this.createFreshTerminal();
    terminal.show();

    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: displayCommand,
    });

    this.streamingChunkEmitter.fire(
      "📺 Interactive TUI mode: Output is streaming to the VS Code terminal.\n" +
        "   View the terminal for real-time output.\n\n"
    );

    const shellIntegration = await this.waitForShellIntegration(terminal);
    const execution = shellIntegration.executeCommand(tuiCommand);
    this.currentExecution = execution;

    let tempFilePath: string | undefined;

    try {
      const { tempFilePath: path, promptWithInstruction } =
        await this.createPromptFileWithReference(promptText, workflowContext);
      tempFilePath = path;

      this.lastSanitizedPrompt = promptText;

      const timeoutMs =
        ConfigurationUtils.getMaxPromptExecutionTimeMs() || 12 * 60 * 60 * 1000; // 12 hours default if unlimited
      const shouldShowOutput = this.shouldShowOutput();

      const tuiConfig: TuiStreamConfig = {
        escapeIndicator: this.getEscapeIndicator(),
        screenEndPattern: this.getScreenEndPattern(),
        tuiChromePatterns: this.getTuiChromePatterns(),
        streamingEmitter: this.streamingChunkEmitter,
        responseCompleteEmitter: this.responseCompleteEmitter,
        ...tuiConfigOverrides,
      };

      const tuiProcessor = new TuiStreamProcessor(tuiConfig);

      // CRITICAL: Must await execute() before finally block runs
      // Otherwise temp file gets deleted while TUI is still reading it
      return await execute({
        terminal,
        execution,
        promptWithInstruction,
        tuiProcessor,
        timeoutMs,
        shouldShowOutput,
      });
    } finally {
      if (tempFilePath) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const tempMgr = new TempFileManager(workspaceRoot);
          await tempMgr.deleteFile(tempFilePath);
          Log.debug(`🗑️ Cleaned up temp file: ${tempFilePath}`);
        }
      }
    }
  }

  /**
   * Execute a CLI command in interactive TUI mode.
   *
   * Strategy:
   * 1. Dispose any existing terminal (CLI may be running in it)
   * 2. Create fresh terminal and start CLI in interactive mode
   * 3. Wait for TUI to be ready (delay-based, simple)
   * 4. Send prompt via terminal.sendText() (no length limits!)
   * 5. Stream output via execution.read() and detect completion
   *
   * Session continuity is handled via --resume flag in CLI args, not by
   * reusing the same terminal. Each execution starts a fresh CLI process.
   *
   * Completion detection uses the stable TerminalShellExecution.read() API
   * to watch for the escape indicator to disappear from recent output.
   *
   * @param args The CLI arguments (WITHOUT prompt, but WITH --resume if session should continue)
   * @param promptText The prompt text (will be sent via sendText)
   * @param workflowContext Optional workflow context for temp file naming
   * @returns Promise<boolean> indicating success
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string,
    workflowContext?: WorkflowContext
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
          shouldShowOutput,
        }) =>
          tuiProcessor.processStream(
            execution,
            terminal,
            promptWithInstruction,
            timeoutMs,
            this.lastSanitizedPrompt,
            shouldShowOutput
          )
      );

      if (!result.success && result.errorMessage) {
        this.lastFailureReason = result.errorMessage;
      }

      return result.success;
    } catch (error) {
      Log.error(`❌ TUI execution error`, error);
      throw error;
    }
  }

  /**
   * Execute a CLI command in headless mode using temp file for prompt passing.
   *
   * Strategy:
   * 1. Write fully-expanded prompt to temp file
   * 2. Spawn CLI process with @temp-file or --prompt @temp-file parameter
   * 3. Wait for process to complete
   * 4. Cleanup temp file
   *
   * Benefits over stdin approach:
   * - Copilot: Allows agent specification with --prompt flag
   * - Claude: Avoids auto-expansion of @path references (no duplicates)
   * - Codex: Supports all CLIs (codex doesn't support stdin)
   * - Unified: Same approach for interactive and headless modes
   *
   * @param args The CLI arguments (WITHOUT prompt)
   * @param promptText The prompt text (will be written to temp file)
   * @param workflowContext Optional workflow context for temp file naming
   * @param executeCallback Callback for CLI-specific result handling
   * @returns Promise<boolean> indicating success
   */
  protected async executeHeadlessWithPromptFile(
    args: string[],
    promptText: string,
    workflowContext:
      | {
          promptIndex: number;
          allPrompts: PromptItem[];
          filePath?: string;
        }
      | undefined,
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => Promise<boolean>
  ): Promise<boolean> {
    let tempFilePath: string | undefined;

    try {
      // Create temp file with instructional prompt
      const { tempFilePath: path, promptWithInstruction } =
        await this.createPromptFileWithReference(promptText, workflowContext);
      tempFilePath = path;

      // Build args with instructional prompt
      const headlessArgs = this.buildHeadlessArgs(args, promptWithInstruction);
      const displayCommand = `${this.getCliName()} ${headlessArgs.join(" ")}`;

      Log.info(`🚀 Starting headless mode with file: ${displayCommand}`);
      Log.info(`📝 Prompt length: ${promptText.length} characters`);

      // Store for debugging
      this.lastCliCommand = displayCommand;

      // Fire prompt ready event
      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: displayCommand,
      });

      // Check if we should stream output in real-time
      const shouldStream = this.shouldStreamHeadlessOutput();

      // Spawn and execute (no stdin needed)
      const result = await this.spawnProcess(this.getCliName(), headlessArgs, {
        timeout:
          ConfigurationUtils.getMaxPromptExecutionTimeMs() ||
          12 * 60 * 60 * 1000, // 12 hours default if unlimited
        onStdout: shouldStream
          ? (chunk) => {
              const processedChunk = this.processStreamingChunk(chunk);
              if (processedChunk !== undefined) {
                this.streamingChunkEmitter.fire(processedChunk);
              }
            }
          : undefined,
      });

      // Check for cancellation
      if (this.isCancelling) {
        Log.info("⏹️ Prompt execution cancelled by user");
        return false;
      }

      // Delegate result handling to subclass
      return await executeCallback(result);
    } catch (error) {
      Log.error(`❌ Headless execution error`, error);
      return false;
    } finally {
      // Cleanup temp file
      if (tempFilePath) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const tempMgr = new TempFileManager(workspaceRoot);
          await tempMgr.deleteFile(tempFilePath);
          Log.debug(`🗑️ Cleaned up temp file`);
        }
      }
    }
  }

  /**
   * Spawn a child process for headless CLI execution.
   * Prompt is passed via command line argument (temp file reference).
   *
   * @param command The command to run
   * @param args Command arguments (including prompt file reference)
   * @param options Timeout and streaming options
   */
  protected async spawnProcess(
    command: string,
    args: string[],
    options: {
      timeout?: number;
      onStdout?: (chunk: string) => void;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.processManager.spawn(command, args, {
      cwd: this.getWorkspaceRoot() || "",
      timeout: options.timeout,
      onStdout: options.onStdout,
    });

    // Emit response complete so dashboard knows process actually stopped
    if (result.exitCode === 0) {
      this.responseCompleteEmitter.fire("Process exited");
    }

    return result;
  }

  /**
   * Spawn a simple command (like --version checks) without stdin.
   * Uses shell: true for PATH resolution.
   */
  protected async spawnSimpleCommand(
    command: string,
    args: string[],
    timeoutMs: number = 5000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await this.processManager.spawnSimple(command, args, timeoutMs);
  }

  /**
   * Check if output should be shown in Output panel
   */
  protected shouldShowOutput(): boolean {
    return ConfigurationUtils.shouldShowCliOutput();
  }

  /**
   * Log prompt to output channel with formatting
   */
  protected logPrompt(promptText: string): void {
    if (this.shouldShowOutput()) {
      Log.appendLine("");
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine(`[PROMPT] ${new Date().toLocaleTimeString()}`);
      Log.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      Log.appendLine(promptText);
      Log.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      Log.appendLine("");
    }
  }

  /**
   * Log response to output channel with formatting
   */
  protected logResponse(response: string, statistics?: string): void {
    if (this.shouldShowOutput()) {
      Log.appendLine(`[RESPONSE] ${new Date().toLocaleTimeString()}`);
      Log.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      Log.appendLine(response);
      if (statistics) {
        Log.appendLine("");
        Log.appendLine("[STATISTICS]");
        Log.appendLine(statistics);
      }
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine("");
    }
  }

  // ============================================================
  // WORKSPACE HELPERS
  // ============================================================

  /**
   * Get workspace directories for --add-dir flag
   */
  protected getWorkspaceDirs(): string[] {
    const configured = ConfigurationUtils.getCliAllowedDirs();
    const workspaceDirs =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
    return [...workspaceDirs, ...configured];
  }

  // ============================================================
  // RESULT ACCESSORS
  // ============================================================

  /**
   * Get the last CLI result
   */
  getLastResult(): CopilotCliResult | undefined {
    return this.lastResult;
  }

  /**
   * Get the last CLI command executed
   */
  getLastCliCommand(): string | undefined {
    return this.lastCliCommand;
  }

  /**
   * Get the full prompt text sent to CLI
   */
  getLastFullPrompt(): string | undefined {
    return this.lastFullPrompt;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize CLI by checking availability via --version command.
   * Subclasses can override for custom initialization logic.
   */
  async initialize(): Promise<void> {
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    try {
      const result = await this.spawnSimpleCommand(
        this.getCliName(),
        ["--version"],
        5000
      );

      if (result.exitCode === 0) {
        const version = result.stdout.trim();
        Log.info(`✅ ${this.getCliName()} CLI available: ${version}`);
        this.isAvailable = true;
        this.initializationStatus = CopilotStatus.Ready;
        this.statusChangeEmitter.fire(CopilotStatus.Ready);
      } else {
        this.handleInitializationError("command_failed", result.stderr);
      }
    } catch (error) {
      this.handleInitializationError("exception", error);
    }
  }

  /**
   * Handle initialization errors with logging.
   * Subclasses can override for custom error messages.
   */
  protected handleInitializationError(
    type: "command_failed" | "exception",
    error: unknown
  ): void {
    this.isAvailable = false;
    this.initializationStatus = CopilotStatus.Unavailable;
    this.statusChangeEmitter.fire(CopilotStatus.Unavailable);

    Log.error(`❌ ${this.getCliName()} CLI not available`, error);
  }

  /**
   * Show warning when running in headless mode without full permissions
   */
  protected warnIfHeadlessWithoutPermissions(): void {
    const mode = this.getExecutionMode();
    if (mode === CLI_EXECUTION_MODE.HEADLESS && !this.hasFullPermissions()) {
      vscode.window.showWarningMessage(
        CLI_WARNING_MESSAGES.HEADLESS_WITHOUT_PERMISSIONS
      );
    }
  }

  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  isReady(): boolean {
    return this.initializationStatus === CopilotStatus.Ready;
  }

  getInitializationStatus(): CopilotStatus {
    return this.initializationStatus;
  }

  isCli(): boolean {
    return true;
  }

  /**
   * Cancel the current CLI process
   */
  protected async cancelImplementation(): Promise<void> {
    // Abort any active read() streaming
    if (this.readAbortController) {
      this.readAbortController.abort();
      this.readAbortController = undefined;
    }

    // Delegate to CliProcessManager for both terminal and process cancellation
    await this.processManager.cancel(this.currentExecution);
    this.currentExecution = undefined;

    // Fire responseComplete so FlightPathManager can call confirmedStopped()
    this.responseCompleteEmitter.fire("Execution cancelled");
    Log.info("✅ Execution cancelled");
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (this.readAbortController) {
      this.readAbortController.abort();
      this.readAbortController = undefined;
    }
    this.processManager.dispose();
    this.currentExecution = undefined;
  }

  /**
   * Get integration status.
   * Subclasses can override getCliDisplayName() and getInstallCommand() for custom messages.
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message: `✅ ${this.getCliDisplayName()} available`,
        strategy: this.getIntegrationMode(),
      };
    } else {
      return {
        available: false,
        message: `❌ ${this.getCliDisplayName()} unavailable - ${this.getInstallHint()}`,
        strategy: this.getIntegrationMode(),
      };
    }
  }

  /**
   * Parse pattern: toolName or toolName(args)
   * Returns [toolName, args] or null if invalid
   */
  protected parseToolPattern(pattern: string): [string, string?] | null {
    const match = pattern.match(/^(\w+)(\(.+\))?$/);
    if (!match) {
      return null;
    }
    const [, toolName, args] = match;
    return args ? [toolName, args] : [toolName];
  }
}
