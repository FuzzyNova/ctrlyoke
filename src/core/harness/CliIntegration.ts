import * as fs from "fs";
import * as path from "path";
import {
  createNoWorktreeExecutionWorkspace,
  PlatformAdapter,
} from "../../platform/PlatformAdapter";
import type { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import {
  mapSourceDefinitionPathToExecution,
  resolveEffectiveAbsoluteReferences,
  type ResolverWorkspaceFolder,
} from "../../platform/WorkspaceRootResolver";
import {
  CliEvent,
  CliResult,
  ContextWindowSyncData,
  UniversalCliOutput,
} from "../../types/CliOutputTypes";
import { PromptStep } from "../../types/CtrlYokeTypes";
import {
  WorkflowContext,
  type ExecutionWorkspace,
  getExecutionWorkspaceIdentity,
} from "../../types/WorkflowContextTypes";
import {
  HarnessIntegration,
  HarnessStatus,
  type WorkflowArtifactCleanupResult,
} from "../HarnessIntegration";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { CliProcessManager } from "../../utils/CliProcessManager";
import { TempFileManager } from "../../utils/TempFileManager";
import { Log } from "../../utils/Log";
import {
  CLI_EVENT_TYPES,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  formatContextResolutionFailureMessage,
  isContextResolutionDiagnostic,
  type ExecutionMode,
  type HarnessId,
  HARNESS_IDS,
  HOOK_EVENT_ORDER,
  USER_FEEDBACK_SEVERITY,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import type {
  CliExecutionSidecar,
  ICliProvider,
} from "./shared/interfaces/ICliProvider";
import type { HarnessQuotaSnapshot } from "../../types/UsageTypes";
import type { ToolPermissionConfig } from "./shared/interfaces/IToolPermissionMapper";
import { CliFailureTracker } from "./shared/CliFailureTracker";
import {
  CliExecutionSession,
  type CliExecutionSessionSnapshot,
} from "./shared/CliExecutionSession";
import { CliExecutionRunner } from "./shared/CliExecutionRunner";
import { SessionActivityWatcher } from "./SessionActivityWatcher";
import { CliInteractiveStartupCoordinator } from "./shared/CliInteractiveStartupCoordinator";
import { CliPromptPreparer } from "./shared/CliPromptPreparer";
import { CliPromptRuntimeCoordinator } from "./shared/CliPromptRuntimeCoordinator";
import { CliResponseCollector } from "./shared/CliResponseCollector";
import { CliSessionResolverAdapter } from "./shared/CliSessionResolverAdapter";
import { CliTransportCoordinator } from "./shared/CliTransportCoordinator";
import { ExecutionPlanBuilder } from "./shared/ExecutionPlanBuilder";
import type { ExecutionPreviewHarness } from "../ExecutionPreviewService";
import type { ResolvedProperties } from "../../utils/PropertyResolver";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import type { PtySession } from "./PtyProcessManager";
import type { HookEvent } from "../../types/CtrlYokeTypes";
import { notifyUserFeedback, type UserFeedbackSink } from "../UserFeedbackSink";
import { SETTINGS_JSON_INSTALL_KIND_WRITTEN } from "./shared/SettingsJsonMcpTracker";
import { resolveSecretEnvironment } from "../../utils/SecretResolver";
import { type RunSecretRedactor } from "../../utils/SecretRedactionService";

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
} as const;

interface CliIntegrationServices {
  promptPreparer: CliPromptPreparer;
  sessionResolverAdapter: CliSessionResolverAdapter;
  promptRuntimeCoordinator: CliPromptRuntimeCoordinator;
  transportCoordinator: CliTransportCoordinator;
  executionRunner: CliExecutionRunner;
  executionPlanBuilder: ExecutionPlanBuilder;
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

  /** Immutable roots captured for this execution integration. */
  private readonly executionWorkspace: ExecutionWorkspace;

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
  private activeSecretRedactor?: RunSecretRedactor;

  // NOTE: currentProcess field removed — the child process lives in processManager,
  // not on this class. See processManager.isActive() for process state.

  /** Process/terminal manager for CLI execution */
  protected processManager: CliProcessManager;

  /** Tracks PTY exits, process-exit classification, and captured PTY tail output. */
  private readonly failureTracker = new CliFailureTracker();

  /** One-shot callback registered by WorkflowInstance to dispose this integration when the PTY exits. */
  private ptySessionEndedCallback?: () => void;

  /** Layer 1 safety net: tails the live session log after a prompt's CliLogMonitor
   *  resolves, so resumed background-task output and human TUI steers aren't lost. */
  private sessionActivityWatcher?: SessionActivityWatcher;

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

  /** Shared side-effect-free execution-plan assembly used by launch paths. */
  private readonly executionPlanBuilder: ExecutionPlanBuilder;

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
    registerWithContext: boolean = true,
    private readonly userFeedbackSink?: UserFeedbackSink,
    private readonly onProviderUsageUpdate?: (
      quota: HarnessQuotaSnapshot
    ) => void,
    executionWorkspace: ExecutionWorkspace = createNoWorktreeExecutionWorkspace(
      platform
    )
  ) {
    // Pass ExtensionContext to base class if available (VS Code context) for subscription management
    const vsCtx =
      "getExtensionContext" in platform
        ? (platform as VsCodeAdapter).getExtensionContext()
        : undefined;
    super(vsCtx, registerWithContext);
    this.platform = platform;
    this.provider = cliProvider;
    this.executionWorkspace = executionWorkspace;
    this.processManager = new CliProcessManager(
      this.getExecutionRoot() || "",
      (msg) => Log.debug(msg)
    );
    // Propagate workspace root to the log parser for session log discovery.
    // For example, ClaudeLogParser uses this to locate ~/.claude/projects/<workspace>.
    const workspaceRoot = this.getExecutionRoot();
    const logParser = this.provider.logParser;
    if (workspaceRoot && logParser?.setWorkspaceRoot) {
      logParser.setWorkspaceRoot(workspaceRoot);
    }

    const services = this.createServices();
    this.promptPreparer = services.promptPreparer;
    this.sessionResolverAdapter = services.sessionResolverAdapter;
    this.promptRuntimeCoordinator = services.promptRuntimeCoordinator;
    this.transportCoordinator = services.transportCoordinator;
    this.executionRunner = services.executionRunner;
    this.executionPlanBuilder = services.executionPlanBuilder;
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
   * user settings — the optional PlatformAdapter hook keeps that compatibility
   * behavior explicit without widening the global config service.
   */
  protected getExecutionMode(): CliExecutionMode {
    if (this.platform.getConfig) {
      const mode = this.platform.getConfig("cliExecutionMode", "");
      if (
        mode === EXECUTION_MODES.HEADLESS ||
        mode === EXECUTION_MODES.INTERACTIVE
      ) {
        return mode as CliExecutionMode;
      }
    }
    return ConfigurationUtils.getCliExecutionMode() as CliExecutionMode;
  }

  /**
   * Get the execution mode resolved for one session.
   *
   * The integration-level setting remains the fallback for callers that do not
   * have a workflow session, such as commit-message generation.
   */
  private sessionExecutionMode(session: CliExecutionSession): CliExecutionMode {
    return session.resolvedProperties?.executionMode ?? this.getExecutionMode();
  }

  /**
   * Override base class getWorkspaceRoot() to use the platform adapter.
   * The platform adapter knows the true workspace root in both VS Code and CLI contexts.
   */
  protected override getWorkspaceRoot(): string | undefined {
    return this.getStateRoot() || undefined;
  }

  /** Root containing ctrlyoke state, workflow files, and MCP state identity. */
  public getStateRoot(): string {
    return this.executionWorkspace.stateRoot;
  }

  /** Root used for harness cwd, temp files, hooks, and workspace-local config. */
  public getExecutionRoot(): string {
    return this.executionWorkspace.executionRoot;
  }

  /** Immutable execution-workspace contract used to construct this integration. */
  public getExecutionWorkspace(): ExecutionWorkspace {
    return this.executionWorkspace;
  }

  override getExecutionWorkspaceIdentity(): string {
    return getExecutionWorkspaceIdentity(this.executionWorkspace);
  }

  protected override getExecutionWorkspaceRoot(): string | undefined {
    return this.getExecutionRoot() || undefined;
  }

  protected override getExecutionSourceCheckoutRoot(): string | undefined {
    return this.executionWorkspace.sourceCheckoutRoot;
  }

  protected override getExecutionCheckoutRoot(): string | undefined {
    return this.executionWorkspace.executionCheckoutRoot;
  }

  /**
   * Override base class getWorkspaceRoots() to use the platform adapter, which
   * knows about multi-root `.code-workspace` folders in the VS Code context.
   */
  protected override getWorkspaceRoots(): string[] {
    return this.platform.getWorkspaceRoots();
  }

  protected override getExecutionWorkspaceRoots(): string[] {
    return [...this.executionWorkspace.workspaceRoots];
  }

  protected override getExecutionNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
    return this.executionWorkspace.namedWorkspaceRoots.map((root) => ({
      ...root,
    }));
  }

  protected override getApprovedExternalRoots(): string[] {
    return [...this.executionWorkspace.approvedExternalRoots];
  }

  protected override getExecutionSourceDefinitionPath(): string | undefined {
    return mapSourceDefinitionPathToExecution(
      this.sourceDefinitionPath,
      this.executionWorkspace.sourceCheckoutRoot,
      this.executionWorkspace.executionCheckoutRoot
    ).executionPath;
  }

  protected override allowsWorkflowRelativeReferences(): boolean {
    return mapSourceDefinitionPathToExecution(
      this.sourceDefinitionPath,
      this.executionWorkspace.sourceCheckoutRoot,
      this.executionWorkspace.executionCheckoutRoot
    ).allowWorkflowRelativeReferences;
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
   * Effective "render absolute file paths" decision for this CLI integration,
   * computed the same way as `HarnessIntegration.buildPromptSections` so
   * `formatDirectFileRef`/`formatTempFileRef` (invoked outside that method,
   * via `CliPromptPreparer`'s deps) agree with it by construction.
   */
  private getEffectiveAbsolute(): boolean {
    return resolveEffectiveAbsoluteReferences(
      ConfigurationUtils.shouldUseAbsolutePathReferences(),
      this.getExecutionWorkspaceRoots().length > 1
    );
  }

  /**
   * Set the workflow name used for VS Code terminal tab labeling.
   * Call this whenever a new workflow is loaded or renamed.
   */
  setWorkflowName(name: string | undefined): void {
    this.workflowName = name;
  }

  /** Expose the exact shared planning helpers to execution-preview consumers. */
  public getExecutionPreviewHarness(): ExecutionPreviewHarness {
    return {
      provider: this.provider,
      promptPreparer: this.promptPreparer,
      executionPlanBuilder: this.executionPlanBuilder,
    };
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

  // ============================================================
  // PROMPT PREPARATION
  // ============================================================

  /**
   * Format an already-quoted path using the provider's formatFileReference()
   * override for a harness-specific prefix (e.g. Codex drops the `@`).
   * Single source for every `@`-ref formatting decision in this class.
   */
  private formatFileReferenceToken(quoted: string): string {
    return this.provider.formatFileReference?.(quoted) ?? `@${quoted}`;
  }

  /**
   * Format a workspace-relative or absolute path as a direct file reference,
   * with space-quoting applied when the path contains spaces.
   * Uses the provider's formatFileReference() override for harness-specific prefix.
   */
  private formatDirectFileRef(absolutePath: string): string {
    const workspaceRoot = this.getExecutionRoot();
    const refPath = this.getEffectiveAbsolute()
      ? absolutePath
      : path.relative(workspaceRoot, absolutePath);
    const quoted = refPath.includes(" ") ? `"${refPath}"` : refPath;
    return this.formatFileReferenceToken(quoted);
  }

  /**
   * Format a temp-file relative path as a file reference using the provider's
   * harness-specific prefix (e.g. "@path" for Copilot, "path" for Claude).
   *
   * Renders absolute when `getEffectiveAbsolute()` is true (multi-root, or the
   * `ui.useAbsolutePathReferences` setting in single-root).
   */
  private formatTempFileRef(
    tempMgr: TempFileManager,
    absolutePath: string
  ): string {
    const refPath = this.getEffectiveAbsolute()
      ? absolutePath
      : tempMgr.getRelativePath(absolutePath);
    const quoted = refPath.includes(" ") ? `"${refPath}"` : refPath;
    return this.formatFileReferenceToken(quoted);
  }

  /**
   * Override of {@link HarnessIntegration.formatInlineFileReference}: routes
   * literal `@path` mentions found inline in prompt text through the same
   * provider hook as ctrlyoke-generated refs, so e.g. Codex's "no @ prefix"
   * requirement applies uniformly regardless of where the reference came from.
   */
  protected formatInlineFileReference(quotedPath: string): string {
    return this.formatFileReferenceToken(quotedPath);
  }

  /**
   * Format categorized file references into a structured instruction string.
   *
   * Format (absent categories omitted):
   *   Following these agent instructions @agent.1.md[, @agent.2.md],
   *   using these secrets @secrets.md,
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
   * @param secretRefs Formatted file refs for the available-secrets block
   */
  protected formatCategorizedReferences(
    agentRefs: string[],
    skillRefs: string[],
    directRefs: string[],
    contextRefs: string[],
    excerptRefs: string[],
    promptRefs: string[],
    secretRefs: string[] = []
  ): string {
    return CliIntegration.formatCategorizedInstruction(
      agentRefs,
      skillRefs,
      directRefs,
      contextRefs,
      excerptRefs,
      promptRefs,
      ", ",
      secretRefs
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

    if (!prev) {
      return "spawnedWith snapshot is missing — cannot verify spawn-time configuration";
    }
    if (!curr) {
      return "current resolved properties are missing — cannot verify spawn-time configuration";
    }

    // Inject mode keeps the TUI alive and continues the existing conversation,
    // which is semantically equivalent to resumeSession: true. If the prompt
    // requests a fresh session, we must spawn a new process instead.
    if (!curr.resumeSession) {
      return "resumeSession is false — fresh session required";
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

  // Deliberately not redacted: these emitters carry the harness's canonical,
  // still-in-progress response. WorkflowExecutor consumes their payloads to
  // build `$prior-context`/`$step:N` for later prompts and the runtime
  // output cache (see PromptQueue.cacheRuntimeOutput), so pre-redacting here
  // would send the model back its own corrupted output next turn — the same
  // failure mode that broke the standalone shim's generated JS. Every
  // downstream consumer that actually persists or displays this content
  // (TimelineRecorder, dashboard/hosted transports, OutputHistoryManager via
  // TimelineRecorder, CLI output, Markdown export) redacts independently at
  // its own boundary, so removing this pass does not weaken that protection.
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

  private emitSessionActivityResumed(events: CliEvent[]): void {
    this.sessionActivityResumedEmitter.fire({ events });
  }

  /**
   * Start (or resume) the Layer 1 session-activity watcher after an interactive
   * prompt has finished and the PTY is still alive. Reuses the same `ILogParser`
   * instance the prompt's `CliLogMonitor` just used, so no read-offset hand-off
   * is needed — see `SessionActivityWatcher` for the one-reader rationale.
   */
  private resumeSessionActivityWatcher(
    model: string,
    mode: CliExecutionMode
  ): void {
    if (mode !== CLI_EXECUTION_MODE.INTERACTIVE) {
      return;
    }
    if (!this.transportCoordinator.hasLivePtySession()) {
      return;
    }
    const ctx = this.executionRunner.getLastInteractiveContext();
    if (!ctx) {
      return;
    }

    if (this.sessionActivityWatcher) {
      this.sessionActivityWatcher.resume();
      return;
    }

    this.sessionActivityWatcher = new SessionActivityWatcher({
      parser: this.provider.logParser!,
      model,
      onResumedEvents: (events) => this.emitSessionActivityResumed(events),
      // Unlike the per-step CliLogMonitor pathway (which feeds the live
      // running-step gauge via emitContextWindowUpdate — a listener that's
      // disposed the moment the step's dispatch resolves), this fires *after*
      // the step is already done. Route it through the same session-activity
      // channel as resumed events instead, as an invisible marker event, so
      // WorkflowInstance can refresh the completed step's stats footer.
      onContextWindowUpdate: (used, size) =>
        this.emitSessionActivityResumed([
          {
            type: CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC,
            timestamp: Date.now(),
            data: { used, size } satisfies ContextWindowSyncData,
          },
        ]),
    });
    this.sessionActivityWatcher.start(ctx.logPath);
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
    this.sessionActivityWatcher?.stop();
    this.sessionActivityWatcher = undefined;

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
      getWorkspaceRoot: () => this.getExecutionRoot(),
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
    this.activeSecretRedactor = workflowContext?.secretRedactor;
    return new CliExecutionSession({
      prompt,
      workflowContext: workflowContext
        ? { ...workflowContext, stateRoot: this.getStateRoot() }
        : undefined,
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
      buildPriorContextXmlFromItems: (items) =>
        this.buildPriorContextXmlFromItems(items),
      getWorkspaceRoot: () => this.getExecutionRoot(),
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
        promptRefs,
        secretRefs
      ) =>
        this.formatCategorizedReferences(
          agentRefs,
          skillRefs,
          directRefs,
          contextRefs,
          excerptRefs,
          promptRefs,
          secretRefs
        ),
      isSecretAvailable: async (name) => {
        try {
          await resolveSecretEnvironment([name], {
            workspaceRoot: this.platform.getWorkspaceRoot(),
            secretStore: this.platform.getSecretStore?.(),
          });
          return true;
        } catch {
          return false;
        }
      },
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
        getWorkspaceRoot: () => this.getExecutionRoot(),
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
      resolveSecretEnvironment: async (names) => {
        const values = await resolveSecretEnvironment(names, {
          workspaceRoot: this.platform.getWorkspaceRoot(),
          secretStore: this.platform.getSecretStore?.(),
        });
        this.activeSecretRedactor?.addResolvedValues(values);
        return values;
      },
    });

    const executionPlanBuilder = new ExecutionPlanBuilder({
      provider: this.provider,
      getWorkspaceRoot: () => this.getExecutionRoot(),
      getWorkspaceRoots: () => this.getExecutionWorkspaceRoots(),
      getApprovedExternalRoots: () => this.getApprovedExternalRoots(),
      getStateRoot: () => this.getStateRoot(),
      getExtensionPath: () => this.platform.getExtensionPath(),
      getExecutionMode: () => this.getExecutionMode(),
      getEnabledHookNotificationEvents: () =>
        this.getEnabledHookNotificationEvents(),
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
        getWorkspaceRoot: () => this.getExecutionRoot(),
        getWorkspaceRoots: () => this.getExecutionWorkspaceRoots(),
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
      executionPlanBuilder,
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
      injectMode
    );

    if (prepared.diagnostics.length > 0) {
      for (const diagnostic of prepared.diagnostics) {
        Log.warn(`[PromptPreparation] ${diagnostic.message}`);
      }
      const promptStartedAt = session.workflowContext?.promptStartedAt;
      session.workflowContext?.reportCompatibilityDiagnostics?.(
        this.routePromptDiagnostics(
          prepared.diagnostics,
          session.workflowContext
        ),
        promptStartedAt === undefined
          ? undefined
          : Math.max(0, promptStartedAt - 1)
      );
    }

    const blockingDiagnostics = prepared.diagnostics.filter((diagnostic) =>
      isContextResolutionDiagnostic(diagnostic.code)
    );
    if (
      ConfigurationUtils.getContextResolutionFailureMode() ===
        CONTEXT_RESOLUTION_FAILURE_MODES.FAIL &&
      blockingDiagnostics.length > 0
    ) {
      throw new Error(
        formatContextResolutionFailureMessage(blockingDiagnostics)
      );
    }

    session.preparePrompt(
      prepared.promptWithInstruction,
      prepared.tempFilePaths,
      prepared.imageFileRefs
    );

    const imageFileRefs = prepared.imageFileRefs ?? [];
    if (
      imageFileRefs.length > 0 &&
      session.workflowContext?.analyzeCompatibilityForPrompt &&
      session.resolvedProperties
    ) {
      const diagnostics =
        await session.workflowContext.analyzeCompatibilityForPrompt(
          session.workflowContext.promptIndex,
          session.prompt,
          session.resolvedProperties,
          imageFileRefs
        );
      if (diagnostics.length > 0) {
        session.workflowContext.reportCompatibilityDiagnostics?.(
          diagnostics,
          session.workflowContext.promptStartedAt === undefined
            ? undefined
            : Math.max(0, session.workflowContext.promptStartedAt - 1)
        );
      }
    }

    if (injectMode) {
      session.markInjectModePrepared();
    }
  }

  private routePromptDiagnostics(
    diagnostics: readonly CompatibilityDiagnostic[],
    workflowContext: WorkflowContext | undefined
  ): CompatibilityDiagnostic[] {
    if (!workflowContext) {
      return [...diagnostics];
    }
    const consumer =
      workflowContext.promptIndex < workflowContext.allPrompts.length
        ? {
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: workflowContext.promptIndex,
          }
        : { kind: FINAL_STEP_PHASES.FINAL_STEP };
    return diagnostics.map((diagnostic) => ({ ...diagnostic, consumer }));
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
    const mode = this.sessionExecutionMode(session);
    const isInteractive = mode === CLI_EXECUTION_MODE.INTERACTIVE;
    const workspaceRoot = this.getExecutionRoot();

    // Inject mode: write directly into the running TUI instead of killing and
    // restarting with --resume. Works for sequential follow-up prompts within a
    // run AND for the first prompt of a resumed workflow — when the integration is
    // reused via WorkflowInstance.liveInjectIntegration, lastInteractiveContext is
    // already populated and shouldUseInjectMode passes without needing promptIndex > 0.
    if (isInteractive && this.shouldUseInjectMode(session)) {
      this.handleInjectedPromptPrepared(session.promptArgument);
      const executionSidecar = this.startProviderExecutionSidecar(
        session,
        workspaceRoot
      );
      let injectResult;
      try {
        injectResult =
          await this.executionRunner.executeInteractiveInject(session);
      } finally {
        executionSidecar?.stop();
      }
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

    const executionPlan = await this.executionPlanBuilder.plan(session);
    const routedDiagnostics =
      executionPlan.permissionApplication.diagnostics.map((diagnostic) => {
        const workflowContext = session.workflowContext;
        if (!workflowContext) {
          return diagnostic;
        }
        return {
          ...diagnostic,
          consumer:
            workflowContext.promptIndex < workflowContext.allPrompts.length
              ? {
                  kind: FINAL_STEP_PHASES.QUEUE,
                  stepIndex: workflowContext.promptIndex,
                }
              : { kind: FINAL_STEP_PHASES.FINAL_STEP },
        };
      });
    for (const diagnostic of routedDiagnostics) {
      Log.warn(`[PermissionCompatibility] ${diagnostic.message}`);
    }
    session.workflowContext?.reportCompatibilityDiagnostics?.(
      routedDiagnostics
    );
    try {
      await this.executionPlanBuilder.apply(executionPlan);
    } finally {
      this.notifyStatuslineInstall(
        this.provider.consumeStatuslineInstallResult?.()
      );
    }
    const executionSidecar = this.startProviderExecutionSidecar(
      session,
      workspaceRoot
    );

    let success: boolean;
    try {
      success = isInteractive
        ? await this.executionRunner.executeInteractive(
            session,
            executionPlan.cliArgs,
            executionPlan.resolvedCommand
          )
        : await (() => {
            this.warnIfHeadlessWithoutPermissions(
              executionPlan.effectiveToolPermissions,
              mode
            );
            return this.executionRunner.executeHeadless(
              session,
              executionPlan.cliArgs,
              executionPlan.resolvedCommand
            );
          })();
    } finally {
      executionSidecar?.stop();
    }

    if (!session.effectiveSessionId && session.resolvedSessionId) {
      session.setExtractedSessionId(session.resolvedSessionId);
      Log.debug(
        `📝 Reusing resolved session ID (no new ID extracted): ${session.effectiveSessionId}`
      );
    }

    return success;
  }

  private notifyStatuslineInstall(
    result:
      | ReturnType<NonNullable<ICliProvider["consumeStatuslineInstallResult"]>>
      | undefined
  ): void {
    if (!result) {
      return;
    }
    if (
      result.collision &&
      this.provider.config.harnessId === HARNESS_IDS.QWEN_CLI
    ) {
      notifyUserFeedback(
        this.userFeedbackSink,
        USER_FEEDBACK_SEVERITY.INFO,
        "Qwen already has a status line configured (a 'preset' set up outside ctrlyoke) — ctrlyoke won't replace it automatically, and has turned off its own Qwen status line tracking. Enable it again in Settings → Status Line whenever you'd like ctrlyoke's branded line instead."
      );
      return;
    }
    if (result.kind !== SETTINGS_JSON_INSTALL_KIND_WRITTEN) {
      return;
    }
    const harness = this.provider.config.terminalName;
    const message = result.captured
      ? `ctrlyoke is now managing your ${harness} statusline and forwarding to your existing script unchanged. Settings → Status Line to change this.`
      : `ctrlyoke is now showing its own statusline for ${harness}. Settings → Status Line to change this.`;
    notifyUserFeedback(
      this.userFeedbackSink,
      USER_FEEDBACK_SEVERITY.INFO,
      message
    );
  }

  private startProviderExecutionSidecar(
    session: CliExecutionSession,
    workspaceRoot: string | undefined
  ): CliExecutionSidecar | undefined {
    if (!workspaceRoot) {
      return undefined;
    }
    return this.provider.startExecutionSidecar?.({
      workspaceRoot,
      model: session.resolvedProperties?.model ?? "",
      onStreamingEvents: (events) => this.emitStreamingEvents(events),
      onContextWindowUpdate: (used, size) =>
        this.emitContextWindowUpdate(used, size),
      onProviderUsageUpdate: this.onProviderUsageUpdate,
    });
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
   * Log prompt to output channel with formatting
   */
  protected logPrompt(promptText: string): void {
    if (ConfigurationUtils.shouldLogRawCliOutput()) {
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
    if (ConfigurationUtils.shouldLogRawCliOutput()) {
      if (statistics) {
        Log.appendLine(`\n[STATISTICS] ${statistics}`);
      }
    }
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
    toolPermissions?: ToolPermissionConfig | null,
    mode: CliExecutionMode = this.getExecutionMode()
  ): void {
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

    notifyUserFeedback(this.userFeedbackSink, "warning", message);
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

  /**
   * Return the provider-owned installation guidance for dashboard surfaces.
   * Keeping this on the integration prevents UI code from duplicating
   * provider-specific install commands.
   */
  getInstallHint(): string {
    return this.provider.config.installHint;
  }

  override getDetailedStatus() {
    const status = super.getDetailedStatus();
    if (status.initializationStatus !== HarnessStatus.Unavailable) {
      return status;
    }

    return {
      ...status,
      message: this.getUnavailableGuidance(),
    };
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
        message: this.getUnavailableGuidance(),
        strategy: this.getIntegrationMode(),
      };
    }
  }

  private getUnavailableGuidance(): string {
    return `❌ ${this.provider.config.displayName} unavailable. ${this.getInstallHint()}. Then sign in with the CLI before running a workflow.`;
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
    this.sessionActivityWatcher?.stop();
    this.sessionActivityWatcher = undefined;
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

  override shouldRetainWorkflowArtifactsForReuse(): boolean {
    return this.provider.shouldRetainWorkflowArtifactsForReuse?.() ?? false;
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
    const tempMgr = new TempFileManager(workspaceRoot);
    const configPath = this.provider.getMcpConfigFilePath?.(
      workingFilePath,
      workspaceRoot
    );
    if (configPath) {
      await tempMgr.deleteFile(configPath);
    }
    // Clean up provider-specific interactive setup files (e.g., OpenCode plugin)
    const additionalPaths =
      this.provider.getAdditionalCleanupFilePaths?.(workspaceRoot) ?? [];
    for (const p of additionalPaths) {
      await tempMgr.deleteFile(p);
    }
    // Restore workspace config files modified during interactive hook setup (e.g., Qwen)
    await this.provider.cleanupWorkspaceArtifacts?.(
      workspaceRoot,
      workingFilePath
    );
  }

  /** Strict variant used as the managed-worktree commit barrier. */
  override async cleanupWorkflowArtifactsStrict(
    workingFilePath: string | undefined,
    workspaceRoot: string
  ): Promise<WorkflowArtifactCleanupResult> {
    const failures: string[] = [];
    const paths = [
      this.provider.getMcpConfigFilePath?.(workingFilePath, workspaceRoot),
      ...(this.provider.getAdditionalCleanupFilePaths?.(workspaceRoot) ?? []),
    ].filter((value): value is string => Boolean(value));

    try {
      await this.cleanupWorkflowArtifacts(workingFilePath, workspaceRoot);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    for (const artifactPath of paths) {
      try {
        await fs.promises.access(artifactPath);
        failures.push(
          `Provider artifact remains after cleanup: ${artifactPath}`
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          failures.push(
            `Could not prove provider artifact cleanup: ${artifactPath}`
          );
        }
      }
    }

    return { cleaned: failures.length === 0, failures };
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
    // One-reader rule: the watcher must not read the log while this prompt's own
    // CliLogMonitor owns it — see SessionActivityWatcher for the rationale.
    this.sessionActivityWatcher?.pause();

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
        this.sessionExecutionMode(executionSession) ===
        CLI_EXECUTION_MODE.INTERACTIVE;
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
        this.resumeSessionActivityWatcher(
          executionSession.resolvedProperties?.model ?? "",
          this.sessionExecutionMode(executionSession)
        );
      }
      this.activeSession = undefined;
    }
  }
}
