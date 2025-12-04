import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

/**
 * Execution mode for CLI integrations
 */
export type CliExecutionMode = "interactive" | "headless";

/**
 * Execution mode constants - single source of truth
 */
export const CLI_EXECUTION_MODE = {
  INTERACTIVE: "interactive" as const,
  HEADLESS: "headless" as const,
};

/**
 * Base class for CLI integrations (Copilot CLI and Claude CLI)
 *
 * Provides shared functionality for CLI-based AI integrations:
 * - Logging and output channel management
 * - Process spawning with stdin, timeout, and streaming support
 * - Interactive terminal execution with shell integration
 * - Workspace directory resolution
 * - Session management
 * - Result accessors for dashboard
 * - Cancellation handling
 *
 * Subclasses implement CLI-specific logic:
 * - Command and argument building
 * - Output parsing (different formats)
 * - Model validation (different supported models)
 * - Tool permissions (different flag syntax)
 * - Error message formatting
 */
export abstract class BaseCliIntegration extends CopilotIntegration {
  protected sessionId?: string;
  protected initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  protected outputChannel?: vscode.OutputChannel;
  protected lastResult?: CopilotCliResult;
  protected lastCliCommand?: string;
  protected lastFullPrompt?: string;
  protected currentProcess?: ChildProcess;

  // Terminal mode properties
  protected terminal?: vscode.Terminal;
  protected shellIntegration?: vscode.TerminalShellIntegration;
  protected currentExecution?: vscode.TerminalShellExecution;

  // Temp file for prompt storage (interactive mode)
  protected tempPromptFile?: string;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel
  ) {
    super(context);
    this.outputChannel = outputChannel;
  }

  // ============================================================
  // EXECUTION MODE HELPERS
  // ============================================================

  /**
   * Get the configured execution mode (interactive or headless)
   */
  protected getExecutionMode(): CliExecutionMode {
    return ConfigurationUtils.getCliExecutionMode() as CliExecutionMode;
  }

  /**
   * Get or create a VS Code terminal for interactive execution
   */
  protected async getOrCreateTerminal(): Promise<vscode.Terminal> {
    if (this.terminal && !this.isTerminalClosed()) {
      return this.terminal;
    }

    this.terminal = vscode.window.createTerminal({
      name: `FlightPath: ${this.getCliName()}`,
      cwd: this.getWorkspaceRoot(),
    });

    return this.terminal;
  }

  /**
   * Check if the terminal has been closed
   */
  private isTerminalClosed(): boolean {
    return !this.terminal || this.terminal.exitStatus !== undefined;
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
    // If already available, return immediately
    if (terminal.shellIntegration) {
      return terminal.shellIntegration;
    }

    // Wait for shell integration to activate
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        disposable.dispose();
        reject(new Error("Shell integration not available"));
      }, timeoutMs);

      const disposable = vscode.window.onDidChangeTerminalShellIntegration(
        (event) => {
          if (event.terminal === terminal) {
            clearTimeout(timeout);
            disposable.dispose();
            resolve(event.shellIntegration);
          }
        }
      );
    });
  }

  /**
   * Strip ANSI escape codes and terminal control sequences from output for clean display.
   *
   * Handles:
   * - CSI sequences: \x1B[...  (colors, cursor movement, etc.)
   * - OSC sequences: \x1B]...\x07 or \x1B]...\x1B\\ (VS Code shell integration markers like 633;C)
   * - Simple escapes: \x1B followed by single character
   * - Bell character: \x07
   * - Other control characters that shouldn't appear in output
   *
   * Special handling:
   * - Cursor position sequences (\x1B[row;colH) are replaced with newlines
   *   to preserve visual line breaks
   */
  protected stripAnsiCodes(text: string): string {
    return (
      text
        // OSC sequences: \x1B] ... terminated by BEL (\x07) or ST (\x1B\\)
        .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "")
        // Cursor position (H) and similar commands that move to new lines - replace with newline
        .replace(/\x1B\[[0-9;]*[Hf]/g, "\n")
        // Other CSI sequences: \x1B[ followed by parameters and command (remove)
        .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
        // Other escape sequences: \x1B followed by various characters
        .replace(/\x1B[@-Z\\-_]/g, "")
        // Standalone BEL character
        .replace(/\x07/g, "")
        // Hide cursor and other private sequences
        .replace(/\x1B\[\?[0-9;]*[A-Za-z]/g, "")
        // Clean up multiple consecutive newlines (but keep at least one)
        .replace(/\n{3,}/g, "\n\n")
    );
  }

  /**
   * Get the CLI name for terminal/logging (e.g., "copilot" or "claude")
   */
  protected abstract getCliName(): string;

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Used to warn users when running headless without full permissions
   */
  protected abstract hasFullPermissions(): boolean;

  // ============================================================
  // TEMP FILE MANAGEMENT FOR PROMPT PASSING
  // ============================================================

  /**
   * Write prompt to a temporary file and return the file path.
   * This avoids shell escaping issues when passing prompts with special characters.
   *
   * @param promptText The prompt text to write
   * @returns The path to the temp file
   */
  protected async writePromptToTempFile(promptText: string): Promise<string> {
    // Create unique temp file name
    const tempDir = os.tmpdir();
    const fileName = `flightpath-prompt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.txt`;
    const filePath = path.join(tempDir, fileName);

    // Write the prompt to the file (no escaping needed)
    await fs.writeFile(filePath, promptText, "utf-8");

    // Track for cleanup
    this.tempPromptFile = filePath;

    // DEBUG: Log file size info
    const stats = await fs.stat(filePath);
    this.log(`📝 Wrote prompt to temp file: ${filePath}`);
    this.log(
      `📝 DEBUG: Prompt length: ${promptText.length} chars, File size: ${stats.size} bytes`
    );

    return filePath;
  }

  /**
   * Clean up the temporary prompt file if it exists.
   * Called after command execution completes.
   *
   * DEBUG: Set DEBUG_KEEP_TEMP_FILES=true to prevent deletion for debugging
   */
  protected async cleanupTempPromptFile(): Promise<void> {
    if (this.tempPromptFile) {
      // DEBUG: Skip cleanup to inspect temp files
      const debugKeepFiles = true; // TODO: Set to false after debugging
      if (debugKeepFiles) {
        this.log(
          `🔍 DEBUG: Keeping temp file for inspection: ${this.tempPromptFile}`
        );
        this.log(
          `🔍 DEBUG: Run 'Get-Content "${this.tempPromptFile}"' to view contents`
        );
        this.tempPromptFile = undefined;
        return;
      }

      try {
        await fs.unlink(this.tempPromptFile);
        this.log(`🧹 Cleaned up temp file: ${this.tempPromptFile}`);
      } catch (error) {
        // Ignore errors (file may already be deleted)
        console.warn(
          `Failed to delete temp file: ${this.tempPromptFile}`,
          error
        );
      }
      this.tempPromptFile = undefined;
    }
  }

  // ============================================================
  // SHARED PROMPT PREPARATION (used by both interactive and headless modes)
  // ============================================================

  /**
   * Prepare prompt for CLI execution using temp file approach.
   * For interactive mode, builds a shell command that reads from file.
   * For headless mode, returns args that can use shell expansion.
   *
   * @param args The command-line arguments (WITHOUT prompt)
   * @param promptText The prompt text (will be written to temp file)
   * @returns Object with:
   *   - shellCommand: Full shell command for interactive mode (uses script block)
   *   - argsWithPrompt: Args array for headless mode (with file read expression)
   *   - displayCommand: Human-readable command (with <prompt> placeholder)
   */
  protected async preparePromptForExecution(
    args: string[],
    promptText: string
  ): Promise<{
    shellCommand: string;
    argsWithPrompt: string[];
    displayCommand: string;
  }> {
    // Write prompt to temp file
    const tempFile = await this.writePromptToTempFile(promptText);

    // Delegate to subclass for CLI-specific command building
    return this.buildPromptCommand(args, tempFile);
  }

  /**
   * Build the shell command and args for executing with a prompt from a temp file.
   * Each CLI has different conventions for passing the prompt.
   *
   * @param args The command-line arguments (WITHOUT prompt)
   * @param tempFilePath Path to the temp file containing the prompt
   * @returns Object with shellCommand (for interactive), argsWithPrompt (for headless), displayCommand
   */
  protected abstract buildPromptCommand(
    args: string[],
    tempFilePath: string
  ): { shellCommand: string; argsWithPrompt: string[]; displayCommand: string };

  // ============================================================
  // INTERACTIVE TERMINAL EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in an interactive VS Code terminal
   * Uses shell integration for output streaming and completion detection.
   *
   * Uses temp file approach to pass prompts safely:
   * 1. Write prompt to temp file (no escaping needed)
   * 2. Execute shell command that reads file content inside a script block
   * 3. Clean up temp file after execution
   *
   * @param args The command-line arguments (WITHOUT prompt - prompt handled separately)
   * @param promptText The prompt text (will be written to temp file)
   * @returns Promise<boolean> indicating success
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string
  ): Promise<boolean> {
    // Use shared method to prepare prompt command (delegates to subclass)
    const { shellCommand, displayCommand } =
      await this.preparePromptForExecution(args, promptText);

    // DEBUG: Log command length - shellCommand uses script block to avoid expansion
    this.log(`🔍 DEBUG: Shell command length: ${shellCommand.length} chars`);
    this.log(`🔍 DEBUG: Display command: ${displayCommand}`);

    // Get or create terminal
    const terminal = await this.getOrCreateTerminal();
    terminal.show();

    // Fire prompt ready event (before execution starts)
    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: displayCommand,
    });

    // Send initial message to dashboard indicating interactive mode
    // This helps user understand output is in the terminal
    this.streamingChunkEmitter.fire(
      "📺 Interactive mode: Output is streaming to the VS Code terminal.\n" +
        "   View the terminal for real-time output. This area will show captured output if available.\n\n"
    );

    try {
      // Wait for shell integration (with fallback)
      let shellIntegration: vscode.TerminalShellIntegration;
      try {
        shellIntegration = await this.waitForShellIntegration(terminal);
      } catch {
        // Fallback: use sendText without streaming
        vscode.window.showWarningMessage(
          "Shell integration unavailable. Output streaming disabled, using fallback mode."
        );
        terminal.sendText(shellCommand);
        // Can't detect completion without shell integration
        // Return true and let user manage manually
        this.log(
          "⚠️ Shell integration unavailable - using sendText fallback (no completion detection)"
        );
        this.streamingChunkEmitter.fire(
          "⚠️ Shell integration unavailable - output capture disabled.\n" +
            "   Please view the terminal directly for command output.\n"
        );
        return true;
      }

      // Execute shell command via shell integration
      // Uses script block approach to keep prompt content off main command line
      const execution = shellIntegration.executeCommand(shellCommand);
      this.currentExecution = execution;

      // Start streaming output to dashboard (runs in parallel with completion detection)
      const streamingPromise = this.streamTerminalOutput(execution);

      // Wait for command completion
      const success = await this.waitForTerminalCompletion(execution);

      // Wait for streaming to finish (important: the listener in WorkflowExecutor
      // will be disposed after sendPrompt returns, so we must ensure all streaming
      // events are fired before returning)
      await streamingPromise;

      return success;
    } finally {
      // Always clean up temp file
      await this.cleanupTempPromptFile();
    }
  }

  /**
   * Stream terminal output to the dashboard and output channel.
   *
   * NOTE: VS Code's shell integration read() API can be unreliable on some
   * platforms (especially Windows/PowerShell). If no data is captured, the
   * user should view the terminal directly. See:
   * https://github.com/microsoft/vscode/issues/241592
   */
  private async streamTerminalOutput(
    execution: vscode.TerminalShellExecution
  ): Promise<void> {
    console.log("🔍 streamTerminalOutput: Starting to read terminal output...");
    let chunkCount = 0;
    let totalBytes = 0;
    try {
      for await (const data of execution.read()) {
        chunkCount++;
        totalBytes += data.length;
        console.log(
          `🔍 streamTerminalOutput: Received chunk ${chunkCount}, length=${data.length}`
        );
        console.log(
          `🔍 streamTerminalOutput: Raw data (first 200 chars): ${JSON.stringify(data.substring(0, 200))}`
        );

        // Strip ANSI codes for clean dashboard display
        const cleanData = this.stripAnsiCodes(data);
        console.log(
          `🔍 streamTerminalOutput: Clean data length=${cleanData.length}, content (first 200 chars): ${JSON.stringify(cleanData.substring(0, 200))}`
        );

        // Fire the streaming event
        console.log(
          `🔍 streamTerminalOutput: Firing streamingChunkEmitter with ${cleanData.length} chars...`
        );
        this.streamingChunkEmitter.fire(cleanData);
        console.log(
          `🔍 streamTerminalOutput: streamingChunkEmitter.fire() completed`
        );

        // Also log to output channel (with ANSI codes for color)
        this.outputChannel?.append(data);
      }
      console.log(
        `🔍 streamTerminalOutput: Finished reading, total chunks=${chunkCount}, bytes=${totalBytes}`
      );

      // If no output was captured, notify the user
      if (chunkCount === 0) {
        this.streamingChunkEmitter.fire(
          "\n⚠️ No output captured via shell integration.\n" +
            "   This is a known VS Code limitation on some platforms (especially Windows/PowerShell).\n" +
            "   Please view the terminal window for the full output.\n"
        );
      }
    } catch (error) {
      console.error("Stream error:", error);
      this.streamingChunkEmitter.fire(
        `\n❌ Error capturing output: ${error}\n` +
          "   Please view the terminal window for the output.\n"
      );
    }
  }

  /**
   * Wait for terminal command completion and return success status
   */
  private waitForTerminalCompletion(
    execution: vscode.TerminalShellExecution
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const disposable = vscode.window.onDidEndTerminalShellExecution(
        (event) => {
          if (event.execution === execution) {
            disposable.dispose();
            this.currentExecution = undefined;

            const success = event.exitCode === 0;
            const message = success
              ? "Command completed successfully"
              : `Command failed with exit code ${event.exitCode}`;

            this.log(success ? `✅ ${message}` : `❌ ${message}`);
            this.responseCompleteEmitter.fire(message);
            resolve(success);
          }
        }
      );
    });
  }

  // ============================================================
  // LOGGING HELPERS (shared by all CLI integrations)
  // ============================================================

  /**
   * Log message to both console and output channel (if enabled)
   */
  protected log(message: string): void {
    console.log(message);
    if (this.shouldShowOutput()) {
      this.outputChannel?.appendLine(message);
    }
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
      this.outputChannel?.appendLine("");
      this.outputChannel?.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel?.appendLine(
        `[PROMPT] ${new Date().toLocaleTimeString()}`
      );
      this.outputChannel?.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      this.outputChannel?.appendLine(promptText);
      this.outputChannel?.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      this.outputChannel?.appendLine("");
    }
  }

  /**
   * Log response to output channel with formatting
   */
  protected logResponse(response: string, statistics?: string): void {
    if (this.shouldShowOutput()) {
      this.outputChannel?.appendLine(
        `[RESPONSE] ${new Date().toLocaleTimeString()}`
      );
      this.outputChannel?.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      this.outputChannel?.appendLine(response);
      if (statistics) {
        this.outputChannel?.appendLine("");
        this.outputChannel?.appendLine("[STATISTICS]");
        this.outputChannel?.appendLine(statistics);
      }
      this.outputChannel?.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      this.outputChannel?.appendLine("");
    }
  }

  // ============================================================
  // HEADLESS PROCESS EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in headless mode (background process).
   * Handles temp file setup, prompt ready event, and cleanup.
   *
   * Subclasses call this and provide a callback for CLI-specific execution.
   *
   * @param args The command-line arguments (WITHOUT prompt)
   * @param promptText The prompt text
   * @param executeCallback Callback that executes the CLI and returns success
   * @returns Promise<boolean> indicating success
   */
  protected async executeHeadlessBase(
    args: string[],
    promptText: string,
    executeCallback: (argsWithPrompt: string[]) => Promise<boolean>
  ): Promise<boolean> {
    // Use shared method to prepare prompt args (delegates to subclass for arg placement)
    const { argsWithPrompt, displayCommand } =
      await this.preparePromptForExecution(args, promptText);

    // Store for debugging
    this.lastCliCommand = displayCommand;

    // Fire event with prompt and command ready (before execution starts)
    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: displayCommand,
    });

    try {
      // Execute via callback (CLI-specific logic)
      return await executeCallback(argsWithPrompt);
    } finally {
      // Always clean up temp file
      await this.cleanupTempPromptFile();
    }
  }

  // ============================================================
  // PROCESS MANAGEMENT (shared spawning logic)
  // ============================================================

  /**
   * Spawn a child process and capture output
   * Used for headless CLI execution where we need process control
   *
   * Uses shell:true to resolve commands from PATH. Prompts should be passed
   * via temp file (using buildShellFileReadExpression) to avoid escaping issues.
   */
  protected spawnProcess(
    command: string,
    args: string[],
    options: {
      timeout?: number;
      onStdout?: (chunk: string) => void;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      // Use shell:true to resolve command from PATH
      // Prompts are passed via temp file to avoid shell escaping issues
      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true,
        env: { ...process.env },
      });

      // Store reference for cancellation
      this.currentProcess = child;

      child.stdout.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        // Call streaming callback if provided
        if (options.onStdout) {
          options.onStdout(chunk);
        }
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (error) => {
        console.error("❌ Process error:", error);
        this.currentProcess = undefined;
        reject(error);
      });

      child.on("close", (code) => {
        // Clear reference when process closes
        if (this.currentProcess === child) {
          this.currentProcess = undefined;
        }
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      // Handle timeout
      if (options.timeout) {
        setTimeout(() => {
          if (this.currentProcess === child) {
            child.kill();
            this.currentProcess = undefined;
            reject(new Error(`Process timeout after ${options.timeout}ms`));
          }
        }, options.timeout);
      }
    });
  }

  // ============================================================
  // WORKSPACE HELPERS
  // ============================================================

  /**
   * Get workspace directories for --add-dir flag
   * Returns workspace folders plus any configured additional directories
   */
  protected getWorkspaceDirs(): string[] {
    const configured = ConfigurationUtils.getCliAllowedDirs();

    // Always include workspace folders
    const workspaceDirs =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];

    return [...workspaceDirs, ...configured];
  }

  // ============================================================
  // SESSION MANAGEMENT (shared session tracking)
  // ============================================================

  /**
   * Start a new session (clear session ID)
   */
  startNewSession(): void {
    this.sessionId = undefined;
  }

  /**
   * Continue with existing session
   */
  continueSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Get current session ID
   */
  getCurrentSession(): string | undefined {
    return this.sessionId;
  }

  // ============================================================
  // RESULT ACCESSORS (for dashboard)
  // ============================================================

  /**
   * Get the last CLI result (includes response and statistics)
   */
  getLastResult(): CopilotCliResult | undefined {
    return this.lastResult;
  }

  /**
   * Get the last CLI command executed (for debugging)
   */
  getLastCliCommand(): string | undefined {
    return this.lastCliCommand;
  }

  /**
   * Get the full prompt text sent to CLI (includes all context and instructions)
   */
  getLastFullPrompt(): string | undefined {
    return this.lastFullPrompt;
  }

  // ============================================================
  // STATUS METHODS (shared status tracking)
  // ============================================================

  /**
   * Check if integration is available
   */
  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  /**
   * Check if CLI is ready
   */
  isReady(): boolean {
    return this.initializationStatus === CopilotStatus.Ready;
  }

  /**
   * Get initialization status
   */
  getInitializationStatus(): CopilotStatus {
    return this.initializationStatus;
  }

  /**
   * Check if this is a CLI-based integration
   * Returns true for all CLI integrations
   */
  isCli(): boolean {
    return true;
  }

  // ============================================================
  // CANCELLATION (shared process killing)
  // ============================================================

  /**
   * Cancel the current CLI process (platform-agnostic)
   * Kills the running CLI process if one is active
   * In interactive mode, sends Ctrl+C to the terminal
   */
  protected async cancelImplementation(): Promise<void> {
    // Handle interactive terminal execution
    if (this.currentExecution && this.terminal) {
      this.log("⏹️ Sending Ctrl+C to terminal...");
      this.terminal.sendText("\x03");
      this.currentExecution = undefined;
      this.log("✅ Terminal execution cancelled");
    }

    // Handle headless process execution
    if (this.currentProcess) {
      this.log("⏹️ Cancelling CLI process...");

      // Platform-agnostic kill - sends SIGTERM on Unix, terminates on Windows
      this.currentProcess.kill();

      // Clear the reference
      this.currentProcess = undefined;

      this.log("✅ CLI process cancelled");
    }

    // Clean up temp file on cancellation
    await this.cleanupTempPromptFile();
  }

  /**
   * Dispose of resources including terminal and temp files
   */
  dispose(): void {
    // Clean up terminal
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
    }
    this.shellIntegration = undefined;
    this.currentExecution = undefined;

    // Clean up temp file (fire and forget - don't await in dispose)
    this.cleanupTempPromptFile().catch(() => {
      // Ignore cleanup errors in dispose
    });
  }

  // ============================================================
  // ABSTRACT METHODS (must be implemented by subclasses)
  // ============================================================

  /**
   * Get the CLI-specific integration mode string for status reporting
   */
  protected abstract getIntegrationMode(): string;

  /**
   * Parse token counts from statistics string
   * Each CLI has different output format
   */
  abstract parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined;
}
