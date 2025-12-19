import * as vscode from "vscode";
import { PromptItem, Provider } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";
import { CopilotStatus } from "../base/CopilotIntegration";
import { BaseCliIntegration, CLI_EXECUTION_MODE } from "./BaseCliIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { Log } from "../../utils/Log";
import { TuiStreamProcessor } from "../../utils/TuiStreamProcessor";
import { TempFileManager } from "../../utils/TempFileManager";

/**
 * Codex CLI JSON response structure (JSONL events format)
 */
interface CodexCliJsonEvent {
  type?: string;
  subtype?: string;
  item?: {
    id?: string;
    role?: string;
    text?: string;
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

  // ============================================================
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ============================================================

  /**
   * Get the CLI name for terminal/logging
   */
  protected getCliName(): string {
    return "codex";
  }

  protected getEscapeIndicator(): string {
    return "esc to interrupt";
  }

  protected getTuiChromePattern(): RegExp {
    // Codex's TUI chrome: status bar that shows context percentage
    // Example: "98% context left · ? for shortcuts"
    // This is unique to TUI mode and won't appear in regular output
    return /\d+%\s+context\s+left/;
  }

  protected getScreenEndPattern(): RegExp {
    // Codex prompt indicator: "› " (unicode right-pointing angle quotation mark U+203A)
    // Also matches status bar: "98% context left · ? for shortcuts"
    // Note: Global flag (g) is required for exec() to maintain position in while loop
    return /›\s|\d+%\s+context\s+left/g;
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
    return `${this.getCliName()} ${interactiveArgs.join(" ")}`;
  }

  protected getIntegrationMode(): string {
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
    const match = statistics.match(
      /(\\d+)\\s+input\\s+\\+\\s+(\\d+)\\s+output/
    );
    if (match) {
      return {
        prompt: parseInt(match[1], 10),
        completion: parseInt(match[2], 10),
      };
    }
    return undefined;
  }

  /**
   * Process stdout chunks for JSONL format.
   *
   * JSONL format outputs newline-delimited JSON events:
   * 1. {"type":"thread.started","thread":{"id":"..."}} - Thread init
   * 2. {"type":"turn.started","turn":{"id":"..."}} - Turn started
   * 3. {"type":"item.completed","item":{"text":"...","role":"assistant"}} - Response chunks
   * 4. {"type":"turn.completed","turn":{"status":"completed"}} - Turn complete
   *
   * We extract and stream response text from item.completed events.
   */
  protected processStreamingChunk(chunk: string): string | undefined {
    // Accumulate into buffer
    this.streamBuffer += chunk;

    const lines = this.streamBuffer.split("\\n");
    this.streamBuffer = lines.pop() || ""; // Keep incomplete line in buffer

    let contentToEmit = "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json: CodexCliJsonEvent = JSON.parse(line);

        // Extract response text from item.completed events
        if (json.type === "item.completed" && json.item?.text) {
          contentToEmit += json.item.text;
        }

        // Tool calls can be shown as summaries
        if (json.item?.tool_calls) {
          for (const toolCall of json.item.tool_calls) {
            if (toolCall.function?.name) {
              contentToEmit += `\\n\\n[Tool: ${toolCall.function.name}]\\n\\n`;
            }
          }
        }
      } catch (parseError) {
        // Log parse errors but continue processing
        Log.debug(`Failed to parse JSONL event: ${line.substring(0, 100)}`);
      }
    }

    return contentToEmit || undefined;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

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

  // ============================================================
  // PROMPT EXECUTION
  // ============================================================

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
   * Build CLI arguments for Codex command (without prompt - handled separately)
   *
   * @param prompt The prompt item
   * @param isInteractive Whether this is interactive mode (skips exec/--json flags)
   */
  private buildCliArgs(
    prompt: PromptItem,
    isInteractive: boolean = false
  ): string[] {
    const args: string[] = [];

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

    if (success) {
      Log.info("✅ Codex CLI completed successfully");
    }

    return success;
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
   * Parse JSONL output from Codex CLI (newline-delimited JSON events)
   *
   * JSONL format outputs events:
   * 1. {"type":"thread.started","thread":{"id":"..."}}
   * 2. {"type":"turn.started","turn":{"id":"..."}}
   * 3. {"type":"item.completed","item":{"text":"...","role":"assistant"}}
   * 4. {"type":"turn.completed","turn":{"status":"completed"}}
   */
  private parseJsonLinesOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    let fullResponse = "";
    let sessionId: string | undefined;
    let usage:
      | { input_tokens: number; output_tokens: number; total_tokens?: number }
      | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    const lines = stdout.split("\\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json: CodexCliJsonEvent = JSON.parse(line);

        // Extract response from item.completed events
        if (json.type === "item.completed" && json.item?.text) {
          fullResponse += json.item.text;
        }

        // Extract session ID from thread.started events
        if (json.type === "thread.started" && json.thread?.id) {
          sessionId = json.thread.id;
        }

        // Extract usage from turn.completed events
        if (json.type === "turn.completed" && json.usage) {
          usage = {
            input_tokens: json.usage.input_tokens,
            output_tokens: json.usage.output_tokens,
            total_tokens: json.usage.input_tokens + json.usage.output_tokens,
          };
        }

        // Check for error
        if (json.error) {
          isError = true;
          errorMessage = json.error;
        }
      } catch (parseError) {
        // Ignore parse errors for non-JSON lines
        Log.debug(`Skipping non-JSON line: ${line.substring(0, 100)}`);
      }
    }

    // Build statistics string
    let statistics = "";
    if (usage) {
      const { input_tokens, output_tokens, total_tokens } = usage;
      const total = total_tokens || input_tokens + output_tokens;
      statistics = `Usage: ${input_tokens} input + ${output_tokens} output = ${total} tokens`;
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
   * Get permission arguments based on configuration
   * CRITICAL: Codex does NOT support granular tool patterns
   * Uses simplified mode-based mapping only
   */
  private getPermissionArgs(): string[] {
    const toolMode = ConfigurationUtils.getCliToolPermissions();

    // Warn if tool patterns are configured (unsupported by Codex)
    const allowedTools = ConfigurationUtils.getCliAllowedTools();
    const deniedTools = ConfigurationUtils.getCliDeniedTools();
    if (allowedTools.length > 0 || deniedTools.length > 0) {
      Log.warn(
        "⚠️ Codex CLI does not support granular tool patterns (cliAllowedTools/cliDeniedTools). Use Codex-specific sandbox/approval settings for custom control."
      );
    }

    switch (toolMode) {
      case "dangerouslyAllowAll":
        // Bypass ALL checks (dangerous!)
        return ["--dangerously-bypass-approvals-and-sandbox"];

      case "allowAll":
        // Safe automation: auto-grant all but respect deny list (use --full-auto)
        return ["--full-auto"];

      case "custom":
        // Use Codex-specific sandbox and approval settings
        const sandbox = ConfigurationUtils.getCodexSandboxMode();
        const approval = ConfigurationUtils.getCodexApprovalPolicy();
        // Note: --add-dir is handled in buildCliArgs(), not here
        return ["-s", sandbox, "-a", approval];

      default:
        return ["--full-auto"];
    }
  }

  // ============================================================
  // CODEX-SPECIFIC: LOG FILE MONITORING
  // ============================================================

  /**
   * Get path to Codex TUI log file.
   * Location: %USERPROFILE%\.codex\log\codex-tui.log (Windows)
   *           ~/.codex/log/codex-tui.log (macOS/Linux)
   */
  private getCodexLogPath(): string {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) {
      throw new Error("Cannot determine home directory for Codex log path");
    }

    const path = require("path");
    return path.join(home, ".codex", "log", "codex-tui.log");
  }

  /**
   * Simple delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Monitor Codex log file for completion indicators.
   *
   * Completion Indicators:
   * - Success: "INFO run_task: close time.busy=..."
   * - Error: "Turn error:" or "stream disconnected" or "didn't complete gracefully"
   *
   * @param startTime Execution start time (for timeout calculation)
   * @param timeoutMs Maximum time to wait for completion
   * @returns Object with completed flag and optional error message
   */
  private async monitorLogFileForCompletion(
    startTime: Date,
    timeoutMs: number
  ): Promise<{ completed: boolean; error?: string }> {
    const fs = require("fs");
    const logPath = this.getCodexLogPath();

    // Get initial file size to track new entries
    let lastPosition = 0;
    try {
      const stats = await fs.promises.stat(logPath);
      lastPosition = stats.size;
      Log.debug(`📋 Starting log monitoring from position ${lastPosition}`);
    } catch (error) {
      Log.warn(
        `Codex log file not found at ${logPath}, starting from position 0`
      );
    }

    // Poll log file for completion indicators
    while (Date.now() - startTime.getTime() < timeoutMs) {
      try {
        const stats = await fs.promises.stat(logPath);

        // Only read new content since last check
        if (stats.size > lastPosition) {
          const stream = fs.createReadStream(logPath, {
            start: lastPosition,
            encoding: "utf8",
          });

          let newContent = "";
          for await (const chunk of stream) {
            newContent += chunk;
          }

          lastPosition = stats.size;
          Log.debug(`📋 Read ${newContent.length} new bytes from log file`);

          // Check for completion indicator: "run_task: close" marks end of turn
          if (/INFO\s+run_task:\s+close\s+time\.busy=/i.test(newContent)) {
            Log.info("✅ Codex completion detected from log file");
            return { completed: true };
          }

          // Check for error patterns
          const errorMatch = newContent.match(/Turn error:\s*({.*?})/);
          if (errorMatch) {
            Log.error(`❌ Codex error detected in log: ${errorMatch[1]}`);
            return {
              completed: false,
              error: `Turn error: ${errorMatch[1]}`,
            };
          }

          // Check for warning patterns that indicate failures
          if (/stream disconnected|didn't complete gracefully/i.test(newContent)) {
            const warningMatch = newContent.match(
              /(stream disconnected[^\n]*|didn't complete gracefully[^\n]*)/i
            );
            const warningMsg = warningMatch
              ? warningMatch[1]
              : "Codex CLI warning detected";
            Log.warn(`⚠️ Codex warning in log: ${warningMsg}`);
            return {
              completed: false,
              error: warningMsg,
            };
          }
        }
      } catch (error) {
        // Log file may not exist yet, continue polling
        Log.debug(`Log file polling error (may not exist yet): ${error}`);
      }

      // Poll every 500ms
      await this.delay(500);
    }

    // Timeout reached
    Log.warn(
      `⏱️ Timeout waiting for Codex completion indicator in log file`
    );
    return {
      completed: false,
      error: "Timeout waiting for completion indicator",
    };
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
    const tuiCommand = this.buildInteractiveTuiCommand(args);
    const displayCommand = `${this.getCliName()} [TUI mode] "<prompt>"`;

    Log.debug(`🎮 executeInTerminal called for Codex`);
    Log.debug(`🎮 tuiCommand: ${tuiCommand}`);
    Log.info(`📝 Prompt length: ${promptText.length} characters`);

    // Create fresh terminal
    const terminal = await this.createFreshTerminal();
    terminal.show();

    // Fire prompt ready event
    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: displayCommand,
    });

    this.streamingChunkEmitter.fire(
      "📺 Interactive TUI mode: Output is streaming to the VS Code terminal.\n" +
        "   View the terminal for real-time output.\n\n"
    );

    try {
      // Wait for shell integration
      const shellIntegration = await this.waitForShellIntegration(terminal);

      // Execute command
      const execution = shellIntegration.executeCommand(tuiCommand);
      this.currentExecution = execution;

      // Create temp file with instructional prompt
      let tempFilePath: string | undefined;

      try {
        const { tempFilePath: path, promptWithInstruction } =
          await this.createPromptFileWithReference(promptText, workflowContext);
        tempFilePath = path;

        this.lastSanitizedPrompt = promptText;

        // Create TUI processor with Codex-specific configuration
        const tuiConfig = {
          useTimeBasedExtraction: true,
          escapeIndicator: this.getEscapeIndicator(),
          screenEndPattern: this.getScreenEndPattern(),
          tuiChromePattern: this.getTuiChromePattern(),
          streamingEmitter: this.streamingChunkEmitter,
          responseCompleteEmitter: this.responseCompleteEmitter,
        };

        const tuiProcessor = new TuiStreamProcessor(tuiConfig);

        // Create abort controller to stop TUI processing when log detects completion
        const tuiAbortController = new AbortController();

        // Start log monitoring BEFORE sending prompt
        const startTime = new Date();

        // Process TUI stream (time-based extraction) with abort controller
        Log.info("⏳ Starting Codex TUI processing with log monitoring...");
        const tuiPromise = tuiProcessor.processStream(
          execution,
          terminal,
          promptWithInstruction,
          ConfigurationUtils.getCliExecutionTimeoutMs(),
          this.lastSanitizedPrompt,
          this.shouldShowOutput(),
          tuiAbortController
        );

        // Monitor log file for completion (authoritative source)
        const logPromise = this.monitorLogFileForCompletion(
          startTime,
          ConfigurationUtils.getCliExecutionTimeoutMs()
        );

        // Race the promises - log file wins
        const logResult = await Promise.race([
          logPromise,
          // If TUI completes first (error), return a failure result
          tuiPromise.then((tuiResult) => ({
            completed: tuiResult.success,
            error: tuiResult.errorMessage,
          })),
        ]);

        // Log file detected completion - abort TUI processing immediately
        if (logResult.completed) {
          Log.debug("🛑 Log file detected completion - aborting TUI stream");
          tuiAbortController.abort();
        }

        // Wait for TUI to finish cleaning up (should be fast after abort)
        const tuiResult = await tuiPromise;

        // Check results
        if (!logResult.completed) {
          this.lastFailureReason =
            logResult.error || "Completion detection failed";
          Log.error(`❌ Codex execution failed: ${this.lastFailureReason}`);
          return false;
        }

        // Check TUI result for any errors it may have caught
        if (!tuiResult.success && tuiResult.errorMessage) {
          this.lastFailureReason = tuiResult.errorMessage;
          Log.warn(
            `⚠️ TUI processor detected error: ${tuiResult.errorMessage}`
          );
          // Don't return false here - log file said success, trust it
        }

        Log.info("✅ Codex execution completed successfully");
        return true;
      } finally {
        // Clean up temp file if created
        if (tempFilePath) {
          const workspaceRoot = this.getWorkspaceRoot();
          if (workspaceRoot) {
            const tempMgr = new TempFileManager(workspaceRoot);
            await tempMgr.deleteFile(tempFilePath);
            Log.debug(`🗑️ Cleaned up temp file: ${tempFilePath}`);
          }
        }
      }
    } catch (error) {
      this.lastFailureReason =
        error instanceof Error ? error.message : String(error);
      Log.error(`❌ Codex execution error: ${this.lastFailureReason}`);
      return false;
    }
  }
}
