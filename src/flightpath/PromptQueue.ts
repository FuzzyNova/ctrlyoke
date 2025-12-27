import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import {
  PromptItem,
  QueueState,
  PromptResult,
  EXECUTION_STATES,
  STEP_STATUS,
  WorkingFile,
  AppendSegment,
} from "../types/FlightPathTypes";
import { Log } from "../utils/Log";
import { isPromptCompleted, hashPromptContent } from "../utils/PromptIdentity";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";

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
  private onStateChanged: vscode.EventEmitter<QueueState> =
    new vscode.EventEmitter<QueueState>();
  private isPaused: boolean = false;
  private currentRetryCount: number = 0; // Track retry attempts for current prompt
  private operationQueue: Promise<void> = Promise.resolve(); // Serialize all file operations

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
      appendSegments: [],
    };
  }

  /**
   * Load prompts into the queue
   * @param prompts Prompts to load
   * @param workingFilePath Optional path to working file (source of truth)
   */
  loadPrompts(prompts: PromptItem[], workingFilePath?: string): void {
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
      appendSegments: [],
      workingFilePath,
    };

    this.emitStateChange();
    Log.info(`Loaded ${prompts.length} prompts into queue`);
  }

  /**
   * Start queue execution
   * Note: This only sets the queue state to running. The state change event
   * triggers FlightPathManager.onQueueStateChanged() which starts actual execution.
   */
  async start(): Promise<void> {
    if (this.state.status === EXECUTION_STATES.RUNNING) {
      Log.info("Queue is already running");
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

    Log.info("Queue state set to running");
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
    Log.info("Queue execution paused");
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

    Log.info("Queue state set to running (resumed)");
  }

  /**
   * Stop and reset queue
   * Sets state to CANCELLING - call confirmedStopped() once process actually exits
   */
  stop(): void {
    this.isPaused = false;
    this.state.status = EXECUTION_STATES.CANCELLING; // Cancelling, not stopped yet
    this.state.stopped = true; // Set stopped flag for executor loop

    // Mark sent prompts as cancelled (not just pending)
    this.state.results.forEach((result) => {
      if (result.status === STEP_STATUS.SENT) {
        result.status = STEP_STATUS.CANCELLED;
      }
    });

    this.emitStateChange();
    Log.info("Queue cancellation requested (waiting for process to exit)");
  }

  /**
   * Confirm that execution has fully stopped (process exited)
   * Call this after the CLI process actually terminates
   */
  confirmedStopped(): void {
    if (this.state.status === EXECUTION_STATES.CANCELLING) {
      this.state.status = EXECUTION_STATES.IDLE;
      this.state.currentIndex = 0;
      this.emitStateChange();
      Log.info("Queue execution fully stopped (process exited)");
    }
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
    Log.info("Queue restarted from beginning");
  }

  /**
   * Clear queue and results
   */
  clear(): void {
    this.stop();
    this.state.prompts = [];
    this.state.results = [];
    this.emitStateChange();
    Log.info("Queue cleared");
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

    // Update working file with new currentIndex and completedPrompts
    await this.updateWorkingFile();
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

    // Update working file with failed status
    this.updateWorkingFile().catch((err) =>
      console.error("Failed to update working file after error:", err)
    );

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
  async markCompleted(): Promise<void> {
    this.state.status = EXECUTION_STATES.COMPLETED;
    this.emitStateChange();

    // Update working file with completed status
    await this.updateWorkingFile();
  }

  /**
   * Mark workflow as errored (for manual error handling by FlightPathManager)
   */
  async markErrored(): Promise<void> {
    this.state.status = EXECUTION_STATES.ERROR;
    this.emitStateChange();

    // Update working file with error status
    await this.updateWorkingFile();
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
  /**
   * Reload and merge queue from working file (for Dynamic Queue feature)
   * This method reads the working file, identifies new prompts, and appends them
   * @param parser PromptFileParser instance (no longer needed, kept for compatibility)
   * @param maxQueueSize Maximum queue size (0 = unlimited)
   * @returns Number of new prompts added (-1 if error)
   */
  async reloadAndMergeQueue(
    filePath: string, // This is now ignored - we always use working file
    parser: any, // PromptFileParser instance (kept for compatibility)
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
      Log.info("Queue reload: No new prompts found");
      return 0;
    }

    // 3. Check queue size limit (if not unlimited)
    const newQueueSize = this.state.prompts.length + newPrompts.length;
    if (maxQueueSize > 0 && newQueueSize > maxQueueSize) {
      Log.warn(
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

    // 6. Update working file with merged queue (if exists)
    await this.updateWorkingFile();

    Log.info(
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

      // Build map of prompts we have in memory (by ID and hash)
      const memoryPromptMap = new Map<string, PromptItem>();
      for (const prompt of this.state.prompts) {
        const hash = hashPromptContent(prompt.prompt);
        memoryPromptMap.set(hash, prompt);
        if (prompt.id) {
          memoryPromptMap.set(prompt.id, prompt);
        }
      }

      // Check if disk has prompts we don't have in memory
      const newPromptsFromDisk: PromptItem[] = [];
      for (const diskPrompt of diskPrompts) {
        const hash = hashPromptContent(diskPrompt.prompt);
        const existsInMemory =
          memoryPromptMap.has(hash) ||
          (diskPrompt.id && memoryPromptMap.has(diskPrompt.id));

        if (!existsInMemory) {
          newPromptsFromDisk.push(diskPrompt);
        }
      }

      if (newPromptsFromDisk.length === 0) {
        Log.info("mergePromptsFromDisk: No new prompts found");
        return 0;
      }

      Log.info(
        `mergePromptsFromDisk: Found ${newPromptsFromDisk.length} new prompts from disk (MCP append), merging into queue`
      );

      // CRITICAL: Use disk order as source of truth
      // This preserves the insertion positions chosen by MCP (e.g., "next" vs "end")
      this.state.prompts = diskPrompts;

      // Rebuild results array to match new prompt order
      // Preserve existing results where we have them, add pending for new prompts
      const newResults: PromptResult[] = diskPrompts.map((prompt, index) => {
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
   * @param position - Where to insert prompts: "next" (after current) or "end" (at end of queue)
   * @throws Error if queue is in invalid state for appending
   */
  public async appendPrompts(
    prompts: PromptItem[],
    source: string = "User append",
    position: "next" | "end" = "end"
  ): Promise<void> {
    if (!this.canAppend()) {
      throw new Error("Cannot append: Queue is in cancelled or error state");
    }

    // Serialize operation to prevent race conditions
    this.operationQueue = this.operationQueue.then(async () => {
      // Calculate insert index based on position
      const insertIndex =
        position === "next"
          ? this.state.currentIndex + 1
          : this.state.prompts.length;

      // Generate append segment for tracking
      const segment: AppendSegment = {
        id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
        timestamp: Date.now(),
        source,
        promptCount: prompts.length,
        promptIndices: Array.from(
          { length: prompts.length },
          (_, i) => insertIndex + i
        ),
      };

      // Insert prompts at the specified position
      this.state.prompts.splice(insertIndex, 0, ...prompts);
      this.state.appendSegments.push(segment);

      // Create new results for the inserted prompts
      const newResults: PromptResult[] = prompts.map((prompt) => ({
        prompt: prompt.prompt,
        status: STEP_STATUS.PENDING,
        timestamp: new Date(),
      }));

      // Insert results at the same position
      this.state.results.splice(insertIndex, 0, ...newResults);

      // Auto-start behavior based on current state:
      // - COMPLETED: Set to RUNNING (user already started workflow, treat as continuation)
      // - IDLE: Stay IDLE (user hasn't started yet, don't auto-start)
      // - PAUSED: Stay PAUSED (user explicitly paused, don't auto-resume)
      // - RUNNING: Already running, no change needed
      if (this.state.status === EXECUTION_STATES.COMPLETED) {
        this.state.status = EXECUTION_STATES.RUNNING;
        this.isPaused = false;
        this.state.stopped = false;
      }

      this.emitStateChange();

      // Update working file if it exists (call internal method to avoid nested operation queue)
      Log.info(
        `About to update working file. Path: ${this.state.workingFilePath}, Total prompts: ${this.state.prompts.length}, Insert position: ${position} (index: ${insertIndex})`
      );
      await this._updateWorkingFileInternal();
      Log.info(
        `Working file updated. Appended ${prompts.length} prompts from: ${source} at position: ${position}`
      );
    });

    await this.operationQueue;
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
    return !invalidStates.includes(this.state.status);
  }

  /**
   * Check if queue has completed all prompts
   * @returns true if all prompts completed
   */
  public isCompleted(): boolean {
    return (
      this.state.status === EXECUTION_STATES.COMPLETED ||
      this.state.status === EXECUTION_STATES.IDLE
    );
  }

  // ==================== Working File Operations ====================

  /**
   * Generate working file path in .flightpath/.queue/ directory
   */
  private async generateWorkingFilePath(
    originalFilePath: string,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string> {
    const fileName = path.basename(
      originalFilePath,
      path.extname(originalFilePath)
    );
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .substring(0, 19);
    const queueDir = path.join(
      workspaceFolder.uri.fsPath,
      ".flightpath",
      ".queue"
    );

    // Ensure directory exists
    await fs.mkdir(queueDir, { recursive: true });

    return path.join(queueDir, `${fileName}-${timestamp}.flightpath.json`);
  }

  /**
   * Create working file from original prompt file
   * @param originalFilePath Path to original prompt file
   * @param prompts Prompts to store in working file
   * @param workspaceFolder Current workspace folder
   * @returns Path to created working file
   */
  public async createWorkingFile(
    originalFilePath: string,
    prompts: PromptItem[],
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string> {
    const workingFilePath = await this.generateWorkingFilePath(
      originalFilePath,
      workspaceFolder
    );

    const workingFile: WorkingFile = {
      originalFile: originalFilePath,
      workflowName: path.basename(
        originalFilePath,
        path.extname(originalFilePath)
      ),
      startedAt: Date.now(),
      prompts: prompts,
      _runtime: {
        currentIndex: 0,
        completedPrompts: [],
        executionState: EXECUTION_STATES.IDLE,
        appendSegments: [],
      },
    };

    // Write atomically (temp + rename)
    await this.writeWorkingFileAtomic(workingFilePath, workingFile);

    // Update queue state with working file path
    this.state.workingFilePath = workingFilePath;
    this.emitStateChange();

    Log.info(` Created working file: ${workingFilePath}`);
    return workingFilePath;
  }

  /**
   * Read working file
   * @param workingFilePath Path to working file
   * @returns Parsed working file
   */
  public async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    try {
      const content = await fs.readFile(workingFilePath, "utf-8");
      const parsed = JSON.parse(content) as WorkingFile;
      return parsed;
    } catch (error) {
      throw new Error(
        `Failed to read working file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Write working file atomically (temp + rename)
   * @param workingFilePath Path to working file
   * @param workingFile Working file data
   */
  private async writeWorkingFileAtomic(
    workingFilePath: string,
    workingFile: WorkingFile
  ): Promise<void> {
    const tempPath = `${workingFilePath}.tmp`;

    try {
      // Write to temp file
      await fs.writeFile(tempPath, JSON.stringify(workingFile, null, 2));

      // Atomic rename
      await fs.rename(tempPath, workingFilePath);
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(tempPath);
      } catch {}

      throw new Error(
        `Failed to write working file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Update working file with current queue state
   * This is called after prompt completion, append, or any queue modification
   */
  public async updateWorkingFile(): Promise<void> {
    if (!this.state.workingFilePath) {
      return; // No working file to update
    }

    // Serialize operation to prevent race conditions
    this.operationQueue = this.operationQueue.then(async () => {
      await this._updateWorkingFileInternal();
    });

    await this.operationQueue;
  }

  /**
   * Internal method to update working file (does not use operation queue)
   * This can be called from within an existing operation queue context
   */
  private async _updateWorkingFileInternal(): Promise<void> {
    if (!this.state.workingFilePath) {
      return; // No working file to update
    }

    try {
      // Read current working file from disk to pick up any external changes (e.g., MCP appends)
      const workingFile = await this.readWorkingFile(
        this.state.workingFilePath!
      );

      // CRITICAL FIX: Merge prompts from disk instead of blindly overwriting
      // This preserves MCP-appended prompts that may have been added while we were running
      const diskPrompts = workingFile.prompts || [];
      const memoryPrompts = this.state.prompts;

      // Build a map of prompts we have in memory (by ID and hash)
      const memoryPromptMap = new Map<string, PromptItem>();
      for (const prompt of memoryPrompts) {
        const hash = hashPromptContent(prompt.prompt);
        memoryPromptMap.set(hash, prompt);
        if (prompt.id) {
          memoryPromptMap.set(prompt.id, prompt);
        }
      }

      // Check if disk has prompts we don't have in memory
      const newPromptsFromDisk: PromptItem[] = [];
      for (const diskPrompt of diskPrompts) {
        const hash = hashPromptContent(diskPrompt.prompt);
        const existsInMemory =
          memoryPromptMap.has(hash) ||
          (diskPrompt.id && memoryPromptMap.has(diskPrompt.id));

        if (!existsInMemory) {
          // This prompt exists on disk but not in memory (MCP must have added it)
          newPromptsFromDisk.push(diskPrompt);
        }
      }

      // If disk has new prompts, merge them PRESERVING DISK ORDER
      if (newPromptsFromDisk.length > 0) {
        Log.info(
          `updateWorkingFile - Detected ${newPromptsFromDisk.length} prompts added externally (likely via MCP), merging into queue`
        );

        // CRITICAL: Use disk order as source of truth, not memory order
        // This preserves the insertion positions chosen by MCP (e.g., "next" vs "end")
        this.state.prompts = diskPrompts;

        // Rebuild results array to match new prompt order
        // Preserve existing results where we have them, add pending for new prompts
        const newResults: PromptResult[] = diskPrompts.map((prompt, index) => {
          const hash = hashPromptContent(prompt.prompt);
          const promptId = prompt.id || hash;

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

        // Emit state change so dashboard updates
        this.emitStateChange();
      }

      // Now write back the merged prompts array
      workingFile.prompts = this.state.prompts;
      Log.info(
        `updateWorkingFile - Writing ${workingFile.prompts.length} prompts to ${this.state.workingFilePath}`
      );

      // Update runtime state
      workingFile._runtime = {
        currentIndex: this.state.currentIndex,
        completedPrompts: Array.from(this.state.completedIds),
        executionState: this.state.status,
        appendSegments: this.state.appendSegments,
      };

      // Write atomically
      await this.writeWorkingFileAtomic(
        this.state.workingFilePath!,
        workingFile
      );
      Log.info(`updateWorkingFile - Successfully wrote working file`);
    } catch (error) {
      console.error("FlightPath: Failed to update working file:", error);
      // Don't throw - this is a background operation
    }
  }

  /**
   * Emit state change event
   */
  private emitStateChange(): void {
    this.onStateChanged.fire({ ...this.state });
  }
}
