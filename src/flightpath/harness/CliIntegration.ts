import * as fs from "fs";
import * as path from "path";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import {
  CliEvent,
  CliResult,
  UniversalCliOutput,
} from "../../types/CliOutputTypes";
import { PromptItem, Harness } from "../../types/FlightPathTypes";
import { WorkflowContext } from "../../types/WorkflowContextTypes";
import { HarnessIntegration, HarnessStatus } from "../HarnessIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { CliProcessManager } from "../../utils/CliProcessManager";
import type { TempFileManager } from "../../utils/TempFileManager";
import { Log } from "../../utils/Log";
import {
  EXECUTION_MODES,
  type ExecutionMode,
} from "../../types/DashboardConstants";
import type { ICliProvider } from "./shared/interfaces/ICliProvider";
import type { ToolPermissionConfig } from "./shared/interfaces/IToolPermissionMapper";
import { CliFailureTracker } from "./shared/CliFailureTracker";
import {
  CliExecutionSession,
  type CliExecutionSessionSnapshot,
} from "./shared/CliExecutionSession";
import { CliExecutionRunner } from "./shared/CliExecutionRunner";
import { CliInteractiveStartupCoordinator } from "./shared/CliInteractiveStartupCoordinator";
import { CliPromptPreparer } from "./shared/CliPromptPreparer";
import { CliPromptRuntimeCoordinator } from "./shared/CliPromptRuntimeCoordinator";
import { CliResponseCollector } from "./shared/CliResponseCollector";
import { CliSessionResolverAdapter } from "./shared/CliSessionResolverAdapter";
import { CliTransportCoordinator } from "./shared/CliTransportCoordinator";
import type { ResolvedProperties } from "../../utils/PropertyResolver";
import type { PtySession } from "./PtyProcessManager";

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

interface CliIntegrationServices {
  promptPreparer: CliPromptPreparer;
  sessionResolverAdapter: CliSessionResolverAdapter;
  promptRuntimeCoordinator: CliPromptRuntimeCoordinator;
  transportCoordinator: CliTransportCoordinator;
  executionRunner: CliExecutionRunner;
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

  /** Last execution snapshot exposed through getLast* accessors. */
  private lastExecutionSnapshot?: CliExecutionSessionSnapshot;

  /** Active per-prompt session while sendPrompt() is running. */
  private activeSession?: CliExecutionSession;

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

  /** Execution orchestration helper extracted from CliIntegration. */
  private readonly executionRunner: CliExecutionRunner;

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

    const services = this.createServices();
    this.promptPreparer = services.promptPreparer;
    this.sessionResolverAdapter = services.sessionResolverAdapter;
    this.promptRuntimeCoordinator = services.promptRuntimeCoordinator;
    this.transportCoordinator = services.transportCoordinator;
    this.executionRunner = services.executionRunner;
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

  private setFailureReason(reason: string): void {
    this.lastFailureReason = reason;
  }

  private emitStreamingChunk(chunk: string): void {
    this.streamingChunkEmitter.fire(chunk);
  }

  private emitStreamingEvents(events: CliEvent[]): void {
    this.streamingEventsEmitter.fire(events);
  }

  private emitResponseComplete(response: string): void {
    this.responseCompleteEmitter.fire(response);
  }

  private handleBeforeInteractiveStart(
    workflowContext?: WorkflowContext
  ): void {
    if (workflowContext) {
      this.currentPromptNumber = workflowContext.promptIndex + 1;
      this.currentPromptTotal = workflowContext.allPrompts.length;
    }
  }

  private handleCommandPrepared(params: {
    promptArgument: string;
    cliCommand: string;
  }): void {
    this.activeSession?.recordCommandPrepared(params);
    this.promptReadyEmitter.fire({
      fullPrompt: params.promptArgument,
      cliCommand: params.cliCommand,
    });
  }

  private handlePtyExit(session: PtySession, exitCode: number): void {
    this.failureTracker.capturePtyExit(exitCode, session.reconnectBuffer);
    if (exitCode !== 0) {
      Log.warn(
        `⚠️ AI CLI PTY session ${session.id} exited with code ${exitCode} — workflow step will be stopped`
      );
      return;
    }

    Log.info(
      `🛑 AI CLI PTY session ${session.id} exited with code 0 before completion — workflow step will be stopped`
    );
  }

  private createInteractiveStartupCoordinator(): CliInteractiveStartupCoordinator {
    return new CliInteractiveStartupCoordinator({
      logParser: this.provider.logParser!,
      notificationMonitor: this.provider.notificationMonitor,
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      getAbortState: () => this.getInteractiveAbortState(),
      markProcessExitDuringStage: (stage, exitCode) =>
        this.failureTracker.markProcessExitDuringStage(stage, exitCode),
      setFailureReason: (reason) => this.setFailureReason(reason),
    });
  }

  private createResponseCollector(): CliResponseCollector {
    return new CliResponseCollector({
      provider: this.provider,
      hostCallbacks: {
        logResponse: (response, statistics) =>
          this.logResponse(response, statistics),
        onResponseComplete: (response) => this.emitResponseComplete(response),
      },
    });
  }

  private applyExecutionSession(session: CliExecutionSession): void {
    this.lastExecutionSnapshot = session.toSnapshot();
  }

  private createExecutionSession(
    prompt: PromptItem,
    workflowContext: WorkflowContext | undefined,
    resolvedProperties: ResolvedProperties | undefined,
    resolvedSessionId: string | undefined
  ): CliExecutionSession {
    this.lastExecutionSnapshot = undefined;
    return new CliExecutionSession({
      prompt,
      workflowContext,
      resolvedProperties,
      resolvedSessionId,
    });
  }

  private createServices(): CliIntegrationServices {
    const promptPreparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () =>
        ConfigurationUtils.shouldOmitAgentsAndSkillsOnResume(),
      buildPromptSections: (prompt, resolvedAgent, resolvedSkills) =>
        this.buildPromptSections(prompt, resolvedAgent, resolvedSkills),
      extractLeadingSlashCommand: (promptText) =>
        this.extractLeadingSlashCommand(promptText),
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
    });

    const sessionResolverAdapter = new CliSessionResolverAdapter({
      getIntegrationHarness: () => this.getIntegrationMode() as Harness,
    });

    const promptRuntimeCoordinator = new CliPromptRuntimeCoordinator({
      getIntegrationHarness: () => this.getIntegrationMode() as Harness,
    });

    const transportCoordinator = new CliTransportCoordinator({
      provider: this.provider,
      processManager: this.processManager,
      runtimeState: {
        getWorkspaceRoot: () => this.getWorkspaceRoot(),
        getTerminalName: () => this.buildTerminalName(),
        getWorkflowName: () => this.workflowName,
        isCancelling: () => this.isCancelling,
      },
      hostCallbacks: {
        onBeforeInteractiveStart: (workflowContext) =>
          this.handleBeforeInteractiveStart(workflowContext),
        onCommandPrepared: (params) => this.handleCommandPrepared(params),
        onStreamingChunk: (chunk) => this.emitStreamingChunk(chunk),
        onStreamingEvents: (events) => this.emitStreamingEvents(events),
        onResponseComplete: (response) => this.emitResponseComplete(response),
        onPtyExit: (session, exitCode) => this.handlePtyExit(session, exitCode),
        cleanupTempFiles: (tempFilePaths) => this.cleanupTempFiles(tempFilePaths),
      },
    });

    const executionRunner = new CliExecutionRunner({
      provider: this.provider,
      transportCoordinator,
      failureTracker: this.failureTracker,
      factories: {
        createInteractiveStartupCoordinator: () =>
          this.createInteractiveStartupCoordinator(),
        createResponseCollector: () => this.createResponseCollector(),
        cleanupTempFiles: (tempFilePaths) => this.cleanupTempFiles(tempFilePaths),
      },
      runtimeState: {
        getWorkspaceRoot: () => this.getWorkspaceRoot(),
        getExtensionPath: () => this.platform.getExtensionPath(),
        isVsCodeContext: () => this.isVsCodeContext(),
        isCancelling: () => this.isCancelling,
        setFailureReason: (reason) => this.setFailureReason(reason),
      },
      hostCallbacks: {
        onStreamingEvents: (events) => this.emitStreamingEvents(events),
        onResponseComplete: (response) => this.emitResponseComplete(response),
        logResponse: (response, statistics) =>
          this.logResponse(response, statistics),
      },
    });

    return {
      promptPreparer,
      sessionResolverAdapter,
      promptRuntimeCoordinator,
      transportCoordinator,
      executionRunner,
    };
  }

  private async initializeExecutionSession(
    session: CliExecutionSession
  ): Promise<void> {
    const prepared = await this.promptPreparer.preparePrompt(
      session.prompt,
      session.workflowContext,
      session.resolvedProperties,
      session.resolvedSessionId,
      session.workflowContext?.getFinalPromptResponseTexts?.()
    );

    session.preparePrompt(
      prepared.promptWithInstruction,
      prepared.tempFilePaths
    );
  }

  private async createPreparedExecutionSession(
    prompt: PromptItem,
    workflowContext?: WorkflowContext
  ): Promise<CliExecutionSession> {
    const { resolvedProperties, resolvedSessionId } =
      this.sessionResolverAdapter.resolve(prompt, workflowContext);
    const session = this.createExecutionSession(
      prompt,
      workflowContext,
      resolvedProperties,
      resolvedSessionId
    );
    await this.initializeExecutionSession(session);
    return session;
  }

  private async runExecutionSession(
    session: CliExecutionSession
  ): Promise<boolean> {
    const mode = this.getExecutionMode();
    const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;
    const workspaceRoot = this.getWorkspaceRoot();
    const extensionPath = this.platform.getExtensionPath();

    const baseArgs = await this.provider.buildCliArgs(
      session.prompt,
      isInteractive,
      extensionPath,
      workspaceRoot,
      session.resolvedSessionId,
      session.workflowContext
    );

    // Dispatch hook setup at the integration layer so providers don't have to
    // remember to handle both interactive and headless cases in buildCliArgs().
    if (workspaceRoot) {
      const userHooks =
        session.workflowContext?.resolvedProperties?.hooks ?? undefined;
      const promptIndex = session.workflowContext?.promptIndex ?? 0;
      const workingFilePath = session.workflowContext?.workingFilePath;

      if (isInteractive) {
        // Notification hooks (FlightPath completion detection + user hooks combined)
        const hookArgs =
          (await this.provider.buildNotificationHookArgs?.(
            extensionPath,
            workspaceRoot,
            promptIndex,
            workingFilePath,
            userHooks
          )) ?? [];
        baseArgs.push(...hookArgs);
      } else if (userHooks?.length) {
        // Headless: user hooks only (no FlightPath notification hooks needed)
        const hookArgs =
          (await this.provider.buildHeadlessUserHookArgs?.(
            workspaceRoot,
            promptIndex,
            workingFilePath,
            userHooks
          )) ?? [];
        // Prepend so hook args appear before --disallowedTools (Claude variadic flag issue)
        baseArgs.unshift(...hookArgs);
      }
    }

    // Dispatch permission args at the integration layer so providers don't have to
    // limit permissions to headless-only in buildCliArgs().
    const permissionArgs =
      this.provider.buildPermissionArgs?.(
        session.workflowContext?.resolvedProperties?.toolPermissions
      ) ?? [];
    baseArgs.push(...permissionArgs);

    const success = isInteractive
      ? await this.executionRunner.executeInteractive(session, baseArgs)
      : await (() => {
          this.warnIfHeadlessWithoutPermissions(
            session.resolvedProperties?.toolPermissions
          );
          return this.executionRunner.executeHeadless(session, baseArgs);
        })();

    if (!session.effectiveSessionId && session.resolvedSessionId) {
      session.setExtractedSessionId(session.resolvedSessionId);
      Log.debug(
        `📝 Reusing resolved session ID (no new ID extracted): ${session.effectiveSessionId}`
      );
    }

    return success;
  }

  private async persistExecutionOutcome(
    session: CliExecutionSession,
    prompt: PromptItem,
    workflowContext: WorkflowContext | undefined,
    success: boolean
  ): Promise<void> {
    if (
      !success &&
      this.isCancelling &&
      workflowContext?.workingFilePersistence
    ) {
      await this.promptRuntimeCoordinator.persistCancelledPromptRuntime({
        prompt,
        executionStartTime: session.executionStartTime,
        extractedSessionId: session.effectiveSessionId,
        resolvedProperties: session.resolvedProperties,
        workingFilePersistence: workflowContext.workingFilePersistence,
      });
      return;
    }

    if (!success && this.failureTracker.wasLastFailureProcessExit() && workflowContext?.workingFilePersistence) {
      await this.promptRuntimeCoordinator.persistCancelledPromptRuntime({
        prompt,
        executionStartTime: session.executionStartTime,
        extractedSessionId: session.effectiveSessionId,
        resolvedProperties: session.resolvedProperties,
        workingFilePersistence: workflowContext.workingFilePersistence,
      });
      return;
    }

    if (!success) {
      return;
    }

    const persistedOutput =
      await this.promptRuntimeCoordinator.persistSuccessfulPromptRuntime({
        prompt,
        resolvedProperties: session.resolvedProperties,
        extractedSessionId: session.effectiveSessionId,
        parsedOutput: session.parsedOutput,
        workingFilePersistence: workflowContext?.workingFilePersistence,
      });
    session.updateParsedOutput(persistedOutput);
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
    return this.lastExecutionSnapshot?.result;
  }

  /**
   * Get the last parsed output with structured data.
   * Contains tool calls, thinking blocks, and metadata.
   * Returns undefined if no parsed output is available (e.g., non-CLI integrations).
   */
  getLastParsedOutput(): UniversalCliOutput | undefined {
    return this.lastExecutionSnapshot?.parsedOutput;
  }

  /**
   * Get the last CLI command executed
   */
  getLastCliCommand(): string | undefined {
    return this.lastExecutionSnapshot?.cliCommand;
  }

  override getLastFailureOutput(): string | undefined {
    const ptyTail = this.failureTracker.getLastFailureOutput();
    if (ptyTail) {
      return ptyTail;
    }
    // Fall back to partial response captured from the log (user-cancelled stop case).
    // The log monitor flushes accumulated events on cancel and stores them on the
    // session; applyExecutionSession() copies them to lastExecutionSnapshot before
    // sendPrompt() returns, so the partial text is available here.
    const partialResponse = this.lastExecutionSnapshot?.result?.response;
    return partialResponse || undefined;
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
      this.lastFailureReason = "Stopped by user";
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
    let executionSession: CliExecutionSession | undefined;

    try {
      this.resetCancellationFlag();
      this.failureTracker.reset();

      executionSession = await this.createPreparedExecutionSession(
        prompt,
        workflowContext
      );
      this.activeSession = executionSession;

      // Log prompt
      this.logPrompt(executionSession.promptArgument);

      const success = await this.runExecutionSession(executionSession);
      await this.persistExecutionOutcome(
        executionSession,
        prompt,
        workflowContext,
        success
      );

      return success;
    } catch (error) {
      Log.error("❌ Error sending prompt", error);
      this.lastFailureReason =
        error instanceof Error ? error.message : "Unknown error";
      return false;
    } finally {
      if (executionSession) {
        this.applyExecutionSession(executionSession);
      }
      this.activeSession = undefined;
      this.currentPromptNumber = undefined;
      this.currentPromptTotal = undefined;
    }
  }
}
