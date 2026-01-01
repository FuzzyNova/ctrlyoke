import * as vscode from "vscode";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotStatus } from "../base/CopilotIntegration";
import { BaseCliIntegration, CLI_EXECUTION_MODE } from "./BaseCliIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import { CliResponseParser } from "./shared/CliResponseParser";
import { CliNotificationMonitor } from "./shared/CliNotificationMonitor";
import { CliMcpConfigGenerator } from "./shared/CliMcpConfigGenerator";
import { CliToolPermissionMapper } from "./shared/CliToolPermissionMapper";

/**
 * Codex CLI JSON response structure (JSONL events format)
 */
interface CodexCliJsonEvent {
  type?: string;
  subtype?: string;
  item?: {
    id?: string;
    type?: string; // "agent_message" or "command_execution"
    role?: string;
    text?: string;
    command?: string; // For command_execution type
    aggregated_output?: string; // For command_execution type
    exit_code?: number | null; // For command_execution type
    status?: string; // "in_progress", "completed", "failed"
    tool_calls?: Array<{
      type: string;
      function?: {
        name: string;
        arguments?: string;
      };
    }>;
  };
  turn?: {
    id?: string;
    status?: string;
  };
  thread?: {
    id?: string;
  };
  thread_id?: string; // Actual field name in Codex output
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
  };
  session_id?: string;
  error?: string;
}

/**
 * Codex Code CLI Integration
 *
 * CLI-specific features:
 * - JSONL output format with event-based streaming
 * - Mode-based permissions (no granular tool patterns)
 * - Model selection from 5 GPT models
 * - Sandbox modes + approval policies for safety
 */
export class CodexCommandLineIntegration extends BaseCliIntegration {
  private cliVersion?: string;
  private streamBuffer: string = "";
  private accumulatedResponse: string = "";
  private logFilePath?: string;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.initialize();
  }

  /**
   * Get the CLI name for terminal/logging
   */
  protected getCliName(): string {
    return "codex";
  }

  protected getEscapeIndicator(): string {
    return "esc to interrupt";
  }

  protected getScreenEndPattern(): RegExp {
    // Codex prompt indicator: "› " (unicode right-pointing angle quotation mark U+203A)
    // Also matches status bar: "98% context left · ? for shortcuts"
    // Note: Global flag (g) is required for exec() to maintain position in while loop
    return /›\s|\d+%\s+context\s+left/g;
  }

  protected getTuiChromePatterns(): RegExp[] {
    return [
      // Codex-specific box borders (UI chrome only)
      /^[╭╰]─+[╮╯]$/, // Box top/bottom borders
      />_\s+OpenAI Codex/i, // Header (distinctive marker)
      /^│\s*│$/, // Empty box lines
      /model:.*\/model to change/i, // Model info line (distinctive parts)
      /directory:.*│$/i, // Directory line in box

      // Codex informational messages (UI chrome)
      /^Tip:/i, // Tips (any tip)
      /is deprecated.*Use \[features\]/i, // Deprecation warnings (distinctive parts)
      /^Enable it with/i, // Configuration hints
      /github\.com\/openai\/codex/i, // Documentation links

      // Codex status bar (UI chrome - context percentage and shortcuts)
      /\d+%\s+context\s+left.*\?\s+for shortcuts/i, // Status bar (distinctive parts)

      // Codex prompt indicator when empty (UI chrome)
      /^›\s*$/, // Empty prompt line only

      // Codex approval prompts (UI chrome)
      /Would you like to run the following command\?/i, // Approval question
      /^\s*Reason:/i, // Reason line prefix
      /^›\s+\d+\.\s+Yes, proceed/i, // Option 1 (distinctive part)
      /Yes, and don't ask again for commands that start with/i, // Option 2 (distinctive part)
      /No, and tell Codex what to do differently/i, // Option 3
      /Press enter to confirm or esc to cancel/i, // Confirmation hint

      // Codex separators (UI chrome)
      /^─\s+Worked for \d+s\s+─/i, // Worked for Xs separator

      // Codex spinner/thinking indicator (UI chrome)
      /^•?\s*W(o(r(k(i(n(g)?)?)?)?)?)?\d*\s*$/i, // Working prefixes (W, Wo, Wor, Work, Worki, Workin, Working + numbers)
      /^•?\s*(orking|rking|king|ing|ng|g)\s*$/i, // Working suffixes (fragments from right side)
      /^•?\s*\d+\s*$/i, // Standalone numbers (spinner frame counters)
      /\(.*esc to interrupt.*\)/i, // Lines with "(esc to interrupt)" or "(Xs • esc to interrupt)"
    ];
  }

  protected buildHeadlessArgs(
    baseArgs: string[],
    promptFileRef: string
  ): string[] {
    // Codex CLI expects: codex exec [OPTIONS] [PROMPT]
    // The prompt argument must come LAST after all flags/options
    // Note: Quotes are needed because spawn with shell:true doesn't auto-quote the @ character
    return [...baseArgs, `"${promptFileRef}"`];
  }

  protected shouldStreamHeadlessOutput(): boolean {
    return true; // Stream and extract content from JSONL events
  }

  protected buildInteractiveTuiCommand(baseArgs: string[]): string {
    // Filter out headless-only flags for interactive mode
    const interactiveArgs = baseArgs.filter(
      (arg, i, arr) =>
        arg !== "--json" && arg !== "exec" && arr[i - 1] !== "--output-format"
    );

    // Quote arguments that contain special characters (brackets, quotes, etc.)
    const quotedArgs = interactiveArgs.map((arg) => {
      // If arg contains special chars like brackets, spaces, or quotes, wrap in double quotes
      // But escape any internal double quotes first
      if (/[\[\]\s"]/.test(arg)) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    });

    return `${this.getCliName()} ${quotedArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Codex CLI.
   * Codex does NOT support @ symbol file references - it interprets them literally.
   * Returns the file path without the @ prefix.
   *
   * @param relativeFilePath The relative file path (e.g., ".flightpath/temp/prompt.md")
   * @returns File path without @ prefix (e.g., ".flightpath/temp/prompt.md")
   */
  protected formatFileReference(relativeFilePath: string): string {
    // Codex CLI doesn't support @ prefix - just return the path as-is
    return relativeFilePath;
  }

  public getIntegrationMode(): string {
    return Provider.CodexCli;
  }

  protected getCliDisplayName(): string {
    return "Codex CLI";
  }

  protected getInstallHint(): string {
    return "run: npm install -g @openai/codex-cli";
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Full permissions with dangerouslyAllowAll mode only
   */
  protected hasFullPermissions(): boolean {
    const toolMode = ConfigurationUtils.getCliToolPermissions();
    return toolMode === "dangerouslyAllowAll";
  }

  /**
   * Parse token counts from Codex CLI statistics string
   * Codex output includes usage in JSONL result event
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    // Statistics should be in format: "Usage: {input} input + {output} output = {total} tokens"
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
  // JSONL PARSING HELPERS
  // ============================================================

  /**
   * Format command execution output for display
   */
  private formatCommandExecution(
    cmd: string,
    status: string,
    exitCode: number | null | undefined,
    output: string
  ): string {
    let formatted = `\n\n🔧 Tool: ${cmd}\n`;
    formatted += `   Status: ${status}`;
    if (exitCode !== null && exitCode !== undefined) {
      formatted += ` (exit code: ${exitCode})`;
    }
    if (output.trim()) {
      const firstLine = output.split("\n")[0].substring(0, 100);
      formatted += `\n   Output: ${firstLine}${output.length > 100 ? "..." : ""}`;
    }
    formatted += `\n\n`;
    return formatted;
  }

  /**
   * Extract response text from a single JSONL event
   * Returns the text to add to the response, or empty string if no content
   */
  private extractResponseFromEvent(json: CodexCliJsonEvent): string {
    let content = "";

    // Handle different item types
    if (json.type === "item.completed" && json.item) {
      // Agent message (text response)
      if (json.item.type === "agent_message" && json.item.text) {
        content += json.item.text;
      }

      // Command execution (tool call)
      if (json.item.type === "command_execution") {
        const cmd = json.item.command || "unknown";
        const status = json.item.status || "unknown";
        const exitCode = json.item.exit_code;
        const output = json.item.aggregated_output || "";
        content += this.formatCommandExecution(cmd, status, exitCode, output);
      }
    }

    // Legacy tool_calls format (kept for compatibility)
    if (json.item?.tool_calls) {
      for (const toolCall of json.item.tool_calls) {
        if (toolCall.function?.name) {
          content += `\n\n[Tool: ${toolCall.function.name}]\n\n`;
        }
      }
    }

    return content;
  }

  /**
   * Process stdout chunks for JSONL format.
   *
   * JSONL format outputs newline-delimited JSON events:
   * 1. {"type":"thread.started","thread_id":"..."} - Thread init
   * 2. {"type":"turn.started"} - Turn started
   * 3. {"type":"item.completed","item":{"text":"...","role":"assistant"}} - Response chunks
   * 4. {"type":"turn.completed","usage":{"input_tokens":X,"output_tokens":Y}} - Turn complete
   *
   * We extract and stream response text from item.completed events.
   */
  protected processStreamingChunk(chunk: string): string | undefined {
    // Accumulate into buffer
    this.streamBuffer += chunk;

    const lines = this.streamBuffer.split("\n");
    this.streamBuffer = lines.pop() || ""; // Keep incomplete line in buffer

    let contentToEmit = "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json: CodexCliJsonEvent = JSON.parse(line);
        contentToEmit += this.extractResponseFromEvent(json);
      } catch (parseError) {
        // Log parse errors but continue processing
        Log.debug(`Failed to parse JSONL event: ${line.substring(0, 100)}`);
      }
    }

    return contentToEmit || undefined;
  }

  /**
   * Initialize CLI integration by checking if Codex CLI is available
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
        Log.info(`✅ Codex CLI available: ${this.cliVersion}`);
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
   * Override base class to provide Codex-specific installation instructions
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
      Log.info("   💻 Install: npm install -g @openai/codex-cli");
      Log.info("   📖 Documentation: https://docs.openai.com/codex");
    }
  }

  /**
   * Send prompt to Codex via CLI
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
      Log.error("❌ FlightPath: Cannot send prompt - Codex CLI not available");
      vscode.window.showErrorMessage(
        "FlightPath: Codex CLI is not available. Please install it first."
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

      // Build CLI arguments (mode-specific: interactive mode skips exec/--json flags)
      const mode = this.getExecutionMode();
      const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;
      const args = await this.buildCliArgs(
        prompt,
        isInteractive,
        workflowContext
      );

      // Store full command for debugging (will be updated by execution methods)
      this.lastCliCommand = `${this.getCliName()} ${args.join(" ")} "<prompt>"`;

      // Reset cancellation flag before execution
      this.resetCancellationFlag();

      // Route based on execution mode
      if (mode === CLI_EXECUTION_MODE.INTERACTIVE) {
        return await this.executeInTerminal(args, promptText, workflowContext);
      } else {
        return await this.executeHeadless(args, promptText, workflowContext);
      }
    } catch (error) {
      Log.error("❌ Codex CLI execution error", error);
      this.lastFailureReason =
        error instanceof Error ? error.message : "Failed to execute Codex CLI";
      vscode.window.showErrorMessage(
        `FlightPath: Failed to execute Codex CLI: ${error}`
      );
      return false;
    }
  }

  /**
   * Generate MCP server configuration for Codex CLI (delegated to shared utility)
   * Returns -c 'mcp_servers.flightpath={...}' inline TOML argument.
   */
  protected async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    try {
      const tomlConfig = CliMcpConfigGenerator.generateInlineTomlConfig(
        "flightpath",
        mcpServerPath,
        workspaceRoot
      );
      return ["-c", tomlConfig];
    } catch (error) {
      Log.error("Failed to generate MCP config for Codex CLI", error);
      return null;
    }
  }

  /**
   * Build CLI arguments for Codex command (without prompt - handled separately)
   *
   * @param prompt The prompt item
   * @param isInteractive Whether this is interactive mode (skips exec/--json flags)
   * @param workflowContext Optional workflow context for MCP config generation
   */
  private async buildCliArgs(
    prompt: PromptItem,
    isInteractive: boolean = false,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<string[]> {
    const args: string[] = [];

    // MCP configuration (when dynamic queue extension is enabled)
    if (workflowContext) {
      const dynamicQueueConfig = ConfigurationUtils.getDynamicQueueConfig();
      if (dynamicQueueConfig.enabled) {
        const {
          shouldInjectExtensionInstructions,
        } = require("../../utils/PromptIdentity");
        const shouldInject = shouldInjectExtensionInstructions(
          prompt,
          workflowContext.promptIndex,
          workflowContext.allPrompts,
          dynamicQueueConfig.dynamicExtensionOnLastPrompt
        );

        if (shouldInject) {
          const mcpServerPath =
            this.context.asAbsolutePath("out/mcp-server.js");
          const workspaceRoot = this.getWorkspaceRoot();
          if (workspaceRoot) {
            const mcpArgs = await this.getMcpConfigArgs(
              mcpServerPath,
              workspaceRoot
            );
            if (mcpArgs) {
              args.push(...mcpArgs);
              Log.info(
                "🔧 MCP server config added for dynamic queue extension"
              );
            }
          }
        }
      }
    }

    // Only add exec subcommand and --json flag for headless mode
    if (!isInteractive) {
      args.push("exec");
      args.push("--json");
    }

    // Model selection
    const model = this.validateAndGetModel(prompt.model);
    args.push("--model", model);

    // Tool permissions (only for headless mode - interactive mode lets user approve interactively)
    if (!isInteractive) {
      const permissionArgs = this.getPermissionArgs();
      args.push(...permissionArgs);

      // Add ADDITIONAL directories from settings (only in headless mode)
      // In interactive mode, user controls directory access through TUI
      const toolMode = ConfigurationUtils.getCliToolPermissions();
      if (toolMode !== "dangerouslyAllowAll") {
        // danger mode bypasses all restrictions, no need for --add-dir
        const additionalDirs = ConfigurationUtils.getCliAllowedDirs();
        additionalDirs.forEach((dir) => {
          args.push("--add-dir", dir);
        });
      }
    } else {
      // Interactive mode: Configure notify hook for completion detection
      const notifyScript = this.getNotificationScriptPath();
      const notifyConfig =
        CliNotificationMonitor.buildCodexNotifyConfig(notifyScript);
      args.push("--config", notifyConfig);
      Log.debug(`🔔 Configured notify hook for completion detection`);
    }

    // Session management
    if (prompt.newChatSession === false && this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // Note: Prompt is NOT included here - it's a positional argument
    // handled by the execution methods

    return args;
  }

  /**
   * Execute in headless mode (background process)
   * Uses temp file parameter to pass the prompt (exec --json @file)
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
    this.accumulatedResponse = "";

    return this.executeHeadlessWithPromptFile(
      args,
      promptText,
      workflowContext,
      async (result: { stdout: string; stderr: string; exitCode: number }) => {
        // Parse the CLI output using JSONL format
        const cliResult = this.parseJsonLinesOutput(
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
            cliResult.error || "Codex CLI returned non-zero exit code";
          Log.error("❌ Codex CLI execution failed", new Error(errorMsg));
          this.lastFailureReason = errorMsg;
          vscode.window.showErrorMessage(
            `FlightPath: Codex CLI failed: ${errorMsg}`
          );
          return false;
        }
      }
    );
  }

  /**
   * Parse JSONL output from Codex CLI (delegated to shared utility)
   */
  private parseJsonLinesOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    return CliResponseParser.parseCodexJsonLines(stdout, stderr, exitCode);
  }

  // ============================================================
  // CONFIGURATION HELPERS
  // ============================================================

  /**
   * Validate model is supported by Codex CLI, fallback to default if not
   */
  private validateAndGetModel(requestedModel?: string): string {
    const defaultModel = ConfigurationUtils.getCodexCliModel();

    if (!requestedModel) {
      return defaultModel;
    }

    // Check if model is in the supported list
    const supportedModels = [
      "gpt-5.1-codex-max",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.2",
      "gpt-5.1",
    ];

    if (supportedModels.includes(requestedModel)) {
      return requestedModel;
    }

    // Model not supported - warn user and fallback
    const message = `Model "${requestedModel}" not supported by Codex CLI. Using default: ${defaultModel}`;
    Log.warn(`⚠️ ${message}`);
    vscode.window.showWarningMessage(
      `FlightPath: ${message}\\n\\nCodex-supported models: ${supportedModels.join(", ")}`
    );

    return defaultModel;
  }

  /**
   * Get permission arguments based on configuration (delegated to shared utility)
   * CRITICAL: Codex does NOT support granular tool patterns
   */
  private getPermissionArgs(): string[] {
    const mode = ConfigurationUtils.getCliToolPermissions();
    const allowedTools = ConfigurationUtils.getCliAllowedTools();
    const deniedTools = ConfigurationUtils.getCliDeniedTools();
    const sandboxMode = ConfigurationUtils.getCodexSandboxMode();
    const approvalPolicy = ConfigurationUtils.getCodexApprovalPolicy();

    return CliToolPermissionMapper.buildCodexArgs(
      { mode, allowedTools, deniedTools },
      sandboxMode,
      approvalPolicy
    );
  }

  // ============================================================
  // CODEX-SPECIFIC: NOTIFY HOOK COMPLETION DETECTION
  // ============================================================

  /**
   * Get path to FlightPath's Codex notification handler script.
   * This script is called by Codex CLI when agent-turn-complete events occur.
   */
  private getNotificationScriptPath(): string {
    const path = require("path");
    return path.join(
      this.context.extensionPath,
      "out",
      "scripts",
      "flightpath-codex-notify.js"
    );
  }

  /**
   * Monitor notification file for completion (delegated to shared utility).
   */
  private async monitorNotificationFile(
    threadId: string | undefined,
    startTime: Date,
    timeoutMs: number
  ): Promise<{ completed: boolean; error?: string }> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        completed: false,
        error: "Cannot determine workspace root for notification monitoring",
      };
    }

    const notifyDir = CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "codex"
    );

    return CliNotificationMonitor.monitorForCompletion(
      { directory: notifyDir, timeoutMs },
      threadId,
      startTime,
      () => this.isCancelling
    );
  }

  /**
   * Execute Codex CLI in interactive terminal with dual monitoring:
   * - Time-based TUI output extraction
   * - Log file completion detection
   *
   * This overrides BaseCliIntegration's executeInTerminal to handle
   * Codex's unique cursor-based rendering and log-based completion.
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
        }) => {
          const tuiAbortController = new AbortController();
          const startTime = new Date();
          let threadId: string | undefined;

          Log.info(
            "⏳ Starting Codex TUI processing with notify hook monitoring..."
          );
          const tuiPromise = tuiProcessor.processStream(
            execution,
            terminal,
            promptWithInstruction,
            timeoutMs,
            this.lastSanitizedPrompt,
            tuiAbortController
          );

          const notifyPromise = this.monitorNotificationFile(
            threadId,
            startTime,
            timeoutMs
          );

          const notifyResult = await Promise.race([
            notifyPromise,
            tuiPromise.then((tuiResult) => ({
              completed: tuiResult.success,
              error: tuiResult.errorMessage,
            })),
          ]);

          if (notifyResult.completed) {
            Log.debug(
              "🛑 Notify hook detected completion - aborting TUI stream"
            );
            tuiAbortController.abort();
          }

          const tuiResult = await tuiPromise;

          if (!notifyResult.completed) {
            this.lastFailureReason =
              notifyResult.error || "Completion detection failed";
            Log.error(`❌ Codex execution failed: ${this.lastFailureReason}`);
            return { success: false, errorMessage: this.lastFailureReason };
          }

          if (!tuiResult.success && tuiResult.errorMessage) {
            this.lastFailureReason = tuiResult.errorMessage;
            Log.warn(
              `⚠️ TUI processor detected error: ${tuiResult.errorMessage}`
            );
          }

          return { success: true };
        },
        { useTimeBasedExtraction: true }
      );

      return result.success;
    } catch (error) {
      this.lastFailureReason =
        error instanceof Error ? error.message : String(error);
      Log.error(`❌ Codex execution error: ${this.lastFailureReason}`);
      return false;
    }
  }
}
