import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";

/**
 * Base class for CLI integrations (Copilot CLI and Claude CLI)
 *
 * Provides shared functionality for CLI-based AI integrations:
 * - Logging and output channel management
 * - Process spawning with stdin, timeout, and streaming support
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

  constructor(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel
  ) {
    super(context);
    this.outputChannel = outputChannel;
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
   * Optionally writes to stdin if provided (for sending prompts to CLI)
   */
  protected spawnProcess(
    command: string,
    args: string[],
    options: {
      timeout?: number;
      stdin?: string;
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

      // Write to stdin if provided
      if (options.stdin !== undefined) {
        if (child.stdin) {
          child.stdin.write(options.stdin);
          child.stdin.end();
        } else {
          this.currentProcess = undefined;
          reject(new Error("Failed to access stdin"));
          return;
        }
      }

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
   */
  protected async cancelImplementation(): Promise<void> {
    if (this.currentProcess) {
      this.log("⏹️ Cancelling CLI process...");

      // Platform-agnostic kill - sends SIGTERM on Unix, terminates on Windows
      this.currentProcess.kill();

      // Clear the reference
      this.currentProcess = undefined;

      this.log("✅ CLI process cancelled");
    }
  }

  // ============================================================
  // ABSTRACT METHODS (must be implemented by subclasses)
  // ============================================================

  /**
   * Get the CLI command name (e.g., "copilot" or "claude")
   */
  protected abstract getCliCommand(): string;

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
