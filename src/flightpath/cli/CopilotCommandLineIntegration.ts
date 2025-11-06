import * as vscode from "vscode";
import { spawn } from "child_process";
import { PromptItem } from "../../types/FlightPathTypes";
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
  private initializationStatus: CopilotStatus = "initializing";
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
    console.log("🔍 FlightPath: Checking Copilot CLI availability...");

    this.initializationStatus = "initializing";
    this.statusChangeEmitter.fire("initializing");

    try {
      // Check if copilot CLI is available by running --version
      const result = await this.spawnProcess("copilot", ["--version"], {
        timeout: 5000,
      });

      if (result.exitCode === 0) {
        console.log("✅ FlightPath: Copilot CLI available");
        console.log(`📊 Version: ${result.stdout.trim()}`);
        this.isAvailable = true;
        this.initializationStatus = "ready";
        this.statusChangeEmitter.fire("ready");
      } else {
        console.log("❌ FlightPath: Copilot CLI not found or not working");
        this.isAvailable = false;
        this.initializationStatus = "unavailable";
        this.statusChangeEmitter.fire("unavailable");
      }
    } catch (error) {
      console.error("❌ FlightPath: Error checking Copilot CLI:", error);
      console.log(
        "💡 FlightPath: Make sure GitHub Copilot CLI is installed and in PATH"
      );
      this.isAvailable = false;
      this.initializationStatus = "unavailable";
      this.statusChangeEmitter.fire("unavailable");
    }
  }

  /**
   * Send prompt to Copilot via CLI
   */
  async sendPrompt(prompt: PromptItem): Promise<boolean> {
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
      this.log("🚀 FlightPath: Sending prompt via Copilot CLI...");

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

      // Get CLI options from configuration
      const options: CopilotCliOptions = {
        addDirs: this.getWorkspaceDirs(),
        model: this.getConfiguredModel(),
        resumeSession: this.sessionId,
      };

      // Execute CLI command
      const result = await this.executeCopilotCommand(promptText, options);

      if (result.success) {
        this.log("✅ FlightPath: Copilot CLI completed successfully");

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

        console.log(`📊 Response length: ${result.response.length} characters`);
        console.log(`📊 Statistics: ${result.statistics}`);

        // Fire response complete event WITH THE ACTUAL RESPONSE TEXT
        this.responseCompleteEmitter.fire(result.response);

        // Update workflow progress
        await this.updateWorkflowProgress();

        return true;
      } else {
        console.error("❌ FlightPath: Copilot CLI failed:", result.error);
        vscode.window.showErrorMessage(
          `FlightPath: Copilot CLI error: ${result.error}`
        );
        return false;
      }
    } catch (error) {
      console.error("❌ FlightPath: CLI execution error:", error);
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

    console.log("📋 FlightPath: Executing copilot command:", {
      command: "copilot",
      promptLength: prompt.length,
      model: options.model,
      addDirs: options.addDirs?.length || 0,
      resumeSession: !!options.resumeSession,
    });

    // Execute command with stdin for prompt (5 minute timeout)
    const { stdout, stderr, exitCode } = await this.spawnProcessWithStdin(
      "copilot",
      args,
      prompt,
      {
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
   */
  private spawnProcess(
    command: string,
    args: string[],
    options: { timeout?: number } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      console.log(
        `🔧 FlightPath: Spawning process: ${command} ${args.join(" ")}`
      );

      // On Windows, copilot is a PowerShell script, so we need shell: true
      // We carefully construct args to avoid injection issues
      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true, // Required for copilot.ps1 on Windows
      });

      // Stream output to console in real-time
      child.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        // Log chunks as they arrive so you can see progress
        console.log(`📤 [Copilot stdout]: ${text.trim()}`);
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        // Log stderr separately
        console.log(`📤 [Copilot stderr]: ${text.trim()}`);
      });

      child.on("error", (error) => {
        console.error("❌ Process error:", error);
        reject(error);
      });

      child.on("close", (code) => {
        console.log(`✅ Process closed with exit code: ${code}`);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      // Handle timeout
      if (options.timeout) {
        setTimeout(() => {
          console.warn(
            `⏱️ Process timeout after ${options.timeout}ms, killing...`
          );
          child.kill();
          reject(new Error(`Process timeout after ${options.timeout}ms`));
        }, options.timeout);
      }
    });
  }

  /**
   * Spawn a child process with stdin input
   * Use this for sending prompts to copilot CLI to avoid shell escaping issues
   */
  private spawnProcessWithStdin(
    command: string,
    args: string[],
    stdinInput: string,
    options: { timeout?: number } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      console.log(
        `🔧 FlightPath: Spawning process with stdin: ${command} ${args.join(" ")}`
      );
      console.log(
        `📝 FlightPath: Stdin length: ${stdinInput.length} characters`
      );

      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true, // Required for copilot.ps1 on Windows
      });

      // Write prompt to stdin
      if (child.stdin) {
        child.stdin.write(stdinInput);
        child.stdin.end();
      } else {
        reject(new Error("Failed to access stdin"));
        return;
      }

      // Stream output to console in real-time
      child.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        console.log(`📤 [Copilot stdout]: ${text.trim()}`);
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        console.log(`📤 [Copilot stderr]: ${text.trim()}`);
      });

      child.on("error", (error) => {
        console.error("❌ Process error:", error);
        reject(error);
      });

      child.on("close", (code) => {
        console.log(`✅ Process closed with exit code: ${code}`);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      // Handle timeout
      if (options.timeout) {
        setTimeout(() => {
          console.warn(
            `⏱️ Process timeout after ${options.timeout}ms, killing...`
          );
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
   * Get workspace root directory
   */
  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        strategy: "cli",
      };
    } else {
      return {
        available: false,
        message:
          "❌ Copilot CLI unavailable - please install GitHub Copilot CLI",
        strategy: "cli",
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
    return this.initializationStatus === "ready";
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
    console.log("🔄 FlightPath: Started new CLI session");
  }

  /**
   * Continue with existing session
   */
  continueSession(sessionId: string): void {
    this.sessionId = sessionId;
    console.log(`🔄 FlightPath: Continuing CLI session: ${sessionId}`);
  }

  /**
   * Get current session ID
   */
  getCurrentSession(): string | undefined {
    return this.sessionId;
  }
}
