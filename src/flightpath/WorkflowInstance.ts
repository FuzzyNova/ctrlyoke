import * as vscode from "vscode";
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
} from "../types/FlightPathTypes";
import {
  ACTION_TYPES,
  QUEUE_POSITION,
  type ActionType,
  type QueuePosition,
} from "../types/DashboardConstants";
import { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { Log } from "../utils/Log";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";

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

  /** Execution integrations created for the current/most-recent run — disposed in finally block */
  private readonly executionIntegrations = new Set<HarnessIntegration>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dashboardProvider: FlightPathWebviewProvider | undefined,
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
    private readonly workspaceFolder: vscode.WorkspaceFolder | undefined
  ) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();

    // Per-workflow dependencies
    this.promptFileParser = new PromptFileParser();
    this.promptQueue = new PromptQueue();

    const workspaceFolderPath =
      workspaceFolder?.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      "";
    this.outputHistoryManager = new OutputHistoryManager(workspaceFolderPath);

    this.endConditionEvaluator = new EndConditionEvaluator(context);
    this.endConditionHandler = new EndConditionHandler(
      this.endConditionEvaluator,
      this.promptQueue,
      () => this.activeDashboard
    );
    this.workflowExecutor = new WorkflowExecutor(
      this.promptQueue,
      this.promptFileParser,
      this.endConditionHandler,
      this.endConditionEvaluator
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
    return this.isActive ? this.dashboardProvider : undefined;
  }

  /**
   * Mark this instance as the active/visible workflow.
   * Phase 2: flushes buffered events and sends a full state sync to the dashboard.
   */
  setActive(value: boolean): void {
    const prev = this.isActive;
    this.isActive = value;
    Log.info(
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
      Log.info(
        `[inst:${this.id.slice(0, 8)}] flushBufferedEvents: no buffered events, sending full state`
      );
      this.sendFullStateToDashboard();
      return;
    }
    Log.info(
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
    if (!this.dashboardProvider) {
      return;
    }
    const state = this.promptQueue.getState();
    const fileName = this.currentPromptFile
      ? path.basename(this.currentPromptFile.filePath)
      : state.workflowName || "Untitled";
    Log.info(
      `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: status=${state.status}, currentIndex=${state.currentIndex}, prompts=${state.prompts.length}, bufferSteps=${this.stepOutputBuffer.size}`
    );
    this.dashboardProvider.updateSessionRestored(
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
        Log.info(
          `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: replaying completed step ${stepIndex} (${entry.outputs.length} attempt(s))`
        );
        // If this step had retries, send retry state BEFORE the outputs so
        // the webview store's addCliOutput guard accepts attemptIndex > 0.
        if (entry.retryState) {
          this.dashboardProvider.updateRetryAttempt(
            stepIndex,
            entry.retryState.currentRetry,
            entry.retryState.maxRetries
          );
        }
        for (const output of entry.outputs) {
          this.dashboardProvider.updateCliOutput(stepIndex, output);
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
        Log.info(
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
            Log.info(
              `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: retryState already sent for step ${runningStep} (attempt ${retryState.currentRetry}/${retryState.maxRetries})`
            );
          } else {
            // Edge case: retry streaming started but completedStepOutputs
            // doesn't have retryState yet (should be set by captureOutputInit,
            // but defend against timing gaps).
            const promptItem = this.promptQueue.getState().prompts[runningStep];
            const maxRetries =
              promptItem?.endCondition?.maxRetries ?? buffer.attemptIndex;
            Log.info(
              `[inst:${this.id.slice(0, 8)}] sendFullStateToDashboard: sending fallback retryState for step ${runningStep} (attempt ${buffer.attemptIndex}/${maxRetries})`
            );
            this.dashboardProvider.updateRetryAttempt(
              runningStep,
              buffer.attemptIndex,
              maxRetries
            );
          }
        }

        // Re-initialize the step as streaming (so the output panel shows it correctly)
        this.dashboardProvider.updateCliOutput(runningStep, {
          prompt: buffer.prompt,
          response: "",
          elapsed: 0,
          tokens: undefined,
          isStreaming: true,
          cliCommand: buffer.cliCommand,
          workingDirectory: buffer.workingDirectory,
          timestampMs: buffer.timestampMs,
          attemptIndex: buffer.attemptIndex,
        });
        // Replay the accumulated text as a single chunk
        if (buffer.accumulatedText) {
          this.dashboardProvider.updateCliStreamingChunk(
            runningStep,
            buffer.accumulatedText
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
    this.promptFileWatcher.dispose();
    this.endConditionEvaluator.dispose();
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
      this.workspaceFolder
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
      vscode.window.showErrorMessage(
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
      vscode.window.showWarningMessage(
        "No prompt file loaded. Use 'Change' button to select a file first."
      );
      return;
    }

    const { filePath } = this.currentPromptFile;

    const prevQueueState = this.promptQueue.getState();
    const prevCurrentIndex = prevQueueState.currentIndex;
    const prevCompletedCount =
      prevQueueState.status === EXECUTION_STATES.COMPLETED
        ? prevQueueState.prompts.length
        : prevQueueState.status === EXECUTION_STATES.STOPPED
          ? prevCurrentIndex
          : 0;

    const { promptFile } = this.currentPromptFile;
    const fileName = path.basename(filePath);

    const filePromptCount = promptFile.prompts?.length ?? 0;
    const isAppendContinuation =
      !continueFromCurrent &&
      prevCompletedCount > 0 &&
      filePromptCount > prevCompletedCount;

    Log.info(
      `[executeLoadedPromptFile] continueFromCurrent=${continueFromCurrent}, ` +
        `prevQueueStatus=${prevQueueState.status}, prevCompletedCount=${prevCompletedCount}, ` +
        `filePromptCount=${filePromptCount}, isAppendContinuation=${isAppendContinuation}`
    );

    try {
      Log.info(`FlightPath: Executing loaded prompt file: ${filePath}`);

      if (this.dashboardProvider && !this.isDashboardReady()) {
        const action = await vscode.window.showWarningMessage(
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
        const action = await vscode.window.showWarningMessage(
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
        const action = await vscode.window.showWarningMessage(
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
        const action = await vscode.window.showErrorMessage(
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
          Log.info(
            `FlightPath: Queue in ${queueState.status} state, restarting from beginning`
          );
          await this.promptQueue.restart();
        }
      } else if (isAppendContinuation) {
        Log.info(
          `FlightPath: Append continuation — skipping restart, continuing from step ${prevCompletedCount}`
        );
        if (queueState.status === EXECUTION_STATES.IDLE) {
          await this.promptQueue.restoreCompletedSteps(prevCompletedCount);
        }
      } else {
        Log.info(
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
          this.dashboardProvider?.notifyRunHistoryUpdated(
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
        Log.info(
          `🟢 [APPEND-DEBUG] Reusing existing history file for append continuation: ${historyFilePath}`
        );
      } else if (continueFromCurrent && workingFilePath) {
        const workflowId =
          this.outputHistoryManager.extractWorkflowId(workingFilePath);
        historyFilePath =
          await this.outputHistoryManager.getLatestHistoryFilePath(workflowId);
        Log.info(
          `🟢 [APPEND-DEBUG] Manual resume: Reusing existing history file: ${historyFilePath}`
        );
      }

      if (this.dashboardProvider && totalPrompts > 0) {
        if (continueFromCurrent) {
          const currentIndex = currentQueueState.currentIndex;
          Log.info(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true, preserveStepCount=${currentIndex}, totalSteps=${totalPrompts}`
          );
          this.dashboardProvider.updateExecutionStarted(
            fileName,
            totalPrompts,
            true,
            currentIndex
          );
        } else if (isAppendContinuation) {
          Log.info(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED isContinuation=true (append-to-completed), preserveStepCount=${prevCompletedCount}, totalSteps=${totalPrompts}`
          );
          this.dashboardProvider.updateExecutionStarted(
            fileName,
            totalPrompts,
            true,
            prevCompletedCount
          );
        } else {
          Log.info(
            `[executeLoadedPromptFile] Sending EXECUTION_STARTED fresh start, totalSteps=${totalPrompts}`
          );
          this.stepOutputBuffer.clear();
          this.completedStepOutputs.clear();
          this.dashboardProvider.updateExecutionStarted(fileName, totalPrompts);
        }
      }

      if (totalPrompts > 0) {
        const currentIndex = currentQueueState.currentIndex;
        integration.setWorkflowProgress(currentIndex + 1, totalPrompts);
      }
      Log.info(
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
      vscode.window.showErrorMessage(`FlightPath: Execution failed: ${error}`);
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
      Log.info(
        "▶️ Resuming with pending response (Copilot finished while paused)"
      );
      this.workflowExecutor.resumePendingResponse();
      return;
    }

    if (this.workflowExecutor.isAwaitingResponse()) {
      Log.info(
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
        Log.info(
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
    Log.info("Workflow state cleared");
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
        vscode.window.showErrorMessage("No prompts found in file");
        return;
      }

      const queueState = this.promptQueue.getState();
      const currentSize = queueState.prompts.length;

      if (currentSize === 0) {
        Log.info("Empty workflow, creating new workflow in IDLE state");
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
        vscode.window.showErrorMessage(
          "Cannot queue prompts: Workflow must be cleared first"
        );
        return;
      }

      const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
      const maxQueueSize = queueConfig.maxQueueSize;
      const unlimitedMode = queueConfig.unlimitedMode;
      const newSize = currentSize + parsed.prompts.length;

      if (!unlimitedMode && newSize > maxQueueSize) {
        vscode.window.showWarningMessage(
          `Queue size limit exceeded: ${newSize}/${maxQueueSize} prompts. ` +
            `Enable unlimitedMode or increase maxQueueSize to proceed.`
        );
        return;
      }

      const source = `User append (${position}): ${path.basename(filePath)}`;
      await this.promptQueue.appendPrompts(parsed.prompts, source, position);

      if (this.dashboardProvider) {
        const updatedState = this.promptQueue.getState();
        this.dashboardProvider.updatePromptsExtended(updatedState.prompts);
        this.dashboardProvider.updateProgress(
          updatedState.currentIndex,
          updatedState.prompts.length
        );
      }

      if (!this.currentPromptFile) {
        Log.info("No prompt file loaded, updating context (append mode)");
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
      vscode.window.showInformationMessage(
        `Queued ${parsed.prompts.length} prompt(s) ${positionText}`
      );
    } catch (error) {
      Log.error("Failed to queue prompts:", error);
      vscode.window.showErrorMessage(
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
    if (this.dashboardProvider) {
      const currentState = this.promptQueue.getState();
      this.dashboardProvider.updatePromptsExtended(currentState.prompts);
    }
    Log.info(`Updated prompt ${index}: ${text.substring(0, 50)}...`);
  }

  async deletePromptFromQueue(index: number): Promise<void> {
    Log.info(
      `🗑️ WorkflowInstance.deletePromptFromQueue: Deleting prompt at index ${index}`
    );
    await this.promptQueue.deletePrompt(index);
    if (this.dashboardProvider) {
      const currentState = this.promptQueue.getState();
      const fileName = this.currentPromptFile
        ? path.basename(this.currentPromptFile.filePath)
        : "Untitled";
      this.dashboardProvider.updatePromptDeleted(
        fileName,
        currentState.prompts
      );
    }
    Log.info(`Deleted prompt ${index}`);
  }

  async resetWorkflowState(): Promise<void> {
    Log.info("WorkflowInstance.resetWorkflowState: Resetting workflow state");
    await this.promptQueue.restart();
    if (this.dashboardProvider) {
      const currentState = this.promptQueue.getState();
      this.dashboardProvider.notifyWorkflowStateReset(currentState.prompts);
    }
    Log.info("WorkflowInstance.resetWorkflowState: Complete");
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
      Log.info("Force new workflow requested - clearing current workflow");
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
      Log.info(
        `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: no existing workflow — initializing new with name="${workflowName}", shouldRun=${shouldRun}, action=${action}`
      );
      await this.initializeNewWorkflow([promptItem], workflowName);

      if (shouldRun) {
        await this.executeLoadedPromptFile();
        Log.info(
          `Send prompt (run, position=${position}): ${text.substring(0, 50)}...`
        );
      } else {
        Log.info(
          `Add prompt (no run, position=${position}): ${text.substring(0, 50)}...`
        );
      }
    } else {
      Log.info(
        `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: appending to existing workflow ` +
          `(status=${currentState.status}, prompts=${currentState.prompts.length}, shouldRun=${shouldRun}, action=${action})`
      );
      await this.promptQueue.appendPrompts(
        [promptItem],
        "Dashboard editor",
        position,
        shouldRun
      );

      if (this.dashboardProvider) {
        const updatedState = this.promptQueue.getState();
        this.dashboardProvider.updatePromptsExtended(updatedState.prompts);
      }

      if (shouldRun) {
        const isStopped = currentState.status === EXECUTION_STATES.STOPPED;
        Log.info(
          `[inst:${this.id.slice(0, 8)}] executeEphemeralPrompt: post-append shouldRun=true, ` +
            `isIdle=${isIdle}, isCompleted=${isCompleted}, isStopped=${isStopped}, ` +
            `queueStatusNow=${this.promptQueue.getState().status}`
        );
        if (isIdle || isCompleted || isStopped) {
          await this.executeLoadedPromptFile(undefined, true);
        }
        Log.info(
          `Send prompt (run, position=${position}): ${text.substring(0, 50)}...`
        );
      } else {
        Log.info(
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
    if (harnessOverride) {
      Log.info(`🔀 Using harness override: ${harnessOverride}`);
    }
    const integration = this.integrationFactory.createForExecution(harness);
    integration.setWorkflowName(this.workflowName || undefined);
    this.executionIntegrations.add(integration);
    return integration;
  }

  private async startWorkflowExecution(
    integration?: HarnessIntegration,
    historyFilePath = "",
    workingFilePath?: string
  ): Promise<void> {
    if (this.startPending) {
      Log.info(
        `[inst:${this.id.slice(0, 8)}] ⚠️ Workflow start already pending, skipping duplicate start request`
      );
      return;
    }

    this.startPending = true;
    this.startedAt = Date.now();

    try {
      const activeIntegration = integration || this.createIntegrationForMode();
      this.activeIntegration = activeIntegration;

      Log.info(
        `[inst:${this.id.slice(0, 8)}] startWorkflowExecution: isActive=${this.isActive}, historyFilePath="${historyFilePath}"`
      );
      // Use a getter so dashboardProvider is evaluated lazily each time
      // WorkflowExecutor accesses it. When this instance is deactivated
      // (user switches to another workflow), activeDashboard returns
      // undefined and background output stops flowing to the UI.
      const self = this;
      const workflowContext: WorkflowContext = {
        workspaceFolderPath: this.workspaceFolder?.uri.fsPath,
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
          const resolvedHarness = harnessOverride || prompt.harness;
          if (resolvedHarness) {
            Log.info(
              `🔀 Prompt ${prompt.name || "unnamed"} using harness override: ${resolvedHarness}`
            );
            const overrideIntegration =
              this.createIntegrationForMode(resolvedHarness);
            this.activeIntegration = overrideIntegration;
            return overrideIntegration;
          }
          return activeIntegration;
        },
        captureOutputInit: (
          stepIndex,
          prompt,
          cliCommand,
          workingDirectory,
          timestampMs,
          attemptIndex
        ) => {
          // Always buffer the init state so we can replay it when switching back
          self.stepOutputBuffer.set(stepIndex, {
            prompt,
            cliCommand,
            workingDirectory,
            timestampMs,
            attemptIndex,
            accumulatedText:
              self.stepOutputBuffer.get(stepIndex)?.accumulatedText ?? "",
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
              Log.info(
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
          Log.info(
            `[inst:${self.id.slice(0, 8)}] captureCompletedOutput: step ${stepIndex} attempt ${attemptIndex}, total outputs=${self.completedStepOutputs.get(stepIndex)!.outputs.length}, retryState=${JSON.stringify(self.completedStepOutputs.get(stepIndex)!.retryState ?? null)}`
          );
          // The step is no longer streaming; remove from streaming buffer
          self.stepOutputBuffer.delete(stepIndex);
        },
      };

      await this.workflowExecutor.execute(activeIntegration, workflowContext);

      this.activeIntegration = undefined;
    } finally {
      // Dispose all execution integrations created for this run.
      // They are short-lived (one run), not registered with context.subscriptions,
      // so must be disposed manually to release their EventEmitter resources.
      for (const execIntegration of this.executionIntegrations) {
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
    Log.info(
      `[inst:${this.id.slice(0, 8)}] Queue state → ${state.status} (step ${state.currentIndex}/${state.prompts.length}, isActive=${this.isActive})`
    );
    this.onStatusBarUpdate();

    if (this.isActive && this.dashboardProvider) {
      // Active workflow: forward state changes directly to the dashboard
      this.dashboardProvider.updateExecutionState(state.status);

      if (state.prompts.length > this.lastKnownPromptCount) {
        Log.info(
          `Detected prompt count increase: ${this.lastKnownPromptCount} → ${state.prompts.length}. Notifying dashboard.`
        );
        this.dashboardProvider.updatePromptsExtended(state.prompts);
        this.dashboardProvider.updateProgress(
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
      Log.info(
        `Auto-starting workflow: State=RUNNING, activeIntegration=null, currentIndex=${state.currentIndex}, totalPrompts=${state.prompts.length}`
      );
      this.startWorkflowExecution(
        undefined,
        "",
        state.workingFilePath || undefined
      ).catch((error) => {
        Log.error("Auto-start failed:", error);
        vscode.window.showErrorMessage(
          `FlightPath: Failed to auto-start workflow: ${error}`
        );
      });
    } else if (state.status === EXECUTION_STATES.RUNNING) {
      Log.info(
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

    Log.info(
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
        Log.info(`Reusing existing working file: ${workingFilePath}`);
      }
    }

    const workspaceFolder =
      this.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    if (!workingFilePath && workspaceFolder) {
      try {
        workingFilePath = await this.promptQueue.createWorkingFile(
          displayName,
          prompts,
          workspaceFolder,
          originalFilePath
        );
        Log.info(`✅ Created working file: ${workingFilePath}`);

        if (this.dashboardProvider) {
          await this.dashboardProvider.applyPendingWorkflowProperties();
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
    Log.info(
      `[inst:${this.id.slice(0, 8)}] initializeNewWorkflow: post-load state — ` +
        `queue.workflowName="${postLoadState.workflowName || '(unset)"'}` +
        `, instance.workflowName="${this.workflowName}", instance.filePath="${this.filePath}"` +
        `, getSummary().workflowName="${this.getSummary().workflowName || "(empty)"}"`
    );

    if (this.dashboardProvider) {
      const queueState = this.promptQueue.getState();
      this.dashboardProvider.updateFileSelected(
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
      vscode.window.showInformationMessage(notificationMessage);
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
