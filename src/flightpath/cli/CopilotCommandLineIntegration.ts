import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import {
  PromptItem,
  CopilotIntegrationMode,
} from "../../types/FlightPathTypes";
import { CopilotCliOptions, CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import {
  CLI_SUPPORTED_MODELS,
  CliSupportedModel,
} from "../../types/ModelConstants";

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
  private lastResult?: CopilotCliResult;
  private lastCliCommand?: string; // Full command with args for debugging
  private lastFullPrompt?: string; // Full prompt text sent to CLI (with all context)
  private currentProcess?: ReturnType<typeof spawn>;
  private logDirectory?: string;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel
  ) {
    super(context);
    this.outputChannel = outputChannel;
    this.initializeLogDirectory();
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
   * Check if CLI command should be shown in dashboard output
   */
  private shouldShowCliCommand(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("showCliCommand", false);
  }

  /**
   * Initialize log directory for session ID tracking
   * Uses OS temp directory + FlightPath subdirectory for cross-platform compatibility
   */
  private initializeLogDirectory(): void {
    // Create FlightPath-specific log directory in OS temp folder
    // Cross-platform: works on Windows (C:\Users\{user}\AppData\Local\Temp), macOS/Linux (/tmp)
    this.logDirectory = path.join(os.tmpdir(), "flightpath-copilot-logs");
    this.log(`📁 Log directory set to: ${this.logDirectory}`);
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
      console.error(
        "❌ FlightPath: Cannot send prompt - Copilot CLI not available"
      );
      vscode.window.showErrorMessage(
        "FlightPath: Copilot CLI is not available. Please install it first."
      );
      return false;
    }

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
        model: this.validateAndGetModel(prompt.model),
        agent: prompt.agent, // Pass agent to CLI (undefined if not specified)
        // Only resume session if newChatSession is explicitly false AND we have a session ID
        resumeSession:
          prompt.newChatSession === false && this.sessionId
            ? this.sessionId
            : undefined,
      };

      // Build CLI command args BEFORE execution so it's available for dashboard
      const args: string[] = [];
      const toolPermissions = this.getToolPermissionArgs();
      args.push(...toolPermissions);
      if (this.shouldAllowAllPaths()) {
        args.push("--allow-all-paths");
      }
      if (this.logDirectory) {
        args.push("--log-dir", this.logDirectory);
      }
      if (options.addDirs && options.addDirs.length > 0) {
        options.addDirs.forEach((dir) => {
          args.push("--add-dir", dir);
        });
      }
      if (options.model) {
        args.push("--model", options.model);
      }
      if (options.agent) {
        // Copilot CLI expects agent name with .agent suffix (e.g., "my-agent.agent")
        // File on disk: my-agent.agent.md
        // CLI expects: my-agent.agent
        const agentName = options.agent.endsWith(".agent")
          ? options.agent
          : `${options.agent}.agent`;

        args.push("--agent", agentName);
        this.log(`🤖 Using agent: ${agentName}`);

        // When using --agent, we need -p flag with prompt text
        // Wrap prompt in quotes to handle special characters
        // Use JSON.stringify to properly escape quotes and special chars
        args.push("-p", JSON.stringify(promptText));
      }
      if (options.resumeSession) {
        args.push("--resume", options.resumeSession);
      } // Store full command for debugging (NOW available before execution)
      this.lastCliCommand = `copilot ${args.join(" ")}`;

      // Fire event with prompt and command ready (before execution starts)
      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: this.lastCliCommand,
      });

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Execute CLI command (args already built above)
      // When using agent, we pass prompt as arg (quoted via JSON.stringify)
      // Otherwise, use stdin to avoid escaping issues
      const result = await this.executeCopilotCommand(
        options.agent ? null : promptText,
        args
      );

      // Check if this was a cancellation (not a real error)
      if (this.isCancelling) {
        console.log("⏹️ Prompt execution cancelled by user");
        return false;
      }

      // Store the result for statistics retrieval
      this.lastResult = result;

      // Extract and store session ID from log files for resuming future conversations
      const sessionId = await this.extractSessionIdFromLogs();
      if (sessionId) {
        this.sessionId = sessionId;
        this.log(`💾 Session ID extracted: ${sessionId}`);
      }

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
        this.lastFailureReason = `Copilot CLI error: ${result.error}`;
        vscode.window.showErrorMessage(
          `FlightPath: Copilot CLI error: ${result.error}`
        );
        return false;
      }
    } catch (error) {
      console.error("❌ CLI execution error:", error);
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
   * Execute copilot CLI command with args
   * @param prompt The prompt text to send via stdin (or null if using -p flag)
   * @param args Pre-built command-line arguments
   */
  private async executeCopilotCommand(
    prompt: string | null,
    args: string[]
  ): Promise<CopilotCliResult> {
    // Execute command with stdin for prompt (5 minute timeout)
    // When using --agent with -p flag, prompt is in args (JSON.stringify wrapped)
    const { stdout, stderr, exitCode } = await this.spawnProcess(
      "copilot",
      args,
      {
        stdin: prompt || undefined,
        timeout: 300000, // 5 minutes
        onStdout: (chunk) => {
          // Emit streaming chunk for real-time display
          this.streamingChunkEmitter.fire(chunk);
        },
      }
    );

    // Handle agent-specific errors with helpful messages
    const agentArg = args.find((arg, i) => args[i - 1] === "--agent");
    if (exitCode !== 0 && agentArg) {
      let enhancedError = stderr || "Unknown error";

      // Check for common agent error patterns
      if (
        stderr.toLowerCase().includes("agent") &&
        (stderr.toLowerCase().includes("not found") ||
          stderr.toLowerCase().includes("could not find") ||
          stderr.toLowerCase().includes("does not exist"))
      ) {
        enhancedError =
          `Agent '${agentArg}' not found. Please ensure it exists in:\n` +
          `  - .github/agents/${agentArg}.agent.md (project-level)\n` +
          `  - ~/.copilot/agents/${agentArg}.agent.md (user-level)\n\n` +
          `Original error: ${stderr}`;
      } else if (
        stderr.toLowerCase().includes("yaml") ||
        stderr.toLowerCase().includes("frontmatter") ||
        stderr.toLowerCase().includes("syntax error")
      ) {
        enhancedError =
          `Agent '${agentArg}' has invalid YAML frontmatter. ` +
          `Please check the agent file for syntax errors.\n\n` +
          `Original error: ${stderr}`;
      }

      // Parse output
      const { response, statistics } = this.parseCliOutput(stdout);

      return {
        success: false,
        response,
        statistics,
        error: enhancedError,
        exitCode,
      };
    }

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
    options: {
      timeout?: number;
      stdin?: string;
      onStdout?: (chunk: string) => void;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      // Always use shell:true for cross-platform copilot script execution
      // When prompt is in args, it's wrapped with JSON.stringify for proper escaping
      const child = spawn(command, args, {
        cwd: this.getWorkspaceRoot(),
        shell: true, // Required to find copilot in PATH
      });

      // Store reference for cancellation
      this.currentProcess = child;

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
   * Validate model is supported by CLI, fallback to default if not
   * Shows user-friendly warning when unsupported model requested
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = this.getConfiguredModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check if model is supported by CLI
    if (CLI_SUPPORTED_MODELS.includes(requestedModel as CliSupportedModel)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Copilot CLI. Using default: ${defaultModel}`;
    this.log(`⚠️ ${message}`);

    vscode.window.showWarningMessage(
      `FlightPath: ${message}\n\nCLI-supported models: ${CLI_SUPPORTED_MODELS.join(", ")}`
    );

    return defaultModel;
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
   * Check if all paths should be allowed (no interactive prompts)
   */
  private shouldAllowAllPaths(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("copilotCliAllowAllPaths", true);
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

  /**
   * Parse token counts from statistics string
   * Example statistics: "Usage estimate: 1234 prompt + 5678 completion = 6912 total tokens"
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    const match = statistics.match(/(\d+)\s+prompt\s+\+\s+(\d+)\s+completion/);
    if (match) {
      return {
        prompt: parseInt(match[1], 10),
        completion: parseInt(match[2], 10),
      };
    }
    return undefined;
  }

  /**
   * Check if this is a CLI-based integration
   * Returns true for CLI integration (supports output logging, token display, etc.)
   */
  isCli(): boolean {
    return true;
  }

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
      console.error("❌ Failed to extract session ID from logs:", error);
      return undefined;
    }
  }

  /**
   * Cancel the current CLI process (platform-agnostic)
   * Kills the running copilot CLI process if one is active
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
}
