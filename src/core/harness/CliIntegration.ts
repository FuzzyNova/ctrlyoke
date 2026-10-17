import * as fs from "fs";
import * as path from "path";
import {
  createNoWorktreeExecutionWorkspace,
  PlatformAdapter,
  requireWorkspaceRoot,
} from "../../platform/PlatformAdapter";
import type { DisposableRegistry } from "../HostPorts";
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
import { reportCliNotFound } from "../../utils/TelemetryEvents";
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
  PRIOR_CONTEXT_KEYWORDS,
  TEMP_FILE_CATEGORIES,
  USER_FEEDBACK_SEVERITY,
  type TerminalEndReason,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import type {
  CliExecutionSidecar,
  ICliProvider,
} from "./shared/interfaces/ICliProvider";
import type { HarnessQuotaSnapshot } from "../../types/UsageTypes";
import type { ToolPermissionConfig } from "./shared/interfaces/IToolPermissionMapper";
import { CliFailureTracker } from "./shared/CliFailureTracker";
import { detectHarness } from "./shared/HarnessDetection";
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
import {
  SPAWN_IDENTITY_FIELDS,
  spawnIdentityFields,
} from "../../types/ExecutionSpawnIdentity";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import type { PtySession } from "./PtyProcessManager";
import type { HookEvent } from "../../types/CtrlYokeTypes";
import { notifyUserFeedback, type UserFeedbackSink } from "../UserFeedbackSink";
import { SETTINGS_JSON_INSTALL_KIND_WRITTEN } from "./shared/SettingsJsonMcpTracker";
import { resolveSecretEnvironment } from "../../utils/SecretResolver";
import { type RunSecretRedactor } from "../../utils/SecretRedactionService";
import {
  formatHarnessInstallGuidance,
  formatHarnessVersionGuidance,
  type HarnessVersionAssessment,
} from "../../utils/HarnessVersion";
import type { HarnessAvailabilityReport } from "../../types/WebviewMessageTypes";

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
  /** Last execution context retained for steering while the PTY remains alive. */
  private lastWorkflowContext?: WorkflowContext;
  private lastResolvedProperties?: ResolvedProperties;
  private lastResolvedSessionId?: string;
  /** Temp prompt files held until the live PTY exits after a steer. */
  private deferredSteerTempFilePaths: string[] = [];
  /** Hook env files live as long as the PTY configuration that references them. */
  private deferredHookEnvironmentFilePaths = new Set<string>();
  private deferredHookEnvironmentCleanup?: Promise<void>;

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
  /** Detected CLI version against `config.versionPolicy`; set by initialize(). */
  private versionAssessment: HarnessVersionAssessment | undefined;

  /**
   * Create a new CLI integration with the specified CLI provider.
   *
   * @param cliProvider The CLI provider instance (encapsulates all CLI-specific logic)
   * @param platform Platform adapter providing workspace and runtime capabilities
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
    ),
    disposableRegistry?: DisposableRegistry
  ) {
    super(disposableRegistry, registerWithContext);
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

  protected override getApprovedExternalRoots(
    workflowContext?: WorkflowContext
  ): string[] {
    if (!workflowContext) {
      return [...this.executionWorkspace.approvedExternalRoots];
    }
    return super.getApprovedExternalRoots(workflowContext);
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
    const config =
      ConfigurationUtils.resolveSpawnToolPermissions(toolPermissions);
    return (
      config !== null &&
      this.provider.toolPermissionMapper.hasFullPermissions(config)
    );
  }

  // ============================================================
  // PROMPT PREPARATION
  // ============================================================

  /**
   * Format an already-quoted path using the provider's formatFileReference()
   * override for a harness-specific prefix (e.g. Codex drops the `@`).
   * Single source for every `@`-ref formatting decision in this class.
   */
  private formatFileReferenceToken(
    quoted: string,
    tempFileCategory?: (typeof TEMP_FILE_CATEGORIES)[keyof typeof TEMP_FILE_CATEGORIES]
  ): string {
    return (
      this.provider.formatFileReference?.(quoted, { tempFileCategory }) ??
      `@${quoted}`
    );
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
    absolutePath: string,
    category: (typeof TEMP_FILE_CATEGORIES)[keyof typeof TEMP_FILE_CATEGORIES]
  ): string {
    const refPath = this.getEffectiveAbsolute()
      ? absolutePath
      : tempMgr.getRelativePath(absolutePath);
    const quoted = refPath.includes(" ") ? `"${refPath}"` : refPath;
    return this.formatFileReferenceToken(quoted, category);
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
   *   using these secrets @secrets.1.md[, @secrets.2.md],
   *   using these available skills @skills.1.md[, @skills.2.md],
   *   using these file references @src/foo.ts, @src/bar.ts,
   *   with this prior conversation context @context.1.md[, @context.2.md],
   *   and these attachment excerpts @excerpts.1.md[, @excerpts.2.md],
   *   follow the instructions in @prompt.1.md[, @prompt.2.md]
   *
   * When only a prompt exists: "Follow instructions in @prompt.md "
   *
   * Every category below is routed through PromptFileSplitter and may expand
   * to multiple numbered files (`.1.md`, `.2.md`, …) once its content exceeds
   * the configured token/line limits — `directRefs` is the only exception,
   * since it names real workspace files rather than ctrlyoke-generated content.
   *
   * @param agentRefs Formatted file refs for agent files (split if large)
   * @param skillRefs Formatted file refs for skills files (split if large)
   * @param directRefs Formatted direct workspace file refs (never split — real files, not generated content)
   * @param contextRefs Formatted file refs for prior context files (split on step boundaries)
   * @param excerptRefs Formatted file refs for excerpt files (split if large)
   * @param promptRefs Formatted file refs for prompt files (split if large)
   * @param secretRefs Formatted file refs for the available-secrets block (split if large)
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
   * Returns true when terminal reuse should be used for the given session.
   *
   * Conditions:
   * 1. The global reuseRunningTerminal setting is enabled.
   * 2. There is a previous interactive context (PTY + log file). This is set either
   *    by a previous prompt in the same integration run, or carried over from a prior
   *    run when WorkflowInstance re-inserts the live integration into executionIntegrations.
   * 3. The prompt has resumeSession: true. Terminal reuse continues the existing
   *    conversation, which is semantically equivalent to resumeSession: true. A
   *    prompt with resumeSession: false requires a fresh process.
   * 4. The spawn-time configuration is compatible — model, tool permissions, hooks,
   *    MCP servers, and additional args must all match the spawned process. Any
   *    prompt-level override that changes these requires a fresh process instead.
   */
  private shouldReuseRunningTerminal(session: CliExecutionSession): boolean {
    if (!ConfigurationUtils.isReuseRunningTerminalEnabled()) {
      return false;
    }
    const ctx = this.executionRunner.getLastInteractiveContext();
    if (!ctx) {
      return false;
    }
    const promptIndex = session.workflowContext?.promptIndex ?? 0;
    const reason = CliIntegration.getTerminalReuseIncompatibilityReason(
      ctx,
      session.resolvedProperties,
      session.resolvedSessionId,
      this.getParallelGroupId(session.workflowContext)
    );
    if (reason) {
      Log.info(
        `[CliIntegration] Terminal reuse skipped for prompt ${promptIndex + 1}: ${reason} — using restart`
      );
      return false;
    }
    return true;
  }

  /**
   * Returns a human-readable reason why terminal reuse cannot be used, or null if compatible.
   *
   * Checks the spawn-time configuration fields that are fixed for the lifetime of a
   * Claude process. Any prompt-level override of these requires killing the current
   * process and restarting with the new args.
   */
  private static getTerminalReuseIncompatibilityReason(
    ctx: import("./shared/CliExecutionRunner").RunningTerminalContext,
    curr: ResolvedProperties | undefined,
    currSessionId: string | undefined,
    parallelGroupId?: string
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

    // This is deliberately a presence test rather than a prev/curr comparison:
    // coordination-enabled steps can have identical ResolvedProperties while
    // still requiring distinct spawn-time group identities.
    if (parallelGroupId !== undefined) {
      return "parallel-group identity requires a fresh process";
    }

    // Terminal reuse keeps the TUI alive and continues the existing conversation,
    // which is semantically equivalent to resumeSession: true. If the prompt
    // requests a fresh session, we must spawn a new process instead.
    if (!curr.resumeSession) {
      return "resumeSession is false — fresh session required";
    }

    const currIdentity = spawnIdentityFields(curr);
    const prevIdentity = spawnIdentityFields(prev);

    if (
      currIdentity[SPAWN_IDENTITY_FIELDS.MODEL] !==
      prevIdentity[SPAWN_IDENTITY_FIELDS.MODEL]
    ) {
      return `model changed (${prev.model} → ${curr.model})`;
    }

    if (
      currIdentity[SPAWN_IDENTITY_FIELDS.TOOL_PERMISSIONS] !==
      prevIdentity[SPAWN_IDENTITY_FIELDS.TOOL_PERMISSIONS]
    ) {
      return "toolPermissions changed";
    }

    if (
      currIdentity[SPAWN_IDENTITY_FIELDS.HOOKS] !==
      prevIdentity[SPAWN_IDENTITY_FIELDS.HOOKS]
    ) {
      return "hooks changed";
    }

    if (
      currIdentity[SPAWN_IDENTITY_FIELDS.MCP_SERVERS] !==
      prevIdentity[SPAWN_IDENTITY_FIELDS.MCP_SERVERS]
    ) {
      return "mcpServers changed";
    }

    if (
      currIdentity[SPAWN_IDENTITY_FIELDS.ADDITIONAL_ARGS] !==
      prevIdentity[SPAWN_IDENTITY_FIELDS.ADDITIONAL_ARGS]
    ) {
      return `additionalArgs changed`;
    }

    if (
      currIdentity[SPAWN_IDENTITY_FIELDS.SECRETS] !==
      prevIdentity[SPAWN_IDENTITY_FIELDS.SECRETS]
    ) {
      return "secrets changed";
    }

    if (
      currIdentity[SPAWN_IDENTITY_FIELDS.CTRLYOKE_MCP_MODE] !==
      prevIdentity[SPAWN_IDENTITY_FIELDS.CTRLYOKE_MCP_MODE]
    ) {
      return "ctrlyokeMcpMode changed";
    }

    return null;
  }

  private getParallelGroupId(
    workflowContext: WorkflowContext | undefined
  ): string | undefined {
    if (!workflowContext) return undefined;
    return workflowContext.workflowFile?.parallelGroups?.find(
      (group) =>
        workflowContext.promptIndex >= group.startIndex &&
        workflowContext.promptIndex <= group.endIndex
    )?.id;
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
  // still-in-progress response. WorkflowExecutor uses the payload while
  // persisting the current CliOutput response, so pre-redacting here would
  // send the model back its own corrupted output next turn — the same failure
  // mode that broke the standalone shim's generated JS. Every
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

  private emitResponseComplete(): void {
    this.responseCompleteEmitter.fire(undefined);
  }

  private emitSessionActivityResumed(events: CliEvent[]): void {
    this.sessionActivityResumedEmitter.fire({ events });
  }

  override getActivitySessionId(): string | undefined {
    return this.transportCoordinator.getLastPtySessionId();
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

  private handleSentPromptPrepared(promptArgument: string): void {
    this.activeSession?.recordSentPrompt(promptArgument);
    this.promptReadyEmitter.fire({
      fullPrompt: promptArgument,
      cliCommand: promptArgument,
      cliCommandSentToRunningTerminal: true,
    });
  }

  private handlePtyExit(session: PtySession, exitCode: number): void {
    this.sessionActivityWatcher?.stop();
    this.sessionActivityWatcher = undefined;

    const deferredSteerTempFilePaths = this.deferredSteerTempFilePaths;
    this.deferredSteerTempFilePaths = [];
    if (deferredSteerTempFilePaths.length > 0) {
      void this.cleanupTempFiles(deferredSteerTempFilePaths).catch((error) => {
        Log.warn(
          `[CliIntegration] Failed to clean up deferred steer temp files: ${String(error)}`
        );
      });
    }

    if (this.suppressPtyExitSessionId === session.id) {
      this.suppressPtyExitSessionId = undefined;
      Log.info(
        `[CliIntegration] AI CLI PTY session ${session.id} exited after intentional mode handoff`
      );
      return;
    }

    this.failureTracker.capturePtyExit(exitCode, session.reconnectBuffer);

    // Notify WorkflowInstance that the PTY session is gone so it can clean up
    // liveReusableIntegration and dispose this integration.
    const endedCb = this.ptySessionEndedCallback;
    if (endedCb) {
      this.ptySessionEndedCallback = undefined;
      endedCb();
    }

    if (exitCode !== 0) {
      Log.warn(
        `[CliIntegration] AI CLI PTY session ${session.id} exited with code ${exitCode} — workflow step will be stopped`
      );
      return;
    }

    Log.info(
      `[CliIntegration] AI CLI PTY session ${session.id} exited with code 0 before completion — workflow step will be stopped`
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
        onResponseComplete: () => this.emitResponseComplete(),
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
    this.lastWorkflowContext = workflowContext
      ? { ...workflowContext, stateRoot: this.getStateRoot() }
      : undefined;
    this.lastResolvedProperties = resolvedProperties;
    this.lastResolvedSessionId = resolvedSessionId;
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
      buildPromptSections: (
        prompt,
        resolvedAgent,
        resolvedSkills,
        workflowContext
      ) =>
        this.buildPromptSections(
          prompt,
          resolvedAgent,
          resolvedSkills,
          workflowContext
        ),
      extractLeadingSlashCommand: (promptText) =>
        this.extractLeadingSlashCommand(promptText),
      isSimplePrompt: (promptText) => this.isSimplePrompt(promptText),
      canSendToRunningTerminal: (promptText) =>
        this.canSendToRunningTerminal(promptText),
      buildPriorContextXmlFromItems: (items) =>
        this.buildPriorContextXmlFromItems(items),
      getWorkspaceRoot: () => this.getExecutionRoot(),
      getTempFileSplitConfig: () => this.getTempFileSplitConfig(),
      formatDirectFileRef: (absolutePath) =>
        this.formatDirectFileRef(absolutePath),
      formatTempFileRef: (tempMgr, absolutePath, category) =>
        this.formatTempFileRef(tempMgr, absolutePath, category),
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
            workspaceRoot: requireWorkspaceRoot(this.platform),
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
        onResponseComplete: () => this.emitResponseComplete(),
        onPtyExit: (session, exitCode) => this.handlePtyExit(session, exitCode),
        cleanupTempFiles: (tempFilePaths) =>
          this.cleanupTempFiles(tempFilePaths),
      },
      resolveSecretEnvironment: async (names) => {
        const values = await resolveSecretEnvironment(names, {
          workspaceRoot: requireWorkspaceRoot(this.platform),
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
      getApprovedExternalRoots: (workflowContext) =>
        this.getApprovedExternalRoots(workflowContext),
      getStateRoot: () => this.getStateRoot(),
      getExtensionPath: () => this.platform.getExtensionPath(),
      getExecutionMode: () => this.getExecutionMode(),
      getEnabledHookNotificationEvents: () =>
        this.getEnabledHookNotificationEvents(),
    });

    const executionRunner = new CliExecutionRunner({
      provider: this.provider,
      executionPlanBuilder,
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
        interactiveTerminal: this.platform.interactiveTerminal,
        isCancelling: () => this.isCancelling,
        setFailureReason: (reason) => this.setFailureReason(reason),
      },
      hostCallbacks: {
        onStreamingEvents: (events) => this.emitStreamingEvents(events),
        onResponseComplete: () => this.emitResponseComplete(),
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
    reuseRunningTerminal = false
  ): Promise<void> {
    const prepared = await this.promptPreparer.preparePrompt(
      session.prompt,
      session.workflowContext,
      session.resolvedProperties,
      session.resolvedSessionId,
      reuseRunningTerminal
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
      prepared.imageFileRefs,
      prepared.attachedSkills
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

    if (reuseRunningTerminal) {
      session.markTerminalReusePrepared();
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

    // Terminal reuse: write directly into the running TUI instead of killing and
    // restarting with --resume. Works for sequential follow-up prompts within a
    // run AND for the first prompt of a resumed workflow — when the integration is
    // reused via WorkflowInstance.liveReusableIntegration, lastInteractiveContext is
    // already populated and shouldReuseRunningTerminal passes without needing promptIndex > 0.
    if (isInteractive && this.shouldReuseRunningTerminal(session)) {
      this.handleSentPromptPrepared(session.promptArgument);
      const executionSidecar = this.startProviderExecutionSidecar(
        session,
        workspaceRoot
      );
      let reuseResult;
      try {
        reuseResult =
          await this.executionRunner.executeInRunningTerminal(session);
      } finally {
        executionSidecar?.stop();
      }
      if (reuseResult.sent) {
        return reuseResult.success;
      }
      // Fall through to restart mode if the PTY is no longer available.
      Log.info(
        "[CliIntegration] Terminal reuse unavailable — falling back to restart mode"
      );
      await this.retireInteractivePtyForRestartFallback(
        this.doesInteractivePtyOwnSession(session)
      );
    } else if (isInteractive && this.transportCoordinator.hasLivePtySession()) {
      // Terminal reuse was preemptively skipped (settings changed, resumeSession: false,
      // etc.) but a live PTY from the previous step is still running. Gracefully signal
      // it before spawning a fresh one so the CLI TUI can clean up.
      //
      // Deliberately unconditional, rather than gated on the session-id conflict
      // check used before a headless resume. `hasLivePtySession()` reports this
      // integration's *own* coordinator, which tracks exactly one
      // `currentPtySession` and overwrites it on the next spawn
      // (`CliTransportCoordinator.spawn`). Declining to retire here would leave the
      // old PTY referenced by nothing — `terminateCurrentPtySession`,
      // `writeToSession`, steer routing and `cancel()` all reach only
      // `currentPtySession` — so the process would survive until the extension host
      // exits. Sibling terminals are produced by the spawn-identity cache keys in
      // `WorkflowInstance`, which hand an incompatible prompt its own integration
      // and coordinator; a terminal worth retaining therefore never reaches this
      // branch at all.
      await this.retireInteractivePtyForRestartFallback(
        this.doesInteractivePtyOwnSession(session)
      );
    }

    // If the session was prepared with reuse-lenient rules (which can leave
    // prompts inline that contain shell-unsafe characters), re-prepare strictly
    // before any non-reuse execution path (restart or headless). This covers:
    //   1. Terminal reuse attempted but PTY died → fell through above.
    //   2. shouldReuseRunningTerminal was true in sendPrompt (prep was lenient) but
    //      returned false here (context changed between prep and dispatch).
    // Only text-only prompts (no temp files) can reach this branch, so there
    // are no orphaned files to clean up.
    if (
      session.wasTerminalReusePrepared &&
      session.tempFilePaths.length === 0
    ) {
      await this.initializeExecutionSession(session, false);
    }

    if (!isInteractive) {
      await this.retireInteractivePtyBeforeHeadlessResume(session);
    }

    // Everything below spawns a process. Whatever mode it runs in, it must be
    // the only owner of the AI session it resumes — including against the
    // sibling terminals this workflow deliberately retains.
    await this.retireConflictingSiblingPty(session);

    const executionPlan = await this.executionPlanBuilder.plan(session);
    if (session.resolvedProperties?.hooks !== null) {
      await this.cleanupDeferredHookEnvironmentFiles();
    }
    for (const tempFilePath of executionPlan.deferredHookEnvironmentFilePaths ??
      []) {
      session.addDeferredHookEnvironmentFilePath(tempFilePath);
      this.deferredHookEnvironmentFilePaths.add(tempFilePath);
    }
    for (const tempFilePath of executionPlan.tempFilePaths) {
      session.addTempFilePath(tempFilePath);
    }
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
        `[CliIntegration] Reusing resolved session ID (no new ID extracted): ${session.effectiveSessionId}`
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
    if (result.alreadyCtrlyoke) {
      // The pre-existing value was already ctrlyoke's own wrapper (e.g. its
      // absolute path moved after an extension update). The command still
      // needed refreshing, but the user has already seen this provider's
      // one-time install notification, so don't show it again.
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
   * Terminal reuse failed (PTY unavailable) so we are doing a full interactive restart
   * for this prompt. The old PTY session may still be alive or may exit soon; either
   * way its exit must not be treated as a failure for the new step — which is
   * why this is the one caller that suppresses the *last known* PTY's exit and
   * resets the failure tracker: `capturePtyExit` may already have run for it.
   *
   * When the restart resumes the very conversation the old PTY held, its tab
   * goes with it — the new terminal continues that session, and leaving the
   * dead one behind would show the same conversation twice.
   */
  private async retireInteractivePtyForRestartFallback(
    continuesSameAiSession: boolean
  ): Promise<void> {
    await this.retireInteractivePty({
      reason: "reuse fallback restart",
      suppressLastKnownPty: true,
      resetFailureTracker: true,
      removeTerminalTab: continuesSameAiSession,
    });
  }

  /**
   * Shared teardown for every reason this integration abandons its interactive
   * PTY: terminate it, stop terminal reuse from retrying against the dead session,
   * and mark the pending exit as an intentional handoff rather than a step
   * failure. Returns the terminated PTY session id, if one was still live.
   */
  private async retireInteractivePty(options: {
    /** Coordinator-facing reason; also names the handoff in the log. */
    reason: string;
    /**
     * Also suppress the exit of a PTY the coordinator has already forgotten.
     * Only the reuse-fallback path wants this: it gets here precisely because
     * the PTY may have died on its own moments earlier.
     */
    suppressLastKnownPty?: boolean;
    /**
     * Discard a failure captured for the abandoned PTY (e.g. its exit fired
     * during a prior await) so it is not attributed to the next step.
     */
    resetFailureTracker?: boolean;
    /** Drop the retired terminal's tab; see `TerminatePtySessionOptions`. */
    removeTerminalTab?: boolean;
  }): Promise<string | undefined> {
    const terminatedPtyId =
      await this.transportCoordinator.terminateCurrentPtySession(
        options.reason,
        { removeTerminalTab: options.removeTerminalTab }
      );
    const suppressedPtyId = options.suppressLastKnownPty
      ? (terminatedPtyId ?? this.transportCoordinator.getLastPtySessionId())
      : terminatedPtyId;
    this.executionRunner.clearInteractiveContext();
    if (options.resetFailureTracker) {
      this.failureTracker.reset();
    }
    if (suppressedPtyId) {
      this.suppressPtyExitSessionId = suppressedPtyId;
      Log.info(
        `[CliIntegration] Retired interactive PTY ${suppressedPtyId.slice(0, 8)} for ${options.reason}`
      );
    }
    return terminatedPtyId;
  }

  /**
   * Another integration in this workflow is about to resume the AI session this
   * one still holds open. Retire the PTY so the incoming process is that
   * session's only owner.
   *
   * Cross-integration takeover is the case neither local path above can see:
   * a step that changes a spawn-time property (model, MCP servers, tool
   * permissions…) while still resuming the previous step's session is handed a
   * *fresh* integration by `WorkflowInstance`'s spawn-identity cache keys, whose
   * own coordinator has no live PTY to retire. Sibling terminals are the point
   * of those keys, but siblings are only safe while they own different
   * conversations.
   */
  override ownsLiveAiSession(aiSessionId: string): boolean {
    return (
      this.transportCoordinator.hasLivePtySession() &&
      this.interactivePtyOwnsAiSession(aiSessionId)
    );
  }

  override async releaseLiveAiSession(
    aiSessionId: string
  ): Promise<string | undefined> {
    if (!this.ownsLiveAiSession(aiSessionId)) {
      return undefined;
    }
    return this.retireInteractivePty({
      reason: `takeover of AI session ${aiSessionId}`,
      resetFailureTracker: true,
    });
  }

  /**
   * Terminal reuse intentionally leaves the interactive TUI alive between prompts.
   * If the user switches to headless before a resume prompt, that headless
   * process must become the only owner of the resumed AI session; otherwise
   * some harnesses reject or corrupt concurrent access to the same session.
   */
  private async retireInteractivePtyBeforeHeadlessResume(
    session: CliExecutionSession
  ): Promise<void> {
    if (!this.doesInteractivePtyOwnSession(session)) {
      return;
    }

    await this.retireInteractivePty({
      reason: `headless resume of AI session ${session.resolvedSessionId}`,
    });
  }

  /**
   * Retire a live PTY owned by a *different* integration when this dispatch is
   * about to resume the AI session that PTY still holds. No-op unless the
   * workflow wired the cross-integration hook — a standalone CLI or MCP host
   * runs one integration at a time and has no sibling to conflict with.
   */
  private async retireConflictingSiblingPty(
    session: CliExecutionSession
  ): Promise<void> {
    const resolvedSessionId = session.resolvedSessionId;
    if (
      !resolvedSessionId ||
      session.resolvedProperties?.resumeSession === false
    ) {
      return;
    }
    await session.workflowContext?.releaseConflictingAiSession?.(
      resolvedSessionId,
      this
    );
  }

  /**
   * Returns true only when a new resume would take over the session owned by
   * the retained interactive PTY. Fresh-session prompts never conflict with
   * that PTY, even if their resolver carried an old or explicit session ID.
   *
   * This is the predicate for the *headless* path, where the new process is a
   * separate owner and the interactive PTY can legitimately stay alive. It is
   * not safe on the interactive restart path, which replaces the PTY on this
   * integration's own coordinator — see the unconditional retirement in
   * `sendPrompt`.
   */
  private doesInteractivePtyOwnSession(session: CliExecutionSession): boolean {
    if (session.resolvedProperties?.resumeSession === false) {
      return false;
    }

    const resolvedSessionId = session.resolvedSessionId;
    return (
      resolvedSessionId !== undefined &&
      this.interactivePtyOwnsAiSession(resolvedSessionId)
    );
  }

  /**
   * Does the interactive context this integration last spawned name the given
   * AI session? Both the session the harness reported and the one it was
   * spawned with count — a resume of either would collide with that process.
   */
  private interactivePtyOwnsAiSession(aiSessionId: string): boolean {
    const ctx = this.executionRunner.getLastInteractiveContext();
    if (!ctx) {
      return false;
    }

    const activeSessionIds = [ctx.sessionId, ctx.spawnedWithSessionId].filter(
      (id): id is string => typeof id === "string" && id.length > 0
    );
    return activeSessionIds.includes(aiSessionId);
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
        attachedSkills: session.attachedSkills,
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
        attachedSkills: session.attachedSkills,
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
        attachedSkills: session.attachedSkills,
        extractedSessionId: session.effectiveSessionId,
        parsedOutput: session.parsedOutput,
        workingFilePersistence: workflowContext?.workingFilePersistence,
      });
    session.updateParsedOutput(persistedOutput);
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
    Log.debug(
      `[CliIntegration] Cleaned up ${tempFilePaths.length} temp file(s)`
    );
  }

  private async cleanupDeferredHookEnvironmentFiles(): Promise<void> {
    const filePaths = [...this.deferredHookEnvironmentFilePaths];
    if (filePaths.length === 0) {
      return;
    }
    this.deferredHookEnvironmentFilePaths.clear();
    await Promise.all(
      filePaths.map((filePath) => fs.promises.unlink(filePath).catch(() => {}))
    );
  }

  /** Keep steer prompt files available until the live PTY has consumed them. */
  private registerDeferredSteerTempFiles(tempFilePaths: string[]): void {
    this.deferredSteerTempFilePaths.push(...tempFilePaths);
  }

  /**
   * Prepare and write a steer turn without entering the workflow execution
   * pipeline. The PTY writer owns serialization with ordinary sent turns.
   */
  override async sendSteerMessage(text: string): Promise<boolean> {
    // During a monitored prompt, CliLogMonitor already owns the parser. Only
    // pause the activity watcher for the between-runs case; resuming it while
    // the prompt monitor is active would violate the one-reader rule.
    const hasActivePrompt = this.activeSession !== undefined;
    if (!hasActivePrompt) {
      this.sessionActivityWatcher?.pause();
    }
    try {
      const activeSession = this.activeSession;
      const workflowContext =
        activeSession?.workflowContext ?? this.lastWorkflowContext;
      const liveProperties =
        activeSession?.resolvedProperties ?? this.lastResolvedProperties;
      if (!liveProperties) {
        return false;
      }

      const reducedResolvedProperties: ResolvedProperties = {
        ...liveProperties,
        agent: undefined,
        skills: [],
        priorContext: PRIOR_CONTEXT_KEYWORDS.NONE,
      };
      const resolvedSessionId =
        activeSession?.effectiveSessionId ??
        this.executionRunner.getLastInteractiveContext()?.sessionId ??
        this.lastResolvedSessionId;
      const prepared = await this.promptPreparer.preparePrompt(
        { prompt: text },
        workflowContext,
        reducedResolvedProperties,
        resolvedSessionId,
        true
      );

      this.registerDeferredSteerTempFiles(prepared.tempFilePaths);
      return await this.executionRunner.writeTurnToLivePty(
        prepared.promptWithInstruction
      );
    } finally {
      if (!hasActivePrompt) {
        this.sessionActivityWatcher?.resume();
      }
    }
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

  override getLastCliCommandSentToRunningTerminal(): boolean | undefined {
    return this.lastExecutionSnapshot?.cliCommandSentToRunningTerminal;
  }

  override getLastFailureOutput(): string | undefined {
    const ptyTail = this.failureTracker.getLastFailureOutput();
    if (ptyTail) {
      return ptyTail;
    }
    return undefined;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Detect the CLI and enforce its supported version window (see
   * `detectHarness`). A CLI below the minimum is reported unavailable with
   * update guidance rather than install guidance.
   */
  async initialize(): Promise<void> {
    this.initializationStatus = HarnessStatus.Initializing;
    this.statusChangeEmitter.fire(HarnessStatus.Initializing);

    try {
      const detection = await detectHarness(this.provider);
      if (!detection.version) {
        this.handleInitializationError("command_failed", "CLI not available");
        return;
      }

      this.versionAssessment = detection.version;
      const { displayName } = this.provider.config;
      const versionGuidance = formatHarnessVersionGuidance(
        displayName,
        detection.version
      );
      if (versionGuidance) {
        Log.warn(`[CliIntegration] ${versionGuidance}`);
      }
      if (!detection.available) {
        this.markUnavailable();
        return;
      }

      Log.debug(
        `[CliIntegration] ${displayName} available${detection.rawVersion ? `: ${detection.rawVersion}` : ""}`
      );
      this.isAvailable = true;
      this.initializationStatus = HarnessStatus.Ready;
      this.statusChangeEmitter.fire(HarnessStatus.Ready);
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
    this.versionAssessment = undefined;
    this.markUnavailable();

    Log.error(
      `[CliIntegration] ${this.provider.config.displayName} not available`,
      error
    );
    reportCliNotFound(this.getIntegrationMode());
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
   * Availability plus the provider-owned install command and version verdict,
   * as published to dashboard surfaces. Keeping this on the integration
   * prevents UI code from duplicating provider-specific commands.
   */
  getAvailabilityReport(): HarnessAvailabilityReport {
    return {
      available: this.isAvailable,
      installCommand: this.provider.config.installCommand,
      ...(this.versionAssessment ? { version: this.versionAssessment } : {}),
    };
  }

  private markUnavailable(): void {
    this.isAvailable = false;
    this.initializationStatus = HarnessStatus.Unavailable;
    this.statusChangeEmitter.fire(HarnessStatus.Unavailable);
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

  override closeTerminal(reason: TerminalEndReason): void {
    this.transportCoordinator.closeTerminal(reason);
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
    const { displayName, installCommand } = this.provider.config;
    const versionGuidance = formatHarnessVersionGuidance(
      displayName,
      this.versionAssessment
    );
    return versionGuidance
      ? `❌ ${versionGuidance}`
      : `❌ ${displayName} unavailable. ${formatHarnessInstallGuidance(installCommand)}. Then sign in with the CLI before running a workflow.`;
  }

  // ============================================================
  // CANCELLATION & DISPOSAL
  // ============================================================

  /**
   * Cancel the current CLI process
   */
  protected async cancelImplementation(): Promise<void> {
    Log.debug(
      `[CliIntegration] Cancel called (harness: ${this.provider.config.displayName})`
    );

    const hadActiveProcess = await this.transportCoordinator.cancel();

    if (!hadActiveProcess) {
      // No active process anywhere - fire responseComplete immediately
      Log.debug(
        "[CliIntegration] No active process/execution - firing responseComplete immediately"
      );
      this.lastFailureReason = "Stopped by user";
      this.responseCompleteEmitter.fire(undefined);
      return;
    }

    // Active process exists: Kill it. responseComplete will be fired by the
    // process close handler (in spawnProcess) when the process actually exits.
    Log.info("[CliIntegration] Active process found - sending kill signal");

    Log.info("[CliIntegration] Kill signal sent - waiting for process to exit");
  }

  /**
   * Sends Ctrl+C to the live PTY and schedules a hard kill after 500 ms, giving
   * the CLI time to clean up before the next run spawns a fresh process.
   * Called by WorkflowInstance when the user explicitly restarts from beginning.
   */
  override closeTerminalGracefully(reason: TerminalEndReason): void {
    this.transportCoordinator.closeTerminal(reason);
  }

  /**
   * Dispose of resources.
   * If closeTerminalWhenPromptCompletes is false (default), the terminal is kept open
   * so the user can review output. The next prompt launch will close it before reuse.
   */
  dispose(): void {
    super.dispose();
    this.deferredHookEnvironmentCleanup =
      this.cleanupDeferredHookEnvironmentFiles();
    this.sessionActivityWatcher?.stop();
    this.sessionActivityWatcher = undefined;
    this.transportCoordinator.dispose(
      ConfigurationUtils.shouldCloseTerminalWhenPromptCompletes()
    );
  }

  override async waitForProcessShutdown(): Promise<void> {
    await this.processManager.disposeAsync();
    await this.deferredHookEnvironmentCleanup;
  }

  /**
   * Returns true when terminal reuse is configured AND the last run left a live PTY
   * session with known running-terminal context. WorkflowInstance checks this in the
   * startWorkflowExecution finally block to decide whether to keep this integration
   * alive for the next run instead of disposing it.
   */
  override canReuseRunningTerminal(): boolean {
    const reuseRunningTerminal =
      ConfigurationUtils.isReuseRunningTerminalEnabled();
    const hasCtx = this.executionRunner.hasInteractiveContext();
    const hasPty = this.transportCoordinator.hasLivePtySession();
    Log.debug(
      `[canReuseRunningTerminal] reuseRunningTerminal=${reuseRunningTerminal} hasCtx=${hasCtx} hasPty=${hasPty}`
    );
    return reuseRunningTerminal && hasCtx && hasPty;
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
   * integration exits. Used by WorkflowInstance to clean up liveReusableIntegration
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

      // Create session without prompt preparation so we can check terminal reuse
      // before deciding which inline-check rules to apply.
      executionSession = this.createUnpreparedExecutionSession(
        prompt,
        workflowContext
      );
      this.activeSession = executionSession;

      const isInteractive =
        this.sessionExecutionMode(executionSession) ===
        CLI_EXECUTION_MODE.INTERACTIVE;
      const reuseRunningTerminal =
        isInteractive && this.shouldReuseRunningTerminal(executionSession);
      await this.initializeExecutionSession(
        executionSession,
        reuseRunningTerminal
      );

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
      Log.error("[CliIntegration] Error sending prompt", error);
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
