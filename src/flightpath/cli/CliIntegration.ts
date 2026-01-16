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
import { ICliProvider } from "./shared/interfaces/ICliProvider";

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
 * Generic CLI integration class using composition.
 *
 * This class replaces the inheritance-based BaseCliIntegration with a composition-based
 * approach. Instead of extending a base class and implementing abstract methods, it accepts
 * an ICliProvider instance that encapsulates all provider-specific behavior.
 *
 * **Architecture Benefits:**
 * - Zero base class changes when adding new providers
 * - Provider isolation (all logic in provider's directory)
 * - Easy testing (test provider components independently)
 * - Clear separation of concerns (integration orchestration vs provider implementation)
 *
 * **Supports two execution modes:**
 * - **Interactive:** TUI in VS Code terminal with file-based prompt passing
 * - **Headless:** Background process with temp file reference and streaming output
 *
 * All prompts are pre-expanded (context references resolved) before sending to CLI.
 * Delegates to CliProcessManager for spawning/terminal/cancellation.
 * Delegates to provider for all CLI-specific behavior.
 *
 * @example
 * ```typescript
 * const provider = new CopilotCliProvider(context);
 * const integration = new CliIntegration(provider, context);
 * await integration.initialize();
 * await integration.sendPrompt(prompt);
 * ```
 */
export class CliIntegration extends CopilotIntegration {
  /** Provider instance that encapsulates all CLI-specific logic */
  private readonly provider: ICliProvider;

  /** Session ID for resumption across prompts */
  protected sessionId?: string;

  /** Initialization status */
  protected initializationStatus: CopilotStatus = CopilotStatus.Initializing;

  /** Last CLI execution result */
  protected lastResult?: CopilotCliResult;

  /** Last CLI command executed (for debugging) */
  protected lastCliCommand?: string;

  /** Last full prompt text sent (for debugging) */
  protected lastFullPrompt?: string;

  /** Current background process (headless mode) */
  protected currentProcess?: ChildProcess;

  /** Process/terminal manager for CLI execution */
  protected processManager: CliProcessManager;

  // Interactive terminal mode properties
  protected currentExecution?: vscode.TerminalShellExecution;

  // TUI completion detection - using execution.read()
  private readAbortController?: AbortController;

  // Track the sanitized prompt sent to terminal for filtering echo in response
  protected lastSanitizedPrompt?: string;

  // Cached MCP config file path (generated once per session, reused for all prompts)
  private cachedMcpConfigPath?: string;

  /**
   * Create a new CLI integration with the specified provider.
   *
   * @param provider The CLI provider instance (encapsulates all CLI-specific logic)
   * @param context VS Code extension context
   */
  constructor(provider: ICliProvider, context: vscode.ExtensionContext) {
    super(context);
    this.provider = provider;
    this.processManager = new CliProcessManager(
      this.getWorkspaceRoot() || "",
      (msg) => Log.debug(msg)
    );
  }

  // ============================================================
  // CONFIGURATION & EXECUTION MODE
  // ============================================================

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
      `FlightPath: ${this.provider.config.displayName}`,
      this.getWorkspaceRoot()
    );
  }

  /**
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

  // ============================================================
  // ABSTRACT METHOD IMPLEMENTATIONS (DELEGATED TO PROVIDER)
  // ============================================================

  /**
   * Get the CLI-specific integration mode string (e.g., "copilot-cli", "claude-cli")
   */
  public getIntegrationMode(): string {
    return this.provider.config.name;
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Used to warn users when running headless without full permissions
   */
  protected hasFullPermissions(): boolean {
    const config = {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.provider.toolPermissionMapper.hasFullPermissions(config);
  }

  /**
   * Parse token counts from statistics string
   * Delegates to provider's response parser
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    return this.provider.responseParser.parseTokenCounts(statistics);
  }

  // ============================================================
  // MCP CONFIGURATION
  // ============================================================

  /**
   * Generate MCP config file (shared implementation for JSON-based CLIs).
   * Creates the file once and caches the path for reuse across all prompts.
   * The config content is static per session (server path and workspace root don't change).
   *
   * @param mcpServerPath Absolute path to the MCP server executable
   * @param workspaceRoot Absolute path to the workspace root
   * @returns Absolute path to the generated config file, or null if provider doesn't support MCP
   */
  protected async generateMcpConfigFile(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string | null> {
    // Check if provider supports MCP
    if (!this.provider.getMcpConfigArgs) {
      return null;
    }

    // Return cached path if already generated
    if (this.cachedMcpConfigPath) {
      return this.cachedMcpConfigPath;
    }

    // Delegate to provider to get MCP config args
    const args = await this.provider.getMcpConfigArgs(
      mcpServerPath,
      workspaceRoot
    );

    if (!args) {
      return null; // Provider doesn't support MCP
    }

    // For providers that use config files (not inline args), generate the file
    // This is determined by checking if the provider uses CliMcpConfigGenerator
    // For now, we'll cache the args as the config path (simplified)
    // In actual implementation, each provider would handle their own config format

    return null; // Placeholder - actual implementation would generate config file
  }

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
  protected async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    if (!this.provider.getMcpConfigArgs) {
      return null;
    }

    return await this.provider.getMcpConfigArgs(mcpServerPath, workspaceRoot);
  }

  // ============================================================
  // PROMPT FILE CREATION & MANAGEMENT
  // ============================================================

  /**
   * Check if a prompt is simple enough to pass directly without temp file.
   *
   * Simple prompts:
   * - Short length (≤300 characters)
   * - No dynamic queue XML instructions
   * - No complex formatting that would break shell escaping
   *
   * Benefits of direct passing:
   * - No file I/O overhead
   * - Faster response for quick queries
   * - Better UX for interactive commands
   *
   * @param finalPromptText The final prompt text (after instruction injection)
   * @returns true if prompt can be passed directly
   */
  protected isSimplePrompt(finalPromptText: string): boolean {
    const MAX_SIMPLE_PROMPT_LENGTH = 300;

    if (finalPromptText.length > MAX_SIMPLE_PROMPT_LENGTH) {
      return false;
    }

    if (finalPromptText.includes("<criticalInstruction>")) {
      return false;
    }

    if (finalPromptText.includes("`")) {
      return false;
    }

    return true;
  }

  /**
   * Create a temp file for the prompt and return file reference with instruction.
   * Returns both the temp file path (for cleanup) and the instructional prompt text
   * that tells the LLM to follow instructions in the file.
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
    const fileReference = this.provider.formatFileReference(relativeFilePath);

    // Prepend instruction so LLMs understand the file contains the prompt
    // Add trailing space to prevent TUI file picker from activating
    const promptWithInstruction = `Follow instructions in ${fileReference} `;

    Log.info(`📁 Temp file created: ${relativeFilePath}`);

    return { tempFilePath, promptWithInstruction };
  }

  // ============================================================
  // INTERACTIVE TUI EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in interactive TUI mode.
   *
   * Strategy:
   * 1. Dispose any existing terminal (CLI may be running in it)
   * 2. Create fresh terminal and start CLI in interactive mode
   * 3. Wait for TUI to be ready (delay-based, simple)
   * 4. Send prompt via terminal.sendText()
   *    - Simple prompts: sent directly (fast!)
   *    - Complex prompts: written to temp file and referenced
   * 5. Stream output via execution.read() and detect completion
   *
   * Session continuity is handled via --resume flag in CLI args, not by
   * reusing the same terminal. Each execution starts a fresh CLI process.
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
      // Check if prompt is simple enough for direct passing
      const useDirectPrompt = this.isSimplePrompt(promptText);

      if (useDirectPrompt) {
        Log.debug("📝 Using direct prompt (simple, no temp file)");
      } else {
        Log.debug("📁 Using temp file prompt (complex or long)");
      }

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
        }) =>
          tuiProcessor.processStream(
            execution,
            terminal,
            promptWithInstruction,
            timeoutMs,
            this.lastSanitizedPrompt
          ),
        undefined,
        useDirectPrompt
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
   * Common wrapper for interactive TUI execution with proper cleanup.
   *
   * @param args Base CLI arguments
   * @param promptText Prompt text to send
   * @param workflowContext Optional workflow context
   * @param execute Execution callback
   * @param tuiConfigOverrides Optional TUI config overrides
   * @param useDirectPrompt Whether to send prompt directly (no temp file)
   * @returns Success/failure result
   */
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
    }) => Promise<{ success: boolean; errorMessage?: string }>,
    tuiConfigOverrides?: Partial<TuiStreamConfig>,
    useDirectPrompt: boolean = false
  ): Promise<{ success: boolean; errorMessage?: string }> {
    const tuiCommand = this.provider.buildInteractiveTuiCommand(args);
    const displayCommand = `${this.provider.config.name} [TUI mode] "<prompt>"`;

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
      let promptToSend: string;

      if (useDirectPrompt) {
        // Simple prompt: send directly without temp file
        promptToSend = promptText;
        this.lastSanitizedPrompt = promptText;
      } else {
        // Complex prompt: create temp file with instruction
        const { tempFilePath: path, promptWithInstruction } =
          await this.createPromptFileWithReference(promptText, workflowContext);
        tempFilePath = path;
        promptToSend = promptWithInstruction;
        this.lastSanitizedPrompt = promptText;
      }

      const timeoutMs =
        ConfigurationUtils.getMaxPromptExecutionTimeMs() || 12 * 60 * 60 * 1000; // 12 hours default

      const tuiConfig: TuiStreamConfig = {
        escapeIndicator: this.provider.config.escapeIndicator,
        screenEndPattern: this.provider.config.screenEndPattern,
        tuiChromePatterns: this.provider.config.chromePatterns,
        streamingEmitter: this.streamingChunkEmitter,
        responseCompleteEmitter: this.responseCompleteEmitter,
        ...tuiConfigOverrides,
      };

      const tuiProcessor = new TuiStreamProcessor(tuiConfig);

      // CRITICAL: Must await execute() before finally block runs
      return await execute({
        terminal,
        execution,
        promptWithInstruction: promptToSend,
        tuiProcessor,
        timeoutMs,
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

  // ============================================================
  // HEADLESS EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in headless mode.
   *
   * Strategy for simple prompts (≤300 chars, no XML, no backticks):
   * 1. Pass prompt directly on command line (fast!)
   * 2. No file I/O overhead
   *
   * Strategy for complex prompts:
   * 1. Write fully-expanded prompt to temp file
   * 2. Spawn CLI process with @temp-file or --prompt @temp-file parameter
   * 3. Wait for process to complete
   * 4. Cleanup temp file
   *
   * @param args The CLI arguments (WITHOUT prompt)
   * @param promptText The prompt text (will be written to temp file or passed directly)
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
      const useDirectPrompt = this.isSimplePrompt(promptText);
      let headlessArgs: string[];
      let displayCommand: string;

      if (useDirectPrompt) {
        // Simple prompt: pass directly on command line
        headlessArgs = this.provider.buildHeadlessArgsWithDirectPrompt(
          args,
          promptText
        );
        displayCommand = `${this.provider.config.name} ${headlessArgs.join(" ")}`;
        Log.info(`🚀 Starting headless mode with direct prompt (fast path)`);
        Log.info(`📝 Prompt length: ${promptText.length} characters`);
      } else {
        // Complex prompt: create temp file
        const { tempFilePath: path, promptWithInstruction } =
          await this.createPromptFileWithReference(promptText, workflowContext);
        tempFilePath = path;
        headlessArgs = this.provider.buildHeadlessArgs(
          args,
          promptWithInstruction
        );
        displayCommand = `${this.provider.config.name} ${headlessArgs.join(" ")}`;
        Log.info(`🚀 Starting headless mode with file reference`);
        Log.info(`📝 Prompt length: ${promptText.length} characters`);
      }

      this.lastCliCommand = displayCommand;

      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: displayCommand,
      });

      // Check if we should stream output in real-time
      const shouldStream = this.provider.config.shouldStreamHeadlessOutput;

      // Create streaming state map for provider's response parser
      const streamState = new Map<string, any>();

      // Spawn and execute
      const result = await this.spawnProcess(
        this.provider.config.name,
        headlessArgs,
        {
          timeout:
            ConfigurationUtils.getMaxPromptExecutionTimeMs() ||
            12 * 60 * 60 * 1000,
          onStdout: shouldStream
            ? (chunk) => {
                // Delegate to provider's response parser for streaming
                if (this.provider.responseParser.processStreamingChunk) {
                  const processedChunk =
                    this.provider.responseParser.processStreamingChunk(
                      chunk,
                      streamState
                    );
                  if (processedChunk !== undefined) {
                    this.streamingChunkEmitter.fire(processedChunk);
                  }
                } else {
                  // No streaming processor, emit raw chunk
                  this.streamingChunkEmitter.fire(chunk);
                }
              }
            : undefined,
        }
      );

      // Check for cancellation
      if (this.isCancelling) {
        Log.info("⏹️ Prompt execution cancelled by user");
        return false;
      }

      // Delegate result handling to callback
      return await executeCallback(result);
    } catch (error) {
      Log.error(`❌ Headless execution error`, error);
      return false;
    } finally {
      // Cleanup temp file (if used)
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

  // ============================================================
  // OUTPUT LOGGING
  // ============================================================

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
   * Initialize CLI by checking availability via provider.checkAvailability().
   */
  async initialize(): Promise<void> {
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    try {
      const available = await this.provider.checkAvailability();

      if (available) {
        // Get version if provider supports it
        let versionInfo = "";
        if (this.provider.getVersion) {
          const version = await this.provider.getVersion();
          versionInfo = version ? `: ${version}` : "";
        }

        Log.info(
          `✅ ${this.provider.config.displayName} available${versionInfo}`
        );
        this.isAvailable = true;
        this.initializationStatus = CopilotStatus.Ready;
        this.statusChangeEmitter.fire(CopilotStatus.Ready);
      } else {
        this.handleInitializationError("command_failed", "CLI not available");
      }
    } catch (error) {
      this.handleInitializationError("exception", error);
    }
  }

  /**
   * Handle initialization errors with logging.
   */
  protected handleInitializationError(
    type: "command_failed" | "exception",
    error: unknown
  ): void {
    this.isAvailable = false;
    this.initializationStatus = CopilotStatus.Unavailable;
    this.statusChangeEmitter.fire(CopilotStatus.Unavailable);

    Log.error(`❌ ${this.provider.config.displayName} not available`, error);
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

  // ============================================================
  // STATUS & AVAILABILITY
  // ============================================================

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
   * Get integration status.
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message: `✅ ${this.provider.config.displayName} available`,
        strategy: this.getIntegrationMode(),
      };
    } else {
      return {
        available: false,
        message: `❌ ${this.provider.config.displayName} unavailable - ${this.provider.config.installHint}`,
        strategy: this.getIntegrationMode(),
      };
    }
  }

  // ============================================================
  // CANCELLATION & DISPOSAL
  // ============================================================

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

  // ============================================================
  // PROMPT SENDING (MAIN ENTRY POINT)
  // ============================================================

  /**
   * Send a prompt to the CLI.
   *
   * This is the main entry point for executing prompts. It:
   * 1. Builds the prompt with optional dynamic queue instructions
   * 2. Builds CLI arguments (tool permissions, MCP config, session resumption, etc.)
   * 3. Executes in interactive TUI or headless mode based on configuration
   * 4. Parses the response and extracts session ID for continuity
   *
   * @param prompt The prompt item to send
   * @param needsCompletionDetection If true, set up completion detection (default: true)
   * @param workflowContext Optional workflow context for dynamic queue and temp file naming
   * @returns True if prompt was sent successfully
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
    try {
      this.resetCancellationFlag();

      // Build prompt with optional dynamic queue instructions
      const finalPromptText = await this.buildPromptWithInstructions(
        prompt,
        workflowContext?.promptIndex ?? 0,
        workflowContext?.allPrompts ?? [prompt],
        workflowContext?.filePath
      );

      this.lastFullPrompt = finalPromptText;

      // Log prompt
      this.logPrompt(finalPromptText);

      // Build base CLI arguments
      const baseArgs = await this.buildCliArgs(prompt, workflowContext);

      // Execute based on mode
      const mode = this.getExecutionMode();
      let success = false;

      if (mode === CLI_EXECUTION_MODE.INTERACTIVE) {
        success = await this.executeInTerminal(
          baseArgs,
          finalPromptText,
          workflowContext
        );
      } else {
        // Headless mode
        this.warnIfHeadlessWithoutPermissions();

        success = await this.executeHeadlessWithPromptFile(
          baseArgs,
          finalPromptText,
          workflowContext,
          async (result) => {
            // Parse result using provider's response parser
            const parsed = this.provider.responseParser.parse(
              result.stdout,
              result.stderr,
              result.exitCode
            );

            // Extract session ID if available
            if (parsed.sessionId) {
              this.sessionId = parsed.sessionId;
              Log.debug(`📝 Session ID: ${this.sessionId}`);
            }

            // Store result
            this.lastResult = parsed;

            // Log response
            this.logResponse(parsed.response, parsed.statistics);

            // Fire response complete event
            this.responseCompleteEmitter.fire(parsed.response);

            return parsed.exitCode === 0;
          }
        );
      }

      return success;
    } catch (error) {
      Log.error("❌ Error sending prompt", error);
      this.lastFailureReason =
        error instanceof Error ? error.message : "Unknown error";
      return false;
    }
  }

  /**
   * Build CLI arguments including tool permissions, MCP config, session resumption, etc.
   *
   * @param prompt The prompt item
   * @param workflowContext Optional workflow context
   * @returns Array of CLI arguments
   */
  protected async buildCliArgs(
    prompt: PromptItem,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // Add tool permissions
    const permissionConfig = {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    const permissionArgs =
      this.provider.toolPermissionMapper.buildArgs(permissionConfig);
    args.push(...permissionArgs);

    // Add workspace directories (if supported)
    const workspaceDirs = this.getWorkspaceDirs();
    for (const dir of workspaceDirs) {
      args.push("--add-dir", dir);
    }

    // Add MCP config for dynamic queue (if enabled and supported)
    const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
    if (dynamicQueueConfig.enabled && prompt.allowDynamicExtension) {
      const workspaceRoot = this.getWorkspaceRoot();
      if (workspaceRoot) {
        // Get MCP server path from environment or default location
        const mcpServerPath =
          process.env.FLIGHTPATH_MCP_SERVER || "flightpath-mcp";
        const mcpArgs = await this.getMcpConfigArgs(
          mcpServerPath,
          workspaceRoot
        );
        if (mcpArgs) {
          args.push(...mcpArgs);
        }
      }
    }

    // Add session resumption (if we have a session ID)
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // Add model override (if specified in prompt)
    if (prompt.model) {
      args.push("--model", prompt.model);
    }

    return args;
  }
}
