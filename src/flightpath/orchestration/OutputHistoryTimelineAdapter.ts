import {
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
} from "../../types/DashboardConstants";
import type {
  OrderedHistoryEntry,
  OutputExecutionTarget,
  StepOutput,
  WorkflowOutputHistory,
} from "../../types/OutputHistoryTypes";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import { TimelineRecorder } from "./TimelineRecorder";

export class OutputHistoryTimelineAdapter {
  constructor(
    private readonly recorder: TimelineRecorder = new TimelineRecorder()
  ) {}

  async loadHistory(manifestPath: string): Promise<WorkflowOutputHistory> {
    const [manifest, events] = await Promise.all([
      this.recorder.readManifest(manifestPath),
      this.recorder.readEvents(manifestPath),
    ]);

    return this.project(manifest, events);
  }

  project(
    manifest: WorkflowRunManifest,
    events: WorkflowTimelineEvent[]
  ): WorkflowOutputHistory {
    const history: WorkflowOutputHistory = {
      schemaVersion: "1.1.0",
      workflowId: manifest.workflowId,
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      executionState: manifest.executionState,
      promptOutputs: {},
      orderedEntries: [],
    };
    const orderedEntries: OrderedHistoryEntry[] = [];
    const cliEntriesByKey = new Map<string, OrderedHistoryEntry>();

    for (const event of [...events].sort(compareTimelineEvents)) {
      switch (event.eventType) {
        case TIMELINE_EVENT_TYPES.WORKFLOW_RUNTIME_TRANSITION_RECORDED:
          orderedEntries.push({
            kind: OUTPUT_HISTORY_KINDS.RUNTIME,
            timestampMs: event.timestampMs,
            sequence: event.sequence,
            transition: event.payload.transition,
          });
          break;
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED: {
          const runIndex = event.runIndex ?? 0;
          const attemptIndex = event.attemptIndex;
          cliEntriesByKey.set(
            getCliEntryKey(event.target, runIndex, attemptIndex),
            {
            kind: OUTPUT_HISTORY_KINDS.CLI,
            target: event.target,
            runIndex,
            attemptIndex,
            cliOutput: event.payload.cliOutput,
            timestampMs: event.timestampMs,
            sequence: event.sequence,
            }
          );
          break;
        }
        case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
          orderedEntries.push({
            kind: OUTPUT_HISTORY_KINDS.STATUS,
            target: event.target,
            statusMessage: event.payload.statusMessage,
            timestampMs: event.timestampMs,
            sequence: event.sequence,
          });
          break;
        case TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED:
        case TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_UPDATED:
          this.ensureStepOutput(history, event.target).workspaceSnapshot =
            event.payload.workspaceSnapshot;
          break;
        case TIMELINE_EVENT_TYPES.UNDO_APPLIED:
        case TIMELINE_EVENT_TYPES.REDO_APPLIED:
        case TIMELINE_EVENT_TYPES.UNDO_RECORD_UPDATED:
          this.ensureStepOutput(history, event.target).undoRecord =
            event.payload.undoRecord;
          break;
      }
    }

    history.orderedEntries = [
      ...orderedEntries,
      ...cliEntriesByKey.values(),
    ].sort(compareOrderedHistoryEntries);

    if (
      history.finalStepOutputs &&
      Object.keys(history.finalStepOutputs).length === 0
    ) {
      delete history.finalStepOutputs;
    }

    return history;
  }

  private ensureStepOutput(
    history: WorkflowOutputHistory,
    target: OutputExecutionTarget
  ): StepOutput {
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      history.promptOutputs[target.stepIndex] ??= {};
      return history.promptOutputs[target.stepIndex];
    }

    history.finalStepOutputs ??= {};
    history.finalStepOutputs[target.loopIndex] ??= {};
    return history.finalStepOutputs[target.loopIndex];
  }
}

function compareTimelineEvents(
  left: WorkflowTimelineEvent,
  right: WorkflowTimelineEvent
): number {
  return left.timestampMs - right.timestampMs || left.sequence - right.sequence;
}

function getCliEntryKey(
  target: OutputExecutionTarget,
  runIndex: number,
  attemptIndex: number
): string {
  const base =
    target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  return `${base}:run:${runIndex}:attempt:${attemptIndex}`;
}

function compareOrderedHistoryEntries(
  left: OrderedHistoryEntry,
  right: OrderedHistoryEntry
): number {
  return left.timestampMs - right.timestampMs || left.sequence - right.sequence;
}
