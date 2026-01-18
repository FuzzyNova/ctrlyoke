import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import { CliResult } from "../../types/CopilotTypes";
import { PromptItem, Provider, PromptFile } from "../../types/FlightPathTypes";
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
import { PromptFileSplitter } from "../../utils/PromptFileSplitter";
import {
  ResolvedProperties,
  PropertyResolver,
} from "../../utils/PropertyResolver";
import { SessionResolver } from "../../utils/SessionResolver";
import { SessionValidator } from "../../utils/SessionValidator";
import type { PromptQueue } from "../PromptQueue";

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
 * Result of creating prompt file(s) with reference instruction
 */
interface PromptFileResult {
  /** Array of temp file paths (for cleanup) */
  tempFilePaths: string[];

  /** Instruction prompt that references all files */
  promptWithInstruction: string;
}

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

  /** Initialization status */
  protected initializationStatus: CopilotStatus = CopilotStatus.Initializing;

  /** Last CLI execution result */
  protected lastResult?: CliResult;

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
   * Create temp file(s) for the prompt and return file reference instruction.
   *
   * For large prompts (>20K tokens or >1800 lines), splits into multiple files
   * with decimal notation (e.g., prompt-1.1.md, prompt-1.2.md, prompt-1.3.md).
   *
   * Returns both temp file paths (for cleanup) and instruction prompt that
   * references all files.
   *
   * @param promptText The full prompt text to write
   * @param workflowContext Optional workflow context for meaningful filename
   * @returns Object with tempFilePaths array and promptWithInstruction
   */
  protected async createPromptFileWithReference(
    promptText: string,
    workflowContext?: WorkflowContext
  ): Promise<PromptFileResult> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace root available for temp file");
    }

    const tempMgr = new TempFileManager(workspaceRoot);

    // Check if splitting is needed
    const splitter = new PromptFileSplitter();
    const splitResult = splitter.split(promptText);

    if (!splitResult.needsSplit) {
      // Single file path (backward compatible)
      const tempFilePath = await tempMgr.createPromptFile(
        promptText,
        workflowContext?.filePath,
        workflowContext ? workflowContext.promptIndex + 1 : undefined
      );
      const relativeFilePath = tempMgr.getRelativePath(tempFilePath);
      const fileReference = this.provider.formatFileReference(relativeFilePath);
      const promptWithInstruction = `Follow instructions in ${fileReference} `;

      Log.info(`📁 Temp file created: ${relativeFilePath}`);
      Log.info(
        `📊 Prompt stats: ${splitResult.tokenCounts[0]} tokens, ${splitResult.lineCounts[0]} lines`
      );

      return {
        tempFilePaths: [tempFilePath],
        promptWithInstruction,
      };
    }

    // Multiple files needed
    const tempFilePaths = await tempMgr.createSplitPromptFiles(
      splitResult.chunks,
      workflowContext?.filePath,
      workflowContext ? workflowContext.promptIndex + 1 : undefined
    );

    // Build instruction referencing all files
    const fileReferences = tempFilePaths.map((fp) => {
      const relativePath = tempMgr.getRelativePath(fp);
      return this.provider.formatFileReference(relativePath);
    });

    // Format: "Follow instructions in @file1, @file2, and @file3 "
    const promptWithInstruction =
      this.formatMultipleFileReferences(fileReferences);

    // Log split statistics
    Log.info(`📁 Prompt split into ${splitResult.chunks.length} files:`);
    splitResult.chunks.forEach((_, idx) => {
      const relativePath = tempMgr.getRelativePath(tempFilePaths[idx]);
      Log.info(
        `   ${idx + 1}. ${relativePath} (${splitResult.tokenCounts[idx]} tokens, ${splitResult.lineCounts[idx]} lines)`
      );
    });

    return {
      tempFilePaths,
      promptWithInstruction,
    };
  }

  /**
   * Format multiple file references into instructional prompt
   * Uses natural language formatting: "file1, file2, and file3"
   *
   * @param fileRefs Array of file references (already formatted with @ prefix if needed)
   * @returns Instruction prompt with trailing space
   */
  private formatMultipleFileReferences(fileRefs: string[]): string {
    if (fileRefs.length === 1) {
      return `Follow instructions in ${fileRefs[0]} `;
    }

    if (fileRefs.length === 2) {
      return `Follow instructions in ${fileRefs[0]} and ${fileRefs[1]} `;
    }

    // 3+ files: "file1, file2, and file3"
    const allButLast = fileRefs.slice(0, -1).join(", ");
    const last = fileRefs[fileRefs.length - 1];
    return `Follow instructions in ${allButLast}, and ${last} `;
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
   *    - If provider uses notification monitoring: dual monitoring (TUI + notification)
   *    - Otherwise: TUI-only completion detection
   *
   * Session continuity is handled via --resume flag in CLI args, not by
   * reusing the same terminal. Each execution starts a fresh CLI process.
   *
   * @param args The CLI arguments (WITHOUT prompt, but WITH --resume if session should continue)
   * @param promptText The prompt text (will be sent via sendText)
   * @param workflowContext Optional workflow context for temp file naming
   * @param resolvedSessionId Resolved session ID for notification monitoring
   * @returns Promise with success flag and optional sessionId
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string,
    workflowContext?: WorkflowContext,
    resolvedSessionId?: string
  ): Promise<{ success: boolean; sessionId?: string }> {
    try {
      // Check if prompt is simple enough for direct passing
      const useDirectPrompt = this.isSimplePrompt(promptText);

      if (useDirectPrompt) {
        Log.debug("📝 Using direct prompt (simple, no temp file)");
      } else {
        Log.debug("📁 Using temp file prompt (complex or long)");
      }

      // Check if provider uses notification-based completion detection
      const useNotificationMonitoring =
        this.provider.config.usesInteractiveNotificationMonitor === true;

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
          if (useNotificationMonitoring) {
            // Dual monitoring: TUI + notification file (Claude, Copilot, Codex)
            return this.executeDualMonitoring(
              execution,
              terminal,
              promptWithInstruction,
              tuiProcessor,
              timeoutMs,
              resolvedSessionId // Pass resolved session for notification monitoring
            );
          } else {
            // TUI-only monitoring (fallback)
            return tuiProcessor.processStream(
              execution,
              terminal,
              promptWithInstruction,
              timeoutMs,
              this.lastSanitizedPrompt
            );
          }
        },
        undefined,
        useDirectPrompt
      );

      if (!result.success && result.errorMessage) {
        this.lastFailureReason = result.errorMessage;
      }

      return { success: result.success, sessionId: result.sessionId };
    } catch (error) {
      Log.error(`❌ TUI execution error`, error);
      throw error;
    }
  }

  /**
   * Execute with dual monitoring: TUI stream + notification file.
   *
   * Uses Promise.race to detect completion from either:
   * - TUI stream processing (escape indicator disappearing)
   * - Notification file (hook writes completion file)
   *
   * When notification detects completion first:
   * 1. Aborts TUI stream processing
   * 2. Extracts session ID from notification data
   * 3. Waits for TUI stream to finish (cleanup)
   *
   * This provides more reliable completion detection for CLIs that
   * support hooks (Claude Stop hook, Copilot sessionEnd, Codex notify).
   *
   * @param execution Terminal shell execution
   * @param terminal Terminal instance
   * @param promptWithInstruction Prompt text to send
   * @param tuiProcessor TUI stream processor
   * @param timeoutMs Execution timeout in milliseconds
   * @param resolvedSessionId Resolved session ID for monitoring (undefined = wildcard mode)
   * @returns TuiProcessResult with success flag and optional error
   */
  private async executeDualMonitoring(
    execution: vscode.TerminalShellExecution,
    terminal: vscode.Terminal,
    promptWithInstruction: string,
    tuiProcessor: TuiStreamProcessor,
    timeoutMs: number,
    resolvedSessionId?: string
  ): Promise<{ success: boolean; errorMessage?: string; sessionId?: string }> {
    const tuiAbortController = new AbortController();
    const startTime = new Date();
    const workspaceRoot = this.getWorkspaceRoot();

    if (!workspaceRoot) {
      Log.warn("⚠️ No workspace root - falling back to TUI-only monitoring");
      return tuiProcessor.processStream(
        execution,
        terminal,
        promptWithInstruction,
        timeoutMs,
        this.lastSanitizedPrompt
      );
    }

    Log.info("⏳ Starting TUI processing with notification monitoring...");

    // Start TUI stream processing
    const tuiPromise = tuiProcessor.processStream(
      execution,
      terminal,
      promptWithInstruction,
      timeoutMs,
      this.lastSanitizedPrompt,
      tuiAbortController
    );

    // Get notification directory from provider
    const notifyDir =
      this.provider.notificationMonitor.getNotificationDirectory(workspaceRoot);

    // Track whether the race has resolved - used to cancel notification monitor
    // when TUI finishes first, preventing stale monitors from stealing hook files
    // from subsequent runs
    let raceResolved = false;

    // Start notification monitoring
    const notifyPromise =
      this.provider.notificationMonitor.monitorForCompletion(
        {
          directory: notifyDir,
          timeoutMs,
        },
        resolvedSessionId, // undefined = wildcard mode for first prompt
        startTime,
        () => this.isCancelling || raceResolved // Cancel when user cancels OR race resolved
      );

    // Race: TUI completion vs notification file
    type NotifyLikeResult = { completed: boolean; error?: string; data?: any };

    const notifyResult = await Promise.race<NotifyLikeResult>([
      notifyPromise,
      tuiPromise.then((tuiResult) => ({
        completed: tuiResult.success,
        error: tuiResult.errorMessage,
      })),
    ]);

    // Mark race as resolved to stop the notification monitor if it's still running
    // This prevents the monitor from stealing hook files from subsequent runs
    raceResolved = true;

    let extractedSessionId: string | undefined;

    if (notifyResult.completed) {
      Log.debug("🛑 Notification detected completion - aborting TUI stream");
      tuiAbortController.abort();

      // Extract session ID from notification data if available
      if (
        "data" in notifyResult &&
        notifyResult.data &&
        this.provider.notificationMonitor.extractSessionId
      ) {
        extractedSessionId = this.provider.notificationMonitor.extractSessionId(
          notifyResult.data
        );
        if (extractedSessionId) {
          Log.debug(`💾 Session ID from notification: ${extractedSessionId}`);
        }
      }
    }

    // Wait for TUI stream to finish (ensures cleanup)
    const tuiResult = await tuiPromise;

    if (!notifyResult.completed) {
      const errorMsg = notifyResult.error || "Completion detection failed";
      Log.error(`❌ Execution failed: ${errorMsg}`);
      return { success: false, errorMessage: errorMsg };
    }

    // Log any TUI error as warning (notification took precedence)
    if (!tuiResult.success && tuiResult.errorMessage) {
      Log.warn(`⚠️ TUI processor reported: ${tuiResult.errorMessage}`);
    }

    // CRITICAL: Extract and store response from terminal output
    // Interactive mode doesn't parse output automatically like headless mode does.
    // We need to extract the response text from the terminal stream for WorkflowExecutor.
    const terminalOutput = tuiProcessor.getAccumulatedOutput();
    if (terminalOutput) {
      // Parse the terminal output to extract response and statistics
      const parsed = this.provider.responseParser.parseInteractiveResponse(
        terminalOutput,
        this.lastSanitizedPrompt || ""
      );

      // Store the result so getLastResult() works
      this.lastResult = parsed;

      // Log the response for visibility
      this.logResponse(parsed.response, parsed.statistics);
    } else {
      Log.warn("⚠️ No terminal output captured - lastResult may be incomplete");
    }

    return { success: true, sessionId: extractedSessionId };
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
   * @returns Success/failure result with optional sessionId
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
    }) => Promise<{
      success: boolean;
      errorMessage?: string;
      sessionId?: string;
    }>,
    tuiConfigOverrides?: Partial<TuiStreamConfig>,
    useDirectPrompt: boolean = false
  ): Promise<{ success: boolean; errorMessage?: string; sessionId?: string }> {
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

    let tempFilePaths: string[] = [];

    try {
      let promptToSend: string;

      if (useDirectPrompt) {
        // Simple prompt: send directly without temp file
        promptToSend = promptText;
        this.lastSanitizedPrompt = promptText;
      } else {
        // Complex prompt: create temp file(s) with instruction
        const { tempFilePaths: paths, promptWithInstruction } =
          await this.createPromptFileWithReference(promptText, workflowContext);
        tempFilePaths = paths;
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
      if (tempFilePaths.length > 0) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const tempMgr = new TempFileManager(workspaceRoot);
          await tempMgr.deleteFiles(tempFilePaths);
          Log.debug(`🗑️ Cleaned up ${tempFilePaths.length} temp file(s)`);
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
    let tempFilePaths: string[] = [];

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
        // Complex prompt: create temp file(s)
        const { tempFilePaths: paths, promptWithInstruction } =
          await this.createPromptFileWithReference(promptText, workflowContext);
        tempFilePaths = paths;
        headlessArgs = this.provider.buildHeadlessArgs(
          args,
          promptWithInstruction
        );
        displayCommand = `${this.provider.config.name} ${headlessArgs.join(" ")}`;
        Log.info(`🚀 Starting headless mode with ${paths.length} file(s)`);
        Log.info(`📝 Total prompt length: ${promptText.length} characters`);
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
      // Cleanup temp file(s) (if used)
      if (tempFilePaths.length > 0) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const tempMgr = new TempFileManager(workspaceRoot);
          await tempMgr.deleteFiles(tempFilePaths);
          Log.debug(`🗑️ Cleaned up ${tempFilePaths.length} temp file(s)`);
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
  getLastResult(): CliResult | undefined {
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
      resolvedProperties?: ResolvedProperties;
      workflowFile?: PromptFile;
      promptQueue?: PromptQueue;
    }
  ): Promise<boolean> {
    try {
      this.resetCancellationFlag();

      // Resolve session ID for current prompt using SessionResolver
      let resolvedSessionId = SessionResolver.resolve(
        prompt,
        workflowContext?.promptIndex ?? 0,
        workflowContext?.allPrompts ?? [prompt],
        workflowContext?.workflowFile
      );

      // Resolve execution properties (provider, model, agent)
      const resolvedProperties = workflowContext?.workflowFile
        ? PropertyResolver.resolve(prompt, workflowContext.workflowFile)
        : workflowContext?.resolvedProperties;

      // Validate session ID format before passing to CLI (Phase 5)
      if (resolvedSessionId) {
        const provider =
          resolvedProperties?.provider ??
          (this.getIntegrationMode() as Provider);
        if (!SessionValidator.validate(resolvedSessionId, provider)) {
          // Invalid format - start new session instead
          Log.info(`🔄 Starting new session due to invalid session ID format`);
          resolvedSessionId = undefined;
        }
      }

      // Build prompt with optional dynamic queue instructions
      const finalPromptText = await this.buildPromptWithInstructions(
        prompt,
        workflowContext?.promptIndex ?? 0,
        workflowContext?.allPrompts ?? [prompt],
        workflowContext?.filePath,
        resolvedProperties?.allowDynamicExtension
      );

      this.lastFullPrompt = finalPromptText;

      // Log prompt
      this.logPrompt(finalPromptText);

      // Determine execution mode first
      const mode = this.getExecutionMode();
      const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;

      // Build CLI arguments - delegated to provider for complete control
      const workspaceRoot = this.getWorkspaceRoot();
      const baseArgs = await this.provider.buildCliArgs(
        prompt,
        isInteractive,
        this.context,
        workspaceRoot,
        resolvedSessionId, // Use resolved session instead of this.sessionId
        workflowContext
      );

      // Execute based on mode
      let success = false;
      let extractedSessionId: string | undefined;

      if (mode === CLI_EXECUTION_MODE.INTERACTIVE) {
        const result = await this.executeInTerminal(
          baseArgs,
          finalPromptText,
          workflowContext,
          resolvedSessionId
        );
        success = result.success;
        extractedSessionId = result.sessionId;
      } else {
        // Headless mode
        this.warnIfHeadlessWithoutPermissions();

        // Claude CLI error recovery wrapper (Phase 5)
        const executeWithRecovery = async (
          args: string[],
          promptText: string
        ): Promise<boolean> => {
          try {
            return await this.executeHeadlessWithPromptFile(
              args,
              promptText,
              workflowContext,
              async (result) => {
                // Parse result using provider's response parser
                const parsed = this.provider.responseParser.parse(
                  result.stdout,
                  result.stderr,
                  result.exitCode
                );

                // Extract session ID if available from output or logs
                if (parsed.sessionId) {
                  extractedSessionId = parsed.sessionId;
                  Log.debug(`📝 Session ID from output: ${extractedSessionId}`);
                } else if (this.provider.extractSessionIdFromLogs) {
                  // For CLIs that store session ID in log files (e.g., Copilot)
                  const logSessionId =
                    await this.provider.extractSessionIdFromLogs();
                  if (logSessionId) {
                    extractedSessionId = logSessionId;
                    Log.debug(`📝 Session ID from logs: ${extractedSessionId}`);
                  }
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
          } catch (error) {
            // Check for recoverable session errors using provider's response parser (Phase 5)
            if (
              this.provider.responseParser.isRecoverableSessionError?.(error)
            ) {
              const currentProvider =
                resolvedProperties?.provider ??
                (this.getIntegrationMode() as Provider);

              if (currentProvider === Provider.ClaudeCli) {
                Log.warn(
                  `⚠️ Claude CLI rejected session ID "${resolvedSessionId}". ` +
                    `Retrying without resume flag.`
                );

                // Rebuild args without session ID
                const argsWithoutResume = await this.provider.buildCliArgs(
                  prompt,
                  false, // headless mode
                  this.context,
                  this.getWorkspaceRoot() || "",
                  undefined, // no session ID - start new session
                  workflowContext
                );

                // Retry with new args
                return await this.executeHeadlessWithPromptFile(
                  argsWithoutResume,
                  promptText,
                  workflowContext,
                  async (result) => {
                    const parsed = this.provider.responseParser.parse(
                      result.stdout,
                      result.stderr,
                      result.exitCode
                    );

                    if (parsed.sessionId) {
                      extractedSessionId = parsed.sessionId;
                      Log.debug(
                        `📝 New session ID from retry: ${extractedSessionId}`
                      );
                    }

                    this.lastResult = parsed;
                    this.logResponse(parsed.response, parsed.statistics);
                    this.responseCompleteEmitter.fire(parsed.response);

                    return parsed.exitCode === 0;
                  }
                );
              }
            }
            // Re-throw if not a recoverable error
            throw error;
          }
        };

        success = await executeWithRecovery(baseArgs, finalPromptText);
      }

      // Store session ID in prompt's _runtime metadata (both modes)
      if (success && extractedSessionId) {
        if (!prompt._runtime) {
          prompt._runtime = {
            provider:
              resolvedProperties?.provider ??
              (this.getIntegrationMode() as Provider),
            model: resolvedProperties?.model ?? "",
            agent: resolvedProperties?.agent,
            startedAt: Date.now(),
          };
        }
        prompt._runtime.sessionId = extractedSessionId;
        prompt._runtime.completedAt = Date.now();

        // Persist runtime metadata to working file
        if (workflowContext?.promptQueue) {
          await workflowContext.promptQueue.updateWorkingFile();
          Log.debug(`💾 Saved runtime metadata to working file`);
        }
      }

      return success;
    } catch (error) {
      Log.error("❌ Error sending prompt", error);
      this.lastFailureReason =
        error instanceof Error ? error.message : "Unknown error";
      return false;
    }
  }

  // ============================================================
  // ERROR RECOVERY (PHASE 5)
  // ============================================================
  // NOTE: Error recovery logic is now provider-specific.
  // See IResponseParser.isRecoverableSessionError() for implementation.
}
