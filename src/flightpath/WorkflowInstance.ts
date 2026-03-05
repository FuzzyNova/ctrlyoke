import * as path from "path";
import { PromptFileParser } from "./PromptFileParser";
import { PromptQueue } from "./PromptQueue";
import { HarnessIntegration, HarnessStatus } from "./HarnessIntegration";
import { EndConditionEvaluator } from "./EndConditionEvaluator";
import { EndConditionHandler } from "./EndConditionHandler";
import { WorkflowExecutor, WorkflowContext } from "./WorkflowExecutor";
import {
  PromptFile,
  PromptItem,
  QueueState,
  Harness,
  EndCondition,
  EXECUTION_STATES,
  WorkingFile,
  WorkflowSummary,
  WorkflowRunnerLock,
} from "../types/FlightPathTypes";
import { WorkflowLockManager } from "../utils/WorkflowLockManager";
import {
  ACTION_TYPES,
  QUEUE_POSITION,
  STEP_STATUS,
  type ActionType,
  type QueuePosition,
} from "../types/DashboardConstants";
import type { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { IDashboardSink } from "../types/IDashboardSink";
import type { CliEvent } from "../types/WebviewMessageTypes";
import { Log } from "../utils/Log";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { PlatformAdapter } from "../platform/PlatformAdapter";
import { TypedEmitter } from "../utils/TypedEmitter";

// Import orchestration classes
import { PromptFileLoader } from "./orchestration/PromptFileLoader";
import { PromptFileWatcher } from "./orchestration/PromptFileWatcher";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { IntegrationFactory } from "./IntegrationFactory";

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
 *   - activeIntegration, currentPromptFile, startPending, lastKnownPromptCount
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

/** Data carried by onPromptComplete after each prompt fully finishes (post session-ID extraction). */
export interface PromptCompleteData {
  stepIndex: number;
  tokens?: {
    prompt: number;
    completion: number;
    cached?: number;
    cacheCreated?: number;
    contextWindowUsed?: number;
    contextWindowSize?: number;
  };
  sessionId?: string;
  harness?: string;
  elapsed?: number; // seconds
}

export class WorkflowInstance {
  /** Unique identifier — stable for this instance's lifetime */
  readonly id: string;
  /** Editable display name (kept in sync with queue's workflowName) */
  workflowName: string = "";
  /** Path to the source prompt/workflow file (or generated name for ephemerals) */
  filePath: string = "";
  /** True when this instance is the one shown in the dashboard */
  isActive: boolean = false;
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
  /** Currently-executing integration (set for the duration of startWorkflowExecution) */
  activeIntegration?: HarnessIntegration;
  private readonly endConditionEvaluator: EndConditionEvaluator;
  private readonly endConditionHandler: EndConditionHandler;

  /** Reference to the loaded source prompt file */
  private currentPromptFile?: { filePath: string; promptFile: PromptFile };
  /** Race-condition guard: prevents duplicate workflow starts */
  startPending: boolean = false;
  /** Tracks prompt count to detect MCP-triggered merges */
  private lastKnownPromptCount: number = 0;
  /** Heartbeat interval for the process lock file (cleared in finally + dispose) */
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Background buffering for inactive workflows
  // ─────────────────────────────────────────────────────────────────────────
  private bufferedEvents: Array<{
    type: string;
    data: unknown;
    timestamp: number;
  }> = [];
  private static readonly MAX_BUFFER_SIZE = 500;

  /**
   * Per-step streaming output buffer — captures chunks even when this instance is inactive.
   * Replayed in sendFullStateToDashboard so the user sees in-progress output when switching back.
   */
  private readonly stepOutputBuffer = new Map<
    number,
    {
      prompt: string;
      cliCommand: string | undefined;
      workingDirectory: string | undefined;
      timestampMs: number;
      attemptIndex: number;
      accumulatedText: string;
      accumulatedEvents: CliEvent[];
      rawTextOutput?: boolean;
    }
  >();

  /**
   * Stores the final completed output(s) for each step, indexed by stepIndex.
   * Captured via captureCompletedOutput even when the instance is inactive.
   * Replayed in sendFullStateToDashboard so completed prompts' outputs are
   * visible when switching back to a running workflow.
   *
   * Each entry holds an array of outputs (one per attempt) plus optional retry
   * state so the webview store accepts attemptIndex > 0 outputs on replay.
   */
  private readonly completedStepOutputs = new Map<
    number,
    {
      outputs: any[];
      retryState?: { currentRetry: number; maxRetries: number };
    }
  >();

  // ─────────────────────────────────────────────────────────────────────────
  // Orchestration helpers
  // ─────────────────────────────────────────────────────────────────────────
  private readonly promptFileLoader: PromptFileLoader;
  private readonly promptFileWatcher: PromptFileWatcher;
  readonly outputHistoryManager: OutputHistoryManager;

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

  private readonly _promptCompleteEmitter = new TypedEmitter<PromptCompleteData>();
  /**
   * Fires after each prompt fully completes (after session ID extraction),
   * carrying token stats, session ID, harness, and elapsed time.
   * Designed for the standalone CLI to display per-prompt statistics.
   */
  public readonly onPromptComplete = this._promptCompleteEmitter.event;

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly dashboardSink: IDashboardSink | undefined,
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
      harnessOverride?: Harness
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

    // Per-workflow dependencies
    this.promptFileParser = new PromptFileParser(this.platform);
    this.promptQueue = new PromptQueue();

    const resolvedWorkspacePath =
      workspaceFolderPath ?? this.platform.getWorkspaceRoot();
    this.outputHistoryManager = new OutputHistoryManager(resolvedWorkspacePath);

    this.endConditionEvaluator = new EndConditionEvaluator(this.platform);
    this.endConditionHandler = new EndConditionHandler(
      this.endConditionEvaluator,
      this.promptQueue,
      () => this.activeDashboard,
      this.platform
    );
    this.workflowExecutor = new WorkflowExecutor(
      this.promptQueue,
      this.promptFileParser,
      this.endConditionHandler,
      this.endConditionEvaluator,
      this.platform
    );
    this.promptFileLoader = new PromptFileLoader(
      this.promptFileParser,
      this.promptQueue,
      () => this.activeDashboard
    );
    this.promptFileWatcher = new PromptFileWatcher(
      this.promptQueue,
      () => this.activeDashboard
    );

    // Subscribe to queue state changes
    this.promptQueue.onDidChangeState(this.onQueueStateChanged.bind(this));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the dashboard provider only when this instance is the active
   * (viewed) workflow. Background instances return undefined so their
   * output is not routed to the UI.
   */
  private get activeDashboard(): FlightPathWebviewProvider | undefined {
    return this.isActive
      ? (this.dashboardSink as unknown as FlightPathWebviewProvider | undefined)
      : undefined;
  }

  /**
   * Mark this instance as the active/visible workflow.
   * Phase 2: flushes buffered events and sends a full state sync to the dashboard.
   */
  setActive(value: boolean): void {
    const prev = this.isActive;
    this.isActive = value;
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] setActive: ${prev} → ${value} (workflow: ${this.workflowName || "unnamed"})`
    );
    if (value) {
      this.flushBufferedEvents();
    }
  }

  /**
   * Replay buffered state changes to the dashboard and clear the buffer.
   * Called automatically when this instance becomes the active workflow.
   */
  private flushBufferedEvents(): void {
    if (this.bufferedEvents.length === 0) {
      Log.trace(
        `[inst:${this.id.slice(0, 8)}] flushBufferedEvents: no buffered events, sending full state`
      );
      this.sendFullStateToDashboard();
      return;
    }
    Log.trace(
      `[inst:${this.id.slice(0, 8)}] flushBufferedEvents: replaying ${this.bufferedEvents.length} buffered events via full state sync`
    );
    // Replay the current state to cover all buffered changes in one shot
    this.sendFullStateToDashboard();
    this.bufferedEvents = [];
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
    const fileName = this.currentPromptFile
      ? path.basename(this.currentPromptFile.filePath)
      : state.workflowName || "Untitled";
    Log.trace(
      `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: status=${state.status}, currentIndex=${state.currentIndex}, prompts=${state.prompts.length}, bufferSteps=${this.stepOutputBuffer.size}`
    );
    this.dashboardSink.updateSessionRestored(
      fileName,
      state.prompts,
      state.results,
      state.status,
      state.currentIndex,
      state.workflowName || undefined
    );

    // Replay completed step outputs so the user sees prior-prompt results
    // when switching back to a workflow that is already partway through.
    if (this.completedStepOutputs.size > 0) {
      for (const [stepIndex, entry] of this.completedStepOutputs) {
        Log.trace(
          `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: replaying completed step ${stepIndex} (${entry.outputs.length} attempt(s))`
        );
        // If this step had retries, send retry state BEFORE the outputs so
        // the webview store's addCliOutput guard accepts attemptIndex > 0.
        if (entry.retryState) {
          this.dashboardSink.updateRetryAttempt(
            stepIndex,
            entry.retryState.currentRetry,
            entry.retryState.maxRetries
          );
        }
        for (const output of entry.outputs) {
          this.dashboardSink.updateCliOutput(stepIndex, output);
        }
      }
    }

    // Replay buffered streaming output for the currently-running step so the user
    // sees in-progress output when switching back to this workflow mid-execution.
    if (
      state.status === EXECUTION_STATES.RUNNING &&
      this.stepOutputBuffer.size > 0
    ) {
      const runningStep = state.currentIndex;
      const buffer = this.stepOutputBuffer.get(runningStep);
      if (buffer) {
        Log.trace(
          `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: replaying step ${runningStep} buffer (${buffer.accumulatedText.length} chars, attemptIndex=${buffer.attemptIndex})`
        );

        // Belt-and-suspenders: if the streaming buffer is for a retry attempt
        // and the completedStepOutputs replay didn't already send retryState
        // (e.g. step hasn't completed its first attempt yet), send it now so
        // the webview store accepts attemptIndex > 0.
        if (buffer.attemptIndex > 0) {
          const completedEntry = this.completedStepOutputs.get(runningStep);
          const retryState = completedEntry?.retryState;
          if (retryState) {
            // retryState was already sent via the completedStepOutputs loop
            // above, but log for traceability
            Log.trace(
              `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: retryState already sent for step ${runningStep} (attempt ${retryState.currentRetry}/${retryState.maxRetries})`
            );
          } else {
            // Edge case: retry streaming started but completedStepOutputs
            // doesn't have retryState yet (should be set by captureOutputInit,
            // but defend against timing gaps).
            const promptItem = this.promptQueue.getState().prompts[runningStep];
            const maxRetries =
              promptItem?.endCondition?.maxRetries ?? buffer.attemptIndex;
            Log.trace(
              `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: sending fallback retryState for step ${runningStep} (attempt ${buffer.attemptIndex}/${maxRetries})`
            );
            this.dashboardSink.updateRetryAttempt(
              runningStep,
              buffer.attemptIndex,
              maxRetries
            );
          }
        }

        // Re-initialize the step as streaming (so the output panel shows it correctly)
        this.dashboardSink.updateCliOutput(runningStep, {
          prompt: buffer.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: buffer.cliCommand,
          workingDirectory: buffer.workingDirectory,
          timestampMs: buffer.timestampMs,
          attemptIndex: buffer.attemptIndex,
          rawTextOutput: buffer.rawTextOutput,
        });
        // Replay the accumulated text as a single chunk
        if (buffer.accumulatedText) {
          this.dashboardSink.updateCliStreamingChunk(
            runningStep,
            buffer.accumulatedText
          );
        }
        // Replay accumulated structured events so tool calls/file edits are
        // visible when switching back to a workflow mid-execution.
        if (buffer.accumulatedEvents.length > 0) {
          this.dashboardSink.updateCliStreamingEvents(
            runningStep,
            buffer.accumulatedEvents
          );
        }
      }
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
        this.outputHistoryManager.extractWorkflowId(workingFilePath);
      const [runs, runTimestamps, runStates] = await Promise.all([
        this.outputHistoryManager.getRunsForWorkflow(workflowId),
        this.outputHistoryManager.getRunTimestamps(workflowId),
        this.outputHistoryManager.getRunStates(workflowId),
      ]);
      if (runs.length > 0) {
        // activeDashboard returns undefined if the instance was deactivated
        // between the start of the async op and now — preventing stale updates.
        this.activeDashboard?.notifyRunHistoryUpdated(
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
      executionState: state.status,
      currentStep: state.currentIndex,
      totalSteps: state.prompts.length,
      startedAt: this.startedAt || undefined,
    };
  }

  getCurrentPromptFile(): { fileName: string; prompts: unknown[] } | null {
    if (!this.currentPromptFile?.promptFile.prompts) {
      return null;
    }
    return {
      fileName: path.basename(this.currentPromptFile.filePath),
      prompts: this.currentPromptFile.promptFile.prompts.map((p) => ({
        prompt: p.prompt,
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
   * Restore a workflow from a working file.
   * Shared helper used by resumeWorkflow and loadWorkingFile.
   */
  async restoreWorkflowFromWorkingFile(workingFilePath: string): Promise<void> {
    // Read working file FIRST so this.filePath is correct when queue state fires
    // (onDidChangeState → getSummary() → filePath must already be set)
    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    if (workingFile?.prompts) {
      const filePath = workingFile.originalFile || workingFilePath;
      this.filePath = filePath;
      this.currentPromptFile = {
        filePath,
        promptFile: { prompts: workingFile.prompts },
      };
    }

    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace"
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
        `Failed to load workflow: ${loadError instanceof Error ? loadError.message : String(loadError)}`
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
    if (workingFile?.prompts) {
      const filePath = workingFile.originalFile || workingFilePath;
      this.filePath = filePath;
      this.currentPromptFile = {
        filePath,
        promptFile: { prompts: workingFile.prompts },
      };
    }

    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace",
      true // isAutoLoad — prevents auto-starting RUNNING workflows
    );

    this.setupPromptFileWatcher(workingFilePath);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute the currently loaded prompt file.
   */
  async executeLoadedPromptFile(
    modeOverride?: Harness,
    continueFromCurrent: boolean = false
  ): Promise<void> {
    if (!this.currentPromptFile) {
      this.platform.warn(
        "No prompt file loaded. Use 'Change' button to select a file first."
      );
      return;
    }

    const { filePath } = this.currentPromptFile;

    const prevQueueState = this.promptQueue.getState();
    // Only COMPLETED workflows count as having "completed" steps for append-continuation.
    // STOPPED workflows should restart from the beginning when Run is pressed (not continue).
    const prevCompletedCount =
      prevQueueState.status === EXECUTION_STATES.COMPLETED
        ? prevQueueState.prompts.length
        : 0;

    const { promptFile } = this.currentPromptFile;
    const fileName = path.basename(filePath);

    const filePromptCount = promptFile.prompts?.length ?? 0;
    const isAppendContinuation =
      !continueFromCurrent &&
      prevCompletedCount > 0 &&
      filePromptCount > prevCompletedCount;

    Log.debug(
      `[executeLoadedPromptFile] continueFromCurrent=${continueFromCurrent}, ` +
        `prevQueueStatus=${prevQueueState.status}, prevCompletedCount=${prevCompletedCount}, ` +
        `filePromptCount=${filePromptCount}, isAppendContinuation=${isAppendContinuation}`
    );

    try {
      Log.info(`FlightPath: Executing loaded prompt file: ${filePath}`);

      if (this.dashboardSink && !this.isDashboardReady()) {
        const action = await this.platform.showChoice(
          `FlightPath dashboard is still initializing. Please wait a moment and try again.`,
          "Retry",
          "Cancel"
        );
        if (action === "Retry") {
          setTimeout(
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
            500
          );
        }
        return;
      }

      // Pre-flight check uses the DETECTOR singleton (already initialized at startup).
      // The execution integration created later will have markAsReady() called and
      // should not be used for this check.
      const detailedStatus =
        this.getDetectorIntegration(modeOverride).getDetailedStatus();

      // Create the execution integration only after passing all pre-flight checks.
      const integration = this.createIntegrationForMode(modeOverride);

      if (detailedStatus.initializationStatus === HarnessStatus.Initializing) {
        const action = await this.platform.showChoice(
          `FlightPath is still initializing Copilot integration. Please wait a moment and try again.`,
          "Retry",
          "Cancel"
        );
        if (action === "Retry") {
          setTimeout(
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
            1000
          );
        }
        return;
      }

      if (detailedStatus.initializationStatus === HarnessStatus.Waiting) {
        const action = await this.platform.showChoice(
          `FlightPath is waiting for Copilot to activate (attempt ${detailedStatus.pollingAttempts}/${detailedStatus.maxPollingAttempts}). Please wait...`,
          "Retry",
          "Cancel"
        );
        if (action === "Retry") {
          setTimeout(
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
            2000
          );
        }
        return;
      }

      if (detailedStatus.initializationStatus === HarnessStatus.Unavailable) {
        const action = await this.platform.showChoice(
          `FlightPath: Copilot automation is unavailable. Please ensure GitHub Copilot Chat is installed and active.`,
          "Retry Detection",
          "View Requirements",
          "Cancel"
        );
        if (action === "Retry Detection") {
          await this.getDetectorIntegration(modeOverride).retryDetection();
          setTimeout(
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
            2000
          );
        } else if (action === "View Requirements") {
          await this.getDetectorIntegration(modeOverride).testAutomation();
        }
        return;
      }

      const queueState = this.promptQueue.getState();
      if (!continueFromCurrent && !isAppendContinuation) {
        if (
          queueState.status === EXECUTION_STATES.COMPLETED ||
          queueState.status === EXECUTION_STATES.PAUSED ||
          queueState.status === EXECUTION_STATES.STOPPED ||
          queueState.status === EXECUTION_STATES.ERROR
        ) {
          Log.debug(
            `FlightPath: Queue in ${queueState.status} state, restarting from beginning`
          );
          await this.promptQueue.restart();
        }
      } else if (isAppendContinuation) {
        Log.debug(
          `FlightPath: Append continuation — skipping restart, continuing from step ${prevCompletedCount}`
        );
        if (queueState.status === EXECUTION_STATES.IDLE) {
          await this.promptQueue.restoreCompletedSteps(prevCompletedCount);
        }
      } else {
        Log.debug(
          `FlightPath: Continuing from current position (append mode), preserving history`
        );
      }

      const currentQueueState = this.promptQueue.getState();
      const totalPrompts = currentQueueState.prompts.length;

      const workingFilePath = currentQueueState.workingFilePath ?? "";
      let historyFilePath = "";
      if (!continueFromCurrent && !isAppendContinuation && workingFilePath) {
        const workflowId =
          this.outputHistoryManager.extractWorkflowId(workingFilePath);
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
          this.outputHistoryManager.extractWorkflowId(workingFilePath);
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
            for (let i = 0; i < prevCompletedCount; i++) {
              const stepData = history.promptOutputs[i];
              if (stepData && stepData.cliOutputs.length > 0) {
                const maxAttemptIndex = Math.max(
                  ...stepData.cliOutputs.map((o) => o.attemptIndex ?? 0)
                );
                this.completedStepOutputs.set(i, {
                  outputs: stepData.cliOutputs,
                  retryState:
                    maxAttemptIndex > 0
                      ? {
                          currentRetry: maxAttemptIndex,
                          maxRetries: maxAttemptIndex,
                        }
                      : undefined,
                });
              }
            }
            Log.debug(
              `[inst:${this.id.slice(0, 8)}] Cached ${this.completedStepOutputs.size} historical step(s) in completedStepOutputs for replay on workflow switch`
            );
          } catch (error) {
            Log.warn(
              `[inst:${this.id.slice(0, 8)}] Failed to cache historical step outputs for replay: ${error}`
            );
          }
        }
      } else if (continueFromCurrent && workingFilePath) {
        const workflowId =
          this.outputHistoryManager.extractWorkflowId(workingFilePath);
        historyFilePath =
          await this.outputHistoryManager.getLatestHistoryFilePath(workflowId);
        Log.debug(
          `🟢 [APPEND-DEBUG] Manual resume: Reusing existing history file: ${historyFilePath}`
        );
      }

      if (this.dashboardSink && totalPrompts > 0) {
        if (continueFromCurrent) {
          const currentIndex = currentQueueState.currentIndex;
          Log.debug(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true, preserveStepCount=${currentIndex}, totalSteps=${totalPrompts}`
          );
          this.dashboardSink.updateExecutionStarted(
            fileName,
            totalPrompts,
            true,
            currentIndex
          );
        } else if (isAppendContinuation) {
          Log.debug(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true (append-to-completed), preserveStepCount=${prevCompletedCount}, totalSteps=${totalPrompts}`
          );
          this.dashboardSink.updateExecutionStarted(
            fileName,
            totalPrompts,
            true,
            prevCompletedCount
          );
        } else {
          Log.debug(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED fresh start, totalSteps=${totalPrompts}`
          );
          this.stepOutputBuffer.clear();
          this.completedStepOutputs.clear();
          this.dashboardSink.updateExecutionStarted(fileName, totalPrompts);
        }
      }

      if (totalPrompts > 0) {
        const currentIndex = currentQueueState.currentIndex;
        integration.setWorkflowProgress(currentIndex + 1, totalPrompts);
      }
      Log.debug(
        `🟢 [APPEND-DEBUG] Starting workflow execution with historyFilePath: "${historyFilePath}" (empty=${!historyFilePath})`
      );
      await this.startWorkflowExecution(
        integration,
        historyFilePath,
        workingFilePath || undefined
      );
    } catch (error) {
      Log.error("Failed to execute prompt file:", error);
      await this.promptQueue.markErrored();
      this.platform.error(`FlightPath: Execution failed: ${error}`);
    }
  }

  /**
   * Pause current execution.
   */
  async pause(): Promise<void> {
    await this.promptQueue.pause();
  }

  /**
   * Resume execution from paused state.
   */
  async resume(): Promise<void> {
    await this.promptQueue.resume();

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

    Log.info(`⏹️ WorkflowInstance.stop() - stopping active integration`);

    this.promptQueue.stop();

    let confirmedStoppedCalled = false;

    const timeoutHandle = setTimeout(() => {
      if (!confirmedStoppedCalled) {
        confirmedStoppedCalled = true;
        Log.warn(
          "⏱️ Stop timeout: onResponseComplete never fired within 10s, forcing confirmedStopped()"
        );
        this.promptQueue.confirmedStopped().catch((err) => {
          Log.error("Failed to update working file after stop:", err);
        });
      }
    }, 10000);

    // Single listener handles both confirmedStopped and timeout cancellation
    const responseCompleteDisposable = integration.onResponseComplete(() => {
      if (!confirmedStoppedCalled) {
        confirmedStoppedCalled = true;
        Log.debug(
          "🔔 Process confirmed exited - setting queue state to STOPPED"
        );
        this.promptQueue.confirmedStopped().catch((err) => {
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
    const state = this.promptQueue.getState();
    if (
      state.status === EXECUTION_STATES.RUNNING ||
      state.status === EXECUTION_STATES.PAUSED
    ) {
      Log.warn(
        `clearWorkflow called on running/paused instance inst:${this.id.slice(0, 8)} — ignoring`
      );
      return;
    }

    this.currentPromptFile = undefined;
    this.promptQueue.clearQueue();
    this.lastKnownPromptCount = 0;
    this.propagateWorkflowNameToIntegrations();
    Log.debug("Workflow state cleared");
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

      if (!parsed?.prompts?.length) {
        this.platform.error("No prompts found in file");
        return;
      }

      const queueState = this.promptQueue.getState();
      const currentSize = queueState.prompts.length;

      if (currentSize === 0) {
        Log.debug("Empty workflow, creating new workflow in IDLE state");
        const displayName =
          queueState.workflowName || PromptQueue.extractWorkflowName(filePath);
        const workflowType = queueState.workflowName
          ? `workflow "${queueState.workflowName}"`
          : "new workflow";

        await this.initializeNewWorkflow(
          parsed.prompts,
          path.basename(filePath),
          filePath,
          true,
          `Queued ${parsed.prompts.length} prompt(s) to ${workflowType}`
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
      const newSize = currentSize + parsed.prompts.length;

      if (!unlimitedMode && newSize > maxQueueSize) {
        this.platform.warn(
          `Queue size limit exceeded: ${newSize}/${maxQueueSize} prompts. ` +
            `Enable unlimitedMode or increase maxQueueSize to proceed.`
        );
        return;
      }

      const source = `User append (${position}): ${path.basename(filePath)}`;
      await this.promptQueue.appendPrompts(parsed.prompts, source, position);

      if (this.dashboardSink) {
        const updatedState = this.promptQueue.getState();
        this.dashboardSink.updatePromptsExtended(updatedState.prompts);
        this.dashboardSink.updateProgress(
          updatedState.currentIndex,
          updatedState.prompts.length
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
        `Queued ${parsed.prompts.length} prompt(s) ${positionText}`
      );
    } catch (error) {
      Log.error("Failed to queue prompts:", error);
      this.platform.error(
        `Failed to queue prompts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async updateWorkflowName(workflowName: string): Promise<void> {
    if (!this.promptQueue) {
      throw new Error("No active queue");
    }
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

  async updatePromptInQueue(
    index: number,
    text: string,
    properties: unknown
  ): Promise<void> {
    const updates: Partial<PromptItem> = {
      prompt: text,
      ...this.buildPromptItemProperties(properties),
    };
    await this.promptQueue.updatePrompt(index, updates);
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.updatePromptsExtended(currentState.prompts);
    }
    Log.debug(`Updated prompt ${index}: ${text.substring(0, 50)}...`);
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
        : "Untitled";
      this.dashboardSink.updatePromptDeleted(fileName, currentState.prompts);
    }
    Log.debug(`Deleted prompt ${index}`);
  }

  async resetWorkflowState(): Promise<void> {
    Log.debug("WorkflowInstance.resetWorkflowState: Resetting workflow state");
    await this.promptQueue.restart();
    if (this.dashboardSink) {
      const currentState = this.promptQueue.getState();
      this.dashboardSink.notifyWorkflowStateReset(currentState.prompts);
    }
    Log.debug("WorkflowInstance.resetWorkflowState: Complete");
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

    const promptItem: PromptItem = {
      prompt: text,
      ...(promptName?.trim() ? { name: promptName.trim() } : {}),
      ...this.buildPromptItemProperties(properties),
    };

    if (forceNewWorkflow) {
      Log.info("Force new workflow requested...");
      this.clearWorkflow();
    }

    const currentState = this.promptQueue.getState();
    const hasWorkflow =
      currentState.prompts.length > 0 || !!currentState.workingFilePath;
    const isIdle = currentState.status === EXECUTION_STATES.IDLE;
    const isCompleted = currentState.status === EXECUTION_STATES.COMPLETED;

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
      await this.initializeNewWorkflow([promptItem], workflowName);

      if (shouldRun) {
        await this.executeLoadedPromptFile();
        Log.debug(
          `Send prompt (run, position=${position}): ${text.substring(0, 50)}...`
        );
      } else {
        Log.debug(
          `Add prompt (no run, position=${position}): ${text.substring(0, 50)}...`
        );
      }
    } else {
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: appending to existing workflow ` +
          `(status=${currentState.status}, prompts=${currentState.prompts.length}, shouldRun=${shouldRun}, action=${action})`
      );
      await this.promptQueue.appendPrompts(
        [promptItem],
        "Dashboard editor",
        position,
        shouldRun
      );

      if (this.dashboardSink) {
        const updatedState = this.promptQueue.getState();
        this.dashboardSink.updatePromptsExtended(updatedState.prompts);
      }

      if (shouldRun) {
        const isStopped = currentState.status === EXECUTION_STATES.STOPPED;
        Log.debug(
          `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: post-append shouldRun=true, ` +
            `isIdle=${isIdle}, isCompleted=${isCompleted}, isStopped=${isStopped}, ` +
            `queueStatusNow=${this.promptQueue.getState().status}`
        );
        if (isIdle || isCompleted || isStopped) {
          await this.executeLoadedPromptFile(undefined, true);
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

  /**
   * Guard: returns true when the dashboard webview is ready to receive messages.
   * TODO: In Phase 2 (multi-workflow), this should check actual dashboard readiness
   * state. For Phase 1, the orchestrator's dashboardReady flag is already checked
   * upstream before this method is reached via executeLoadedPromptFile.
   */
  private isDashboardReady(): boolean {
    return true;
  }

  private shouldShowCliCommand(): boolean {
    return ConfigurationUtils.shouldShowCliCommand();
  }

  private getDynamicQueueConfig(): import("../types/FlightPathTypes").DynamicQueueConfig {
    return ConfigurationUtils.getDynamicQueueConfig();
  }

  private createIntegrationForMode(
    harnessOverride?: Harness
  ): HarnessIntegration {
    const harness = harnessOverride ?? ConfigurationUtils.getIntegrationMode();
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
    this.executionIntegrations.set(harness, integration);
    return integration;
  }

  private async startWorkflowExecution(
    integration?: HarnessIntegration,
    historyFilePath = "",
    workingFilePath?: string
  ): Promise<void> {
    if (this.startPending) {
      Log.debug(
        `[inst:${this.id.slice(0, 8)}] ⚠️ Workflow start already pending, skipping duplicate start request`
      );
      return;
    }

    this.startPending = true;
    this.startedAt = Date.now();

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

    // Acquire process lock so the extension can be identified as the runner
    // and stale-lock detection works correctly on next startup.
    if (workingFilePath) {
      const lock: WorkflowRunnerLock = {
        runner: "vscode",
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
        instanceId: this.id,
        workflowId: path.basename(workingFilePath).replace(/\.flightpath\.json$/, ""),
      };
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
      const activeIntegration = integration || this.createIntegrationForMode();
      this.activeIntegration = activeIntegration;

      Log.debug(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: isActive=${this.isActive}, historyFilePath="${historyFilePath}"`
      );
      // Use a getter so dashboardProvider is evaluated lazily each time
      // WorkflowExecutor accesses it. When this instance is deactivated
      // (user switches to another workflow), activeDashboard returns
      // undefined and background output stops flowing to the UI.
      const self = this;
      const workflowContext: WorkflowContext = {
        workspaceFolderPath: this.workspaceFolderPath,
        currentPromptFilePath: this.currentPromptFile?.filePath,
        get dashboardProvider() {
          return self.activeDashboard;
        },
        shouldShowCliCommand: this.shouldShowCliCommand(),
        showCliOutput: ConfigurationUtils.shouldShowCliOutput(),
        dynamicQueueConfig: this.getDynamicQueueConfig(),
        historyFilePath,
        workingFilePath: workingFilePath || undefined,
        instanceTag: `[inst:${this.id.slice(0, 8)}]`,
        outputHistoryManager: this.outputHistoryManager,
        getIntegrationForPrompt: (
          prompt: PromptItem,
          harnessOverride?: Harness
        ) => {
          const currentIntegration =
            this.activeIntegration ?? activeIntegration;
          const resolvedHarness = harnessOverride || prompt.harness;
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
          rawTextOutput
        ) => {
          // Always buffer the init state so we can replay it when switching back.
          // Preserve accumulatedText and accumulatedEvents across the two
          // captureOutputInit calls that occur within a single attempt (the
          // second call updates cliCommand once the process starts).
          const existing = self.stepOutputBuffer.get(stepIndex);
          self.stepOutputBuffer.set(stepIndex, {
            prompt,
            cliCommand,
            workingDirectory,
            timestampMs,
            attemptIndex,
            accumulatedText: existing?.accumulatedText ?? "",
            accumulatedEvents: existing?.accumulatedEvents ?? [],
            rawTextOutput,
          });

          // When a retry starts streaming, eagerly set retryState in
          // completedStepOutputs so sendFullStateToDashboard can send
          // RETRY_ATTEMPT_CHANGED *before* replaying outputs.  Without
          // this, switching to a workflow mid-retry would cause the
          // webview store to reject attemptIndex > 0 (no retryState yet)
          // and replace attempt 0 instead of appending.
          if (attemptIndex > 0) {
            const existing = self.completedStepOutputs.get(stepIndex);
            if (existing) {
              const promptItem = self.promptQueue.getState().prompts[stepIndex];
              const maxRetries =
                promptItem?.endCondition?.maxRetries ?? attemptIndex;
              existing.retryState = {
                currentRetry: attemptIndex,
                maxRetries,
              };
              Log.debug(
                `[inst:${self.id.slice(0, 8)}] captureOutputInit: set retryState for step ${stepIndex} (attempt ${attemptIndex}/${maxRetries})`
              );
            }
          }
        },
        captureChunk: (stepIndex, chunk) => {
          const existing = self.stepOutputBuffer.get(stepIndex);
          if (existing) {
            existing.accumulatedText += chunk;
          }
        },
        captureEvents: (stepIndex, events) => {
          const existing = self.stepOutputBuffer.get(stepIndex);
          if (existing) {
            existing.accumulatedEvents.push(...events);
          }
        },
        captureCompletedOutput: (stepIndex, output) => {
          // Store the final output for replay when switching back to this workflow.
          // Multiple outputs per step accumulate when retries occur.
          const existing = self.completedStepOutputs.get(stepIndex);
          const attemptIndex = output.attemptIndex ?? 0;
          if (existing) {
            existing.outputs.push(output);
            // Update retry state to reflect the latest completed attempt
            if (attemptIndex > 0) {
              const prompt = self.promptQueue.getState().prompts[stepIndex];
              const maxRetries =
                prompt?.endCondition?.maxRetries ?? attemptIndex;
              existing.retryState = {
                currentRetry: attemptIndex,
                maxRetries,
              };
            }
          } else {
            self.completedStepOutputs.set(stepIndex, { outputs: [output] });
          }
          Log.debug(
            `[inst:${self.id.slice(0, 8)}] captureCompletedOutput: step ${stepIndex} attempt ${attemptIndex}, total outputs=${self.completedStepOutputs.get(stepIndex)!.outputs.length}, retryState=${JSON.stringify(self.completedStepOutputs.get(stepIndex)!.retryState ?? null)}`
          );
          // The step is no longer streaming; remove from streaming buffer
          self.stepOutputBuffer.delete(stepIndex);
          // Fire prompt-complete event so standalone CLI can render per-step stats.
          // This fires AFTER sendPrompt() returns (post session-ID extraction), so
          // metadata.sessionId is already populated for all harnesses.
          self._promptCompleteEmitter.fire({
            stepIndex,
            tokens: output.tokens,
            sessionId: output.structured?.metadata?.sessionId,
            harness: output.structured?.metadata?.harness,
            elapsed: output.elapsed,
          });
        },
      };

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

      // Dispose all execution integrations created for this run.
      // They are short-lived (one run), not registered with context.subscriptions,
      // so must be disposed manually to release their EventEmitter resources.
      // Save references first so the next run can close any terminals that were
      // intentionally left open (closeTerminalWhenPromptCompletes = false).
      this.lastRunIntegrations = [...this.executionIntegrations.values()];
      for (const execIntegration of this.executionIntegrations.values()) {
        execIntegration.dispose();
      }
      this.executionIntegrations.clear();

      if (historyFilePath) {
        const finalState = this.promptQueue.getState();
        const runStepCount = this.promptQueue.getProgress().total;
        await this.outputHistoryManager
          .finalizeRun(
            historyFilePath,
            finalState.status as Parameters<
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
    this.onWorkflowNameChange(name);
  }

  private setupPromptFileWatcher(filePath: string): void {
    this.promptFileWatcher.setupFileWatcher(
      filePath,
      async (changedFilePath: string) => {
        await this.promptFileLoader.reloadFromWorkingFile(changedFilePath);

        const workingFile =
          await this.promptQueue.readWorkingFile(changedFilePath);
        if (workingFile?.prompts) {
          const fp = workingFile.originalFile || changedFilePath;
          this.currentPromptFile = {
            filePath: fp,
            promptFile: { prompts: workingFile.prompts },
          };
        }
      },
      (_deletedFilePath: string) => {
        this.currentPromptFile = undefined;
      }
    );
  }

  private onQueueStateChanged(state: QueueState): void {
    Log.debug(
      `[inst:${this.id.slice(0, 8)}] Queue state → ${state.status} (step ${state.currentIndex}/${state.prompts.length}, isActive=${this.isActive})`
    );
    this.onStatusBarUpdate();

    if (this.isActive && this.dashboardSink) {
      // Active workflow: forward state changes directly to the dashboard
      this.dashboardSink.updateExecutionState(state.status);

      // When cancelling, the currently-executing step must be marked CANCELLED.
      // The queue updates its internal result record but WorkflowExecutor never
      // sends a STEP_STATUS_CHANGED for the cancelled step (it already broke out
      // of the loop), so we send it here from the authoritative state change.
      if (state.status === EXECUTION_STATES.CANCELLING) {
        const currentResult = state.results[state.currentIndex];
        if (currentResult && currentResult.status === STEP_STATUS.CANCELLED) {
          this.dashboardSink.updateStepStatus(state.currentIndex, {
            state: STEP_STATUS.CANCELLED,
          });
        }
      }

      if (state.prompts.length > this.lastKnownPromptCount) {
        Log.debug(
          `Detected prompt count increase: ${this.lastKnownPromptCount} → ${state.prompts.length}. Notifying dashboard.`
        );
        this.dashboardSink.updatePromptsExtended(state.prompts);
        this.dashboardSink.updateProgress(
          state.currentIndex,
          state.prompts.length
        );
      }
    } else if (!this.isActive) {
      // Inactive workflow: buffer the event for replay when this workflow becomes active
      this.bufferedEvents.push({
        type: "executionStateChanged",
        data: { status: state.status, currentIndex: state.currentIndex },
        timestamp: Date.now(),
      });
      // Cap buffer size to prevent unbounded memory growth
      if (this.bufferedEvents.length > WorkflowInstance.MAX_BUFFER_SIZE) {
        this.bufferedEvents = this.bufferedEvents.slice(
          -WorkflowInstance.MAX_BUFFER_SIZE
        );
      }
    }

    this.lastKnownPromptCount = state.prompts.length;

    if (state.status === EXECUTION_STATES.RUNNING && !this.activeIntegration) {
      Log.debug(
        `Auto-starting workflow: State=RUNNING, activeIntegration=null, currentIndex=${state.currentIndex}, totalPrompts=${state.prompts.length}`
      );
      this.startWorkflowExecution(
        undefined,
        "",
        state.workingFilePath || undefined
      ).catch((error) => {
        Log.error("Auto-start failed:", error);
        this.platform.error(
          `FlightPath: Failed to auto-start workflow: ${error}`
        );
      });
    } else if (state.status === EXECUTION_STATES.RUNNING) {
      Log.debug(
        `State is RUNNING but NOT auto-starting (activeIntegration already exists)`
      );
    }
  }

  private async initializeNewWorkflow(
    prompts: PromptItem[],
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
          prompts,
          workspaceFolderPath,
          originalFilePath
        );
        Log.info(`✅ Created working file: ${workingFilePath}`);

        if (this.dashboardSink) {
          await this.dashboardSink.applyPendingWorkflowProperties();
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
      if (!promptFile.prompts || promptFile.prompts.length === 0) {
        promptFile = { ...promptFile, prompts };
      }
    } else {
      promptFile = { prompts };
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
        prompts,
        queueState.workflowName || undefined
      );
    }

    if (originalFilePath) {
      this.currentPromptFile = {
        filePath: originalFilePath,
        promptFile: { prompts },
      };
    } else {
      this.currentPromptFile = {
        filePath: displayName,
        promptFile: { prompts },
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
      return promptName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    const words = text
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .map((word) =>
        word
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
      )
      .filter((word) => word.length > 0);

    return words.length > 0 ? words.join("-") : "ephemeral-prompt";
  }

  private buildPromptItemProperties(properties: unknown): Partial<PromptItem> {
    const props = properties as Record<string, unknown>;
    // null means "delete the property" (set to undefined); absent key means "leave unchanged"
    const coerce = <T>(v: unknown): T | undefined =>
      v === null ? undefined : (v as T);

    return {
      ...(props?.harness !== undefined && {
        harness: coerce<Harness>(props.harness),
      }),
      ...(props?.model !== undefined && { model: coerce<string>(props.model) }),
      ...(props?.agent !== undefined && { agent: coerce<string>(props.agent) }),
      ...(props?.resumeSession !== undefined && {
        resumeSession: coerce<boolean>(props.resumeSession),
      }),
      ...(props?.sessionId !== undefined && {
        sessionId: coerce<string | number>(props.sessionId),
      }),
      ...(props?.allowDynamicExtension !== undefined && {
        allowDynamicExtension: coerce<boolean>(props.allowDynamicExtension),
      }),
      ...(props?.endCondition !== undefined && {
        endCondition: coerce<EndCondition>(props.endCondition),
      }),
    };
  }
}
