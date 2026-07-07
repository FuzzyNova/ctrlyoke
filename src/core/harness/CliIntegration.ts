import * as fs from "fs";
import * as path from "path";
import { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import {
  resolveEffectiveAbsoluteReferences,
  type ResolverWorkspaceFolder,
} from "../../platform/WorkspaceRootResolver";
import {
  CliEvent,
  CliResult,
  UniversalCliOutput,
} from "../../types/CliOutputTypes";
import { PromptStep, McpServerConfig } from "../../types/CtrlYokeTypes";
import { WorkflowContext } from "../../types/WorkflowContextTypes";
import { HarnessIntegration, HarnessStatus } from "../HarnessIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { CliProcessManager } from "../../utils/CliProcessManager";
import type { TempFileManager } from "../../utils/TempFileManager";
import { Log } from "../../utils/Log";
import {
  EXECUTION_MODES,
  PERMISSION_MODES,
  type ExecutionMode,
  type HarnessId,
  HOOK_EVENT_ORDER,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
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
import type { HookEvent } from "../../types/CtrlYokeTypes";

/** Timeout (ms) for waiting for SessionStart hook from CLI harness */
/**
 * Execution mode for CLI integrations
 */
export type CliExecutionMode = ExecutionMode;

/**
 * Execution mode constants
 */
const CLI_EXECUTION_MODE = EXECUTION_MODES;

/**
 * Warning messages
 */
const CLI_WARNING_MESSAGES = {
  HEADLESS_WITHOUT_PERMISSIONS:
    "Headless mode with limited tool permissions: there is no interactive approval prompt, so tools that are not explicitly allowed will be auto-denied. Workflow may not make progress.",
  DONT_SHOW_AGAIN: "Don't Show Again",
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

  /** One-shot callback registered by WorkflowInstance to dispose this integration when the PTY exits. */
  private ptySessionEndedCallback?: () => void;

  /** PTY session intentionally killed for a mode handoff; its exit is not a step failure. */
  private suppressPtyExitSessionId?: string;

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

  /** Workflow display name used for logging */
  private workflowName?: string;

  /** Prevents repeating the same headless permission warning in one run. */
  private headlessPermissionWarningShown = false;

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
   * In VS Code context, reads from the file-based config service via ConfigurationUtils.
   * In CLI context, the resolved execution mode (from flags/TTY detection) is written
   * to the configService overlay in cli.ts, so ConfigurationUtils returns the correct value.
   *
   * When the platform adapter exposes a `getConfig()` method (i.e. CliAdapter), its value
   * takes precedence over the global configService. This allows callers like
   * CommitMessageGenerator to force headless mode via CliAdapter without affecting VS Code
   * user settings — mirrors the duck-typing pattern used by isVsCodeContext().
   */
  protected getExecutionMode(): CliExecutionMode {
    const adapter = this.platform as unknown as {
      getConfig?: (key: string, defaultValue: string) => string;
    };
    if (typeof adapter.getConfig === "function") {
      const mode = adapter.getConfig("cliExecutionMode", "");
      if (mode === "headless" || mode === "interactive") {
        return mode as CliExecutionMode;
      }
    }
    return ConfigurationUtils.getCliExecutionMode() as CliExecutionMode;
  }

  /**
   * Override base class getWorkspaceRoot() to use the platform adapter.
   * The platform adapter knows the true workspace root in both VS Code and CLI contexts.
   */
  protected override getWorkspaceRoot(): string | undefined {
    return this.platform.getWorkspaceRoot() || undefined;
  }

  /**
   * Override base class getWorkspaceRoots() to use the platform adapter, which
   * knows about multi-root `.code-workspace` folders in the VS Code context.
   */
  protected override getWorkspaceRoots(): string[] {
    return this.platform.getWorkspaceRoots();
  }

  /**
   * Override base class getNamedWorkspaceRoots() to use the platform adapter.
   * `CliAdapter` always returns a single named root, so multi-root behavior
   * can never trigger for the CLI binary.
   */
  protected override getNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    return this.platform.getNamedWorkspaceRoots();
  }

  /**
   * Override base class requiresAbsoluteFileReferences() to consult the
   * provider config — Antigravity hard-requires absolute paths regardless of
   * the `ui.useAbsolutePathReferences` setting or root count.
   */
  protected override requiresAbsoluteFileReferences(): boolean {
    return this.provider.config.usesAbsoluteFileReferences ?? false;
  }

  /**
   * Effective "render absolute file paths" decision for this CLI integration,
   * computed the same way as `HarnessIntegration.buildPromptSections` so
   * `formatDirectFileRef`/`formatTempFileRef` (invoked outside that method,
   * via `CliPromptPreparer`'s deps) agree with it by construction.
   */
  private getEffectiveAbsolute(): boolean {
    return resolveEffectiveAbsoluteReferences(
      ConfigurationUtils.shouldUseAbsolutePathReferences(),
      this.getWorkspaceRoots().length > 1,
      this.requiresAbsoluteFileReferences()
    );
  }

  /**
   * Set the workflow name used for VS Code terminal tab labeling.
   * Call this whenever a new workflow is loaded or renamed.
   */
  setWorkflowName(name: string | undefined): void {
    this.workflowName = name;
  }

  // ============================================================
  // ABSTRACT METHOD IMPLEMENTATIONS (DELEGATED TO PROVIDER)
  // ============================================================

  /**
   * Get the CLI-specific integration mode string (e.g., "copilot-cli", "claude-cli")
   */
  public getIntegrationMode(): HarnessId {
    return this.provider.config.harnessId as HarnessId;
  }

  /**
   * Check if configured permissions can run headless without approval prompts.
   * Used to warn users when headless execution may auto-deny needed tools.
   *
   * @param toolPermissions Resolved permissions from workflow context.
   *   - undefined: no workflow context — falls back to ConfigurationUtils global settings
   *   - null: none mode — returns false (ctrlyoke can't know what the harness allows)
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
    const refPath = this.getEffectiveAbsolute()
      ? absolutePath
      : path.relative(workspaceRoot, absolutePath);
    const quoted = refPath.includes(" ") ? `"${refPath}"` : refPath;
    return this.provider.formatFileReference?.(quoted) ?? `@${quoted}`;
  }

  /**
   * Format a temp-file relative path as a file reference using the provider's
   * harness-specific prefix (e.g. "@path" for Copilot, "path" for Claude).
   *
   * Providers with `usesAbsoluteFileReferences` (Antigravity) get the absolute
   * path so the harness can resolve it regardless of its working directory.
   */
  private formatTempFileRef(
    tempMgr: TempFileManager,
    absolutePath: string
  ): string {
    const refPath = this.getEffectiveAbsolute()
      ? absolutePath
      : tempMgr.getRelativePath(absolutePath);
    const quoted = refPath.includes(" ") ? `"${refPath}"` : refPath;
    return this.provider.formatFileReference?.(quoted) ?? `@${quoted}`;
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
      promptRefs,
      ", "
    );
  }

  // ============================================================
  // INTERACTIVE TUI EXECUTION
  // ============================================================

  /**
   * Returns true when inject mode should be used for the given session.
   *
   * Conditions:
   * 1. The global injectMode setting is enabled.
   * 2. There is a previous interactive context (PTY + log file). This is set either
   *    by a previous prompt in the same integration run, or carried over from a prior
   *    run when WorkflowInstance re-inserts the live integration into executionIntegrations.
   * 3. The prompt has resumeSession: true. Inject mode continues the existing
   *    conversation, which is semantically equivalent to resumeSession: true. A
   *    prompt with resumeSession: false requires a fresh process.
   * 4. The spawn-time configuration is compatible — model, tool permissions, hooks,
   *    MCP servers, and additional args must all match the spawned process. Any
   *    prompt-level override that changes these requires a fresh process instead.
   */
  private shouldUseInjectMode(session: CliExecutionSession): boolean {
    if (!ConfigurationUtils.isInjectModeEnabled()) {
      return false;
    }
    const ctx = this.executionRunner.getLastInteractiveContext();
    if (!ctx) {
      return false;
    }
    const promptIndex = session.workflowContext?.promptIndex ?? 0;
    const reason = CliIntegration.getInjectIncompatibilityReason(
      ctx,
      session.resolvedProperties,
      session.resolvedSessionId
    );
    if (reason) {
      Log.info(
        `↩️ Inject mode skipped for prompt ${promptIndex + 1}: ${reason} — using restart`
      );
      return false;
    }
    return true;
  }

  /**
   * Returns a human-readable reason why inject mode cannot be used, or null if compatible.
   *
   * Checks the spawn-time configuration fields that are fixed for the lifetime of a
   * Claude process. Any prompt-level override of these requires killing the current
   * process and restarting with the new args.
   */
  private static getInjectIncompatibilityReason(
    ctx: import("./shared/CliExecutionRunner").InteractiveInjectContext,
    curr: ResolvedProperties | undefined,
    currSessionId: string | undefined
  ): string | null {
    const prev = ctx.spawnedWith;

    // Explicit session ID pointing to a different session than the running one
    if (
      currSessionId !== undefined &&
      currSessionId !== ctx.sessionId &&
      currSessionId !== ctx.spawnedWithSessionId
    ) {
      return `explicit sessionId "${currSessionId}" differs from running session`;
    }

    // Inject mode keeps the TUI alive and continues the existing conversation,
    // which is semantically equivalent to resumeSession: true. If the prompt
    // requests a fresh session, we must spawn a new process instead.
    if (!curr?.resumeSession) {
      return "resumeSession is false — fresh session required";
    }

    if (!prev || !curr) {
      return null; // no stored config to compare against — allow inject
    }

    if (curr.model !== prev.model) {
      return `model changed (${prev.model} → ${curr.model})`;
    }

    if (
      JSON.stringify(curr.toolPermissions) !==
      JSON.stringify(prev.toolPermissions)
    ) {
      return "toolPermissions changed";
    }

    if (JSON.stringify(curr.hooks) !== JSON.stringify(prev.hooks)) {
      return "hooks changed";
    }

    if (JSON.stringify(curr.mcpServers) !== JSON.stringify(prev.mcpServers)) {
      return "mcpServers changed";
    }

    if ((curr.additionalArgs ?? "") !== (prev.additionalArgs ?? "")) {
      return `additionalArgs changed`;
    }

    return null;
  }

  private getInteractiveAbortState(): ReturnType<
    typeof this.failureTracker.getInteractiveAbortState
  > {
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

  private emitContextWindowUpdate(used: number, size: number): void {
    this.contextWindowUpdateEmitter.fire({ used, size });
  }

  private emitResponseComplete(response: string): void {
    this.responseCompleteEmitter.fire(response);
  }

  private handleBeforeInteractiveStart(
    _workflowContext?: WorkflowContext
  ): void {}

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

  private handleInjectedPromptPrepared(promptArgument: string): void {
    this.activeSession?.recordInjectedPrompt(promptArgument);
    this.promptReadyEmitter.fire({
      fullPrompt: promptArgument,
      cliCommand: promptArgument,
      cliCommandWasInjected: true,
    });
  }

  private handlePtyExit(session: PtySession, exitCode: number): void {
    if (this.suppressPtyExitSessionId === session.id) {
      this.suppressPtyExitSessionId = undefined;
      Log.info(
        `🛑 AI CLI PTY session ${session.id} exited after intentional mode handoff`
      );
      return;
    }

    this.failureTracker.capturePtyExit(exitCode, session.reconnectBuffer);

    // Notify WorkflowInstance that the PTY session is gone so it can clean up
    // liveInjectIntegration and dispose this integration.
    const endedCb = this.ptySessionEndedCallback;
    if (endedCb) {
      this.ptySessionEndedCallback = undefined;
      endedCb();
    }

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
    prompt: PromptStep,
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
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () =>
        ConfigurationUtils.shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume(),
      buildPromptSections: (prompt, resolvedAgent, resolvedSkills) =>
        this.buildPromptSections(prompt, resolvedAgent, resolvedSkills),
      extractLeadingSlashCommand: (promptText) =>
        this.extractLeadingSlashCommand(promptText),
      isSimplePrompt: (promptText) => this.isSimplePrompt(promptText),
      isInjectablePrompt: (promptText) => this.isInjectablePrompt(promptText),
      gatherAndMergeContextItems: (
        propertyContext,
        inlineRefs,
        allPrompts,
        promptIndex,
        finalStepResponseTexts
      ) =>
        this.gatherAndMergeContextItems(
          propertyContext,
          inlineRefs,
          allPrompts,
          promptIndex,
          finalStepResponseTexts
        ),
      buildPriorContextXmlFromItems: (items) =>
        this.buildPriorContextXmlFromItems(items),
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
      getIntegrationHarness: () => this.getIntegrationMode(),
    });

    const promptRuntimeCoordinator = new CliPromptRuntimeCoordinator({
      getIntegrationHarness: () => this.getIntegrationMode(),
    });

    const transportCoordinator = new CliTransportCoordinator({
      provider: this.provider,
      processManager: this.processManager,
      runtimeState: {
        getWorkspaceRoot: () => this.getWorkspaceRoot(),
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
        cleanupTempFiles: (tempFilePaths) =>
          this.cleanupTempFiles(tempFilePaths),
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
        cleanupTempFiles: (tempFilePaths) =>
          this.cleanupTempFiles(tempFilePaths),
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
        onContextWindowUpdate: (used, size) =>
          this.emitContextWindowUpdate(used, size),
        onNotificationEvent: (event) =>
          this.notificationEventEmitter.fire(event),
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
    session: CliExecutionSession,
    injectMode = false
  ): Promise<void> {
    const prepared = await this.promptPreparer.preparePrompt(
      session.prompt,
      session.workflowContext,
      session.resolvedProperties,
      session.resolvedSessionId,
      session.workflowContext?.getFinalStepResponseTexts?.(),
      injectMode
    );

    session.preparePrompt(
      prepared.promptWithInstruction,
      prepared.tempFilePaths
    );

    if (injectMode) {
      session.markInjectModePrepared();
    }
  }

  private createUnpreparedExecutionSession(
    prompt: PromptStep,
    workflowContext?: WorkflowContext
  ): CliExecutionSession {
    const { resolvedProperties, resolvedSessionId } =
      this.sessionResolverAdapter.resolve(prompt, workflowContext);
    return this.createExecutionSession(
      prompt,
      workflowContext,
      resolvedProperties,
      resolvedSessionId
    );
  }

  private async runExecutionSession(
    session: CliExecutionSession
  ): Promise<boolean> {
    const mode = this.getExecutionMode();
    const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;

    // Inject mode: write directly into the running TUI instead of killing and
    // restarting with --resume. Works for sequential follow-up prompts within a
    // run AND for the first prompt of a resumed workflow — when the integration is
    // reused via WorkflowInstance.liveInjectIntegration, lastInteractiveContext is
    // already populated and shouldUseInjectMode passes without needing promptIndex > 0.
    if (isInteractive && this.shouldUseInjectMode(session)) {
      this.handleInjectedPromptPrepared(session.promptArgument);
      const injectResult =
        await this.executionRunner.executeInteractiveInject(session);
      if (injectResult.injected) {
        return injectResult.success;
      }
      // Fall through to restart mode if the PTY is no longer available.
      Log.info("↩️ Inject mode unavailable — falling back to restart mode");
      await this.retireInteractivePtyForRestartFallback();
    } else if (isInteractive && this.transportCoordinator.hasLivePtySession()) {
      // Inject mode was preemptively skipped (settings changed, resumeSession: false,
      // etc.) but a live PTY from the previous step is still running. Gracefully signal
      // it before spawning a fresh one so the CLI TUI can clean up.
      await this.retireInteractivePtyForRestartFallback();
    }

    // If the session was prepared with inject-lenient rules (which can leave
    // prompts inline that contain shell-unsafe characters), re-prepare strictly
    // before any non-inject execution path (restart or headless). This covers:
    //   1. Inject attempted but PTY died → fell through above.
    //   2. shouldUseInjectMode was true in sendPrompt (prep was lenient) but
    //      returned false here (context changed between prep and dispatch).
    // Only text-only prompts (no temp files) can reach this branch, so there
    // are no orphaned files to clean up.
    if (session.wasInjectModePrepared && session.tempFilePaths.length === 0) {
      await this.initializeExecutionSession(session, false);
    }

    if (!isInteractive) {
      await this.retireInteractivePtyBeforeHeadlessResume(session);
    }

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
      const resolvedHooks = session.workflowContext?.resolvedProperties?.hooks;
      const hooksExplicitlyDisabled = resolvedHooks === null;
      const userHooks = resolvedHooks ?? undefined;
      const enabledNotificationHookEvents = hooksExplicitlyDisabled
        ? []
        : this.getEnabledHookNotificationEvents();
      const promptIndex = session.workflowContext?.promptIndex ?? 0;
      const workingFilePath = session.workflowContext?.workingFilePath;

      // Remove hook artifacts from the previous prompt before setting up new ones.
      // Providers that write per-prompt files (Copilot: .github/hooks/*.json,
      // Claude: .ctrlyoke/temp/claude-hook-settings-*.json) implement this so
      // that hooks from earlier prompts don't persist into the current prompt's run.
      // Skip when hooks are explicitly disabled (null) — no prior hooks to clean up.
      if (!hooksExplicitlyDisabled) {
        await this.provider.cleanupPreviousPromptHooks?.(workspaceRoot);
      }

      if (isInteractive) {
        // Notification hooks (ctrlyoke completion detection + user hooks combined)
        const hookArgs =
          (await this.provider.buildNotificationHookArgs?.(
            extensionPath,
            workspaceRoot,
            promptIndex,
            workingFilePath,
            userHooks,
            enabledNotificationHookEvents
          )) ?? [];
        baseArgs.push(...hookArgs);
      } else if (
        this.provider.buildHeadlessUserHookArgs &&
        !hooksExplicitlyDisabled
      ) {
        // Headless: call when the provider supports it (unless hooks explicitly disabled),
        // even with no user hooks — guarantees hooks from a previous prompt are cleared
        // before this prompt runs (providers with per-prompt files or settings.json
        // registration both handle the empty-hooks case correctly).
        const hookArgs =
          (await this.provider.buildHeadlessUserHookArgs(
            extensionPath,
            workspaceRoot,
            promptIndex,
            workingFilePath,
            userHooks,
            enabledNotificationHookEvents
          )) ?? [];
        // Prepend so hook args appear before --disallowedTools (Claude variadic flag issue)
        baseArgs.unshift(...hookArgs);
      }
    }

    // Dispatch permission args at the integration layer so providers don't have to
    // limit permissions to headless-only in buildCliArgs().
    // Use session.resolvedProperties (prompt > workflow > settings) so prompt-level
    // overrides take precedence over workflow-level defaults.
    // Merge any server-level deniedTools from McpServerConfig objects before dispatching.
    const effectiveToolPermissions = this.mergeServerDeniedTools(
      session.resolvedProperties?.toolPermissions,
      session.resolvedProperties?.mcpServers
    );
    const permissionArgs =
      this.provider.buildPermissionArgs?.(
        effectiveToolPermissions,
        isInteractive
      ) ?? [];
    baseArgs.push(...permissionArgs);

    // Append suffix args last — these are args that must follow ALL global flags.
    // Used by Codex for "resume <session-id>": a subcommand that must come after
    // --enable hooks and -c hooks.state=... to avoid them being misread as subcommand args.
    const suffixArgs =
      this.provider.buildCliSuffix?.(
        session.resolvedSessionId,
        session.workflowContext
      ) ?? [];
    if (suffixArgs.length > 0) {
      baseArgs.push(...suffixArgs);
    }

    const success = isInteractive
      ? await this.executionRunner.executeInteractive(session, baseArgs)
      : await (() => {
          this.warnIfHeadlessWithoutPermissions(effectiveToolPermissions);
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

  /**
   * Inject mode failed (PTY unavailable) so we are doing a full interactive restart
   * for this prompt. The old PTY session may still be alive or may exit soon; either
   * way its exit must not be treated as a failure for the new step.
   *
   * - Terminates it immediately if still active.
   * - Sets suppressPtyExitSessionId so a late exit event is silently ignored.
   * - Resets the failure tracker in case capturePtyExit was already called for
   *   the old PTY before we got here (e.g. exit fired during a prior await).
   * - Clears lastInteractiveContext so shouldUseInjectMode won't retry inject
   *   on the dead session.
   */
  private async retireInteractivePtyForRestartFallback(): Promise<void> {
    const activePtyId =
      await this.transportCoordinator.terminateCurrentPtySession(
        "inject fallback restart"
      );
    const lastId =
      activePtyId ?? this.transportCoordinator.getLastPtySessionId();
    if (lastId) {
      this.suppressPtyExitSessionId = lastId;
      Log.info(
        `🛑 Suppressing exit for abandoned PTY ${lastId.slice(0, 8)} after inject fallback`
      );
    }
    this.executionRunner.clearInteractiveContext();
    this.failureTracker.reset();
  }

  /**
   * Inject mode intentionally leaves the interactive TUI alive between prompts.
   * If the user switches to headless before a resume prompt, that headless
   * process must become the only owner of the resumed AI session; otherwise
   * some harnesses reject or corrupt concurrent access to the same session.
   */
  private async retireInteractivePtyBeforeHeadlessResume(
    session: CliExecutionSession
  ): Promise<void> {
    const ctx = this.executionRunner.getLastInteractiveContext();
    const resolvedSessionId = session.resolvedSessionId;
    if (!ctx || !resolvedSessionId) {
      return;
    }

    const activeSessionIds = [ctx.sessionId, ctx.spawnedWithSessionId].filter(
      (id): id is string => typeof id === "string" && id.length > 0
    );
    if (!activeSessionIds.includes(resolvedSessionId)) {
      return;
    }

    const ptySessionId =
      await this.transportCoordinator.terminateCurrentPtySession(
        `headless resume of AI session ${resolvedSessionId}`
      );
    this.executionRunner.clearInteractiveContext();

    if (ptySessionId) {
      this.suppressPtyExitSessionId = ptySessionId;
      Log.info(
        `🛑 Retired interactive PTY ${ptySessionId.slice(0, 8)} before headless resume of ${resolvedSessionId}`
      );
    }
  }

  private async persistExecutionOutcome(
    session: CliExecutionSession,
    prompt: PromptStep,
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
        parsedOutput: session.parsedOutput,
        responseText:
          session.result?.response !== session.result?.error
            ? session.result?.response
            : undefined,
        resolvedProperties: session.resolvedProperties,
        workingFilePersistence: workflowContext.workingFilePersistence,
      });
      return;
    }

    if (
      !success &&
      (this.failureTracker.wasLastFailureProcessExit() ||
        this.failureTracker.wasLastFailureHarnessError() ||
        this.failureTracker.wasLastFailureTimeout() ||
        this.failureTracker.getLastFailureKind() !== undefined) &&
      workflowContext?.workingFilePersistence
    ) {
      await this.promptRuntimeCoordinator.persistCancelledPromptRuntime({
        prompt,
        executionStartTime: session.executionStartTime,
        extractedSessionId: session.effectiveSessionId,
        parsedOutput: session.parsedOutput,
        responseText:
          session.result?.response !== session.result?.error
            ? session.result?.response
            : undefined,
        failureKind:
          session.failureKind ?? this.failureTracker.getLastFailureKind(),
        failureMessage:
          session.failureMessage ??
          this.failureTracker.getLastFailureMessage() ??
          this.lastFailureReason ??
          undefined,
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
   *  - VS Code interactive path: PTY session via PtyProcessManager
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
  // TOOL PERMISSION HELPERS
  // ============================================================

  /**
   * Merge server-level `deniedTools` from McpServerConfig objects into the tool permission config.
   *
   * Each McpServerConfig may declare bare tool names to deny (e.g. `["ctrlyoke_append_queue"]`).
   * These are translated to `mcp__<id>__<tool>` patterns and appended to the resolved deny list
   * before the harness-specific `buildPermissionArgs` call.
   *
   * Returns the original config unchanged when no server specifies `deniedTools`, keeping the
   * fast path free of allocation overhead. Returns `null` as-is (none mode — no permission flags).
   */
  private mergeServerDeniedTools(
    toolPermissions: ToolPermissionConfig | null | undefined,
    mcpServers: (string | McpServerConfig)[] | null | undefined
  ): ToolPermissionConfig | null | undefined {
    if (!mcpServers) return toolPermissions;
    const serverDenied = (mcpServers as (string | McpServerConfig)[])
      .filter(
        (s): s is McpServerConfig =>
          typeof s === "object" && s !== null && !!s.deniedTools?.length
      )
      .flatMap((s) => s.deniedTools!.map((tool) => `mcp__${s.id}__${tool}`));
    if (serverDenied.length === 0) return toolPermissions;
    if (toolPermissions === null) return null;
    const base = toolPermissions ?? {
      mode: PERMISSION_MODES.ALLOW_ALL,
      allowedTools: [],
      deniedTools: [],
    };
    return { ...base, deniedTools: [...base.deniedTools, ...serverDenied] };
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

  override getLastCliCommandWasInjected(): boolean | undefined {
    return this.lastExecutionSnapshot?.cliCommandWasInjected;
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
    const lastResult = this.lastExecutionSnapshot?.result;
    const partialResponse =
      lastResult?.response && lastResult.response !== lastResult.error
        ? lastResult.response
        : undefined;
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
   * Show warning when running in headless mode with limited permissions.
   *
   * @param toolPermissions Resolved permissions from workflow context (passed through to hasFullPermissions)
   */
  protected warnIfHeadlessWithoutPermissions(
    toolPermissions?: ToolPermissionConfig | null
  ): void {
    const mode = this.getExecutionMode();
    if (
      mode !== CLI_EXECUTION_MODE.HEADLESS ||
      this.hasFullPermissions(toolPermissions) ||
      !ConfigurationUtils.shouldShowHeadlessPermissionWarning() ||
      this.headlessPermissionWarningShown
    ) {
      return;
    }

    this.headlessPermissionWarningShown = true;
    const message = CLI_WARNING_MESSAGES.HEADLESS_WITHOUT_PERMISSIONS;

    if (this.platform.isVsCode?.()) {
      void this.platform
        .showChoice(message, CLI_WARNING_MESSAGES.DONT_SHOW_AGAIN)
        .then((choice) => {
          if (choice === CLI_WARNING_MESSAGES.DONT_SHOW_AGAIN) {
            return ConfigurationUtils.setShowHeadlessPermissionWarning(false);
          }
          return undefined;
        })
        .catch((error) =>
          Log.warn(
            "Failed to handle headless permission warning choice:",
            error
          )
        );
      return;
    }

    this.platform.warn(message);
  }

  private getEnabledHookNotificationEvents(): HookEvent[] {
    const hookSettings = configService.getAll().notifications.events.hookEvents;
    return HOOK_EVENT_ORDER.filter((event) => hookSettings[event]);
  }

  // ============================================================
  // STATUS & AVAILABILITY
  // ============================================================

  isIntegrationAvailable(): boolean {
    return this.isAvailable;
  }

  getLastSpawnedCommand(): string | undefined {
    return this.processManager.getLastSpawnedCommand();
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
   * Sends Ctrl+C to the live PTY and schedules a hard kill after 500 ms, giving
   * the CLI time to clean up before the next run spawns a fresh process.
   * Called by WorkflowInstance when the user explicitly restarts from beginning.
   */
  override closeTerminalGracefully(): void {
    this.transportCoordinator.closeTerminal();
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
   * Returns true when inject mode is configured AND the last run left a live PTY
   * session with known inject context. WorkflowInstance checks this in the
   * startWorkflowExecution finally block to decide whether to keep this integration
   * alive for the next run instead of disposing it.
   */
  override canReuseForInject(): boolean {
    const injectMode = ConfigurationUtils.isInjectModeEnabled();
    const hasCtx = this.executionRunner.hasInteractiveContext();
    const hasPty = this.transportCoordinator.hasLivePtySession();
    Log.debug(
      `[canReuseForInject] injectMode=${injectMode} hasCtx=${hasCtx} hasPty=${hasPty}`
    );
    return injectMode && hasCtx && hasPty;
  }

  /**
   * Reset per-run mutable state before this integration is reused for a new workflow
   * execution. Clears cancellation/failure flags and the failure tracker so the new
   * run starts with a clean slate.
   */
  override resetForNewRun(): void {
    super.resetForNewRun();
    this.failureTracker.reset();
    this.activeSession = undefined;
    this.ptySessionEndedCallback = undefined;
    this.headlessPermissionWarningShown = false;
  }

  /**
   * Register a one-shot callback that fires when the PTY session underlying this
   * integration exits. Used by WorkflowInstance to clean up liveInjectIntegration
   * when the user kills the terminal between runs.
   */
  override onPtySessionEnded(callback: () => void): void {
    this.ptySessionEndedCallback = callback;
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

  override wasLastFailureHarnessError(): boolean {
    return this.failureTracker.wasLastFailureHarnessError();
  }

  override wasLastFailureTimeout(): boolean {
    return this.failureTracker.wasLastFailureTimeout();
  }

  override getLastFailureKind() {
    return this.failureTracker.getLastFailureKind();
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
    prompt: PromptStep,
    _needsCompletionDetection: boolean = true,
    workflowContext?: WorkflowContext
  ): Promise<boolean> {
    let executionSession: CliExecutionSession | undefined;

    try {
      this.resetCancellationFlag();
      this.failureTracker.reset();

      // Create session without prompt preparation so we can check inject mode
      // before deciding which inline-check rules to apply.
      executionSession = this.createUnpreparedExecutionSession(
        prompt,
        workflowContext
      );
      this.activeSession = executionSession;

      const isInteractive =
        this.getExecutionMode() === CLI_EXECUTION_MODE.INTERACTIVE;
      const injectMode =
        isInteractive && this.shouldUseInjectMode(executionSession);
      await this.initializeExecutionSession(executionSession, injectMode);

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
    }
  }
}
