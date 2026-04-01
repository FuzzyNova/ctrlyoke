import * as path from "path";
import { TypedEmitter } from "../utils/TypedEmitter";
import {
  PromptItem,
  PromptFile,
  FinalPromptRuntimeState,
  QueueState,
  PromptResult,
  EXECUTION_STATES,
  STEP_STATUS,
} from "../types/FlightPathTypes";
import type { WorkingFile } from "../types/FlightPathTypes";
import {
  QUEUE_POSITION,
  type QueuePosition,
} from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import { hashPromptContent } from "../utils/PromptIdentity";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { WorkingFileManager } from "./WorkingFileManager";
import type { IWorkingFileQueueAccess } from "./WorkingFileManager";
import { WorkflowStateMachine } from "./WorkflowStateMachine";

/**
 * Get effective maxRetries value with smart defaults
 */
function getEffectiveMaxRetries(
  endCondition?: PromptItem["endCondition"]
): number {
  if (!endCondition) {
    return 0;
  }

  const hasRetryPrompt = !!endCondition.retryPrompt;
  const hasMaxRetries = endCondition.maxRetries !== undefined;

  // Case 1: Both specified - use explicit maxRetries
  if (hasMaxRetries) {
    return endCondition.maxRetries!;
  }

  // Case 2: Only retryPrompt specified - use default from settings
  if (hasRetryPrompt) {
    return ConfigurationUtils.getDefaultMaxRetries();
  }

  // Case 3: Neither specified - no retries
  return 0;
}

/**
 * Get effective retry prompt with smart defaults
 */
function getEffectiveRetryPrompt(
  endCondition?: PromptItem["endCondition"]
): string | undefined {
  if (!endCondition) {
    return undefined;
  }

  const hasRetryPrompt = !!endCondition.retryPrompt;
  const hasMaxRetries =
    endCondition.maxRetries !== undefined && endCondition.maxRetries !== 0;

  // Case 1: Explicit retryPrompt - use it
  if (hasRetryPrompt) {
    return endCondition.retryPrompt;
  }

  // Case 2: Only maxRetries specified - use default from settings
  if (hasMaxRetries) {
    const defaultPrompt = ConfigurationUtils.getDefaultRetryPrompt();
    return defaultPrompt || undefined;
  }

  // Case 3: Neither specified - no retry prompt
  return undefined;
}

export class PromptQueue {
  private state: QueueState;
  private workflowFile?: PromptFile; // Store complete workflow file with workflow-level properties
  private finalPromptRuntime?: FinalPromptRuntimeState;
  private onStateChanged = new TypedEmitter<QueueState>();
  private currentRetryCount: number = 0; // Track retry attempts for current prompt
  private readonly workingFileManager: WorkingFileManager;
  private readonly stateMachine: WorkflowStateMachine;

  // Public event for state changes
  public readonly onDidChangeState = this.onStateChanged.event;

  constructor(stateMachine: WorkflowStateMachine = new WorkflowStateMachine()) {
    this.stateMachine = stateMachine;
    this.state = {
      currentIndex: 0,
      status: EXECUTION_STATES.IDLE,
      prompts: [],
      results: [],
      stopped: false,
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      totalPausedDuration: 0,
    };

    // Create WorkingFileManager with adapter that provides access to queue state
    const queueAccess: IWorkingFileQueueAccess = {
      getWorkingFilePath: () => this.state.workingFilePath,
      getPrompts: () => this.state.prompts,
      getCurrentIndex: () => this.state.currentIndex,
      getStatus: () => this.stateMachine.status,
      getWorkflowName: () => this.state.workflowName,
      mergeDiskPrompts: (diskPrompts: PromptItem[]) =>
        this.mergeDiskPrompts(diskPrompts),
      emitStateChange: () => this.emitStateChange(),
      getFinalPromptRuntime: () => this.getFinalPromptRuntime(),
      updateWorkflowProperty: (key: string, value: unknown) =>
        this.updateWorkflowProperty(key, value),
    };
    this.workingFileManager = new WorkingFileManager(queueAccess);
  }

  /**
   * Extract workflow name from file path
   * Strips FlightPath-specific extensions (.flightpath.json, .flightpath.yaml, .flightpath.yml, .prompt.md)
   *
   * @param filePath - Full file path
   * @returns Workflow name without extensions
   *
   * @example
   * PromptQueue.extractWorkflowName("/path/to/my-workflow.flightpath.yaml") // "my-workflow"
   * PromptQueue.extractWorkflowName("C:\\Users\\dev\\feature.flightpath.json") // "feature"
   * PromptQueue.extractWorkflowName("/path/prompt.prompt.md") // "prompt"
   */
  static extractWorkflowName(filePath: string): string {
    const fileName = path.basename(filePath);
    // Remove FlightPath extensions: .flightpath.json, .flightpath.yaml, .flightpath.yml, .prompt.md
    return fileName.replace(/\.(flightpath\.(json|yaml|yml)|prompt\.md)$/, "");
  }

  /**
   * Update the workflow name in queue state and persist to working file.
   * Used when the name is derived after the working file is eagerly created
   * (e.g., first prompt text used to name an ephemeral workflow).
   */
  setWorkflowName(name: string): void {
    this.state.workflowName = name;
    this.emitStateChange();
  }

  /**
   * Clear the queue completely (reset to empty state)
   * Used when user clicks "New Workflow" button
   */
  clearQueue(): void {
    this.state = {
      currentIndex: 0,
      status: EXECUTION_STATES.IDLE,
      prompts: [],
      results: [],
      stopped: false,
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      totalPausedDuration: 0,
      // Clear working file path and workflow name
      workingFilePath: undefined,
      workflowName: undefined,
    };

    this.workflowFile = undefined; // Clear workflow file reference
    this.finalPromptRuntime = undefined;
    this.syncToStateMachine();

    this.emitStateChange();
    Log.info("Queue cleared - ready for new workflow");
  }

  public getRuntimeStateMachine(): WorkflowStateMachine {
    return this.stateMachine;
  }

  public async commitRuntimeTransition(
    options: {
      persist?: boolean;
      emitStateChange?: boolean;
      skipMerge?: boolean;
    } = {}
  ): Promise<void> {
    const {
      persist = true,
      emitStateChange = true,
      skipMerge = false,
    } = options;

    this.syncFromStateMachine();

    if (emitStateChange) {
      this.emitStateChange();
    }

    if (persist) {
      await this.updateWorkingFile(skipMerge);
    }
  }

  public markCurrentPromptCancelled(): void {
    const currentIndex = this.state.currentIndex;
    this.state.results.forEach((result, index) => {
      if (
        result.status === STEP_STATUS.SENT ||
        (result.status === STEP_STATUS.PENDING && index === currentIndex)
      ) {
        result.status = STEP_STATUS.CANCELLED;
      }
    });
  }

  public advanceCancelledPromptAfterStop(): boolean {
    const index = this.state.currentIndex;
    const prompt = this.state.prompts[index];

    if (!prompt) {
      return false;
    }

    const now = Date.now();
    prompt._runtime = {
      startedAt: prompt._runtime?.startedAt ?? now,
      ...prompt._runtime,
      completedAt: now,
      terminalStatus: "cancelled",
    };
    this.state.completedIndices.add(String(index));
    this.state.currentIndex++;

    return true;
  }

  public failCurrentPromptIfInProgress(): boolean {
    if (!this.hasNext()) {
      return false;
    }

    const index = this.state.currentIndex;
    const currentResult = this.state.results[index];
    if (
      currentResult?.status !== STEP_STATUS.SENT &&
      currentResult?.status !== STEP_STATUS.RUNNING
    ) {
      return false;
    }

    currentResult.status = STEP_STATUS.FAILED;
    currentResult.timestamp = new Date();

    const prompt = this.state.prompts[index];
    if (prompt) {
      const now = Date.now();
      prompt._runtime = {
        startedAt: prompt._runtime?.startedAt ?? now,
        ...prompt._runtime,
        completedAt: now,
        terminalStatus: "failed",
      };
    }
    this.state.completedIndices.add(String(index));
    this.state.currentIndex++;

    return true;
  }

  /**
   * Clear only the working file path reference without affecting prompts or other state.
   * Used when the working file has been deleted externally (e.g., removed from history)
   * so that ensureEphemeralWorkingFile() will create a fresh one on the next write.
   */
  clearWorkingFilePath(): void {
    this.state.workingFilePath = undefined;
    this.emitStateChange();
  }

  /**
   * Load prompts into the queue
   * @param promptFile Complete workflow file with prompts and workflow-level properties
   * @param workingFilePath Optional path to working file (source of truth)
   */
  loadPrompts(promptFile: PromptFile, workingFilePath?: string): void {
    const prompts = promptFile.prompts || [];

    this.state = {
      currentIndex: 0,
      status: EXECUTION_STATES.IDLE,
      prompts: [...prompts],
      results: prompts.map((prompt) => ({
        prompt: prompt.prompt,
        status: STEP_STATUS.PENDING,
        timestamp: new Date(),
      })),
      stopped: false, // Reset stopped flag on new load
      completedIndices: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      totalPausedDuration: 0,
      workingFilePath,
      workflowName: this.state.workflowName, // Preserve workflow name across reloads
    };

    // Store complete workflow file for property resolution
    this.workflowFile = promptFile;
    this.finalPromptRuntime = undefined;
    this.syncToStateMachine();

    this.emitStateChange();
    Log.info(`Loaded ${prompts.length} prompts into queue`);
  }

  /**
   * Restore queue state from a working file (including runtime state)
   * This is used when resuming a previous session from .flightpath/.queue
   * @param workingFilePath Path to the working file
   */
  async restoreFromWorkingFile(
    workingFilePath: string,
    isAutoLoad: boolean = false
  ): Promise<void> {
    try {
      // Read the working file
      const workingFile = await this.readWorkingFile(workingFilePath);

      const runtime = workingFile._runtime;
      this.finalPromptRuntime = runtime?.finalPrompt;

      const prompts = workingFile.prompts ?? [];

      // Build completedIndices from per-prompt _runtime.completedAt (source of truth).
      // Fall back to currentIndex boundary for old working files that lack per-prompt _runtime.
      const hasPerPromptTracking = prompts.some(
        (p) => p._runtime?.completedAt !== undefined
      );

      const completedIndices = new Set<string>();
      if (hasPerPromptTracking) {
        // New format: use per-prompt completedAt
        prompts.forEach((p, i) => {
          if (p._runtime?.completedAt !== undefined) {
            completedIndices.add(String(i));
          }
        });
      } else if (runtime?.currentIndex && runtime.currentIndex > 0) {
        // Old format: treat prompts before currentIndex as completed
        Log.info(
          "Old working file format detected: using currentIndex for completion boundary"
        );
        for (let i = 0; i < runtime.currentIndex; i++) {
          completedIndices.add(String(i));
          // Self-heal: write completedAt back so next save uses new format
          if (prompts[i]) {
            prompts[i]._runtime = {
              ...prompts[i]._runtime,
              startedAt:
                prompts[i]._runtime?.startedAt ??
                (workingFile.startedAt || Date.now()),
              completedAt: workingFile.startedAt
                ? workingFile.startedAt + 1
                : Date.now(),
            };
          }
        }
      }

      // Determine execution state
      // When auto-loading on startup, NEVER restore as RUNNING (prevents unwanted auto-start)
      // Force to STOPPED — preserves per-prompt progress so the user can see how far the
      // workflow got and resume from the current prompt. PAUSED is semantically wrong here
      // (it implies the user intentionally paused); STOPPED signals "aborted, position kept".
      let executionState = runtime?.executionState || EXECUTION_STATES.IDLE;
      let forcedToStopped = false;
      if (isAutoLoad && executionState === EXECUTION_STATES.RUNNING) {
        executionState = EXECUTION_STATES.STOPPED;
        forcedToStopped = true;
        Log.info(
          "Auto-load: Forced RUNNING state to STOPPED to prevent auto-start"
        );
      }

      // Restore prompts and basic state
      // CRITICAL: Preserve _runtime metadata during load (Phase 4: Per-Prompt Session Management)
      // Each prompt's _runtime contains: harness, model, agent, sessionId, startedAt, completedAt
      this.state = {
        currentIndex: runtime?.currentIndex || 0,
        status: executionState,
        prompts: prompts.map((prompt) => ({
          ...prompt,
          // Backward compatibility: _runtime is optional, old files won't have it
          // The spread operator preserves _runtime if it exists
        })),
        results: [],
        stopped: false,
        completedIndices,
        totalExecutionTime: 0,
        queueExtensions: 0,
        totalPausedDuration: 0,
        workingFilePath,
        workflowName: workingFile.workflowName, // Restore workflow name from working file
      };

      // Store complete workflow file for property resolution
      this.workflowFile = workingFile;
      this.syncToStateMachine();

      // Rebuild results array with proper status based on completion state
      this.state.results = prompts.map((prompt, index) => {
        let status: (typeof STEP_STATUS)[keyof typeof STEP_STATUS];

        // Check if this prompt was processed (per-prompt completedAt is authoritative)
        // Use terminalStatus to restore the correct visual state (cancelled/failed vs completed).
        if (prompt._runtime?.completedAt !== undefined) {
          const terminal = prompt._runtime.terminalStatus;
          status =
            terminal === "cancelled"
              ? STEP_STATUS.CANCELLED
              : terminal === "failed"
                ? STEP_STATUS.FAILED
                : STEP_STATUS.COMPLETED;
        }
        // Check if this is the current prompt (always PENDING or SENT — never CANCELLED)
        else if (index === this.state.currentIndex) {
          // RUNNING → SENT (actively being processed)
          // Otherwise (IDLE, PAUSED, STOPPED, etc.) → PENDING
          status =
            this.state.status === EXECUTION_STATES.RUNNING
              ? STEP_STATUS.SENT
              : STEP_STATUS.PENDING;
        }
        // All other prompts are pending
        else {
          status = STEP_STATUS.PENDING;
        }

        return {
          prompt: prompt.prompt,
          status,
          timestamp: new Date(),
        };
      });

      this.emitStateChange();

      // Persist forced STOPPED state to disk immediately so subsequent
      // handleGetRecentWorkflows reads see the correct state, not "running".
      if (forcedToStopped) {
        await this.updateWorkingFile().catch((err) =>
          Log.warn("Auto-load: failed to persist STOPPED state to disk:", err)
        );
      }

      // Log runtime metadata restoration (Phase 4: Session Management)
      const promptsWithRuntime = this.state.prompts.filter(
        (p) => p._runtime
      ).length;
      Log.info(
        `Restored queue from working file: ${prompts.length} prompts, ` +
          `currentIndex=${this.state.currentIndex}, ` +
          `completed=${this.state.completedIndices.size}, ` +
          `status=${this.state.status}, ` +
          `_runtime: ${promptsWithRuntime}/${prompts.length} prompts`
      );
    } catch (error) {
      Log.error("Failed to restore from working file:", error as Error);
      throw error;
    }
  }

  /**
   * Start queue execution
   * Note: This only sets the queue state to running. The state change event
   * triggers WorkflowOrchestrator.onQueueStateChanged() which starts actual execution.
   */
  async start(): Promise<void> {
    if (this.stateMachine.status === EXECUTION_STATES.RUNNING) {
      Log.debug("Queue is already running");
      return;
    }

    if (this.state.prompts.length === 0) {
      Log.warn("FlightPath: No prompts to execute");
      return;
    }

    if (!this.stateMachine.startExecution()) {
      return;
    }

    await this.commitRuntimeTransition();

    Log.debug("Queue state set to running");
  }

  /**
   * Pause queue execution
   */
  async pause(): Promise<void> {
    if (!this.stateMachine.pause()) {
      return;
    }

    await this.commitRuntimeTransition();
    Log.info("Queue execution paused");
  }

  /**
   * Resume queue execution
   * Note: This only updates queue state. WorkflowOrchestrator checks the state
   * and continues execution from where it was paused or stopped.
   *
   * PAUSED: Current prompt completed normally, continues to next prompt.
   * STOPPED: Cancelled prompt was already advanced past in confirmedStopped(),
   *          so currentIndex already points to the next prompt to run.
   */
  async resume(): Promise<void> {
    const previousState = this.stateMachine.status;
    if (!this.stateMachine.resume()) {
      return;
    }

    await this.commitRuntimeTransition();

    Log.info(`Queue state set to running (resumed from ${previousState})`);
  }

  /**
   * Stop and reset queue
   * Sets state to CANCELLING - call confirmedStopped() once process actually exits
   */
  stop(): void {
    if (!this.stateMachine.requestStop()) {
      return;
    }

    this.markCurrentPromptCancelled();

    this.syncFromStateMachine();
    this.emitStateChange();
    Log.info("Queue cancellation requested (waiting for process to exit)");
  }

  /**
   * Confirm that execution has fully stopped (process exited)
   * Call this after the CLI process actually terminates
   *
   * STOP semantics: Abort current prompt and advance past it
   * - Unlike PAUSE (which lets current prompt finish), STOP cancels immediately
   * - Unlike RESTART (which resets to beginning), STOP preserves all progress
   * - Current prompt is marked CANCELLED and currentIndex advances to the next prompt
   * - Resume / Run continues from the next prompt (use setStartPosition to re-run the cancelled one)
   */
  async confirmedStopped(): Promise<void> {
    if (!this.stateMachine.confirmStopped()) {
      return;
    }

    const stoppedIndex = this.state.currentIndex;
    const advancedPastQueuePrompt = this.advanceCancelledPromptAfterStop();

    await this.commitRuntimeTransition();
    if (advancedPastQueuePrompt) {
      Log.info(
        `Queue execution fully stopped - advanced past cancelled step ${stoppedIndex}`
      );
    } else {
      Log.info("Queue execution fully stopped");
    }
  }

  /**
   * Restart queue from the beginning
   * Resets index, results, and tracking state while keeping prompts loaded
   * Updates working file to clear completedPrompts array
   */
  async restart(): Promise<void> {
    this.stateMachine.reset();
    this.syncFromStateMachine();
    this.state.currentIndex = 0;
    this.currentRetryCount = 0;

    // Reset all results to pending
    this.state.results = this.state.prompts.map((prompt) => ({
      prompt: prompt.prompt,
      status: STEP_STATUS.PENDING,
      timestamp: new Date(),
    }));

    // Reset tracking state
    this.state.completedIndices = new Set<string>();
    this.state.totalExecutionTime = 0;
    this.state.queueExtensions = 0;
    this.finalPromptRuntime = undefined;

    // Clear per-prompt _runtime data (sessionId, harness, model, etc.)
    // Stale session IDs from a previous run would cause log discovery and session
    // resumption to find the wrong session when re-running the same workflow.
    this.state.prompts = this.state.prompts.map((prompt) => {
      // Destructure to remove _runtime, preserving all other PromptItem fields
      const { _runtime, ...rest } = prompt;
      return rest;
    });

    this.emitStateChange();
    Log.info("Queue restarted from beginning");

    // Update working file immediately to clear completedPrompts array
    // This prevents race condition where MCP appends during first prompt
    // would reload stale completedPrompts from disk
    await this.updateWorkingFile();
  }

  /**
   * Restore queue state after a dirty-file reload for an append continuation.
   *
   * When the prompt file was dirty in VS Code and `loadPrompts` was called (resetting
   * currentIndex to 0), we need to advance the queue past the N steps that were already
   * completed in the previous run, so the executor starts at step N.
   *
   * @param completedCount Number of steps from the previous run that were completed.
   */
  async restoreCompletedSteps(completedCount: number): Promise<void> {
    const cap = Math.min(completedCount, this.state.prompts.length);
    for (let i = 0; i < cap; i++) {
      this.state.results[i].status = STEP_STATUS.COMPLETED;
    }
    this.state.currentIndex = cap;
    this.emitStateChange();
    Log.info(`Restored ${cap} completed step(s) for append continuation`);
  }

  /**
   * Clear queue and results.
   * NOTE: Only called from tests (production code uses clearQueue() instead).
   */
  clear(): void {
    this.stop();
    this.state.prompts = [];
    this.state.results = [];
    this.emitStateChange();
    Log.debug("Queue cleared");
  }

  /**
   * Get current queue state
   */
  getState(): QueueState {
    return {
      ...this.state,
      ...this.stateMachine.getSnapshot(),
    };
  }

  /**
   * Check if queue has more prompts to execute
   */
  hasNext(): boolean {
    return this.state.currentIndex < this.state.prompts.length;
  }

  /**
   * Get current prompt
   */
  getCurrentPrompt(): PromptItem | null {
    if (!this.hasNext()) {
      return null;
    }
    return this.state.prompts[this.state.currentIndex];
  }

  /**
   * Mark current prompt as sent
   * Note: Does NOT automatically move to next prompt. WorkflowOrchestrator handles
   * end condition evaluation and decides when to move to next prompt (including retries).
   */
  async markCurrentAsSent(): Promise<void> {
    if (!this.hasNext()) {
      return;
    }

    const currentResult = this.state.results[this.state.currentIndex];
    currentResult.status = STEP_STATUS.SENT;
    currentResult.timestamp = new Date();

    this.emitStateChange();

    // WorkflowOrchestrator handles end condition evaluation and workflow progression
    // Do NOT set up timers or automatically move to next prompt here
  }

  /**
   * Mark current prompt as completed and move to next
   * Note: This only updates state. WorkflowOrchestrator's loop handles actual execution progression.
   */
  async completeCurrentAndMoveNext(): Promise<void> {
    if (!this.hasNext()) {
      return;
    }

    const currentResult = this.state.results[this.state.currentIndex];

    currentResult.status = STEP_STATUS.COMPLETED;
    currentResult.timestamp = new Date();

    // Mark prompt as completed (sets completedAt on _runtime and updates in-memory index)
    this.markPromptCompleted(this.state.currentIndex);

    // Reset retry count when successfully moving to next prompt
    this.resetRetryCount();

    this.state.currentIndex++;
    this.emitStateChange();

    // Update working file with new currentIndex and completedPrompts
    await this.updateWorkingFile();
  }

  /**
   * Mark current prompt as failed and advance past it.
   * The failed prompt keeps FAILED status for display; currentIndex moves to the next prompt.
   */
  markCurrentAsFailed(error: string): void {
    if (!this.hasNext()) {
      return;
    }

    const index = this.state.currentIndex;
    const currentResult = this.state.results[index];
    currentResult.status = STEP_STATUS.FAILED;
    currentResult.error = error;
    currentResult.timestamp = new Date();

    // Record terminal state and advance past the failed prompt
    const prompt = this.state.prompts[index];
    if (prompt) {
      const now = Date.now();
      prompt._runtime = {
        startedAt: prompt._runtime?.startedAt ?? now,
        ...prompt._runtime,
        completedAt: now,
        terminalStatus: "failed",
      };
    }
    this.state.completedIndices.add(String(index));
    this.state.currentIndex++;

    this.stateMachine.fail();
    this.commitRuntimeTransition().catch((err) =>
      Log.error("Failed to update working file after error:", err)
    );

    Log.error(`FlightPath: Prompt ${index + 1} failed: ${error}`);
    Log.error(`FlightPath: Execution failed at prompt ${index + 1}: ${error}`);
  }

  /**
   * Get execution progress
   */
  getProgress(): { current: number; total: number; percentage: number } {
    const total = this.state.prompts.length;
    const current = this.state.currentIndex;
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

    return { current, total, percentage };
  }

  /**
   * Get completed prompts count
   */
  getCompletedCount(): number {
    return this.state.results.filter(
      (result) => result.status === STEP_STATUS.COMPLETED
    ).length;
  }

  /**
   * Get the current workflow name
   * Returns undefined if no workflow is loaded
   */
  getWorkflowName(): string | undefined {
    return this.state.workflowName;
  }

  /**
   * Get the complete workflow file with workflow-level properties.
   * Used by PropertyResolver to apply three-tier property precedence.
   *
   * @returns Complete PromptFile with workflow-level properties, or empty object if not loaded
   */
  getWorkflowFile(): PromptFile {
    // Return the stored workflow file, or an empty object with just prompts if not available
    return this.workflowFile || { prompts: this.state.prompts };
  }

  /**
   * Update workflow-level property in the cached workflow file.
   * Ensures property resolution uses the latest values during execution.
   */
  updateWorkflowProperty(property: string, value: unknown): void {
    if (!this.workflowFile) {
      this.workflowFile = { prompts: this.state.prompts };
    }

    if (value === undefined) {
      delete (this.workflowFile as any)[property];
      return;
    }

    (this.workflowFile as any)[property] = value;
  }

  /**
   * Get failed prompts count
   * @internal Test-only method — not used in production code paths.
   */
  getFailedCount(): number {
    return this.state.results.filter(
      (result) => result.status === STEP_STATUS.FAILED
    ).length;
  }

  /**
   * Check if current prompt can be retried
   */
  canRetry(prompt: PromptItem): boolean {
    const retryPrompt = getEffectiveRetryPrompt(prompt.endCondition);
    if (!retryPrompt) {
      return false;
    }

    const maxRetries = getEffectiveMaxRetries(prompt.endCondition);

    // -1 means unlimited retries
    if (maxRetries === -1) {
      return true;
    }

    return this.currentRetryCount < maxRetries;
  }

  /**
   * Get effective maxRetries for current prompt (including defaults)
   */
  getEffectiveMaxRetries(prompt: PromptItem): number {
    return getEffectiveMaxRetries(prompt.endCondition);
  }

  /**
   * Get effective retry prompt for current prompt (including defaults)
   */
  getEffectiveRetryPrompt(prompt: PromptItem): string | undefined {
    return getEffectiveRetryPrompt(prompt.endCondition);
  } /**
   * Increment retry count for current prompt
   */
  incrementRetryCount(): void {
    this.currentRetryCount++;

    // Update result with retry count
    if (this.hasNext()) {
      const currentResult = this.state.results[this.state.currentIndex];
      currentResult.retryCount = this.currentRetryCount;
      this.emitStateChange();
    }
  }

  /**
   * Reset retry count (call when moving to next prompt or on success)
   */
  resetRetryCount(): void {
    this.currentRetryCount = 0;
  }

  /**
   * Get current retry count
   */
  getCurrentRetryCount(): number {
    return this.currentRetryCount;
  }

  /**
   * Mark workflow as completed (called by WorkflowOrchestrator)
   */
  async markCompleted(): Promise<void> {
    this.stateMachine.complete();
    await this.commitRuntimeTransition();
  }

  /**
   * Mark workflow as errored (called by WorkflowExecutor).
   * If the current prompt was actively in-progress (SENT/RUNNING), advances past it
   * so that resume/run continues from the next prompt.
   */
  async markErrored(): Promise<void> {
    this.failCurrentPromptIfInProgress();
    this.stateMachine.fail();
    await this.commitRuntimeTransition();
  }

  /**
   * Start execution time tracking
   */
  startExecutionTimer(): void {
    if (this.stateMachine.startExecutionTimer()) {
      this.syncFromStateMachine();
    }
  }

  /**
   * Get active execution time (excluding paused duration)
   */
  getActiveExecutionTime(): number {
    return this.stateMachine.getActiveExecutionTime();
  }

  /**
   * Mark a prompt as completed.
   * Sets completedAt on the prompt's own _runtime (source of truth) and
   * updates the in-memory fast-lookup index keyed by prompt index.
   */
  markPromptCompleted(index: number): void {
    const prompt = this.state.prompts[index];
    if (prompt) {
      prompt._runtime = {
        ...prompt._runtime,
        startedAt: prompt._runtime?.startedAt ?? Date.now(),
        completedAt: Date.now(),
      };
    }
    // Update in-memory fast-lookup cache (key = prompt index as string)
    this.state.completedIndices.add(String(index));
  }

  /**
   * Reload prompt file and merge new prompts into queue
   * @param filePath Path to the .flightpath.json file
   * @param parser PromptFileParser instance for reloading
   * @param maxQueueSize Maximum allowed queue size (0 = unlimited)
   * @returns Number of new prompts added, or -1 if reload failed
   */
  /**
   * Persist partial runtime metadata updates for a specific prompt.
   * Merges `updates` into the prompt's existing `_runtime` and flushes to the working file.
   * This is the single write path for storing responseText and other per-prompt runtime data.
   *
   * @param promptIndex 0-based prompt index
   * @param updates Partial metadata to merge into existing _runtime
   */
  async persistRuntimeMetadata(
    promptIndex: number,
    updates: Partial<import("../types/FlightPathTypes").PromptRuntimeMetadata>
  ): Promise<void> {
    const prompt = this.state.prompts[promptIndex];
    if (!prompt) {
      return;
    }

    prompt._runtime = {
      startedAt: Date.now(),
      ...prompt._runtime,
      ...updates,
    };

    await this.updateWorkingFile();
  }

  /**
   * Reload and merge queue from working file (for Dynamic Queue feature)
   * This method reads the working file, identifies new prompts, and appends them
   * @param parser PromptFileParser instance (no longer needed, kept for compatibility)
   * @param maxQueueSize Maximum queue size (0 = unlimited)
   * @returns Number of new prompts added (-1 if error)
   */
  async reloadAndMergeQueue(
    filePath: string, // This is now ignored - we always use working file
    parser: { parsePromptFile(filePath: string): Promise<PromptFile | null> }, // PromptFileParser-compatible interface
    maxQueueSize: number = 0
  ): Promise<number> {
    // Use working file if available, otherwise fall back to provided filePath
    const targetPath = this.state.workingFilePath || filePath;

    // 1. Reload file with validation
    let reloadedFile;
    try {
      if (this.state.workingFilePath) {
        // Read working file directly (already in JSON format)
        reloadedFile = await this.readWorkingFile(targetPath);
      } else {
        // Fall back to parsing original file (legacy path)
        reloadedFile = await parser.parsePromptFile(targetPath);
      }

      if (!reloadedFile || !reloadedFile.prompts) {
        throw new Error("Invalid prompt file structure");
      }
    } catch (error) {
      // Invalid JSON - log error and continue with current queue
      Log.error("Failed to reload queue - invalid JSON", error as Error);
      Log.error(
        "FlightPath: Queue file has invalid JSON. Continuing with current queue."
      );
      return -1;
    }

    const reloadedPrompts = reloadedFile.prompts;

    // 2. Identify new prompts (not in completedIndices AND not already in current queue)
    const newPrompts: PromptItem[] = [];
    const currentPromptHashes = new Set<string>();

    // Build set of content hashes for prompts currently in queue
    for (const existingPrompt of this.state.prompts) {
      const hash = hashPromptContent(existingPrompt.prompt);
      currentPromptHashes.add(hash);
    }

    // Find truly new prompts (not completed, not already in queue)
    for (const prompt of reloadedPrompts) {
      // Skip if already completed (per-prompt _runtime.completedAt is authoritative)
      if (prompt._runtime?.completedAt !== undefined) {
        continue;
      }

      // Skip if already in current pending queue (by content hash)
      const hash = hashPromptContent(prompt.prompt);
      if (currentPromptHashes.has(hash)) {
        continue;
      }

      // This is a truly new prompt
      newPrompts.push(prompt);
    }

    if (newPrompts.length === 0) {
      Log.trace("Queue reload: No new prompts found");
      return 0;
    }

    // 3. Check queue size limit (if not unlimited)
    const newQueueSize = this.state.prompts.length + newPrompts.length;
    if (maxQueueSize > 0 && newQueueSize > maxQueueSize) {
      Log.warn(
        `Queue size limit reached: ${newQueueSize} > ${maxQueueSize}. Cannot add ${newPrompts.length} new prompts.`
      );
      Log.warn(
        `FlightPath: Queue limit reached (${this.state.prompts.length}/${maxQueueSize} prompts). Cannot add more prompts. Consider increasing maxQueueSize in settings.`
      );
      return -1;
    }

    // 4. Append new prompts to current queue
    this.state.prompts.push(...newPrompts);

    // Add new results for the new prompts
    const newResults: PromptResult[] = newPrompts.map((prompt) => ({
      prompt: prompt.prompt,
      status: STEP_STATUS.PENDING,
      timestamp: new Date(),
    }));
    this.state.results.push(...newResults);

    // 5. Update reload tracking
    this.state.queueExtensions++;
    this.state.lastReloadTime = Date.now();

    this.emitStateChange();

    // 6. Update working file with merged queue (if exists)
    await this.updateWorkingFile();

    Log.info(
      `Queue extended: +${newPrompts.length} prompts added (total: ${this.state.prompts.length})`
    );

    return newPrompts.length;
  }

  /**
   * Get queue extension statistics
   * @internal Test-only method — not used in production code paths.
   */
  getQueueExtensionStats(): {
    queueExtensions: number;
    currentSize: number;
    lastReloadTime?: number;
  } {
    return {
      queueExtensions: this.state.queueExtensions,
      currentSize: this.state.prompts.length,
      lastReloadTime: this.state.lastReloadTime,
    };
  }

  /**
   * Merge prompts from disk into the in-memory queue.
   * Identifies new prompts by content hash, adopts disk ordering as source of truth,
   * and preserves existing results for prompts already in memory.
   *
   * @param diskPrompts Prompts read from the working file on disk
   * @returns Array of newly-discovered prompts (empty if none)
   */
  private mergeDiskPrompts(diskPrompts: PromptItem[]): PromptItem[] {
    // Build map of prompts we have in memory (by content hash)
    const memoryPromptMap = new Map<string, PromptItem>();
    for (const prompt of this.state.prompts) {
      const hash = hashPromptContent(prompt.prompt);
      memoryPromptMap.set(hash, prompt);
    }

    // Find prompts on disk that don't exist in memory
    const newPromptsFromDisk: PromptItem[] = [];
    for (const diskPrompt of diskPrompts) {
      const hash = hashPromptContent(diskPrompt.prompt);
      if (!memoryPromptMap.has(hash)) {
        newPromptsFromDisk.push(diskPrompt);
      }
    }

    if (newPromptsFromDisk.length === 0) {
      return [];
    }

    // CRITICAL: Use disk order as source of truth
    // This preserves the insertion positions chosen by MCP (e.g., "next" vs "end")
    // But preserve in-memory state for existing prompts — specifically _runtime (session IDs,
    // completedAt, etc.) that may not have been persisted to disk yet at the time of this merge.
    this.state.prompts = diskPrompts.map((diskPrompt) => {
      const hash = hashPromptContent(diskPrompt.prompt);
      const memoryPrompt = memoryPromptMap.get(hash);
      return memoryPrompt ?? diskPrompt;
    });

    // Rebuild results array to match new prompt order
    // Preserve existing results where we have them, add pending for new prompts
    const newResults: PromptResult[] = diskPrompts.map((prompt) => {
      const hash = hashPromptContent(prompt.prompt);

      // Find existing result for this prompt
      const existingResultIndex = this.state.results.findIndex((r) => {
        const resultHash = hashPromptContent(r.prompt);
        return resultHash === hash || r.prompt === prompt.prompt;
      });

      if (existingResultIndex >= 0) {
        // Use existing result (preserves completion status)
        return this.state.results[existingResultIndex];
      } else {
        // New prompt - create pending result
        return {
          prompt: prompt.prompt,
          status: STEP_STATUS.PENDING,
          timestamp: new Date(),
        };
      }
    });

    this.state.results = newResults;
    return newPromptsFromDisk;
  }

  /**
   * Merge prompts from working file disk into current queue (for MCP appends during execution)
   * This preserves execution state (currentIndex, status, results) while adding new prompts
   * @returns Number of new prompts merged (-1 if error)
   */
  public async mergePromptsFromDisk(): Promise<number> {
    if (!this.state.workingFilePath) {
      Log.warn("mergePromptsFromDisk: No working file path set");
      return -1;
    }

    try {
      // Read working file from disk
      const workingFile = await this.readWorkingFile(
        this.state.workingFilePath
      );
      const diskPrompts = workingFile.prompts || [];

      Log.info(
        `mergePromptsFromDisk: Disk has ${diskPrompts.length} prompts, memory has ${this.state.prompts.length} prompts`
      );

      const newPromptsFromDisk = this.mergeDiskPrompts(diskPrompts);

      if (newPromptsFromDisk.length === 0) {
        Log.info("mergePromptsFromDisk: No new prompts found");
        return 0;
      }

      Log.info(
        `mergePromptsFromDisk: Found ${newPromptsFromDisk.length} new prompts from disk (MCP append), merging into queue`
      );

      // Update queue extension tracking
      this.state.queueExtensions++;
      this.state.lastReloadTime = Date.now();

      // Emit state change so dashboard updates
      this.emitStateChange();

      Log.info(
        `mergePromptsFromDisk: Successfully merged. New queue size: ${this.state.prompts.length}`
      );

      return newPromptsFromDisk.length;
    } catch (error) {
      Log.error(
        "mergePromptsFromDisk: Failed to read working file",
        error as Error
      );
      return -1;
    }
  }

  /**
   * Append prompts to the current queue without clearing state
   * This method now uses working file operations for persistence
   * @param prompts - Prompts to append
   * @param source - Description of append source (e.g., filename or "MCP")
   * @param position - Where to insert prompts:
   *   - QUEUE_POSITION.NEXT: After current prompt (paused/running)
   *   - QUEUE_POSITION.BEFORE_CURRENT: Before current prompt (stopped/idle)
   *   - QUEUE_POSITION.END: At end of queue (default)
   * @param willRunImmediately - When true, skip the COMPLETED→STOPPED
   *   transition because the caller will immediately start execution.
   *   This avoids a race where the transient STOPPED state triggers
   *   retirement before the RUNNING state is reached.
   * @throws Error if queue is in invalid state for appending
   */
  public async appendPrompts(
    prompts: PromptItem[],
    source: string = "User append",
    position: QueuePosition = QUEUE_POSITION.END,
    willRunImmediately: boolean = false
  ): Promise<void> {
    if (!this.canAppend()) {
      throw new Error("Cannot append: Queue is in cancelled or error state");
    }

    // Serialize state mutations + file write through WorkingFileManager's operation queue
    await this.workingFileManager.runInQueue(async () => {
      // Calculate insert index based on position
      let insertIndex: number;
      if (position === QUEUE_POSITION.NEXT) {
        // Insert after current prompt
        insertIndex = this.state.currentIndex + 1;
      } else if (position === QUEUE_POSITION.BEFORE_CURRENT) {
        // Insert before current prompt (for stopped/idle states)
        insertIndex = this.state.currentIndex;
      } else {
        // QUEUE_POSITION.END - append to end
        insertIndex = this.state.prompts.length;
      }

      // Insert prompts at the specified position
      this.state.prompts.splice(insertIndex, 0, ...prompts);

      // Create new results for the inserted prompts
      const newResults: PromptResult[] = prompts.map((prompt) => ({
        prompt: prompt.prompt,
        status: STEP_STATUS.PENDING,
        timestamp: new Date(),
      }));

      // Insert results at the same position
      this.state.results.splice(insertIndex, 0, ...newResults);

      // Auto-start behavior based on current state:
      // - COMPLETED + willRunImmediately: Stay COMPLETED (caller will start execution)
      // - COMPLETED: Set to STOPPED (user can manually Resume to continue)
      // - IDLE: Stay IDLE (user hasn't started yet, don't auto-start)
      // - PAUSED: Stay PAUSED (user explicitly paused, don't auto-resume)
      // - RUNNING: Already running, no change needed
      const previousStatus = this.stateMachine.status;
      if (
        this.stateMachine.status === EXECUTION_STATES.COMPLETED &&
        !willRunImmediately
      ) {
        Log.info(
          `appendPrompts: Setting to STOPPED (appended to COMPLETED queue, ${this.state.completedIndices.size} prompts previously completed, user can Resume)`
        );
        this.stateMachine.reopenForContinuation();
        this.syncFromStateMachine();
      } else {
        Log.info(
          `appendPrompts: NOT changing state (current: ${previousStatus}, willRunImmediately: ${willRunImmediately}, completed count: ${this.state.completedIndices.size})`
        );
      }

      this.emitStateChange();

      // Update working file if it exists (direct call since we're already in the operation queue)
      Log.info(
        `About to update working file. Path: ${this.state.workingFilePath}, Total prompts: ${this.state.prompts.length}, Insert position: ${position} (index: ${insertIndex})`
      );
      await this.workingFileManager.updateWorkingFileDirect();
      Log.info(
        `Working file updated. Appended ${prompts.length} prompts from: ${source} at position: ${position}`
      );
    });
  }

  /**
   * Check if queue can accept appended prompts
   * @returns true if queue state allows appending
   */
  public canAppend(): boolean {
    const invalidStates: string[] = [
      EXECUTION_STATES.CANCELLING,
      EXECUTION_STATES.ERROR,
    ];
    return !invalidStates.includes(this.stateMachine.status);
  }

  // ==================== Working File Operations (delegated to WorkingFileManager) ====================

  /**
   * Create working file from original prompt file
   * @param nameForFile Display name or file path used to generate the working file's filename
   * @param prompts Prompts to store in working file
   * @param workspaceFolderPath Path to the current workspace folder root
   * @param originalFilePath The true source file path (if any). Only set for file-based workflows;
   *   leave undefined for ephemeral/dashboard-created workflows so the save dialog defaults correctly.
   * @returns Path to created working file
   */
  public async createWorkingFile(
    nameForFile: string,
    prompts: PromptItem[],
    workspaceFolderPath: string,
    originalFilePath?: string
  ): Promise<string> {
    // Compute workflow name and store back into state so loadPrompts preserves it
    const computedWorkflowName =
      this.state.workflowName || PromptQueue.extractWorkflowName(nameForFile);
    this.state.workflowName = computedWorkflowName;

    const workingFilePath = await this.workingFileManager.createWorkingFile(
      nameForFile,
      prompts,
      workspaceFolderPath,
      computedWorkflowName,
      originalFilePath
    );

    // Update queue state with working file path
    this.state.workingFilePath = workingFilePath;
    this.emitStateChange();

    return workingFilePath;
  }

  /**
   * Read working file
   * @param workingFilePath Path to working file
   * @returns Parsed working file
   */
  public async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.workingFileManager.readWorkingFile(workingFilePath);
  }

  /**
   * Update working file with current queue state
   * This is called after prompt completion, append, or any queue modification
   * @param skipMerge If true, writes memory state directly without checking for MCP changes (used for deletes/updates)
   */
  public async updateWorkingFile(skipMerge: boolean = false): Promise<void> {
    return this.workingFileManager.updateWorkingFile(skipMerge);
  }

  /**
   * Get runtime state for workflow-level finalPrompt execution.
   */
  public getFinalPromptRuntime(): FinalPromptRuntimeState | undefined {
    return this.finalPromptRuntime ? { ...this.finalPromptRuntime } : undefined;
  }

  /**
   * Persist runtime state for workflow-level finalPrompt execution.
   * responseTexts accumulated via storeFinalPromptResponseText are preserved
   * when the incoming runtime does not explicitly include them.
   */
  public async setFinalPromptRuntime(
    runtime: FinalPromptRuntimeState | undefined
  ): Promise<void> {
    if (runtime) {
      const existingResponseTexts = this.finalPromptRuntime?.responseTexts;
      this.finalPromptRuntime = {
        ...runtime,
        responseTexts: runtime.responseTexts ?? existingResponseTexts,
      };
    } else {
      this.finalPromptRuntime = undefined;
    }
    await this.updateWorkingFile();
  }

  /**
   * Store the response text from a single finalPrompt loop execution.
   * Merges into the existing finalPromptRuntime.responseTexts array and flushes to disk.
   *
   * @param loopIndex 0-based loop index (from ExecutionTarget.loopIndex)
   * @param text Plain-text AI response from this loop
   */
  public async storeFinalPromptResponseText(
    loopIndex: number,
    text: string
  ): Promise<void> {
    if (!this.finalPromptRuntime) {
      return;
    }
    const responseTexts = [...(this.finalPromptRuntime.responseTexts ?? [])];
    responseTexts[loopIndex] = text;
    this.finalPromptRuntime = { ...this.finalPromptRuntime, responseTexts };
    await this.updateWorkingFile();
  }

  /**
   * Get all finalPrompt loop response texts accumulated so far.
   * Returns a copy indexed by loopIndex (0-based); missing loops are empty strings.
   */
  public getFinalPromptResponseTexts(): string[] {
    return [...(this.finalPromptRuntime?.responseTexts ?? [])];
  }

  /**
   * Update workflow-level properties in the working file (atomic + serialized).
   */
  public async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    return this.workingFileManager.updateWorkingFileProperties(
      properties,
      options
    );
  }

  /**
   * Emit state change event
   */
  private emitStateChange(): void {
    this.syncFromStateMachine();
    this.onStateChanged.fire(this.getState());
  }

  /**
   * Copy status-related fields from the state machine into this.state.
   * Call after every named state machine transition so this.state stays current.
   */
  private syncFromStateMachine(): void {
    this.state.status = this.stateMachine.status;
    this.state.stopped = this.stateMachine.stopped;
    this.state.startTime = this.stateMachine.startTime;
    this.state.pausedTime = this.stateMachine.pausedTime;
    this.state.totalPausedDuration = this.stateMachine.totalPausedDuration;
  }

  /**
   * Copy status-related fields from this.state into the state machine.
   * Call after full state resets (clearQueue, loadPrompts, restoreFromWorkingFile)
   * so the state machine reflects the reconstructed state.
   */
  private syncToStateMachine(): void {
    this.stateMachine.restore({
      status: this.state.status,
      stopped: this.state.stopped,
      startTime: this.state.startTime,
      pausedTime: this.state.pausedTime,
      totalPausedDuration: this.state.totalPausedDuration,
    });
  }

  /**
   * Update an existing prompt in the queue
   * @param index - Prompt index (0-based)
   * @param updates - Partial PromptItem updates to apply
   * @throws Error if index is out of range
   */
  public async updatePrompt(
    index: number,
    updates: Partial<PromptItem>
  ): Promise<void> {
    if (index < 0 || index >= this.state.prompts.length) {
      throw new Error(`Invalid prompt index: ${index}`);
    }

    // Merge updates into existing prompt
    this.state.prompts[index] = {
      ...this.state.prompts[index],
      ...updates,
    };

    // Persist to working file (skip merge to avoid undoing the update)
    await this.updateWorkingFile(true);

    // Emit state change
    this.emitStateChange();

    Log.debug(`Updated prompt at index ${index}`);
  }

  /**
   * Delete a prompt from the queue
   * @param index - Prompt index (0-based)
   * @throws Error if index is out of range or if deleting current/completed prompt
   */
  public async deletePrompt(index: number): Promise<void> {
    if (index < 0 || index >= this.state.prompts.length) {
      throw new Error(`Invalid prompt index: ${index}`);
    }

    // Don't allow deleting the prompt that is actively being processed.
    // When the workflow is idle, stopped, or completed nothing is executing, so
    // any non-completed prompt may be deleted freely.
    const isActivelyExecuting =
      this.stateMachine.status === EXECUTION_STATES.RUNNING ||
      this.stateMachine.status === EXECUTION_STATES.PAUSED ||
      this.stateMachine.status === EXECUTION_STATES.CANCELLING;

    if (isActivelyExecuting && index === this.state.currentIndex) {
      throw new Error("Cannot delete the currently executing prompt");
    }

    // Don't allow deleting completed prompts
    if (this.state.completedIndices.has(String(index))) {
      throw new Error("Cannot delete a completed prompt");
    }

    // Remove the prompt
    this.state.prompts.splice(index, 1);

    // Update currentIndex if deletion affects it
    if (index < this.state.currentIndex) {
      this.state.currentIndex--;
    }

    // Update results array to match
    if (this.state.results.length > index) {
      this.state.results.splice(index, 1);
    }

    // Persist to working file (skip merge to avoid undoing the delete)
    await this.updateWorkingFile(true);

    // Emit state change
    this.emitStateChange();

    Log.debug(`Deleted prompt at index ${index}`);
  }

  /**
   * Update workflow name in working file
   * @param workflowName - New workflow name
   */
  public async updateWorkflowName(workflowName: string): Promise<void> {
    // Update in-memory state (always allow this)
    this.state.workflowName = workflowName;

    // Update working file if it exists
    // If no working file yet (brand new workflow), the name will be included when the working file is created
    if (this.state.workingFilePath) {
      await this.updateWorkingFile(true);
    }

    this.emitStateChange();
    Log.debug(`Updated workflow name to: ${workflowName}`);
  }

  /**
   * Move the execution start position to a given index.
   * - Rewind (toIndex < currentIndex): clears _runtime and resets results to PENDING for all prompts >= toIndex.
   * - Skip-ahead (toIndex > currentIndex): marks prompts currentIndex..toIndex-1 as SKIPPED.
   */
  async setStartPosition(toIndex: number): Promise<void> {
    const currentIndex = this.state.currentIndex;
    if (toIndex === currentIndex) return;

    if (toIndex < currentIndex) {
      this.state.prompts = this.state.prompts.map((prompt, index) => {
        if (index < toIndex) return prompt;
        const { _runtime, ...rest } = prompt;
        void _runtime;
        return rest;
      });
      this.state.results = this.state.results.map((result, index) =>
        index < toIndex ? result : { ...result, status: STEP_STATUS.PENDING }
      );
    } else {
      this.state.results = this.state.results.map((result, index) =>
        index >= currentIndex && index < toIndex
          ? { ...result, status: STEP_STATUS.SKIPPED }
          : result
      );
      this.state.prompts = this.state.prompts.map((prompt, index) => {
        if (index < currentIndex || index >= toIndex) return prompt;
        return {
          ...prompt,
          _runtime: {
            ...(prompt._runtime ?? { startedAt: Date.now() }),
            completedAt: Date.now(),
          },
        };
      });
    }

    this.state.currentIndex = toIndex;
    this.stateMachine.reset();
    this.syncFromStateMachine();
    this.state.completedIndices = new Set<string>(
      Array.from({ length: toIndex }, (_, i) => String(i))
    );

    this.emitStateChange();
    await this.updateWorkingFile();
  }

  /**
   * Reorder the pending (not-yet-executed) prompts.
   * @param newPendingOrder Positions within the current pending slice (0-based)
   *   in the desired new order. These are slice-relative indices, not absolute
   *   indices into the full prompts array. Using absolute indices would break on
   *   the second reorder because state.prompts has already been mutated.
   */
  async reorderPendingPrompts(newPendingOrder: number[]): Promise<void> {
    const currentIndex = this.state.currentIndex;
    const donePrompts = this.state.prompts.slice(0, currentIndex);
    const doneResults = this.state.results.slice(0, currentIndex);
    const pendingPrompts = this.state.prompts.slice(currentIndex);
    const pendingResults = this.state.results.slice(currentIndex);
    const newPending = newPendingOrder.map((i) => pendingPrompts[i]);
    const newPendingResults = newPendingOrder.map((i) => pendingResults[i]);
    this.state.prompts = [...donePrompts, ...newPending];
    this.state.results = [...doneResults, ...newPendingResults];
    this.emitStateChange();
    await this.updateWorkingFile();
  }

  /**
   * Replace all prompts with the state restored by an undo/redo operation.
   * Preserves completed results (0..currentIndex-1); resets pending slots to PENDING.
   * Does NOT emit a state change event — the webview already has the correct state.
   * The working file watcher ignores changes in non-running states, so no re-broadcast occurs.
   */
  public async syncPromptsForUndoRedo(newPrompts: PromptItem[]): Promise<void> {
    const currentIndex = this.state.currentIndex;
    this.state.prompts = newPrompts;

    // Preserve completed results; reset pending slots to PENDING
    const completedResults = this.state.results.slice(0, currentIndex);
    const pendingResults = newPrompts.slice(currentIndex).map((p) => ({
      prompt: p.prompt,
      status: STEP_STATUS.PENDING,
      timestamp: new Date(),
    }));
    this.state.results = [...completedResults, ...pendingResults];

    // Persist to working file (skip merge — we know exactly what we want)
    await this.updateWorkingFile(true);

    Log.debug(
      `[PromptQueue] syncPromptsForUndoRedo: ${newPrompts.length} prompts, currentIndex=${currentIndex}`
    );
  }

  /**
   * Load working file from path
   * @param filePath - Path to working file
   */
  public async loadWorkingFile(filePath: string): Promise<void> {
    await this.restoreFromWorkingFile(filePath);
    Log.debug(`Loaded working file: ${filePath}`);
  }
}
