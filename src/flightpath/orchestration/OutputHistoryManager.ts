import * as fs from "fs";
import * as path from "path";
import {
  PATH_CONSTANTS,
  ConfigurationUtils,
} from "../../utils/ConfigurationUtils";
import {
  WorkflowOutputHistory,
  StepOutput,
} from "../../types/OutputHistoryTypes";
import { CliOutput, StatusMessage } from "../../types/WebviewMessageTypes";
import { ExecutionState } from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";

/**
 * OutputHistoryManager
 *
 * RESPONSIBILITY: Workflow Output History Storage & Retrieval
 *
 * Manages per-run output history for workflows, storing CLI outputs and
 * status messages in separate JSON files under .flightpath/.history/<workflow-id>/.
 *
 * Key design decisions:
 * - The .history/<workflow-id>/ directory is the single source of truth
 * - Working files do NOT track outputHistory — disk is always authoritative
 * - Outputs stored using existing CliOutput format (zero new types for storage)
 * - History is a self-contained snapshot (renders independently of current prompts)
 */
export class OutputHistoryManager {
  /** Absolute path to .flightpath/.history/ */
  readonly historyBaseDir: string;

  constructor(private workspaceFolderPath: string) {
    this.historyBaseDir = path.join(
      workspaceFolderPath,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.HISTORY_DIR
    );
  }

  /** Check if history is enabled via settings */
  isHistoryEnabled(): boolean {
    return ConfigurationUtils.isSaveOutputHistoryEnabled();
  }

  /**
   * Extract workflow ID from working file path.
   * "workflow-2024-01-21T10-30-00.flightpath.json" → "workflow-2024-01-21T10-30-00"
   */
  extractWorkflowId(workingFilePath: string): string {
    const basename = path.basename(workingFilePath);
    return basename
      .replace(/\.flightpath\.json$/, "")
      .replace(/\.flightpath\.yaml$/, "");
  }

  /** Get absolute path to a history file */
  getHistoryFilePath(workflowId: string, historyFileName: string): string {
    return path.join(this.historyBaseDir, workflowId, historyFileName);
  }

  /**
   * Initialize a new run for a workflow.
   * Returns { filePath, runCount } where filePath is the new history file path
   * (or "" if history is disabled) and runCount is the total runs after initialization
   * (capped at maxHistoryRuns after pruning).
   *
   * The .history/<workflow-id>/ directory is the single source of truth —
   * nothing is written to the working file.
   *
   * Steps:
   * 1. Creates the .history/<workflow-id>/ directory
   * 2. Determines the next sequential run ID from existing files on disk
   * 3. Creates the initial (incomplete) history file
   * 4. Prunes old runs beyond maxHistoryRuns limit
   */
  async initializeRun(
    workflowId: string
  ): Promise<{ filePath: string; runCount: number }> {
    if (!this.isHistoryEnabled()) {
      return { filePath: "", runCount: 0 };
    }

    try {
      const historyDir = path.join(this.historyBaseDir, workflowId);
      await fs.promises.mkdir(historyDir, { recursive: true });

      // Determine next run ID from what's on disk
      const existingRuns = await this.getRunsForWorkflow(workflowId);
      const nextRunId =
        existingRuns.length > 0
          ? Math.max(...existingRuns.map((f) => this.extractRunId(f))) + 1
          : 1;

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `run-${nextRunId}-${timestamp}.json`;
      const filePath = path.join(historyDir, fileName);

      const initial: WorkflowOutputHistory = {
        schemaVersion: "1.0.0",
        workflowId,
        runId: nextRunId,
        startedAt: Date.now(),
        executionState: "running" as ExecutionState,
        runStepCount: 0,
        promptOutputs: {},
      };

      await fs.promises.writeFile(
        filePath,
        JSON.stringify(initial, null, 2),
        "utf-8"
      );

      // Prune old runs if needed (disk-only operation)
      const maxRuns = ConfigurationUtils.getMaxHistoryRuns();
      await this.pruneOldRuns(workflowId, maxRuns);

      // runCount = new total after pruning.
      // maxRuns <= 0 means "keep all" (no cap), so use actual count directly.
      const runCount = maxRuns > 0
        ? Math.min(existingRuns.length + 1, maxRuns)
        : existingRuns.length + 1;

      return { filePath, runCount };
    } catch (error) {
      Log.warn("Failed to initialize history run:", error);
      return { filePath: "", runCount: 0 };
    }
  }

  /**
   * Save CLI outputs for a step (called after each prompt completes or retries).
   * Replaces the entire step entry (handles both initial + retry case).
   */
  async saveStepOutput(
    historyFilePath: string,
    stepIndex: number,
    cliOutputs: CliOutput[],
    statusMessages: StatusMessage[]
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      const history = await this.readHistory(historyFilePath);
      history.promptOutputs[stepIndex] = { cliOutputs, statusMessages };
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to save step output to history:", error);
    }
  }

  /**
   * Finalize run (mark as completed/stopped/error and record total step count).
   * runStepCount is the total number of steps that were executed in this run —
   * used by history rendering to show all steps regardless of current workflow size.
   */
  async finalizeRun(
    historyFilePath: string,
    executionState: ExecutionState,
    runStepCount: number
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      const history = await this.readHistory(historyFilePath);
      history.completedAt = Date.now();
      history.executionState = executionState;
      history.runStepCount = runStepCount;
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to finalize history run:", error);
    }
  }

  /**
   * Load a history file for display.
   * Validates required fields before returning.
   */
  async loadHistory(historyFilePath: string): Promise<WorkflowOutputHistory> {
    const content = await fs.promises.readFile(historyFilePath, "utf-8");
    const history = JSON.parse(content) as WorkflowOutputHistory;

    if (!history.workflowId || !history.runId || !history.promptOutputs) {
      throw new Error("Invalid history file: missing required fields");
    }

    return history;
  }

  /**
   * Get all run filenames for a workflow (sorted newest first).
   * Returns empty array if directory does not exist or is empty.
   */
  async getRunsForWorkflow(workflowId: string): Promise<string[]> {
    const historyDir = path.join(this.historyBaseDir, workflowId);

    try {
      const entries = await fs.promises.readdir(historyDir);
      const runFiles = entries.filter((f) => /^run-\d+-.*\.json$/.test(f));
      return runFiles.sort((a, b) => this.extractRunId(b) - this.extractRunId(a));
    } catch {
      return [];
    }
  }

  /**
   * Prune runs beyond maxRuns limit (oldest first).
   * Disk-only: deletes the oldest history files, no working file changes.
   */
  async pruneOldRuns(workflowId: string, maxRuns: number): Promise<void> {
    // -1 or 0 means keep all runs
    if (maxRuns <= 0) {
      return;
    }

    const runs = await this.getRunsForWorkflow(workflowId);
    if (runs.length <= maxRuns) {
      return;
    }

    // runs is newest-first; slice(maxRuns) gives the oldest entries to delete
    const toDelete = runs.slice(maxRuns);
    for (const fileName of toDelete) {
      const filePath = this.getHistoryFilePath(workflowId, fileName);
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        Log.warn(`Failed to delete old history file ${fileName}:`, error);
      }
    }
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /** Extract numeric run ID from filename like "run-3-2024-01-21T10-30-00.json" */
  private extractRunId(fileName: string): number {
    const match = fileName.match(/^run-(\d+)-/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private async readHistory(
    filePath: string
  ): Promise<WorkflowOutputHistory> {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content) as WorkflowOutputHistory;
  }

  private async writeHistory(
    filePath: string,
    history: WorkflowOutputHistory
  ): Promise<void> {
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(history, null, 2),
      "utf-8"
    );
  }

}
