import * as fs from "fs";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
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
import { HistorySearchIndexService } from "./HistorySearchIndexService";
import { TimelineRecorder } from "./TimelineRecorder";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEventDraft,
  type WorkflowDefinitionSnapshot,
  type RunSummary,
} from "../../types/WorkflowTimelineTypes";

/** The definitionRevision that produced an attempt, plus the snapshot to commit before its first output. */
export interface DefinitionRevisionContext {
  definitionRevision: number;
  definition: WorkflowDefinitionSnapshot;
}
import type { WorkflowRuntimeTransition } from "../../types/CtrlYokeTypes";
import type { CliEvent } from "../../types/CliOutputTypes";
import {
  StreamingHistoryBuffer,
  type StreamingHistoryFlush,
} from "./StreamingHistoryBuffer";

/**
 * OutputHistoryManager
 *
 * RESPONSIBILITY: Workflow Output History Storage & Retrieval
 *
 * Manages per-run output history for workflows. Runs are stored as
 * manifest.json + events.jsonl timeline data under `.ctrlyoke/.runs/<workflowKey>/<runRef>/`.
 * `WorkflowLineageRepository` owns the `RunRef` directory itself (created together with
 * the run's `workflow.ctrlyoke.json` at promotion time); this class only populates and
 * maintains the manifest/events pair inside it.
 *
 * Key design decisions:
 * - History is always on — there is no longer a way to disable it.
 * - Working files do NOT track outputHistory — disk is always authoritative
 * - Outputs stored using existing CliOutput format (zero new types for storage)
 * - History is a self-contained snapshot (renders independently of current prompts)
 */
export class OutputHistoryManager {
  private readonly timelineRecorder = new TimelineRecorder();
  private readonly timelineAdapter = new OutputHistoryTimelineAdapter(
    this.timelineRecorder
  );
  private readonly historySearchIndexService = new HistorySearchIndexService();
  /** Coalesces token-cadence streaming deltas before they hit events.jsonl. */
  private readonly streamingBuffer = new StreamingHistoryBuffer(
    (historyFilePath, flush) => this.writeStreamingFlush(historyFilePath, flush)
  );
  private readonly snapshotService = new WorkspaceSnapshotService();
  /** Latest fire-and-forget search-index refresh; see flushPendingIndexRefresh. */
  private pendingIndexRefresh: Promise<void> = Promise.resolve();

  constructor(private _workspaceFolderPath: string) {}

  /** Get the manifest path for an already-known run. */
  getHistoryFilePath(workflowKey: WorkflowKey, runRef: RunRef): string {
    return WorkflowPaths.manifestPath(
      this._workspaceFolderPath,
      workflowKey,
      runRef
    );
  }

  /**
   * Populate manifest.json/events.jsonl inside a run directory that
   * `WorkflowLineageRepository.allocateRun` (via `WorkingFileManager.promoteToNewRun`)
   * has already created alongside the run's `workflow.ctrlyoke.json`.
   * Returns { filePath, runCount } where runCount is the total runs after initialization
   * (capped at maxHistoryRuns after pruning).
   */
  async initializeRunAt(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    runDir: string,
    runId: number,
    startedAt: number
  ): Promise<{ filePath: string; runCount: number }> {
    Log.debug(
      `[OutputHistoryManager] initializeRunAt: ${workflowKey}/${runRef} (runId=${runId})`
    );
    try {
      const filePath = await this.timelineRecorder.initializeRunAt(
        runDir,
        workflowKey,
        runId,
        startedAt,
        EXECUTION_STATES.RUNNING
      );

      // Prune old runs if needed (disk-only operation)
      const maxRuns = ConfigurationUtils.getMaxRuns();
      await this.pruneOldRuns(workflowKey, maxRuns);

      const runCount = (await this.getRunsForWorkflow(workflowKey)).length;
      this.refreshSearchIndex();

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
    cliOutputs: CliOutput[],
    definitionContext?: DefinitionRevisionContext
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      // Land any buffered deltas before the aggregate so events.jsonl stays a
      // faithful log; the adapter seals the attempt once the aggregate lands.
      await this.streamingBuffer.flush(historyFilePath);
      if (definitionContext) {
        await this.commitDefinitionRevisionIfNeeded(
          historyFilePath,
          definitionContext
        );
      }
      await this.saveTimelineExecutionOutput(
        historyFilePath,
        target,
        cliOutputs,
        definitionContext?.definitionRevision
      );
    } catch (error) {
      Log.warn("Failed to save step output to history:", error);
    }
  }

  /**
   * Persist the initial in-flight output record before any streamed deltas arrive.
   * Streaming writes intentionally do not rebuild the search index; the completed
   * aggregate write does that once when the attempt settles.
   */
  async startStreamingExecutionOutput(
    historyFilePath: string,
    target: OutputExecutionTarget,
    cliOutput: CliOutput,
    definitionContext?: DefinitionRevisionContext
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }
    try {
      if (definitionContext) {
        await this.commitDefinitionRevisionIfNeeded(
          historyFilePath,
          definitionContext
        );
      }
      await this.timelineRecorder.appendEvents(historyFilePath, [
        {
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
          timestampMs: cliOutput.timestampMs ?? Date.now(),
          target,
          runIndex: cliOutput.runIndex ?? 0,
          attemptIndex: cliOutput.attemptIndex ?? 0,
          definitionRevision: definitionContext?.definitionRevision,
          payload: { cliOutput },
        },
      ]);
    } catch (error) {
      Log.warn("Failed to start streaming output history:", error);
    }
  }

  /**
   * Commit a `DEFINITION_REVISION_COMMITTED` snapshot before this attempt's first
   * output, if the manifest does not already reflect this revision. No-ops for a
   * revision already recorded — cheap to call from every output-writing call site.
   */
  private async commitDefinitionRevisionIfNeeded(
    historyFilePath: string,
    context: DefinitionRevisionContext
  ): Promise<void> {
    try {
      await this.timelineRecorder.commitDefinitionRevisionIfNewer(
        historyFilePath,
        context.definitionRevision,
        context.definition,
        Date.now()
      );
    } catch (error) {
      Log.warn("Failed to commit definition revision snapshot:", error);
    }
  }

  /** Commit a definition transition that occurs before any new output exists. */
  async commitDefinitionRevision(
    historyFilePath: string,
    context: DefinitionRevisionContext
  ): Promise<void> {
    if (!historyFilePath) {
      throw new Error(
        "Cannot commit a definition revision without a manifest path"
      );
    }
    await this.timelineRecorder.commitDefinitionRevisionIfNewer(
      historyFilePath,
      context.definitionRevision,
      context.definition,
      Date.now()
    );
  }

  /**
   * Buffer a raw text delta for an in-flight attempt. Written on a semantic
   * boundary rather than immediately — see {@link StreamingHistoryBuffer}.
   */
  async appendStreamingChunk(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    chunk: string
  ): Promise<void> {
    if (!historyFilePath || !chunk) {
      return;
    }
    await this.streamingBuffer.addChunk(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      chunk
    );
  }

  /**
   * Buffer parsed CLI events for an in-flight attempt. Consecutive text-only
   * events merge; a tool call or other boundary event writes immediately.
   */
  async appendStreamingEvents(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    events: CliEvent[]
  ): Promise<void> {
    if (!historyFilePath || events.length === 0) {
      return;
    }
    await this.streamingBuffer.addEvents(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      events
    );
  }

  /** Write one coalesced batch of streamed deltas to the timeline. */
  private async writeStreamingFlush(
    historyFilePath: string,
    flush: StreamingHistoryFlush
  ): Promise<void> {
    const drafts: WorkflowTimelineEventDraft[] = [];
    const shared = {
      timestampMs: flush.timestampMs,
      target: flush.target,
      runIndex: flush.runIndex,
      attemptIndex: flush.attemptIndex,
    };

    if (flush.chunk) {
      drafts.push({
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED,
        ...shared,
        payload: { chunk: flush.chunk },
      });
    }
    if (flush.events) {
      drafts.push({
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
        ...shared,
        payload: { events: flush.events },
      });
    }

    try {
      // One appendEvents call so a chunk + event batch cost a single write.
      await this.timelineRecorder.appendEvents(historyFilePath, drafts);
    } catch (error) {
      Log.warn("Failed to append streamed output deltas to history:", error);
    }
  }

  /**
   * Write buffered deltas, then wait for all serialized timeline writes already
   * queued by live callbacks.
   */
  async flushPendingWrites(historyFilePath?: string): Promise<void> {
    await this.streamingBuffer.flush(historyFilePath);
    await this.timelineRecorder.flushPendingOperations(historyFilePath);
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
      this.refreshSearchIndex();
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
      // Keep the manifest's executionState authoritative for every transition, not
      // only init/finalize, so manifest-only run lists show paused/pausing/cancelling
      // states correctly. finalizeRun (called after this for terminal transitions,
      // serialized through the same per-manifest queue) still owns completedAt/stepCount.
      await this.timelineRecorder.updateManifest(
        historyFilePath,
        (manifest) => ({
          ...manifest,
          executionState: transition.current.status,
          lastUpdatedAt: transition.timestampMs,
        })
      );
      this.refreshSearchIndex();
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
      this.refreshSearchIndex();
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
    stepCount: number
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      await this.streamingBuffer.flush(historyFilePath);
      const completedAt = Date.now();
      await this.timelineRecorder.updateManifest(
        historyFilePath,
        (manifest) => ({
          ...manifest,
          completedAt,
          executionState,
          stepCount,
          lastUpdatedAt: completedAt,
        })
      );
      this.refreshSearchIndex();
    } catch (error) {
      Log.warn("Failed to finalize history run:", error);
    }
  }

  /** Finalize the newest still-running run after startup detects a dead owner. */
  async recoverInterruptedRun(
    workflowKey: WorkflowKey,
    stepCount: number
  ): Promise<void> {
    const [latestRun] = await this.getRunsForWorkflow(workflowKey);
    if (!latestRun) {
      return;
    }
    const historyFilePath = this.getHistoryFilePath(workflowKey, latestRun);
    try {
      const manifest =
        await this.timelineRecorder.readManifest(historyFilePath);
      if (manifest.executionState !== EXECUTION_STATES.RUNNING) {
        return;
      }
      await this.finalizeRun(
        historyFilePath,
        EXECUTION_STATES.STOPPED,
        stepCount
      );
    } catch (error) {
      Log.warn("Failed to recover interrupted history run:", error);
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
   * Get all run refs for a workflow (sorted newest first).
   * Returns empty array if the lineage directory does not exist or has no runs.
   */
  async getRunsForWorkflow(workflowKey: WorkflowKey): Promise<RunRef[]> {
    const lineageDir = WorkflowPaths.lineageDir(
      this._workspaceFolderPath,
      workflowKey
    );

    try {
      const entries = await fs.promises.readdir(lineageDir, {
        withFileTypes: true,
      });
      const runEntries = entries
        .filter((entry) => WorkflowPaths.isRunDirEntry(entry))
        .map((entry) => entry.name as RunRef);

      return runEntries.sort(
        (a, b) =>
          (WorkflowPaths.parseRunRefTimestamp(b) ?? 0) -
          (WorkflowPaths.parseRunRefTimestamp(a) ?? 0)
      );
    } catch {
      return [];
    }
  }

  /**
   * Get the most recent history file path for a workflow.
   * Returns empty string if no run exists for this workflow.
   * Used for append-to-completed scenarios where we want to continue
   * writing to the existing run instead of creating a new one.
   */
  async getLatestHistoryFilePath(workflowKey: WorkflowKey): Promise<string> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    if (runs.length === 0) {
      return "";
    }

    // runs[0] is the most recent (sorted newest first)
    return this.getHistoryFilePath(workflowKey, runs[0]);
  }

  /**
   * Get startedAt timestamps for all runs of a workflow, newest first.
   * Matches the order of getRunsForWorkflow() (index 0 = most recent run).
   * Returns undefined for any run whose file cannot be read or lacks startedAt.
   */
  async getRunTimestamps(
    workflowKey: WorkflowKey
  ): Promise<(number | undefined)[]> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    const timestamps = await Promise.all(
      runs.map(async (runRef) => {
        try {
          const filePath = this.getHistoryFilePath(workflowKey, runRef);
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
  async getRunStates(
    workflowKey: WorkflowKey
  ): Promise<(string | undefined)[]> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    const states = await Promise.all(
      runs.map(async (runRef) => {
        try {
          const filePath = this.getHistoryFilePath(workflowKey, runRef);
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
   * Manifest-only run listing for a lineage, newest first. Reads each run's
   * manifest.json plus its workflow.ctrlyoke.json (for harness/model disclosure only —
   * no output events are loaded). Runs whose manifest cannot be read are treated as
   * recovery candidates and excluded rather than returned as malformed rows.
   */
  async getRunSummaries(workflowKey: WorkflowKey): Promise<RunSummary[]> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    const summaries = await Promise.all(
      runs.map((runRef) => this.readRunSummary(workflowKey, runRef))
    );
    return summaries.filter(
      (summary): summary is RunSummary => summary !== null
    );
  }

  private async readRunSummary(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<RunSummary | null> {
    const historyFilePath = this.getHistoryFilePath(workflowKey, runRef);
    try {
      const manifest =
        await this.timelineRecorder.readManifest(historyFilePath);
      const {
        primaryHarness,
        primaryModel,
        hasMixedHarnesses,
        hasMixedModels,
      } = await this.readRunHarnessDisclosure(workflowKey, runRef);

      return {
        workflowKey,
        runRef,
        runId: manifest.runId,
        startedAt: manifest.startedAt,
        completedAt: manifest.completedAt,
        executionState: manifest.executionState,
        definitionRevision: manifest.definitionRevision,
        stepCount: manifest.stepCount,
        primaryHarness,
        primaryModel,
        hasMixedHarnesses,
        hasMixedModels,
      };
    } catch (error) {
      Log.warn(
        `[OutputHistoryManager] getRunSummaries: skipping unreadable run ${workflowKey}/${runRef}:`,
        error
      );
      return null;
    }
  }

  /**
   * Best-effort harness/model disclosure for a run: the resolved value each queue
   * step actually executed with (`_runtime.harness`/`_runtime.model`) falling back to
   * its declared step/workflow-level override for steps that have not executed yet.
   * Script-only runs and runs whose steps disclose nothing report both as undefined.
   */
  private async readRunHarnessDisclosure(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<{
    primaryHarness?: string;
    primaryModel?: string;
    hasMixedHarnesses: boolean;
    hasMixedModels: boolean;
  }> {
    const runFilePath = WorkflowPaths.runFilePath(
      this._workspaceFolderPath,
      workflowKey,
      runRef
    );

    try {
      const content = await fs.promises.readFile(runFilePath, "utf8");
      const workingFile = JSON.parse(content) as {
        harness?: string;
        model?: string;
        steps?: Array<{
          type?: string;
          harness?: string;
          model?: string;
          _runtime?: { harness?: string; model?: string };
        }>;
      };

      const harnesses = new Set<string>();
      const models = new Set<string>();
      for (const step of workingFile.steps ?? []) {
        if (step.type === "script") {
          continue;
        }
        const harness =
          step._runtime?.harness ?? step.harness ?? workingFile.harness;
        const model = step._runtime?.model ?? step.model ?? workingFile.model;
        if (harness) {
          harnesses.add(harness);
        }
        if (model) {
          models.add(model);
        }
      }

      return {
        primaryHarness: harnesses.values().next().value,
        primaryModel: models.values().next().value,
        hasMixedHarnesses: harnesses.size > 1,
        hasMixedModels: models.size > 1,
      };
    } catch {
      return {
        hasMixedHarnesses: false,
        hasMixedModels: false,
      };
    }
  }

  /**
   * Prune runs beyond maxRuns limit (oldest first).
   * Disk-only: deletes the oldest run directories, no working file changes.
   */
  async pruneOldRuns(workflowKey: WorkflowKey, maxRuns: number): Promise<void> {
    // -1 or 0 means keep all runs
    if (maxRuns <= 0) {
      return;
    }

    const runs = await this.getRunsForWorkflow(workflowKey);
    if (runs.length <= maxRuns) {
      return;
    }

    // runs is newest-first; slice(maxRuns) gives the oldest entries to delete
    const protectedRunRef = await this.getProtectedRunRef(workflowKey);
    const toDelete = runs.slice(maxRuns).filter((runRef) => {
      if (runRef !== protectedRunRef) return true;
      Log.warn(
        `Skipping protected pending-continuation run ${runRef} during pruning`
      );
      return false;
    });
    for (const runRef of toDelete) {
      const entryPath = WorkflowPaths.runDir(
        this._workspaceFolderPath,
        workflowKey,
        runRef
      );
      try {
        await fs.promises.rm(entryPath, { recursive: true, force: true });
      } catch (error) {
        Log.warn(`Failed to delete old run ${runRef}:`, error);
      }
    }
    this.refreshSearchIndex();
  }

  /**
   * Delete a single run by index (0 = most recent), matching the newest-first
   * ordering of getRunsForWorkflow(). Disk-only: removes the one run directory,
   * no working file changes. Returns the number of runs remaining afterward.
   *
   * Because continue/append always reuse getLatestHistoryFilePath() (newest run),
   * deleting an accidental newest run lets the prior run resume seamlessly.
   */
  async deleteRun(workflowKey: WorkflowKey, runIndex: number): Promise<number> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    const runRef = runs[runIndex];
    if (!runRef) {
      Log.warn(
        `deleteRun: no run at index ${runIndex} for workflow ${workflowKey}`
      );
      return runs.length;
    }
    if ((await this.getProtectedRunRef(workflowKey)) === runRef) {
      throw new Error("Cannot delete a run with a pending continuation");
    }

    const entryPath = WorkflowPaths.runDir(
      this._workspaceFolderPath,
      workflowKey,
      runRef
    );
    try {
      await fs.promises.rm(entryPath, { recursive: true, force: true });
    } catch (error) {
      Log.warn(`Failed to delete run ${runRef}:`, error);
    }

    this.refreshSearchIndex();
    return (await this.getRunsForWorkflow(workflowKey)).length;
  }

  /** Delete one stable run identity. Callers must never resolve a display index late. */
  async deleteRunByRef(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<number> {
    if ((await this.getProtectedRunRef(workflowKey)) === runRef) {
      throw new Error("Cannot delete a run with a pending continuation");
    }
    const runs = await this.getRunsForWorkflow(workflowKey);
    if (!runs.includes(runRef)) {
      throw new Error(
        `Run ${runRef} does not exist for workflow ${workflowKey}`
      );
    }
    await fs.promises.rm(
      WorkflowPaths.runDir(this._workspaceFolderPath, workflowKey, runRef),
      {
        recursive: true,
        force: false,
      }
    );
    this.refreshSearchIndex();
    return (await this.getRunsForWorkflow(workflowKey)).length;
  }

  private async getProtectedRunRef(
    workflowKey: WorkflowKey
  ): Promise<RunRef | undefined> {
    try {
      const descriptor = JSON.parse(
        await fs.promises.readFile(
          WorkflowPaths.descriptorPath(this._workspaceFolderPath, workflowKey),
          "utf8"
        )
      ) as import("../../types/CtrlYokeTypes").WorkflowLineageDescriptor;
      return descriptor.pendingEdit?.kind === "rewind"
        ? descriptor.pendingEdit.runRef
        : undefined;
    } catch {
      return undefined;
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
      this.refreshSearchIndex();
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
      this.refreshSearchIndex();
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
    cliOutputs: CliOutput[],
    definitionRevision?: number
  ): Promise<void> {
    if (cliOutputs.length === 0) {
      return;
    }

    const eventDrafts: WorkflowTimelineEventDraft[] = cliOutputs.map(
      (cliOutput) => ({
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: cliOutput.timestampMs ?? Date.now(),
        target,
        runIndex: cliOutput.runIndex ?? 0,
        attemptIndex: cliOutput.attemptIndex ?? 0,
        definitionRevision,
        payload: { cliOutput },
      })
    );

    eventDrafts.sort((left, right) => left.timestampMs - right.timestampMs);
    await this.timelineRecorder.appendEvents(historyFilePath, eventDrafts);
    this.refreshSearchIndex();
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

  /**
   * Kick off a search-index refresh without blocking the history write. The
   * index service coalesces bursts internally, so firing this after every
   * append is cheap. Awaiting it here previously stalled workflow completion on
   * a full index rebuild (and contributed to the extension-host OOM).
   */
  private refreshSearchIndex(): void {
    this.pendingIndexRefresh = this.historySearchIndexService
      .enqueueWorkspaceRefresh(this._workspaceFolderPath)
      .catch(() => {
        /* index refresh failures are logged inside the index service */
      });
  }

  /**
   * Resolves once any in-flight background search-index refresh has settled.
   * Search-index writes are intentionally fire-and-forget, so callers that need
   * a quiescent workspace (disposal, tests deleting the workspace dir) should
   * await this first to avoid racing a rebuild still writing to `.search-index`.
   */
  async flushPendingIndexRefresh(): Promise<void> {
    await this.pendingIndexRefresh;
  }
}
