import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import {
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
  ScriptStep,
  WorkflowStep,
  isScriptStep,
  QueueState,
  HarnessId,
  EndCondition,
  PriorContext,
  McpServerConfig,
  EXECUTION_STATES,
  WorkingFile,
  WorkflowAttemptTarget,
  WorkflowAttemptTransition,
  WorkflowRuntimeTransition,
  WorkflowSummary,
  WorkflowRunnerLock,
  UserHookConfig,
  DynamicQueueConfig,
  PreCondition,
  ToolPermissionsOverride,
} from "../types/FlightPathTypes";
import { WorkflowLockManager } from "../utils/WorkflowLockManager";
import {
  ACTION_TYPES,
  DEFAULT_WORKFLOW_NAME,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  OUTPUT_HISTORY_KINDS,
  QUEUE_POSITION,
  RUNNER_IDS,
  SESSION_KINDS,
  STEP_STATUS,
  STEP_TYPES,
  WORKFLOW_ATTEMPT_COMMANDS,
  CONDITION_ACTIONS,
  COMPARE_SOURCES,
  type ActionType,
  type QueuePosition,
} from "../types/DashboardConstants";
import type { IDashboardSink } from "../types/IDashboardSink";
import { WorkflowTaggedSink } from "./WorkflowTaggedSink";
import type { CliEvent, CliOutput } from "../types/WebviewMessageTypes";
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
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { IntegrationFactory } from "./IntegrationFactory";
import { WorkspaceSnapshotService } from "../utils/WorkspaceSnapshotService";
import type {
  OutputExecutionTarget,
  UndoExecutionTarget,
} from "../types/OutputHistoryTypes";
import type { FlightPathMcpServerProvider } from "../ui/FlightPathMcpServerProvider";
import {
  OutputCaptureBuffer,
  type OutputCaptureCallbacks,
  type PromptStartData,
  type PromptCompleteData,
} from "./OutputCaptureBuffer";
import { WorkflowStateMachine } from "./WorkflowStateMachine";
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

  /** MCP server provider for injecting user-defined MCP servers (chat harness only) */
  mcpServerProvider?: FlightPathMcpServerProvider;

  /** Per-workflow dashboard sink (wrapped with WorkflowTaggedSink to inject workflowId) */
  private readonly dashboardSink: IDashboardSink | undefined;

  /** Manages all output capture Maps and replay logic for background workflows. */
  private readonly outputCaptureBuffer: OutputCaptureBuffer;

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
    private readonly workspaceFolderPath: string | undefined
  ) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.dashboardSink = dashboardSink
      ? new WorkflowTaggedSink(dashboardSink, this.id)
      : undefined;

    // Per-workflow dependencies
    this.promptFileParser = new PromptFileParser(this.platform);
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
      this.platform
    );
    this.workflowExecutor = new WorkflowExecutor(
      this.promptQueue,
      this.endConditionHandler,
      this.endConditionEvaluator,
      this.platform
    );
    this.promptFileLoader = new PromptFileLoader(
      this.promptFileParser,
      this.promptQueue,
      () => this.dashboardSink
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
   * Replay run history count to an explicit sink.
   * Unlike sendRunHistoryToDashboard(), this sends to the provided sink directly.
   */
  async replayRunHistoryTo(sink: IDashboardSink): Promise<void> {
    const workingFilePath = this.promptQueue.getState().workingFilePath;
    if (!workingFilePath) {
      return;
    }
    try {
      const workflowId =
        OutputHistoryManager.extractWorkflowId(workingFilePath);
      const [runs, runTimestamps, runStates] = await Promise.all([
        this.outputHistoryManager.getRunsForWorkflow(workflowId),
        this.outputHistoryManager.getRunTimestamps(workflowId),
        this.outputHistoryManager.getRunStates(workflowId),
      ]);
      if (runs.length > 0) {
        sink.notifyRunHistoryUpdated(runs.length, runTimestamps, runStates);
      }
    } catch (err) {
      Log.warn(`[inst:${this.id.slice(0, 8)}] replayRunHistoryTo failed:`, err);
    }
  }

  async replayOutputHistoryTo(send: (msg: unknown) => void): Promise<void> {
    const workingFilePath = this.promptQueue.getState().workingFilePath;
    if (!workingFilePath) {
      return;
    }
    try {
      const om = this.outputHistoryManager;
      const fileId = OutputHistoryManager.extractWorkflowId(workingFilePath);
      const runs = await om.getRunsForWorkflow(fileId);
      if (runs.length > 0) {
        const historyPath = om.getHistoryFilePath(fileId, runs[0]);
        const [history, runTimestamps, runStates] = await Promise.all([
          om.loadHistory(historyPath),
          om.getRunTimestamps(fileId),
          om.getRunStates(fileId),
        ]);
        send({
          type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
          history,
          availableRuns: runs.length,
          currentRunIndex: 0,
          runTimestamps,
          runStates,
        });
      }
    } catch (err) {
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] replayOutputHistoryTo failed:`,
        err
      );
    }
  }

  /**
   * Asynchronously read this workflow's run history from disk and send
   * RUN_HISTORY_UPDATED to the dashboard so the RunSelector appears after
   * switching back to a running/paused workflow.
   * Must NOT put the UI into history-view mode — only updates the counter.
   */
  async sendRunHistoryToDashboard(): Promise<void> {
    const workingFilePath = this.promptQueue.getState().workingFilePath;
    if (!workingFilePath) {
      return;
    }
    try {
      const workflowId =
        OutputHistoryManager.extractWorkflowId(workingFilePath);
      const [runs, runTimestamps, runStates] = await Promise.all([
        this.outputHistoryManager.getRunsForWorkflow(workflowId),
        this.outputHistoryManager.getRunTimestamps(workflowId),
        this.outputHistoryManager.getRunStates(workflowId),
      ]);
      if (runs.length > 0) {
        this.dashboardSink?.notifyRunHistoryUpdated(
          runs.length,
          runTimestamps,
          runStates
        );
      }
    } catch (err) {
      Log.warn(
        `[inst:${this.id.slice(0, 8)}] sendRunHistoryToDashboard failed:`,
        err
      );
    }
  }

  /**
   * No-op for Phase 1; reserved for Phase 2 per-instance initialisation.
   */
  async initialize(): Promise<void> {
    // No per-instance async setup required in Phase 1.
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
    for (const integration of this.liveInjectIntegrations.values()) {
      integration.dispose();
    }
    this.liveInjectIntegrations.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status / summary
  // ─────────────────────────────────────────────────────────────────────────

  getQueueState(): QueueState {
    return this.promptQueue.getState();
  }

  getSummary(): WorkflowSummary {
    const state = this.promptQueue.getState();
    return {
      id: this.id,
      workflowName: this.workflowName || state.workflowName || "",
      filePath: this.filePath,
      workingFilePath: state.workingFilePath || undefined,
      executionState: this.getAuthoritativeExecutionState(),
      currentStep: state.currentIndex,
      totalSteps: state.steps.length,
      startedAt: this.startedAt || undefined,
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

  // ─────────────────────────────────────────────────────────────────────────
  // File loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load a prompt file into the dashboard without executing.
   */
  async loadPromptFile(filePath: string): Promise<void> {
    // Clear queue to reset cached workflow name — ensures fresh name from filename
    this.promptQueue.clearQueue();
    // Track the source file path for summaries and state sync
    this.filePath = filePath;

    const workingFilePath = await this.promptFileLoader.loadPromptFile(
      filePath,
      this.workspaceFolderPath
    );

    if (workingFilePath) {
      const promptFile = await this.promptFileParser.parsePromptFile(filePath);
      if (promptFile) {
        this.currentPromptFile = { filePath, promptFile };
      }
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
      this.platform.error(
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

    this.setupPromptFileWatcher(workingFilePath);
    this.propagateWorkflowNameToIntegrations();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute the currently loaded prompt file.
   */
  async executeLoadedPromptFile(
    modeOverride?: HarnessId,
    continueFromCurrent: boolean = false
  ): Promise<void> {
    if (!this.currentPromptFile) {
      const queueState = this.promptQueue.getState();
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] executeLoadedPromptFile: currentPromptFile is null — ` +
          `workingFilePath=${queueState.workingFilePath ?? "(none)"}, ` +
          `prompts=${queueState.steps.length}, status=${this.getAuthoritativeExecutionState()}`
      );
      this.platform.warn(
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

    // Detect stop → setStartPosition → Run scenario: the queue is IDLE but
    // already has a partial run in progress (currentIndex > 0). This happens
    // when the user stopped a workflow, skipped the cancelled step via
    // setStartPosition, and then pressed Run instead of Resume. We want to
    // reuse the existing history file rather than starting a fresh run.
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
    let historyFilePath = "";

    try {
      Log.info(`FlightPath: Executing loaded prompt file: ${filePath}`);

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
          `FlightPath: Harness not ready (${detailedStatus.initializationStatus}), waiting for status change…`
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
        Log.error(`FlightPath: Harness not ready: ${errorMessage}`);
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
        // Gracefully terminate live inject integrations before creating the new
        // execution integration. Ctrl+C gives the CLI time to clean up; dispose()
        // then releases the event emitters and any headless process handle.
        for (const liveIntegration of this.liveInjectIntegrations.values()) {
          liveIntegration.closeTerminalGracefully();
          liveIntegration.dispose();
        }
        this.liveInjectIntegrations.clear();
      }

      // Create the execution integration only after passing pre-flight checks.
      const integration = this.createIntegrationForMode(modeOverride);

      if (!continueFromCurrent && !isAppendContinuation) {
        if (isRestartFromBeginning) {
          Log.debug(
            `FlightPath: Queue in ${executionState} state, restarting from beginning`
          );
          await this.promptQueue.restart();
        }
      } else if (isAppendContinuation) {
        Log.debug(
          `FlightPath: Append continuation — skipping restart, continuing from step ${prevCompletedCount}`
        );
        if (executionState === EXECUTION_STATES.IDLE) {
          await this.promptQueue.restoreCompletedSteps(prevCompletedCount);
        }
      } else {
        Log.debug(
          `FlightPath: Continuing from current position (append mode), preserving history`
        );
      }

      const currentQueueState = this.promptQueue.getState();
      const totalSteps = currentQueueState.steps.length;

      const workingFilePath = currentQueueState.workingFilePath ?? "";
      if (
        !continueFromCurrent &&
        !isAppendContinuation &&
        !isIdleContinuation &&
        workingFilePath
      ) {
        const workflowId =
          OutputHistoryManager.extractWorkflowId(workingFilePath);
        const historyInit =
          await this.outputHistoryManager.initializeRun(workflowId);
        historyFilePath = historyInit.filePath;
        if (historyInit.runCount > 0) {
          const [runTimestamps, runStates] = await Promise.all([
            this.outputHistoryManager.getRunTimestamps(workflowId),
            this.outputHistoryManager.getRunStates(workflowId),
          ]);
          this.dashboardSink?.notifyRunHistoryUpdated(
            historyInit.runCount,
            runTimestamps,
            runStates
          );
        }
      } else if (isAppendContinuation && workingFilePath) {
        const workflowId =
          OutputHistoryManager.extractWorkflowId(workingFilePath);
        historyFilePath =
          await this.outputHistoryManager.getLatestHistoryFilePath(workflowId);
        Log.debug(
          `🟢 [APPEND-DEBUG] Reusing existing history file for append continuation: ${historyFilePath}`
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
      } else if (continueFromCurrent && workingFilePath) {
        const workflowId =
          OutputHistoryManager.extractWorkflowId(workingFilePath);
        historyFilePath =
          await this.outputHistoryManager.getLatestHistoryFilePath(workflowId);
        Log.debug(
          `🟢 [APPEND-DEBUG] Manual resume: Reusing existing history file: ${historyFilePath}`
        );
      } else if (isIdleContinuation && workingFilePath) {
        const workflowId =
          OutputHistoryManager.extractWorkflowId(workingFilePath);
        historyFilePath =
          await this.outputHistoryManager.getLatestHistoryFilePath(workflowId);
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
              true
            );
          } else {
            this.dashboardSink.updateExecutionStarted(
              this.id,
              fileName,
              totalSteps,
              true,
              currentIndex
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
              true
            );
          } else {
            this.dashboardSink.updateExecutionStarted(
              this.id,
              fileName,
              totalSteps,
              true,
              prevCompletedCount
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
            totalSteps
          );
        }
      }

      if (totalSteps > 0) {
        const currentIndex = currentQueueState.currentIndex;
        integration.setWorkflowProgress(currentIndex + 1, totalSteps);
      }
      const targetRunIndices = await this.computeTargetRunIndices(
        historyFilePath,
        {
          continueFromCurrent,
          isAppendContinuation,
          isIdleContinuation,
        }
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
      if (historyFilePath) {
        await this.outputHistoryManager
          .finalizeRun(
            historyFilePath,
            EXECUTION_STATES.ERROR,
            this.promptQueue.getProgress().total
          )
          .catch((err) =>
            Log.warn("Failed to finalize history run on early error:", err)
          );
      }
      this.platform.error(`FlightPath: Execution failed: ${error}`);
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
  async resume(): Promise<void> {
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

    if (this.workflowExecutor.hasPendingResponse()) {
      Log.debug(
        "▶️ Resuming with pending response (Copilot finished while paused)"
      );
      this.workflowExecutor.resumePendingResponse();
      return;
    }

    if (this.workflowExecutor.isAwaitingResponse()) {
      Log.debug(
        "▶️ Resuming while Copilot is still responding - will continue when response completes"
      );
      return;
    }

    Log.info("▶️ Resuming workflow from paused position");
    await this.startWorkflowExecution();
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

    this.workflowExecutor.clearPendingState();
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
        this.platform.error("No prompts found in file");
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
        this.platform.error(
          "Cannot queue prompts: Workflow must be cleared first"
        );
        return;
      }

      const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
      const maxQueueSize = queueConfig.maxQueueSize;
      const unlimitedMode = queueConfig.unlimitedMode;
      const newSize = currentSize + parsed.steps.length;

      if (!unlimitedMode && newSize > maxQueueSize) {
        this.platform.warn(
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
      this.platform.log(
        `Queued ${parsed.steps.length} prompt(s) ${positionText}`
      );
    } catch (error) {
      Log.error("Failed to queue prompts:", error);
      this.platform.error(`Failed to queue prompts: ${getErrorMessage(error)}`);
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

  updateWorkflowPropertyInQueue(property: string, value: unknown): void {
    this.promptQueue.updateWorkflowProperty(property, value);
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
        this.getAuthoritativeExecutionState()
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
      const scriptStep = this.buildScriptStepFromProperties(
        text,
        props,
        promptName
      );
      await this.promptQueue.replaceStep(index, scriptStep);
    } else {
      const updates: Partial<PromptStep> = {
        prompt: text,
        ...(promptName !== undefined && { name: promptName || undefined }),
        ...this.buildPromptStepProperties(properties),
        ...this.buildClearUpdates(clearProperties),
      };
      await this.promptQueue.updatePrompt(index, updates);
    }
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.updateStepsExtended(
        currentState.steps,
        this.promptQueue.getWorkflowFile().finalStep ?? null
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
        ...this.buildPromptStepProperties(finalStep as unknown),
        ...this.buildClearUpdates(clearProperties),
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

  async resetWorkflowState(): Promise<void> {
    Log.debug("WorkflowInstance.resetWorkflowState: Resetting workflow state");
    await this.promptQueue.restart();
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.notifyWorkflowStateReset(currentState.steps);
    }
    Log.debug("WorkflowInstance.resetWorkflowState: Complete");
  }

  async reorderPendingPrompts(newPendingOrder: number[]): Promise<void> {
    await this.promptQueue.reorderPendingPrompts(newPendingOrder);
    if (this.dashboardSink) {
      const state = this.promptQueue.getState();
      this.dashboardSink.notifyPromptsReordered(state.steps);
    }
  }

  async setStartPosition(toIndex: number): Promise<void> {
    const executionState = this.getAuthoritativeExecutionState();
    if (
      executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSING ||
      executionState === EXECUTION_STATES.CANCELLING
    ) {
      Log.warn(
        `WorkflowInstance.setStartPosition: Cannot set start position while in state ${executionState}`
      );
      return;
    }
    Log.info(`WorkflowInstance.setStartPosition: Moving to index ${toIndex}`);
    await this.promptQueue.setStartPosition(toIndex);
    if (this.dashboardSink) {
      const updatedState = this.promptQueue.getState();
      const promptsWithStatus = updatedState.steps.map((prompt, index) => ({
        ...prompt,
        status: updatedState.results[index]?.status ?? STEP_STATUS.PENDING,
      }));
      this.dashboardSink.notifyStartPositionSet(promptsWithStatus, toIndex);
    }
    Log.info(`WorkflowInstance.setStartPosition: Complete`);
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

    const props = properties as Record<string, unknown>;
    const step: WorkflowStep =
      props?.type === STEP_TYPES.SCRIPT
        ? this.buildScriptStepFromProperties(text, props, promptName)
        : {
            prompt: text,
            ...(promptName?.trim() ? { name: promptName.trim() } : {}),
            ...this.buildPromptStepProperties(properties),
          };
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
          this.promptQueue.getWorkflowFile().finalStep ?? null
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
  }

  private getExecutionTargetRunKey(
    target: OutputExecutionTarget
  ): `queue:${number}` | `final:${number}` {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  }

  private async computeTargetRunIndices(
    historyFilePath: string,
    options: {
      continueFromCurrent: boolean;
      isAppendContinuation: boolean;
      isIdleContinuation: boolean;
    }
  ): Promise<Map<string, number>> {
    if (
      !historyFilePath ||
      (!options.continueFromCurrent && !options.isIdleContinuation) ||
      options.isAppendContinuation
    ) {
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
      currentPromptFilePath: this.currentPromptFile?.filePath,
      // Use a getter so dashboardProvider is evaluated lazily each time
      // WorkflowExecutor accesses it.
      get dashboardProvider() {
        return self.dashboardSink;
      },
      // In CLI mode always show the CLI command so it flows through
      // captureOutputInit and into onPromptStart events.
      shouldShowCliCommand: isCli() || this.shouldShowCliCommand(),
      showCliOutput: ConfigurationUtils.shouldShowCliOutput(),
      dynamicQueueConfig: this.getDynamicQueueConfig(),
      historyFilePath,
      workingFilePath: workingFilePath || undefined,
      instanceTag: `[inst:${this.id.slice(0, 8)}]`,
      instanceId: this.id,
      outputHistoryManager: this.outputHistoryManager,
      mcpServerProvider: this.mcpServerProvider,
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
          currentIntegration.closeTerminal(); // close orphaned terminal before switching harnesses
          Log.debug(
            `🔀 Prompt ${prompt.name || "unnamed"} switching to harness: ${resolvedHarness}`
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
      },
      captureFinalStepOutputInit: (
        loopIndex,
        prompt,
        cliCommand,
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
          workingDirectory,
          timestampMs,
          attemptIndex,
          rawTextOutput,
          runIndex
        );
      },
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
                ptyManager.spawnPty({
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
                    // Strip ANSI codes for the CliOutput panel (xterm handles them natively)
                    options.onOutput(
                      chunk.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
                    );
                  },
                  onExit: (ptySession, exitCode) => {
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
    this.executionIntegrations.set(harness, integration);
    return integration;
  }

  private async startWorkflowExecution(
    integration?: HarnessIntegration,
    historyFilePath = this.activeHistoryFilePath,
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
    if (workingFilePath) {
      const runner = isCli() ? RUNNER_IDS.CLI : RUNNER_IDS.VSCODE;
      const lock: WorkflowRunnerLock = {
        runner,
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
        instanceId: this.id,
        workflowId: OutputHistoryManager.extractWorkflowId(workingFilePath),
      };
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: acquiring ${runner} lock for "${path.basename(workingFilePath)}"`
      );
      await WorkflowLockManager.acquireLock(workingFilePath, lock).catch(
        (err) =>
          Log.warn(
            `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: failed to acquire lock:`,
            err
          )
      );
      // Heartbeat every 5 seconds
      this.heartbeatInterval = setInterval(() => {
        WorkflowLockManager.updateHeartbeat(workingFilePath).catch(() => {});
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
      // (In the normal single-harness case this map is already empty because
      //  executeLoadedPromptFile already called createIntegrationForMode().)
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: liveInjectIntegrations.size=${this.liveInjectIntegrations.size} (should be 0 in normal flow)`
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
      if (workingFilePath) {
        await WorkflowLockManager.releaseLock(workingFilePath).catch((err) =>
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
        if (workspaceRoot) {
          await execIntegration
            .cleanupWorkflowArtifacts(workingFilePath, workspaceRoot)
            .catch((err) =>
              Log.warn("Failed to clean up workflow artifacts:", err)
            );
        }
        if (execIntegration.canReuseForInject()) {
          // PTY still alive and inject context set — keep the integration alive
          // for the next run rather than destroying it. Store under the same map key
          // so the restore code can insert it where createIntegrationForMode looks.
          // Register a one-shot exit callback so we dispose it if the terminal is
          // killed between runs.
          this.liveInjectIntegrations.set(harnessKey, execIntegration);
          execIntegration.onPtySessionEnded(() => {
            this.liveInjectIntegrations.delete(harnessKey);
            execIntegration.dispose();
          });
        } else {
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
    }
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
      (_deletedFilePath: string) => {
        this.currentPromptFile = undefined;
      }
    );
  }

  private getAuthoritativeExecutionState(): QueueState["status"] {
    return this.workflowRuntime.status;
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

    if (this.activeHistoryFilePath) {
      const historyFilePath = this.activeHistoryFilePath;
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
          executionState
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
      this.platform.log(notificationMessage);
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

  /** Produces `{ key: undefined }` entries for each key in clearProperties, which
   *  when spread into a Partial<PromptStep> removes those fields from the stored prompt. */
  private buildClearUpdates(clearProperties?: string[]): Partial<PromptStep> {
    if (!clearProperties?.length) return {};
    return Object.fromEntries(
      clearProperties.map((key) => [key, undefined])
    ) as Partial<PromptStep>;
  }

  /** Build a ScriptStep from properties sent in an EXECUTE_PROMPT / UPDATE_PROMPT message. */
  private buildScriptStepFromProperties(
    script: string,
    props: Record<string, unknown>,
    name?: string
  ): ScriptStep {
    return {
      type: STEP_TYPES.SCRIPT,
      script,
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(props.enabled !== undefined && {
        enabled: props.enabled as boolean,
      }),
      ...(props.timeout !== undefined &&
        props.timeout !== null && {
          timeout: props.timeout as number,
        }),
      ...(props.onPass !== undefined &&
        props.onPass !== null && {
          onPass: props.onPass as
            | typeof CONDITION_ACTIONS.CONTINUE
            | typeof CONDITION_ACTIONS.STOP_WORKFLOW,
        }),
      ...(props.onFail !== undefined &&
        props.onFail !== null && {
          onFail: props.onFail as
            | typeof CONDITION_ACTIONS.CONTINUE
            | typeof CONDITION_ACTIONS.STOP_WORKFLOW,
        }),
      ...(props.compareSource !== undefined &&
        props.compareSource !== null && {
          compareSource:
            props.compareSource as (typeof COMPARE_SOURCES)[keyof typeof COMPARE_SOURCES],
        }),
      ...(props.returns !== undefined &&
        props.returns !== null && { returns: props.returns as string }),
    };
  }

  private buildPromptStepProperties(properties: unknown): Partial<PromptStep> {
    const props = properties as Record<string, unknown>;
    // For non-nullable properties: null coerces to undefined (removes key from PromptStep).
    // For tri-state nullable properties like agent, skills, and additionalArgs,
    // null is stored as-is to represent an explicit "none/disabled" override.
    // "Clear to inherit" is handled separately via buildClearUpdates / clearProperties.
    const coerce = <T>(v: unknown): T | undefined =>
      v === null ? undefined : (v as T);

    return {
      ...(props?.harness !== undefined && {
        harness: coerce<HarnessId>(props.harness),
      }),
      ...(props?.model !== undefined && { model: coerce<string>(props.model) }),
      ...(props?.agent !== undefined && {
        agent: props.agent as string | null,
      }),
      ...(props?.enabled !== undefined && {
        enabled: props.enabled as boolean,
      }),
      ...(props?.resumeSession !== undefined && {
        resumeSession: coerce<boolean>(props.resumeSession),
      }),
      ...(props?.sessionId !== undefined && {
        sessionId: coerce<string | number>(props.sessionId),
      }),
      ...(props?.mcpServers !== undefined && {
        mcpServers: props.mcpServers as (string | McpServerConfig)[] | null,
      }),
      ...(props?.hooks !== undefined && {
        hooks: props.hooks as UserHookConfig[] | null,
      }),
      ...(props?.endCondition !== undefined && {
        endCondition: coerce<EndCondition>(props.endCondition),
      }),
      ...(props?.preCondition !== undefined && {
        preCondition: props.preCondition as PreCondition | null,
      }),
      ...(props?.skills !== undefined && {
        skills: props.skills as string[] | null,
      }),
      ...(props?.priorContext !== undefined && {
        priorContext: coerce<PriorContext>(props.priorContext),
      }),
      // additionalArgs is three-state: null = explicitly disabled, string = custom, undefined = inherit.
      // Do NOT coerce null to undefined — null must be preserved in PromptStep so the working
      // file retains the "explicitly none" override and the PropertyResolver stops resolution.
      ...(props?.additionalArgs !== undefined && {
        additionalArgs: props.additionalArgs as string | null,
      }),
      // toolPermissions is three-state: null = explicitly none (inject no flags),
      // object = override, undefined = inherit from workflow.
      // Do NOT coerce null to undefined — null must be preserved so the PropertyResolver
      // stops resolution and injects no permission flags for this prompt.
      ...(props?.toolPermissions !== undefined && {
        toolPermissions:
          props.toolPermissions as ToolPermissionsOverride | null,
      }),
    };
  }
}
