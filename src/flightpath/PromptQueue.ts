import * as vscode from "vscode";
import {
  PromptItem,
  QueueState,
  PromptResult,
  EXECUTION_STATES,
  STEP_STATUS,
} from "../types/FlightPathTypes";

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
  private executionTimer?: NodeJS.Timeout;
  private isPaused: boolean = false;
  private currentRetryCount: number = 0; // Track retry attempts for current prompt

  // Public event for state changes
  public readonly onDidChangeState: vscode.Event<QueueState> =
    this.onStateChanged.event;

  constructor() {
    this.state = {
      currentIndex: 0,
      status: "idle",
      prompts: [],
      results: [],
      stopped: false,
    };
  }

  /**
   * Load prompts into the queue
   */
  loadPrompts(prompts: PromptItem[]): void {
    this.state = {
      currentIndex: 0,
      status: "idle",
      prompts: [...prompts],
      results: prompts.map((prompt) => ({
        prompt: prompt.prompt,
        status: "pending",
        timestamp: new Date(),
      })),
      stopped: false, // Reset stopped flag on new load
    };

    this.emitStateChange();
    console.log(`FlightPath: Loaded ${prompts.length} prompts into queue`);
  }

  /**
   * Start queue execution
   */
  async start(): Promise<void> {
    if (this.state.status === "running") {
      console.log("FlightPath: Queue is already running");
      return;
    }

    if (this.state.prompts.length === 0) {
      vscode.window.showWarningMessage("FlightPath: No prompts to execute");
      return;
    }

    this.state.status = "running";
    this.isPaused = false;
    this.state.stopped = false; // Clear stopped flag when starting
    this.emitStateChange();

    console.log("FlightPath: Starting queue execution");
    await this.executeNext();
  }

  /**
   * Pause queue execution
   */
  pause(): void {
    if (this.state.status !== "running") {
      return;
    }

    this.isPaused = true;
    this.state.status = "paused";

    if (this.executionTimer) {
      clearTimeout(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.emitStateChange();
    console.log("FlightPath: Queue execution paused");
  }

  /**
   * Resume queue execution
   */
  async resume(): Promise<void> {
    if (this.state.status !== "paused") {
      return;
    }

    this.isPaused = false;
    this.state.status = "running";
    this.emitStateChange();

    console.log("FlightPath: Resuming queue execution");
    await this.executeNext();
  }

  /**
   * Stop and reset queue
   */
  stop(): void {
    this.isPaused = false;
    this.state.status = "idle";
    this.state.currentIndex = 0;
    this.state.stopped = true; // Set stopped flag

    if (this.executionTimer) {
      clearTimeout(this.executionTimer);
      this.executionTimer = undefined;
    }

    // Mark sent prompts as cancelled (not just pending)
    this.state.results.forEach((result) => {
      if (result.status === "sent") {
        result.status = "cancelled";
      }
    });

    this.emitStateChange();
    console.log("FlightPath: Queue execution stopped");
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
    currentResult.status = "sent";
    currentResult.timestamp = new Date();

    this.emitStateChange();

    // FlightPathManager now handles end condition evaluation and workflow progression
    // Do NOT set up timers or automatically move to next prompt here
  }

  /**
   * Mark current prompt as completed and move to next
   */
  async completeCurrentAndMoveNext(): Promise<void> {
    if (!this.hasNext()) {
      return;
    }

    const currentResult = this.state.results[this.state.currentIndex];
    currentResult.status = "completed";
    currentResult.timestamp = new Date();

    // Reset retry count when successfully moving to next prompt
    this.resetRetryCount();

    this.state.currentIndex++;
    this.emitStateChange();

    // Continue with next prompt if not paused
    if (!this.isPaused && this.state.status === "running") {
      await this.executeNext();
    }
  }

  /**
   * Mark current prompt as failed
   */
  markCurrentAsFailed(error: string): void {
    if (!this.hasNext()) {
      return;
    }

    const currentResult = this.state.results[this.state.currentIndex];
    currentResult.status = "failed";
    currentResult.error = error;
    currentResult.timestamp = new Date();

    this.state.status = "error";
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
   * Execute next prompt in queue
   */
  private async executeNext(): Promise<void> {
    if (this.isPaused || this.state.status !== "running") {
      return;
    }

    if (!this.hasNext()) {
      // All prompts completed
      this.state.status = "completed";
      this.emitStateChange();
      console.log("FlightPath: All prompts completed successfully");
      vscode.window.showInformationMessage(
        "FlightPath: Workflow completed successfully!"
      );
      return;
    }

    const currentPrompt = this.getCurrentPrompt();
    if (!currentPrompt) {
      return;
    }

    console.log(
      `FlightPath: Processing prompt ${this.state.currentIndex + 1}/${this.state.prompts.length}`
    );

    // This is where we would integrate with CopilotIntegration
    // For now, we'll emit an event that the FlightPathManager can handle
    this.emitPromptReady(currentPrompt);
  }

  /**
   * Wait for end condition to be met
   */
  private async waitForEndCondition(prompt: PromptItem): Promise<void> {
    if (!prompt.endCondition) {
      await this.completeCurrentAndMoveNext();
      return;
    }

    // This would integrate with EndConditionEvaluator
    // For now, simulate waiting with a timeout
    const timeout = prompt.endCondition.timeout || 30000;

    this.executionTimer = setTimeout(async () => {
      console.log(
        `FlightPath: End condition timeout reached for prompt ${this.state.currentIndex + 1}`
      );
      // In a real implementation, we would check the actual condition here
      await this.completeCurrentAndMoveNext();
    }, timeout);
  }

  /**
   * Emit state change event
   */
  private emitStateChange(): void {
    this.onStateChanged.fire({ ...this.state });
  }

  /**
   * Emit prompt ready event (to be handled by FlightPathManager)
   */
  private emitPromptReady(prompt: PromptItem): void {
    // This would be handled by FlightPathManager to send to Copilot
    console.log(
      "FlightPath: Prompt ready for execution:",
      prompt.prompt.substring(0, 100) + "..."
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
    return this.state.results.filter((result) => result.status === "completed")
      .length;
  }

  /**
   * Get failed prompts count
   */
  getFailedCount(): number {
    return this.state.results.filter((result) => result.status === "failed")
      .length;
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
}
