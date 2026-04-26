import * as fs from "fs";
import * as path from "path";
import {
  PATH_CONSTANTS,
  ConfigurationUtils,
} from "../../utils/ConfigurationUtils";
import {
  WorkflowOutputHistory,
  OutputExecutionTarget,
  WorkspaceSnapshot,
  UndoRecord,
  StepOutput,
} from "../../types/OutputHistoryTypes";
import { WorkspaceSnapshotService } from "../../utils/WorkspaceSnapshotService";
import { CliOutput, StatusMessage } from "../../types/WebviewMessageTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  type ExecutionState,
} from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import { OutputHistoryTimelineAdapter } from "./OutputHistoryTimelineAdapter";
import { TimelineRecorder } from "./TimelineRecorder";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEventDraft,
} from "../../types/WorkflowTimelineTypes";
import type { WorkflowRuntimeTransition } from "../../types/FlightPathTypes";

/**
 * OutputHistoryManager
 *
 * RESPONSIBILITY: Workflow Output History Storage & Retrieval
 *
 * Manages per-run output history for workflows. Runs are stored as
 * manifest.json + events.jsonl timeline data under .flightpath/.history/<workflow-id>/.
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
  private readonly timelineRecorder = new TimelineRecorder();
  private readonly timelineAdapter = new OutputHistoryTimelineAdapter(
    this.timelineRecorder
  );
  private readonly snapshotService = new WorkspaceSnapshotService();

  constructor(private _workspaceFolderPath: string) {
    this.historyBaseDir = path.join(
      this._workspaceFolderPath,
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
      .replace(/\.flightpath\.yaml$/, "")
      .replace(/\.flightpath\.yml$/, "");
  }

  /** Get absolute path to a history file */
  getHistoryFilePath(workflowId: string, historyFileName: string): string {
    const workflowHistoryPath = path.join(this.historyBaseDir, workflowId);
    return TimelineRecorder.getManifestPathForRunDirectory(
      path.join(workflowHistoryPath, historyFileName)
    );
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

      const existingRuns = await this.getRunsForWorkflow(workflowId);
      const startedAt = Date.now();
      const filePath = await this.timelineRecorder.initializeRun(
        historyDir,
        workflowId,
        existingRuns.length + 1,
        startedAt,
        EXECUTION_STATES.RUNNING
      );

      // Prune old runs if needed (disk-only operation)
      const maxRuns = ConfigurationUtils.getMaxHistoryRuns();
      await this.pruneOldRuns(workflowId, maxRuns);

      const runCount = (await this.getRunsForWorkflow(workflowId)).length;

      return { filePath, runCount };
    } catch (error) {
      Log.warn("Failed to initialize history run:", error);
      return { filePath: "", runCount: 0 };
    }
  }

  /**
   * Save outputs for either a queue step or a finalStep loop.
   */
  async saveExecutionOutput(
    historyFilePath: string,
    target: OutputExecutionTarget,
    cliOutputs: CliOutput[]
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      await this.saveTimelineExecutionOutput(
        historyFilePath,
        target,
        cliOutputs
      );
    } catch (error) {
      Log.warn("Failed to save step output to history:", error);
    }
  }

  /**
   * Append a single status message at the moment it is emitted.
   */
  async appendStatusMessage(
    historyFilePath: string,
    target: OutputExecutionTarget,
    statusMessage: StatusMessage
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      await this.timelineRecorder.appendEvents(historyFilePath, [
        this.createStatusMessageRecordedDraft(target, statusMessage),
      ]);
    } catch (error) {
      Log.warn("Failed to append status message to history:", error);
    }
  }

  /**
   * Append an authoritative workflow runtime transition.
   */
  async appendRuntimeTransition(
    historyFilePath: string,
    transition: WorkflowRuntimeTransition
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      await this.timelineRecorder.appendEvents(historyFilePath, [
        {
          eventType: TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED,
          timestampMs: transition.timestampMs,
          payload: {
            transition: {
              command: transition.command,
              previous: transition.previous,
              current: transition.current,
            },
          },
        },
      ]);
    } catch (error) {
      Log.warn(
        "Failed to append workflow runtime transition to history:",
        error
      );
    }
  }

  /**
   * Save workspace snapshot for a specific execution target.
   * Called after a prompt fully completes (including retries).
   */
  async saveSnapshotForTarget(
    historyFilePath: string,
    target: OutputExecutionTarget,
    snapshot: WorkspaceSnapshot
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }
    try {
      const history = await this.timelineAdapter.loadHistory(historyFilePath);
      const stepOutput = this.getStepOutput(history, target);
      if (
        stepOutput &&
        JSON.stringify(stepOutput.workspaceSnapshot) ===
          JSON.stringify(snapshot)
      ) {
        return;
      }

      await this.timelineRecorder.appendEvents(historyFilePath, [
        {
          eventType: TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED,
          timestampMs: snapshot.capturedAt,
          target,
          payload: {
            workspaceSnapshot: snapshot,
          },
        },
      ]);
    } catch (error) {
      Log.warn("Failed to save workspace snapshot to history:", error);
    }
  }

  /**
   * Finalize run (mark as completed/stopped/error and record total step count).
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
      const completedAt = Date.now();
      await this.timelineRecorder.updateManifest(
        historyFilePath,
        (manifest) => ({
          ...manifest,
          completedAt,
          executionState,
          runStepCount,
          lastUpdatedAt: completedAt,
        })
      );
    } catch (error) {
      Log.warn("Failed to finalize history run:", error);
    }
  }

  /**
   * Load a history file for display.
   * Enriches gitHead snapshot entries with `beforeContent` fetched from git
   * when the original capture omitted it (e.g. file was >512 KB at HEAD).
   */
  async loadHistory(historyFilePath: string): Promise<WorkflowOutputHistory> {
    const history = await this.timelineAdapter.loadHistory(historyFilePath);
    return this.enrichSnapshotsInHistory(history);
  }

  /**
   * Get all run filenames for a workflow (sorted newest first).
   * Returns empty array if directory does not exist or is empty.
   */
  async getRunsForWorkflow(workflowId: string): Promise<string[]> {
    const historyDir = path.join(this.historyBaseDir, workflowId);

    try {
      const entries = await fs.promises.readdir(historyDir, {
        withFileTypes: true,
      });
      const runEntries = entries
        .filter((entry) => TimelineRecorder.isRunEntry(entry))
        .map((entry) => entry.name);

      return runEntries.sort(
        (a, b) =>
          TimelineRecorder.extractRunTimestamp(b) -
          TimelineRecorder.extractRunTimestamp(a)
      );
    } catch {
      return [];
    }
  }

  /**
   * Get the most recent history file path for a workflow.
   * Returns empty string if no history exists for this workflow.
   * Used for append-to-completed scenarios where we want to continue
   * writing to the existing run instead of creating a new one.
   */
  async getLatestHistoryFilePath(workflowId: string): Promise<string> {
    if (!this.isHistoryEnabled()) {
      return "";
    }

    const runs = await this.getRunsForWorkflow(workflowId);
    if (runs.length === 0) {
      return "";
    }

    // runs[0] is the most recent (sorted newest first)
    return this.getHistoryFilePath(workflowId, runs[0]);
  }

  /**
   * Get startedAt timestamps for all runs of a workflow, newest first.
   * Matches the order of getRunsForWorkflow() (index 0 = most recent run).
   * Returns undefined for any run whose file cannot be read or lacks startedAt.
   */
  async getRunTimestamps(workflowId: string): Promise<(number | undefined)[]> {
    const runs = await this.getRunsForWorkflow(workflowId);
    const timestamps = await Promise.all(
      runs.map(async (fileName) => {
        try {
          const filePath = this.getHistoryFilePath(workflowId, fileName);
          const metadata = await this.readRunMetadata(filePath);
          return metadata.startedAt;
        } catch {
          return undefined;
        }
      })
    );
    return timestamps;
  }

  /**
   * Get executionState for all runs of a workflow, newest first.
   * Matches the order of getRunsForWorkflow() (index 0 = most recent run).
   * Returns undefined for any run whose file cannot be read.
   */
  async getRunStates(workflowId: string): Promise<(string | undefined)[]> {
    const runs = await this.getRunsForWorkflow(workflowId);
    const states = await Promise.all(
      runs.map(async (fileName) => {
        try {
          const filePath = this.getHistoryFilePath(workflowId, fileName);
          const metadata = await this.readRunMetadata(filePath);
          return metadata.executionState as string;
        } catch {
          return undefined;
        }
      })
    );
    return states;
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
      const entryPath = path.join(this.historyBaseDir, workflowId, fileName);
      try {
        const stats = await fs.promises.stat(entryPath);
        if (stats.isDirectory()) {
          await fs.promises.rm(entryPath, { recursive: true, force: true });
        } else {
          await fs.promises.unlink(entryPath);
        }
      } catch (error) {
        Log.warn(`Failed to delete old history file ${fileName}:`, error);
      }
    }
  }

  /**
   * Persist an UndoRecord for a step after undo has been applied.
   */
  async saveUndoRecord(
    historyFilePath: string,
    target: OutputExecutionTarget,
    undoRecord: UndoRecord
  ): Promise<void> {
    if (!historyFilePath) return;
    try {
      const history = await this.timelineAdapter.loadHistory(historyFilePath);
      const stepOutput = this.getStepOutput(history, target);
      if (
        stepOutput &&
        JSON.stringify(stepOutput.undoRecord) === JSON.stringify(undoRecord)
      ) {
        return;
      }

      await this.timelineRecorder.appendEvents(historyFilePath, [
        {
          eventType: TIMELINE_EVENT_TYPES.UNDO_APPLIED,
          timestampMs: undoRecord.appliedAt,
          target,
          payload: {
            undoRecord,
          },
        },
      ]);
    } catch (error) {
      Log.warn("Failed to save undo record to history:", error);
    }
  }

  /**
   * Update the undoRecord after redo is applied (set isRedone=true, redoneAt).
   */
  async markUndoRecordRedone(
    historyFilePath: string,
    target: OutputExecutionTarget,
    redoneAt: number
  ): Promise<void> {
    if (!historyFilePath) return;
    try {
      const history = await this.timelineAdapter.loadHistory(historyFilePath);
      const stepOutput = this.getStepOutput(history, target);
      if (!stepOutput?.undoRecord) {
        return;
      }

      const updatedUndoRecord: UndoRecord = {
        ...stepOutput.undoRecord,
        isRedone: true,
        redoneAt,
      };

      if (
        JSON.stringify(stepOutput.undoRecord) ===
        JSON.stringify(updatedUndoRecord)
      ) {
        return;
      }

      await this.timelineRecorder.appendEvents(historyFilePath, [
        {
          eventType: TIMELINE_EVENT_TYPES.REDO_APPLIED,
          timestampMs: redoneAt,
          target,
          payload: {
            undoRecord: updatedUndoRecord,
          },
        },
      ]);
    } catch (error) {
      Log.warn("Failed to mark undo record as redone:", error);
    }
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /**
   * Enrich all workspace snapshots in a loaded history by hydrating
   * `beforeContent` for gitHead entries that were missing it.
   * Returns the same history object reference if nothing changed.
   */
  private async enrichSnapshotsInHistory(
    history: WorkflowOutputHistory
  ): Promise<WorkflowOutputHistory> {
    const enrichStep = async (stepOutput: StepOutput): Promise<StepOutput> => {
      if (!stepOutput.workspaceSnapshot) {
        return stepOutput;
      }
      const enriched = await this.snapshotService.enrichSnapshotBeforeContent(
        stepOutput.workspaceSnapshot,
        this._workspaceFolderPath
      );
      if (enriched === stepOutput.workspaceSnapshot) {
        return stepOutput;
      }
      return { ...stepOutput, workspaceSnapshot: enriched };
    };

    const promptEntries = await Promise.all(
      Object.entries(history.promptOutputs).map(
        async ([k, v]): Promise<[number, StepOutput]> => [
          Number(k),
          await enrichStep(v),
        ]
      )
    );

    let finalStepOutputs = history.finalStepOutputs;
    if (finalStepOutputs) {
      const finalEntries = await Promise.all(
        Object.entries(finalStepOutputs).map(
          async ([k, v]): Promise<[number, StepOutput]> => [
            Number(k),
            await enrichStep(v),
          ]
        )
      );
      finalStepOutputs = Object.fromEntries(finalEntries);
    }

    const promptOutputs: WorkflowOutputHistory["promptOutputs"] =
      Object.fromEntries(promptEntries);

    return { ...history, promptOutputs, finalStepOutputs };
  }

  private getStepOutput(
    history: WorkflowOutputHistory,
    target: OutputExecutionTarget
  ) {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? history.promptOutputs[target.stepIndex]
      : history.finalStepOutputs?.[target.loopIndex];
  }

  private async saveTimelineExecutionOutput(
    historyFilePath: string,
    target: OutputExecutionTarget,
    cliOutputs: CliOutput[]
  ): Promise<void> {
    if (cliOutputs.length === 0) {
      return;
    }

    const eventDrafts: WorkflowTimelineEventDraft[] = cliOutputs.map(
      (cliOutput) => ({
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: cliOutput.timestampMs ?? Date.now(),
        target,
        attemptIndex: cliOutput.attemptIndex ?? 0,
        payload: { cliOutput },
      })
    );

    eventDrafts.sort((left, right) => left.timestampMs - right.timestampMs);
    await this.timelineRecorder.appendEvents(historyFilePath, eventDrafts);
  }

  private createStatusMessageRecordedDraft(
    target: OutputExecutionTarget,
    statusMessage: StatusMessage
  ): WorkflowTimelineEventDraft {
    return {
      eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
      timestampMs: statusMessage.timestamp,
      target,
      payload: {
        statusMessage,
      },
    };
  }

  private async readRunMetadata(
    historyFilePath: string
  ): Promise<Pick<WorkflowOutputHistory, "startedAt" | "executionState">> {
    const manifest = await this.timelineRecorder.readManifest(historyFilePath);
    return {
      startedAt: manifest.startedAt,
      executionState: manifest.executionState,
    };
  }
}
