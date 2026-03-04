import type * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import { CliResult } from "../../types/CliOutputTypes";
import {
  PromptItem,
  Harness,
  PromptFile,
  WorkflowContext,
} from "../../types/FlightPathTypes";
import { UniversalCliOutput } from "../../types/CliOutputTypes";
import { HarnessIntegration, HarnessStatus } from "../HarnessIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { CliProcessManager } from "../../utils/CliProcessManager";
import { Log } from "../../utils/Log";
import { ICliProvider } from "./shared/interfaces/ICliProvider";
import { CliOutputFormatter } from "./shared/CliOutputFormatter";
import { CliLogMonitor } from "./CliLogMonitor";
import {
  ResolvedProperties,
  PropertyResolver,
} from "../../utils/PropertyResolver";
import { SessionResolver } from "../../utils/SessionResolver";
import { SessionValidator } from "../../utils/SessionValidator";
import type { PromptQueue } from "../PromptQueue";

/** Timeout (ms) for waiting for SessionStart hook from CLI harness */
const SESSION_START_TIMEOUT_MS = 60_000;
/** Polling interval (ms) when waiting for SessionStart hook */
const SESSION_START_POLL_MS = 100;
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
 * an ICliProvider instance that encapsulates all harness-specific behavior.
 *
 * **Architecture Benefits:**
 * - Zero base class changes when adding new harnesses
 * - Harness isolation (all logic in harness's directory)
 * - Easy testing (test harness components independently)
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
export class CliIntegration extends HarnessIntegration {
  /** Provider instance that encapsulates all CLI-specific logic */
  private readonly provider: ICliProvider;

  /** Platform adapter (VS Code or standalone CLI) */
  private readonly platform: PlatformAdapter;

  /** Delegates rawTextOutput from provider config (used by WorkflowExecutor for streaming CliOutput) */
  override get rawTextOutput(): boolean {
    return this.provider.config.rawTextOutput ?? false;
  }

  /** Initialization status */
  protected initializationStatus: HarnessStatus = HarnessStatus.Initializing;

  /** Last CLI execution result */
  protected lastResult?: CliResult;

  /** Last parsed output with structured data (tool calls, thinking blocks, etc.) */
  protected lastParsedOutput?: UniversalCliOutput;

  /** Last CLI command executed (for debugging) */
  protected lastCliCommand?: string;

  /** Last full prompt text sent (for debugging) */
  protected lastFullPrompt?: string;

  /** Actual prompt text sent to CLI (may be file reference if using temp files) */
  protected actualPromptSent?: string;

  // NOTE: currentProcess field removed — the child process lives in processManager,
  // not on this class. See processManager.isActive() for process state.

  /** Process/terminal manager for CLI execution */
  protected processManager: CliProcessManager;

  // Interactive terminal mode properties
  protected currentExecution?: vscode.TerminalShellExecution;

  /** Workflow display name used for VS Code terminal tab naming */
  private workflowName?: string;

  /** Current prompt index (1-based) and total, for terminal tab naming */
  private currentPromptNumber?: number;
  private currentPromptTotal?: number;

  /**
   * Create a new CLI integration with the specified CLI provider.
   *
   * @param cliProvider The CLI provider instance (encapsulates all CLI-specific logic)
   * @param platform Platform adapter (VS Code or standalone CLI)
   */
  constructor(
    cliProvider: ICliProvider,
    platform: PlatformAdapter,
    registerWithContext: boolean = true
  ) {
    // Pass ExtensionContext to base class if available (VS Code context) for subscription management
    const vsCtx =
      "getExtensionContext" in platform
        ? (platform as VsCodeAdapter).getExtensionContext()
        : undefined;
    super(vsCtx, registerWithContext);
    this.platform = platform;
    this.provider = cliProvider;
    this.processManager = new CliProcessManager(
      this.getWorkspaceRoot() || "",
      (msg) => Log.debug(msg)
    );
    // Propagate workspace root to the log parser for session log discovery.
    // For example, ClaudeLogParser uses this to locate ~/.claude/projects/<workspace>.
    const workspaceRoot = this.getWorkspaceRoot();
    if (
      workspaceRoot &&
      this.provider.logParser &&
      "setWorkspaceRoot" in this.provider.logParser
    ) {
      (
        this.provider.logParser as { setWorkspaceRoot(r: string): void }
      ).setWorkspaceRoot(workspaceRoot);
    }
  }

  // ============================================================
  // CONFIGURATION & EXECUTION MODE
  // ============================================================

  /**
   * Get the configured execution mode (interactive or headless).
   *
   * Uses the platform adapter rather than ConfigurationUtils so that
   * the standalone CLI (CliAdapter) always gets "headless" — the shim
   * would otherwise return the vscode-shim default ("interactive") which
   * would trigger createTerminal() and throw at runtime.
   */
  protected getExecutionMode(): CliExecutionMode {
    return this.platform.getConfig<string>(
      "cliExecutionMode",
      "interactive"
    ) as CliExecutionMode;
  }

  /**
   * Override base class getWorkspaceRoot() to use the platform adapter.
   * The platform adapter knows the true workspace root in both VS Code and CLI contexts.
   */
  protected override getWorkspaceRoot(): string | undefined {
    return this.platform.getWorkspaceRoot() || undefined;
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
    const hasTerminal = !!this.processManager.getTerminal();
    if (hasTerminal) {
      Log.info(`🗑️ Closing previous terminal before starting next prompt (was: "${this.buildTerminalName()}")`);
    } else {
      Log.debug("🗑️ disposeTerminalIfExists: no terminal open, nothing to close");
    }
    this.processManager.disposeTerminal();
    this.currentExecution = undefined;
  }

  /**
   * Set the workflow name used for VS Code terminal tab labeling.
   * Call this whenever a new workflow is loaded or renamed.
   */
  setWorkflowName(name: string | undefined): void {
    this.workflowName = name;
  }

  /**
   * Build the VS Code terminal tab name.
   *
   * Format: "FP: {Harness}" when no workflow is loaded,
   *         "FP: {Harness} · {name} [{n}/{total}]" when a workflow is active.
   *
   * Workflow name is capped at 25 characters; VS Code handles tab-level
   * truncation naturally when many terminals are open.
   */
  private buildTerminalName(): string {
    const base = `FP: ${this.provider.config.terminalName}`;
    if (!this.workflowName) {
      return base;
    }
    const cleaned = this.workflowName.trim();
    const short = cleaned.length > 25 ? `${cleaned.slice(0, 24)}…` : cleaned;
    const promptSuffix =
      this.currentPromptNumber !== undefined && this.currentPromptTotal !== undefined
        ? ` [${this.currentPromptNumber}/${this.currentPromptTotal}]`
        : "";
    return `${base} · ${short}${promptSuffix}`;
  }

  /**
   * Create a fresh VS Code terminal for interactive execution.
   * Always creates a new terminal, disposing any existing one first.
   */
  protected async createFreshTerminal(): Promise<vscode.Terminal> {
    this.disposeTerminalIfExists();
    return await this.processManager.createTerminal(
      this.buildTerminalName(),
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
  // PROMPT FILE CREATION & MANAGEMENT
  // ============================================================

  /**
   * Check if a prompt is simple enough to pass directly without temp file.
   *
   * Simple prompts must be:
   * - Short length (≤300 characters)
   * - No dynamic queue XML instructions
   * - No shell-dangerous characters (quotes, backslashes, newlines, metacharacters, etc.)
   *
   * **Security-critical:** We're conservative here because the prompt gets embedded
   * directly in the shell command line. Even with escaping, complex prompts could
   * break parsing or introduce security issues.
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

    // Check length
    if (finalPromptText.length > MAX_SIMPLE_PROMPT_LENGTH) {
      return false;
    }

    // Check for XML instructions (dynamic queue)
    if (finalPromptText.includes("<criticalInstruction>")) {
      return false;
    }

    // Check for shell-dangerous characters
    // We only allow: letters, numbers, spaces, and basic safe punctuation
    // This regex matches SAFE characters; if anything else exists, use file-based passing
    const SAFE_CHARS_PATTERN = /^[a-zA-Z0-9\s.,!?:;\-_()@#/]*$/;
    if (!SAFE_CHARS_PATTERN.test(finalPromptText)) {
      Log.debug(
        "📁 Prompt contains special characters, using file-based passing for safety"
      );
      return false;
    }

    // Check for control characters and newlines
    if (/[\n\r\t]/.test(finalPromptText)) {
      Log.debug("📁 Prompt contains newlines/tabs, using file-based passing");
      return false;
    }

    // SAFE_CHARS_PATTERN above already excludes all dangerous chars (", ', \, `, $)
    // No additional per-character checks needed.
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
    const { tempFilePaths, relativePaths } = await this.createTempPromptFiles(
      promptText,
      workflowContext?.filePath,
      workflowContext ? workflowContext.promptIndex + 1 : undefined
    );

    // Format references per provider convention (e.g., @file for Copilot, -f file for Codex)
    const fileReferences = relativePaths.map((rp) =>
      this.provider.formatFileReference(rp)
    );

    return {
      tempFilePaths,
      promptWithInstruction: this.formatMultipleFileReferences(fileReferences),
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
   * Discover the session log file and extract session ID.
   *
   * Consolidates the common pattern used in all 3 session discovery paths:
   * resumed session, SessionStart hook, and fallback prompt matching.
   *
   * @param promptText The prompt text (for log discovery via matching)
   * @param startTime Execution start time
   * @param sessionId Known session ID (from resumption or hook), or null for prompt matching
   * @param errorContext Human-readable failure reason set on `this.lastFailureReason`
   * @returns Log path and session ID, or null if log file not found
   */
  private async discoverAndExtractSession(
    promptText: string,
    startTime: Date,
    sessionId: string | null,
    errorContext: string
  ): Promise<{ logPath: string; sessionId: string | null } | null> {
    const promptForDiscovery = this.actualPromptSent || promptText;

    const logPath = await this.provider.logParser!.discoverSessionLog(
      promptForDiscovery,
      startTime,
      sessionId || undefined
    );

    if (!logPath) {
      this.lastFailureReason = errorContext;
      return null;
    }

    // If no session ID was provided, try to extract it from the log events
    if (!sessionId) {
      const events = await this.provider.logParser!.readNewLines(logPath);
      const extractedId = this.provider.logParser!.extractSessionId(events);
      if (extractedId) {
        Log.debug(`💾 Extracted session ID from log: ${extractedId}`);
      }
      return { logPath, sessionId: extractedId };
    }

    return { logPath, sessionId };
  }

  /**
   * Returns true when running inside a VS Code extension context.
   *
   * Uses the presence of `getExtensionContext` on the platform adapter as a
   * lightweight discriminator — only VsCodeAdapter exposes that method.
   * CliAdapter does not, so `"getExtensionContext" in this.platform` is false.
   *
   * This lets CliIntegration choose between:
   *  - VS Code interactive path: createTerminal() + shell integration
   *  - CLI interactive path: spawn() with stdio:'inherit'
   */
  private isVsCodeContext(): boolean {
    return "getExtensionContext" in this.platform;
  }

  // ============================================================
  // CLI INTERACTIVE EXECUTION (spawn with stdio:inherit)
  // ============================================================

  /**
   * Execute a CLI command in interactive mode for the standalone CLI binary.
   *
   * Unlike the VS Code interactive path (which runs the AI CLI inside a
   * vscode.Terminal), this path spawns the AI CLI as a child process with
   * `stdio: 'inherit'` so the user's terminal is wired directly to the AI
   * CLI's stdin/stdout/stderr.
   *
   * The user ends the session manually (Ctrl+D, /exit, etc.). When the child
   * process exits, this method returns and the next prompt starts.
   *
   * No output is captured (no CliEvent[], no session ID extraction from logs).
   *
   * @param args Base CLI args (from buildCliArgs with isInteractive=true)
   * @param promptText Prompt text (written to temp file for safe passing)
   * @param workflowContext Optional workflow context for temp file naming
   * @param resolvedSessionId Resolved session ID (preserved across prompts)
   * @returns success flag and the original sessionId (no new ID extracted)
   */
  private async executeInteractiveCliProcess(
    args: string[],
    promptText: string,
    workflowContext: WorkflowContext | undefined,
    resolvedSessionId: string | undefined
  ): Promise<{ success: boolean; sessionId?: string }> {
    let tempFilePaths: string[] = [];

    try {
      // Print a separator for multi-prompt workflows so users see the boundary
      if (workflowContext && workflowContext.promptIndex > 0) {
        console.log(`\n${"─".repeat(52)}`);
        console.log(
          `Prompt ${workflowContext.promptIndex + 1} / ${workflowContext.allPrompts.length}`
        );
        console.log();
      }

      // Use temp file for prompt passing (same security policy as VS Code path)
      const { tempFilePaths: paths, promptWithInstruction } =
        await this.createPromptFileWithReference(promptText, workflowContext);
      tempFilePaths = paths;
      this.actualPromptSent = promptWithInstruction;

      // Build the interactive TUI command string
      const tuiCommand = this.provider.buildInteractiveTuiCommand(
        args,
        promptWithInstruction
      );
      const commandStr = String(tuiCommand).replace(/\s+/g, " ").trim();
      this.lastCliCommand = commandStr;

      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: commandStr,
      });

      // Record start time before spawning so we can filter stale notification files
      const startTime = new Date();

      // Spawn with stdio:'inherit' — the user sees the AI CLI TUI directly.
      const workingDir = this.getWorkspaceRoot() || process.cwd();
      const interactiveEnv = this.provider.getInteractiveSpawnEnv?.();
      let processExited = false;
      const spawnPromise = this.processManager
        .spawnInteractive(commandStr, workingDir, interactiveEnv)
        .finally(() => {
          processExited = true;
        });

      // When the harness supports hook-based completion detection, monitor for the
      // stop notification in parallel. When it fires, kill the process so the
      // workflow automatically advances to the next prompt without user interaction.
      const workspaceRoot = this.getWorkspaceRoot();
      let hookSessionId: string | undefined;

      if (
        workspaceRoot &&
        this.provider.config.usesInteractiveNotificationMonitor
      ) {
        const notifyDir =
          this.provider.notificationMonitor.getNotificationDirectory(
            workspaceRoot
          );
        const timeoutMs =
          ConfigurationUtils.getMaxPromptExecutionTimeMs() ?? 3_600_000;

        const monitorPromise = this.provider.notificationMonitor
          .monitorForCompletion(
            { directory: notifyDir, timeoutMs },
            resolvedSessionId, // wildcard mode when undefined (new session)
            startTime,
            () => this.isCancelling || processExited
          )
          .then((result) => {
            if (result.completed && !processExited) {
              hookSessionId =
                this.provider.notificationMonitor.extractSessionId?.(
                  result.data
                );
              // Completion hook fired — terminate the TUI so the next prompt can start.
              // Terminal scrollback remains visible to the user.
              Log.info(
                `✅ Stop hook detected — terminating interactive session` +
                  (hookSessionId ? ` (session: ${hookSessionId})` : "")
              );
              this.processManager.disposeProcess();
            }
          });

        await Promise.all([spawnPromise, monitorPromise]);
      } else {
        // No hook monitoring — wait for the user to exit manually (Ctrl+D, /exit, etc.)
        await spawnPromise;
      }

      // Session ended. Fire responseComplete so WorkflowExecutor can advance to the next prompt.
      this.responseCompleteEmitter.fire("Interactive session ended");

      return { success: true, sessionId: hookSessionId ?? resolvedSessionId };
    } catch (error) {
      Log.error("❌ CLI interactive execution error", error);
      this.lastFailureReason =
        error instanceof Error ? error.message : String(error);
      return { success: false };
    } finally {
      await this.cleanupTempFiles(tempFilePaths);
    }
  }

  /**
   * Execute a CLI command in interactive mode with log file monitoring.
   *
   * Strategy:
   * 1. Record start time BEFORE spawning CLI
   * 2. Spawn CLI in terminal (TUI displays for user, but we ignore it)
   * 3. Wait for session start and discover log file:
   *    - **Session resumption:** If resolvedSessionId provided, use it directly to find log file
   *    - **Claude + Copilot (SessionStart hook):** Wait up to 60 seconds for SessionStart hook,
   *      then use session ID to find log file directly
   *    - **Codex (no start hook):** Discover log file by matching prompt text
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
   * @param resolvedSessionId Resolved session ID (used for session resumption to skip log discovery)
   * @returns Promise with success flag and optional sessionId
   */
  protected async executeInTerminal(
    args: string[],
    promptText: string,
    workflowContext?: WorkflowContext,
    resolvedSessionId?: string
  ): Promise<{ success: boolean; sessionId?: string }> {
    // In the standalone CLI binary (CliAdapter), vscode.Terminal is unavailable.
    // Delegate to the spawn-with-stdio:inherit path so the user gets a real TUI.
    if (!this.isVsCodeContext()) {
      return this.executeInteractiveCliProcess(
        args,
        promptText,
        workflowContext,
        resolvedSessionId
      );
    }

    let tempFilePaths: string[] = [];

    try {
      // Check if provider has log parser capability
      if (!this.provider.logParser) {
        Log.error("❌ Harness does not support log file monitoring");
        return { success: false };
      }

      // 1. Record start time BEFORE spawning CLI
      const startTime = new Date();
      Log.debug(`⏱️ Recording start time: ${startTime.toISOString()}`);

      // Clean up any stale stop notification file from a previous run of this session.
      // If the previous run crashed before cleanup, the leftover file would cause an
      // immediate false completion the next time this session is resumed.
      if (resolvedSessionId && this.provider.notificationMonitor) {
        const workspaceRoot = this.getWorkspaceRoot();
        if (workspaceRoot) {
          const notifyDir =
            this.provider.notificationMonitor.getNotificationDirectory(
              workspaceRoot
            );
          const staleStopFile = path.join(
            notifyDir,
            `${resolvedSessionId}-stop.json`
          );
          if (fs.existsSync(staleStopFile)) {
            try {
              fs.unlinkSync(staleStopFile);
              Log.debug(
                `🧹 Cleaned up stale stop notification for session ${resolvedSessionId.substring(0, 8)}`
              );
            } catch {
              // Non-fatal — worst case the notification monitor will find it
              // but the startTime filter will ignore it if it's old enough
            }
          }
        }
      }

      // 2. Spawn CLI in terminal (TUI displays for user)
      const startResult = await this.startCliProcess(
        args,
        promptText,
        workflowContext
      );
      tempFilePaths = startResult.tempFilePaths; // Store for cleanup in finally

      // 3. Wait for SessionStart hook and discover log file
      let sessionId: string | null = resolvedSessionId || null;
      let logPath: string | null = null;

      // If we already have a resolved session ID (from resumption), use it directly
      if (resolvedSessionId) {
        Log.debug(
          `🔄 Resuming session ${resolvedSessionId} - discovering log file directly...`
        );

        const discovery = await this.discoverAndExtractSession(
          promptText,
          startTime,
          resolvedSessionId,
          "Log file not found for resumed session"
        );

        if (!discovery) {
          Log.error(
            `❌ Could not find log file for resumed session ${resolvedSessionId}\n` +
              `   The session may have been deleted or never existed.\n` +
              `   To fix: Remove the sessionId property to start a new session.`
          );
          return { success: false };
        }

        logPath = discovery.logPath;
        sessionId = discovery.sessionId;
        Log.info(`✅ Found log file for resumed session: ${logPath}`);
      } else if (this.provider.notificationMonitor.waitForSessionStart) {
        // Harness supports SessionStart hook (Claude only currently)
        Log.info("🔍 Waiting for SessionStart hook and log file creation...");

        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
          Log.error("❌ No workspace root for session start monitoring");
          return { success: false };
        }

        const notifyDir =
          this.provider.notificationMonitor.getNotificationDirectory(
            workspaceRoot
          );

        // Wait for SessionStart notification
        const startResultNotify =
          await this.provider.notificationMonitor.waitForSessionStart(
            {
              directory: notifyDir,
              timeoutMs: SESSION_START_TIMEOUT_MS,
              pollMs: SESSION_START_POLL_MS,
            },
            startTime,
            () => this.isCancelling
          );

        if (!startResultNotify.completed) {
          Log.error(
            `❌ SessionStart hook timeout: ${startResultNotify.error || "Unknown error"}`
          );
          this.lastFailureReason =
            startResultNotify.error || "SessionStart hook timeout";
          return { success: false };
        }

        // Extract session ID if provided (Claude provides it, Copilot doesn't)
        const hookSessionId = startResultNotify.data?.sessionId || null;

        if (hookSessionId) {
          Log.debug(
            `✅ SessionStart hook provided session ID: ${hookSessionId}`
          );
        } else {
          Log.debug(
            "✅ SessionStart hook confirmed (session ID not provided by CLI)"
          );
          Log.debug(
            "🔍 Discovering session log file via prompt text matching..."
          );
        }

        const discovery = await this.discoverAndExtractSession(
          promptText,
          startTime,
          hookSessionId,
          hookSessionId
            ? "Log file not found after SessionStart"
            : "Session log not found"
        );

        if (!discovery) {
          if (hookSessionId) {
            Log.error(
              `❌ Could not find log file for session ${hookSessionId} - this should not happen!`
            );
          } else {
            Log.error(
              "❌ Could not discover session log - no matching prompt found"
            );
          }
          return { success: false };
        }

        logPath = discovery.logPath;
        sessionId = discovery.sessionId;
        Log.info(`✅ Found session log: ${logPath}`);
      } else {
        // Harness doesn't support SessionStart hook - use old method (Copilot, Codex)
        Log.info("🔍 Discovering session log file (no SessionStart hook)...");

        const discovery = await this.discoverAndExtractSession(
          promptText,
          startTime,
          null,
          "Session log not found"
        );

        if (!discovery) {
          Log.error(
            "❌ Could not discover session log - no matching prompt found"
          );
          return { success: false };
        }

        logPath = discovery.logPath;
        sessionId = discovery.sessionId;
        Log.info(`✅ Found session log: ${logPath}`);
      }

      // 4. Monitor log file for completion
      const result = await this.monitorLogFile(logPath, sessionId, startTime);

      return result;
    } catch (error) {
      Log.error(`❌ Interactive execution error`, error);
      this.lastFailureReason =
        error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      // Always clean up temp files, regardless of success or failure
      await this.cleanupTempFiles(tempFilePaths);
    }
  }

  /**
   * Start CLI process in terminal and return execution details.
   *
   * **Security: Always uses temp file for prompt passing.**
   * The prompt text is never embedded directly in the shell command string,
   * eliminating shell injection risk entirely. A temp file is created and
   * a file reference (e.g., "Follow instructions in @.flightpath/temp/prompt.md")
   * is passed instead.
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
    // Security: Always use temp file for interactive mode prompt passing.
    // The prompt text is embedded in a shell command string by buildInteractiveTuiCommand(),
    // so even with escaping, raw prompt text could contain shell metacharacters.
    // Using temp files eliminates shell injection entirely — prompt never enters the command line.
    const { tempFilePaths, promptWithInstruction } =
      await this.createPromptFileWithReference(promptText, workflowContext);
    const actualPromptText = promptWithInstruction; // "Follow instructions in @file1 "

    Log.debug(
      `📁 Interactive mode using ${tempFilePaths.length} temp file(s) for safe prompt passing`
    );

    const tuiCommand = this.provider.buildInteractiveTuiCommand(
      args,
      actualPromptText // Use file reference or original depending on size
    );

    // Persist the actual TUI command (trimmed and collapsed to one line)
    this.lastCliCommand = String(tuiCommand).replace(/\s+/g, " ").trim();

    // Store the actual prompt sent for log discovery
    this.actualPromptSent = actualPromptText;

    // Update prompt number for terminal tab naming before creating the terminal
    if (workflowContext) {
      this.currentPromptNumber = workflowContext.promptIndex + 1;
      this.currentPromptTotal = workflowContext.allPrompts.length;
    }

    const terminal = await this.createFreshTerminal();
    Log.info(`🖥️ Opened terminal: "${this.buildTerminalName()}"`);
    terminal.show();

    this.promptReadyEmitter.fire({
      fullPrompt: promptText, // Always use original prompt for display
      cliCommand: this.lastCliCommand,
    });

    this.streamingChunkEmitter.fire(
      "📺 Interactive mode: Output is streaming to the VS Code terminal.\n" +
        "   View the terminal for real-time output.\n\n"
    );

    const shellIntegration = await this.waitForShellIntegration(terminal);
    const execution = shellIntegration.executeCommand(tuiCommand);
    this.currentExecution = execution;

    return { terminal, execution, tempFilePaths };
  }

  /**
   * Monitor log file for completion using harness's log parser.
   *
   * Delegates to CliLogMonitor for the actual monitoring logic.
   * Stores parsed output and CLI result on this instance for callers.
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
    const monitor = new CliLogMonitor({
      logParser: this.provider.logParser!,
      notificationMonitor: this.provider.notificationMonitor,
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      isCancelling: () => this.isCancelling,
      onStreamingChunk: (chunk) => this.streamingChunkEmitter.fire(chunk),
      onResponseComplete: (msg) => this.responseCompleteEmitter.fire(msg),
      logResponse: (response, statistics) =>
        this.logResponse(response, statistics),
    });

    const result = await monitor.monitor(logPath, sessionId, startTime);

    // Store structured output and legacy result on this instance
    if (result.parsedOutput) {
      this.lastParsedOutput = result.parsedOutput;
    }
    if (result.cliResult) {
      this.lastResult = result.cliResult;
    }

    return { success: result.success, sessionId: result.sessionId };
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
    await this.deleteTempFiles(tempFilePaths);
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
      let promptArgument: string;

      if (useDirectPrompt) {
        // Simple prompt: pass directly on command line
        promptArgument = promptText;
        Log.info(`🚀 Starting headless mode with direct prompt (fast path)`);
        Log.info(`📝 Prompt length: ${promptText.length} characters`);
      } else {
        // Complex prompt: create temp file(s)
        const { tempFilePaths: paths, promptWithInstruction } =
          await this.createPromptFileWithReference(promptText, workflowContext);
        tempFilePaths = paths;
        promptArgument = promptWithInstruction;
        Log.info(`🚀 Starting headless mode with ${paths.length} file(s)`);
        Log.info(`📝 Total prompt length: ${promptText.length} characters`);
      }

      // Build headless arguments (same method for both direct prompts and file references)
      headlessArgs = this.provider.buildHeadlessArgs(args, promptArgument);
      displayCommand = `${this.provider.config.name} ${headlessArgs.join(" ")}`;

      this.lastCliCommand = displayCommand;

      // Store the actual prompt sent for log discovery (may be a file reference)
      this.actualPromptSent = promptArgument;

      this.promptReadyEmitter.fire({
        fullPrompt: promptText,
        cliCommand: displayCommand,
      });

      // Check if we should stream output in real-time
      const shouldStream = this.provider.config.shouldStreamHeadlessOutput;

      // Create streaming state map for harness's response parser
      const streamState = new Map<string, any>();

      // Spawn and execute
      const result = await this.spawnProcess(
        this.provider.config.name,
        headlessArgs,
        {
          timeout: ConfigurationUtils.getMaxPromptExecutionTimeMs(),
          onStdout: shouldStream
            ? (chunk) => {
                // Debug logging: Log raw CLI output if enabled
                const logRawOutput = ConfigurationUtils.shouldLogRawCliOutput();
                if (logRawOutput) {
                  Log.debug(
                    `[${this.provider.config.displayName} RAW OUTPUT]: ${chunk}`
                  );
                }

                // Delegate to provider's response parser for streaming
                if (this.provider.responseParser.processStreamingChunk) {
                  const processedChunk =
                    this.provider.responseParser.processStreamingChunk(
                      chunk,
                      streamState
                    );
                  if (processedChunk !== undefined) {
                    // Check if response parser returned structured events or plain text
                    if (Array.isArray(processedChunk)) {
                      // Modern harnesses (Claude, Codex) return CliEvent[]
                      this.streamingEventsEmitter.fire(processedChunk);
                    } else {
                      // Legacy harnesses (Copilot) return string
                      this.streamingChunkEmitter.fire(processedChunk);
                    }
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
        await this.deleteTempFiles(tempFilePaths);
        Log.debug(`🗑️ Cleaned up ${tempFilePaths.length} temp file(s)`);
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

    // Always emit response complete when process exits (success, error, or cancelled)
    this.responseCompleteEmitter.fire("Process exited");
    Log.info("✅ Process exited - execution complete");

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
      const preview =
        promptText.length > 120
          ? `${promptText.substring(0, 120)}…`
          : promptText;
      Log.appendLine(
        `\n[PROMPT ${new Date().toLocaleTimeString()}] ${preview}`
      );
    }
  }

  /**
   * Extract text content from events array.
   * Delegates to CliLogMonitor.extractTextFromEvents (single source of truth).
   */
  private extractTextFromEvents(output: UniversalCliOutput): string {
    return CliLogMonitor.extractTextFromEvents(output);
  }

  /**
   * Log response to output channel with formatting
   */
  protected logResponse(response: string, statistics?: string): void {
    if (this.shouldShowOutput()) {
      if (statistics) {
        Log.appendLine(`\n[STATISTICS] ${statistics}`);
      }
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
    const root = this.platform.getWorkspaceRoot();
    const workspaceDirs = root ? [root] : [];
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
   * Get the last parsed output with structured data.
   * Contains tool calls, thinking blocks, and metadata.
   * Returns undefined if no parsed output is available (e.g., non-CLI integrations).
   */
  getLastParsedOutput(): UniversalCliOutput | undefined {
    return this.lastParsedOutput;
  }

  /**
   * Get the last CLI command executed
   */
  getLastCliCommand(): string | undefined {
    return this.lastCliCommand;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize CLI by checking availability via provider.checkAvailability().
   */
  async initialize(): Promise<void> {
    this.initializationStatus = HarnessStatus.Initializing;
    this.statusChangeEmitter.fire(HarnessStatus.Initializing);

    try {
      const available = await this.provider.checkAvailability();

      if (available) {
        // Get version if provider supports it
        let versionInfo = "";
        if (this.provider.getVersion) {
          const version = await this.provider.getVersion();
          versionInfo = version ? `: ${version}` : "";
        }

        Log.debug(
          `✅ ${this.provider.config.displayName} available${versionInfo}`
        );
        this.isAvailable = true;
        this.initializationStatus = HarnessStatus.Ready;
        this.statusChangeEmitter.fire(HarnessStatus.Ready);
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
    this.initializationStatus = HarnessStatus.Unavailable;
    this.statusChangeEmitter.fire(HarnessStatus.Unavailable);

    Log.error(`❌ ${this.provider.config.displayName} not available`, error);
  }

  /**
   * Show warning when running in headless mode without full permissions
   */
  protected warnIfHeadlessWithoutPermissions(): void {
    const mode = this.getExecutionMode();
    if (mode === CLI_EXECUTION_MODE.HEADLESS && !this.hasFullPermissions()) {
      this.platform.warn(CLI_WARNING_MESSAGES.HEADLESS_WITHOUT_PERMISSIONS);
    }
  }

  // ============================================================
  // STATUS & AVAILABILITY
  // ============================================================

  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  isReady(): boolean {
    return this.initializationStatus === HarnessStatus.Ready;
  }

  getInitializationStatus(): HarnessStatus {
    return this.initializationStatus;
  }

  isCli(): boolean {
    return true;
  }

  override closeTerminal(): void {
    this.processManager.disposeTerminal();
    this.currentExecution = undefined;
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
    Log.debug(
      `⏹️ CLI Integration cancel called (harness: ${this.provider.config.displayName})`
    );

    // Check if we have an actively running process or execution.
    // In headless mode, the child process lives in processManager.
    const hasActiveProcess =
      this.currentExecution || this.processManager.isActive();

    if (!hasActiveProcess) {
      // No active process anywhere - fire responseComplete immediately
      Log.debug(
        "⏹️ No active process/execution - firing responseComplete immediately"
      );
      this.responseCompleteEmitter.fire("Cancelled before process started");
      this.currentExecution = undefined;
      return;
    }

    // Active process exists: Kill it. responseComplete will be fired by the
    // process close handler (in spawnProcess) when the process actually exits.
    Log.info("⏹️ Active process found - sending kill signal");
    await this.processManager.cancel(this.currentExecution);
    this.currentExecution = undefined;

    Log.info("⏹️ Kill signal sent - waiting for process to exit");
  }

  /**
   * Dispose of resources
   */
  /**
   * Dispose of resources.
   * If closeTerminalWhenPromptCompletes is false (default), the terminal is kept open
   * so the user can review output. The next prompt will close it via createFreshTerminal().
   */
  dispose(): void {
    super.dispose();
    if (ConfigurationUtils.shouldCloseTerminalWhenPromptCompletes()) {
      this.processManager.dispose();
    } else {
      this.processManager.disposeProcess();
    }
    this.currentExecution = undefined;
  }

  /**
   * Mark this execution integration as ready without running initialize().
   * The detector singleton has already confirmed availability; we set the
   * local initializationStatus so getDetailedStatus() returns Ready immediately.
   */
  override markAsReady(): void {
    super.markAsReady();
    this.initializationStatus = HarnessStatus.Ready;
  }

  // ============================================================
  // PROMPT SENDING (MAIN ENTRY POINT)
  // ============================================================

  /**
   * Build the headless response callback that parses results, stores output,
   * extracts session IDs, and fires response events.
   *
   * Previously duplicated in both the primary headless execution and the
   * session error retry path. Now extracted as a single source of truth.
   *
   * @param finalPromptText Original prompt text (for log-based session extraction)
   * @param executionStartTime When execution started
   * @param resolvedSessionId Session ID used for resume (null = new session)
   * @param extractedSessionIdSetter Callback to store the extracted session ID
   * @param label Label for debug logging (e.g., "" or " (retry)")
   * @returns Callback compatible with executeHeadlessWithPromptFile
   */
  private buildHeadlessResponseCallback(
    finalPromptText: string,
    executionStartTime: Date,
    resolvedSessionId: string | undefined,
    extractedSessionIdSetter: (id: string) => void,
    label: string = ""
  ): (result: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }) => Promise<boolean> {
    return async (result) => {
      // Debug logging: Log raw stdout/stderr if enabled
      const logRawOutput = ConfigurationUtils.shouldLogRawCliOutput();
      if (logRawOutput) {
        Log.debug(
          `[${this.provider.config.displayName} FINAL STDOUT${label}]:\n${result.stdout}`
        );
        if (result.stderr) {
          Log.debug(
            `[${this.provider.config.displayName} FINAL STDERR${label}]:\n${result.stderr}`
          );
        }
      }

      // Parse result using provider's response parser (returns UniversalCliOutput)
      const parsedOutput = this.provider.responseParser.parse(
        result.stdout,
        result.stderr,
        result.exitCode
      );

      // Store structured output for tool call/event access
      this.lastParsedOutput = parsedOutput;

      // Extract text from events for legacy CliResult
      const responseText = this.extractTextFromEvents(parsedOutput);

      // Format statistics for display
      const statistics = CliOutputFormatter.formatStatistics(
        parsedOutput.metadata
      );

      // Create legacy CliResult for backward compatibility
      const cliResult: CliResult = {
        success: result.exitCode === 0,
        response: responseText,
        statistics,
        exitCode: result.exitCode,
        error: result.exitCode !== 0 ? result.stderr : undefined,
      };

      // Store legacy result
      this.lastResult = cliResult;

      // Extract session ID if available from output or logs
      if (parsedOutput.metadata.sessionId) {
        extractedSessionIdSetter(parsedOutput.metadata.sessionId);
        Log.debug(
          `📝 Session ID from output${label}: ${parsedOutput.metadata.sessionId}`
        );
      } else if (!resolvedSessionId && this.provider.extractSessionIdFromLogs) {
        const logSessionId = await this.provider.extractSessionIdFromLogs(
          this.actualPromptSent || finalPromptText,
          executionStartTime
        );
        if (logSessionId) {
          extractedSessionIdSetter(logSessionId);
          Log.debug(`📝 Session ID from logs${label}: ${logSessionId}`);
        }
      }

      // Log response
      this.logResponse(responseText, statistics);

      // Fire response complete event
      this.responseCompleteEmitter.fire(responseText);

      return result.exitCode === 0;
    };
  }

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
      workingFilePath?: string;
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

      // Resolve execution properties (harness, model, agent)
      const resolvedProperties = workflowContext?.workflowFile
        ? PropertyResolver.resolve(prompt, workflowContext.workflowFile)
        : workflowContext?.resolvedProperties;

      // Validate session ID format before passing to CLI (Phase 5)
      if (resolvedSessionId) {
        const harness =
          resolvedProperties?.harness ?? (this.getIntegrationMode() as Harness);
        if (!SessionValidator.validate(resolvedSessionId, harness)) {
          // Invalid format - start new session instead
          Log.info(`🔄 Starting new session due to invalid session ID format`);
          resolvedSessionId = undefined;
        }
      }

      // Build prompt with optional dynamic queue instructions, agent, and skills
      const finalPromptText = await this.buildPromptWithInstructions(
        prompt,
        workflowContext?.promptIndex ?? 0,
        workflowContext?.allPrompts ?? [prompt],
        resolvedProperties?.allowDynamicExtension,
        resolvedProperties?.agent, // Pass resolved agent for prompt prepending
        resolvedProperties?.skills // Pass resolved skills for frontmatter injection
      );

      this.lastFullPrompt = finalPromptText;

      // Log prompt
      this.logPrompt(finalPromptText);

      // Capture execution start time for session log discovery
      const executionStartTime = new Date();

      // Determine execution mode first
      const mode = this.getExecutionMode();
      const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;

      // Build CLI arguments - delegated to provider for complete control
      const workspaceRoot = this.getWorkspaceRoot();
      const baseArgs = await this.provider.buildCliArgs(
        prompt,
        isInteractive,
        this.platform.getExtensionPath(),
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

        // Fallback: Extract session ID from logs if not available from notification.
        // Copilot and Claude provide session IDs via hooks (SessionStart + Stop hooks).
        // Codex provides a thread ID at completion (notify hook) but has no start hook yet —
        // it discovers the session log via prompt-text matching instead. This fallback
        // also covers edge cases where hook delivery fails for any harness.
        // Skip if we already have resolvedSessionId - log discovery is unnecessary
        // (the session didn't change) and would search deep into a resumed session log.
        if (
          success &&
          !extractedSessionId &&
          !resolvedSessionId &&
          this.provider.extractSessionIdFromLogs
        ) {
          const logSessionId = await this.provider.extractSessionIdFromLogs(
            this.actualPromptSent || finalPromptText,
            executionStartTime
          );
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

        // Build the shared response callback (single source of truth)
        const responseCallback = this.buildHeadlessResponseCallback(
          finalPromptText,
          executionStartTime,
          resolvedSessionId,
          (id) => {
            extractedSessionId = id;
          }
        );

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
              responseCallback
            );
          } catch (error) {
            // Check for recoverable session errors using provider's response parser (Phase 5)
            if (
              this.provider.responseParser.isRecoverableSessionError?.(error)
            ) {
              const currentHarness =
                resolvedProperties?.harness ??
                (this.getIntegrationMode() as Harness);

              if (currentHarness === Harness.ClaudeCli) {
                Log.warn(
                  `⚠️ Claude CLI rejected session ID "${resolvedSessionId}". ` +
                    `Retrying without resume flag.`
                );

                // Rebuild args without session ID
                const argsWithoutResume = await this.provider.buildCliArgs(
                  prompt,
                  false, // headless mode
                  this.platform.getExtensionPath(),
                  this.getWorkspaceRoot() || "",
                  undefined, // no session ID - start new session
                  workflowContext
                );

                // Build retry callback with label
                const retryCallback = this.buildHeadlessResponseCallback(
                  finalPromptText,
                  executionStartTime,
                  undefined, // no session ID on retry
                  (id) => {
                    extractedSessionId = id;
                  },
                  " (retry)"
                );

                // Retry with new args
                return await this.executeHeadlessWithPromptFile(
                  argsWithoutResume,
                  promptText,
                  workflowContext,
                  retryCallback
                );
              }
            }
            // Re-throw if not a recoverable error
            throw error;
          }
        };

        success = await executeWithRecovery(baseArgs, finalPromptText);
      }

      // If we resumed an existing session and log discovery didn't run (or couldn't find the log),
      // fall back to the resolved session ID — the session hasn't changed.
      if (!extractedSessionId && resolvedSessionId) {
        extractedSessionId = resolvedSessionId;
        Log.debug(
          `📝 Reusing resolved session ID (no new ID extracted): ${extractedSessionId}`
        );
      }

      // Store runtime metadata in prompt's _runtime (always on success, session ID optional)
      if (success) {
        // IMPORTANT: Always create/update harness and model fields, even when resuming from working file
        // This ensures _runtime accurately reflects what was ACTUALLY used, not stale data from previous runs
        const actualHarness =
          resolvedProperties?.harness ?? (this.getIntegrationMode() as Harness);
        const actualModel = resolvedProperties?.model ?? "";
        const actualAgent = resolvedProperties?.agent;

        if (!prompt._runtime) {
          // First execution - create new _runtime
          prompt._runtime = {
            harness: actualHarness,
            model: actualModel,
            agent: actualAgent,
            startedAt: Date.now(),
          };
        } else {
          // Resuming from working file - update harness/model to match what actually ran
          prompt._runtime.harness = actualHarness;
          prompt._runtime.model = actualModel;
          prompt._runtime.agent = actualAgent;
          // Keep existing startedAt (from first attempt)
        }

        // Add session ID if available (may be undefined for first prompt or if extraction failed)
        if (extractedSessionId) {
          prompt._runtime.sessionId = extractedSessionId;

          // Propagate session ID back into lastParsedOutput.metadata so the dashboard
          // renders it in the stats section. Copilot's response parser always sets
          // metadata.sessionId=undefined (session ID comes from log files, not CLI output),
          // so this is the only place where it gets merged into the structured output.
          if (this.lastParsedOutput && !this.lastParsedOutput.metadata.sessionId) {
            this.lastParsedOutput = {
              ...this.lastParsedOutput,
              metadata: {
                ...this.lastParsedOutput.metadata,
                sessionId: extractedSessionId,
              },
            };
          }
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
  // NOTE: Error recovery logic is now Harness-specific.
  // See IResponseParser.isRecoverableSessionError() for implementation.
}
