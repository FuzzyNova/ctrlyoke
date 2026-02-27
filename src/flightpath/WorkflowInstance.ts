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

/**
 * WorkflowInstance
 *
 * RESPONSIBILITY: Single Workflow Execution Lifecycle
 *
 * Encapsulates all per-workflow state that was previously scattered across
 * FlightPathManager:
 *   - PromptQueue (state machine)
 *   - WorkflowExecutor (execution loop)
 *   - EndConditionHandler / EndConditionEvaluator
 *   - PromptFileLoader / PromptFileWatcher
 *   - OutputHistoryManager
 *   - activeIntegration, currentPromptFile, startPending, lastKnownPromptCount
 *
 * Dependencies that span multiple workflows (integrations, status bar, template
 * importing) remain in WorkflowOrchestrator and are injected as callbacks:
 *   - getIntegration(harnessOverride?)  → resolve integration by harness
 *   - getDefaultIntegration()           → resolve per-settings default
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

  // ─────────────────────────────────────────────────────────────────────────
  // Orchestration helpers
  // ─────────────────────────────────────────────────────────────────────────
  private readonly promptFileLoader: PromptFileLoader;
  private readonly promptFileWatcher: PromptFileWatcher;
  readonly outputHistoryManager: OutputHistoryManager;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dashboardProvider: FlightPathWebviewProvider | undefined,
    /**
     * Resolve an integration by optional harness override.
     * Provided by WorkflowOrchestrator so WorkflowInstance never hard-references
     * the shared integration instances.
     */
    private readonly getIntegration: (
      harnessOverride?: Harness
    ) => HarnessIntegration,
    /** Resolve the default integration based on current VS Code settings */
    private readonly getDefaultIntegration: () => HarnessIntegration,
    /**
     * Callback to propagate workflow name to CLI integration terminal tabs.
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
      this.dashboardProvider
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
      this.dashboardProvider
    );
    this.promptFileWatcher = new PromptFileWatcher(
      this.promptQueue,
      this.dashboardProvider
    );

    // Subscribe to queue state changes
    this.promptQueue.onDidChangeState(this.onQueueStateChanged.bind(this));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Mark this instance as the active/visible workflow.
   * Phase 2: flushes buffered events and sends a full state sync to the dashboard.
   */
  setActive(value: boolean): void {
    this.isActive = value;
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
      return;
    }
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
    this.dashboardProvider.updateSessionRestored(
      fileName,
      state.prompts,
      state.results,
      state.status,
      state.currentIndex,
      state.workflowName || undefined
    );
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
    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace"
    );

    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    if (workingFile?.prompts) {
      const filePath = workingFile.originalFile || workingFilePath;
      this.currentPromptFile = {
        filePath,
        promptFile: { prompts: workingFile.prompts },
      };
    }

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
    await this.promptFileLoader.reloadFromWorkingFile(
      workingFilePath,
      "replace",
      true // isAutoLoad — prevents auto-starting RUNNING workflows
    );

    const workingFile = await this.promptQueue.readWorkingFile(workingFilePath);
    if (workingFile?.prompts) {
      const filePath = workingFile.originalFile || workingFilePath;
      this.currentPromptFile = {
        filePath,
        promptFile: { prompts: workingFile.prompts },
      };
    }

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

    await this.saveAndReloadIfDirty(filePath);

    if (!this.currentPromptFile) {
      return;
    }

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

      const integration = this.createIntegrationForMode(modeOverride);

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

      const detailedStatus = integration.getDetailedStatus();

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
          await integration.retryDetection();
          setTimeout(
            () =>
              this.executeLoadedPromptFile(modeOverride, continueFromCurrent),
            2000
          );
        } else if (action === "View Requirements") {
          await integration.testAutomation();
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
      await this.startWorkflowExecution(integration, historyFilePath, workingFilePath || undefined);
    } catch (error) {
      Log.error("Failed to execute prompt file:", error);
      await this.promptQueue.markErrored();
      vscode.window.showErrorMessage(`FlightPath: Execution failed: ${error}`);
    }
  }

  /**
   * Execute a prompt file (legacy: loads and executes immediately).
   */
  async executePromptFile(
    filePath: string,
    modeOverride?: Harness
  ): Promise<void> {
    await this.saveAndReloadIfDirty(filePath);
    await this.loadPromptFile(filePath);
    await this.executeLoadedPromptFile(modeOverride);
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
    const integration = this.activeIntegration || this.getDefaultIntegration();

    Log.info(`⏹️ WorkflowInstance.stop() - stopping active integration`);

    this.promptQueue.stop();

    let confirmedStoppedCalled = false;

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
      responseCompleteDisposable.dispose();
    });

    await integration.cancel();

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

    integration.onResponseComplete(() => {
      clearTimeout(timeoutHandle);
    });

    this.workflowExecutor.clearPendingState();
    this.startPending = false;
  }

  /**
   * Clear current workflow state.
   */
  clearWorkflow(): void {
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
        this.setupPromptFileWatcher(filePath);
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
    console.log(
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
      await this.promptQueue.appendPrompts(
        [promptItem],
        "Dashboard editor",
        position
      );

      if (this.dashboardProvider) {
        const updatedState = this.promptQueue.getState();
        this.dashboardProvider.updatePromptsExtended(updatedState.prompts);
      }

      if (shouldRun) {
        const isStopped = currentState.status === EXECUTION_STATES.STOPPED;
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
   * WorkflowOrchestrator sets the flag; for Phase 1 this is always true when
   * executeLoadedPromptFile is called (dashboardReady is checked upstream).
   * This helper exists so the logic is self-contained inside WorkflowInstance.
   */
  private isDashboardReady(): boolean {
    // In Phase 1 this delegate just reports whether a dashboard is registered at all.
    // The orchestrator's dashboardReady flag is already checked before this method
    // is reached via executeLoadedPromptFile → only called after setDashboardReady.
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
    if (harnessOverride) {
      Log.info(`🔀 Using harness override: ${harnessOverride}`);
    }
    return this.getIntegration(harnessOverride);
  }

  private async saveAndReloadIfDirty(filePath: string): Promise<void> {
    await this.promptFileLoader.saveAndReloadIfDirty(filePath, async () => {
      if (this.currentPromptFile) {
        const fileName = path.basename(this.currentPromptFile.filePath);
        const promptFile = await this.promptFileParser.parsePromptFile(
          this.currentPromptFile.filePath
        );

        if (promptFile?.prompts) {
          const validation = this.promptFileParser.validatePromptItems(
            promptFile.prompts
          );
          if (validation.valid) {
            this.currentPromptFile = {
              filePath: this.currentPromptFile.filePath,
              promptFile,
            };
            this.promptQueue.loadPrompts(promptFile);

            if (this.dashboardProvider) {
              const queueState = this.promptQueue.getState();
              this.dashboardProvider.updateFileSelected(
                fileName,
                promptFile.prompts,
                queueState.workflowName || undefined
              );
            }

            Log.info(
              `FlightPath: Reloaded ${promptFile.prompts.length} prompt(s) from ${fileName}`
            );
          }
        }
      }
    });
  }

  private async startWorkflowExecution(
    integration?: HarnessIntegration,
    historyFilePath = "",
    workingFilePath?: string
  ): Promise<void> {
    if (this.startPending) {
      Log.info(
        "⚠️ Workflow start already pending, skipping duplicate start request"
      );
      return;
    }

    this.startPending = true;
    this.startedAt = Date.now();

    try {
      const activeIntegration = integration || this.getDefaultIntegration();
      this.activeIntegration = activeIntegration;

      Log.info(
        `🟢 [APPEND-DEBUG] Creating WorkflowContext with historyFilePath: "${historyFilePath}" (empty=${!historyFilePath})`
      );
      const workflowContext: WorkflowContext = {
        workspaceFolderPath: this.workspaceFolder?.uri.fsPath,
        currentPromptFilePath: this.currentPromptFile?.filePath,
        dashboardProvider: this.dashboardProvider,
        shouldShowCliCommand: this.shouldShowCliCommand(),
        showCliOutput: ConfigurationUtils.shouldShowCliOutput(),
        dynamicQueueConfig: this.getDynamicQueueConfig(),
        historyFilePath,
        workingFilePath: workingFilePath || undefined,
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
      };

      await this.workflowExecutor.execute(activeIntegration, workflowContext);

      this.activeIntegration = undefined;
    } finally {
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
      `FlightPath: Queue state changed to ${state.status} (currentIndex: ${state.currentIndex}, total: ${state.prompts.length}, completed: ${state.completedIds.size})`
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
      this.startWorkflowExecution(undefined, "", state.workingFilePath || undefined).catch((error) => {
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
      this.setupPromptFileWatcher(originalFilePath);
    } else {
      this.currentPromptFile = {
        filePath: displayName,
        promptFile: { prompts },
      };
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
    const updates: Partial<PromptItem> = {};

    if (props?.harness !== undefined) {
      updates.harness =
        props.harness === null ? undefined : (props.harness as Harness);
    }
    if (props?.model !== undefined) {
      updates.model =
        props.model === null ? undefined : (props.model as string);
    }
    if (props?.agent !== undefined) {
      updates.agent =
        props.agent === null ? undefined : (props.agent as string);
    }
    if (props?.resumeSession !== undefined) {
      updates.resumeSession =
        props.resumeSession === null
          ? undefined
          : (props.resumeSession as boolean);
    }
    if (props?.sessionId !== undefined) {
      updates.sessionId =
        props.sessionId === null
          ? undefined
          : (props.sessionId as string | number);
    }
    if (props?.allowDynamicExtension !== undefined) {
      updates.allowDynamicExtension =
        props.allowDynamicExtension === null
          ? undefined
          : (props.allowDynamicExtension as boolean);
    }
    if (props?.endCondition !== undefined) {
      updates.endCondition =
        props.endCondition === null
          ? undefined
          : (props.endCondition as PromptItem["endCondition"]);
    }

    return updates;
  }
}
