import * as vscode from "vscode";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotStatus } from "../base/CopilotIntegration";
import { BaseCliIntegration, CLI_EXECUTION_MODE } from "./BaseCliIntegration";
import {
  CLAUDE_CLI_DEFAULT_MODEL,
  getClaudeModelName,
} from "../../utils/ModelConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

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
  private streamBuffer: string = ""; // Buffer for incomplete JSON lines in streaming mode

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
   * Get the CLI name for terminal/logging
   */
  protected getCliName(): string {
    return "claude";
  }

  /**
   * Get the escape indicator for Claude CLI.
   * This text appears while generating and disappears when complete.
   * The TUI shows "esc to interrupt" (may have different casing)
   */
  protected getEscapeIndicator(): string {
    return "esc to interrupt";
  }

  /**
   * Get the screen end pattern for Claude CLI.
   * Claude TUI screens end with a line of dashes followed by "> " prompt.
   * The status bar text varies based on user's tab settings, so we use
   * the more stable prompt pattern.
   */
  protected getScreenEndPattern(): RegExp {
    // Match: line of ─ characters, newline, > followed by space(s) or end
    return /─{20,}\r?\n>\s*/g;
  }

  /**
   * Build headless args for Claude CLI.
   * Claude REQUIRES -p flag for headless mode (Ink TUI crashes without it).
   * Note: -p is already added by buildCliArgs for headless mode, so we just return as-is.
   */
  protected buildHeadlessArgs(baseArgs: string[]): string[] {
    // -p flag is already included from buildCliArgs, just pass through
    return baseArgs;
  }

  /**
   * Determine if stdout should be streamed in real-time during headless execution.
   *
   * For Claude CLI:
   * - stream-json: Stream with parsing (extracts content from JSON chunks)
   * - json: Don't stream (wait for complete JSON, parse after)
   * - text: Stream as-is (already human-readable)
   */
  protected shouldStreamHeadlessOutput(): boolean {
    const outputFormat = ConfigurationUtils.getClaudeCliOutputFormat();
    // Only disable streaming for non-streaming JSON format
    return outputFormat !== "json";
  }

  /**
   * Build interactive TUI command for Claude CLI.
   * Starts the CLI in interactive mode without a prompt.
   */
  protected buildInteractiveTuiCommand(baseArgs: string[]): string {
    const cliName = this.getCliName();
    // Start in interactive mode - prompt will be sent via sendText
    // Remove -p flag and output-format for interactive mode
    const interactiveArgs = baseArgs.filter(
      (arg, i, arr) =>
        arg !== "-p" &&
        arg !== "--output-format" &&
        arr[i - 1] !== "--output-format"
    );
    return `${cliName} ${interactiveArgs.join(" ")}`;
  }

  /**
   * Get the integration mode for status reporting
   */
  protected getIntegrationMode(): string {
    return Provider.ClaudeCli;
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   */
  protected hasFullPermissions(): boolean {
    const toolMode = ConfigurationUtils.getClaudeCliToolPermissions();

    return toolMode === "skipAll";
  }

  /**
   * Format a tool call summary for display
   * @param toolName The name of the tool (e.g., "Bash", "Write", "Read")
   * @param input The tool input object with tool-specific fields
   * @returns Formatted summary string
   */
  private formatToolCallSummary(toolName: string, input: any): string {
    let summary = `\n\n[Tool: ${toolName}`;

    // Add tool-specific details
    if (toolName === "Bash" && input?.command) {
      summary += ` → ${input.command}`;
    } else if (toolName === "Write" && input?.file_path) {
      summary += ` → ${input.file_path}`;
    } else if (toolName === "Edit" && input?.file_path) {
      summary += ` → ${input.file_path}`;
    } else if (toolName === "Read" && input?.file_path) {
      summary += ` → ${input.file_path}`;
    } else if (toolName === "WebFetch" && input?.url) {
      summary += ` → ${input.url}`;
    }

    summary += "]\n\n";
    return summary;
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

  /**
   * Process stdout chunks for stream-json format.
   *
   * stream-json format outputs concatenated JSON objects (NOT newline-delimited):
   * 1. {"type":"system","subtype":"init",...} - Session init
   * 2. {"type":"assistant","message":{...}} - Response with content at message.content[0].text
   * 3. {"type":"result",...} - Final summary
   *
   * We extract and stream the response text from object #2.
   */
  protected processStreamingChunk(chunk: string): string | undefined {
    const outputFormat = ConfigurationUtils.getClaudeCliOutputFormat();

    // Only process for stream-json format
    if (outputFormat !== "stream-json") {
      return chunk; // Pass through for text format
    }

    // Accumulate into buffer
    this.streamBuffer += chunk;

    // Try to extract complete JSON objects by finding balanced braces
    // This is a simple approach - look for }{ boundaries between objects
    let contentToEmit = "";
    let startIdx = 0;

    while (startIdx < this.streamBuffer.length) {
      // Find the start of a JSON object
      const objStart = this.streamBuffer.indexOf("{", startIdx);
      if (objStart === -1) {
        break;
      }

      // Try to parse from this position
      let depth = 0;
      let inString = false;
      let escape = false;
      let objEnd = -1;

      for (let i = objStart; i < this.streamBuffer.length; i++) {
        const char = this.streamBuffer[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (char === "\\") {
          escape = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === "{") {
            depth++;
          } else if (char === "}") {
            depth--;
            if (depth === 0) {
              objEnd = i + 1;
              break;
            }
          }
        }
      }

      // If we found a complete object, parse it
      if (objEnd !== -1) {
        const objStr = this.streamBuffer.substring(objStart, objEnd);
        try {
          const json = JSON.parse(objStr);

          // Extract response text and tool calls from assistant message
          // Assistant messages contain an array of content items:
          // - { type: "text", text: "..." } - Claude's text responses
          // - { type: "tool_use", id: "...", name: "Bash", input: {...} } - Tool calls
          if (json.type === "assistant" && json.message?.content) {
            // Extract text content
            const textContent = json.message.content.find(
              (item: any) => item.type === "text"
            );
            if (textContent?.text) {
              contentToEmit += textContent.text;
            }

            // Extract tool use and format as summary for user visibility
            const toolUse = json.message.content.find(
              (item: any) => item.type === "tool_use"
            );
            if (toolUse) {
              const toolSummary = this.formatToolCallSummary(
                toolUse.name,
                toolUse.input
              );
              contentToEmit += toolSummary;
            }
          }
        } catch (parseError) {
          // Invalid JSON - skip and continue
          console.warn(
            "Failed to parse stream-json object:",
            objStr.substring(0, 100),
            parseError
          );
        }

        startIdx = objEnd;
      } else {
        // No complete object found - keep remainder in buffer
        break;
      }
    }

    // Keep unparsed portion in buffer
    this.streamBuffer = this.streamBuffer.substring(startIdx);

    return contentToEmit || undefined;
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
      // Check if CLI is available by running --version
      const result = await this.spawnSimpleCommand(
        this.getCliName(),
        ["--version"],
        5000
      );

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
   * Routes to interactive terminal or headless execution based on settings
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

    const mode = this.getExecutionMode();

    // Warn if headless mode without full permissions
    if (mode === CLI_EXECUTION_MODE.HEADLESS && !this.hasFullPermissions()) {
      vscode.window.showWarningMessage(
        "Headless mode without full permissions: CLI will auto-deny tool/file access. Workflow may not make progress."
      );
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
      this.logPrompt(promptText);

      // Build CLI arguments (mode-specific: interactive mode skips -p flag)
      const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;
      const args = this.buildCliArgs(prompt, isInteractive);

      // Store full command for debugging (will be updated by execution methods)
      this.lastCliCommand = `${this.getCliName()} ${args.join(" ")} "<prompt>"`;

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Route based on execution mode
      if (mode === CLI_EXECUTION_MODE.INTERACTIVE) {
        return await this.executeInteractive(args, promptText);
      } else {
        return await this.executeHeadless(args, promptText);
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
   * Build CLI arguments for Claude command (without prompt - handled separately)
   *
   * Note: In Claude CLI:
   * - `-p` or `--print` means print mode (non-interactive output)
   * - The prompt is passed as a positional argument at the end of the command
   * - Interactive mode: `claude --model sonnet "prompt"` (allows user input)
   * - Headless mode: `claude -p --output-format json --model sonnet "prompt"` (automated)
   *
   * @param prompt The prompt item
   * @param isInteractive Whether this is interactive mode (skips -p flag)
   */
  private buildCliArgs(
    prompt: PromptItem,
    isInteractive: boolean = false
  ): string[] {
    const args: string[] = [];

    // Only add print mode for headless (non-interactive) execution
    // Interactive mode should allow user input, so we skip -p
    if (!isInteractive) {
      args.push("-p");

      // Output format only applies to print mode (headless)
      const outputFormat = ConfigurationUtils.getClaudeCliOutputFormat();
      args.push("--output-format", outputFormat);

      // stream-json requires --verbose flag
      if (outputFormat === "stream-json") {
        args.push("--verbose");
      }
    }

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
      args.push("-r", this.sessionId);
    } else if (prompt.newChatSession === false) {
      args.push("-c");
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods

    return args;
  }

  /**
   * Execute in interactive terminal mode
   * Uses temp file approach via base class to avoid shell escaping issues
   */
  private async executeInteractive(
    args: string[],
    promptText: string
  ): Promise<boolean> {
    // Use base class executeInTerminal (buildArgsWithPrompt handles positional arg)
    const success = await this.executeInTerminal(args, promptText);

    // Note: In interactive mode, we can't easily extract session ID from JSON output
    // since the terminal output is mixed with ANSI codes. Session continuity may be limited.
    if (success) {
      this.log("✅ Claude CLI completed successfully");
    }

    return success;
  }

  /**
   * Execute in headless mode (background process)
   * Uses stdin to pass the prompt (with -p flag required by Claude's Ink TUI)
   */
  private async executeHeadless(
    args: string[],
    promptText: string
  ): Promise<boolean> {
    // Reset stream buffer for new execution
    this.streamBuffer = "";

    return this.executeHeadlessWithStdin(
      args,
      promptText,
      async (result: { stdout: string; stderr: string; exitCode: number }) => {
        const outputFormat = ConfigurationUtils.getClaudeCliOutputFormat();

        // Parse the CLI output based on format
        const cliResult =
          outputFormat === "stream-json"
            ? this.parseStreamJsonOutput(
                result.stdout,
                result.stderr,
                result.exitCode
              )
            : outputFormat === "json"
              ? this.parseJsonOutput(
                  result.stdout,
                  result.stderr,
                  result.exitCode
                )
              : this.parseTextOutput(
                  result.stdout,
                  result.stderr,
                  result.exitCode
                );

        // For non-streaming JSON format, emit the parsed response now
        // (stream-json already streamed during execution, text streams as-is)
        if (outputFormat === "json" && cliResult.response) {
          this.streamingChunkEmitter.fire(cliResult.response);
        }

        // Check if this was a cancellation
        if (this.isCancelling) {
          console.log("⏹️ Prompt execution cancelled by user");
          return false;
        }

        // Store the result for statistics retrieval
        this.lastResult = cliResult;

        // Extract and store session ID
        if (cliResult.sessionId) {
          this.sessionId = cliResult.sessionId;
          this.log(`💾 Session ID: ${this.sessionId}`);
        }

        if (cliResult.success) {
          this.logResponse(cliResult.response, cliResult.statistics);
          this.responseCompleteEmitter.fire(cliResult.response);
          return true;
        } else {
          const errorMsg =
            cliResult.error || "Claude CLI returned non-zero exit code";
          console.error("❌ Claude CLI execution failed:", errorMsg);
          this.lastFailureReason = errorMsg;
          vscode.window.showErrorMessage(
            `FlightPath: Claude CLI failed: ${errorMsg}`
          );
          return false;
        }
      }
    );
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

  /**
   * Parse stream-json output from Claude CLI (concatenated JSON objects)
   *
   * Stream-json format outputs 3 concatenated JSON objects:
   * 1. {"type":"system","subtype":"init",...} - Session metadata
   * 2. {"type":"assistant","message":{...}} - Response at message.content[0].text
   * 3. {"type":"result",...} - Usage stats, session_id, costs
   *
   * We extract the response and metadata from these objects.
   */
  private parseStreamJsonOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    let fullResponse = "";
    let sessionId: string | undefined;
    let usage:
      | { input_tokens: number; output_tokens: number; total_tokens?: number }
      | undefined;
    let model: string | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    // Extract JSON objects by finding balanced braces
    const objects: any[] = [];
    let startIdx = 0;

    while (startIdx < stdout.length) {
      const objStart = stdout.indexOf("{", startIdx);
      if (objStart === -1) break;

      let depth = 0;
      let inString = false;
      let escape = false;
      let objEnd = -1;

      for (let i = objStart; i < stdout.length; i++) {
        const char = stdout[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === "\\") {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === "{") depth++;
          else if (char === "}") {
            depth--;
            if (depth === 0) {
              objEnd = i + 1;
              break;
            }
          }
        }
      }

      if (objEnd !== -1) {
        try {
          const json = JSON.parse(stdout.substring(objStart, objEnd));
          objects.push(json);
        } catch (e) {
          console.warn("Failed to parse JSON object:", e);
        }
        startIdx = objEnd;
      } else {
        break;
      }
    }

    // Extract data from parsed objects
    for (const json of objects) {
      // Extract response from assistant message
      // Assistant messages contain an array of content items:
      // - { type: "text", text: "..." } - Claude's text responses
      // - { type: "tool_use", id: "...", name: "Bash", input: {...} } - Tool calls
      if (json.type === "assistant" && json.message?.content) {
        // Check for text content
        const textContent = json.message.content.find(
          (item: any) => item.type === "text"
        );
        if (textContent?.text) {
          fullResponse += textContent.text;
        }

        // Check for tool use (and format as summary for user visibility)
        const toolUse = json.message.content.find(
          (item: any) => item.type === "tool_use"
        );
        if (toolUse) {
          const toolSummary = this.formatToolCallSummary(
            toolUse.name,
            toolUse.input
          );
          fullResponse += toolSummary;
        }
      }

      // Extract metadata from result object
      if (json.type === "result") {
        sessionId = json.session_id;
        if (json.usage) {
          usage = {
            input_tokens: json.usage.input_tokens,
            output_tokens: json.usage.output_tokens,
            total_tokens: json.usage.input_tokens + json.usage.output_tokens,
          };
        }
        model = json.model;
        if (json.is_error) {
          isError = true;
          errorMessage = json.result || "Unknown error";
        }
      }
    }

    // Build statistics string
    let statistics = "";
    if (usage) {
      const { input_tokens, output_tokens, total_tokens } = usage;
      const total = total_tokens || input_tokens + output_tokens;
      statistics = `Usage: ${input_tokens} input + ${output_tokens} output = ${total} tokens`;
      if (model) {
        statistics += ` | Model: ${model}`;
      }
    }

    if (isError) {
      return {
        success: false,
        response: "",
        statistics,
        error: errorMessage || stderr || "Stream contained error",
        exitCode: exitCode !== 0 ? exitCode : 1,
        sessionId,
      };
    }

    return {
      success: exitCode === 0,
      response: fullResponse.trim(),
      statistics,
      error: exitCode !== 0 ? stderr : undefined,
      exitCode,
      sessionId,
    };
  }

  // ============================================================
  // CONFIGURATION HELPERS
  // ============================================================

  /**
   * Get configured AI model (with alias resolution)
   */
  private getConfiguredModel(): string {
    return ConfigurationUtils.getClaudeCliModel();
  }

  /**
   * Validate model is supported by Claude CLI, fallback to default if not
   *
   * Accepts:
   * - Aliases: "sonnet", "opus", "haiku"
   * - Generic Copilot-style names: "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5"
   * - Full Claude names: "claude-sonnet-4-5-20250929"
   *
   * All are converted to Claude's full model name format.
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = this.getConfiguredModel();

    if (!requestedModel) {
      // Return full model name for default
      const fullName = getClaudeModelName(defaultModel);
      return fullName || defaultModel;
    }

    // Try to look up the model in our comprehensive map
    const fullModelName = getClaudeModelName(requestedModel);
    if (fullModelName) {
      return fullModelName;
    }

    // Model not recognized - warn user and fallback
    const supportedFormats =
      "aliases (sonnet, opus, haiku), generic names (claude-sonnet-4.5), or full names";
    const message = `Model "${requestedModel}" not recognized for Claude CLI. Using default: ${defaultModel}`;
    this.log(`⚠️ ${message}`);
    this.log(`   Accepted formats: ${supportedFormats}`);

    vscode.window.showWarningMessage(`FlightPath: ${message}`);

    const defaultFullName = getClaudeModelName(defaultModel);
    return defaultFullName || defaultModel;
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
    const mode = ConfigurationUtils.getClaudeCliToolPermissions();

    if (mode === "skipAll") {
      return ["--dangerously-skip-permissions"];
    }

    // Custom mode - read from shared settings and convert to Claude format
    const args: string[] = [];

    const allowedTools = ConfigurationUtils.getCliAllowedTools();
    const deniedTools = ConfigurationUtils.getCliDeniedTools();

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
