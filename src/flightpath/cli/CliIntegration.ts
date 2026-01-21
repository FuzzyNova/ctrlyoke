import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ChildProcess } from "child_process";
import { CliResult } from "../../types/CopilotTypes";
import {
  PromptItem,
  Provider,
  PromptFile,
  WorkflowContext,
} from "../../types/FlightPathTypes";
import { CopilotIntegration, CopilotStatus } from "../base/CopilotIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { TempFileManager } from "../../utils/TempFileManager";
import { CliProcessManager } from "../../utils/CliProcessManager";
import { FileSystemUtils } from "../../utils/FileSystemUtils";
import { Log } from "../../utils/Log";
import { ILogParser } from "./shared/interfaces/ILogParser";
import { ICliProvider } from "./shared/interfaces/ICliProvider";
import { PromptFileSplitter } from "../../utils/PromptFileSplitter";
import {
  ResolvedProperties,
  PropertyResolver,
} from "../../utils/PropertyResolver";
import { SessionResolver } from "../../utils/SessionResolver";
import { SessionValidator } from "../../utils/SessionValidator";
import type { PromptQueue } from "../PromptQueue";

/**
 * Execution mode for CLI integrations
 */
export type CliExecutionMode = "interactive" | "headless";

/**
 * Execution mode constants
 */
export const CLI_EXECUTION_MODE = {
  INTERACTIVE: "interactive" as const,
  HEADLESS: "headless" as const,
};

/**
 * Warning messages
 */
export const CLI_WARNING_MESSAGES = {
  HEADLESS_WITHOUT_PERMISSIONS:
    "Headless mode without full permissions: CLI will auto-deny tool/file access. Workflow may not make progress.",
} as const;

/**
 * Result of creating prompt file(s) with reference instruction
 */
interface PromptFileResult {
  /** Array of temp file paths (for cleanup) */
  tempFilePaths: string[];

  /** Instruction prompt that references all files */
  promptWithInstruction: string;
}

/**
 * Generic CLI integration class using composition.
 *
 * This class replaces the inheritance-based BaseCliIntegration with a composition-based
 * approach. Instead of extending a base class and implementing abstract methods, it accepts
 * an ICliProvider instance that encapsulates all provider-specific behavior.
 *
 * **Architecture Benefits:**
 * - Zero base class changes when adding new providers
 * - Provider isolation (all logic in provider's directory)
 * - Easy testing (test provider components independently)
 * - Clear separation of concerns (integration orchestration vs provider implementation)
 *
 * **Supports two execution modes:**
 * - **Interactive:** TUI in VS Code terminal with file-based prompt passing
 * - **Headless:** Background process with temp file reference and streaming output
 *
 * All prompts are pre-expanded (context references resolved) before sending to CLI.
 * Delegates to CliProcessManager for spawning/terminal/cancellation.
 * Delegates to provider for all CLI-specific behavior.
 *
 * @example
 * ```typescript
 * const provider = new CopilotCliProvider(context);
 * const integration = new CliIntegration(provider, context);
 * await integration.initialize();
 * await integration.sendPrompt(prompt);
 * ```
 */
export class CliIntegration extends CopilotIntegration {
  /** Provider instance that encapsulates all CLI-specific logic */
  private readonly provider: ICliProvider;

  /** Initialization status */
  protected initializationStatus: CopilotStatus = CopilotStatus.Initializing;

  /** Last CLI execution result */
  protected lastResult?: CliResult;

  /** Last CLI command executed (for debugging) */
  protected lastCliCommand?: string;

  /** Last full prompt text sent (for debugging) */
  protected lastFullPrompt?: string;

  /** Current background process (headless mode) */
  protected currentProcess?: ChildProcess;

  /** Process/terminal manager for CLI execution */
  protected processManager: CliProcessManager;

  // Interactive terminal mode properties
  protected currentExecution?: vscode.TerminalShellExecution;

  // Cached MCP config file path (generated once per session, reused for all prompts)
  private cachedMcpConfigPath?: string;

  /**
   * Create a new CLI integration with the specified provider.
   *
   * @param provider The CLI provider instance (encapsulates all CLI-specific logic)
   * @param context VS Code extension context
   */
  constructor(provider: ICliProvider, context: vscode.ExtensionContext) {
    super(context);
    this.provider = provider;
    this.processManager = new CliProcessManager(
      this.getWorkspaceRoot() || "",
      (msg) => Log.debug(msg)
    );
  }

  // ============================================================
  // CONFIGURATION & EXECUTION MODE
  // ============================================================

  /**
   * Get the configured execution mode (interactive or headless)
   */
  protected getExecutionMode(): CliExecutionMode {
    return ConfigurationUtils.getCliExecutionMode() as CliExecutionMode;
  }

  /**
   * Dispose the current terminal if it exists.
   * This does NOT clear the session ID - that's preserved for potential resume.
   *
   * Call this before starting a new CLI process in interactive mode to ensure
   * we get a fresh terminal. The old terminal output remains visible until
   * the user closes it or the new terminal opens.
   */
  protected disposeTerminalIfExists(): void {
    Log.debug("🗑️ Disposing existing terminal for fresh CLI session");
    this.processManager.disposeTerminal();
    this.currentExecution = undefined;
  }

  /**
   * Create a fresh VS Code terminal for interactive execution.
   * Always creates a new terminal, disposing any existing one first.
   */
  protected async createFreshTerminal(): Promise<vscode.Terminal> {
    this.disposeTerminalIfExists();
    return await this.processManager.createTerminal(
      `FlightPath: ${this.provider.config.displayName}`,
      this.getWorkspaceRoot()
    );
  }

  /**
   * Wait for shell integration to become available on a terminal
   * @param terminal The terminal to wait for
   * @param timeoutMs Maximum time to wait (default 5 seconds)
   */
  protected async waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number = 5000
  ): Promise<vscode.TerminalShellIntegration> {
    return await this.processManager.waitForShellIntegration(
      terminal,
      timeoutMs
    );
  }

  // ============================================================
  // ABSTRACT METHOD IMPLEMENTATIONS (DELEGATED TO PROVIDER)
  // ============================================================

  /**
   * Get the CLI-specific integration mode string (e.g., "copilot-cli", "claude-cli")
   */
  public getIntegrationMode(): string {
    return this.provider.config.name;
  }

  /**
   * Check if full permissions are granted (no interactive prompts will occur)
   * Used to warn users when running headless without full permissions
   */
  protected hasFullPermissions(): boolean {
    const config = {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.provider.toolPermissionMapper.hasFullPermissions(config);
  }

  /**
   * Parse token counts from statistics string
   * Delegates to provider's response parser
   */
  parseTokenCounts(
    statistics: string
  ): { prompt: number; completion: number } | undefined {
    return this.provider.responseParser.parseTokenCounts(statistics);
  }

  // ============================================================
  // MCP CONFIGURATION
  // ============================================================

  /**
   * Generate MCP config file (shared implementation for JSON-based CLIs).
   * Creates the file once and caches the path for reuse across all prompts.
   * The config content is static per session (server path and workspace root don't change).
   *
   * @param mcpServerPath Absolute path to the MCP server executable
   * @param workspaceRoot Absolute path to the workspace root
   * @returns Absolute path to the generated config file, or null if provider doesn't support MCP
   */
  protected async generateMcpConfigFile(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string | null> {
    // Check if provider supports MCP
    if (!this.provider.getMcpConfigArgs) {
      return null;
    }

    // Return cached path if already generated
    if (this.cachedMcpConfigPath) {
      return this.cachedMcpConfigPath;
    }

    // Delegate to provider to get MCP config args
    const args = await this.provider.getMcpConfigArgs(
      mcpServerPath,
      workspaceRoot
    );

    if (!args) {
      return null; // Provider doesn't support MCP
    }

    // For providers that use config files (not inline args), generate the file
    // This is determined by checking if the provider uses CliMcpConfigGenerator
    // For now, we'll cache the args as the config path (simplified)
    // In actual implementation, each provider would handle their own config format

    return null; // Placeholder - actual implementation would generate config file
  }

  /**
   * Generate MCP server configuration arguments for dynamic queue extension.
   * Returns CLI-specific arguments to pass MCP server config.
   *
   * Only called when:
   * 1. Dynamic queue is enabled (flightpath.enableDynamicQueue)
   * 2. Current prompt has allowDynamicExtension enabled
   *
   * @param mcpServerPath Absolute path to the MCP server executable
   * @param workspaceRoot Workspace root directory (for FLIGHTPATH_WORKSPACE env var)
   * @returns Array of arguments to append to CLI command, or null if not supported
   */
  protected async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    if (!this.provider.getMcpConfigArgs) {
      return null;
    }

    return await this.provider.getMcpConfigArgs(mcpServerPath, workspaceRoot);
  }

  // ============================================================
  // PROMPT FILE CREATION & MANAGEMENT
  // ============================================================

  /**
   * Check if a prompt is simple enough to pass directly without temp file.
   *
   * Simple prompts:
   * - Short length (≤300 characters)
   * - No dynamic queue XML instructions
   * - No complex formatting that would break shell escaping
   *
   * Benefits of direct passing:
   * - No file I/O overhead
   * - Faster response for quick queries
   * - Better UX for interactive commands
   *
   * @param finalPromptText The final prompt text (after instruction injection)
   * @returns true if prompt can be passed directly
   */
  protected isSimplePrompt(finalPromptText: string): boolean {
    const MAX_SIMPLE_PROMPT_LENGTH = 300;

    if (finalPromptText.length > MAX_SIMPLE_PROMPT_LENGTH) {
      return false;
    }

    if (finalPromptText.includes("<criticalInstruction>")) {
      return false;
    }

    if (finalPromptText.includes("`")) {
      return false;
    }

    return true;
  }

  /**
   * Create temp file(s) for the prompt and return file reference instruction.
   *
   * For large prompts (>20K tokens or >1800 lines), splits into multiple files
   * with decimal notation (e.g., prompt-1.1.md, prompt-1.2.md, prompt-1.3.md).
   *
   * Returns both temp file paths (for cleanup) and instruction prompt that
   * references all files.
   *
   * @param promptText The full prompt text to write
   * @param workflowContext Optional workflow context for meaningful filename
   * @returns Object with tempFilePaths array and promptWithInstruction
   */
  protected async createPromptFileWithReference(
    promptText: string,
    workflowContext?: WorkflowContext
  ): Promise<PromptFileResult> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace root available for temp file");
    }

    const tempMgr = new TempFileManager(workspaceRoot);

    // Check if splitting is needed
    const splitter = new PromptFileSplitter();
    const splitResult = splitter.split(promptText);

    if (!splitResult.needsSplit) {
      // Single file path (backward compatible)
      const tempFilePath = await tempMgr.createPromptFile(
        promptText,
        workflowContext?.filePath,
        workflowContext ? workflowContext.promptIndex + 1 : undefined
      );
      const relativeFilePath = tempMgr.getRelativePath(tempFilePath);
      const fileReference = this.provider.formatFileReference(relativeFilePath);
      const promptWithInstruction = `Follow instructions in ${fileReference} `;

      Log.info(`📁 Temp file created: ${relativeFilePath}`);
      Log.info(
        `📊 Prompt stats: ${splitResult.tokenCounts[0]} tokens, ${splitResult.lineCounts[0]} lines`
      );

      return {
        tempFilePaths: [tempFilePath],
        promptWithInstruction,
      };
    }

    // Multiple files needed
    const tempFilePaths = await tempMgr.createSplitPromptFiles(
      splitResult.chunks,
      workflowContext?.filePath,
      workflowContext ? workflowContext.promptIndex + 1 : undefined
    );

    // Build instruction referencing all files
    const fileReferences = tempFilePaths.map((fp) => {
      const relativePath = tempMgr.getRelativePath(fp);
      return this.provider.formatFileReference(relativePath);
    });

    // Format: "Follow instructions in @file1, @file2, and @file3 "
    const promptWithInstruction =
      this.formatMultipleFileReferences(fileReferences);

    // Log split statistics
    Log.info(`📁 Prompt split into ${splitResult.chunks.length} files:`);
    splitResult.chunks.forEach((_, idx) => {
      const relativePath = tempMgr.getRelativePath(tempFilePaths[idx]);
      Log.info(
        `   ${idx + 1}. ${relativePath} (${splitResult.tokenCounts[idx]} tokens, ${splitResult.lineCounts[idx]} lines)`
      );
    });

    return {
      tempFilePaths,
      promptWithInstruction,
    };
  }

  /**
   * Format multiple file references into instructional prompt
   * Uses natural language formatting: "file1, file2, and file3"
   *
   * @param fileRefs Array of file references (already formatted with @ prefix if needed)
   * @returns Instruction prompt with trailing space
   */
  private formatMultipleFileReferences(fileRefs: string[]): string {
    if (fileRefs.length === 1) {
      return `Follow instructions in ${fileRefs[0]} `;
    }

    if (fileRefs.length === 2) {
      return `Follow instructions in ${fileRefs[0]} and ${fileRefs[1]} `;
    }

    // 3+ files: "file1, file2, and file3"
    const allButLast = fileRefs.slice(0, -1).join(", ");
    const last = fileRefs[fileRefs.length - 1];
    return `Follow instructions in ${allButLast}, and ${last} `;
  }

  // ============================================================
  // INTERACTIVE TUI EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in interactive mode with log file monitoring.
   *
   * Strategy:
   * 1. Record start time BEFORE spawning CLI
   * 2. Spawn CLI in terminal (TUI displays for user, but we ignore it)
   * 3. Wait for session start and discover log file:
   *    - **Claude (SessionStart hook):** Wait up to 60 seconds for SessionStart hook,
   *      then use session ID to find log file directly
   *    - **Copilot/Codex (no hook):** Discover log file by matching prompt text
   * 4. Monitor log file for completion
   *
   * **Important:** 60-second timeout gives Claude CLI plenty of time to:
   * - Start the session
   * - Fire the SessionStart hook
   * - Create the log file
   *
   * @param args The CLI arguments (WITHOUT prompt, but WITH --resume if session should continue)
   * @param promptText The prompt text (will be sent via sendText)
   * @param workflowContext Optional workflow context for temp file naming
   * @param resolvedSessionId Resolved session ID (not used in log monitoring)
   * @returns Promise with success flag and optional sessionId
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string,
    workflowContext?: WorkflowContext,
    resolvedSessionId?: string
  ): Promise<{ success: boolean; sessionId?: string }> {
    try {
      // Check if provider has log parser capability
      if (!this.provider.logParser) {
        Log.error("❌ Provider does not support log file monitoring");
        return { success: false };
      }

      // 1. Record start time BEFORE spawning CLI
      const startTime = new Date();
      Log.info(`⏱️ Recording start time: ${startTime.toISOString()}`);

      // 2. Spawn CLI in terminal (TUI displays for user)
      const { terminal, execution, tempFilePaths } = await this.startCliProcess(
        args,
        promptText,
        workflowContext
      );

      // 3. Wait for SessionStart hook and discover log file
      let sessionId: string | null = null;
      let logPath: string | null = null;

      if (this.provider.notificationMonitor.waitForSessionStart) {
        // Provider supports SessionStart hook (Claude only currently)
        Log.info("🔍 Waiting for SessionStart hook and log file creation...");

        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
          Log.error("❌ No workspace root for session start monitoring");
          await this.cleanupTempFiles(tempFilePaths);
          return { success: false };
        }

        const notifyDir =
          this.provider.notificationMonitor.getNotificationDirectory(
            workspaceRoot
          );

        // Wait for SessionStart notification (60 second timeout)
        const startResult =
          await this.provider.notificationMonitor.waitForSessionStart(
            {
              directory: notifyDir,
              timeoutMs: 60000,
              pollMs: 100,
            },
            startTime,
            () => this.isCancelling
          );

        if (!startResult.completed) {
          Log.error(
            `❌ SessionStart hook timeout: ${startResult.error || "Unknown error"}`
          );
          this.lastFailureReason =
            startResult.error || "SessionStart hook timeout";
          await this.cleanupTempFiles(tempFilePaths);
          return { success: false };
        }

        // Extract session ID if provided (Claude provides it, Copilot doesn't)
        sessionId = startResult.data?.sessionId || null;

        if (sessionId) {
          Log.info(`✅ SessionStart hook provided session ID: ${sessionId}`);

          // Use session ID to find log file directly
          logPath = await this.provider.logParser.discoverSessionLog(
            promptText,
            startTime,
            sessionId
          );

          if (!logPath) {
            Log.error(
              `❌ Could not find log file for session ${sessionId} - this should not happen!`
            );
            this.lastFailureReason = "Log file not found after SessionStart";
            await this.cleanupTempFiles(tempFilePaths);
            return { success: false };
          }

          Log.info(`✅ Found session log: ${logPath}`);
        } else {
          // No session ID provided - fall back to prompt text matching
          Log.info(
            "✅ SessionStart hook confirmed (session ID not provided by CLI)"
          );
          Log.info(
            "🔍 Discovering session log file via prompt text matching..."
          );

          logPath = await this.provider.logParser.discoverSessionLog(
            promptText,
            startTime
          );

          if (!logPath) {
            Log.error(
              "❌ Could not discover session log - no matching prompt found"
            );
            this.lastFailureReason = "Session log not found";
            await this.cleanupTempFiles(tempFilePaths);
            return { success: false };
          }

          Log.info(`✅ Found session log: ${logPath}`);

          // Extract session ID from matched log
          const events = await this.provider.logParser.readNewLines(logPath);
          sessionId = this.provider.logParser.extractSessionId(events);

          if (sessionId) {
            Log.debug(`💾 Extracted session ID from log: ${sessionId}`);
          }
        }
      } else {
        // Provider doesn't support SessionStart hook - use old method (Copilot, Codex)
        Log.info("🔍 Discovering session log file (no SessionStart hook)...");
        logPath = await this.provider.logParser.discoverSessionLog(
          promptText,
          startTime
        );

        if (!logPath) {
          Log.error(
            "❌ Could not discover session log - no matching prompt found"
          );
          this.lastFailureReason = "Session log not found";
          await this.cleanupTempFiles(tempFilePaths);
          return { success: false };
        }

        Log.info(`✅ Found session log: ${logPath}`);

        // Extract session ID from matched log
        const events = await this.provider.logParser.readNewLines(logPath);
        sessionId = this.provider.logParser.extractSessionId(events);

        if (sessionId) {
          Log.debug(`💾 Extracted session ID from log: ${sessionId}`);
        }
      }

      // 4. Monitor log file for completion
      const result = await this.monitorLogFile(logPath, sessionId, startTime);

      // Clean up temp files
      await this.cleanupTempFiles(tempFilePaths);

      return result;
    } catch (error) {
      Log.error(`❌ Interactive execution error`, error);
      this.lastFailureReason =
        error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Start CLI process in terminal and return execution details.
   *
   * @param args CLI arguments
   * @param promptText Prompt text
   * @param workflowContext Optional workflow context
   * @returns Terminal, execution, and temp file paths for cleanup
   */
  private async startCliProcess(
    args: string[],
    promptText: string,
    workflowContext?: WorkflowContext
  ): Promise<{
    terminal: vscode.Terminal;
    execution: vscode.TerminalShellExecution;
    tempFilePaths: string[];
  }> {
    const tuiCommand = this.provider.buildInteractiveTuiCommand(
      args,
      promptText
    );
    const displayCommand = `${this.provider.config.name} [Interactive mode] "<prompt>"`;

    const terminal = await this.createFreshTerminal();
    terminal.show();

    this.promptReadyEmitter.fire({
      fullPrompt: promptText,
      cliCommand: displayCommand,
    });

    this.streamingChunkEmitter.fire(
      "📺 Interactive mode: Output is streaming to the VS Code terminal.\n" +
        "   View the terminal for real-time output.\n\n"
    );

    const shellIntegration = await this.waitForShellIntegration(terminal);
    const execution = shellIntegration.executeCommand(tuiCommand);
    this.currentExecution = execution;

    // For interactive mode, we no longer need temp files since prompt is in CLI args
    // However, we keep this structure for potential future use or MCP config files
    const tempFilePaths: string[] = [];

    return { terminal, execution, tempFilePaths };
  }

  /**
   * Monitor log file for completion using provider's log parser.
   *
   * For providers with notification monitors (Claude, Codex), monitors both:
   * - Log file for streaming content
   * - Notification file for completion signal
   *
   * For providers without notification monitors (Copilot), relies on log file completion detection.
   *
   * @param logPath Absolute path to log file
   * @param sessionId Session ID (if already extracted)
   * @param startTime Execution start time
   * @returns Promise with success flag and sessionId
   */
  private async monitorLogFile(
    logPath: string,
    sessionId: string | null,
    startTime: Date
  ): Promise<{ success: boolean; sessionId?: string }> {
    const parser = this.provider.logParser!;
    const events: any[] = [];
    const timeoutMs =
      ConfigurationUtils.getMaxPromptExecutionTimeMs() || 12 * 60 * 60 * 1000;

    return new Promise(async (resolve, reject) => {
      let completed = false;
      let completionCheckInterval: NodeJS.Timeout | undefined;

      // Completion handler - single source of truth
      const handleCompletion = (source: string) => {
        if (completed) {
          return; // Already completed
        }
        completed = true;

        Log.info(`✅ Completion detected via ${source}`);

        // Extract final response from accumulated events
        const response = parser.extractResponse(events);

        // Store the result
        const cliResult: CliResult = {
          success: true,
          response: response.text,
          statistics: this.formatStatistics(response.metadata),
          exitCode: 0,
          sessionId: response.metadata.sessionId || sessionId || undefined,
        };
        this.lastResult = cliResult;
        this.logResponse(cliResult.response, cliResult.statistics);

        // Cleanup
        watcher.close();
        if (completionCheckInterval) {
          clearInterval(completionCheckInterval);
        }
        this.responseCompleteEmitter.fire("Response complete");

        resolve({
          success: true,
          sessionId: cliResult.sessionId,
        });
      };

      // Start log file watcher for streaming content
      const watcher = parser.watchLogFile(
        logPath,
        (event) => {
          events.push(event);

          // Stream content to output window
          const content = this.extractContentFromEvent(event);
          if (content) {
            this.streamingChunkEmitter.fire(content);
          }

          // Check completion via log file (fallback for providers without notification monitor)
          if (parser.isComplete(event)) {
            handleCompletion("log file");
          }
        },
        startTime
      );

      // If provider has notification monitor, also monitor for Stop/completion hook
      if (this.provider.notificationMonitor && sessionId) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const notifyDir =
            this.provider.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );
          const notifyFile = path.join(notifyDir, `${sessionId}.json`);

          Log.debug(`🔔 Monitoring Stop hook notification: ${notifyFile}`);

          // Helper to check and cleanup notification file
          const checkNotificationFile = async (): Promise<boolean> => {
            const fsUtils = new FileSystemUtils();
            const notifyData = await fsUtils.readJsonFileAndDelete(notifyFile);
            if (notifyData?.status === "completed") {
              handleCompletion("Stop hook");
              return true;
            }
            return false;
          };

          // Check if notification file already exists (race condition: hook fired before we started monitoring)
          if (await checkNotificationFile()) {
            return; // Early exit - completion already handled
          }

          // Poll for completion notification (check every 100ms)
          completionCheckInterval = setInterval(async () => {
            await checkNotificationFile();
          }, 100);
        }
      }

      // Timeout handling
      const timeoutHandle = setTimeout(() => {
        Log.warn(`⚠️ Log monitoring timeout after ${timeoutMs}ms`);
        watcher.close();
        if (completionCheckInterval) {
          clearInterval(completionCheckInterval);
        }
        reject(new Error("Log monitoring timeout"));
      }, timeoutMs);

      // Cancel handling
      const checkCancellation = setInterval(() => {
        if (this.isCancelling) {
          Log.info("⏹️ Log monitoring cancelled by user");
          clearInterval(checkCancellation);
          clearTimeout(timeoutHandle);
          if (completionCheckInterval) {
            clearInterval(completionCheckInterval);
          }
          watcher.close();
          resolve({ success: false });
        }
      }, 100);
    });
  }

  /**
   * Extract text content from provider-specific log event.
   *
   * @param event Provider-specific log event
   * @returns Text content for streaming, or undefined if no content
   */
  private extractContentFromEvent(event: any): string | undefined {
    // Handle different provider event formats
    // Claude: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
    if (event.type === "assistant" && event.message?.content) {
      const textContent = event.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      return textContent || undefined;
    }

    // Copilot/Codex: { type: "text", content: "..." }
    if (event.type === "text" && event.content) {
      return event.content;
    }

    // Codex nested payload: { payload: { type: "text", text: "..." } }
    if (event.payload?.type === "text" && event.payload.text) {
      return event.payload.text;
    }

    return undefined;
  }

  /**
   * Format metadata into statistics string.
   *
   * @param metadata Provider-specific metadata
   * @returns Formatted statistics string
   */
  private formatStatistics(metadata: any): string {
    const parts: string[] = [];

    if (metadata.model) {
      parts.push(`Model: ${metadata.model}`);
    }

    if (metadata.usage) {
      const usage = metadata.usage;
      if (
        usage.input_tokens !== undefined &&
        usage.output_tokens !== undefined
      ) {
        parts.push(
          `Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`
        );
      }
    }

    return parts.join(" | ");
  }

  /**
   * Clean up temporary prompt files.
   *
   * @param tempFilePaths Array of temp file paths to delete
   */
  private async cleanupTempFiles(tempFilePaths: string[]): Promise<void> {
    if (tempFilePaths.length === 0) {
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const tempMgr = new TempFileManager(workspaceRoot);
    await tempMgr.deleteFiles(tempFilePaths);
    Log.debug(`🗑️ Cleaned up ${tempFilePaths.length} temp file(s)`);
  }

  // ============================================================
  // HEADLESS EXECUTION
  // ============================================================

  /**
   * Execute a CLI command in headless mode.
   *
   * Strategy for simple prompts (≤300 chars, no XML, no backticks):
   * 1. Pass prompt directly on command line (fast!)
   * 2. No file I/O overhead
   *
   * Strategy for complex prompts:
   * 1. Write fully-expanded prompt to temp file
   * 2. Spawn CLI process with @temp-file or --prompt @temp-file parameter
   * 3. Wait for process to complete
   * 4. Cleanup temp file
   *
   * @param args The CLI arguments (WITHOUT prompt)
   * @param promptText The prompt text (will be written to temp file or passed directly)
   * @param workflowContext Optional workflow context for temp file naming
   * @param executeCallback Callback for CLI-specific result handling
   * @returns Promise<boolean> indicating success
   */
  protected async executeHeadlessWithPromptFile(
    args: string[],
    promptText: string,
    workflowContext:
      | {
          promptIndex: number;
          allPrompts: PromptItem[];
          filePath?: string;
        }
      | undefined,
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => Promise<boolean>
  ): Promise<boolean> {
    let tempFilePaths: string[] = [];

    try {
      const useDirectPrompt = this.isSimplePrompt(promptText);
      let headlessArgs: string[];
      let displayCommand: string;

      if (useDirectPrompt) {
        // Simple prompt: pass directly on command line
        headlessArgs = this.provider.buildHeadlessArgsWithDirectPrompt(
          args,
          promptText
        );
        displayCommand = `${this.provider.config.name} ${headlessArgs.join(" ")}`;
        Log.info(`🚀 Starting headless mode with direct prompt (fast path)`);
        Log.info(`📝 Prompt length: ${promptText.length} characters`);
      } else {
        // Complex prompt: create temp file(s)
        const { tempFilePaths: paths, promptWithInstruction } =
          await this.createPromptFileWithReference(promptText, workflowContext);
        tempFilePaths = paths;
        headlessArgs = this.provider.buildHeadlessArgs(
          args,
          promptWithInstruction
        );
        displayCommand = `${this.provider.config.name} ${headlessArgs.join(" ")}`;
        Log.info(`🚀 Starting headless mode with ${paths.length} file(s)`);
        Log.info(`📝 Total prompt length: ${promptText.length} characters`);
      }

      this.lastCliCommand = displayCommand;

      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: displayCommand,
      });

      // Check if we should stream output in real-time
      const shouldStream = this.provider.config.shouldStreamHeadlessOutput;

      // Create streaming state map for provider's response parser
      const streamState = new Map<string, any>();

      // Spawn and execute
      const result = await this.spawnProcess(
        this.provider.config.name,
        headlessArgs,
        {
          timeout:
            ConfigurationUtils.getMaxPromptExecutionTimeMs() ||
            12 * 60 * 60 * 1000,
          onStdout: shouldStream
            ? (chunk) => {
                // Delegate to provider's response parser for streaming
                if (this.provider.responseParser.processStreamingChunk) {
                  const processedChunk =
                    this.provider.responseParser.processStreamingChunk(
                      chunk,
                      streamState
                    );
                  if (processedChunk !== undefined) {
                    this.streamingChunkEmitter.fire(processedChunk);
                  }
                } else {
                  // No streaming processor, emit raw chunk
                  this.streamingChunkEmitter.fire(chunk);
                }
              }
            : undefined,
        }
      );

      // Check for cancellation
      if (this.isCancelling) {
        Log.info("⏹️ Prompt execution cancelled by user");
        return false;
      }

      // Delegate result handling to callback
      return await executeCallback(result);
    } catch (error) {
      Log.error(`❌ Headless execution error`, error);
      return false;
    } finally {
      // Cleanup temp file(s) (if used)
      if (tempFilePaths.length > 0) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const tempMgr = new TempFileManager(workspaceRoot);
          await tempMgr.deleteFiles(tempFilePaths);
          Log.debug(`🗑️ Cleaned up ${tempFilePaths.length} temp file(s)`);
        }
      }
    }
  }

  /**
   * Spawn a child process for headless CLI execution.
   *
   * @param command The command to run
   * @param args Command arguments (including prompt file reference)
   * @param options Timeout and streaming options
   */
  protected async spawnProcess(
    command: string,
    args: string[],
    options: {
      timeout?: number;
      onStdout?: (chunk: string) => void;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.processManager.spawn(command, args, {
      cwd: this.getWorkspaceRoot() || "",
      timeout: options.timeout,
      onStdout: options.onStdout,
    });

    // Emit response complete so dashboard knows process actually stopped
    if (result.exitCode === 0) {
      this.responseCompleteEmitter.fire("Process exited");
    }

    return result;
  }

  /**
   * Spawn a simple command (like --version checks) without stdin.
   * Uses shell: true for PATH resolution.
   */
  protected async spawnSimpleCommand(
    command: string,
    args: string[],
    timeoutMs: number = 5000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await this.processManager.spawnSimple(command, args, timeoutMs);
  }

  // ============================================================
  // OUTPUT LOGGING
  // ============================================================

  /**
   * Check if output should be shown in Output panel
   */
  protected shouldShowOutput(): boolean {
    return ConfigurationUtils.shouldShowCliOutput();
  }

  /**
   * Log prompt to output channel with formatting
   */
  protected logPrompt(promptText: string): void {
    if (this.shouldShowOutput()) {
      Log.appendLine("");
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine(`[PROMPT] ${new Date().toLocaleTimeString()}`);
      Log.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      Log.appendLine(promptText);
      Log.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      Log.appendLine("");
    }
  }

  /**
   * Log response to output channel with formatting
   */
  protected logResponse(response: string, statistics?: string): void {
    if (this.shouldShowOutput()) {
      Log.appendLine(`[RESPONSE] ${new Date().toLocaleTimeString()}`);
      Log.appendLine(
        "───────────────────────────────────────────────────────────"
      );
      Log.appendLine(response);
      if (statistics) {
        Log.appendLine("");
        Log.appendLine("[STATISTICS]");
        Log.appendLine(statistics);
      }
      Log.appendLine(
        "═══════════════════════════════════════════════════════════"
      );
      Log.appendLine("");
    }
  }

  // ============================================================
  // WORKSPACE HELPERS
  // ============================================================

  /**
   * Get workspace directories for --add-dir flag
   */
  protected getWorkspaceDirs(): string[] {
    const configured = ConfigurationUtils.getCliAllowedDirs();
    const workspaceDirs =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
    return [...workspaceDirs, ...configured];
  }

  // ============================================================
  // RESULT ACCESSORS
  // ============================================================

  /**
   * Get the last CLI result
   */
  getLastResult(): CliResult | undefined {
    return this.lastResult;
  }

  /**
   * Get the last CLI command executed
   */
  getLastCliCommand(): string | undefined {
    return this.lastCliCommand;
  }

  /**
   * Get the full prompt text sent to CLI
   */
  getLastFullPrompt(): string | undefined {
    return this.lastFullPrompt;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize CLI by checking availability via provider.checkAvailability().
   */
  async initialize(): Promise<void> {
    this.initializationStatus = CopilotStatus.Initializing;
    this.statusChangeEmitter.fire(CopilotStatus.Initializing);

    try {
      const available = await this.provider.checkAvailability();

      if (available) {
        // Get version if provider supports it
        let versionInfo = "";
        if (this.provider.getVersion) {
          const version = await this.provider.getVersion();
          versionInfo = version ? `: ${version}` : "";
        }

        Log.info(
          `✅ ${this.provider.config.displayName} available${versionInfo}`
        );
        this.isAvailable = true;
        this.initializationStatus = CopilotStatus.Ready;
        this.statusChangeEmitter.fire(CopilotStatus.Ready);
      } else {
        this.handleInitializationError("command_failed", "CLI not available");
      }
    } catch (error) {
      this.handleInitializationError("exception", error);
    }
  }

  /**
   * Handle initialization errors with logging.
   */
  protected handleInitializationError(
    type: "command_failed" | "exception",
    error: unknown
  ): void {
    this.isAvailable = false;
    this.initializationStatus = CopilotStatus.Unavailable;
    this.statusChangeEmitter.fire(CopilotStatus.Unavailable);

    Log.error(`❌ ${this.provider.config.displayName} not available`, error);
  }

  /**
   * Show warning when running in headless mode without full permissions
   */
  protected warnIfHeadlessWithoutPermissions(): void {
    const mode = this.getExecutionMode();
    if (mode === CLI_EXECUTION_MODE.HEADLESS && !this.hasFullPermissions()) {
      vscode.window.showWarningMessage(
        CLI_WARNING_MESSAGES.HEADLESS_WITHOUT_PERMISSIONS
      );
    }
  }

  // ============================================================
  // STATUS & AVAILABILITY
  // ============================================================

  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  isReady(): boolean {
    return this.initializationStatus === CopilotStatus.Ready;
  }

  getInitializationStatus(): CopilotStatus {
    return this.initializationStatus;
  }

  isCli(): boolean {
    return true;
  }

  /**
   * Get integration status.
   */
  getStatus(): { available: boolean; message: string; strategy: string } {
    if (this.isAvailable) {
      return {
        available: true,
        message: `✅ ${this.provider.config.displayName} available`,
        strategy: this.getIntegrationMode(),
      };
    } else {
      return {
        available: false,
        message: `❌ ${this.provider.config.displayName} unavailable - ${this.provider.config.installHint}`,
        strategy: this.getIntegrationMode(),
      };
    }
  }

  // ============================================================
  // CANCELLATION & DISPOSAL
  // ============================================================

  /**
   * Cancel the current CLI process
   */
  protected async cancelImplementation(): Promise<void> {
    // Delegate to CliProcessManager for both terminal and process cancellation
    await this.processManager.cancel(this.currentExecution);
    this.currentExecution = undefined;

    // Fire responseComplete so FlightPathManager can call confirmedStopped()
    this.responseCompleteEmitter.fire("Execution cancelled");
    Log.info("✅ Execution cancelled");
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.processManager.dispose();
    this.currentExecution = undefined;
  }

  // ============================================================
  // PROMPT SENDING (MAIN ENTRY POINT)
  // ============================================================

  /**
   * Send a prompt to the CLI.
   *
   * This is the main entry point for executing prompts. It:
   * 1. Builds the prompt with optional dynamic queue instructions
   * 2. Builds CLI arguments (tool permissions, MCP config, session resumption, etc.)
   * 3. Executes in interactive TUI or headless mode based on configuration
   * 4. Parses the response and extracts session ID for continuity
   *
   * @param prompt The prompt item to send
   * @param needsCompletionDetection If true, set up completion detection (default: true)
   * @param workflowContext Optional workflow context for dynamic queue and temp file naming
   * @returns True if prompt was sent successfully
   */
  async sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection: boolean = true,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workflowFile?: PromptFile;
      promptQueue?: PromptQueue;
    }
  ): Promise<boolean> {
    try {
      this.resetCancellationFlag();

      // Resolve session ID for current prompt using SessionResolver
      let resolvedSessionId = SessionResolver.resolve(
        prompt,
        workflowContext?.promptIndex ?? 0,
        workflowContext?.allPrompts ?? [prompt],
        workflowContext?.workflowFile
      );

      // Resolve execution properties (provider, model, agent)
      const resolvedProperties = workflowContext?.workflowFile
        ? PropertyResolver.resolve(prompt, workflowContext.workflowFile)
        : workflowContext?.resolvedProperties;

      // Validate session ID format before passing to CLI (Phase 5)
      if (resolvedSessionId) {
        const provider =
          resolvedProperties?.provider ??
          (this.getIntegrationMode() as Provider);
        if (!SessionValidator.validate(resolvedSessionId, provider)) {
          // Invalid format - start new session instead
          Log.info(`🔄 Starting new session due to invalid session ID format`);
          resolvedSessionId = undefined;
        }
      }

      // Build prompt with optional dynamic queue instructions
      const finalPromptText = await this.buildPromptWithInstructions(
        prompt,
        workflowContext?.promptIndex ?? 0,
        workflowContext?.allPrompts ?? [prompt],
        workflowContext?.filePath,
        resolvedProperties?.allowDynamicExtension
      );

      this.lastFullPrompt = finalPromptText;

      // Log prompt
      this.logPrompt(finalPromptText);

      // Determine execution mode first
      const mode = this.getExecutionMode();
      const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;

      // Build CLI arguments - delegated to provider for complete control
      const workspaceRoot = this.getWorkspaceRoot();
      const baseArgs = await this.provider.buildCliArgs(
        prompt,
        isInteractive,
        this.context,
        workspaceRoot,
        resolvedSessionId, // Use resolved session instead of this.sessionId
        workflowContext
      );

      // Execute based on mode
      let success = false;
      let extractedSessionId: string | undefined;

      if (mode === CLI_EXECUTION_MODE.INTERACTIVE) {
        const result = await this.executeInTerminal(
          baseArgs,
          finalPromptText,
          workflowContext,
          resolvedSessionId
        );
        success = result.success;
        extractedSessionId = result.sessionId;

        // Fallback: Extract session ID from logs if not available from notification
        // Note: For Copilot CLI, this is currently the ONLY working method since hooks
        // don't provide session IDs yet. For Claude/Codex, this is a true fallback.
        if (
          success &&
          !extractedSessionId &&
          this.provider.extractSessionIdFromLogs
        ) {
          const logSessionId = await this.provider.extractSessionIdFromLogs();
          if (logSessionId) {
            extractedSessionId = logSessionId;
            Log.debug(
              `📝 Session ID from logs (interactive): ${extractedSessionId}`
            );
          }
        }
      } else {
        // Headless mode
        this.warnIfHeadlessWithoutPermissions();

        // Claude CLI error recovery wrapper (Phase 5)
        const executeWithRecovery = async (
          args: string[],
          promptText: string
        ): Promise<boolean> => {
          try {
            return await this.executeHeadlessWithPromptFile(
              args,
              promptText,
              workflowContext,
              async (result) => {
                // Parse result using provider's response parser
                const parsed = this.provider.responseParser.parse(
                  result.stdout,
                  result.stderr,
                  result.exitCode
                );

                // Extract session ID if available from output or logs
                if (parsed.sessionId) {
                  extractedSessionId = parsed.sessionId;
                  Log.debug(`📝 Session ID from output: ${extractedSessionId}`);
                } else if (this.provider.extractSessionIdFromLogs) {
                  // For CLIs that store session ID in log files (e.g., Copilot)
                  const logSessionId =
                    await this.provider.extractSessionIdFromLogs();
                  if (logSessionId) {
                    extractedSessionId = logSessionId;
                    Log.debug(`📝 Session ID from logs: ${extractedSessionId}`);
                  }
                }

                // Store result
                this.lastResult = parsed;

                // Log response
                this.logResponse(parsed.response, parsed.statistics);

                // Fire response complete event
                this.responseCompleteEmitter.fire(parsed.response);

                return parsed.exitCode === 0;
              }
            );
          } catch (error) {
            // Check for recoverable session errors using provider's response parser (Phase 5)
            if (
              this.provider.responseParser.isRecoverableSessionError?.(error)
            ) {
              const currentProvider =
                resolvedProperties?.provider ??
                (this.getIntegrationMode() as Provider);

              if (currentProvider === Provider.ClaudeCli) {
                Log.warn(
                  `⚠️ Claude CLI rejected session ID "${resolvedSessionId}". ` +
                    `Retrying without resume flag.`
                );

                // Rebuild args without session ID
                const argsWithoutResume = await this.provider.buildCliArgs(
                  prompt,
                  false, // headless mode
                  this.context,
                  this.getWorkspaceRoot() || "",
                  undefined, // no session ID - start new session
                  workflowContext
                );

                // Retry with new args
                return await this.executeHeadlessWithPromptFile(
                  argsWithoutResume,
                  promptText,
                  workflowContext,
                  async (result) => {
                    const parsed = this.provider.responseParser.parse(
                      result.stdout,
                      result.stderr,
                      result.exitCode
                    );

                    if (parsed.sessionId) {
                      extractedSessionId = parsed.sessionId;
                      Log.debug(
                        `📝 New session ID from retry: ${extractedSessionId}`
                      );
                    }

                    this.lastResult = parsed;
                    this.logResponse(parsed.response, parsed.statistics);
                    this.responseCompleteEmitter.fire(parsed.response);

                    return parsed.exitCode === 0;
                  }
                );
              }
            }
            // Re-throw if not a recoverable error
            throw error;
          }
        };

        success = await executeWithRecovery(baseArgs, finalPromptText);
      }

      // Store runtime metadata in prompt's _runtime (always on success, session ID optional)
      if (success) {
        if (!prompt._runtime) {
          prompt._runtime = {
            provider:
              resolvedProperties?.provider ??
              (this.getIntegrationMode() as Provider),
            model: resolvedProperties?.model ?? "",
            agent: resolvedProperties?.agent,
            startedAt: Date.now(),
          };
        }

        // Add session ID if available (may be undefined for first prompt or if extraction failed)
        if (extractedSessionId) {
          prompt._runtime.sessionId = extractedSessionId;
        }

        prompt._runtime.completedAt = Date.now();

        // Persist runtime metadata to working file
        if (workflowContext?.promptQueue) {
          await workflowContext.promptQueue.updateWorkingFile();
          Log.debug(
            `💾 Saved runtime metadata to working file (sessionId: ${extractedSessionId || "none"})`
          );
        }
      }

      return success;
    } catch (error) {
      Log.error("❌ Error sending prompt", error);
      this.lastFailureReason =
        error instanceof Error ? error.message : "Unknown error";
      return false;
    }
  }

  // ============================================================
  // ERROR RECOVERY (PHASE 5)
  // ============================================================
  // NOTE: Error recovery logic is now provider-specific.
  // See IResponseParser.isRecoverableSessionError() for implementation.
}
