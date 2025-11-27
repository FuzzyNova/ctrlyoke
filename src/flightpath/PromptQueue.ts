import * as vscode from "vscode";
import {
  PromptItem,
  QueueState,
  PromptResult,
  EXECUTION_STATES,
  STEP_STATUS,
} from "../types/FlightPathTypes";
import { LoggingUtils } from "../utils/LoggingUtils";
import { isPromptCompleted, hashPromptContent } from "../utils/PromptIdentity";

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
    const config = vscode.workspace.getConfiguration("flightpath");
    return config.get<number>("defaultMaxRetries", 3);
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
    const config = vscode.workspace.getConfiguration("flightpath");
    const defaultPrompt = config.get<string>("defaultRetryPrompt", "");
    return defaultPrompt || undefined;
  }

  // Case 3: Neither specified - no retry prompt
  return undefined;
}

export class PromptQueue {
  private state: QueueState;
  private onStateChanged: vscode.EventEmitter<QueueState> =
    new vscode.EventEmitter<QueueState>();
  private isPaused: boolean = false;
  private currentRetryCount: number = 0; // Track retry attempts for current prompt

  // Public event for state changes
  public readonly onDidChangeState: vscode.Event<QueueState> =
    this.onStateChanged.event;

  constructor() {
    this.state = {
      currentIndex: 0,
      status: EXECUTION_STATES.IDLE,
      prompts: [],
      results: [],
      stopped: false,
      completedIds: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      totalPausedDuration: 0,
    };
  }

  /**
   * Load prompts into the queue
   */
  loadPrompts(prompts: PromptItem[]): void {
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
      completedIds: new Set<string>(),
      totalExecutionTime: 0,
      queueExtensions: 0,
      totalPausedDuration: 0,
    };

    this.emitStateChange();
    console.log(`FlightPath: Loaded ${prompts.length} prompts into queue`);
  }

  /**
   * Start queue execution
   * Note: This only sets the queue state to running. Actual execution
   * is handled by FlightPathManager's startWorkflowExecution method.
   */
  async start(): Promise<void> {
    if (this.state.status === EXECUTION_STATES.RUNNING) {
      console.log("FlightPath: Queue is already running");
      return;
    }

    if (this.state.prompts.length === 0) {
      vscode.window.showWarningMessage("FlightPath: No prompts to execute");
      return;
    }

    this.state.status = EXECUTION_STATES.RUNNING;
    this.isPaused = false;
    this.state.stopped = false; // Clear stopped flag when starting
    this.emitStateChange();

    console.log("FlightPath: Queue state set to running");
  }

  /**
   * Pause queue execution
   */
  pause(): void {
    if (this.state.status !== EXECUTION_STATES.RUNNING) {
      return;
    }

    this.isPaused = true;
    this.state.status = EXECUTION_STATES.PAUSED;
    this.state.pausedTime = Date.now(); // Record when paused

    this.emitStateChange();
    console.log("FlightPath: Queue execution paused");
  }

  /**
   * Resume queue execution
   * Note: This only updates queue state. FlightPathManager checks the state
   * and continues execution from where it was paused.
   */
  async resume(): Promise<void> {
    if (this.state.status !== EXECUTION_STATES.PAUSED) {
      return;
    }

    // Calculate paused duration and add to total
    if (this.state.pausedTime) {
      const pauseDuration = Date.now() - this.state.pausedTime;
      this.state.totalPausedDuration += pauseDuration;
      this.state.pausedTime = undefined;
    }

    this.isPaused = false;
    this.state.status = EXECUTION_STATES.RUNNING;
    this.emitStateChange();

    console.log("FlightPath: Queue state set to running (resumed)");
  }

  /**
   * Stop and reset queue
   */
  stop(): void {
    this.isPaused = false;
    this.state.status = EXECUTION_STATES.IDLE;
    this.state.currentIndex = 0;
    this.state.stopped = true; // Set stopped flag

    // Mark sent prompts as cancelled (not just pending)
    this.state.results.forEach((result) => {
      if (result.status === STEP_STATUS.SENT) {
        result.status = STEP_STATUS.CANCELLED;
      }
    });

    this.emitStateChange();
    console.log("FlightPath: Queue execution stopped");
  }

  /**
   * Restart queue from the beginning
   * Resets index, results, and tracking state while keeping prompts loaded
   */
  restart(): void {
    this.isPaused = false;
    this.state.currentIndex = 0;
    this.state.status = EXECUTION_STATES.IDLE;
    this.state.stopped = false;
    this.currentRetryCount = 0;

    // Reset all results to pending
    this.state.results = this.state.prompts.map((prompt) => ({
      prompt: prompt.prompt,
      status: STEP_STATUS.PENDING,
      timestamp: new Date(),
    }));

    // Reset tracking state
    this.state.completedIds = new Set<string>();
    this.state.totalExecutionTime = 0;
    this.state.queueExtensions = 0;
    this.state.totalPausedDuration = 0;
    this.state.pausedTime = undefined;

    this.emitStateChange();
    console.log("FlightPath: Queue restarted from beginning");
  }

  /**
   * Clear queue and results
   */
  clear(): void {
    this.stop();
    this.state.prompts = [];
    this.state.results = [];
    this.emitStateChange();
    console.log("FlightPath: Queue cleared");
  }

  /**
   * Get current queue state
   */
  getState(): QueueState {
    return { ...this.state };
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
   * Note: Does NOT automatically move to next prompt. FlightPathManager handles
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

    // FlightPathManager now handles end condition evaluation and workflow progression
    // Do NOT set up timers or automatically move to next prompt here
  }

  /**
   * Mark current prompt as completed and move to next
   * Note: This only updates state. FlightPathManager's loop handles actual execution progression.
   */
  async completeCurrentAndMoveNext(): Promise<void> {
    if (!this.hasNext()) {
      return;
    }

    const currentPrompt = this.state.prompts[this.state.currentIndex];
    const currentResult = this.state.results[this.state.currentIndex];

    currentResult.status = STEP_STATUS.COMPLETED;
    currentResult.timestamp = new Date();

    // Mark prompt as completed in the tracking set
    this.markPromptCompleted(currentPrompt);

    // Reset retry count when successfully moving to next prompt
    this.resetRetryCount();

    this.state.currentIndex++;
    this.emitStateChange();
  }

  /**
   * Mark current prompt as failed
   */
  markCurrentAsFailed(error: string): void {
    if (!this.hasNext()) {
      return;
    }

    const currentResult = this.state.results[this.state.currentIndex];
    currentResult.status = STEP_STATUS.FAILED;
    currentResult.error = error;
    currentResult.timestamp = new Date();

    this.state.status = EXECUTION_STATES.ERROR;
    this.emitStateChange();

    console.error(
      `FlightPath: Prompt ${this.state.currentIndex + 1} failed:`,
      error
    );
    vscode.window.showErrorMessage(
      `FlightPath: Execution failed at prompt ${this.state.currentIndex + 1}: ${error}`
    );
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
   * Get failed prompts count
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
   * Mark workflow as completed (for manual completion by FlightPathManager)
   */
  markCompleted(): void {
    this.state.status = EXECUTION_STATES.COMPLETED;
    this.emitStateChange();
  }

  /**
   * Mark workflow as errored (for manual error handling by FlightPathManager)
   */
  markErrored(): void {
    this.state.status = EXECUTION_STATES.ERROR;
    this.emitStateChange();
  }

  /**
   * Start execution time tracking
   */
  startExecutionTimer(): void {
    this.state.startTime = Date.now();
    this.state.totalPausedDuration = 0;
  }

  /**
   * Get active execution time (excluding paused duration)
   */
  getActiveExecutionTime(): number {
    if (!this.state.startTime) {
      return 0;
    }

    const elapsed = Date.now() - this.state.startTime;
    return elapsed - this.state.totalPausedDuration;
  }

  /**
   * Mark a prompt as completed (add to completedIds set)
   */
  markPromptCompleted(prompt: PromptItem): void {
    // Add both explicit ID and content hash to completed set
    if (prompt.id) {
      this.state.completedIds.add(prompt.id);
    }

    // Always add content hash as fallback
    const hash = hashPromptContent(prompt.prompt);
    this.state.completedIds.add(hash);
  }

  /**
   * Reload prompt file and merge new prompts into queue
   * @param filePath Path to the .flightpath.json file
   * @param parser PromptFileParser instance for reloading
   * @param maxQueueSize Maximum allowed queue size (0 = unlimited)
   * @returns Number of new prompts added, or -1 if reload failed
   */
  async reloadAndMergeQueue(
    filePath: string,
    parser: any, // PromptFileParser instance
    maxQueueSize: number = 0
  ): Promise<number> {
    // 1. Reload file with validation
    let reloadedFile;
    try {
      reloadedFile = await parser.parsePromptFile(filePath);
      if (!reloadedFile || !reloadedFile.prompts) {
        throw new Error("Invalid prompt file structure");
      }
    } catch (error) {
      // Invalid JSON - log error and continue with current queue
      LoggingUtils.error(
        "Failed to reload queue - invalid JSON",
        error as Error
      );
      vscode.window.showErrorMessage(
        "FlightPath: Queue file has invalid JSON. Continuing with current queue."
      );
      return -1;
    }

    const reloadedPrompts = reloadedFile.prompts;

    // 2. Identify new prompts (not in completedIds AND not already in current queue)
    const newPrompts: PromptItem[] = [];
    const currentPromptHashes = new Set<string>();

    // Build set of hashes for prompts currently in queue
    for (const existingPrompt of this.state.prompts) {
      const hash = hashPromptContent(existingPrompt.prompt);
      currentPromptHashes.add(hash);
      if (existingPrompt.id) {
        currentPromptHashes.add(existingPrompt.id);
      }
    }

    // Find truly new prompts (not completed, not already in queue)
    for (const prompt of reloadedPrompts) {
      // Skip if already completed
      if (isPromptCompleted(prompt, this.state.completedIds)) {
        continue;
      }

      // Skip if already in current queue (check by ID and hash)
      const hash = hashPromptContent(prompt.prompt);
      if (
        currentPromptHashes.has(hash) ||
        (prompt.id && currentPromptHashes.has(prompt.id))
      ) {
        continue;
      }

      // This is a truly new prompt
      newPrompts.push(prompt);
    }

    if (newPrompts.length === 0) {
      LoggingUtils.info("Queue reload: No new prompts found");
      return 0;
    }

    // 3. Check queue size limit (if not unlimited)
    const newQueueSize = this.state.prompts.length + newPrompts.length;
    if (maxQueueSize > 0 && newQueueSize > maxQueueSize) {
      LoggingUtils.warn(
        `Queue size limit reached: ${newQueueSize} > ${maxQueueSize}. Cannot add ${newPrompts.length} new prompts.`
      );
      vscode.window.showWarningMessage(
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

    LoggingUtils.info(
      `Queue extended: +${newPrompts.length} prompts added (total: ${this.state.prompts.length})`
    );

    return newPrompts.length;
  }

  /**
   * Get queue extension statistics
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
   * Emit state change event
   */
  private emitStateChange(): void {
    this.onStateChanged.fire({ ...this.state });
  }
}
