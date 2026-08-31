import {
  FINAL_STEP_PHASES,
  type ExecutionPhase,
} from "../../types/DashboardConstants";
import type {
  OutputExecutionTarget,
  UndoRecord,
  WorkspaceSnapshot,
} from "../../types/OutputHistoryTypes";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import { TimelineRecorder } from "./TimelineRecorder";

/**
 * Narrow, streaming reads of a run's timeline for bookkeeping checks that only
 * need one small field (a snapshot, an undo record, a max index) rather than a
 * full `OutputHistoryTimelineAdapter.loadHistory()` projection. Each method
 * streams `events.jsonl` once via `TimelineRecorder.streamEvents` and never
 * materializes CLI response text, so repeated per-step bookkeeping checks on a
 * long-running workflow stay proportional to that run's event count instead of
 * re-parsing and re-hydrating the whole run on every call.
 */
export class RunMetadataScanner {
  constructor(
    private readonly recorder: TimelineRecorder = new TimelineRecorder()
  ) {}

  /** Latest workspace snapshot recorded for `target`, or undefined if none. */
  async findLatestWorkspaceSnapshot(
    manifestPath: string,
    target: OutputExecutionTarget
  ): Promise<WorkspaceSnapshot | undefined> {
    const targetKey = getTargetKey(target);
    let snapshot: WorkspaceSnapshot | undefined;
    for await (const event of this.recorder.streamEvents(manifestPath)) {
      if (
        (event.eventType ===
          TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED ||
          event.eventType ===
            TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_UPDATED) &&
        getTargetKey(event.target) === targetKey
      ) {
        snapshot = event.payload.workspaceSnapshot;
      }
    }
    return snapshot;
  }

  /** Latest undo record recorded for `target`, or undefined if none. */
  async findLatestUndoRecord(
    manifestPath: string,
    target: OutputExecutionTarget
  ): Promise<UndoRecord | undefined> {
    const targetKey = getTargetKey(target);
    let undoRecord: UndoRecord | undefined;
    for await (const event of this.recorder.streamEvents(manifestPath)) {
      if (
        (event.eventType === TIMELINE_EVENT_TYPES.UNDO_APPLIED ||
          event.eventType === TIMELINE_EVENT_TYPES.REDO_APPLIED ||
          event.eventType === TIMELINE_EVENT_TYPES.UNDO_RECORD_UPDATED) &&
        getTargetKey(event.target) === targetKey
      ) {
        undoRecord = event.payload.undoRecord;
      }
    }
    return undoRecord;
  }

  /** Next attempt index: one past the highest recorded CLI attempt in `phase` (0 if none). */
  async findNextAttemptIndexForPhase(
    manifestPath: string,
    phase: ExecutionPhase
  ): Promise<number> {
    let nextAttemptIndex = 0;
    for await (const event of this.recorder.streamEvents(manifestPath)) {
      if (
        event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED &&
        event.phase === phase
      ) {
        nextAttemptIndex = Math.max(nextAttemptIndex, event.attemptIndex + 1);
      }
    }
    return nextAttemptIndex;
  }

  /**
   * Next run index (one past the highest recorded CLI `runIndex`) for each
   * target named in `targetKeys`. Keys use the same `queue:<index>` /
   * `final:<index>` format as `getTargetKey` here and the equivalent helpers
   * in `RunOutputResolver`/`OutputHistoryTimelineAdapter`/`WorkflowInstance`.
   */
  async findNextRunIndexByTarget(
    manifestPath: string,
    targetKeys: ReadonlySet<string>
  ): Promise<Map<string, number>> {
    const maxRunIndexByTarget = new Map<string, number>();
    for await (const event of this.recorder.streamEvents(manifestPath)) {
      if (event.eventType !== TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED) {
        continue;
      }
      const key = getTargetKey(event.target);
      if (!targetKeys.has(key)) {
        continue;
      }
      const runIndex = event.runIndex ?? event.payload.cliOutput.runIndex ?? 0;
      maxRunIndexByTarget.set(
        key,
        Math.max(maxRunIndexByTarget.get(key) ?? -1, runIndex)
      );
    }

    const nextRunIndexByTarget = new Map<string, number>();
    for (const [key, maxRunIndex] of maxRunIndexByTarget) {
      nextRunIndexByTarget.set(key, maxRunIndex + 1);
    }
    return nextRunIndexByTarget;
  }
}

function getTargetKey(target: OutputExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `queue:${target.stepIndex}`
    : `final:${target.loopIndex}`;
}
