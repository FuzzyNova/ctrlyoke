import * as fs from "fs";
import * as path from "path";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  projectWorktreeRuntime,
} from "../../types/CtrlYokeTypes";
import type {
  RunRef,
  WorkflowKey,
  WorkflowTokenTotals,
  WorktreeRunProjection,
} from "../../types/CtrlYokeTypes";
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
  LOCK_STATUS,
  type ExecutionState,
  type ExecutionPhase,
} from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import { OutputHistoryTimelineAdapter } from "./OutputHistoryTimelineAdapter";
import { HistorySearchIndexService } from "./HistorySearchIndexService";
import { TimelineRecorder } from "./TimelineRecorder";
import { RunOutputResolver } from "./RunOutputResolver";
import { WorkflowTokenTotalsReducer } from "./WorkflowTokenTotalsReducer";
import { ObservedHarnessUsageStore } from "../harness/shared/usage/ObservedHarnessUsageStore";
import {
  LifetimeUsageStore,
  contributionFromManifest,
} from "../harness/shared/usage/LifetimeUsageStore";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_ATTEMPT_START_REASONS,
  TIMELINE_STORAGE_FILES,
  type TimelineAttemptKind,
  type TimelineAttemptStartReason,
  type TimelineAttemptTerminalState,
  type WorkflowTimelineEventDraft,
  type WorkflowDefinitionSnapshot,
  type RunSummary,
} from "../../types/WorkflowTimelineTypes";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  lookupRunSummary,
  stampRunFiles,
  storeRunSummary,
} from "./RunSummaryCache";

/** The definitionRevision that produced an attempt, plus the snapshot to commit before its first output. */
export interface DefinitionRevisionContext {
  definitionRevision: number;
  definition: WorkflowDefinitionSnapshot;
}

/** Immutable identity/input metadata recorded before an attempt can emit output. */
export interface TimelineAttemptStartContext {
  kind: TimelineAttemptKind;
  startReason: TimelineAttemptStartReason;
  prompt: string;
  phase?: ExecutionPhase;
}
import type { WorkflowRuntimeTransition } from "../../types/CtrlYokeTypes";
import type { CliEvent } from "../../types/CliOutputTypes";
import {
  StreamingHistoryBuffer,
  type StreamingHistoryFlush,
} from "./StreamingHistoryBuffer";

/**
 * Each summary reads a manifest and then its small working definition. Keeping
 * this below common Windows per-process file-handle limits prevents a large,
 * unbounded lineage from turning transient EMFILE errors into silently omitted
 * run rows.
 */
const RUN_SUMMARY_READ_BATCH_SIZE = 32;

/** Lifecycle states in which a run may still be owned by an executor. */
const ACTIVE_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  EXECUTION_STATES.RUNNING,
  EXECUTION_STATES.PAUSING,
  EXECUTION_STATES.PAUSED,
  EXECUTION_STATES.CANCELLING,
]);

function isTerminalExecutionState(state: ExecutionState): boolean {
  return (
    state === EXECUTION_STATES.COMPLETED ||
    state === EXECUTION_STATES.STOPPED ||
    state === EXECUTION_STATES.ERROR
  );
}

/**
 * One run's summary plus the manifest's own lifecycle state, which the resolved
 * summary may have overridden with the working file's. Exported only so
 * `RunSummaryCache` can type its entries; nothing else should consume it.
 */
export interface RunSummaryRecord {
  summary: RunSummary;
  manifestExecutionState: ExecutionState;
}

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
  private readonly runOutputResolver = new RunOutputResolver(
    this.timelineRecorder
  );
  private readonly historySearchIndexService = new HistorySearchIndexService();
  private readonly lineageRepository = new WorkflowLineageRepository();
  private readonly observedHarnessUsageStore: ObservedHarnessUsageStore;
  private readonly lifetimeUsageStore: LifetimeUsageStore;
  /** Coalesces token-cadence streaming deltas before they hit events.jsonl. */
  private readonly streamingBuffer = new StreamingHistoryBuffer(
    (historyFilePath, flush) => this.writeStreamingFlush(historyFilePath, flush)
  );
  private readonly snapshotService = new WorkspaceSnapshotService();
  /** Latest fire-and-forget search-index refresh; see flushPendingIndexRefresh. */
  private pendingIndexRefresh: Promise<void> = Promise.resolve();
  /** One aggregate owner per active run manifest. */
  private readonly tokenReducers = new Map<
    string,
    WorkflowTokenTotalsReducer
  >();
  private readonly tokenReducerHydration = new Map<string, Promise<void>>();
  private pendingObservedUsageFeed: Promise<void> = Promise.resolve();
  private tokenTotalsChangedHandler?: (
    historyFilePath: string,
    tokenTotals: WorkflowTokenTotals
  ) => Promise<void> | void;

  constructor(private _workspaceFolderPath: string) {
    this.observedHarnessUsageStore = new ObservedHarnessUsageStore(
      _workspaceFolderPath
    );
    this.lifetimeUsageStore = new LifetimeUsageStore(_workspaceFolderPath);
  }

  /** Project reducer snapshots into the owning queue/working file. */
  setTokenTotalsChangedHandler(
    handler: (
      historyFilePath: string,
      tokenTotals: WorkflowTokenTotals
    ) => Promise<void> | void
  ): void {
    this.tokenTotalsChangedHandler = handler;
  }

  /** Hydrate a run aggregate once from its durable timeline and repair its manifest copy. */
  async hydrateTokenTotals(
    historyFilePath: string
  ): Promise<WorkflowTokenTotals | undefined> {
    if (!historyFilePath) {
      return undefined;
    }
    const existingReducer = this.tokenReducers.get(historyFilePath);
    if (existingReducer) {
      return existingReducer.snapshot();
    }
    const existingHydration = this.tokenReducerHydration.get(historyFilePath);
    if (existingHydration) {
      await existingHydration;
      return this.tokenReducers.get(historyFilePath)?.snapshot();
    }

    const hydration = (async () => {
      const manifest =
        await this.timelineRecorder.readManifest(historyFilePath);
      const reducer = new WorkflowTokenTotalsReducer({
        workflowId: manifest.workflowId,
        runId: manifest.runId,
        isFinal: !ACTIVE_EXECUTION_STATES.has(manifest.executionState),
      });
      const events = [];
      for await (const event of this.timelineRecorder.streamEvents(
        historyFilePath
      )) {
        events.push(event);
      }
      reducer.reduce(events, {
        isFinal: !ACTIVE_EXECUTION_STATES.has(manifest.executionState),
      });
      this.tokenReducers.set(historyFilePath, reducer);
      const totals = reducer.snapshot();
      if (totals) {
        await this.persistTokenTotals(historyFilePath, totals);
      }
    })();
    this.tokenReducerHydration.set(historyFilePath, hydration);
    try {
      await hydration;
    } finally {
      this.tokenReducerHydration.delete(historyFilePath);
    }
    return this.tokenReducers.get(historyFilePath)?.snapshot();
  }

  /** Get the manifest path for an already-known run. */
  getHistoryFilePath(workflowKey: WorkflowKey, runRef: RunRef): string {
    return WorkflowPaths.manifestPath(
      this._workspaceFolderPath,
      workflowKey,
      runRef
    );
  }

  /** Streaming response reader shared by active execution and read-output clients. */
  getRunOutputResolver(): RunOutputResolver {
    return this.runOutputResolver;
  }

  /**
   * Populate manifest.json/events.jsonl inside a run directory that
   * `WorkflowLineageRepository.allocateRun` (via `WorkingFileManager.promoteToNewRun`)
   * has already created alongside the run's `workflow.ctrlyoke.json`.
   * Returns { filePath, runCount } where runCount is the total runs after initialization
   * (capped at runs.maxRuns after pruning).
   */
  async initializeRunAt(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    runDir: string,
    runId: number,
    startedAt: number,
    retentionProtectedRunRefs: readonly RunRef[] = [],
    initialDefinition?: WorkflowDefinitionSnapshot
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
        EXECUTION_STATES.RUNNING,
        1,
        initialDefinition
      );

      // Prune old runs if needed (disk-only operation)
      const maxRuns = ConfigurationUtils.getMaxRuns();
      await this.pruneOldRuns(
        workflowKey,
        maxRuns,
        new Set([runRef, ...retentionProtectedRunRefs])
      );

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
    definitionContext?: DefinitionRevisionContext,
    phase?: ExecutionPhase
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
        definitionContext?.definitionRevision,
        phase
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
    definitionContext?: DefinitionRevisionContext,
    attemptContext: TimelineAttemptStartContext = {
      kind: TIMELINE_ATTEMPT_KINDS.AI,
      startReason: TIMELINE_ATTEMPT_START_REASONS.INITIAL,
      prompt: cliOutput.prompt ?? "",
    }
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
      const definitionRevision = definitionContext?.definitionRevision ?? 1;
      const events = await this.timelineRecorder.appendEvents(historyFilePath, [
        {
          eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
          timestampMs: cliOutput.timestampMs ?? Date.now(),
          target,
          runIndex: cliOutput.runIndex ?? 0,
          attemptIndex: cliOutput.attemptIndex ?? 0,
          definitionRevision,
          phase: attemptContext.phase,
          payload: attemptContext,
        },
        {
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
          timestampMs: cliOutput.timestampMs ?? Date.now(),
          target,
          runIndex: cliOutput.runIndex ?? 0,
          attemptIndex: cliOutput.attemptIndex ?? 0,
          definitionRevision,
          responseKind: attemptContext.kind,
          phase: attemptContext.phase,
          payload: { cliOutput },
        },
      ]);
      await this.applyTokenEvents(historyFilePath, events);
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
    chunk: string,
    phase?: ExecutionPhase
  ): Promise<void> {
    if (!historyFilePath || !chunk) {
      return;
    }
    await this.streamingBuffer.addChunk(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      chunk,
      phase
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
    events: CliEvent[],
    phase?: ExecutionPhase
  ): Promise<void> {
    if (!historyFilePath || events.length === 0) {
      return;
    }
    await this.streamingBuffer.addEvents(
      historyFilePath,
      target,
      runIndex,
      attemptIndex,
      events,
      phase
    );
  }

  /** Record the final state of an attempt after its response/error has landed. */
  async recordAttemptTerminal(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    terminalState: TimelineAttemptTerminalState,
    definitionContext?: DefinitionRevisionContext,
    reason?: string
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }
    await this.timelineRecorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: Date.now(),
        target,
        runIndex,
        attemptIndex,
        definitionRevision: definitionContext?.definitionRevision ?? 1,
        payload: { terminalState, reason },
      },
    ]);
  }

  /** Persist lossless script process data before runtime metadata can be replaced. */
  async recordScriptExecution(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    scriptOutput: {
      command: string;
      stdout: string;
      stderr: string;
      exitCode?: number;
    },
    definitionContext?: DefinitionRevisionContext,
    phase?: ExecutionPhase
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }
    await this.timelineRecorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED,
        timestampMs: Date.now(),
        target,
        runIndex,
        attemptIndex,
        phase,
        definitionRevision: definitionContext?.definitionRevision ?? 1,
        payload: scriptOutput,
      },
    ]);
  }

  /** Persist the exact retry input before the retry attempt is sent. */
  async recordRetryScheduled(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    previousAttemptIndex: number,
    retryPrompt: string,
    definitionContext?: DefinitionRevisionContext
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }
    await this.timelineRecorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.RETRY_SCHEDULED,
        timestampMs: Date.now(),
        target,
        runIndex,
        attemptIndex,
        definitionRevision: definitionContext?.definitionRevision ?? 1,
        payload: { retryPrompt, previousAttemptIndex },
      },
    ]);
  }

  /** Persist asynchronous post-completion activity before mutable runtime text is updated. */
  async recordFollowUpResponse(
    historyFilePath: string,
    target: OutputExecutionTarget,
    runIndex: number,
    attemptIndex: number,
    responseText: string,
    events: CliEvent[],
    contextWindow: { used: number; size: number } | undefined,
    definitionContext?: DefinitionRevisionContext
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }
    await this.timelineRecorder.appendEvents(historyFilePath, [
      {
        eventType: TIMELINE_EVENT_TYPES.FOLLOW_UP_RESPONSE_APPENDED,
        timestampMs: Date.now(),
        target,
        runIndex,
        attemptIndex,
        definitionRevision: definitionContext?.definitionRevision ?? 1,
        payload: {
          responseTextLength: responseText.length,
          eventCount: events.length,
          contextWindow,
        },
      },
    ]);
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
      phase: flush.phase,
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
      const events = await this.timelineRecorder.appendEvents(historyFilePath, [
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
      await this.applyTokenEvents(
        historyFilePath,
        events,
        isTerminalExecutionState(transition.current.status) ? true : undefined
      );
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
      if (isTerminalExecutionState(transition.current.status)) {
        this.feedUsageStores(historyFilePath);
      }
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
    stepCount: number,
    activeExecutionMs?: number
  ): Promise<void> {
    if (!historyFilePath) {
      return;
    }

    try {
      await this.streamingBuffer.flush(historyFilePath);
      const completedAt = Date.now();
      const events = await this.timelineRecorder.appendEvents(historyFilePath, [
        {
          eventType: TIMELINE_EVENT_TYPES.RUN_TERMINATED,
          timestampMs: completedAt,
          payload: { executionState, stepCount },
        },
      ]);
      await this.applyTokenEvents(historyFilePath, events, true);
      await this.timelineRecorder.updateManifest(
        historyFilePath,
        (manifest) => ({
          ...manifest,
          completedAt,
          ...(activeExecutionMs !== undefined ? { activeExecutionMs } : {}),
          executionState,
          stepCount,
          lastUpdatedAt: completedAt,
        })
      );
      this.feedUsageStores(historyFilePath);
      this.refreshSearchIndex();
    } catch (error) {
      Log.warn("Failed to finalize history run:", error);
    }
  }

  /** Reopen one known manifest for an explicit same-run continuation. */
  async reopenRun(
    historyFilePath: string,
    executionState: ExecutionState,
    definitionRevision: number,
    stepCount: number
  ): Promise<void> {
    if (!historyFilePath) {
      throw new Error("Cannot reopen a run without a manifest path");
    }
    await this.streamingBuffer.flush(historyFilePath);
    await this.timelineRecorder.reopenRun(
      historyFilePath,
      executionState,
      definitionRevision,
      stepCount
    );
    await this.hydrateTokenTotals(historyFilePath);
    const reducer = this.tokenReducers.get(historyFilePath);
    const totals = reducer?.setFinal(false);
    if (totals) {
      await this.persistTokenTotals(historyFilePath, totals);
    }
    this.refreshSearchIndex();
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
      const totals = await this.hydrateTokenTotals(historyFilePath);
      if (manifest.executionState === EXECUTION_STATES.RUNNING) {
        await this.finalizeRun(
          historyFilePath,
          EXECUTION_STATES.STOPPED,
          stepCount
        );
      }
      const recoveredTotals =
        this.tokenReducers.get(historyFilePath)?.snapshot() ?? totals;
      if (recoveredTotals) {
        await this.repairWorkingFileTokenTotals(
          workflowKey,
          latestRun,
          recoveredTotals
        );
      }
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
    const enriched = await this.enrichSnapshotsInHistory(history);
    try {
      const runFilePath = path.join(
        path.dirname(historyFilePath),
        WorkflowPaths.WORKING_FILE_NAME
      );
      const workingFile = JSON.parse(
        await fs.promises.readFile(runFilePath, "utf8")
      ) as {
        _runtime?: {
          worktree?: import("../../types/CtrlYokeTypes").WorkingFileWorktreeRuntime;
          worktreeNotice?: string;
        };
      };
      enriched.worktree = projectWorktreeRuntime(workingFile._runtime?.worktree);
      enriched.worktreeNotice = workingFile._runtime?.worktreeNotice;
    } catch {
      // Older or partially recovered runs may not have a working file. The
      // timeline remains renderable without a worktree projection.
    }
    return enriched;
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
   * Cheap run-count plus the latest run's manifest `runId`, for workflow-list rows that
   * need to know whether a lineage is drillable without loading every run's summary.
   * `runCount` comes from `getRunsForWorkflow` (directory listing only, no manifest I/O),
   * so a corrupted non-latest run directory still counts — validating every run's
   * manifest just to produce a list-row count would reintroduce the per-run cost this
   * method exists to avoid. Only the newest run's manifest is read, for `primaryRunId`.
   */
  async getRunNavigationSummary(
    workflowKey: WorkflowKey
  ): Promise<{ runCount: number; primaryRunId?: number }> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    if (runs.length === 0) {
      return { runCount: 0 };
    }
    try {
      const manifest = await this.timelineRecorder.readManifest(
        this.getHistoryFilePath(workflowKey, runs[0])
      );
      return { runCount: runs.length, primaryRunId: manifest.runId };
    } catch (error) {
      Log.warn(
        `[OutputHistoryManager] getRunNavigationSummary: latest run manifest unreadable for ${workflowKey}/${runs[0]}:`,
        error
      );
      return { runCount: runs.length };
    }
  }

  /**
   * Manifest-only run listing for a lineage, newest first. Reads each run's
   * manifest.json plus its workflow.ctrlyoke.json (for harness/model disclosure only —
   * no output events are loaded). Runs whose manifest cannot be read are treated as
   * recovery candidates and excluded rather than returned as malformed rows.
   */
  async getRunSummaries(workflowKey: WorkflowKey): Promise<RunSummary[]> {
    return (await this.getRunSummaryRecords(workflowKey)).map(
      (record) => record.summary
    );
  }

  /**
   * Batched read of every run's summary plus the manifest's own lifecycle state.
   *
   * The manifest copy is deliberately kept alongside the resolved summary rather
   * than discarded: display answers "what state is this run in" (the working file
   * wins — see `readRunSummaryRecord`), while deletion safety answers "could this
   * run be active" and must not narrow as a side effect of that. Both come from
   * the same pair of file reads, so carrying the extra field is free and keeps
   * `RunSummary` — a webview-facing contract — free of protection plumbing.
   */
  private async getRunSummaryRecords(
    workflowKey: WorkflowKey
  ): Promise<RunSummaryRecord[]> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    const records: Array<RunSummaryRecord | null> = [];
    for (
      let startIndex = 0;
      startIndex < runs.length;
      startIndex += RUN_SUMMARY_READ_BATCH_SIZE
    ) {
      const batch = runs.slice(
        startIndex,
        startIndex + RUN_SUMMARY_READ_BATCH_SIZE
      );
      records.push(
        ...(await Promise.all(
          batch.map((runRef) => this.readRunSummaryRecord(workflowKey, runRef))
        ))
      );
    }
    return records.filter(
      (record): record is RunSummaryRecord => record !== null
    );
  }

  private async readRunSummaryRecord(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<RunSummaryRecord | null> {
    const historyFilePath = this.getHistoryFilePath(workflowKey, runRef);
    const runFilePath = WorkflowPaths.runFilePath(
      this._workspaceFolderPath,
      workflowKey,
      runRef
    );
    const runDirectoryPath = WorkflowPaths.runDir(
      this._workspaceFolderPath,
      workflowKey,
      runRef
    );

    // Stamp before reading — see `stampRunFiles`. The executing run stamps
    // differently on every read and so is a permanent miss, which is correct:
    // the cache is here for the runs that have stopped changing.
    const stamp = await stampRunFiles(historyFilePath, runFilePath);
    const cached = lookupRunSummary(runDirectoryPath, stamp);
    if (cached) {
      return cached;
    }

    try {
      const manifest =
        await this.timelineRecorder.readManifest(historyFilePath);
      const {
        executionState,
        executionEndTime,
        primaryHarness,
        primaryModel,
        hasMixedHarnesses,
        hasMixedModels,
        tokenTotals,
        worktree,
        worktreeNotice,
      } = await this.readRunFileSummaryFields(runFilePath);

      const record: RunSummaryRecord = {
        manifestExecutionState: manifest.executionState,
        summary: {
          workflowKey,
          runRef,
          runId: manifest.runId,
          startedAt: manifest.startedAt,
          // The run's own working file wins over the manifest's denormalized
          // copy whenever the two disagree. `_runtime.executionState` is written
          // on every transition by the executor itself, while the manifest copy
          // is written by a separate best-effort path that can be skipped
          // entirely (see `appendRuntimeTransition`'s empty-path early return) —
          // so the manifest can lag permanently behind a run that actually
          // finished. Reading it here is free: this file is already open for
          // harness disclosure. Manifest values remain the fallback for a run
          // whose working file is missing or unreadable.
          completedAt: executionEndTime ?? manifest.completedAt,
          executionState: executionState ?? manifest.executionState,
          definitionRevision: manifest.definitionRevision,
          stepCount: manifest.stepCount,
          primaryHarness,
          primaryModel,
          hasMixedHarnesses,
          hasMixedModels,
          tokenTotals: tokenTotals ?? manifest.tokenTotals,
          worktree,
          worktreeNotice,
        },
      };

      storeRunSummary(runDirectoryPath, stamp, record);
      return record;
    } catch (error) {
      // Deliberately not cached: an unreadable manifest means a recovery
      // candidate, and caching the failure would keep it excluded from the
      // listing after a recovery pass repaired it.
      Log.warn(
        `[OutputHistoryManager] getRunSummaries: skipping unreadable run ${workflowKey}/${runRef}:`,
        error
      );
      return null;
    }
  }

  /**
   * Best-effort read of a run's `workflow.ctrlyoke.json` for summary purposes.
   * @internal see `getRunSummaryRecords`
   *
   * Harness/model disclosure is the resolved value each queue step actually
   * executed with (`_runtime.harness`/`_runtime.model`), falling back to its
   * declared step/workflow-level override for steps that have not executed yet.
   * Script-only runs and runs whose steps disclose nothing report both as
   * undefined.
   *
   * Also returns the run's own lifecycle state, which `readRunSummary` prefers
   * over the manifest's copy — see the divergence note there.
   */
  private async readRunFileSummaryFields(runFilePath: string): Promise<{
    executionState?: ExecutionState;
    executionEndTime?: number;
    tokenTotals?: WorkflowTokenTotals;
    worktree?: WorktreeRunProjection;
    worktreeNotice?: string;
    primaryHarness?: string;
    primaryModel?: string;
    hasMixedHarnesses: boolean;
    hasMixedModels: boolean;
  }> {
    try {
      const content = await fs.promises.readFile(runFilePath, "utf8");
      const workingFile = JSON.parse(content) as {
        harness?: string;
        model?: string;
        _runtime?: {
          executionState?: ExecutionState;
          executionEndTime?: number;
          tokenTotals?: WorkflowTokenTotals;
          worktree?: import("../../types/CtrlYokeTypes").WorkingFileWorktreeRuntime;
          worktreeNotice?: string;
        };
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
        executionState: workingFile._runtime?.executionState,
        executionEndTime: workingFile._runtime?.executionEndTime,
        tokenTotals: workingFile._runtime?.tokenTotals,
        worktree: projectWorktreeRuntime(workingFile._runtime?.worktree),
        worktreeNotice: workingFile._runtime?.worktreeNotice,
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
  async pruneOldRuns(
    workflowKey: WorkflowKey,
    maxRuns: number,
    inFlightRunRefs: ReadonlySet<RunRef> = new Set()
  ): Promise<void> {
    // -1 or 0 means keep all runs
    if (maxRuns <= 0) {
      return;
    }

    const runs = await this.getRunsForWorkflow(workflowKey);
    if (runs.length <= maxRuns) {
      return;
    }

    const protectedRunRefs = await this.getProtectedRunRefs(
      workflowKey,
      inFlightRunRefs
    );
    // The newest completed rows remain the normal retention set. Additional
    // protected rows may temporarily exceed the configured limit, while older
    // eligible rows are removed without retargeting an in-flight source/target.
    for (const runRef of runs.slice(0, maxRuns)) {
      protectedRunRefs.add(runRef);
    }
    const toDelete = runs.filter((runRef) => !protectedRunRefs.has(runRef));
    for (const runRef of toDelete) {
      try {
        await this.lineageRepository.deleteRun(
          this._workspaceFolderPath,
          workflowKey,
          runRef,
          protectedRunRefs
        );
      } catch (error) {
        Log.warn(`Failed to delete old run ${runRef}:`, error);
      }
    }
    if (toDelete.length > 0) {
      await this.refreshSearchIndex();
    }
  }

  /** Delete one stable run identity. Callers must never resolve a display index late. */
  async deleteRunByRef(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<number> {
    const runs = await this.getRunsForWorkflow(workflowKey);
    if (!runs.includes(runRef)) {
      throw new Error(
        `Run ${runRef} does not exist for workflow ${workflowKey}`
      );
    }
    const protectedRunRefs = await this.getProtectedRunRefs(workflowKey);
    await this.lineageRepository.deleteRun(
      this._workspaceFolderPath,
      workflowKey,
      runRef,
      protectedRunRefs
    );
    // Returning only after the refreshed documents land makes a deleted run
    // unreachable through search as well as through the run list.
    await this.refreshSearchIndex();
    return (await this.getRunsForWorkflow(workflowKey)).length;
  }

  private async getProtectedRunRefs(
    workflowKey: WorkflowKey,
    inFlightRunRefs: ReadonlySet<RunRef> = new Set()
  ): Promise<Set<RunRef>> {
    const protectedRunRefs = new Set(inFlightRunRefs);
    try {
      const descriptor = JSON.parse(
        await fs.promises.readFile(
          WorkflowPaths.descriptorPath(this._workspaceFolderPath, workflowKey),
          "utf8"
        )
      ) as import("../../types/CtrlYokeTypes").WorkflowLineageDescriptor;
      if (descriptor.pendingEdit?.kind === "rewind") {
        protectedRunRefs.add(descriptor.pendingEdit.runRef);
      }
    } catch {
      // A missing/corrupt descriptor cannot make an active run safe to delete.
    }
    // Deletion protection takes the *union* of both lifecycle records, unlike
    // display which prefers the working file's. The two answer different
    // questions: "what state is this run in" has one right answer, but "could
    // this run still be owned by an executor" must stay conservative — keeping a
    // finished run costs nothing, deleting a live one is unrecoverable. The case
    // that splits them is a run seeded for immediate execution but not yet
    // started (manifest already RUNNING, working file still idle): during that
    // window no instance or lock names it, so the manifest is its only
    // protection and it must survive a bulk delete. A run seeded *without*
    // execution (Set start position on the first step) records IDLE in both and
    // is deliberately deletable — nothing owns it.
    for (const {
      summary,
      manifestExecutionState,
    } of await this.getRunSummaryRecords(workflowKey)) {
      if (
        ACTIVE_EXECUTION_STATES.has(summary.executionState) ||
        ACTIVE_EXECUTION_STATES.has(manifestExecutionState)
      ) {
        protectedRunRefs.add(summary.runRef);
      }
    }
    const lock = await WorkflowLockManager.readLock(
      this._workspaceFolderPath,
      workflowKey
    );
    const lockStatus = await WorkflowLockManager.checkLock(
      this._workspaceFolderPath,
      workflowKey
    );
    if (
      lock &&
      lockStatus !== LOCK_STATUS.NONE &&
      lockStatus !== LOCK_STATUS.STALE
    ) {
      protectedRunRefs.add(lock.runRef);
    }
    return protectedRunRefs;
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
    definitionRevision?: number,
    phase?: ExecutionPhase
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
        phase,
        definitionRevision,
        responseKind: cliOutput.source
          ? TIMELINE_ATTEMPT_KINDS.SCRIPT
          : TIMELINE_ATTEMPT_KINDS.AI,
        payload: { cliOutput },
      })
    );

    eventDrafts.sort((left, right) => left.timestampMs - right.timestampMs);
    const events = await this.timelineRecorder.appendEvents(
      historyFilePath,
      eventDrafts
    );
    await this.applyTokenEvents(historyFilePath, events);
    this.refreshSearchIndex();
  }

  private async applyTokenEvents(
    historyFilePath: string,
    events: readonly import("../../types/WorkflowTimelineTypes").WorkflowTimelineEvent[],
    isFinal?: boolean
  ): Promise<void> {
    await this.hydrateTokenTotals(historyFilePath);
    const reducer = this.tokenReducers.get(historyFilePath);
    if (!reducer) {
      return;
    }
    const totals = reducer.appendEvents(events, { isFinal });
    if (totals) {
      await this.persistTokenTotals(historyFilePath, totals);
    }
  }

  /** Repair the fast-path copy during startup recovery without rescanning on list reads. */
  private async repairWorkingFileTokenTotals(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    tokenTotals: WorkflowTokenTotals
  ): Promise<void> {
    const runFilePath = WorkflowPaths.runFilePath(
      this._workspaceFolderPath,
      workflowKey,
      runRef
    );
    try {
      const workingFile = JSON.parse(
        await fs.promises.readFile(runFilePath, "utf8")
      ) as {
        _runtime?: Record<string, unknown>;
      };
      if (
        JSON.stringify(workingFile._runtime?.tokenTotals) ===
        JSON.stringify(tokenTotals)
      ) {
        return;
      }
      const updated = {
        ...workingFile,
        _runtime: {
          ...(workingFile._runtime ?? {}),
          tokenTotals,
        },
      };
      const tempPath = `${runFilePath}.token-totals.tmp`;
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify(updated, null, 2),
        "utf8"
      );
      await fs.promises.rename(tempPath, runFilePath);
    } catch (error) {
      Log.warn(
        `[OutputHistoryManager] failed to repair working-file token totals for ${workflowKey}/${runRef}:`,
        error
      );
    }
  }

  private async persistTokenTotals(
    historyFilePath: string,
    tokenTotals: WorkflowTokenTotals
  ): Promise<void> {
    await this.timelineRecorder.updateManifest(historyFilePath, (manifest) => {
      if (
        JSON.stringify(manifest.tokenTotals) === JSON.stringify(tokenTotals)
      ) {
        return manifest;
      }
      return { ...manifest, tokenTotals };
    });
    await this.tokenTotalsChangedHandler?.(historyFilePath, tokenTotals);
  }

  /**
   * Feed the workspace rollup only after the terminal aggregate is durable in
   * the run manifest. This is deliberately fire-and-forget: usage persistence
   * must never delay or fail a workflow terminal transition.
   */
  private feedUsageStores(historyFilePath: string): void {
    if (!ConfigurationUtils.shouldPersistObservedHarnessUsage()) return;
    const address = WorkflowPaths.parseRunArtifactPath(
      this._workspaceFolderPath,
      historyFilePath
    );
    if (!address || address.fileName !== TIMELINE_STORAGE_FILES.MANIFEST) {
      return;
    }
    this.pendingObservedUsageFeed = this.pendingObservedUsageFeed
      .then(async () => {
        const manifest =
          await this.timelineRecorder.readManifest(historyFilePath);
        const lifetimeContribution = contributionFromManifest(
          address.workflowKey,
          address.runRef,
          manifest
        );
        await Promise.all([
          this.observedHarnessUsageStore.upsertRunContribution(
            address.workflowKey,
            address.runRef,
            manifest.tokenTotals,
            manifest.lastUpdatedAt
          ),
          this.lifetimeUsageStore.upsertRunContribution(
            lifetimeContribution,
            manifest.lastUpdatedAt
          ),
        ]);
      })
      .catch((error) => {
        Log.warn("Failed to persist usage rollups:", error);
      });
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

  /**
   * Kick off a search-index refresh without blocking the history write. The
   * index service coalesces bursts internally, so firing this after every
   * append is cheap. Awaiting it here previously stalled workflow completion on
   * a full index rebuild (and contributed to the extension-host OOM).
   */
  private refreshSearchIndex(): Promise<void> {
    this.pendingIndexRefresh = this.historySearchIndexService
      .enqueueWorkspaceRefresh(this._workspaceFolderPath)
      .catch(() => {
        /* index refresh failures are logged inside the index service */
      });
    return this.pendingIndexRefresh;
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
