import * as vscode from "vscode";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotStatus } from "../base/CopilotIntegration";
import { BaseCliIntegration, CLI_EXECUTION_MODE } from "./BaseCliIntegration";
import { getClaudeModelName } from "../../utils/ModelConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import type { TuiProcessResult } from "../../utils/TuiStreamProcessor";

/**
 * Maps Copilot permission patterns to Claude tool names.
 * Copilot uses categories (shell, write), Claude uses granular tools (Bash, Write, Edit, Read, etc.).
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
 * CLI-specific features:
 * - Stream-json output format with real-time content extraction
 * - Model alias resolution (sonnet, opus, haiku)
 * - Tool call summaries for user visibility
 */
export class ClaudeCommandLineIntegration extends BaseCliIntegration {
  private cliVersion?: string;
  private streamBuffer: string = ""; // Buffer for incomplete JSON lines in streaming mode

  constructor(context: vscode.ExtensionContext) {
    super(context);
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

  protected getEscapeIndicator(): string {
    return "esc to interrupt";
  }

  protected getScreenEndPattern(): RegExp {
    return /─{20,}\r?\n>\s*/g;
  }

  protected getTuiChromePatterns(): RegExp[] {
    return [
      // Claude-specific box drawing and separators
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing characters (8+ in a row = UI chrome)
      /^[─═]{20,}$/, // Long horizontal separators
      /Claude Code v[\d.]+/i, // Header with version

      // Claude ASCII logo (distinctive characters)
      /▐▛███▜▌/, // Logo line 1
      /▝▜█████▛▘/, // Logo line 2

      // Claude welcome and info sections (UI chrome)
      /^Welcome back/i, // Welcome message
      /^Recent activity/i, // Activity header
      /^No recent activity/i, // Empty activity
      /^What's new/i, // Release notes header
      /\/release-notes for more/i, // Navigation hint
      /^Added .* support for/i, // Feature announcements
      /^Added .* tool for/i, // Tool announcements
      /Claude Pro ·.*Organization/i, // Status line with model and account

      // Claude spinner/thinking indicator (UI chrome)
      /^[✻✽✢✶·*]\s*$/, // Spinner alone (any Claude spinner character including *)
      /^[✻✽✢✶·*]\s+.*\(esc to interrupt.*\)/, // Spinner + text + (esc to interrupt)

      // Claude approval prompts (UI chrome)
      /^Do you want to proceed\?/i, // Approval question
      /^Esc to cancel$/i, // Cancel hint (exact match - distinctive)
      /^❯\s*\d+\./, // Selected option indicator
      /^\s*\d+\.\s+Yes, and don't ask again/i, // Option 2
      /^\s*\d+\.\s+Type here to tell Claude/i, // Option 3

      // Claude UI hints and mode indicators
      /ctrl\+b to run in background/i, // Background hint
      /^>\s*$/, // Empty prompt line
      /⏵⏵.*\(shift\+tab to cycle\)/, // Mode indicator (accept edits, etc.)
      /⏸.*\(shift\+tab to cycle\)/, // Pause/plan mode indicator
      /^\s*\?\s+for shortcuts/i, // Shortcuts hint
    ];
  }

  protected buildHeadlessArgs(
    baseArgs: string[],
    promptFileRef: string
  ): string[] {
    // Claude CLI expects the prompt as the FIRST positional argument (right after command name)
    // This is critical because variadic flags like --disallowedTools will consume any args after them
    // Format: claude "@path/to/file" -p [other args]
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return [`"${promptFileRef}"`, ...baseArgs];
  }

  protected shouldStreamHeadlessOutput(): boolean {
    return true; // Stream and extract content from JSON chunks
  }

  protected buildInteractiveTuiCommand(baseArgs: string[]): string {
    // Filter out headless-only flags for interactive mode
    const interactiveArgs = baseArgs.filter(
      (arg, i, arr) =>
        arg !== "-p" &&
        arg !== "--output-format" &&
        arr[i - 1] !== "--output-format"
    );
    return `${this.getCliName()} ${interactiveArgs.join(" ")}`;
  }

  protected getIntegrationMode(): string {
    return Provider.ClaudeCli;
  }

  protected getCliDisplayName(): string {
    return "Claude Code CLI";
  }

  protected getInstallHint(): string {
    return "run: npm install -g @anthropic-ai/claude-code";
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Full permissions with:
   * - dangerouslyAllowAll: bypasses ALL checks including deny list
   * - allowAll/custom: uses --permission-mode bypassPermissions (respects deny list)
   */
  protected hasFullPermissions(): boolean {
    // All modes now auto-grant permissions (dangerouslyAllowAll, allowAll, custom)
    // The difference is whether deny list is respected
    return true;
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

  private extractJsonObjectsFromStream(data: string): {
    objects: any[];
    remainder: string;
  } {
    const objects: any[] = [];
    let cursor = 0;

    while (cursor < data.length) {
      const objStart = data.indexOf("{", cursor);
      if (objStart === -1) {
        cursor = data.length;
        break;
      }

      let depth = 0;
      let inString = false;
      let escape = false;
      let objEnd = -1;

      for (let i = objStart; i < data.length; i++) {
        const char = data[i];

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

      if (objEnd !== -1) {
        const objStr = data.substring(objStart, objEnd);
        try {
          const json = JSON.parse(objStr);
          objects.push(json);
        } catch (parseError) {
          console.warn(
            "Failed to parse stream-json object:",
            objStr.substring(0, 100),
            parseError
          );
        }
        cursor = objEnd;
        continue;
      }

      cursor = objStart;
      break;
    }

    return {
      objects,
      remainder: data.substring(cursor),
    };
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
    // Accumulate into buffer
    this.streamBuffer += chunk;

    const { objects, remainder } = this.extractJsonObjectsFromStream(
      this.streamBuffer
    );
    this.streamBuffer = remainder;

    let contentToEmit = "";

    for (const json of objects) {
      if (json.type === "assistant" && json.message?.content) {
        const textContent = json.message.content.find(
          (item: any) => item.type === "text"
        );
        if (textContent?.text) {
          contentToEmit += textContent.text;
        }

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
    }

    return contentToEmit || undefined;
  }

  // Context expansion now handled by ContextExpander utility (no override needed)

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
        Log.info(`✅ Claude Code CLI available: ${this.cliVersion}`);
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
   * Override base class to provide Claude-specific installation instructions
   */
  protected handleInitializationError(
    type: "command_failed" | "exception",
    error: unknown
  ): void {
    super.handleInitializationError(type, error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Enhanced error messages based on error type
    if (
      errorMessage.includes("ENOENT") ||
      errorMessage.includes("not found") ||
      errorMessage.includes("not recognized")
    ) {
      Log.info("   💻 Install: npm install -g @anthropic-ai/claude-code");
      Log.info(
        "   📖 Documentation: https://docs.anthropic.com/en/docs/claude-code"
      );
    }
  }

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
      Log.error(
        "❌ FlightPath: Cannot send prompt - Claude Code CLI not available"
      );
      vscode.window.showErrorMessage(
        "FlightPath: Claude Code CLI is not available. Please install it first."
      );
      return false;
    }

    // Warn if headless mode without full permissions
    this.warnIfHeadlessWithoutPermissions();

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
      const mode = this.getExecutionMode();
      const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;
      const args = this.buildCliArgs(prompt, isInteractive);

      // Store full command for debugging (will be updated by execution methods)
      this.lastCliCommand = `${this.getCliName()} ${args.join(" ")} "<prompt>"`;

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Route based on execution mode
      if (mode === CLI_EXECUTION_MODE.INTERACTIVE) {
        return await this.executeInteractive(args, promptText, workflowContext);
      } else {
        return await this.executeHeadless(args, promptText, workflowContext);
      }
    } catch (error) {
      Log.error("❌ Claude CLI execution error", error);
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

      // Always use stream-json format with verbose flag for headless mode
      args.push("--output-format", "stream-json");
      args.push("--verbose");
    }

    // Model selection
    const model = this.validateAndGetModel(prompt.model);
    args.push("--model", model);

    // Add workspace directories
    const workspaceDirs = this.getWorkspaceDirs();
    workspaceDirs.forEach((dir) => {
      args.push("--add-dir", dir);
    });

    // Tool permissions (only for headless mode - interactive mode lets user approve interactively)
    if (!isInteractive) {
      const toolPermissionArgs = this.getToolPermissionArgs();
      args.push(...toolPermissionArgs);
    } else {
      // Interactive mode: Configure stop hook for completion detection
      const hookSettings = this.buildStopHookSettings();
      // Wrap JSON in single quotes for shell safety (PowerShell/bash)
      args.push("--settings", `'${hookSettings}'`);
      Log.debug(`🔔 Configured stop hook for completion detection`);
    }

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
   * Execute Claude CLI in interactive terminal with dual monitoring:
   * - Screen-based TUI output extraction
   * - Stop hook completion detection
   *
   * This overrides BaseCliIntegration's executeInTerminal to add
   * Claude's stop hook notification monitoring for reliable completion.
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    try {
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
          shouldShowOutput,
          lastSanitizedPrompt,
        }) => {
          const tuiAbortController = new AbortController();
          const startTime = new Date();
          let sessionId: string | undefined;

          Log.info("⏳ Starting Claude TUI processing with stop hook monitoring...");
          const tuiPromise = tuiProcessor.processStream(
            execution,
            terminal,
            promptWithInstruction,
            timeoutMs,
            lastSanitizedPrompt,
            shouldShowOutput,
            tuiAbortController
          );

          const notifyPromise = this.monitorNotificationFile(
            sessionId,
            startTime,
            timeoutMs
          );

          const notifyResult = await Promise.race([
            notifyPromise,
            tuiPromise.then((tuiResult: TuiProcessResult) => ({
              completed: tuiResult.success,
              error: tuiResult.errorMessage,
            })),
          ]);

          if (notifyResult.completed) {
            Log.debug("🛑 Stop hook detected completion - aborting TUI stream");
            tuiAbortController.abort();
          }

          const tuiResult = await tuiPromise;

          if (!notifyResult.completed) {
            this.lastFailureReason =
              notifyResult.error || "Completion detection failed";
            Log.error(`❌ Claude execution failed: ${this.lastFailureReason}`);
            return { success: false, errorMessage: this.lastFailureReason };
          }

          if (!tuiResult.success && tuiResult.errorMessage) {
            this.lastFailureReason = tuiResult.errorMessage;
            Log.warn(
              `⚠️ TUI processor detected error: ${tuiResult.errorMessage}`
            );
          }

          return { success: true };
        }
      );

      return result.success;
    } catch (error) {
      this.lastFailureReason =
        error instanceof Error ? error.message : String(error);
      Log.error(`❌ Claude execution error: ${this.lastFailureReason}`);
      return false;
    }
  }

  /**
   * Execute in interactive terminal mode
   * Uses temp file approach via base class to avoid shell escaping issues
   */
  private async executeInteractive(
    args: string[],
    promptText: string,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    // Use base class executeInTerminal (passes workflow context for temp file naming)
    const success = await this.executeInTerminal(
      args,
      promptText,
      workflowContext
    );

    // Note: In interactive mode, we can't easily extract session ID from JSON output
    // since the terminal output is mixed with ANSI codes. Session continuity may be limited.
    if (success) {
      Log.info("✅ Claude CLI completed successfully");
    }

    return success;
  }

  /**
   * Execute in headless mode (background process)
   * Uses temp file parameter to pass the prompt (-p @file)
   */
  private async executeHeadless(
    args: string[],
    promptText: string,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean> {
    // Reset stream buffer for new execution
    this.streamBuffer = "";

    return this.executeHeadlessWithPromptFile(
      args,
      promptText,
      workflowContext,
      async (result: { stdout: string; stderr: string; exitCode: number }) => {
        // Parse the CLI output using stream-json format
        const cliResult = this.parseStreamJsonOutput(
          result.stdout,
          result.stderr,
          result.exitCode
        );

        // Check if this was a cancellation
        if (this.isCancelling) {
          Log.info("⏹️ Prompt execution cancelled by user");
          return false;
        }

        // Store the result for statistics retrieval
        this.lastResult = cliResult;

        // Extract and store session ID
        if (cliResult.sessionId) {
          this.sessionId = cliResult.sessionId;
          Log.debug(`💾 Session ID: ${this.sessionId}`);
        }

        if (cliResult.success) {
          this.logResponse(cliResult.response, cliResult.statistics);
          this.responseCompleteEmitter.fire(cliResult.response);
          return true;
        } else {
          const errorMsg =
            cliResult.error || "Claude CLI returned non-zero exit code";
          Log.error("❌ Claude CLI execution failed", new Error(errorMsg));
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

    const { objects } = this.extractJsonObjectsFromStream(stdout);

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

  /**
   * Validate model is supported by Claude CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = ConfigurationUtils.getClaudeCliModel();

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
    Log.warn(`⚠️ ${message}`);
    Log.warn(`   Accepted formats: ${supportedFormats}`);

    vscode.window.showWarningMessage(`FlightPath: ${message}`);

    const defaultFullName = getClaudeModelName(defaultModel);
    return defaultFullName || defaultModel;
  }

  private convertToolPatternToClaudeFormat(copilotPattern: string): string {
    const parsed = this.parseToolPattern(copilotPattern);
    if (!parsed) {
      return copilotPattern; // Keep as-is if pattern doesn't match expected format
    }

    const [toolName, args] = parsed;
    const claudeToolName =
      COPILOT_TO_CLAUDE_TOOL_MAP[toolName.toLowerCase()] || toolName;
    return args ? claudeToolName + args : claudeToolName;
  }

  /**
   * Get tool permission arguments based on configuration
   * Supports three modes:
   * - "dangerouslyAllowAll": --dangerously-skip-permissions (bypasses ALL checks, ignores deny list)
   * - "allowAll": --permission-mode bypassPermissions + --tools "default" with deny patterns (safe automation, respects deny list)
   * - "custom": --permission-mode bypassPermissions with specific allow/deny patterns
   *
   * Reads from shared cliAllowedTools/cliDeniedTools and converts to Claude format
   */
  private getToolPermissionArgs(): string[] {
    const mode = ConfigurationUtils.getCliToolPermissions();

    if (mode === "dangerouslyAllowAll") {
      return ["--dangerously-skip-permissions"];
    }

    // Both allowAll and custom modes use --permission-mode bypassPermissions
    const args: string[] = ["--permission-mode", "bypassPermissions"];
    const deniedTools = ConfigurationUtils.getCliDeniedTools();

    if (mode === "allowAll") {
      // Allow all tools (--tools "default") but still apply deny list
      args.push("--tools", "default");
    } else {
      // Custom mode - read specific allow patterns
      const allowedTools = ConfigurationUtils.getCliAllowedTools();
      const convertedAllowTools: string[] = [];

      allowedTools.forEach((tool) => {
        const claudeTool = this.convertToolPatternToClaudeFormat(tool);
        if (!convertedAllowTools.includes(claudeTool)) {
          convertedAllowTools.push(claudeTool);
        }
      });

      // Add all allowed tools as variadic arguments to single flag
      // Quote each pattern to handle spaces and special characters (shell: true in spawn)
      if (convertedAllowTools.length > 0) {
        const quotedTools = convertedAllowTools.map((tool) => `"${tool}"`);
        args.push("--allowedTools", ...quotedTools);
        Log.info(`✅ Allowed tools: ${convertedAllowTools.join(", ")}`);
      } else if (allowedTools.length > 0) {
        Log.warn(
          "⚠️ Custom tool permissions mode enabled but no allowed tools specified. Claude will prompt for each tool."
        );
      }
    }

    // Add disallowed tool patterns (for both allowAll and custom modes)
    // Quote each pattern to handle spaces and special characters (shell: true in spawn)
    const convertedDenyTools: string[] = [];

    deniedTools.forEach((tool) => {
      const claudeTool = this.convertToolPatternToClaudeFormat(tool);
      if (!convertedDenyTools.includes(claudeTool)) {
        convertedDenyTools.push(claudeTool);
      }
    });

    if (convertedDenyTools.length > 0) {
      const quotedTools = convertedDenyTools.map((tool) => `"${tool}"`);
      args.push("--disallowedTools", ...quotedTools);
      Log.info(`🚫 Denied tools: ${convertedDenyTools.join(", ")}`);
    }

    return args;
  }

  // ============================================================
  // CLAUDE-SPECIFIC: STOP HOOK COMPLETION DETECTION
  // ============================================================

  /**
   * Get path to FlightPath's Claude stop hook handler script.
   * This script is called by Claude CLI when Stop events occur.
   */
  private getStopHookScriptPath(): string {
    const path = require("path");
    return path.join(
      this.context.extensionPath,
      "out",
      "scripts",
      "flightpath-claude-stop-hook.js"
    );
  }

  /**
   * Get directory where Claude stop notifications are written.
   * Location: {workspace}/.flightpath/temp/claude-notifications/
   *
   * Uses workspace-specific directory to prevent conflicts when multiple
   * VS Code instances are running FlightPath simultaneously.
   */
  private getNotificationDirectory(): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Cannot determine workspace root for notification path");
    }

    const path = require("path");
    return path.join(
      workspaceRoot,
      ".flightpath",
      "temp",
      "claude-notifications"
    );
  }

  /**
   * Build settings JSON string with Stop hook configuration.
   * This is passed via --settings flag to Claude CLI.
   *
   * @returns JSON string with hook configuration
   */
  private buildStopHookSettings(): string {
    const scriptPath = this.getStopHookScriptPath();
    const notifyDir = this.getNotificationDirectory();

    // Convert paths to forward slashes (works on Windows and avoids escaping issues)
    const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
    const normalizedNotifyDir = notifyDir.replace(/\\/g, "/");

    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `node "${normalizedScriptPath}" "${normalizedNotifyDir}"`,
              },
            ],
          },
        ],
      },
    };

    return JSON.stringify(settings);
  }

  /**
   * Extract session ID from Claude CLI output.
   * Claude emits session info in various formats - try to parse it.
   *
   * @param output Terminal or process output
   * @returns Session ID if found, undefined otherwise
   */
  private extractSessionId(output: string): string | undefined {
    // Try to find session_id in JSON output (stream-json format)
    const sessionMatch = output.match(/"session_id"\s*:\s*"([^"]+)"/i);
    if (sessionMatch) {
      return sessionMatch[1];
    }

    // Try to find session ID in log-like output
    const sessionLogMatch = output.match(/session[_\s-]id[:\s]+([a-f0-9-]+)/i);
    if (sessionLogMatch) {
      return sessionLogMatch[1];
    }

    return undefined;
  }

  /**
   * Simple delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Monitor notification file for completion.
   *
   * Uses Claude's Stop hook to get completion events.
   * The stop hook handler script writes a JSON file that we monitor.
   *
   * If session ID is not available, monitors the entire notification directory
   * for any new notification files (since we're the only process running).
   *
   * @param sessionId Session ID to monitor (from Claude output), undefined to monitor all files
   * @param startTime Execution start time (for timeout calculation)
   * @param timeoutMs Maximum time to wait for completion
   * @returns Object with completed flag and optional error message
   */
  private async monitorNotificationFile(
    sessionId: string | undefined,
    startTime: Date,
    timeoutMs: number
  ): Promise<{ completed: boolean; error?: string }> {
    const fs = require("fs");
    const path = require("path");

    const notifyDir = this.getNotificationDirectory();

    // Ensure notification directory exists
    if (!fs.existsSync(notifyDir)) {
      fs.mkdirSync(notifyDir, { recursive: true });
    }

    // Get initial file list to detect new files
    let initialFiles = new Set<string>();
    try {
      const files = fs.readdirSync(notifyDir);
      initialFiles = new Set(files);
      Log.debug(`📋 Initial notification files: ${files.length}`);
    } catch (error) {
      Log.debug(`Could not read notification directory: ${error}`);
    }

    if (sessionId) {
      Log.debug(`📋 Monitoring notification file for session: ${sessionId}`);
    } else {
      Log.debug(
        `📋 Monitoring notification directory for any new completion file`
      );
    }

    // Poll for notification file
    while (Date.now() - startTime.getTime() < timeoutMs) {
      try {
        if (sessionId) {
          // Monitor specific session ID file
          const notifyFile = path.join(notifyDir, `${sessionId}.json`);

          if (fs.existsSync(notifyFile)) {
            // Read notification data
            const notifyData = JSON.parse(fs.readFileSync(notifyFile, "utf8"));

            Log.info(
              `✅ Claude completion detected via stop hook (session: ${notifyData.sessionId})`
            );

            // Clean up notification file
            try {
              fs.unlinkSync(notifyFile);
              Log.debug(`🗑️ Cleaned up notification file`);
            } catch (cleanupError) {
              Log.debug(
                `Failed to clean up notification file: ${cleanupError}`
              );
            }

            return { completed: true };
          }
        } else {
          // Monitor for any new notification file
          const currentFiles = fs.readdirSync(notifyDir);

          for (const file of currentFiles) {
            if (!initialFiles.has(file) && file.endsWith(".json")) {
              const notifyFile = path.join(notifyDir, file);

              try {
                const notifyData = JSON.parse(
                  fs.readFileSync(notifyFile, "utf8")
                );

                Log.info(
                  `✅ Claude completion detected via stop hook (session: ${notifyData.sessionId})`
                );

                // Clean up notification file
                try {
                  fs.unlinkSync(notifyFile);
                  Log.debug(`🗑️ Cleaned up notification file: ${file}`);
                } catch (cleanupError) {
                  Log.debug(
                    `Failed to clean up notification file: ${cleanupError}`
                  );
                }

                return { completed: true };
              } catch (parseError) {
                Log.debug(
                  `Failed to parse notification file ${file}: ${parseError}`
                );
                // Continue checking other files
              }
            }
          }
        }
      } catch (error) {
        Log.debug(`Notification file check error: ${error}`);
      }

      // Wait before next check
      await this.delay(500);
    }

    // Timeout reached
    Log.warn(`⏱️ Notification file monitoring timed out`);
    return {
      completed: false,
      error: "Timeout waiting for stop hook notification",
    };
  }
}
