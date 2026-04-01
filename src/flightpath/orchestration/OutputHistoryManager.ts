import * as fs from "fs";
import * as path from "path";
import { isDeepStrictEqual } from "util";
import {
  PATH_CONSTANTS,
  ConfigurationUtils,
} from "../../utils/ConfigurationUtils";
import {
  WorkflowOutputHistory,
  OutputExecutionTarget,
  OutputTimelineEntry,
  StepOutput,
  WorkspaceSnapshot,
  UndoRecord,
} from "../../types/OutputHistoryTypes";
import { CliOutput, StatusMessage } from "../../types/WebviewMessageTypes";
import {
  EXECUTION_STATES,
  FINAL_PROMPT_PHASES,
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
 * Manages per-run output history for workflows. New runs are stored as
 * manifest.json + events.jsonl timeline data under .flightpath/.history/<workflow-id>/,
 * while legacy json run files are still loaded without migration.
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
    if (TimelineRecorder.isLegacyRunFile(historyFileName)) {
      return path.join(workflowHistoryPath, historyFileName);
    }

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
   * Save CLI outputs for a step (called after each prompt completes or retries).
   * Merges incoming CLI outputs with existing ones by attemptIndex so all retry
   * attempts are preserved. Timeline-backed runs ignore statusMessages here;
   * canonical status persistence goes through appendStatusMessage().
   */
  async saveStepOutput(
    historyFilePath: string,
    stepIndex: number,
    cliOutputs: CliOutput[],
    statusMessages: StatusMessage[]
  ): Promise<void> {
    await this.saveExecutionOutput(
      historyFilePath,
      { kind: "queue", stepIndex },
      cliOutputs,
      statusMessages
    );
  }

  /**
   * Save outputs for either a queue step or a finalPrompt loop.
   */
  async saveExecutionOutput(
    historyFilePath: string,
    target: OutputExecutionTarget,
    cliOutputs: CliOutput[],
    statusMessages: StatusMessage[]
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      if (this.isTimelineHistoryPath(historyFilePath)) {
        await this.saveTimelineExecutionOutput(
          historyFilePath,
          target,
          cliOutputs
        );
        return;
      }

      const history = await this.readHistory(historyFilePath);
      if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
        const existing =
          history.promptOutputs[target.stepIndex]?.cliOutputs ?? [];
        history.promptOutputs[target.stepIndex] = {
          cliOutputs: this.mergeCliOutputs(existing, cliOutputs),
          statusMessages,
        };
      } else {
        if (!history.finalPromptOutputs) {
          history.finalPromptOutputs = {};
        }
        const existing =
          history.finalPromptOutputs[target.loopIndex]?.cliOutputs ?? [];
        history.finalPromptOutputs[target.loopIndex] = {
          cliOutputs: this.mergeCliOutputs(existing, cliOutputs),
          statusMessages,
        };
      }

      this.upsertTimelineEntry(history, target, cliOutputs);
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to save step output to history:", error);
    }
  }

  /**
   * Append a single status message at the moment it is emitted.
   * This is the canonical write path for timeline-backed runs.
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
      if (this.isTimelineHistoryPath(historyFilePath)) {
        await this.timelineRecorder.appendEvents(historyFilePath, [
          this.createStatusMessageRecordedDraft(target, statusMessage),
        ]);
        return;
      }

      const history = await this.readHistory(historyFilePath);
      this.ensureStepOutput(history, target).statusMessages.push(statusMessage);
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to append status message to history:", error);
    }
  }

  /**
   * Append an authoritative workflow runtime transition for timeline-backed runs.
   * Legacy JSON history files do not persist run-level lifecycle events.
   */
  async appendRuntimeTransition(
    historyFilePath: string,
    transition: WorkflowRuntimeTransition
  ): Promise<void> {
    if (!historyFilePath || !this.isTimelineHistoryPath(historyFilePath)) {
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

  private upsertTimelineEntry(
    history: WorkflowOutputHistory,
    target: OutputExecutionTarget,
    cliOutputs: CliOutput[]
  ): void {
    if (!history.outputTimeline) {
      history.outputTimeline = [];
    }

    const key =
      target.kind === FINAL_PROMPT_PHASES.QUEUE
        ? `queue:${target.stepIndex}`
        : `final:${target.loopIndex}`;
    const firstOutputAt =
      cliOutputs
        .map((o) => o.timestampMs)
        .find((v): v is number => typeof v === "number") ?? Date.now();

    const existingIndex = history.outputTimeline.findIndex(
      (e) => e.key === key
    );
    const entry: OutputTimelineEntry = {
      key,
      target,
      firstOutputAt,
    };

    if (existingIndex >= 0) {
      const existing = history.outputTimeline[existingIndex];
      history.outputTimeline[existingIndex] = {
        ...entry,
        firstOutputAt: Math.min(existing.firstOutputAt, firstOutputAt),
      };
    } else {
      history.outputTimeline.push(entry);
    }

    history.outputTimeline.sort((a, b) => a.firstOutputAt - b.firstOutputAt);
  }

  /**
   * Merge incoming CLI outputs with existing ones by attemptIndex.
   * Replaces an existing entry if the same attemptIndex is already present;
   * otherwise appends. Result is sorted by attemptIndex (chronological order).
   */
  private mergeCliOutputs(
    existing: CliOutput[],
    incoming: CliOutput[]
  ): CliOutput[] {
    const merged = [...existing];
    for (const output of incoming) {
      const attemptIndex = output.attemptIndex ?? 0;
      const existingIdx = merged.findIndex(
        (o) => (o.attemptIndex ?? 0) === attemptIndex
      );
      if (existingIdx >= 0) {
        merged[existingIdx] = output;
      } else {
        merged.push(output);
      }
    }
    return merged.sort((a, b) => (a.attemptIndex ?? 0) - (b.attemptIndex ?? 0));
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
      if (this.isTimelineHistoryPath(historyFilePath)) {
        const history = await this.timelineAdapter.loadHistory(historyFilePath);
        const stepOutput = this.getStepOutput(history, target);
        if (!stepOutput) {
          return;
        }
        if (isDeepStrictEqual(stepOutput.workspaceSnapshot, snapshot)) {
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
        return;
      }

      const history = await this.readHistory(historyFilePath);
      if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
        if (history.promptOutputs[target.stepIndex]) {
          history.promptOutputs[target.stepIndex].workspaceSnapshot = snapshot;
        }
      } else {
        if (history.finalPromptOutputs?.[target.loopIndex]) {
          history.finalPromptOutputs[target.loopIndex].workspaceSnapshot =
            snapshot;
        }
      }
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to save workspace snapshot to history:", error);
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
      if (this.isTimelineHistoryPath(historyFilePath)) {
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
        return;
      }

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
    if (this.isTimelineHistoryPath(historyFilePath)) {
      return this.timelineAdapter.loadHistory(historyFilePath);
    }

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
      if (this.isTimelineHistoryPath(historyFilePath)) {
        const history = await this.timelineAdapter.loadHistory(historyFilePath);
        const stepOutput = this.getStepOutput(history, target);
        if (!stepOutput) {
          return;
        }
        if (isDeepStrictEqual(stepOutput.undoRecord, undoRecord)) {
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
        return;
      }

      const history = await this.readHistory(historyFilePath);
      const stepOutput =
        target.kind === FINAL_PROMPT_PHASES.QUEUE
          ? history.promptOutputs[target.stepIndex]
          : history.finalPromptOutputs?.[target.loopIndex];
      if (stepOutput) {
        stepOutput.undoRecord = undoRecord;
      }
      await this.writeHistory(historyFilePath, history);
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
      if (this.isTimelineHistoryPath(historyFilePath)) {
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

        if (isDeepStrictEqual(stepOutput.undoRecord, updatedUndoRecord)) {
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
        return;
      }

      const history = await this.readHistory(historyFilePath);
      const stepOutput =
        target.kind === FINAL_PROMPT_PHASES.QUEUE
          ? history.promptOutputs[target.stepIndex]
          : history.finalPromptOutputs?.[target.loopIndex];
      if (stepOutput?.undoRecord) {
        stepOutput.undoRecord.isRedone = true;
        stepOutput.undoRecord.redoneAt = redoneAt;
      }
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to mark undo record as redone:", error);
    }
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private isTimelineHistoryPath(historyFilePath: string): boolean {
    return (
      path.basename(historyFilePath) === TimelineRecorder.MANIFEST_FILE_NAME
    );
  }

  private getStepOutput(
    history: WorkflowOutputHistory,
    target: OutputExecutionTarget
  ) {
    return target.kind === FINAL_PROMPT_PHASES.QUEUE
      ? history.promptOutputs[target.stepIndex]
      : history.finalPromptOutputs?.[target.loopIndex];
  }

  private ensureStepOutput(
    history: WorkflowOutputHistory,
    target: OutputExecutionTarget
  ): StepOutput {
    if (target.kind === FINAL_PROMPT_PHASES.QUEUE) {
      history.promptOutputs[target.stepIndex] ??= {
        cliOutputs: [],
        statusMessages: [],
      };
      return history.promptOutputs[target.stepIndex];
    }

    history.finalPromptOutputs ??= {};
    history.finalPromptOutputs[target.loopIndex] ??= {
      cliOutputs: [],
      statusMessages: [],
    };
    return history.finalPromptOutputs[target.loopIndex];
  }

  private async saveTimelineExecutionOutput(
    historyFilePath: string,
    target: OutputExecutionTarget,
    cliOutputs: CliOutput[]
  ): Promise<void> {
    if (cliOutputs.length === 0) {
      return;
    }

    const history = await this.timelineAdapter.loadHistory(historyFilePath);
    const existingStepOutput = this.getStepOutput(history, target);
    const eventDrafts: WorkflowTimelineEventDraft[] = [];

    for (const cliOutput of cliOutputs) {
      const attemptIndex = cliOutput.attemptIndex ?? 0;
      const existingOutput = existingStepOutput?.cliOutputs.find(
        (output) => (output.attemptIndex ?? 0) === attemptIndex
      );
      if (existingOutput && isDeepStrictEqual(existingOutput, cliOutput)) {
        continue;
      }

      eventDrafts.push({
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: cliOutput.timestampMs ?? Date.now(),
        target,
        attemptIndex,
        payload: {
          cliOutput,
        },
      });
    }

    if (eventDrafts.length === 0) {
      return;
    }

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
    if (this.isTimelineHistoryPath(historyFilePath)) {
      const manifest =
        await this.timelineRecorder.readManifest(historyFilePath);
      return {
        startedAt: manifest.startedAt,
        executionState: manifest.executionState,
      };
    }

    const history = await this.readHistory(historyFilePath);
    return {
      startedAt: history.startedAt,
      executionState: history.executionState,
    };
  }

  private async readHistory(filePath: string): Promise<WorkflowOutputHistory> {
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
