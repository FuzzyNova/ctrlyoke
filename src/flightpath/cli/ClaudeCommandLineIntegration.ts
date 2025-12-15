import * as vscode from "vscode";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotStatus } from "../base/CopilotIntegration";
import {
  BaseCliIntegration,
  CLI_EXECUTION_MODE,
  CLI_WARNING_MESSAGES,
} from "./BaseCliIntegration";
import {
  CLAUDE_CLI_DEFAULT_MODEL,
  getClaudeModelName,
} from "../../utils/ModelConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

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

  protected getEscapeIndicator(): string {
    return "esc to interrupt";
  }

  protected getTuiChromePattern(): RegExp {
    // Claude's TUI chrome: horizontal separator lines (─) that appear throughout the TUI
    // These appear:
    // - Before/after prompts in the input area
    // - In the status bar area
    // - Around various TUI sections
    // Match 60+ dashes to ensure we're matching TUI chrome, not markdown content
    return /─{60,}/;
  }

  protected getScreenEndPattern(): RegExp {
    return /─{20,}\r?\n>\s*/g;
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
      this.log("   💻 Install: npm install -g @anthropic-ai/claude-code");
      this.log(
        "   📖 Documentation: https://docs.anthropic.com/en/docs/claude-code"
      );
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
      this.log("✅ Claude CLI completed successfully");
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

  // ============================================================
  // CONFIGURATION HELPERS
  // ============================================================

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
    this.log(`⚠️ ${message}`);
    this.log(`   Accepted formats: ${supportedFormats}`);

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
        this.log(`✅ Allowed tools: ${convertedAllowTools.join(", ")}`);
      } else if (allowedTools.length > 0) {
        this.log(
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
      this.log(`🚫 Denied tools: ${convertedDenyTools.join(", ")}`);
    }

    return args;
  }

  // ============================================================
  // STATUS METHODS (Story 2.4)
  // ============================================================

  // Uses base class getStatus() method
}
