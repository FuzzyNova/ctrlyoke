import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";

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
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<string>(
        "cliExecutionMode",
        CLI_EXECUTION_MODE.INTERACTIVE
      ) as CliExecutionMode;
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
   * Strip ANSI escape codes from terminal output for clean display
   */
  protected stripAnsiCodes(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
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
  // INTERACTIVE TERMINAL EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in an interactive VS Code terminal
   * Uses shell integration for output streaming and completion detection
   *
   * Note: The terminal API doesn't support stdin, so we pass the prompt via
   * command-line argument (-p) with JSON.stringify escaping. This is the same
   * approach used for agent mode in headless execution.
   *
   * @param cliName The CLI executable name (e.g., "copilot" or "claude")
   * @param args The command-line arguments (should include -p with escaped prompt)
   * @param promptText The original prompt text for logging/events
   * @returns Promise<boolean> indicating success
   */
  protected async executeInTerminal(
    cliName: string,
    args: string[],
    promptText: string
  ): Promise<boolean> {
    // Build full command string for display/fallback
    const command = `${cliName} ${args.join(" ")}`;

    // Get or create terminal
    const terminal = await this.getOrCreateTerminal();
    terminal.show();

    // Fire prompt ready event (before execution starts)
    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: command,
    });

    // Wait for shell integration (with fallback)
    let shellIntegration: vscode.TerminalShellIntegration;
    try {
      shellIntegration = await this.waitForShellIntegration(terminal);
    } catch {
      // Fallback: use sendText without streaming
      vscode.window.showWarningMessage(
        "Shell integration unavailable. Output streaming disabled, using fallback mode."
      );
      terminal.sendText(command);
      // Can't detect completion without shell integration
      // Return true and let user manage manually
      this.log(
        "⚠️ Shell integration unavailable - using sendText fallback (no completion detection)"
      );
      return true;
    }

    // Execute command via shell integration
    // Use the executable + args overload for proper escaping of individual args
    const execution = shellIntegration.executeCommand(cliName, args);
    this.currentExecution = execution;

    // Stream output to dashboard (don't await - runs in parallel)
    this.streamTerminalOutput(execution);

    // Wait for completion
    return this.waitForTerminalCompletion(execution);
  }

  /**
   * Stream terminal output to the dashboard and output channel
   */
  private async streamTerminalOutput(
    execution: vscode.TerminalShellExecution
  ): Promise<void> {
    try {
      for await (const data of execution.read()) {
        // Strip ANSI codes for clean dashboard display
        const cleanData = this.stripAnsiCodes(data);
        this.streamingChunkEmitter.fire(cleanData);

        // Also log to output channel (with ANSI codes for color)
        this.outputChannel?.append(data);
      }
    } catch (error) {
      console.error("Stream error:", error);
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
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("showCliOutput", true);
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
  // PROCESS MANAGEMENT (shared spawning logic)
  // ============================================================

  /**
   * Spawn a child process and capture output
   * Used for headless CLI execution where we need process control
   *
   * Note: Prompts are passed via command-line arguments (-p flag with JSON.stringify)
   * rather than stdin for consistency between interactive and headless modes.
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

      // Always use shell:true for cross-platform CLI script execution
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
    const configured = vscode.workspace
      .getConfiguration("flightpath")
      .get<string[]>("copilotCliAllowedDirs", []);

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
  }

  /**
   * Dispose of resources including terminal
   */
  dispose(): void {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
    }
    this.shellIntegration = undefined;
    this.currentExecution = undefined;
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
