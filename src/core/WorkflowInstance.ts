import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { WorkingFileManager } from "./WorkingFileManager";
import {
  buildClearUpdates,
  buildDefinitionSnapshot,
  buildEphemeralWorkflowStep,
  buildPromptStepProperties,
  buildScriptStepFromProperties,
  sanitizeClipboardWorkflowStep,
  stripViewOnlyWorkflowStepFields,
} from "./WorkflowStepSanitizer";
import { HarnessIntegration, HarnessStatus } from "./HarnessIntegration";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { EndConditionHandler } from "./EndConditionHandler";
import { WorkflowExecutor, WorkflowExecutionContext } from "./WorkflowExecutor";
import {
  PromptFile,
  PromptStep,
  WorkflowStep,
  isScriptStep,
  QueueState,
  HarnessId,
  EXECUTION_STATES,
  WorkingFile,
  WorkflowAttemptTarget,
  WorkflowAttemptTransition,
  WorkflowRuntimeTransition,
  WorkflowSummary,
  WorkflowRunnerLock,
  DynamicQueueConfig,
  type RunRef,
  type WorkflowKey,
} from "../types/CtrlYokeTypes";
import { WorkflowLockManager } from "../utils/WorkflowLockManager";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { pathsEqual } from "../utils/PathCasing";
import {
  ACTION_TYPES,
  DEFAULT_WORKFLOW_NAME,
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  OUTPUT_HISTORY_KINDS,
  QUEUE_POSITION,
  RUNNER_IDS,
  SESSION_KINDS,
  STATUS_MESSAGE_SEVERITY,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  STEP_STATUS,
  STEP_TYPES,
  WORKFLOW_ATTEMPT_COMMANDS,
  type ActionType,
  type ExecutionMode,
  type QueuePosition,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { WorkflowTaggedSink } from "./WorkflowTaggedSink";
import type {
  CliEvent,
  CliOutput,
  ContextWindowSyncData,
  FollowUpResumedData,
} from "../types/WebviewMessageTypes";
import { Log } from "../utils/Log";
import { getErrorMessage } from "../utils/ErrorUtils";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { PropertyResolver } from "../utils/PropertyResolver";
import { isCli } from "../utils/RuntimeMode";
import { PlatformAdapter } from "../platform/PlatformAdapter";
import { TypedEmitter } from "../utils/TypedEmitter";

// Import orchestration classes
import { PromptFileLoader } from "./orchestration/PromptFileLoader";
import { PromptFileWatcher } from "./orchestration/PromptFileWatcher";
import { createPriorContextResolver } from "./orchestration/AddressedPriorContextResolver";
import {
  OutputHistoryManager,
  type DefinitionRevisionContext,
} from "./orchestration/OutputHistoryManager";
import { IntegrationFactory } from "./IntegrationFactory";
import { HarnessCapabilityRegistry } from "./HarnessCapabilityRegistry";
import { notifyUserFeedback, type UserFeedbackSink } from "./UserFeedbackSink";
import {
  analyzeCompatibility,
  enumerateCompatibilityTargets,
} from "../types/CompatibilityAnalyzer";
import type { CompatibilityDiagnostic } from "../types/CompatibilityTypes";
import { WorkspaceSnapshotService } from "../utils/WorkspaceSnapshotService";
import type {
  OutputExecutionTarget,
  UndoExecutionTarget,
} from "../types/OutputHistoryTypes";
import {
  OutputCaptureBuffer,
  type OutputCaptureCallbacks,
  type PromptStartData,
  type PromptCompleteData,
} from "./OutputCaptureBuffer";
import { WorkflowStateMachine } from "./WorkflowStateMachine";
import { extractTextFromEvents } from "./harness/shared/CliResponseTextExtractor";
import {
  getPtyProcessManager,
  ptyPostMessage,
  resolveWindowsShell,
} from "./harness/PtyProcessManager";
export type {
  PromptStartData,
  PromptCompleteData,
} from "./OutputCaptureBuffer";

/**
 * WorkflowInstance
 *
 * RESPONSIBILITY: Single Workflow Execution Lifecycle
 *
 * Encapsulates all per-workflow state that was previously scattered across
 * the original monolithic manager:
 *   - PromptQueue (state machine)
 *   - WorkflowExecutor (execution loop)
 *   - EndConditionHandler / EndConditionEvaluator
 *   - PromptFileLoader / PromptFileWatcher
 *   - OutputHistoryManager
 *   - activeIntegration, currentPromptFile, startPending, lastKnownStepCount
 *
 * Dependencies that span multiple workflows (integrations, status bar, template
 * importing) remain in WorkflowOrchestrator and are injected as callbacks:
 *   - integrationFactory                → creates per-run execution integrations
 *   - getDetectorIntegration(harness?)  → returns detector singleton for pre-flight checks
 *   - onWorkflowNameChange(name)        → propagate name to CLI tabs
 *   - onStatusBarUpdate()               → trigger orchestrator status bar refresh
 *
 * Phase 1: WorkflowOrchestrator holds exactly one instance.
 * Phase 2: Multiple instances run in parallel (one per open workflow).
 */

export class WorkflowInstance {
  /** Unique identifier — stable for this instance's lifetime */
  readonly id: string;
  /** Editable display name (kept in sync with queue's workflowName) */
  workflowName: string = "";
  /** Path to the source prompt/workflow file (or generated name for ephemerals) */
  filePath: string = "";
  /** Creation timestamp (ms since epoch) */
  readonly createdAt: number;
  /** Timestamp when execution last started (ms since epoch), 0 if never started */
  startedAt: number = 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Per-workflow execution state
  // ─────────────────────────────────────────────────────────────────────────
  readonly promptFileParser: PromptFileParser;
  readonly promptQueue: PromptQueue;
  readonly workflowExecutor: WorkflowExecutor;
  private readonly workflowRuntime: WorkflowStateMachine;
  /** Currently-executing integration (set for the duration of startWorkflowExecution) */
  activeIntegration?: HarnessIntegration;
  private readonly endConditionEvaluator: EndConditionEvaluator;
  private readonly endConditionHandler: EndConditionHandler;

  /** Reference to the loaded source prompt file */
  private currentPromptFile?: { filePath: string; promptFile: PromptFile };
  /** Race-condition guard: prevents duplicate workflow starts */
  startPending: boolean = false;
  /** Deduplicates overlapping eager working-file creation requests */
  private ensureWorkingFilePromise: Promise<void> | undefined;
  /** Tracks prompt count to detect MCP-triggered merges */
  private lastKnownStepCount: number = 0;
  /** Tracks workflow name to detect changes and push them to the dashboard */
  private lastKnownWorkflowName: string = "";
  /**
   * When a prompt is sent with Run intent while the workflow is still cancelling,
   * we can't execute immediately. This stores the harness override so that once
   * confirmStopped fires (cancelling → stopped) we auto-continue rather than
   * leaving the user with a pending step they have to manually resume.
   * null = no deferred run pending.
   */
  private pendingRunAfterCancel: { harness: HarnessId | undefined } | null =
    null;
  /** Heartbeat interval for the process lock file (cleared in finally + dispose) */
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  /** Ownership token for the currently-held runner lock, if any (see WorkflowLockManager). */
  private currentLockOwnerToken: string | undefined;
  /** The RunRef this instance is currently executing, if any. Distinct from any client's viewed run. */
  private executionRunRef: RunRef | undefined;
  private executionSettledPromise: Promise<void> = Promise.resolve();
  private resolveExecutionSettled: (() => void) | undefined;
  /**
   * How long `shutdown()` lets an already-cancelled run settle after durable
   * state is flushed. Deliberately short: VS Code's exit path should not stall
   * on a harness that is slow to acknowledge cancellation, and startup recovery
   * already repairs a run that never settled.
   */
  private static readonly SHUTDOWN_SETTLE_TIMEOUT_MS = 1_500;

  /** Per-workflow dashboard sink (wrapped with WorkflowTaggedSink to inject workflowId) */
  private readonly dashboardSink: IDashboardSink | undefined;

  /** Manages all output capture Maps and replay logic for background workflows. */
  private readonly outputCaptureBuffer: OutputCaptureBuffer;

  /**
   * Target/attempt of the most recently completed step's CliOutput — set every
   * time `captureCompletedOutput`/`captureFinalStepCompletedOutput` fires.
   * `SessionActivityWatcher`'s resumed activity has no target of its own (it
   * fires outside any active dispatch), so it is attributed here instead.
   */
  private lastCompletedActivityTarget?: {
    target: OutputExecutionTarget;
    runIndex: number;
    attemptIndex: number;
  };
  /** Events that arrive in the monitor-to-session-watcher handoff window. */
  private pendingSessionActivityEvents: CliEvent[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // Orchestration helpers
  // ─────────────────────────────────────────────────────────────────────────
  private readonly promptFileLoader: PromptFileLoader;
  private readonly promptFileWatcher: PromptFileWatcher;
  readonly outputHistoryManager: OutputHistoryManager;
  private activeHistoryFilePath: string = "";
  private pendingRuntimeTransitionHistoryWrite: Promise<void> =
    Promise.resolve();

  /**
   * Execution integrations created for the current/most-recent run — disposed in finally block.
   * Keyed by harness ID so harness switches reuse the same integration instance rather than
   * allocating a new one per prompt (important for long-running / infinite-queue workflows).
   * Max live integrations = number of distinct harness types used (≤ 4).
   */
  private readonly executionIntegrations = new Map<
    string,
    HarnessIntegration
  >();

  /**
   * Integrations from the previous run whose terminals were intentionally left open
   * (closeTerminalWhenPromptCompletes = false). Closed at the start of the next run
   * so old terminals don't accumulate when a workflow is restarted or extended.
   */
  private lastRunIntegrations: HarnessIntegration[] = [];

  /**
   * Live integrations saved across workflow runs when inject mode is active, keyed by
   * the same harness ID used in executionIntegrations (e.g. "copilot-cli", "claude-cli").
   * One entry per harness that completed a prompt with an active PTY session. A multi-harness
   * workflow (prompt 1 = copilot-cli, prompt 2 = claude-cli) produces two entries, so the
   * next run can inject into whichever harness its first prompt targets.
   *
   * Instead of disposing these integrations at the end of a run (which would sever the PTY
   * connection), WorkflowInstance holds them here. On the next run they are re-inserted into
   * executionIntegrations so createIntegrationForMode returns the correct live instance — the
   * PTY and lastInteractiveContext from the previous run are fully intact.
   * Each entry is removed and disposed when its PTY process exits.
   */
  private readonly liveInjectIntegrations = new Map<
    string,
    HarnessIntegration
  >();

  /**
   * Cleanup context for retained integrations whose provider explicitly needs
   * workflow artifacts to survive between executions. Most providers clean up
   * at execution completion even when their PTY/session watcher remains live.
   */
  private readonly retainedIntegrationArtifactContexts = new Map<
    string,
    {
      integration: HarnessIntegration;
      workingFilePath: string | undefined;
      workspaceRoot: string;
    }
  >();

  /**
   * Compatibility facts already posted to the dashboard for the run in
   * progress, keyed by code/harness/capability/message. Compatibility is
   * checked from more than one place — the preflight analysis in
   * `executeLoadedPromptFile()` and the per-launch permission translation in
   * `CliIntegration.runExecutionSession()` — and both can legitimately fire
   * more than once per run (step continuations, inject-mode fallback,
   * resumed sessions). Without this, the same "Allowed/Denied Tools are NOT
   * ENFORCED" sentence repeats once per firing. Cleared at the start of each
   * fresh (non-continuation) run in `executeLoadedPromptFile()` so a later
   * run still reports its own applicable warnings.
   */
  private reportedCompatibilityDiagnosticKeys = new Set<string>();

  /**
   * Compatibility facts already written to this run's history, tracked
   * separately from `reportedCompatibilityDiagnosticKeys`. The earliest
   * report — the preflight analysis in `executeLoadedPromptFile()` — fires
   * before this run's history file exists (`resolveHistoryFilePath()`
   * resolves to "" until `startWorkflowExecution` sets
   * `activeHistoryFilePath`, since falling back to the queue's `runRef` at
   * that point risks writing into the *previous*, already-completed run —
   * see the `promotedRunRef` comment in `executeLoadedPromptFile()`). A
   * single shared "already reported" set would let that first, unwritable
   * occurrence permanently suppress the later occurrence that actually has
   * somewhere to persist to. Cleared alongside
   * `reportedCompatibilityDiagnosticKeys`.
   */
  private persistedCompatibilityDiagnosticKeys = new Set<string>();

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming event forwarding — aggregates events from all execution integrations
  // so callers (e.g. the standalone CLI) can subscribe once on the instance.
  // ─────────────────────────────────────────────────────────────────────────
  private readonly _streamingEventsEmitter = new TypedEmitter<CliEvent[]>();
  /** Fires structured CLI events (Claude/Codex) from the active execution integration. */
  public readonly onStreamingEvents = this._streamingEventsEmitter.event;

  private readonly _streamingChunkEmitter = new TypedEmitter<string>();
  /** Fires plain-text chunks (Copilot) from the active execution integration. */
  public readonly onStreamingChunk = this._streamingChunkEmitter.event;

  private readonly _promptCompleteEmitter =
    new TypedEmitter<PromptCompleteData>();
  /**
   * Fires after each prompt fully completes (after session ID extraction),
   * carrying token stats, session ID, harness, and elapsed time.
   * Designed for the standalone CLI to display per-prompt statistics.
   */
  public readonly onPromptComplete = this._promptCompleteEmitter.event;

  private readonly _promptStartEmitter = new TypedEmitter<PromptStartData>();
  /**
   * Fires when a prompt step begins (or retries).
   * Fires once immediately with the prompt text (cliCommand undefined), then again
   * when the harness CLI command is known (cliCommand populated).
   * Designed for the standalone CLI to display step headers and CLI commands.
   */
  public readonly onPromptStart = this._promptStartEmitter.event;

  private readonly _workflowStatusMessageEmitter = new TypedEmitter<{
    stepIndex: number;
    message: string;
    severity: string;
  }>();
  /**
   * Fires for each status message produced during workflow execution
   * (end condition results, retry notifications, etc.).
   * Designed for the standalone CLI to display status updates.
   */
  public readonly onWorkflowStatusMessage =
    this._workflowStatusMessageEmitter.event;

  constructor(
    private readonly platform: PlatformAdapter,
    dashboardSink: IDashboardSink | undefined,
    /**
     * Factory for creating per-run execution integrations.
     * Each call to createIntegrationForMode() produces a fresh, isolated integration.
     */
    private readonly integrationFactory: IntegrationFactory,
    /**
     * Resolve a DETECTOR integration (singleton) by optional harness override.
     * Used only for pre-flight status checks (Initializing / Waiting / Unavailable).
     * Never used for execution — execution always goes through integrationFactory.createForExecution().
     */
    private readonly getDetectorIntegration: (
      harnessOverride?: HarnessId
    ) => HarnessIntegration,
    /**
     * Callback to propagate workflow name to CLI detector singleton terminal tabs.
     * Called whenever workflowName changes or is cleared.
     */
    private readonly onWorkflowNameChange: (name: string | undefined) => void,
    /** Callback so status bar in orchestrator stays in sync with queue state */
    private readonly onStatusBarUpdate: () => void,
    private readonly workspaceFolderPath: string | undefined,
    private readonly hostCanProvidePty: boolean = true,
    private readonly compatibilityRegistry?: HarnessCapabilityRegistry,
    /** Destination for future operational feedback migrations. */
    private readonly userFeedbackSink?: UserFeedbackSink
  ) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.dashboardSink = dashboardSink
      ? new WorkflowTaggedSink(dashboardSink, this.id)
      : undefined;

    // Per-workflow dependencies
    this.promptFileParser = new PromptFileParser(
      this.platform,
      this.userFeedbackSink
    );
    this.workflowRuntime = new WorkflowStateMachine();
    this.promptQueue = new PromptQueue(this.workflowRuntime);

    const resolvedWorkspacePath =
      workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    this.outputHistoryManager = new OutputHistoryManager(resolvedWorkspacePath);

    this.endConditionEvaluator = new EndConditionEvaluator(this.platform);
    this.endConditionHandler = new EndConditionHandler(
      this.endConditionEvaluator,
      this.promptQueue,
      () => this.dashboardSink,
      this.userFeedbackSink
    );
    this.workflowExecutor = new WorkflowExecutor(
      this.promptQueue,
      this.endConditionHandler,
      this.endConditionEvaluator,
      this.platform,
      this.userFeedbackSink
    );
    this.promptFileLoader = new PromptFileLoader(
      this.promptFileParser,
      this.promptQueue,
      () => this.dashboardSink,
      (workflow) => this.analyzeWorkflowCompatibility(workflow),
      (diagnostics) => this.reportCompatibilityDiagnostics(diagnostics),
      this.userFeedbackSink
    );
    this.promptFileWatcher = new PromptFileWatcher(
      this.promptQueue,
      () => this.dashboardSink
    );

    const bufferCallbacks: OutputCaptureCallbacks = {
      onPromptStart: (data) => this._promptStartEmitter.fire(data),
      onPromptComplete: (data) => this._promptCompleteEmitter.fire(data),
      onStatusMessage: (stepIndex, message, severity) =>
        this._workflowStatusMessageEmitter.fire({
          stepIndex,
          message,
          severity,
        }),
      getWorkflowStep: (stepIndex) =>
        this.promptQueue.getState().steps[stepIndex],
      getTotalSteps: () => this.promptQueue.getProgress().total,
    };
    this.outputCaptureBuffer = new OutputCaptureBuffer(
      `[inst:${this.id.slice(0, 8)}]`,
      bufferCallbacks
    );

    // Subscribe to queue state changes
    this.promptQueue.onDidChangeState(this.onQueueStateChanged.bind(this));
    this.workflowRuntime.onDidTransition(this.onRuntimeTransition.bind(this));
    this.workflowRuntime.onDidAttemptTransition(
      this.onAttemptTransition.bind(this)
    );
  }

  /** Exposes the injected feedback port to the future caller migrations. */
  getUserFeedbackSink(): UserFeedbackSink | undefined {
    return this.userFeedbackSink;
  }

  private async analyzeWorkflowCompatibility(
    workflow: PromptFile
  ): Promise<CompatibilityDiagnostic[]> {
    if (!this.compatibilityRegistry) {
      return [];
    }

    const workflowForAnalysis: PromptFile = {
      ...workflow,
      steps: workflow.steps ?? [],
    };
    const targets = enumerateCompatibilityTargets(
      workflowForAnalysis,
      (prompt, resolvedWorkflow) =>
        PropertyResolver.resolveTarget(prompt, resolvedWorkflow, {
          hostCanProvidePty: this.hostCanProvidePty,
        })
    );
    return analyzeCompatibility({
      workflow: workflowForAnalysis,
      executionTargets: targets,
      capabilities: await this.compatibilityRegistry.getSnapshot(),
      workspace: {
        workspaceRoot: this.workspaceFolderPath,
      },
    });
  }

  private reportCompatibilityDiagnostics(
    diagnostics: readonly CompatibilityDiagnostic[]
  ): void {
    const historyFilePath = this.resolveHistoryFilePath();

    for (const diagnostic of diagnostics) {
      const key = JSON.stringify([
        diagnostic.code,
        diagnostic.harnessId,
        diagnostic.capability,
        diagnostic.message,
      ]);
      const stepIndex =
        diagnostic.consumer?.kind === FINAL_STEP_PHASES.QUEUE
          ? diagnostic.consumer.stepIndex
          : 0;
      const timestampMs = Date.now();

      // Same fact, live-pushed once per run regardless of how many times this
      // method fires — see `reportedCompatibilityDiagnosticKeys`.
      if (!this.reportedCompatibilityDiagnosticKeys.has(key)) {
        this.reportedCompatibilityDiagnosticKeys.add(key);
        this.dashboardSink?.updateStatusMessage(
          stepIndex,
          diagnostic.message,
          diagnostic.severity,
          this.id,
          timestampMs
        );
      }

      // Persist alongside the live push so the warning survives navigating
      // away and back — same pattern as WorkflowExecutor.trackStatusMessage().
      // Tracked independently of the live-push dedup above: the earliest call
      // (preflight, before this run's history file exists) has nothing to
      // persist to, so it must not block a later call — once execution is
      // underway and a history file exists — from writing it. See
      // `persistedCompatibilityDiagnosticKeys`.
      if (
        historyFilePath &&
        !this.persistedCompatibilityDiagnosticKeys.has(key)
      ) {
        this.persistedCompatibilityDiagnosticKeys.add(key);
        this.outputHistoryManager
          .appendStatusMessage(
            historyFilePath,
            { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
            {
              message: diagnostic.message,
              severity: diagnostic.severity,
              timestamp: timestampMs,
            }
          )
          .catch((err) =>
            Log.warn(
              "Failed to append compatibility diagnostic to history:",
              err
            )
          );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  private getWorkflowPropertiesForDashboard(): Record<string, unknown> {
    const { prompt, steps, finalStep, ...workflowProperties } =
      this.promptQueue.getWorkflowFile();
    void prompt;
    void steps;
    void finalStep;
    return workflowProperties;
  }

  /**
   * Send a full SESSION_RESTORED state sync to the dashboard.
   * Called by WorkflowOrchestrator when this workflow becomes the active view,
   * and internally when flushing the event buffer.
   */
  sendFullStateToDashboard(): void {
    if (!this.dashboardSink) {
      return;
    }
    const state = this.promptQueue.getState();
    const executionState = this.getAuthoritativeExecutionState();
    const fileName = this.currentPromptFile
      ? path.basename(this.currentPromptFile.filePath)
      : state.workflowName || DEFAULT_WORKFLOW_NAME;
    Log.trace(
      `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: status=${executionState}, currentIndex=${state.currentIndex}, prompts=${state.steps.length}, bufferSteps=${this.outputCaptureBuffer.stepBufferSize}, finalBufferLoops=${this.outputCaptureBuffer.finalStepBufferSize}`
    );
    this.dashboardSink.updateSessionRestored(
      fileName,
      state.steps,
      state.results,
      executionState,
      state.currentIndex,
      state.workflowName || undefined,
      this.promptQueue.getWorkflowFile().finalStep ?? null,
      this.promptQueue.getFinalStepRuntime(),
      undefined,
      this.getWorkflowPropertiesForDashboard()
    );
    this.outputCaptureBuffer.replayTo(
      this.dashboardSink,
      { status: executionState, currentIndex: state.currentIndex },
      this.promptQueue.getFinalStepRuntime(),
      `[inst:${this.id.slice(0, 8)}]`
    );
  }

  /**
   * Replay the full current state of this workflow to an explicit sink.
   * Unlike sendFullStateToDashboard(), this bypasses the broadcast hub so
   * only the provided sink receives the messages — used for per-client
   * workflow switches in the hosted server.
   */
  replayFullStateTo(sink: IDashboardSink): void {
    const state = this.promptQueue.getState();
    const executionState = this.getAuthoritativeExecutionState();
    const fileName = this.currentPromptFile
      ? path.basename(this.currentPromptFile.filePath)
      : state.workflowName || DEFAULT_WORKFLOW_NAME;
    sink.updateSessionRestored(
      fileName,
      state.steps,
      state.results,
      executionState,
      state.currentIndex,
      state.workflowName || undefined,
      this.promptQueue.getWorkflowFile().finalStep ?? null,
      this.promptQueue.getFinalStepRuntime(),
      undefined,
      this.getWorkflowPropertiesForDashboard()
    );
    this.outputCaptureBuffer.replayTo(
      sink,
      { status: executionState, currentIndex: state.currentIndex },
      this.promptQueue.getFinalStepRuntime(),
      `[inst:${this.id.slice(0, 8)}]`
    );
  }

  /**
   * Replay only in-memory output that may be newer than the persisted timeline.
   * Addressed run switches already carry definition, runtime, and history in one
   * RUN_VIEW_LOADED snapshot, so emitting SESSION_RESTORED here would reset that
   * snapshot before the client could display it.
   */
  replayBufferedOutputTo(sink: IDashboardSink): void {
    const state = this.promptQueue.getState();
    this.outputCaptureBuffer.replayTo(
      sink,
      {
        status: this.getAuthoritativeExecutionState(),
        currentIndex: state.currentIndex,
      },
      this.promptQueue.getFinalStepRuntime(),
      `[inst:${this.id.slice(0, 8)}]`
    );
  }

  async replayOutputHistoryTo(send: (msg: unknown) => void): Promise<void> {
    const { workflowKey, runRef } = this.promptQueue.getState();
    if (!workflowKey || !runRef) {
      return;
    }
    try {
      const om = this.outputHistoryManager;
      const runs = await om.getRunsForWorkflow(workflowKey);
      const currentRunIndex = runs.indexOf(runRef);
      if (currentRunIndex >= 0) {
        const historyPath = om.getHistoryFilePath(workflowKey, runRef);
        const history = await om.loadHistory(historyPath);
        send({
          type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
          history,
          availableRuns: runs.length,
          currentRunIndex,
        });
      }
    } catch (err) {
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] replayOutputHistoryTo failed:`,
        err
      );
    }
  }

  /** Release file-system watchers and child processes owned by this instance */
  dispose(): void {
    // Clear heartbeat interval (the finally block in startWorkflowExecution handles
    // releaseLock for normal termination; crash path is covered by staleness detection).
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    this.promptFileWatcher.dispose();
    this.endConditionEvaluator.dispose();
    // Close any lingering terminals from the last run and release references.
    for (const prev of this.lastRunIntegrations) {
      prev.closeTerminal();
    }
    this.lastRunIntegrations = [];
    // Dispose all live inject integrations held across runs (PTY still alive).
    for (const [harnessKey, integration] of this.liveInjectIntegrations) {
      void this.cleanupRetainedIntegrationArtifacts(harnessKey, integration);
      integration.dispose();
    }
    this.liveInjectIntegrations.clear();
  }

  /**
   * End every terminal/integration retained from the previous run before a
   * different RunRef starts. Same-run append/continue deliberately does not
   * call this because its resumable session is part of that run's state.
   */
  async closeRetainedTerminalsForFreshRun(): Promise<void> {
    for (const previous of this.lastRunIntegrations) {
      previous.closeTerminal();
    }
    this.lastRunIntegrations = [];

    for (const [harnessKey, liveIntegration] of this.liveInjectIntegrations) {
      await this.cleanupRetainedIntegrationArtifacts(
        harnessKey,
        liveIntegration
      );
      liveIntegration.closeTerminalGracefully();
      liveIntegration.dispose();
    }
    this.liveInjectIntegrations.clear();
  }

  /**
   * Stop an active run and get its durable state onto disk.
   *
   * Ordering matters on the VS Code exit path: cancel the harness, flush
   * immediately, and only then allow a brief settle window. Flushing first is
   * what makes exit fast — the streamed output and working-file metadata are
   * the parts that must survive, and they are already written by the time we
   * wait on anything.
   *
   * The settle window is a small bonus, not a guarantee: if the run finishes
   * cancelling in time we persist its final aggregate and terminal status here.
   * Anything that misses it is repaired on the next startup by
   * `WorkflowLockManager.normalizeStaleLocks` plus
   * `OutputHistoryManager.recoverInterruptedRun`.
   *
   * Ordinary view disposal remains synchronous.
   */
  async shutdown(): Promise<void> {
    const status = this.workflowRuntime.status;
    if (
      status === EXECUTION_STATES.RUNNING ||
      status === EXECUTION_STATES.PAUSING ||
      status === EXECUTION_STATES.PAUSED
    ) {
      await this.stop().catch((error) =>
        Log.warn(
          `[inst:${this.id.slice(0, 8)}] Failed to request stop during shutdown:`,
          error
        )
      );
    }

    await this.flushDurableState();

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.executionSettledPromise,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(
          resolve,
          WorkflowInstance.SHUTDOWN_SETTLE_TIMEOUT_MS
        );
      }),
    ]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    // Persist whatever the settle window produced (final aggregate, terminal status).
    await this.flushDurableState();
  }

  /**
   * The manifest this instance's history/timeline writes belong to.
   *
   * `activeHistoryFilePath` is only assigned by `startWorkflowExecution`, so it
   * is empty on an instance that was restored from a working file rather than
   * started here — exactly the shape a host restart leaves behind for a run that
   * was paused when the previous host died. Every history writer early-returns on
   * an empty path, so without this fallback a resumed run executes to completion
   * while `manifest.json` stays frozen at whatever the dead process last wrote,
   * and the run panel (which lists from manifests) disagrees with the header
   * (which reads the run's `workflow.ctrlyoke.json`) forever after.
   *
   * The queue's own `workflowKey`/`runRef` are restored with the working file and
   * identify the run's manifest exactly, so derive from them. A draft has no
   * `runRef` yet and correctly resolves to "" — it has no manifest to write to.
   */
  private resolveHistoryFilePath(): string {
    if (this.activeHistoryFilePath) {
      return this.activeHistoryFilePath;
    }
    const { workflowKey, runRef } = this.promptQueue.getState();
    if (!workflowKey || !runRef) {
      return "";
    }
    return this.outputHistoryManager.getHistoryFilePath(workflowKey, runRef);
  }

  /** Write pending history/working-file state for this instance. */
  private async flushDurableState(): Promise<void> {
    await this.pendingRuntimeTransitionHistoryWrite;
    await this.outputHistoryManager.flushPendingWrites(
      this.resolveHistoryFilePath() || undefined
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status / summary
  // ─────────────────────────────────────────────────────────────────────────

  getQueueState(): QueueState {
    return this.promptQueue.getState();
  }

  getSummary(): WorkflowSummary {
    const state = this.promptQueue.getState();
    const executionTimeUpdatedAt = Date.now();
    const workflowHarness =
      this.currentPromptFile?.promptFile?.harness ??
      this.promptQueue.getWorkflowFile().harness;
    const harness = PropertyResolver.resolveHarnessValue(
      undefined,
      workflowHarness
    );
    return {
      id: this.id,
      workflowKey: state.workflowKey,
      runRef: state.runRef,
      workflowName: this.workflowName || state.workflowName || "",
      filePath: this.filePath,
      workingFilePath: state.workingFilePath || undefined,
      executionState: this.getAuthoritativeExecutionState(),
      currentStep: state.currentIndex,
      totalSteps: state.steps.length,
      startedAt: this.startedAt || undefined,
      executionTimeMs: this.workflowRuntime.getActiveExecutionTime(),
      executionTimeUpdatedAt,
      harness,
    };
  }

  getCurrentPromptFile(): { fileName: string; steps: unknown[] } | null {
    if (!this.currentPromptFile?.promptFile.steps) {
      return null;
    }
    return {
      fileName: path.basename(this.currentPromptFile.filePath),
      steps: this.currentPromptFile.promptFile.steps.map((p) => ({
        prompt: isScriptStep(p) ? p.script : p.prompt,
      })),
    };
  }

  /** Internal accessor used by WorkflowOrchestrator for openCurrentPromptFile */
  getCurrentPromptFilePath(): string | undefined {
    return this.currentPromptFile?.filePath;
  }

  /**
   * Set the current prompt file reference (for WorkflowOrchestrator draft prompt setup).
   */
  setCurrentPromptFile(filePath: string, promptFile: PromptFile): void {
    this.currentPromptFile = { filePath, promptFile };
  }

  /**
   * Keep the in-memory prompt file aligned with the queue after dashboard/appends.
   * This avoids relying on the working-file watcher for local writes, which is
   * intentionally muted in idle/completed states to preserve the dashboard view.
   */
  private syncCurrentPromptFileFromQueue(filePathOverride?: string): void {
    const nextFilePath =
      filePathOverride ??
      this.currentPromptFile?.filePath ??
      this.promptQueue.getState().workingFilePath;

    if (!nextFilePath) {
      return;
    }

    const workflowFile = this.promptQueue.getWorkflowFile();
    this.currentPromptFile = {
      filePath: nextFilePath,
      promptFile: {
        ...workflowFile,
        steps: this.promptQueue.getState().steps.map((prompt) => ({
          ...prompt,
        })),
      },
    };
  }

  /**
   * Set up a file watcher for the given file path (for WorkflowOrchestrator draft prompt setup).
   */
  initializeFileWatcher(filePath: string): void {
    this.setupPromptFileWatcher(filePath);
  }

  async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.promptQueue.readWorkingFile(workingFilePath);
  }

  getOutputHistoryManager(): OutputHistoryManager {
    return this.outputHistoryManager;
  }

  /** The RunRef this instance is currently executing, if any (undefined while idle). */
  getExecutionRunRef(): RunRef | undefined {
    return this.executionRunRef;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load a prompt file into the dashboard without executing.
   */
  async loadPromptFile(filePath: string): Promise<boolean> {
    // Clear queue to reset cached workflow name — ensures fresh name from filename
    this.promptQueue.clearQueue();
    // Track the source file path for summaries and state sync
    this.filePath = filePath;

    const workingFilePath = await this.promptFileLoader.loadPromptFile(
      filePath,
      this.workspaceFolderPath
    );

    if (!workingFilePath) {
      this.propagateWorkflowNameToIntegrations();
      return false;
    }

    const promptFile = await this.promptFileParser.parsePromptFile(filePath);
    if (!promptFile) {
      this.propagateWorkflowNameToIntegrations();
      return false;
    }

    this.currentPromptFile = { filePath, promptFile };
    this.setupPromptFileWatcher(workingFilePath);
    this.propagateWorkflowNameToIntegrations();
    return true;
  }

  /**
   * Load an already-substituted template workflow into the dashboard without
   * executing. There is no source file on disk — the working file created
   * here is the only artifact, with `originalFile` left undefined so Save As
   * is the only way to export a durable copy.
   */
  async loadFromTemplate(
    promptFile: PromptFile,
    displayName: string
  ): Promise<void> {
    this.promptQueue.clearQueue();
    this.filePath = displayName;

    const workingFilePath = await this.promptFileLoader.loadFromMemory(
      promptFile,
      displayName,
      this.workspaceFolderPath
    );

    if (workingFilePath) {
      this.currentPromptFile = { filePath: displayName, promptFile };
      this.setupPromptFileWatcher(workingFilePath);
    }

    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Load an inline prompt string into the queue without a file.
   * Behaves like loading a single-prompt .prompt.md file.
   */
  loadPromptString(
    promptText: string,
    workflowOverrides?: Partial<PromptFile>
  ): void {
    this.promptQueue.clearQueue();
    this.filePath = "";
    const promptFile: PromptFile = {
      steps: [{ prompt: promptText }],
      ...workflowOverrides,
    };
    this.currentPromptFile = { filePath: "<inline>", promptFile };
    this.promptQueue.loadPrompts(promptFile);
    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Restore a workflow from a working file.
   * Shared helper used by resumeWorkflow and loadWorkingFile.
   */
  async restoreWorkflowFromWorkingFile(workingFilePath: string): Promise<void> {
    // Read working file FIRST so this.filePath is correct when queue state fires
    // (onDidChangeState → getSummary() → filePath must already be set)
    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    if (workingFile?.steps) {
      const filePath = workingFile.originalFile || workingFilePath;
      this.filePath = filePath;
      this.currentPromptFile = {
        filePath,
        promptFile: { steps: workingFile.steps },
      };
    }

    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace",
      true
    );
    await this.hydrateActiveExecutionOutputCaches();

    this.setupPromptFileWatcher(workingFilePath);
    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Load a working file by path (used by WorkflowOrchestrator.loadWorkingFile).
   */
  async loadWorkingFile(filePath: string): Promise<void> {
    try {
      await this.restoreWorkflowFromWorkingFile(filePath);
      Log.info(`Loaded workflow: ${filePath}`);
    } catch (loadError) {
      Log.error("Failed to load workflow:", loadError as Error);
      notifyUserFeedback(
        this.userFeedbackSink,
        "error",
        `Failed to load workflow: ${getErrorMessage(loadError)}`
      );
      throw loadError;
    }
  }

  /**
   * Auto-load from working file without triggering auto-start
   * (called by triggerAutoLoad in orchestrator).
   */
  async autoLoadFromWorkingFile(workingFilePath: string): Promise<void> {
    // Read working file FIRST so this.filePath is correct when queue state fires
    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    if (workingFile?.steps) {
      const filePath = workingFile.originalFile || workingFilePath;
      this.filePath = filePath;
      this.currentPromptFile = {
        filePath,
        promptFile: { steps: workingFile.steps },
      };
    }

    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace",
      true
    );
    await this.hydrateActiveExecutionOutputCaches();

    this.setupPromptFileWatcher(workingFilePath);
    this.propagateWorkflowNameToIntegrations();
  }

  /**
   * Rebuild the small in-memory response cache required by a resumed active
   * executor. Historical/inactive views never hydrate this cache; they read
   * timeline data through their own resolver consumers instead.
   */
  private async hydrateActiveExecutionOutputCaches(): Promise<void> {
    const state = this.promptQueue.getState();
    const activeExecutionStates: QueueState["status"][] = [
      EXECUTION_STATES.RUNNING,
      EXECUTION_STATES.PAUSED,
      EXECUTION_STATES.PAUSING,
      EXECUTION_STATES.CANCELLING,
    ];
    if (
      !state.workflowKey ||
      !state.runRef ||
      !activeExecutionStates.includes(state.status)
    ) {
      return;
    }

    const manifestPath = this.outputHistoryManager.getHistoryFilePath(
      state.workflowKey,
      state.runRef
    );
    const resolver = this.outputHistoryManager.getRunOutputResolver();
    const queueTargets: OutputExecutionTarget[] = Array.from(
      { length: Math.min(state.currentIndex, state.steps.length) },
      (_, stepIndex) => ({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex })
    );
    try {
      const [queueAttempts, finalStepAttempts] = await Promise.all([
        resolver.resolveLatestAttempts(manifestPath, queueTargets),
        resolver.resolveLatestFinalStepAttempts(manifestPath),
      ]);
      const queueEntries = [...queueAttempts.values()].flatMap((attempt) =>
        attempt.target.kind === FINAL_STEP_PHASES.QUEUE
          ? [
              {
                stepIndex: attempt.target.stepIndex,
                responseText: attempt.responseText,
                scriptOutput: attempt.scriptOutput,
              },
            ]
          : []
      );
      const finalStepResponseTexts = new Map<number, string>();
      for (const attempt of finalStepAttempts.values()) {
        if (
          attempt.target.kind === FINAL_STEP_PHASES.FINAL_STEP &&
          attempt.responseText !== undefined
        ) {
          finalStepResponseTexts.set(
            attempt.target.loopIndex,
            attempt.responseText
          );
        }
      }
      this.promptQueue.hydrateActiveRuntimeOutputCache(
        queueEntries,
        finalStepResponseTexts
      );
    } catch (error) {
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] Failed to hydrate active output cache from timeline:`,
        error
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Executes a run already allocated and written by `WorkingFileManager.seedNewRun`
   * (Re-run / CLI `rerun`) — a brand-new `RunRef` whose definition was seeded from an
   * older run that is not necessarily the one this instance currently has loaded.
   *
   * This is deliberately NOT `loadWorkingFile(...)` followed by a plain
   * `executeLoadedPromptFile(harnessOverride)` call: that method's fresh-execution-start
   * branch has no way to tell "this run was already promoted" from "this is a draft/older
   * run that still needs promoting" — it would call `promptQueue.promoteToNewRun()` again
   * (minting a second, unwanted run) and would skip initializing the seeded run's
   * manifest/events (violating the invariant that every promoted run has all three run
   * artifacts). Instead: load the seeded file, initialize ITS timeline directly, then
   * execute with `continueFromCurrent=true` so `executeLoadedPromptFile` treats it purely
   * as "run exactly what's loaded" — no restart, no re-promotion.
   */
  async executeSeededRun(
    seeded: {
      workingFilePath: string;
      sourceRunRef: RunRef;
      runRef: RunRef;
      runId: number;
      runDir: string;
      stagingRunDir: string;
      stagingWorkingFilePath: string;
      allocation: import("./orchestration/WorkflowLineageRepository").AllocatedRun;
      startedAt: number;
    },
    workflowKey: WorkflowKey,
    harnessOverride?: HarnessId,
    onPrepared?: () => Promise<void>
  ): Promise<void> {
    await this.closeRetainedTerminalsForFreshRun();
    await this.loadWorkingFile(seeded.workingFilePath);
    const historyInit = await this.outputHistoryManager.initializeRunAt(
      workflowKey,
      seeded.runRef,
      seeded.runDir,
      seeded.runId,
      seeded.startedAt,
      [seeded.sourceRunRef],
      this.getDefinitionRevisionContext().definition
    );
    if (!historyInit.filePath) {
      throw new Error(
        `Failed to initialize timeline for seeded run ${workflowKey}/${seeded.runRef}`
      );
    }
    await onPrepared?.();
    await this.executeLoadedPromptFile(
      harnessOverride,
      false,
      historyInit.filePath,
      true
    );
  }

  /**
   * Bind and execute one already-promoted run as an explicit continuation.
   * Callers must have already validated that this is the lineage's permitted
   * execution target; this method never discovers a "latest" run.
   */
  async executeContinuationAtRun(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    onPrepared?: () => Promise<void>
  ): Promise<void> {
    const workspaceRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );

    // Binding is intentionally done only here, as part of an explicit action.
    await this.loadWorkingFile(workingFilePath);
    const state = this.promptQueue.getState();
    if (state.workflowKey !== workflowKey || state.runRef !== runRef) {
      throw new Error("Continuation target did not bind to the requested run");
    }
    if (state.definitionRevision !== expectedDefinitionRevision) {
      throw new Error(
        `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${state.definitionRevision}`
      );
    }
    await onPrepared?.();

    const historyFilePath = this.outputHistoryManager.getHistoryFilePath(
      workflowKey,
      runRef
    );
    await this.prepareFinalStepContinuation(historyFilePath);
    // Commit before reopening: a newer definition must have its immutable
    // snapshot in events.jsonl before any continuation output can be written.
    await this.outputHistoryManager.commitDefinitionRevision(
      historyFilePath,
      this.getDefinitionRevisionContext()
    );
    await this.outputHistoryManager.reopenRun(
      historyFilePath,
      EXECUTION_STATES.RUNNING,
      state.definitionRevision,
      state.steps.length
    );

    if (this.getAuthoritativeExecutionState() === EXECUTION_STATES.PAUSED) {
      const targetRunIndices = await this.computeTargetRunIndices(
        historyFilePath,
        true
      );
      await this.resume(historyFilePath, targetRunIndices);
      return;
    }

    await this.executeLoadedPromptFile(undefined, true, historyFilePath);
  }

  /**
   * Execute the currently loaded prompt file.
   */
  async executeLoadedPromptFile(
    modeOverride?: HarnessId,
    continueFromCurrent: boolean = false,
    preinitializedHistoryFilePath: string = "",
    prePromotedFreshStart: boolean = false
  ): Promise<void> {
    if (!this.currentPromptFile) {
      const queueState = this.promptQueue.getState();
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] executeLoadedPromptFile: currentPromptFile is null — ` +
          `workingFilePath=${queueState.workingFilePath ?? "(none)"}, ` +
          `prompts=${queueState.steps.length}, status=${this.getAuthoritativeExecutionState()}`
      );
      notifyUserFeedback(
        this.userFeedbackSink,
        "warning",
        "No prompt file loaded. Use 'Change' button to select a file first."
      );
      return;
    }

    const { filePath } = this.currentPromptFile;

    const prevQueueState = this.promptQueue.getState();
    const prevExecutionState = this.getAuthoritativeExecutionState();
    // Only COMPLETED workflows count as having "completed" steps for append-continuation.
    const prevCompletedCount =
      prevExecutionState === EXECUTION_STATES.COMPLETED
        ? this.promptQueue.getCompletedCount()
        : 0;

    const { promptFile } = this.currentPromptFile;
    const fileName = path.basename(filePath);

    const filePromptCount = promptFile.steps?.length ?? 0;
    // Count pending (never-run) prompts in the queue. Newly appended prompts are
    // PENDING; prompts that ran but were cancelled/skipped are CANCELLED. Using
    // pendingCount instead of (filePromptCount > prevCompletedCount) prevents a
    // false-positive when a completed workflow has cancelled prompts: e.g. 3 prompts
    // where 1 was cancelled → completedCount=2, filePromptCount=3, but no PENDING
    // prompts exist, so this is a restart, not an append continuation.
    const pendingCount = prevQueueState.results.filter(
      (r) => r.status === STEP_STATUS.PENDING
    ).length;
    const isAppendContinuation =
      !continueFromCurrent && prevCompletedCount > 0 && pendingCount > 0;

    // Detect stop → rewind → Run scenario: the queue is IDLE but already has
    // a partial run in progress (currentIndex > 0). This happens when the
    // user stopped a workflow, moved the start position past the cancelled
    // step (a nonzero rewind), and then pressed Run instead of Resume. We
    // want to reuse the existing history file rather than starting a fresh run.
    const isIdleContinuation =
      !continueFromCurrent &&
      !isAppendContinuation &&
      prevExecutionState === EXECUTION_STATES.IDLE &&
      prevQueueState.currentIndex > 0;

    Log.debug(
      `[executeLoadedPromptFile] continueFromCurrent=${continueFromCurrent}, ` +
        `prevQueueStatus=${prevExecutionState}, prevCompletedCount=${prevCompletedCount}, ` +
        `pendingCount=${pendingCount}, filePromptCount=${filePromptCount}, ` +
        `isAppendContinuation=${isAppendContinuation}, isIdleContinuation=${isIdleContinuation}`
    );

    // Declared outside try so the catch block can finalize history on early errors
    // (errors thrown before startWorkflowExecution, which has its own finally block).
    let historyFilePath = preinitializedHistoryFilePath;
    // The run *this call* promoted, if any. Publishing a run deletes the
    // lineage's draft, so from that moment the run is the only thing the user's
    // definition lives in and the only address a client can be sent to — the
    // catch below has to be able to name it even when the throw beat
    // `historyFilePath` being resolved. Never read the queue's `runRef` for
    // this: on a later run's failed start that still holds the *previous*,
    // legitimately completed run.
    let promotedRunRef: RunRef | undefined;

    // A genuinely fresh run (not a step continuation, append, or idle-rewind
    // resume) starts a new compatibility-reporting window so this run's
    // applicable warnings are reported at least once, even if the previous
    // run already reported the identical fact.
    if (!continueFromCurrent && !isAppendContinuation && !isIdleContinuation) {
      this.reportedCompatibilityDiagnosticKeys.clear();
      this.persistedCompatibilityDiagnosticKeys.clear();
    }

    try {
      Log.info(`ctrlyoke: Executing loaded prompt file: ${filePath}`);

      // Compatibility is authoritative at execution time. Resolve only the
      // consumers that exist in the current queue/definition so a workflow
      // default never stands in for a step-level harness override.
      const compatibilityDiagnostics = await this.analyzeWorkflowCompatibility({
        ...this.promptQueue.getWorkflowFile(),
        steps: this.promptQueue.getState().steps,
      });
      const compatibilityErrors = compatibilityDiagnostics.filter(
        (diagnostic) =>
          diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
      );
      if (compatibilityErrors.length > 0) {
        // Report here (rather than after EXECUTION_STARTED, like the success
        // path below) because this early-return means EXECUTION_STARTED is
        // never sent at all — nothing will ever reset the dashboard's runtime
        // state to make room for it otherwise.
        this.reportCompatibilityDiagnostics(compatibilityDiagnostics);
        Log.error(
          "ctrlyoke: Compatibility preflight failed:",
          compatibilityErrors.map((diagnostic) => diagnostic.message).join(" ")
        );
        this.workflowRuntime.fail();
        await this.promptQueue.commitRuntimeTransition();
        return;
      }

      // Pre-flight: use the DETECTOR singleton (already initialized at startup).
      // If the harness is still initializing or polling, wait until it settles
      // (up to 35 s — enough to cover CopilotChat's 6 × 5 s polling window).
      // If it ends up unavailable, surface the error in the webview and bail.
      const preflightHarness = PropertyResolver.resolveHarnessValue(
        modeOverride,
        this.currentPromptFile?.promptFile?.harness
      );
      const detectedIntegration = this.getDetectorIntegration(preflightHarness);
      let detailedStatus = detectedIntegration.getDetailedStatus();

      if (
        detailedStatus.initializationStatus === HarnessStatus.Initializing ||
        detailedStatus.initializationStatus === HarnessStatus.Waiting
      ) {
        Log.info(
          `ctrlyoke: Harness not ready (${detailedStatus.initializationStatus}), waiting for status change…`
        );
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (!settled) {
              settled = true;
              subscription.dispose();
              clearTimeout(timer);
              resolve();
            }
          };
          const subscription = detectedIntegration.onDidChangeStatus(settle);
          const timer = setTimeout(settle, 35_000);
        });
        detailedStatus = detectedIntegration.getDetailedStatus();
      }

      if (detailedStatus.initializationStatus !== HarnessStatus.Ready) {
        const errorMessage = detailedStatus.message || "Harness is unavailable";
        Log.error(`ctrlyoke: Harness not ready: ${errorMessage}`);
        const preflightStepCount = this.promptQueue.getState().steps.length;
        if (this.dashboardSink && preflightStepCount > 0) {
          this.dashboardSink.updateExecutionStarted(
            this.id,
            fileName,
            preflightStepCount
          );
          this.dashboardSink.updateCliOutput(0, {
            prompt: "",
            response: "",
            elapsed: 0,
            errorMessage,
          });
        }
        this.workflowRuntime.fail();
        await this.promptQueue.commitRuntimeTransition();
        if (historyFilePath) {
          await this.outputHistoryManager.finalizeRun(
            historyFilePath,
            EXECUTION_STATES.ERROR,
            preflightStepCount
          );
        }
        return;
      }

      const executionState = this.getAuthoritativeExecutionState();
      const isRestartFromBeginning =
        !continueFromCurrent &&
        !isAppendContinuation &&
        (executionState === EXECUTION_STATES.COMPLETED ||
          executionState === EXECUTION_STATES.PAUSED ||
          executionState === EXECUTION_STATES.STOPPED ||
          executionState === EXECUTION_STATES.ERROR);

      if (isRestartFromBeginning) {
        await this.closeRetainedTerminalsForFreshRun();
      }

      // Create the execution integration only after passing pre-flight checks.
      const integration = this.createIntegrationForMode(modeOverride);

      if (!continueFromCurrent && !isAppendContinuation) {
        if (isRestartFromBeginning) {
          Log.debug(
            `ctrlyoke: Queue in ${executionState} state, restarting from beginning`
          );
          await this.promptQueue.restart();
        }
      } else if (isAppendContinuation) {
        Log.debug(
          `ctrlyoke: Append continuation — skipping restart, continuing from step ${prevCompletedCount}`
        );
        if (executionState === EXECUTION_STATES.IDLE) {
          await this.promptQueue.restoreCompletedSteps(prevCompletedCount);
        }
      } else {
        Log.debug(
          `ctrlyoke: Continuing from current position (append mode), preserving history`
        );
      }

      const currentQueueState = this.promptQueue.getState();
      const totalSteps = currentQueueState.steps.length;
      const currentStep =
        currentQueueState.steps[currentQueueState.currentIndex];
      const executionMode: ExecutionMode | undefined = currentStep
        ? PropertyResolver.resolveExecutionMode(
            currentStep,
            this.promptQueue.getWorkflowFile(),
            { hostCanProvidePty: this.hostCanProvidePty }
          )
        : undefined;

      let workingFilePath = currentQueueState.workingFilePath ?? "";
      const workflowKey = currentQueueState.workflowKey;
      if (
        !continueFromCurrent &&
        !isAppendContinuation &&
        !isIdleContinuation &&
        !prePromotedFreshStart &&
        workflowKey
      ) {
        const runWorkspaceRoot =
          this.workspaceFolderPath ?? this.platform.getWorkspaceRoot() ?? "";
        const startedAt = Date.now();
        const promoted = await this.promptQueue.promoteToNewRun(
          runWorkspaceRoot,
          startedAt
        );
        if (promoted) {
          workingFilePath = promoted.workingFilePath;
          promotedRunRef = promoted.runRef;
          this.syncCurrentPromptFileFromQueue(promoted.workingFilePath);
          this.executionRunRef = promoted.runRef;
          const historyInit = await this.outputHistoryManager.initializeRunAt(
            workflowKey,
            promoted.runRef,
            promoted.runDir,
            promoted.runId,
            startedAt,
            [],
            this.getDefinitionRevisionContext().definition
          );
          if (!historyInit.filePath) {
            throw new Error(
              `Failed to initialize timeline for promoted run ${workflowKey}/${promoted.runRef}`
            );
          }
          historyFilePath = this.outputHistoryManager.getHistoryFilePath(
            workflowKey,
            promoted.runRef
          );
        }
      } else if (isAppendContinuation && workflowKey) {
        const runRef = currentQueueState.runRef;
        if (!runRef) {
          throw new Error(
            "Append continuation requires an explicit promoted run"
          );
        }
        historyFilePath = this.outputHistoryManager.getHistoryFilePath(
          workflowKey,
          runRef
        );
        Log.debug(
          `🟢 [APPEND-DEBUG] Reusing explicit history file for append continuation: ${historyFilePath}`
        );

        // Cache historical step outputs in completedStepOutputs so they can be
        // replayed by sendFullStateToDashboard() when the user switches away and
        // back to this workflow mid-execution.  Without this, completedStepOutputs
        // is empty for steps that ran in the previous VS Code session, and
        // switching back shows only the currently-running step's output.
        if (historyFilePath) {
          try {
            const history =
              await this.outputHistoryManager.loadHistory(historyFilePath);

            const cliEntriesByStep = new Map<
              number,
              Array<{ cliOutput: CliOutput; attemptIndex: number }>
            >();
            for (const entry of history.orderedEntries) {
              if (
                entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
                entry.target.kind === FINAL_STEP_PHASES.QUEUE
              ) {
                const stepIndex = (
                  entry.target as {
                    kind: typeof FINAL_STEP_PHASES.QUEUE;
                    stepIndex: number;
                  }
                ).stepIndex;
                const arr = cliEntriesByStep.get(stepIndex) ?? [];
                arr.push({
                  cliOutput: entry.cliOutput,
                  attemptIndex: entry.attemptIndex,
                });
                cliEntriesByStep.set(stepIndex, arr);
              }
            }

            for (let i = 0; i < prevCompletedCount; i++) {
              const entries = cliEntriesByStep.get(i);
              if (entries && entries.length > 0) {
                const cliOutputs = entries.map((e) => e.cliOutput);
                const maxAttemptIndex = Math.max(
                  ...entries.map((e) => e.attemptIndex)
                );
                this.outputCaptureBuffer.cacheHistoricalStepOutput(
                  i,
                  cliOutputs,
                  maxAttemptIndex > 0
                    ? {
                        currentRetry: maxAttemptIndex,
                        maxRetries: maxAttemptIndex,
                      }
                    : undefined
                );
              }
            }
            Log.debug(
              `[inst:${this.id.slice(0, 8)}] Cached ${this.outputCaptureBuffer.stepBufferSize} historical step(s) for replay on workflow switch`
            );
          } catch (error) {
            Log.warn(
              `[inst:${this.id.slice(0, 8)}] Failed to cache historical step outputs for replay: ${error}`
            );
          }
        }
      } else if (continueFromCurrent && workflowKey) {
        const runRef = currentQueueState.runRef;
        if (!runRef) {
          throw new Error("Continuation requires an explicit promoted run");
        }
        historyFilePath =
          historyFilePath ||
          this.outputHistoryManager.getHistoryFilePath(workflowKey, runRef);
        Log.debug(
          `🟢 [APPEND-DEBUG] Manual resume: Reusing existing history file: ${historyFilePath}`
        );
      } else if (isIdleContinuation && workflowKey) {
        const runRef = currentQueueState.runRef;
        if (!runRef) {
          throw new Error(
            "Idle continuation requires an explicit promoted run"
          );
        }
        historyFilePath = this.outputHistoryManager.getHistoryFilePath(
          workflowKey,
          runRef
        );
        Log.debug(
          `🟢 [APPEND-DEBUG] Idle continuation (stop+skip): Reusing existing history file: ${historyFilePath}`
        );
      }

      if (this.dashboardSink && totalSteps > 0) {
        if (continueFromCurrent || isIdleContinuation) {
          const currentIndex = currentQueueState.currentIndex;
          const willInject = integration.canReuseForInject();
          Log.debug(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true, preserveStepCount=${currentIndex}, totalSteps=${totalSteps}, isInjectMode=${willInject}`
          );
          if (willInject) {
            this.dashboardSink.updateExecutionStarted(
              this.id,
              fileName,
              totalSteps,
              true,
              currentIndex,
              true,
              executionMode
            );
          } else {
            this.dashboardSink.updateExecutionStarted(
              this.id,
              fileName,
              totalSteps,
              true,
              currentIndex,
              undefined,
              executionMode
            );
          }
        } else if (isAppendContinuation) {
          const willInject = integration.canReuseForInject();
          Log.debug(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true (append-to-completed), preserveStepCount=${prevCompletedCount}, totalSteps=${totalSteps}, isInjectMode=${willInject}`
          );
          if (willInject) {
            this.dashboardSink.updateExecutionStarted(
              this.id,
              fileName,
              totalSteps,
              true,
              prevCompletedCount,
              true,
              executionMode
            );
          } else {
            this.dashboardSink.updateExecutionStarted(
              this.id,
              fileName,
              totalSteps,
              true,
              prevCompletedCount,
              undefined,
              executionMode
            );
          }
        } else {
          Log.debug(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED fresh start, totalSteps=${totalSteps}`
          );
          this.clearOutputBuffers();
          this.dashboardSink.updateExecutionStarted(
            this.id,
            fileName,
            totalSteps,
            undefined,
            undefined,
            undefined,
            executionMode
          );
        }
      }

      // Reported only now, after EXECUTION_STARTED has already gone out: a
      // fresh (non-continuation) start makes the dashboard wipe its live
      // status-message feed to make room for the new run (see
      // EXECUTION_STARTED's webview handler). Reporting any earlier races
      // that reset — the diagnostic lands, then gets discarded a message
      // later — so the warning silently never appears live, only resurfacing
      // once the run ends and history is reloaded from disk.
      this.reportCompatibilityDiagnostics(compatibilityDiagnostics);

      if (totalSteps > 0) {
        const currentIndex = currentQueueState.currentIndex;
        integration.setWorkflowProgress(currentIndex + 1, totalSteps);
      }
      const targetRunIndices = await this.computeTargetRunIndices(
        historyFilePath,
        continueFromCurrent || isAppendContinuation || isIdleContinuation
      );
      Log.debug(
        `🟢 [APPEND-DEBUG] Starting workflow execution with historyFilePath: "${historyFilePath}" (empty=${!historyFilePath})`
      );
      await this.startWorkflowExecution(
        integration,
        historyFilePath,
        workingFilePath || undefined,
        targetRunIndices
      );
    } catch (error) {
      Log.error("Failed to execute prompt file:", error);
      this.promptQueue.finalizeFailedInFlightPrompt();
      this.workflowRuntime.fail();
      await this.promptQueue.commitRuntimeTransition();
      // Finalize the history run if it was initialized before the error occurred
      // (errors thrown between initializeRun and startWorkflowExecution; the latter
      // has its own finally block that handles finalization for errors within execution).
      //
      // A run promoted by this call must be finalized even when the throw came
      // from `initializeRunAt` itself, before `historyFilePath` was resolved:
      // the run directory is already published (and the draft already deleted),
      // and its staged manifest says RUNNING. Left that way the lineage shows a
      // permanently executing run that retention never prunes, and the header
      // offers neither Resume nor "Run" for the one address the user's
      // definition now lives at.
      // The lineage *key* is stable across a promotion (only the RunRef moves),
      // so reading it from the queue here still names the run promoted above.
      const failedRunKey = this.promptQueue.getState().workflowKey;
      const runToFinalize =
        historyFilePath ||
        (promotedRunRef && failedRunKey
          ? this.outputHistoryManager.getHistoryFilePath(
              failedRunKey,
              promotedRunRef
            )
          : "");
      if (runToFinalize) {
        await this.outputHistoryManager
          .finalizeRun(
            runToFinalize,
            EXECUTION_STATES.ERROR,
            this.promptQueue.getProgress().total
          )
          .catch((err) =>
            Log.warn("Failed to finalize history run on early error:", err)
          );
      }
      notifyUserFeedback(
        this.userFeedbackSink,
        "error",
        `ctrlyoke: Execution failed: ${error}`
      );
      this.dashboardSink?.updateStatusMessage(
        this.promptQueue.getState().currentIndex,
        `Execution failed: ${getErrorMessage(error)}`,
        STATUS_MESSAGE_SEVERITY.ERROR,
        this.id
      );
    }
  }

  /**
   * Pause current execution.
   */
  async pause(): Promise<void> {
    if (!this.workflowRuntime.pause()) {
      return;
    }

    await this.promptQueue.commitRuntimeTransition();
  }

  /**
   * Cancel a pending pause request, resuming execution immediately.
   */
  async cancelPause(): Promise<void> {
    if (!this.workflowRuntime.cancelPause()) {
      return;
    }

    await this.promptQueue.commitRuntimeTransition();
  }

  /**
   * Resume execution from paused state.
   */
  async resume(
    historyFilePath?: string,
    targetRunIndices?: Map<string, number>
  ): Promise<void> {
    // IDLE with currentIndex > 0 = user stopped, then used "set start position" to reposition.
    // Treat as a continuation from the set position so existing outputs are preserved.
    if (
      this.workflowRuntime.status === EXECUTION_STATES.IDLE &&
      this.promptQueue.getState().currentIndex > 0
    ) {
      await this.executeLoadedPromptFile(undefined, true);
      return;
    }

    // STOPPED = a step was appended to a completed workflow via reopenForContinuation().
    // ERROR = the current step failed; retry it from the current (failed) position.
    // Both use executeLoadedPromptFile so EXECUTION_STARTED is sent to the webview and
    // the history file is properly initialised for the new step's output.
    if (
      this.workflowRuntime.status === EXECUTION_STATES.STOPPED ||
      this.workflowRuntime.status === EXECUTION_STATES.ERROR
    ) {
      await this.executeLoadedPromptFile(undefined, true);
      return;
    }

    if (!this.workflowRuntime.resume()) {
      return;
    }

    await this.promptQueue.commitRuntimeTransition();

    if (this.workflowExecutor.isAwaitingResponse()) {
      Log.debug(
        "▶️ Resuming while Copilot is still responding - will continue when response completes"
      );
      return;
    }

    if (this.startPending) {
      Log.debug("▶️ Waiting for the paused execution cycle to settle");
      await this.executionSettledPromise;
      if (this.workflowRuntime.status !== EXECUTION_STATES.RUNNING) {
        return;
      }
    }

    Log.info("▶️ Resuming workflow from paused position");
    await this.startWorkflowExecution(
      undefined,
      historyFilePath ?? this.resolveHistoryFilePath(),
      this.promptQueue.getState().workingFilePath,
      targetRunIndices
    );
  }

  /**
   * Stop current execution.
   */
  async stop(): Promise<void> {
    const integration = this.activeIntegration || this.getDetectorIntegration();
    const stopReason = "Workflow stopped by user";

    Log.info(`⏹️ WorkflowInstance.stop() - stopping active integration`);

    this.promptQueue.markInFlightPromptCancelled();
    const activeAttempt = this.workflowRuntime.getActiveAttempt();
    if (activeAttempt) {
      this.workflowRuntime.cancelAttempt(
        activeAttempt.target,
        activeAttempt.attemptIndex,
        stopReason
      );
    } else {
      const currentTarget = this.getCurrentCancellationTarget();
      if (currentTarget) {
        const pendingAttempt = this.workflowRuntime.getAttempt(currentTarget);
        this.workflowRuntime.cancelAttempt(
          currentTarget,
          pendingAttempt?.attemptIndex ?? 0,
          stopReason
        );
      }
    }

    if (this.workflowRuntime.requestStop()) {
      await this.promptQueue.commitRuntimeTransition({ persist: false });
    }

    let confirmedStoppedCalled = false;

    const confirmStopped = async (): Promise<void> => {
      if (confirmedStoppedCalled) {
        return;
      }

      confirmedStoppedCalled = true;
      if (!this.workflowRuntime.confirmStopped()) {
        return;
      }

      const stoppedIndex = this.promptQueue.getState().currentIndex;
      const advancedPastQueuePrompt =
        this.promptQueue.finalizeCancelledPromptAfterStop();

      await this.promptQueue.commitRuntimeTransition();
      if (advancedPastQueuePrompt) {
        Log.info(
          `Queue execution fully stopped - advanced past cancelled step ${stoppedIndex}`
        );
      } else {
        Log.info("Queue execution fully stopped");
      }
    };

    const timeoutHandle = setTimeout(() => {
      if (!confirmedStoppedCalled) {
        Log.warn(
          "⏱️ Stop timeout: onResponseComplete never fired within 10s, forcing confirmedStopped()"
        );
        confirmStopped().catch((err) => {
          Log.error("Failed to update working file after stop:", err);
        });
      }
    }, 10000);

    // Single listener handles both confirmedStopped and timeout cancellation
    const responseCompleteDisposable = integration.onResponseComplete(() => {
      if (!confirmedStoppedCalled) {
        Log.debug(
          "🔔 Process confirmed exited - setting queue state to STOPPED"
        );
        confirmStopped().catch((err) => {
          Log.error("Failed to update working file after stop:", err);
        });
      }
      clearTimeout(timeoutHandle);
      responseCompleteDisposable.dispose();
    });

    await integration.cancel();

    this.workflowExecutor.clearResponseWaitState();
    this.startPending = false;
  }

  /**
   * Clear current workflow state.
   */
  clearWorkflow(): void {
    const executionState = this.getAuthoritativeExecutionState();
    if (
      executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSING ||
      executionState === EXECUTION_STATES.PAUSED
    ) {
      Log.warn(
        `clearWorkflow called on active instance inst:${this.id.slice(0, 8)} (${executionState}) — ignoring`
      );
      return;
    }

    this.activeHistoryFilePath = "";
    this.currentPromptFile = undefined;
    this.promptQueue.clearQueue();
    this.lastKnownStepCount = 0;
    this.pendingRunAfterCancel = null;
    this.propagateWorkflowNameToIntegrations();
    Log.debug("Workflow state cleared");
  }

  /**
   * Clear only the stale working file path without wiping prompts or currentPromptFile.
   * Used when the working file is deleted externally (removed from history) so that
   * ensureEphemeralWorkingFile() will create a fresh one on the next property write or run.
   */
  clearWorkingFilePath(): void {
    this.promptQueue.clearWorkingFilePath();
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] clearWorkingFilePath: stale working file path cleared`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Append prompts from a file to the current queue.
   */
  async appendFromFile(
    filePath: string,
    position: QueuePosition = QUEUE_POSITION.END
  ): Promise<void> {
    try {
      const parsed = await this.promptFileParser.parsePromptFile(filePath);

      if (!parsed?.steps?.length) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          "No steps found in file"
        );
        return;
      }

      const queueState = this.promptQueue.getState();
      const currentSize = queueState.steps.length;

      if (currentSize === 0) {
        Log.debug("Empty workflow, creating new workflow in IDLE state");
        const workflowType = queueState.workflowName
          ? `workflow "${queueState.workflowName}"`
          : DEFAULT_WORKFLOW_NAME;

        await this.initializeNewWorkflow(
          parsed.steps,
          path.basename(filePath),
          filePath,
          true,
          `Queued ${parsed.steps.length} prompt(s) to ${workflowType}`
        );
        return;
      }

      if (!this.promptQueue.canAppend()) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          "Cannot queue prompts: Workflow must be cleared first"
        );
        return;
      }

      const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
      const maxQueueSize = queueConfig.maxQueueSize;
      const unlimitedMode = queueConfig.unlimitedMode;
      const newSize = currentSize + parsed.steps.length;

      if (!unlimitedMode && newSize > maxQueueSize) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "warning",
          `Queue size limit exceeded: ${newSize}/${maxQueueSize} prompts. ` +
            `Enable unlimitedMode or increase maxQueueSize to proceed.`
        );
        return;
      }

      const source = `User append (${position}): ${path.basename(filePath)}`;
      this.reopenRuntimeForContinuationIfNeeded(false);
      await this.promptQueue.appendSteps(parsed.steps, source, position);
      this.syncCurrentPromptFileFromQueue();

      if (this.dashboardSink) {
        const updatedState = this.promptQueue.getState();
        this.dashboardSink.updateStepsExtended(
          updatedState.steps,
          this.promptQueue.getWorkflowFile().finalStep ?? null,
          undefined,
          updatedState.definitionRevision,
          this.id
        );
        this.dashboardSink.updateProgress(
          updatedState.currentIndex,
          updatedState.steps.length,
          this.id
        );
      }

      if (!this.currentPromptFile) {
        Log.debug("No prompt file loaded, updating context (append mode)");
        this.currentPromptFile = { filePath, promptFile: parsed };
        const appendWorkingFilePath =
          this.promptQueue.getState().workingFilePath;
        if (appendWorkingFilePath) {
          this.setupPromptFileWatcher(appendWorkingFilePath);
        }
      }

      const positionText =
        position === QUEUE_POSITION.NEXT
          ? "after current prompt"
          : "at end of queue";
      notifyUserFeedback(
        this.userFeedbackSink,
        "info",
        `Queued ${parsed.steps.length} prompt(s) ${positionText}`
      );
    } catch (error) {
      Log.error("Failed to queue prompts:", error);
      notifyUserFeedback(
        this.userFeedbackSink,
        "error",
        `Failed to queue prompts: ${getErrorMessage(error)}`
      );
    }
  }

  async updateWorkflowName(workflowName: string): Promise<void> {
    if (!this.promptQueue) {
      throw new Error("No active queue");
    }
    // Update instance field first so ensureEphemeralWorkingFile uses the new
    // name when creating the working file for brand-new workflows.
    this.workflowName = workflowName;
    // Eagerly create a working file if one doesn't exist yet, so that renaming
    // a new workflow before adding prompts isn't lost when switching away.
    await this.ensureEphemeralWorkingFile();
    await this.promptQueue.updateWorkflowName(workflowName);
    this.propagateWorkflowNameToIntegrations();
  }

  /** Guard the next user definition mutation with its client-observed revision. */
  expectDefinitionRevision(revision: number): void {
    this.promptQueue.expectDefinitionRevision(revision);
  }

  async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    return this.promptQueue.updateWorkingFileProperties(properties, options);
  }

  /**
   * Eagerly create a working file for a new ephemeral workflow the moment the
   * user first changes any workflow-level property (harness, model, finalStep,
   * etc.) before adding any prompts. This eliminates the need for a
   * pendingWorkflowProperties cache — every property write goes straight to disk.
   *
   * Idempotent: returns immediately if a working file already exists.
   */
  public async ensureEphemeralWorkingFile(options?: {
    /**
     * Properties the caller is about to write explicitly.
     * Passed to populateSettingsDefaults so they influence dependent lookups
     * (e.g. harness change → correct model default) without being overwritten
     * by the defaults computation.
     */
    initialProperties?: Record<string, unknown>;
  }): Promise<void> {
    if (this.promptQueue.getState().workingFilePath) {
      return;
    }

    if (!this.ensureWorkingFilePromise) {
      this.ensureWorkingFilePromise = this.doEnsureEphemeralWorkingFile(
        options
      ).finally(() => {
        this.ensureWorkingFilePromise = undefined;
      });
    }

    await this.ensureWorkingFilePromise;
  }

  private async doEnsureEphemeralWorkingFile(options?: {
    initialProperties?: Record<string, unknown>;
  }): Promise<void> {
    if (this.promptQueue.getState().workingFilePath) {
      return;
    }

    const workspaceFolderPath =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workspaceFolderPath) {
      return;
    }

    const displayName =
      this.workflowName ||
      this.promptQueue.getState().workflowName ||
      DEFAULT_WORKFLOW_NAME;

    try {
      const workingFilePath = await this.promptQueue.createWorkingFile(
        displayName,
        [],
        workspaceFolderPath
      );
      Log.info(`✅ Eagerly created working file: ${workingFilePath}`);

      // Keep currentPromptFile in sync so executeLoadedPromptFile doesn't
      // fail with "No prompt file loaded" when the user runs an ephemeral
      // prompt after changing a workflow property (harness, model, etc.)
      // before adding any prompts.
      if (!this.currentPromptFile) {
        this.currentPromptFile = {
          filePath: workingFilePath,
          promptFile: { steps: [] },
        };
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] ensureEphemeralWorkingFile: set currentPromptFile → ${path.basename(workingFilePath)}`
        );
      }

      // Populate VS Code defaults and write them (along with any explicit
      // initialProperties) to the file BEFORE notifying the webview.
      // This ensures sendWorkflowPropertiesToSettings() — called inside
      // updateFileSelected — reads a file that already contains the correct
      // values (e.g. additionalArgs harness default, resumeSession from an
      // in-progress user selection), preventing a brief reversion in the UI.
      // onlyIfUndefined ensures concurrent calls don't stomp each other.
      const explicitValues = options?.initialProperties ?? {};
      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);
      const allInitialValues = { ...defaults, ...explicitValues };
      // defaults.toolPermissions is always the complete merged object
      // (explicit sub-fields on top of VS Code defaults). Use it over
      // the potentially partial explicitValues.toolPermissions.
      if (defaults.toolPermissions !== undefined) {
        allInitialValues.toolPermissions = defaults.toolPermissions;
      }
      if (Object.keys(allInitialValues).length > 0) {
        await this.promptQueue.updateWorkingFileProperties(allInitialValues, {
          onlyIfUndefined: true,
        });
      }

      // Notify the webview so the WorkflowStatus header transitions from
      // "No workflow loaded" to showing the new workflow name.
      if (this.dashboardSink) {
        const workflowName =
          this.promptQueue.getState().workflowName || displayName;
        await this.dashboardSink.updateFileSelected(
          workingFilePath,
          [],
          workflowName
        );
      }
    } catch (error) {
      Log.error("Failed to eagerly create working file:", error);
    }
  }

  /**
   * Sync steps (and optionally finalStep) to match the state restored by a webview undo/redo.
   * Updates the in-memory queue and persists to the working file without broadcasting to the webview.
   */
  async syncStepsForUndoRedo(
    steps: WorkflowStep[],
    finalStep: WorkflowStep | null
  ): Promise<void> {
    await this.promptQueue.syncStepsForUndoRedo(steps);

    // Sync finalStep if it changed
    if (finalStep !== null) {
      const persistableFinalStep = stripViewOnlyWorkflowStepFields(finalStep);
      this.promptQueue.updateWorkflowProperty(
        "finalStep",
        persistableFinalStep
      );
      await this.promptQueue.updateWorkingFileProperties({
        finalStep: persistableFinalStep,
      });
    } else {
      this.promptQueue.updateWorkflowProperty("finalStep", undefined);
      await this.promptQueue.updateWorkingFileProperties(
        { finalStep: undefined },
        { allowDeletes: true }
      );
    }

    this.dashboardSink?.notifyUndoRedoSynced();
    await this.reconcileExecutionStateAfterStepChange();
    Log.debug(
      `[WorkflowInstance] syncStepsForUndoRedo: ${steps.length} steps, finalStep=${finalStep ? "set" : "null"}`
    );
  }

  async insertWorkflowStepAfterIndex(
    afterIndex: number,
    step: unknown
  ): Promise<void> {
    const sanitizedStep = sanitizeClipboardWorkflowStep(step);

    if (!this.promptQueue.getState().workingFilePath) {
      await this.ensureEphemeralWorkingFile();
    }

    this.reopenRuntimeForContinuationIfNeeded(false);
    await this.promptQueue.insertStepAfterIndex(
      afterIndex,
      sanitizedStep,
      "Clipboard paste"
    );
    this.syncCurrentPromptFileFromQueue();

    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.updateStepsExtended(
        currentState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null,
        this.getAuthoritativeExecutionState(),
        currentState.definitionRevision
      );
      this.dashboardSink.updateProgress(
        currentState.currentIndex,
        currentState.steps.length
      );
    }

    Log.debug(
      `Inserted workflow step after index ${afterIndex}: ${isScriptStep(sanitizedStep) ? sanitizedStep.script.substring(0, 50) : sanitizedStep.prompt.substring(0, 50)}...`
    );
  }

  async updatePromptInQueue(
    index: number,
    text: string,
    properties: unknown,
    promptName?: string,
    clearProperties?: string[]
  ): Promise<void> {
    const props = properties as Record<string, unknown>;
    if (props?.type === STEP_TYPES.SCRIPT) {
      // Replace the step entirely — merging would leave stale prompt-step fields
      const scriptStep = buildScriptStepFromProperties(text, props, promptName);
      await this.promptQueue.replaceStep(index, scriptStep);
    } else {
      const updates: Partial<PromptStep> = {
        prompt: text,
        ...(promptName !== undefined && { name: promptName || undefined }),
        ...buildPromptStepProperties(properties),
        ...buildClearUpdates(clearProperties),
      };
      await this.promptQueue.updatePrompt(index, updates);
    }
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.updateStepsExtended(
        currentState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null,
        undefined,
        currentState.definitionRevision
      );
    }
    Log.debug(`Updated prompt ${index}: ${text.substring(0, 50)}...`);
  }

  async updateFinalStepInQueue(
    finalStep: WorkflowStep | null,
    clearProperties?: string[]
  ): Promise<void> {
    await this.ensureEphemeralWorkingFile();

    if (finalStep && !isScriptStep(finalStep)) {
      const normalized: PromptStep = {
        prompt: finalStep.prompt,
        ...(finalStep.name ? { name: finalStep.name } : {}),
        ...buildPromptStepProperties(finalStep as unknown),
        ...buildClearUpdates(clearProperties),
      };
      this.promptQueue.updateWorkflowProperty("finalStep", normalized);
      await this.promptQueue.updateWorkingFileProperties({
        finalStep: normalized,
      });
      if (this.currentPromptFile) {
        this.currentPromptFile.promptFile.finalStep = normalized;
      }
    } else if (finalStep && isScriptStep(finalStep)) {
      const persistableFinalStep = stripViewOnlyWorkflowStepFields(finalStep);
      this.promptQueue.updateWorkflowProperty(
        "finalStep",
        persistableFinalStep
      );
      await this.promptQueue.updateWorkingFileProperties({
        finalStep: persistableFinalStep,
      });
      if (this.currentPromptFile) {
        this.currentPromptFile.promptFile.finalStep = persistableFinalStep;
      }
    } else {
      this.promptQueue.updateWorkflowProperty("finalStep", undefined);
      await this.promptQueue.updateWorkingFileProperties(
        { finalStep: undefined },
        { allowDeletes: true }
      );
      await this.promptQueue.setFinalStepRuntime(undefined);
      if (this.currentPromptFile) {
        delete this.currentPromptFile.promptFile.finalStep;
      }
    }

    this.dashboardSink?.updateFinalStep(finalStep);
    if (!finalStep) {
      this.dashboardSink?.updateFinalStepStatus(null, 0, null);
    }

    Log.debug(`Updated finalStep (${finalStep ? "enabled" : "disabled"})`);
  }

  async deletePromptFromQueue(index: number): Promise<void> {
    Log.debug(
      `🗑️ WorkflowInstance.deletePromptFromQueue: Deleting prompt at index ${index}`
    );
    await this.promptQueue.deletePrompt(index);
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      const fileName = this.currentPromptFile
        ? path.basename(this.currentPromptFile.filePath)
        : DEFAULT_WORKFLOW_NAME;
      this.dashboardSink.updatePromptDeleted(
        fileName,
        currentState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null
      );
    }
    await this.reconcileExecutionStateAfterStepChange();
    Log.debug(`Deleted prompt ${index}`);
  }

  /**
   * Auto-transition execution state after a step list change triggered by a
   * user edit (delete or undo/redo):
   *
   * - STOPPED + all steps completed → COMPLETED
   *   Handles the case where a user deletes (or undoes the append of) the last
   *   pending step from a workflow that was re-opened for continuation after
   *   reaching COMPLETED. The state machine was set to STOPPED by
   *   `reopenForContinuation`; now that there is no pending work, it should
   *   revert to COMPLETED.
   *
   * - COMPLETED + non-terminal steps present → STOPPED (continuation)
   *   Handles the symmetric redo case: after undoing a delete (via Ctrl+Z/Y)
   *   the user may have restored a pending step. The state machine should go
   *   back to STOPPED so the "Resume" affordance is available.
   *
   * Calling `workflowRuntime.complete()` or `reopenForContinuation()` emits a
   * transition which is picked up by `onRuntimeTransition` → broadcasts
   * EXECUTION_STATE_CHANGED (and EXECUTION_COMPLETED for the COMPLETED case) to
   * the webview.  We then re-persist the working file so the on-disk state
   * matches the new status.
   */
  private async reconcileExecutionStateAfterStepChange(): Promise<void> {
    const status = this.workflowRuntime.status;
    const queueState = this.promptQueue.getState();
    const stepCount = queueState.steps.length;
    const completedCount = this.promptQueue.getCompletedCount();

    if (
      status === EXECUTION_STATES.STOPPED &&
      stepCount > 0 &&
      completedCount === stepCount
    ) {
      Log.info(
        `[WorkflowInstance] reconcileExecutionState: all ${stepCount} step(s) completed while STOPPED — transitioning to COMPLETED`
      );
      this.workflowRuntime.complete();
      await this.promptQueue.updateWorkingFile();
    } else if (
      status === EXECUTION_STATES.COMPLETED &&
      stepCount > 0 &&
      completedCount < stepCount
    ) {
      Log.info(
        `[WorkflowInstance] reconcileExecutionState: ${stepCount - completedCount} non-terminal step(s) present while COMPLETED — reopening for continuation`
      );
      this.workflowRuntime.reopenForContinuation();
      await this.promptQueue.updateWorkingFile();
    }
  }

  async reorderPendingPrompts(newPendingOrder: number[]): Promise<void> {
    await this.promptQueue.reorderPendingPrompts(newPendingOrder);
    if (this.dashboardSink) {
      const state = this.promptQueue.getState();
      this.dashboardSink.notifyPromptsReordered(state.steps);
    }
  }

  /**
   * Begins an addressed same-run rewind for the run already loaded by this
   * instance. Callers that address another historical run use the static
   * WorkingFileManager transaction and never rebind this executor.
   */
  async beginPendingRewind(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    fromStepIndex: number,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number
  ): Promise<{ definitionRevision: number; descriptorRevision: number }> {
    const state = this.promptQueue.getState();
    if (state.workflowKey !== workflowKey || state.runRef !== runRef) {
      throw new Error(
        "Pending rewind target is not loaded by this workflow instance"
      );
    }
    const executionState = this.getAuthoritativeExecutionState();
    if (
      executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSING ||
      executionState === EXECUTION_STATES.CANCELLING
    ) {
      throw new Error(
        `Cannot set start position while in state ${executionState}`
      );
    }
    const workspaceRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    const result = await WorkingFileManager.beginPendingRewind(
      workspaceRoot,
      workflowKey,
      runRef,
      fromStepIndex,
      expectedDefinitionRevision,
      expectedDescriptorRevision
    );
    this.promptQueue.applyPendingRewind(
      fromStepIndex,
      expectedDefinitionRevision,
      result.definitionRevision,
      executionState === EXECUTION_STATES.PAUSED
    );
    this.syncCurrentPromptFileFromQueue();
    return {
      definitionRevision: result.definitionRevision,
      descriptorRevision: result.descriptorRevision,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ephemeral / dashboard prompts
  // ─────────────────────────────────────────────────────────────────────────

  async executeEphemeralPrompt(
    text: string,
    properties: unknown,
    action: ActionType,
    promptName?: string,
    forceNewWorkflow: boolean = false
  ): Promise<void> {
    const generatedWorkflowName = this.generateWorkflowNameFromPrompt(
      text,
      promptName
    );

    const step: WorkflowStep = buildEphemeralWorkflowStep(
      text,
      properties,
      promptName
    );
    const stepHarness = isScriptStep(step) ? undefined : step.harness;
    if (forceNewWorkflow) {
      Log.info("Force new workflow requested...");
      this.clearWorkflow();
    }

    const currentState = this.promptQueue.getState();
    const hasWorkflow =
      currentState.steps.length > 0 || !!currentState.workingFilePath;
    const isCompleted =
      this.getAuthoritativeExecutionState() === EXECUTION_STATES.COMPLETED;

    let position: QueuePosition = QUEUE_POSITION.END;
    let shouldRun = false;

    if (
      action === ACTION_TYPES.RUN ||
      action === ACTION_TYPES.RUN_NEXT ||
      action === ACTION_TYPES.RUN_BEFORE_CURRENT
    ) {
      shouldRun = true;
      if (action === ACTION_TYPES.RUN_NEXT) {
        position = QUEUE_POSITION.NEXT;
      } else if (action === ACTION_TYPES.RUN_BEFORE_CURRENT) {
        position = QUEUE_POSITION.BEFORE_CURRENT;
      } else {
        position = QUEUE_POSITION.END;
      }
    } else if (
      action === ACTION_TYPES.QUEUE ||
      action === ACTION_TYPES.QUEUE_NEXT
    ) {
      shouldRun = false;
      position =
        action === ACTION_TYPES.QUEUE_NEXT
          ? QUEUE_POSITION.NEXT
          : QUEUE_POSITION.END;
    }

    if (!hasWorkflow) {
      const workflowName = currentState.workflowName || generatedWorkflowName;
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: no existing workflow — initializing new with name="${workflowName}", shouldRun=${shouldRun}, action=${action}`
      );
      await this.initializeNewWorkflow([step], workflowName);

      if (shouldRun) {
        await this.executeLoadedPromptFile(stepHarness);
        Log.debug(
          `Send prompt (run, position=${position}): ${text.substring(0, 50)}...`
        );
      } else {
        Log.debug(
          `Add prompt (no run, position=${position}): ${text.substring(0, 50)}...`
        );
      }
    } else {
      // If the workflow was eagerly created before any prompts were added (e.g., a
      // setting was changed first), the name is a generic placeholder like "new workflow".
      // Update it from the first prompt text so the session has a meaningful name.
      // Only do this if the user hasn't explicitly set a custom name — a non-empty
      // workflowName that differs from the default placeholder means the user named it.
      const hasUserDefinedName =
        this.workflowName && this.workflowName !== DEFAULT_WORKFLOW_NAME;
      if (currentState.steps.length === 0 && !hasUserDefinedName) {
        this.workflowName = generatedWorkflowName;
        this.promptQueue.setWorkflowName(generatedWorkflowName);
        await this.promptQueue.updateWorkingFile(true);
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: updated workflow name from first prompt → "${generatedWorkflowName}"`
        );
      }

      Log.debug(
        `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: appending to existing workflow ` +
          `(status=${this.getAuthoritativeExecutionState()}, prompts=${currentState.steps.length}, shouldRun=${shouldRun}, action=${action})`
      );
      this.reopenRuntimeForContinuationIfNeeded(shouldRun);
      await this.promptQueue.appendSteps([step], "Dashboard editor", position);
      this.syncCurrentPromptFileFromQueue();

      if (this.dashboardSink) {
        const updatedState = this.promptQueue.getState();
        this.dashboardSink.updateStepsExtended(
          updatedState.steps,
          this.promptQueue.getWorkflowFile().finalStep ?? null,
          undefined,
          updatedState.definitionRevision
        );
      }

      if (shouldRun) {
        const statusNow = this.getAuthoritativeExecutionState();
        const isStopped = statusNow === EXECUTION_STATES.STOPPED;
        const isIdleNow = statusNow === EXECUTION_STATES.IDLE;
        const isError = statusNow === EXECUTION_STATES.ERROR;
        const isCancelling = statusNow === EXECUTION_STATES.CANCELLING;
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: post-append shouldRun=true, ` +
            `isIdle=${isIdleNow}, isCompleted=${isCompleted}, isStopped=${isStopped}, isError=${isError}, isCancelling=${isCancelling}, ` +
            `queueStatusNow=${statusNow}`
        );
        if (isCancelling) {
          this.pendingRunAfterCancel = { harness: stepHarness };
          Log.debug(
            `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: cancelling in progress — deferring run until confirmStopped`
          );
        } else if (isIdleNow || isCompleted || isStopped || isError) {
          await this.executeLoadedPromptFile(stepHarness, isStopped || isError);
        }
        Log.debug(
          `Send prompt (run, position=${position}): ${text.substring(0, 50)}...`
        );
      } else {
        Log.debug(
          `Add prompt (no run, position=${position}): ${text.substring(0, 50)}...`
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Clear all output capture buffers — called at the start of a fresh (non-continuation) run. */
  private clearOutputBuffers(): void {
    this.outputCaptureBuffer.clear();
    this.lastCompletedActivityTarget = undefined;
    this.pendingSessionActivityEvents = [];
  }

  private recordCompletedActivityTarget(
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number
  ): void {
    this.lastCompletedActivityTarget = { target, runIndex, attemptIndex };
    if (this.pendingSessionActivityEvents.length === 0) {
      return;
    }
    const pendingEvents = this.pendingSessionActivityEvents.splice(0);
    void this.handleSessionActivityResumed(pendingEvents);
  }

  private beginActivityTargetCapture(): void {
    this.lastCompletedActivityTarget = undefined;
    this.pendingSessionActivityEvents = [];
  }

  private getExecutionTargetRunKey(
    target: OutputExecutionTarget
  ): `queue:${number}` | `final:${number}` {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  }

  /**
   * Handle activity observed by `SessionActivityWatcher` after a step's own
   * dispatch already completed — a harness auto-resuming a backgrounded task,
   * or a human typing directly into the live TUI. Display-only: forwards to
   * the live dashboard immediately, then merges into the already-persisted
   * history entry for the most recently completed step/attempt. Never touches
   * workflow/queue state.
   */
  private async handleSessionActivityResumed(
    events: CliEvent[]
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const activityTarget = this.lastCompletedActivityTarget;
    if (!activityTarget) {
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] Session activity resumed before completed step attribution — buffering`
      );
      this.pendingSessionActivityEvents.push(...events);
      return;
    }
    const { target, runIndex, attemptIndex } = activityTarget;

    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      this.dashboardSink?.updateCliStreamingEvents(
        target.stepIndex,
        events,
        attemptIndex,
        runIndex,
        this.id
      );
    } else {
      this.dashboardSink?.updateFinalStepStreamingEvents(
        target.loopIndex,
        events,
        attemptIndex,
        runIndex,
        this.id
      );
    }

    // CONTEXT_WINDOW_SYNC is an invisible marker (see CliIntegration.
    // resumeSessionActivityWatcher) — pull its data out for the tokens/footer
    // refresh below rather than merging it into the visible event stream.
    const contentEvents = events.filter(
      (event) => event.type !== CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC
    );

    // Follow-up output is persisted to the timeline before it enters the small
    // active-only cache. Prior-context consumers always resolve the timeline.
    const followUpText = extractTextFromEvents({ events: contentEvents });
    const historyFilePath = this.resolveHistoryFilePath();
    const latestContextWindowSync = [...events]
      .reverse()
      .find((event) => event.type === CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC)
      ?.data as ContextWindowSyncData | undefined;
    if (historyFilePath) {
      try {
        await this.outputHistoryManager.recordFollowUpResponse(
          historyFilePath,
          target,
          runIndex,
          attemptIndex,
          followUpText,
          contentEvents,
          latestContextWindowSync
            ? {
                used: latestContextWindowSync.used,
                size: latestContextWindowSync.size,
              }
            : undefined,
          this.getDefinitionRevisionContext()
        );
      } catch (error) {
        Log.warn(
          `[inst:${this.id.slice(0, 8)}] Failed to persist resumed session activity event:`,
          error
        );
      }
    }
    if (followUpText) {
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        this.promptQueue.appendPromptResponseText(
          target.stepIndex,
          followUpText
        );
      } else {
        this.promptQueue.appendFinalStepResponseText(
          target.loopIndex,
          followUpText
        );
      }
    }

    if (!historyFilePath) {
      return;
    }
    try {
      const existing = await this.outputHistoryManager
        .getRunOutputResolver()
        .resolveAttempt(historyFilePath, target, runIndex, attemptIndex);
      if (!existing?.output) {
        return;
      }

      const existingEvents = existing.output.structured?.events ?? [];
      const hasFollowUpDivider = existingEvents.some(
        (event) => event.type === CLI_EVENT_TYPES.FOLLOW_UP_RESUMED
      );
      // Insert the divider at most once per step/attempt/run — it marks the
      // boundary between the step's original output and its follow-up activity,
      // so later batches from the same follow-up burst just append past it.
      const eventsToAppend: CliEvent[] =
        contentEvents.length > 0 && !hasFollowUpDivider
          ? [
              {
                type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
                timestamp: Date.now(),
                data: { resumedAt: Date.now() } as FollowUpResumedData,
              },
              ...contentEvents,
            ]
          : contentEvents;

      const merged: CliOutput = {
        ...existing.output,
        structured: existing.output.structured
          ? {
              ...existing.output.structured,
              events: [...existingEvents, ...eventsToAppend],
            }
          : undefined,
        tokens:
          latestContextWindowSync && existing.output.tokens
            ? {
                ...existing.output.tokens,
                contextWindowUsed: latestContextWindowSync.used,
                contextWindowSize: latestContextWindowSync.size,
              }
            : existing.output.tokens,
        // timestampMs is the attempt's *start* time (see WorkflowExecutor's
        // finalization), so re-deriving elapsed from it naturally folds in
        // follow-up time without needing a separately tracked baseline.
        elapsed:
          existing.output.timestampMs != null
            ? (Date.now() - existing.output.timestampMs) / 1000
            : existing.output.elapsed,
      };
      await this.outputHistoryManager.saveExecutionOutput(
        historyFilePath,
        target,
        [merged],
        this.getDefinitionRevisionContext()
      );
    } catch (error) {
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] Failed to persist resumed session activity to history:`,
        error
      );
    }
  }

  private async computeTargetRunIndices(
    historyFilePath: string,
    isContinuation: boolean
  ): Promise<Map<string, number>> {
    if (!historyFilePath || !isContinuation) {
      return new Map();
    }

    const rerunTargets: OutputExecutionTarget[] = [];
    const state = this.promptQueue.getState();

    for (
      let stepIndex = state.currentIndex;
      stepIndex < state.steps.length;
      stepIndex++
    ) {
      rerunTargets.push({
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex,
      });
    }

    const finalStepRuntime = this.promptQueue.getFinalStepRuntime();
    if (
      finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP &&
      !this.promptQueue.hasNext()
    ) {
      rerunTargets.push({
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: finalStepRuntime.loopCount,
      });
    }

    if (rerunTargets.length === 0) {
      return new Map();
    }

    const targetKeys = new Set(
      rerunTargets.map((target) => this.getExecutionTargetRunKey(target))
    );

    const history =
      await this.outputHistoryManager.loadHistory(historyFilePath);
    const maxRunIndexByTarget = new Map<string, number>();

    for (const entry of history.orderedEntries) {
      if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) {
        continue;
      }
      const key = this.getExecutionTargetRunKey(entry.target);
      if (!targetKeys.has(key)) {
        continue;
      }
      const runIndex = entry.runIndex ?? entry.cliOutput.runIndex ?? 0;
      maxRunIndexByTarget.set(
        key,
        Math.max(maxRunIndexByTarget.get(key) ?? -1, runIndex)
      );
    }

    const nextRunIndexByTarget = new Map<string, number>();
    for (const [key, maxRunIndex] of maxRunIndexByTarget) {
      nextRunIndexByTarget.set(key, maxRunIndex + 1);
    }
    return nextRunIndexByTarget;
  }

  /** Advance a completed final-step loop before it is reached again in this run. */
  private async prepareFinalStepContinuation(
    historyFilePath: string
  ): Promise<void> {
    const runtime = this.promptQueue.getFinalStepRuntime();
    if (
      !runtime ||
      runtime.phase !== FINAL_STEP_PHASES.FINAL_STEP ||
      (runtime.status !== STEP_STATUS.COMPLETED &&
        runtime.status !== STEP_STATUS.SKIPPED)
    ) {
      return;
    }
    const history =
      await this.outputHistoryManager.loadHistory(historyFilePath);
    let maxLoopIndex = runtime.loopCount;
    for (const entry of history.orderedEntries) {
      if (
        entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
        entry.target.kind === FINAL_STEP_PHASES.FINAL_STEP
      ) {
        maxLoopIndex = Math.max(maxLoopIndex, entry.target.loopIndex);
      }
    }
    await this.promptQueue.prepareFinalStepContinuation(maxLoopIndex + 1);
    this.syncCurrentPromptFileFromQueue();
  }

  /**
   * Build the WorkflowExecutionContext passed to WorkflowExecutor.execute().
   * Captures all per-run closure state (integration reference, buffer callbacks,
   * lazy dashboard getter) so startWorkflowExecution stays focused on
   * lock/lifecycle/cleanup concerns.
   */
  private buildWorkflowExecutionContext(
    activeIntegration: HarnessIntegration,
    historyFilePath: string,
    workingFilePath: string | undefined,
    targetRunIndices?: Map<string, number>
  ): WorkflowExecutionContext {
    const self = this;
    return {
      workspaceFolderPath: this.workspaceFolderPath,
      hostCanProvidePty: this.hostCanProvidePty,
      namedWorkspaceRoots: this.platform.getNamedWorkspaceRoots(),
      currentPromptFilePath: this.currentPromptFile?.filePath,
      // Use a getter so dashboardProvider is evaluated lazily each time
      // WorkflowExecutor accesses it.
      get dashboardProvider() {
        return self.dashboardSink;
      },
      reportCompatibilityDiagnostics: (diagnostics) =>
        this.reportCompatibilityDiagnostics(diagnostics),
      getDefinitionRevisionContext: () => self.getDefinitionRevisionContext(),
      // In CLI mode always show the CLI command so it flows through
      // captureOutputInit and into onPromptStart events.
      shouldShowCliCommand: isCli() || this.shouldShowCliCommand(),
      dynamicQueueConfig: this.getDynamicQueueConfig(),
      historyFilePath,
      workingFilePath: workingFilePath || undefined,
      instanceTag: `[inst:${this.id.slice(0, 8)}]`,
      instanceId: this.id,
      outputHistoryManager: this.outputHistoryManager,
      resolvePriorContextItems: createPriorContextResolver({
        workspaceRoot:
          this.workspaceFolderPath ?? this.platform.getWorkspaceRoot(),
        historyFilePath,
        outputResolver: this.outputHistoryManager.getRunOutputResolver(),
      }),
      targetRunIndices,
      getIntegrationForPrompt: (
        prompt: PromptStep,
        harnessOverride?: HarnessId
      ) => {
        const currentIntegration = this.activeIntegration ?? activeIntegration;
        const resolvedHarness = harnessOverride;
        if (
          resolvedHarness &&
          resolvedHarness !== currentIntegration.getIntegrationMode()
        ) {
          Log.debug(
            `🔀 Prompt ${prompt.name || "unnamed"} switching to harness: ${resolvedHarness}; retaining the previous harness terminal`
          );
          const overrideIntegration =
            this.createIntegrationForMode(resolvedHarness);
          this.activeIntegration = overrideIntegration;
          return overrideIntegration;
        }
        return currentIntegration;
      },
      captureOutputInit: (
        stepIndex,
        prompt,
        cliCommand,
        cliCommandWasInjected,
        workingDirectory,
        timestampMs,
        attemptIndex,
        rawTextOutput,
        runIndex
      ) => {
        this.outputCaptureBuffer.captureOutputInit(
          stepIndex,
          prompt,
          cliCommand,
          cliCommandWasInjected,
          workingDirectory,
          timestampMs,
          attemptIndex,
          rawTextOutput,
          runIndex
        );
      },
      captureChunk: (stepIndex, chunk) => {
        this.outputCaptureBuffer.captureChunk(stepIndex, chunk);
      },
      captureEvents: (stepIndex, events) => {
        this.outputCaptureBuffer.captureEvents(stepIndex, events);
      },
      getBufferedOutput: (stepIndex) => {
        return this.outputCaptureBuffer.getBufferedOutput(stepIndex);
      },
      captureCompletedOutput: (stepIndex, output) => {
        this.outputCaptureBuffer.captureCompletedOutput(stepIndex, output);
        this.recordCompletedActivityTarget(
          { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
          output.runIndex ?? 0,
          output.attemptIndex ?? 0
        );
      },
      captureFinalStepOutputInit: (
        loopIndex,
        prompt,
        cliCommand,
        cliCommandWasInjected,
        workingDirectory,
        timestampMs,
        attemptIndex,
        rawTextOutput,
        runIndex
      ) => {
        this.outputCaptureBuffer.captureFinalStepOutputInit(
          loopIndex,
          prompt,
          cliCommand,
          cliCommandWasInjected,
          workingDirectory,
          timestampMs,
          attemptIndex,
          rawTextOutput,
          runIndex
        );
      },
      beginSessionActivityTargetCapture: () =>
        this.beginActivityTargetCapture(),
      captureFinalStepChunk: (loopIndex, chunk) => {
        this.outputCaptureBuffer.captureFinalStepChunk(loopIndex, chunk);
      },
      captureFinalStepEvents: (loopIndex, events) => {
        this.outputCaptureBuffer.captureFinalStepEvents(loopIndex, events);
      },
      getFinalStepBufferedOutput: (loopIndex) => {
        return this.outputCaptureBuffer.getFinalStepBufferedOutput(loopIndex);
      },
      captureFinalStepCompletedOutput: (loopIndex, output) => {
        this.outputCaptureBuffer.captureFinalStepCompletedOutput(
          loopIndex,
          output
        );
        this.recordCompletedActivityTarget(
          { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex },
          output.runIndex ?? 0,
          output.attemptIndex ?? 0
        );
      },
      onFinalStepStatusMessage: (loopIndex, message, severity) => {
        this.outputCaptureBuffer.onFinalStepStatusMessage(
          loopIndex,
          message,
          severity
        );
      },
      onStatusMessage: (stepIndex, message, severity) => {
        this._workflowStatusMessageEmitter.fire({
          stepIndex,
          message,
          severity,
        });
      },
      snapshotService: new WorkspaceSnapshotService(),
      onSnapshotCaptured: (target, snapshot) => {
        self.dashboardSink?.sendStepUndoDataUpdated(
          target as UndoExecutionTarget,
          snapshot
        );
      },
      spawnScriptPty: isCli()
        ? undefined
        : (options) => {
            return new Promise<number>((resolve) => {
              const ptyManager = getPtyProcessManager();
              if (!ptyManager) {
                Log.warn("[spawnScriptPty] PtyProcessManager not available");
                resolve(1);
                return;
              }

              const workflowId = self.id;
              const preSessionId = `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              const controllerClientId =
                ptyManager.getExpectedController(workflowId);

              // TERMINAL_STARTED must be sent before spawnPty so the webview
              // session store is populated before any TERMINAL_OUTPUT arrives.
              ptyPostMessage({
                type: MESSAGE_TYPES.TERMINAL_STARTED,
                workflowId,
                sessionId: preSessionId,
                stepName: options.stepName,
                kind: SESSION_KINDS.AI_CLI,
                controllerClientId,
              });

              // Wrap the script in a shell so PTY interactive input works.
              const isWindows = process.platform === "win32";
              const shell = isWindows ? resolveWindowsShell() : "/bin/sh";
              const shellArgs = isWindows
                ? ["-NoProfile", "-Command", options.script]
                : ["-c", options.script];

              try {
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                const session = ptyManager.spawnPty({
                  workflowId,
                  stepName: options.stepName,
                  kind: SESSION_KINDS.AI_CLI,
                  sessionId: preSessionId,
                  command: shell,
                  args: shellArgs,
                  cwd: options.cwd,
                  onData: (ptySession, chunk) => {
                    ptyPostMessage({
                      type: MESSAGE_TYPES.TERMINAL_OUTPUT,
                      workflowId: ptySession.workflowId,
                      sessionId: ptySession.id,
                      data: chunk,
                    });
                    // Keep raw bytes for xterm; WorkflowExecutor sanitizes the
                    // accumulated output before display and persistence.
                    options.onOutput(chunk);
                  },
                  onExit: (ptySession, exitCode) => {
                    if (timeoutHandle !== undefined) {
                      clearTimeout(timeoutHandle);
                    }
                    ptyPostMessage({
                      type: MESSAGE_TYPES.TERMINAL_ENDED,
                      workflowId: ptySession.workflowId,
                      sessionId: ptySession.id,
                      kind: ptySession.kind,
                      exitCode,
                    });
                    resolve(exitCode);
                  },
                });
                if (options.timeout > 0) {
                  timeoutHandle = setTimeout(() => {
                    Log.warn(
                      `[spawnScriptPty] timed out after ${options.timeout}ms: ${options.stepName}`
                    );
                    options.onTimeout?.();
                    ptyManager.killSession(session.id);
                  }, options.timeout);
                }
              } catch (error) {
                const message = getErrorMessage(error);
                Log.warn(`[spawnScriptPty] ${message}`);
                ptyPostMessage({
                  type: MESSAGE_TYPES.TERMINAL_OUTPUT,
                  workflowId,
                  sessionId: preSessionId,
                  data: `${message}\r\n`,
                });
                ptyPostMessage({
                  type: MESSAGE_TYPES.TERMINAL_ENDED,
                  workflowId,
                  sessionId: preSessionId,
                  kind: SESSION_KINDS.AI_CLI,
                  exitCode: 1,
                });
                options.onOutput(message);
                resolve(1);
              }
            });
          },
    };
  }

  private shouldShowCliCommand(): boolean {
    return ConfigurationUtils.shouldShowCliCommand();
  }

  private getDynamicQueueConfig(): DynamicQueueConfig {
    return ConfigurationUtils.getDynamicQueueConfig();
  }

  private createIntegrationForMode(
    harnessOverride?: HarnessId
  ): HarnessIntegration {
    const harness = harnessOverride ?? ConfigurationUtils.getIntegrationMode();

    // If a live integration from the previous run is waiting in liveInjectIntegrations,
    // promote it into executionIntegrations immediately — before checking the cache or
    // creating a new instance. This ensures the live one wins even when
    // executeLoadedPromptFile calls createIntegrationForMode() before startWorkflowExecution
    // has a chance to run its own restore loop.
    const live = this.liveInjectIntegrations.get(harness);
    if (live) {
      this.liveInjectIntegrations.delete(harness);
      live.resetForNewRun();
      this.executionIntegrations.set(harness, live);
      Log.info(
        `[inst:${this.id.slice(0, 8)}] ♻️ Reusing live inject integration (harness=${harness}) from previous run`
      );
      return live;
    }

    const cached = this.executionIntegrations.get(harness);
    if (cached) {
      Log.debug(`♻️ Reusing cached integration for harness: ${harness}`);
      return cached;
    }
    if (harnessOverride) {
      Log.info(`🔀 Using harness override: ${harnessOverride}`);
    }
    const integration = this.integrationFactory.createForExecution(harness);
    integration.setWorkflowName(this.workflowName || undefined);
    integration.onStreamingEvents((events) =>
      this._streamingEventsEmitter.fire(events)
    );
    integration.onStreamingChunk((chunk) =>
      this._streamingChunkEmitter.fire(chunk)
    );
    integration.onNotificationEvent((event) =>
      this.dashboardSink?.notifyNotificationEvent?.(event)
    );
    // Wired once at creation (not per-run) so `SessionActivityWatcher` activity
    // captured between step completions — not just after the whole workflow
    // finishes — reaches the dashboard/history. The integration instance
    // persists across runs when parked in `liveInjectIntegrations`, so this
    // subscription persists with it.
    integration.onSessionActivityResumed((payload) => {
      void this.handleSessionActivityResumed(payload.events);
    });
    this.executionIntegrations.set(harness, integration);
    return integration;
  }

  private async startWorkflowExecution(
    integration?: HarnessIntegration,
    historyFilePath = this.resolveHistoryFilePath(),
    workingFilePath?: string,
    targetRunIndices?: Map<string, number>
  ): Promise<void> {
    if (this.startPending) {
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] ⚠️ Workflow start already pending, skipping duplicate start request`
      );
      return;
    }

    this.startPending = true;
    this.executionSettledPromise = new Promise<void>((resolve) => {
      this.resolveExecutionSettled = resolve;
    });
    this.startedAt = Date.now();
    this.activeHistoryFilePath = historyFilePath;

    // Close any terminals left open from the previous run. With
    // closeTerminalWhenPromptCompletes=false, dispose() only kills the process
    // and leaves the terminal visible. When a new run starts (restart, resume,
    // or prompt-append auto-start) the previous run's CliProcessManager is gone
    // so createFreshTerminal() can't find and close the old terminal — we must
    // do it explicitly here before the new integration opens its own terminal.
    for (const prev of this.lastRunIntegrations) {
      prev.closeTerminal();
    }
    this.lastRunIntegrations = [];

    // Acquire process lock so the runner can be identified and stale-lock
    // detection works correctly on next startup.
    // In CLI mode the CLI process is the runner — write "cli" rather than
    // "vscode" so the VS Code extension detects the lock and registers a
    // CliWatchSession.  Use isCli() rather than checking dashboardSink so a
    // future TUI dashboard implementation doesn't accidentally flip the value.
    const workflowKey = this.promptQueue.getState().workflowKey;
    const runRef = this.promptQueue.getState().runRef;
    this.executionRunRef = runRef;
    const lockWorkspaceRoot =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (workingFilePath && workflowKey && runRef && lockWorkspaceRoot) {
      const runner = isCli() ? RUNNER_IDS.CLI : RUNNER_IDS.VSCODE;
      const ownerToken = WorkflowLockManager.generateOwnerToken();
      const lock: WorkflowRunnerLock = {
        workflowKey,
        runRef,
        runner,
        pid: process.pid,
        ownerToken,
        instanceId: this.id,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      };
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: acquiring ${runner} lock for "${workflowKey}"`
      );
      try {
        await WorkflowLockManager.acquireLock(
          lockWorkspaceRoot,
          workflowKey,
          lock
        );
        this.currentLockOwnerToken = ownerToken;
      } catch (err) {
        Log.warn(
          `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: failed to acquire lock:`,
          err
        );
        throw err;
      }
      // Heartbeat every 5 seconds
      this.heartbeatInterval = setInterval(() => {
        if (this.currentLockOwnerToken) {
          WorkflowLockManager.updateHeartbeat(
            lockWorkspaceRoot,
            workflowKey,
            this.currentLockOwnerToken
          ).catch(() => {});
        }
      }, 5_000);
    }

    try {
      // Re-insert all live integrations saved from the previous run (inject mode with PTY
      // still alive) into executionIntegrations so createIntegrationForMode finds and returns
      // the correct one. This keeps each PTY connection and lastInteractiveContext intact,
      // enabling immediate inject regardless of which harness the next prompt targets.
      // Any remaining liveInjectIntegrations entries that weren't consumed by
      // createIntegrationForMode() above are restored here. This covers entry
      // paths where startWorkflowExecution() is reached before a run-specific
      // integration is chosen, plus multi-harness workflows whose first prompt
      // is not the default harness.
      // The map may already be empty when executeLoadedPromptFile consumed the
      // retained default harness. Entries for other harnesses are expected in
      // same-run multi-harness and per-step override continuations.
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: retained same-run integrations available=${this.liveInjectIntegrations.size}`
      );
      for (const [
        harness,
        liveIntegration,
      ] of this.liveInjectIntegrations.entries()) {
        liveIntegration.resetForNewRun();
        this.executionIntegrations.set(harness, liveIntegration);
        Log.info(
          `[inst:${this.id.slice(0, 8)}] Restored live inject integration (harness=${harness}) at workflow start`
        );
      }
      this.liveInjectIntegrations.clear();

      const activeIntegration = integration || this.createIntegrationForMode();
      this.activeIntegration = activeIntegration;

      Log.debug(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: historyFilePath="${historyFilePath}"`
      );
      // A promoted run always has a manifest, so an empty path here means every
      // history write for this execution will silently no-op — the run finishes
      // on disk while its manifest keeps whatever state it had before. Loud,
      // because the symptom (run panel disagreeing with the header) only shows
      // up much later and nowhere near this code.
      if (!historyFilePath) {
        const { workflowKey, runRef } = this.promptQueue.getState();
        if (workflowKey && runRef) {
          Log.warn(
            `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: no history file for promoted run ` +
              `${workflowKey}/${runRef} — timeline and manifest writes will be skipped for this execution`
          );
        }
      }
      const workflowContext = this.buildWorkflowExecutionContext(
        activeIntegration,
        historyFilePath,
        workingFilePath,
        targetRunIndices
      );

      await this.workflowExecutor.execute(activeIntegration, workflowContext);

      this.activeIntegration = undefined;
    } finally {
      // Stop heartbeat and release the process lock
      if (this.heartbeatInterval !== undefined) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = undefined;
      }
      if (workflowKey && lockWorkspaceRoot && this.currentLockOwnerToken) {
        const ownerToken = this.currentLockOwnerToken;
        this.currentLockOwnerToken = undefined;
        await WorkflowLockManager.releaseLock(
          lockWorkspaceRoot,
          workflowKey,
          ownerToken
        ).catch((err) =>
          Log.warn(
            `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: failed to release lock:`,
            err
          )
        );
      }

      // Dispose all execution integrations created for this run, unless they have
      // a live PTY with inject context — those are saved to liveInjectIntegrations
      // so the next run can reuse them without re-spawning.
      this.lastRunIntegrations = [];
      const workspaceRoot =
        this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution finally: executionIntegrations.size=${this.executionIntegrations.size}`
      );
      for (const [
        harnessKey,
        execIntegration,
      ] of this.executionIntegrations.entries()) {
        const retainIntegration =
          execIntegration.canReuseForInject() ||
          execIntegration.shouldPersistForSessionActivity();
        if (retainIntegration) {
          // Either the PTY is still alive with inject context set (CLI), or the
          // integration wants to stay alive for its own post-completion session
          // watcher (non-PTY harness). Keep it alive for the next run rather
          // than destroying it. Store under the same map key so the restore code
          // can insert it where createIntegrationForMode looks. Register a
          // one-shot exit callback so we dispose it if the terminal is killed
          // between runs (no-op for non-PTY harnesses).
          this.liveInjectIntegrations.set(harnessKey, execIntegration);
          if (
            workspaceRoot &&
            execIntegration.shouldRetainWorkflowArtifactsForReuse()
          ) {
            this.retainedIntegrationArtifactContexts.set(harnessKey, {
              integration: execIntegration,
              workingFilePath,
              workspaceRoot,
            });
          } else {
            await this.cleanupRetainedIntegrationArtifacts(
              harnessKey,
              execIntegration,
              workingFilePath,
              workspaceRoot
            );
          }
          execIntegration.onPtySessionEnded(() => {
            if (
              this.liveInjectIntegrations.get(harnessKey) === execIntegration
            ) {
              this.liveInjectIntegrations.delete(harnessKey);
            }
            void this.cleanupRetainedIntegrationArtifacts(
              harnessKey,
              execIntegration
            ).finally(() => execIntegration.dispose());
          });
        } else {
          await this.cleanupRetainedIntegrationArtifacts(
            harnessKey,
            execIntegration,
            workingFilePath,
            workspaceRoot
          );
          // Normal path: terminal closed or inject mode not active — dispose now
          // and save so the next run can close any VS Code terminal tab left open.
          this.lastRunIntegrations.push(execIntegration);
          execIntegration.dispose();
        }
      }
      this.executionIntegrations.clear();

      await this.pendingRuntimeTransitionHistoryWrite;

      if (historyFilePath) {
        const runStepCount = this.promptQueue.getProgress().total;
        await this.outputHistoryManager
          .finalizeRun(
            historyFilePath,
            this.getAuthoritativeExecutionState() as Parameters<
              OutputHistoryManager["finalizeRun"]
            >[1],
            runStepCount
          )
          .catch((err) => Log.warn("Failed to finalize history run:", err));
      }
      this.startPending = false;
      this.resolveExecutionSettled?.();
      this.resolveExecutionSettled = undefined;
    }
  }

  private async cleanupRetainedIntegrationArtifacts(
    harnessKey: string,
    integration: HarnessIntegration,
    fallbackWorkingFilePath?: string,
    fallbackWorkspaceRoot?: string
  ): Promise<void> {
    const retainedContext =
      this.retainedIntegrationArtifactContexts.get(harnessKey);
    if (retainedContext?.integration === integration) {
      this.retainedIntegrationArtifactContexts.delete(harnessKey);
    }
    const workingFilePath =
      retainedContext?.integration === integration
        ? retainedContext.workingFilePath
        : fallbackWorkingFilePath;
    const workspaceRoot =
      retainedContext?.integration === integration
        ? retainedContext.workspaceRoot
        : fallbackWorkspaceRoot;
    if (!workspaceRoot) return;

    await integration
      .cleanupWorkflowArtifacts(workingFilePath, workspaceRoot)
      .catch((err) => Log.warn("Failed to clean up workflow artifacts:", err));
  }

  private propagateWorkflowNameToIntegrations(): void {
    const state = this.promptQueue.getState();
    const name =
      state.workflowName ||
      (this.currentPromptFile
        ? PromptQueue.extractWorkflowName(this.currentPromptFile.filePath)
        : undefined);
    // Keep instance field in sync so createIntegrationForMode reads the right value.
    this.workflowName = name ?? "";
    // Push to all cached execution integrations created for this run.
    for (const integration of this.executionIntegrations.values()) {
      integration.setWorkflowName(name);
    }
    // Push to the detector singletons (terminal tab labeling for the idle harness).
    this.onWorkflowNameChange(name);
  }

  private setupPromptFileWatcher(filePath: string): void {
    this.promptFileWatcher.setupFileWatcher(
      filePath,
      async (changedFilePath: string) => {
        await this.promptFileLoader.reloadFromWorkingFile(changedFilePath);

        const workingFile =
          await this.promptQueue.readWorkingFile(changedFilePath);
        if (workingFile?.steps) {
          const fp = workingFile.originalFile || changedFilePath;
          this.currentPromptFile = {
            filePath: fp,
            promptFile: { steps: workingFile.steps },
          };
        }
      },
      (deletedFilePath: string) => {
        // A promoted draft is moved, not lost. `WorkingFileManager.finalizeRun`
        // removes `draft/workflow.ctrlyoke.json` once its content lives on in
        // `run-<ts>/workflow.ctrlyoke.json`, and the watcher is never
        // re-pointed off the draft — so that delete lands here, asynchronously,
        // often only after the user has already pressed Run again. The queue
        // has switched to the run's file by then, so a delete for anything
        // other than the queue's *current* working file means the definition
        // moved rather than disappeared. Clearing `currentPromptFile` on it
        // made the next Run bail at the "No prompt file loaded" guard and
        // silently do nothing — a real re-run-after-completion failure that
        // reproduced about half the time, purely on watcher delivery timing.
        const activeWorkingFile = this.promptQueue.getState().workingFilePath;
        if (
          activeWorkingFile &&
          !pathsEqual(activeWorkingFile, deletedFilePath)
        ) {
          return;
        }
        this.currentPromptFile = undefined;
      }
    );
  }

  private getAuthoritativeExecutionState(): QueueState["status"] {
    return this.workflowRuntime.status;
  }

  /** Current definitionRevision + snapshot to commit before this revision's first output. */
  private getDefinitionRevisionContext(): DefinitionRevisionContext {
    const state = this.promptQueue.getState();
    return {
      definitionRevision: state.definitionRevision,
      definition: buildDefinitionSnapshot(
        state.workflowName ?? "",
        state.steps,
        undefined,
        this.promptQueue.getWorkflowFile().finalStep
      ),
    };
  }

  private reopenRuntimeForContinuationIfNeeded(
    willRunImmediately: boolean
  ): void {
    if (willRunImmediately) {
      return;
    }

    const status = this.workflowRuntime.status;
    if (
      status !== EXECUTION_STATES.COMPLETED &&
      status !== EXECUTION_STATES.ERROR
    ) {
      return;
    }

    Log.info(
      `appendSteps: Setting to STOPPED (appended to ${status} queue, ${this.promptQueue.getCompletedCount()} steps previously completed, user can Resume)`
    );
    this.workflowRuntime.reopenForContinuation();
  }

  private onRuntimeTransition(transition: WorkflowRuntimeTransition): void {
    if (transition.command === "reopenForContinuation") {
      return;
    }

    // Resolved rather than read straight off the field: the transition that
    // starts a resume (paused -> running) fires *before* startWorkflowExecution
    // assigns the field, so a restored instance would otherwise drop the very
    // transition that reopens the run.
    const historyFilePath = this.resolveHistoryFilePath();
    if (historyFilePath) {
      this.pendingRuntimeTransitionHistoryWrite =
        this.pendingRuntimeTransitionHistoryWrite
          .then(() =>
            this.outputHistoryManager.appendRuntimeTransition(
              historyFilePath,
              transition
            )
          )
          .catch((error) => {
            Log.warn(
              `[inst:${this.id.slice(0, 8)}] Failed to persist runtime transition history:`,
              error
            );
          });
    }

    const state = this.promptQueue.getState();
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] Runtime transition ${transition.command}: ${transition.previous.status} -> ${transition.current.status} ` +
        `(step ${state.currentIndex}/${state.steps.length})`
    );

    const executionState = this.getAuthoritativeExecutionState();

    if (this.dashboardSink) {
      this.dashboardSink.updateExecutionState(executionState);
      if (transition.command === "complete") {
        this.dashboardSink.updateExecutionCompleted?.();
      }
    }

    if (
      transition.command === "confirmStopped" &&
      this.pendingRunAfterCancel !== null
    ) {
      const { harness } = this.pendingRunAfterCancel;
      this.pendingRunAfterCancel = null;
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] onRuntimeTransition: firing deferred run after cancel completed`
      );
      this.executeLoadedPromptFile(harness, true).catch((err) =>
        Log.error(
          `[inst:${this.id.slice(0, 8)}] Failed to execute deferred run after cancel:`,
          err
        )
      );
    }
  }

  private onAttemptTransition(transition: WorkflowAttemptTransition): void {
    if (!this.dashboardSink) {
      return;
    }

    const target = transition.current.target;
    if (target.kind !== FINAL_STEP_PHASES.QUEUE) {
      return;
    }

    switch (transition.command) {
      case WORKFLOW_ATTEMPT_COMMANDS.BEGIN:
        if (transition.current.attemptIndex > 0) {
          this.dashboardSink.updateStepStatus(target.stepIndex, {
            state: STEP_STATUS.RUNNING,
          });
        }
        break;
      case WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY:
        this.dashboardSink.updateRetryAttempt(
          target.stepIndex,
          transition.current.retryCount ?? transition.current.attemptIndex,
          transition.current.maxRetries ?? 0
        );
        break;
      case WORKFLOW_ATTEMPT_COMMANDS.CANCEL:
        this.dashboardSink.updateStepStatus(target.stepIndex, {
          state: STEP_STATUS.CANCELLED,
        });
        break;
      case WORKFLOW_ATTEMPT_COMMANDS.COMPLETE:
        if (transition.current.attemptIndex > 0) {
          this.dashboardSink.updateRetryAttempt(target.stepIndex, 0, 0);
        }
        break;
      default:
        break;
    }
  }

  private getCurrentCancellationTarget(): WorkflowAttemptTarget | undefined {
    const finalStepRuntime = this.promptQueue.getFinalStepRuntime();
    if (finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP) {
      return {
        kind: FINAL_STEP_PHASES.FINAL_STEP,
        loopIndex: finalStepRuntime.loopCount,
      };
    }

    const state = this.promptQueue.getState();
    if (state.currentIndex >= state.steps.length) {
      return undefined;
    }

    return {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: state.currentIndex,
    };
  }

  private onQueueStateChanged(state: QueueState): void {
    const executionState = this.getAuthoritativeExecutionState();
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] Queue state → ${executionState} (step ${state.currentIndex}/${state.steps.length})`
    );
    this.onStatusBarUpdate();

    if (this.dashboardSink) {
      // Detect workflow name changes and push them to the dashboard immediately.
      const newWorkflowName = state.workflowName ?? "";
      if (newWorkflowName && newWorkflowName !== this.lastKnownWorkflowName) {
        this.dashboardSink.updateWorkflowName(newWorkflowName);
      }

      // Active workflow: forward state changes directly to the dashboard.
      // Runtime transitions now flow through WorkflowStateMachine.onDidTransition.
      // Queue state changes stay responsible for queue topology updates only.
      // When prompts increase, piggyback the current execution state onto the
      // STEPS_EXTENDED message so prompt-growth + lifecycle updates still land
      // in one render and avoid the React 19 detached-fiber issue.
      const hasNewPrompts = state.steps.length > this.lastKnownStepCount;

      if (hasNewPrompts) {
        Log.debug(
          `Detected prompt count increase: ${this.lastKnownStepCount} → ${state.steps.length}. Notifying dashboard.`
        );
        // Include executionState so both updates reach the webview in one message.
        this.dashboardSink.updateStepsExtended(
          state.steps,
          this.promptQueue.getWorkflowFile().finalStep ?? null,
          executionState,
          state.definitionRevision
        );
        this.dashboardSink.updateProgress(
          state.currentIndex,
          state.steps.length
        );
      }
    }

    this.lastKnownStepCount = state.steps.length;
    this.lastKnownWorkflowName = state.workflowName ?? "";
  }

  private async initializeNewWorkflow(
    steps: WorkflowStep[],
    displayName: string,
    originalFilePath?: string,
    reuseExistingWorkingFile: boolean = false,
    notificationMessage?: string
  ): Promise<string | undefined> {
    // Set instance-level name so getSummary() returns it immediately
    this.workflowName = displayName;

    Log.debug(
      `[inst:${this.id.slice(0, 8)}] initializeNewWorkflow: displayName="${displayName}" ` +
        `originalFile=${originalFilePath ? path.basename(originalFilePath) : "(none)"} ` +
        `reuseExisting=${reuseExistingWorkingFile} ` +
        `instance.workflowName="${this.workflowName}" instance.filePath="${this.filePath}" ` +
        `queue.workflowName="${this.promptQueue.getState().workflowName || "(unset)"}"`
    );
    let workingFilePath: string | undefined;
    if (reuseExistingWorkingFile) {
      const queueState = this.promptQueue.getState();
      workingFilePath = queueState.workingFilePath;
      if (workingFilePath) {
        Log.debug(`Reusing existing working file: ${workingFilePath}`);
      }
    }

    const workspaceFolderPath =
      this.workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    if (!workingFilePath && workspaceFolderPath) {
      try {
        workingFilePath = await this.promptQueue.createWorkingFile(
          displayName,
          steps,
          workspaceFolderPath,
          originalFilePath
        );
        Log.info(`✅ Created working file: ${workingFilePath}`);

        // Populate all execution properties from VS Code settings so the
        // working file always has explicit values for every workflow-level
        // setting, making it the sole source of truth regardless of the
        // user's VS Code defaults on any machine. onlyIfUndefined ensures
        // any properties already written (e.g. from ensureEphemeralWorkingFile)
        // are not overwritten.
        const defaults = PromptFileLoader.populateSettingsDefaults({});
        if (Object.keys(defaults).length > 0) {
          await this.promptQueue.updateWorkingFileProperties(defaults, {
            onlyIfUndefined: true,
          });
        }
      } catch (error) {
        Log.error("Failed to create working file:", error);
      }
    } else if (!workingFilePath) {
      Log.warn(
        "No workspace folder, skipping working file creation (MCP won't work)"
      );
    }

    let promptFile: PromptFile;
    if (workingFilePath) {
      promptFile = await this.promptQueue.readWorkingFile(workingFilePath);
      if (!promptFile.steps || promptFile.steps.length === 0) {
        promptFile = { ...promptFile, steps: steps };
      }
    } else {
      promptFile = { steps: steps };
    }
    this.promptQueue.loadPrompts(promptFile, workingFilePath);

    // Log the final state of name resolution after loadPrompts
    const postLoadState = this.promptQueue.getState();
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] initializeNewWorkflow: post-load state — ` +
        `queue.workflowName="${postLoadState.workflowName || '(unset)"'}` +
        `, instance.workflowName="${this.workflowName}", instance.filePath="${this.filePath}"` +
        `, getSummary().workflowName="${this.getSummary().workflowName || "(empty)"}"`
    );

    if (this.dashboardSink) {
      const queueState = this.promptQueue.getState();
      this.dashboardSink.updateFileSelected(
        displayName,
        steps,
        queueState.workflowName || undefined,
        promptFile.finalStep ?? null,
        this.promptQueue.getFinalStepRuntime()
      );
    }

    if (originalFilePath) {
      this.currentPromptFile = {
        filePath: originalFilePath,
        promptFile,
      };
    } else {
      this.currentPromptFile = {
        filePath: displayName,
        promptFile,
      };
    }

    if (workingFilePath) {
      this.setupPromptFileWatcher(workingFilePath);
    }

    if (notificationMessage) {
      notifyUserFeedback(this.userFeedbackSink, "info", notificationMessage);
    }

    return workingFilePath;
  }

  private generateWorkflowNameFromPrompt(
    text: string,
    promptName?: string
  ): string {
    if (promptName?.trim()) {
      return promptName.trim();
    }

    const cleanWords = text
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .map((word) => word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ""))
      .filter((word) => word.length > 0);

    return cleanWords.length > 0 ? cleanWords.join(" ") : "Ephemeral Prompt";
  }
}
