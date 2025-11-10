import * as vscode from "vscode";
import { spawn } from "child_process";
import {
  PromptItem,
  CopilotIntegrationMode,
} from "../../types/FlightPathTypes";
import { CopilotCliOptions, CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";

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
export class CopilotCommandLineIntegration extends CopilotIntegration {
  private sessionId?: string;
  private initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  private outputChannel?: vscode.OutputChannel;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel
  ) {
    super(context);
    this.outputChannel = outputChannel;
    this.initialize();
  }

  /**
   * Log message to both console and output channel (if enabled)
   */
  private log(message: string): void {
    console.log(message);
    if (this.shouldShowOutput()) {
      this.outputChannel?.appendLine(message);
    }
  }

  /**
   * Check if output should be shown in Output panel
   */
  private shouldShowOutput(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("showCliOutput", true);
  }

  /**
   * Initialize CLI integration by checking if copilot CLI is available
   */
  async initialize(): Promise<void> {
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    try {
      // Check if copilot CLI is available by running --version
      const result = await this.spawnProcess("copilot", ["--version"], {
        timeout: 5000,
      });

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
   * @param needsCompletionDetection Ignored for CLI mode (completion is deterministic)
   */
  async sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection: boolean = true
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

    try {
      // Build prompt text (no XML tool instruction needed for CLI!)
      const promptText = await this.buildPromptText(prompt);

      // Log the prompt being sent
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

      // Get CLI options from configuration (or per-prompt override)
      const options: CopilotCliOptions = {
        addDirs: this.getWorkspaceDirs(),
        model: prompt.model || this.getConfiguredModel(),
        resumeSession: this.sessionId,
      };

      // Execute CLI command
      const result = await this.executeCopilotCommand(promptText, options);

      if (result.success) {
        // Log response to output channel
        if (this.shouldShowOutput()) {
          this.outputChannel?.appendLine("[RESPONSE] ✓ Complete");
          this.outputChannel?.appendLine(
            "───────────────────────────────────────────────────────────"
          );
          this.outputChannel?.appendLine(result.response);
          this.outputChannel?.appendLine(
            "───────────────────────────────────────────────────────────"
          );
          this.outputChannel?.appendLine("");
          this.outputChannel?.appendLine("[STATISTICS]");
          this.outputChannel?.appendLine(result.statistics);
          this.outputChannel?.appendLine(
            "═══════════════════════════════════════════════════════════"
          );
          this.outputChannel?.appendLine("");
        }

        // Fire response complete event WITH THE ACTUAL RESPONSE TEXT
        this.responseCompleteEmitter.fire(result.response);

        // Update workflow progress
        await this.updateWorkflowProgress();

        return true;
      } else {
        console.error("❌ Copilot CLI failed:", result.error);
        vscode.window.showErrorMessage(
          `FlightPath: Copilot CLI error: ${result.error}`
        );
        return false;
      }
    } catch (error) {
      console.error("❌ CLI execution error:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to execute Copilot CLI: ${error}`
      );
      return false;
    }
  }

  /**
   * Execute copilot CLI command with options
   */
  private async executeCopilotCommand(
    prompt: string,
    options: CopilotCliOptions = {}
  ): Promise<CopilotCliResult> {
    const args: string[] = [];

    // NOTE: Prompt is sent via stdin (no -p flag needed!)
    // This avoids shell escaping issues and command-line length limits

    // Add tool permissions
    const toolPermissions = this.getToolPermissionArgs();
    args.push(...toolPermissions);

    // Add optional flags
    if (options.addDirs && options.addDirs.length > 0) {
      options.addDirs.forEach((dir) => {
        args.push("--add-dir", dir);
      });
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.resumeSession) {
      args.push("--resume", options.resumeSession);
    }

    // Execute command with stdin for prompt (5 minute timeout)
    const { stdout, stderr, exitCode } = await this.spawnProcess(
      "copilot",
      args,
      {
        stdin: prompt,
        timeout: 300000, // 5 minutes
      }
    );

    // Parse output
    const { response, statistics } = this.parseCliOutput(stdout);

    return {
      success: exitCode === 0,
      response,
      statistics,
      error: stderr || undefined,
      exitCode,
    };
  }

  /**
   * Parse CLI output to separate response from statistics
   */
  private parseCliOutput(output: string): {
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
   * Spawn a child process and capture output
   * Optionally writes to stdin if provided (for sending prompts to copilot CLI)
   */
  private spawnProcess(
    command: string,
    args: string[],
    options: { timeout?: number; stdin?: string } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      // On Windows, copilot is a PowerShell script, so we need shell: true
      // We carefully construct args to avoid injection issues
      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true, // Required for copilot.ps1 on Windows
      });

      // Write to stdin if provided
      if (options.stdin !== undefined) {
        if (child.stdin) {
          child.stdin.write(options.stdin);
          child.stdin.end();
        } else {
          reject(new Error("Failed to access stdin"));
          return;
        }
      }

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (error) => {
        console.error("❌ Process error:", error);
        reject(error);
      });

      child.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      // Handle timeout
      if (options.timeout) {
        setTimeout(() => {
          child.kill();
          reject(new Error(`Process timeout after ${options.timeout}ms`));
        }, options.timeout);
      }
    });
  }

  /**
   * Get workspace directories for --add-dir flag
   */
  private getWorkspaceDirs(): string[] {
    const configured = vscode.workspace
      .getConfiguration("flightpath")
      .get<string[]>("copilotCliAllowedDirs", []);

    // Always include workspace folders
    const workspaceDirs =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];

    return [...workspaceDirs, ...configured];
  }

  /**
   * Get configured AI model
   */
  private getConfiguredModel(): string {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("copilotCliModel", "claude-sonnet-4.5");
  }

  /**
   * Get tool permission arguments
   */
  private getToolPermissionArgs(): string[] {
    const mode = vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("copilotCliToolPermissions", "allowAll");

    if (mode === "allowAll") {
      return ["--allow-all-tools"];
    }

    // TODO: Add custom tool permission configuration
    return ["--allow-all-tools"];
  }

  /**
   * Get integration status
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message: "✅ Copilot CLI available",
        strategy: CopilotIntegrationMode.CLI,
      };
    } else {
      return {
        available: false,
        message:
          "❌ Copilot CLI unavailable - please install GitHub Copilot CLI",
        strategy: CopilotIntegrationMode.CLI,
      };
    }
  }

  /**
   * Check if integration is available
   */
  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  /**
   * Check if Copilot is ready
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
}
