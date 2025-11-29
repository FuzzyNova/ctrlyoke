import * as vscode from "vscode";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotStatus } from "../base/CopilotIntegration";
import { BaseCliIntegration } from "./BaseCliIntegration";
import {
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_MODEL_MAP,
  CLAUDE_CLI_DEFAULT_MODEL,
  ClaudeCliModelAlias,
} from "../../types/ModelConstants";

/**
 * Tool name mappings from Copilot CLI format to Claude CLI format
 * Used to convert shared cliAllowedTools/cliDeniedTools settings
 *
 * Copilot CLI uses permission KINDS (categories), not individual tool names:
 * - shell(command:*?) - Controls powershell, write_powershell, read_powershell, stop_powershell
 * - write - Controls create and edit tools
 * - <mcp-server>(tool?) - Controls MCP server tools
 * Note: Copilot's "view" tool (read files) doesn't require permission.
 *
 * Claude CLI has granular tool permissions:
 * - Bash(command:*?) - Shell commands (equivalent to Copilot's shell)
 * - Read - Read files (no Copilot equivalent - always allowed in Copilot)
 * - Write - Write/create files
 * - Edit - Edit existing files
 * - MultiEdit - Batch editing
 * - Glob - File pattern matching (no Copilot equivalent - always allowed)
 * - Grep - Text search (no Copilot equivalent - always allowed)
 * - LS - List directories (no Copilot equivalent - always allowed)
 * - WebFetch - Fetch web content (no Copilot equivalent)
 * - TodoWrite - Todo management (no Copilot equivalent)
 *
 * When converting Copilot's "write" to Claude, it maps to "Write" only.
 * Users should add "Edit" separately if they want to allow file modifications.
 */
const COPILOT_TO_CLAUDE_TOOL_MAP: Record<string, string> = {
  // Shell commands
  shell: "Bash",

  // File operations (Copilot "write" = create/modify files)
  // Note: Claude separates Write (create) from Edit (modify)
  write: "Write",

  // Additional mappings if users specify Claude-like names in lowercase
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  multiedit: "MultiEdit",
  glob: "Glob",
  grep: "Grep",
  ls: "LS",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
};

/**
 * Claude CLI Response structure (JSON output format)
 */
interface ClaudeCliJsonResponse {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  response?: string;
  content?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
  };
  session_id?: string;
  model?: string;
  error?: string;
  duration_ms?: number;
}

/**
 * Claude Code CLI Integration
 *
 * Implements Copilot integration using the Claude Code CLI (Anthropic).
 * Provides deterministic completion detection, structured output parsing,
 * and simpler architecture compared to chat window automation.
 *
 * Key advantages:
 * - No UI timing dependencies
 * - Command returns when complete (no polling needed)
 * - Structured JSON output format
 * - Model selection support (sonnet, opus, haiku)
 * - Session management for multi-turn conversations
 *
 * CLI Command Reference:
 * - `claude -p "<prompt>"` - Non-interactive prompt execution
 * - `--output-format json` - Structured output
 * - `--model <model>` - Model selection
 * - `-c` - Continue most recent session
 * - `-r <session-id>` - Resume specific session
 * - `--add-dir <path>` - Add accessible directory
 * - `--dangerously-skip-permissions` - Skip all permission prompts
 */
export class ClaudeCommandLineIntegration extends BaseCliIntegration {
  private cliVersion?: string;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel
  ) {
    super(context, outputChannel);
    this.initialize();
  }

  // ============================================================
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ============================================================

  /**
   * Get the CLI command name
   */
  protected getCliCommand(): string {
    return "claude";
  }

  /**
   * Get the integration mode for status reporting
   */
  protected getIntegrationMode(): string {
    return Provider.ClaudeCli;
  }

  /**
   * Parse token counts from Claude CLI statistics string
   * Example: "Usage: 1234 input + 5678 output = 6912 tokens"
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    const match = statistics.match(/(\d+)\s+input\s+\+\s+(\d+)\s+output/);
    if (match) {
      return {
        prompt: parseInt(match[1], 10),
        completion: parseInt(match[2], 10),
      };
    }
    return undefined;
  }

  // ============================================================
  // INITIALIZATION (Epic 2: Story 2.1, 2.2)
  // ============================================================

  /**
   * Initialize CLI integration by checking if Claude CLI is available
   * Fires status change events during lifecycle
   */
  async initialize(): Promise<void> {
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    try {
      // Check if Claude CLI is available by running --version
      const result = await this.spawnProcess("claude", ["--version"], {
        timeout: 5000,
      });

      if (result.exitCode === 0) {
        this.cliVersion = result.stdout.trim();
        console.log("✅ Claude Code CLI available:", this.cliVersion);
        this.log(`✅ Claude Code CLI available: ${this.cliVersion}`);
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
   * Handle initialization errors with user-friendly messages (Story 2.3)
   */
  private handleInitializationError(
    type: "command_failed" | "exception",
    error: unknown
  ): void {
    this.isAvailable = false;
    this.initializationStatus = CopilotStatus.Unavailable;
    this.statusChangeEmitter.fire(CopilotStatus.Unavailable);

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Enhanced error messages based on error type
    if (
      errorMessage.includes("ENOENT") ||
      errorMessage.includes("not found") ||
      errorMessage.includes("not recognized")
    ) {
      const message =
        "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code";
      console.error(`❌ ${message}`);
      this.log(`❌ ${message}`);
      this.log(
        "   📖 Documentation: https://docs.anthropic.com/en/docs/claude-code"
      );
    } else if (
      errorMessage.includes("EACCES") ||
      errorMessage.includes("permission denied")
    ) {
      const message =
        "Claude Code CLI permission denied. Check PATH and file permissions.";
      console.error(`❌ ${message}`);
      this.log(`❌ ${message}`);
    } else if (errorMessage.includes("ETIMEDOUT") || type === "exception") {
      const message =
        "Claude Code CLI detection timed out. Check system resources and try again.";
      console.error(`❌ ${message}`);
      this.log(`❌ ${message}`);
    } else {
      console.error("❌ Claude Code CLI not available:", errorMessage);
      this.log(`❌ Claude Code CLI unavailable: ${errorMessage}`);
    }
  }

  // ============================================================
  // PROMPT EXECUTION (Epic 3: Story 3.1, 3.2, 3.3)
  // ============================================================

  /**
   * Send prompt to Claude via CLI
   * @param prompt The prompt item to send
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
        "❌ FlightPath: Cannot send prompt - Claude Code CLI not available"
      );
      vscode.window.showErrorMessage(
        "FlightPath: Claude Code CLI is not available. Please install it first."
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

      // Build CLI arguments
      const args = this.buildCliArgs(prompt, promptText);

      // Store full command for debugging
      this.lastCliCommand = `claude ${args.join(" ")}`;

      // Fire event with prompt and command ready (before execution starts)
      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: this.lastCliCommand,
      });

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Execute CLI command
      const result = await this.executeClaude(promptText, args);

      // Check if this was a cancellation (not a real error)
      if (this.isCancelling) {
        console.log("⏹️ Prompt execution cancelled by user");
        return false;
      }

      // Store the result for statistics retrieval
      this.lastResult = result;

      // Extract and store session ID for resuming future conversations
      if (result.sessionId) {
        this.sessionId = result.sessionId;
        this.log(`💾 Session ID: ${this.sessionId}`);
      }

      if (result.success) {
        // Log response to output channel
        if (this.shouldShowOutput()) {
          this.outputChannel?.appendLine(
            `[RESPONSE] ${new Date().toLocaleTimeString()}`
          );
          this.outputChannel?.appendLine(
            "───────────────────────────────────────────────────────────"
          );
          this.outputChannel?.appendLine(result.response);
          if (result.statistics) {
            this.outputChannel?.appendLine("");
            this.outputChannel?.appendLine(`[STATISTICS]`);
            this.outputChannel?.appendLine(result.statistics);
          }
          this.outputChannel?.appendLine(
            "═══════════════════════════════════════════════════════════"
          );
          this.outputChannel?.appendLine("");
        }

        // Fire response complete event WITH THE ACTUAL RESPONSE TEXT
        this.responseCompleteEmitter.fire(result.response);
        return true;
      } else {
        const errorMsg =
          result.error || "Claude CLI returned non-zero exit code";
        console.error("❌ Claude CLI execution failed:", errorMsg);
        this.lastFailureReason = errorMsg;

        // Log error to output channel for visibility
        if (this.shouldShowOutput()) {
          this.outputChannel?.appendLine(
            `[ERROR] ${new Date().toLocaleTimeString()}`
          );
          this.outputChannel?.appendLine(
            "───────────────────────────────────────────────────────────"
          );
          this.outputChannel?.appendLine(errorMsg);
          this.outputChannel?.appendLine(
            "═══════════════════════════════════════════════════════════"
          );
          this.outputChannel?.appendLine("");
        }

        vscode.window.showErrorMessage(
          `FlightPath: Claude CLI failed: ${errorMsg}`
        );
        return false;
      }
    } catch (error) {
      console.error("❌ Claude CLI execution error:", error);
      this.lastFailureReason =
        error instanceof Error ? error.message : "Failed to execute Claude CLI";
      vscode.window.showErrorMessage(
        `FlightPath: Failed to execute Claude CLI: ${error}`
      );
      return false;
    }
  }

  /**
   * Build CLI arguments for Claude command
   */
  private buildCliArgs(prompt: PromptItem, _promptText: string): string[] {
    const args: string[] = [];

    // Add prompt via -p flag
    args.push("-p"); // Prompt will be passed via stdin

    // Output format (JSON for structured parsing)
    const outputFormat = vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("claudeCliOutputFormat", "json");
    args.push("--output-format", outputFormat);

    // Model selection
    const model = this.validateAndGetModel(prompt.model);
    args.push("--model", model);

    // Add workspace directories
    const workspaceDirs = this.getWorkspaceDirs();
    workspaceDirs.forEach((dir) => {
      args.push("--add-dir", dir);
    });

    // Tool permissions
    const toolPermissionArgs = this.getToolPermissionArgs();
    args.push(...toolPermissionArgs);

    // Session management
    if (prompt.newChatSession === false && this.sessionId) {
      // Resume specific session
      args.push("-r", this.sessionId);
    } else if (prompt.newChatSession === false) {
      // Continue most recent session (no specific ID)
      args.push("-c");
    }
    // If newChatSession is true or undefined, start fresh (no session flags)

    return args;
  }

  /**
   * Execute Claude CLI command
   * @param promptText The prompt text to send via stdin
   * @param args Pre-built command-line arguments
   */
  private async executeClaude(
    promptText: string,
    args: string[]
  ): Promise<CopilotCliResult & { sessionId?: string }> {
    // Execute command with stdin for prompt (5 minute timeout)
    const { stdout, stderr, exitCode } = await this.spawnProcess(
      "claude",
      args,
      {
        stdin: promptText,
        timeout: 300000, // 5 minutes
        onStdout: (chunk) => {
          // Emit streaming chunk for real-time display
          this.streamingChunkEmitter.fire(chunk);
        },
      }
    );

    // Parse output (JSON or text)
    const outputFormat = vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("claudeCliOutputFormat", "json");

    if (outputFormat === "json") {
      return this.parseJsonOutput(stdout, stderr, exitCode);
    } else {
      return this.parseTextOutput(stdout, stderr, exitCode);
    }
  }

  /**
   * Parse JSON output from Claude CLI (Story 3.3)
   */
  private parseJsonOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    try {
      const json: ClaudeCliJsonResponse = JSON.parse(stdout);

      // Check for error conditions first
      // Claude CLI may return is_error: true even with exitCode 0
      if (json.is_error || json.error) {
        const errorMessage =
          json.error || json.result || stderr || "Unknown Claude CLI error";
        return {
          success: false,
          response: "",
          statistics: "",
          error: errorMessage,
          exitCode: exitCode !== 0 ? exitCode : 1,
          sessionId: json.session_id,
        };
      }

      // Extract response text (Claude may use different field names)
      const response = json.result || json.response || json.content || "";

      // Build statistics string
      let statistics = "";
      if (json.usage) {
        const { input_tokens, output_tokens, total_tokens } = json.usage;
        const total = total_tokens || input_tokens + output_tokens;
        statistics = `Usage: ${input_tokens} input + ${output_tokens} output = ${total} tokens`;
        if (json.model) {
          statistics += ` | Model: ${json.model}`;
        }
      }
      if (json.duration_ms) {
        statistics += statistics
          ? ` | Duration: ${json.duration_ms}ms`
          : `Duration: ${json.duration_ms}ms`;
      }

      return {
        success: exitCode === 0,
        response,
        statistics,
        error: exitCode !== 0 ? stderr : undefined,
        exitCode,
        sessionId: json.session_id,
      };
    } catch (parseError) {
      // JSON parsing failed, fall back to text parsing
      console.warn(
        "Failed to parse JSON output, falling back to text:",
        parseError
      );
      return this.parseTextOutput(stdout, stderr, exitCode);
    }
  }

  /**
   * Parse plain text output from Claude CLI
   */
  private parseTextOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    return {
      success: exitCode === 0,
      response: stdout.trim(),
      statistics: "",
      error: exitCode !== 0 ? stderr || "Command failed" : undefined,
      exitCode,
    };
  }

  // ============================================================
  // CONFIGURATION HELPERS
  // ============================================================

  /**
   * Get configured AI model (with alias resolution)
   */
  private getConfiguredModel(): string {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("claudeCliModel", CLAUDE_CLI_DEFAULT_MODEL);
  }

  /**
   * Validate model is supported by Claude CLI, fallback to default if not
   * Supports both aliases (sonnet, opus, haiku) and full model names
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = this.getConfiguredModel();

    if (!requestedModel) {
      // Return full model name for default
      return CLAUDE_CLI_MODEL_MAP[defaultModel] || defaultModel;
    }

    // Check if it's a valid alias
    if (
      CLAUDE_CLI_MODEL_ALIASES.includes(requestedModel as ClaudeCliModelAlias)
    ) {
      return CLAUDE_CLI_MODEL_MAP[requestedModel] || requestedModel;
    }

    // Check if it's already a full model name in our map values
    const isFullModelName =
      Object.values(CLAUDE_CLI_MODEL_MAP).includes(requestedModel);
    if (isFullModelName) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const supportedModels = [
      ...CLAUDE_CLI_MODEL_ALIASES,
      ...Object.values(CLAUDE_CLI_MODEL_MAP),
    ].join(", ");
    const message = `Model "${requestedModel}" not recognized for Claude CLI. Using default: ${defaultModel}`;
    this.log(`⚠️ ${message}`);
    this.log(`   Supported models: ${supportedModels}`);

    vscode.window.showWarningMessage(`FlightPath: ${message}`);

    return CLAUDE_CLI_MODEL_MAP[defaultModel] || defaultModel;
  }

  /**
   * Convert a Copilot CLI tool pattern to Claude CLI format
   * Examples:
   * - "shell(git:*)" → "Bash(git:*)"
   * - "write" → "Write"
   * - "github(search_repositories)" → "github(search_repositories)" (no mapping, keep as-is)
   */
  private convertToolPatternToClaudeFormat(copilotPattern: string): string {
    // Match pattern: toolName or toolName(args)
    const match = copilotPattern.match(/^(\w+)(\(.+\))?$/);
    if (!match) {
      return copilotPattern; // Return as-is if pattern doesn't match expected format
    }

    const [, toolName, args] = match;
    const claudeToolName =
      COPILOT_TO_CLAUDE_TOOL_MAP[toolName.toLowerCase()] || toolName;
    return args ? claudeToolName + args : claudeToolName;
  }

  /**
   * Get tool permission arguments based on configuration
   * Reads from shared cliAllowedTools/cliDeniedTools and converts to Claude format
   */
  private getToolPermissionArgs(): string[] {
    const config = vscode.workspace.getConfiguration("flightpath");
    const mode = config.get<string>("claudeCliToolPermissions", "skipAll");

    if (mode === "skipAll") {
      return ["--dangerously-skip-permissions"];
    }

    // Custom mode - read from shared settings and convert to Claude format
    const args: string[] = [];

    const allowedTools = config.get<string[]>("cliAllowedTools", []);
    const deniedTools = config.get<string[]>("cliDeniedTools", []);

    // Add allowed tool patterns (converted to Claude format)
    allowedTools.forEach((tool) => {
      const claudeTool = this.convertToolPatternToClaudeFormat(tool);
      args.push("--allowedTools", claudeTool);
    });

    // Add disallowed tool patterns (converted to Claude format)
    deniedTools.forEach((tool) => {
      const claudeTool = this.convertToolPatternToClaudeFormat(tool);
      args.push("--disallowedTools", claudeTool);
    });

    // If no patterns specified in custom mode, log a warning
    if (args.length === 0) {
      this.log(
        "⚠️ Custom tool permissions mode enabled but no tools specified. Claude will prompt for each tool."
      );
    }

    return args;
  }

  // ============================================================
  // STATUS METHODS (Story 2.4)
  // ============================================================

  /**
   * Get integration status
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message: `✅ Claude Code CLI available${this.cliVersion ? ` (${this.cliVersion})` : ""}`,
        strategy: Provider.ClaudeCli,
      };
    } else {
      return {
        available: false,
        message:
          "❌ Claude Code CLI unavailable - please install @anthropic-ai/claude-code",
        strategy: Provider.ClaudeCli,
      };
    }
  }
}
