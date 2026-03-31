import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import { CliResult } from "../../types/CliOutputTypes";
import { PromptItem, Harness } from "../../types/FlightPathTypes";
import { WorkflowContext } from "../../types/WorkflowContextTypes";
import { UniversalCliOutput } from "../../types/CliOutputTypes";
import { HarnessIntegration, HarnessStatus } from "../HarnessIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { CliProcessManager } from "../../utils/CliProcessManager";
import type { TempFileManager } from "../../utils/TempFileManager";
import { Log } from "../../utils/Log";
import {
  EXECUTION_MODES,
  type ExecutionMode,
} from "../../types/DashboardConstants";
import { getErrorMessage } from "../../utils/ErrorUtils";
import type { ICliProvider } from "./shared/interfaces/ICliProvider";
import type { ToolPermissionConfig } from "./shared/interfaces/IToolPermissionMapper";
import { CliOutputFormatter } from "./shared/CliOutputFormatter";
import { CliLogMonitor } from "./CliLogMonitor";
import { CliFailureTracker } from "./shared/CliFailureTracker";
import { CliInteractiveStartupCoordinator } from "./shared/CliInteractiveStartupCoordinator";
import {
  CliPromptPreparer,
  type PromptFileResult,
} from "./shared/CliPromptPreparer";
import { CliPromptRuntimeCoordinator } from "./shared/CliPromptRuntimeCoordinator";
import { CliResponseCollector } from "./shared/CliResponseCollector";
import { CliSessionResolverAdapter } from "./shared/CliSessionResolverAdapter";
import { CliTransportCoordinator } from "./shared/CliTransportCoordinator";
import type { ResolvedProperties } from "../../utils/PropertyResolver";

/** Timeout (ms) for waiting for SessionStart hook from CLI harness */
/**
 * Execution mode for CLI integrations
 */
export type CliExecutionMode = ExecutionMode;

/**
 * Execution mode constants
 */
export const CLI_EXECUTION_MODE = EXECUTION_MODES;

/**
 * Warning messages
 */
export const CLI_WARNING_MESSAGES = {
  HEADLESS_WITHOUT_PERMISSIONS:
    "Headless mode without full permissions: CLI will auto-deny tool/file access. Workflow may not make progress.",
} as const;

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

  /** Tracks PTY exits, process-exit classification, and captured PTY tail output. */
  private readonly failureTracker = new CliFailureTracker();

  /** Prompt/file assembly helper extracted from CliIntegration. */
  private readonly promptPreparer: CliPromptPreparer;

  /** Session/property resolution helper extracted from CliIntegration. */
  private readonly sessionResolverAdapter: CliSessionResolverAdapter;

  /** Per-prompt runtime metadata persistence helper extracted from CliIntegration. */
  private readonly promptRuntimeCoordinator: CliPromptRuntimeCoordinator;

  /** Launch/cancellation helper extracted from CliIntegration. */
  private readonly transportCoordinator: CliTransportCoordinator;

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

    this.promptPreparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () =>
        ConfigurationUtils.shouldOmitAgentsAndSkillsOnResume(),
      buildPromptSections: (prompt, resolvedAgent, resolvedSkills) =>
        this.buildPromptSections(prompt, resolvedAgent, resolvedSkills),
      isSimplePrompt: (promptText) => this.isSimplePrompt(promptText),
      buildPriorContextXml: (
        resolvedPriorContext,
        allPrompts,
        promptIndex,
        finalPromptResponseTexts
      ) => {
        const contextItems = this.gatherPriorContextItems(
          resolvedPriorContext,
          allPrompts,
          promptIndex,
          finalPromptResponseTexts
        );
        return contextItems.length > 0
          ? this.buildPriorContextXml(contextItems)
          : "";
      },
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      getTempFileSplitConfig: () => this.getTempFileSplitConfig(),
      formatDirectFileRef: (absolutePath) =>
        this.formatDirectFileRef(absolutePath),
      formatTempFileRef: (tempMgr, absolutePath) =>
        this.formatTempFileRef(tempMgr, absolutePath),
      formatCategorizedReferences: (
        agentRefs,
        skillRefs,
        directRefs,
        contextRefs,
        excerptRefs,
        promptRefs
      ) =>
        this.formatCategorizedReferences(
          agentRefs,
          skillRefs,
          directRefs,
          contextRefs,
          excerptRefs,
          promptRefs
        ),
      logInfo: (message) => Log.info(message),
    });

    this.sessionResolverAdapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => this.getIntegrationMode() as Harness,
      logger: {
        info: (message) => Log.info(message),
      },
    });

    this.promptRuntimeCoordinator = new CliPromptRuntimeCoordinator({
      getIntegrationHarness: () => this.getIntegrationMode() as Harness,
      logger: {
        debug: (message) => Log.debug(message),
      },
    });

    this.transportCoordinator = new CliTransportCoordinator({
      provider: this.provider,
      processManager: this.processManager,
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      getTerminalName: () => this.buildTerminalName(),
      getWorkflowName: () => this.workflowName,
      onBeforeInteractiveStart: (workflowContext) => {
        if (workflowContext) {
          this.currentPromptNumber = workflowContext.promptIndex + 1;
          this.currentPromptTotal = workflowContext.allPrompts.length;
        }
      },
      onCommandPrepared: ({ promptArgument, cliCommand }) => {
        this.lastCliCommand = cliCommand;
        this.actualPromptSent = promptArgument;
        this.promptReadyEmitter.fire({
          fullPrompt: promptArgument,
          cliCommand,
        });
      },
      onStreamingChunk: (chunk) => this.streamingChunkEmitter.fire(chunk),
      onStreamingEvents: (events) => this.streamingEventsEmitter.fire(events),
      onResponseComplete: (response) =>
        this.responseCompleteEmitter.fire(response),
      onPtyExit: (session, exitCode) => {
        this.failureTracker.capturePtyExit(exitCode, session.reconnectBuffer);
        if (exitCode !== 0) {
          Log.warn(
            `⚠️ AI CLI PTY session ${session.id} exited with code ${exitCode} — workflow step will be stopped`
          );
        } else {
          Log.info(
            `🛑 AI CLI PTY session ${session.id} exited with code 0 before completion — workflow step will be stopped`
          );
        }
      },
      isCancelling: () => this.isCancelling,
      cleanupTempFiles: (tempFilePaths) => this.cleanupTempFiles(tempFilePaths),
      logger: {
        debug: (message) => Log.debug(message),
        info: (message) => Log.info(message),
        warn: (message) => Log.warn(message),
        error: (message, error) => Log.error(message, error),
      },
    });
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
      EXECUTION_MODES.INTERACTIVE
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
      this.currentPromptNumber !== undefined &&
      this.currentPromptTotal !== undefined
        ? ` [${this.currentPromptNumber}/${this.currentPromptTotal}]`
        : "";
    return `${base} · ${short}${promptSuffix}`;
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
   * Used to warn users when running headless without full permissions.
   *
   * @param toolPermissions Resolved permissions from workflow context.
   *   - undefined: no workflow context — falls back to ConfigurationUtils global settings
   *   - null: none mode — returns false (FlightPath can't know what the harness allows)
   *   - ToolPermissionConfig: use the resolved config directly
   */
  protected hasFullPermissions(
    toolPermissions?: ToolPermissionConfig | null
  ): boolean {
    if (toolPermissions === null) {
      return false;
    }
    const config = toolPermissions ?? {
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
  // PROMPT PREPARATION
  // ============================================================

  /**
   * Build prompt sections and create all necessary temp files in one step.
   * Returns the prompt argument to pass to the CLI and the paths to clean up.
   *
   * Fast path: if the prompt is short, shell-safe, and has no attachments,
   * agent, skills, prior context, or critical instruction, returns the raw
   * text directly with no temp files (no disk I/O).
   *
   * Otherwise: delegates to CliPromptPreparer to build sections, create any
   * categorized temp files, and return the structured reference instruction.
   *
   * @param prompt Prompt item to prepare
   * @param workflowContext Workflow execution context
   * @param resolvedProperties Resolved execution properties (agent, skills, etc.)
   * @param resolvedSessionId Used to determine whether to omit agent/skills on resume
   * @param finalPromptResponseTexts Prior finalPrompt response texts for context injection
   */
  private async buildAndPreparePrompt(
    prompt: PromptItem,
    workflowContext: WorkflowContext | undefined,
    resolvedProperties: ResolvedProperties | undefined,
    resolvedSessionId: string | undefined,
    finalPromptResponseTexts?: string[]
  ): Promise<PromptFileResult> {
    return await this.promptPreparer.preparePrompt(
      prompt,
      workflowContext,
      resolvedProperties,
      resolvedSessionId,
      finalPromptResponseTexts
    );
  }

  /**
   * Format a workspace-relative or absolute path as a direct file reference,
   * with space-quoting applied when the path contains spaces.
   * Uses the provider's formatFileReference() override for harness-specific prefix.
   */
  private formatDirectFileRef(absolutePath: string): string {
    const workspaceRoot = this.getWorkspaceRoot() ?? "";
    const relativePath = path.relative(workspaceRoot, absolutePath);
    const quoted = relativePath.includes(" ")
      ? `"${relativePath}"`
      : relativePath;
    return this.provider.formatFileReference?.(quoted) ?? `@${quoted}`;
  }

  /**
   * Format a temp-file relative path as a file reference using the provider's
   * harness-specific prefix (e.g. "@path" for Copilot, "path" for Claude).
   */
  private formatTempFileRef(
    tempMgr: TempFileManager,
    absolutePath: string
  ): string {
    const relativePath = tempMgr.getRelativePath(absolutePath);
    return (
      this.provider.formatFileReference?.(relativePath) ?? `@${relativePath}`
    );
  }

  /**
   * Format categorized file references into a structured instruction string.
   *
   * Format (absent categories omitted):
   *   Following these agent instructions @agent.1.md[, @agent.2.md],
   *   using these available skills @skills.md,
   *   using these file references @src/foo.ts, @src/bar.ts,
   *   with this prior conversation context @context.md,
   *   and these attachment excerpts @excerpts.1.md[, @excerpts.2.md],
   *   follow the instructions in @prompt.md
   *
   * When only a prompt exists: "Follow instructions in @prompt.md "
   *
   * @param agentRefs Formatted file refs for agent files
   * @param skillRefs Formatted file refs for skills files (split if large)
   * @param directRefs Formatted direct workspace file refs
   * @param contextRefs Formatted file refs for prior context files (split on step boundaries)
   * @param excerptRefs Formatted file refs for excerpt files
   * @param promptRefs Formatted file refs for prompt files
   */
  protected formatCategorizedReferences(
    agentRefs: string[],
    skillRefs: string[],
    directRefs: string[],
    contextRefs: string[],
    excerptRefs: string[],
    promptRefs: string[]
  ): string {
    return CliIntegration.formatCategorizedInstruction(
      agentRefs,
      skillRefs,
      directRefs,
      contextRefs,
      excerptRefs,
      promptRefs
    );
  }

  // ============================================================
  // INTERACTIVE TUI EXECUTION
  // ============================================================

  private getInteractiveAbortState():
    | { kind: "user-cancelled" }
    | { kind: "process-exited"; exitCode: number }
    | null {
    return this.failureTracker.getInteractiveAbortState(this.isCancelling);
  }

  private createInteractiveStartupCoordinator(): CliInteractiveStartupCoordinator {
    return new CliInteractiveStartupCoordinator({
      logParser: this.provider.logParser!,
      notificationMonitor: this.provider.notificationMonitor,
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      getAbortState: () => this.getInteractiveAbortState(),
      markProcessExitDuringStage: (stage, exitCode) =>
        this.failureTracker.markProcessExitDuringStage(stage, exitCode),
      setFailureReason: (reason) => {
        this.lastFailureReason = reason;
      },
      logger: {
        debug: (message) => Log.debug(message),
        info: (message) => Log.info(message),
        warn: (message) => Log.warn(message),
        error: (message) => Log.error(message),
      },
    });
  }

  private createResponseCollector(): CliResponseCollector {
    return new CliResponseCollector({
      responseParser: this.provider.responseParser,
      augmentParsedOutput: this.provider.augmentParsedOutput,
      extractSessionIdFromLogs: this.provider.extractSessionIdFromLogs,
      extractTextFromEvents: (output) =>
        CliLogMonitor.extractTextFromEvents(output),
      formatStatistics: (metadata) =>
        CliOutputFormatter.formatStatistics(metadata),
      logResponse: (response, statistics) =>
        this.logResponse(response, statistics),
      onResponseComplete: (response) =>
        this.responseCompleteEmitter.fire(response),
      logger: {
        debug: (message) => Log.debug(message),
      },
    });
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
   * @param promptArgument Final prompt argument — direct text or file reference instruction
   * @param tempFilePaths Temp files to clean up after execution (may be empty)
   * @param workflowContext Optional workflow context
   * @param resolvedSessionId Resolved session ID (preserved across prompts)
   * @returns success flag and the original sessionId (no new ID extracted)
   */
  private async executeInteractiveCliProcess(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    workflowContext: WorkflowContext | undefined,
    resolvedSessionId: string | undefined
  ): Promise<{ success: boolean; sessionId?: string }> {
    try {
      // Print a separator for multi-prompt workflows so users see the boundary
      if (workflowContext && workflowContext.promptIndex > 0) {
        Log.info(`\n${"─".repeat(52)}`);
        Log.info(
          `Prompt ${workflowContext.promptIndex + 1} / ${workflowContext.allPrompts.length}`
        );
        Log.info("\n");
      }

      return await this.transportCoordinator.executeStandaloneInteractiveProcess(
        args,
        promptArgument,
        tempFilePaths,
        resolvedSessionId
      );
    } catch (error) {
      Log.error("❌ CLI interactive execution error", error);
      this.lastFailureReason = getErrorMessage(error);
      return { success: false };
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
    promptArgument: string,
    tempFilePaths: string[],
    workflowContext?: WorkflowContext,
    resolvedSessionId?: string
  ): Promise<{ success: boolean; sessionId?: string }> {
    // In the standalone CLI binary (CliAdapter), vscode.Terminal is unavailable.
    // Delegate to the spawn-with-stdio:inherit path so the user gets a real TUI.
    if (!this.isVsCodeContext()) {
      return this.executeInteractiveCliProcess(
        args,
        promptArgument,
        tempFilePaths,
        workflowContext,
        resolvedSessionId
      );
    }

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
      // Generate a per-run ID so the hook script writes a uniquely-named start file.
      // This eliminates the parallel-workflow race in waitForSessionStart: each run's
      // hook writes {runId}-start.json, and waitForSessionStart watches only that file.
      // Both IDs travel to the hook/plugin via env vars in the terminal's process env.
      const runId = crypto.randomUUID();
      const terminalEnv: Record<string, string> = { FLIGHTPATH_RUN_ID: runId };
      if (ConfigurationUtils.isDiagnosticLogsEnabled()) {
        terminalEnv.FLIGHTPATH_DIAGNOSTIC_LOGS = "true";
      }
      const wsRootForEnv = this.getWorkspaceRoot();
      if (wsRootForEnv) {
        terminalEnv.FLIGHTPATH_NOTIFY_DIR =
          this.provider.notificationMonitor.getNotificationDirectory(
            wsRootForEnv
          );
      }
      await this.startCliProcess(
        args,
        promptArgument,
        tempFilePaths,
        workflowContext,
        terminalEnv
      );

      // 3. Wait for SessionStart hook and discover log file
      const startupCoordinator = this.createInteractiveStartupCoordinator();
      const discovery = await startupCoordinator.resolveSession({
        promptForDiscovery: this.actualPromptSent || promptArgument,
        startTime,
        resolvedSessionId,
        runId,
      });

      if (!discovery) {
        return { success: false };
      }

      // 4. Monitor log file for completion
      const result = await this.monitorLogFile(
        discovery.logPath,
        discovery.sessionId,
        startTime
      );

      return result;
    } catch (error) {
      Log.error(`❌ Interactive execution error`, error);
      this.lastFailureReason = getErrorMessage(error);
      throw error;
    } finally {
      // Always clean up temp files, regardless of success or failure
      await this.cleanupTempFiles(tempFilePaths);
    }
  }

  /**
   * Start CLI process in terminal and return execution details.
   *
   * **Security:** Uses `isSimplePrompt` to decide the passing strategy.
   * Simple prompts (≤300 chars, shell-safe characters only) are passed directly.
   * Complex prompts go through a temp file reference
   * (e.g., "Follow instructions in @.flightpath/temp/prompt.md"),
   * which eliminates shell injection risk entirely.
   *
   * @param args CLI arguments
   * @param promptText Prompt text
   * @param workflowContext Optional workflow context
   * @returns Terminal, execution, and temp file paths for cleanup
   */
  private async startCliProcess(
    args: string[],
    promptArgument: string,
    tempFilePaths: string[],
    workflowContext?: WorkflowContext,
    env?: Record<string, string>
  ): Promise<void> {
    await this.transportCoordinator.startInteractiveProcess(
      args,
      promptArgument,
      tempFilePaths,
      workflowContext,
      env
    );
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
      isPtyTerminated: () => this.failureTracker.getPtyTermination(),
      onStreamingEvents: (events) => this.streamingEventsEmitter.fire(events),
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

    // Flag process-exit termination so callers (WorkflowExecutor) can
    // distinguish it from user cancellation or normal failure.
    if (result.processExited) {
      this.lastFailureReason =
        this.failureTracker.markCompletionDetectionProcessExit(
          result.processExited.exitCode
        );
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
    promptArgument: string,
    tempFilePaths: string[],
    executeCallback: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => Promise<boolean>
  ): Promise<boolean> {
    return await this.transportCoordinator.executeHeadless(
      args,
      promptArgument,
      tempFilePaths,
      executeCallback
    );
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
   * Log response to output channel with formatting
   */
  protected logResponse(_response: string, statistics?: string): void {
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

  override getLastFailureOutput(): string | undefined {
    return this.failureTracker.getLastFailureOutput();
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
    _type: "command_failed" | "exception",
    error: unknown
  ): void {
    this.isAvailable = false;
    this.initializationStatus = HarnessStatus.Unavailable;
    this.statusChangeEmitter.fire(HarnessStatus.Unavailable);

    Log.error(`❌ ${this.provider.config.displayName} not available`, error);
  }

  /**
   * Show warning when running in headless mode without full permissions
   *
   * @param toolPermissions Resolved permissions from workflow context (passed through to hasFullPermissions)
   */
  protected warnIfHeadlessWithoutPermissions(
    toolPermissions?: ToolPermissionConfig | null
  ): void {
    const mode = this.getExecutionMode();
    if (
      mode === CLI_EXECUTION_MODE.HEADLESS &&
      !this.hasFullPermissions(toolPermissions)
    ) {
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
    this.transportCoordinator.closeTerminal();
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

    const hadActiveProcess = await this.transportCoordinator.cancel();

    if (!hadActiveProcess) {
      // No active process anywhere - fire responseComplete immediately
      Log.debug(
        "⏹️ No active process/execution - firing responseComplete immediately"
      );
      this.responseCompleteEmitter.fire("Cancelled before process started");
      return;
    }

    // Active process exists: Kill it. responseComplete will be fired by the
    // process close handler (in spawnProcess) when the process actually exits.
    Log.info("⏹️ Active process found - sending kill signal");

    Log.info("⏹️ Kill signal sent - waiting for process to exit");
  }

  /**
   * Dispose of resources.
   * If closeTerminalWhenPromptCompletes is false (default), the terminal is kept open
   * so the user can review output. The next prompt launch will close it before reuse.
   */
  dispose(): void {
    super.dispose();
    this.transportCoordinator.dispose(
      ConfigurationUtils.shouldCloseTerminalWhenPromptCompletes()
    );
  }

  /**
   * Delete the MCP config file written for this workflow run, if any.
   *
   * Providers that write file-based MCP configs implement getMcpConfigFilePath
   * to declare which file they wrote. CliIntegration owns the deletion so the
   * fs operation is not duplicated across providers.
   */
  override async cleanupWorkflowArtifacts(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): Promise<void> {
    const configPath = this.provider.getMcpConfigFilePath?.(
      workingFilePath,
      workspaceRoot
    );
    if (configPath) {
      await fs.promises.unlink(configPath).catch(() => {});
    }
    // Clean up provider-specific interactive setup files (e.g., OpenCode plugin)
    const additionalPaths =
      this.provider.getAdditionalCleanupFilePaths?.(workspaceRoot) ?? [];
    for (const p of additionalPaths) {
      await fs.promises.unlink(p).catch(() => {});
    }
    // Restore workspace config files modified during interactive hook setup (e.g., Gemini, Qwen)
    await this.provider.cleanupWorkspaceArtifacts?.(
      workspaceRoot,
      workingFilePath
    );
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

  /**
   * Check if the last sendPrompt failure was due to the CLI process exiting
   * before completion was detected. All CLI harnesses are TUIs that stay open
   * between prompts, so any process exit before completion is abnormal.
   */
  override wasLastFailureProcessExit(): boolean {
    return this.failureTracker.wasLastFailureProcessExit();
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
    const responseCollector = this.createResponseCollector();

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

      const collected = await responseCollector.collectHeadlessResponse({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        promptForSessionLog: this.actualPromptSent || finalPromptText,
        executionStartTime,
        resolvedSessionId,
        label,
      });

      this.lastParsedOutput = collected.parsedOutput;
      this.lastResult = collected.cliResult;

      if (collected.extractedSessionId) {
        extractedSessionIdSetter(collected.extractedSessionId);
      }

      return collected.success;
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
    _needsCompletionDetection: boolean = true,
    workflowContext?: WorkflowContext
  ): Promise<boolean> {
    try {
      this.resetCancellationFlag();
      this.failureTracker.reset();

      const { resolvedProperties, resolvedSessionId: initialSessionId } =
        this.sessionResolverAdapter.resolve(prompt, workflowContext);
      let resolvedSessionId = initialSessionId;

      // Detect leading slash command (e.g. /handoff, /context) in the original prompt text.
      // Pure slash commands (/word only) bypass instruction assembly and are sent directly —
      // injecting skill/agent blocks into a meta-command makes no sense and would bury the
      // slash command inside a temp file where the harness won't execute it.
      // Slash commands with a body (/handoff to the next agent) are assembled normally but
      // have the slash word prepended to the temp file reference instruction so the harness
      // still picks it up as a top-level command.
      const originalPromptText = prompt.prompt.trim();
      const slashCommand = this.extractLeadingSlashCommand(originalPromptText);
      const isPureSlashCommand =
        slashCommand !== null && /^\/\w+\s*$/.test(originalPromptText);

      // Build all temp files and the final prompt argument in one step.
      // Pure slash commands bypass assembly entirely and are sent as-is.
      let promptArgument: string;
      let tempFilePaths: string[];
      if (isPureSlashCommand) {
        promptArgument = originalPromptText;
        tempFilePaths = [];
        Log.debug(
          `⚡ Slash command detected ("${slashCommand}") — skipping instruction assembly`
        );
      } else {
        const prepared = await this.buildAndPreparePrompt(
          prompt,
          workflowContext,
          resolvedProperties,
          resolvedSessionId,
          workflowContext?.promptQueue?.getFinalPromptResponseTexts()
        );
        // Prepend slash command prefix for slash+body prompts so the harness
        // executes it as a top-level command (e.g. "/handoff Follow instructions in @prompt.md")
        promptArgument = slashCommand
          ? `${slashCommand} ${prepared.promptWithInstruction.trimStart()}`
          : prepared.promptWithInstruction;
        tempFilePaths = prepared.tempFilePaths;
      }

      this.lastFullPrompt = promptArgument;

      // Log prompt
      this.logPrompt(promptArgument);

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
          promptArgument,
          tempFilePaths,
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
            this.actualPromptSent || promptArgument,
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
        this.warnIfHeadlessWithoutPermissions(
          resolvedProperties?.toolPermissions
        );

        // Build the shared response callback (single source of truth)
        const responseCallback = this.buildHeadlessResponseCallback(
          promptArgument,
          executionStartTime,
          resolvedSessionId,
          (id) => {
            extractedSessionId = id;
          }
        );

        // Claude CLI error recovery wrapper (Phase 5)
        const executeWithRecovery = async (
          args: string[]
        ): Promise<boolean> => {
          try {
            return await this.executeHeadlessWithPromptFile(
              args,
              promptArgument,
              tempFilePaths,
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
                  promptArgument,
                  executionStartTime,
                  undefined, // no session ID on retry
                  (id) => {
                    extractedSessionId = id;
                  },
                  " (retry)"
                );

                // Retry with new args — reuse same promptArgument and tempFilePaths
                return await this.executeHeadlessWithPromptFile(
                  argsWithoutResume,
                  promptArgument,
                  tempFilePaths,
                  retryCallback
                );
              }
            }
            // Re-throw if not a recoverable error
            throw error;
          }
        };

        success = await executeWithRecovery(baseArgs);
      }

      // If we resumed an existing session and log discovery didn't run (or couldn't find the log),
      // fall back to the resolved session ID — the session hasn't changed.
      if (!extractedSessionId && resolvedSessionId) {
        extractedSessionId = resolvedSessionId;
        Log.debug(
          `📝 Reusing resolved session ID (no new ID extracted): ${extractedSessionId}`
        );
      }

      if (!success && this.isCancelling && workflowContext?.promptQueue) {
        await this.promptRuntimeCoordinator.persistCancelledPromptRuntime({
          prompt,
          executionStartTime,
          extractedSessionId,
          promptQueue: workflowContext.promptQueue,
        });
      }

      if (success) {
        this.lastParsedOutput =
          await this.promptRuntimeCoordinator.persistSuccessfulPromptRuntime({
            prompt,
            resolvedProperties,
            extractedSessionId,
            parsedOutput: this.lastParsedOutput,
            promptQueue: workflowContext?.promptQueue,
          });
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
