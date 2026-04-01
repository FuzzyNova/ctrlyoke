import { FINAL_PROMPT_PHASES } from "../../types/DashboardConstants";
import type {
  OutputExecutionTarget,
  OutputTimelineEntry,
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
      runStepCount: manifest.runStepCount,
      promptOutputs: {},
    };
    const outputTimelineByKey = new Map<string, OutputTimelineEntry>();

    for (const event of [...events].sort(compareTimelineEvents)) {
      switch (event.eventType) {
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED: {
          const stepOutput = this.ensureStepOutput(history, event.target);
          const attemptIndex = event.attemptIndex;
          const existingIndex = stepOutput.cliOutputs.findIndex(
            (output) => (output.attemptIndex ?? 0) === attemptIndex
          );

          if (existingIndex >= 0) {
            stepOutput.cliOutputs[existingIndex] = event.payload.cliOutput;
          } else {
            stepOutput.cliOutputs.push(event.payload.cliOutput);
          }

          stepOutput.cliOutputs.sort(
            (left, right) =>
              (left.attemptIndex ?? 0) - (right.attemptIndex ?? 0)
          );

          const firstOutputAt =
            event.payload.cliOutput.timestampMs ?? event.timestampMs;
          const key = getTimelineKey(event.target);
          const existingEntry = outputTimelineByKey.get(key);
          if (!existingEntry || firstOutputAt < existingEntry.firstOutputAt) {
            outputTimelineByKey.set(key, {
              key,
              target: event.target,
              firstOutputAt,
            });
          }
          break;
        }
        case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
          this.ensureStepOutput(history, event.target).statusMessages.push(
            event.payload.statusMessage
          );
          break;
        case TIMELINE_EVENT_TYPES.STATUS_MESSAGES_UPDATED:
          this.ensureStepOutput(history, event.target).statusMessages =
            event.payload.statusMessages;
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

    const outputTimeline = [...outputTimelineByKey.values()].sort(
      (left, right) => left.firstOutputAt - right.firstOutputAt
    );
    if (outputTimeline.length > 0) {
      history.outputTimeline = outputTimeline;
    }

    if (
      history.finalPromptOutputs &&
      Object.keys(history.finalPromptOutputs).length === 0
    ) {
      delete history.finalPromptOutputs;
    }

    return history;
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
}

function compareTimelineEvents(
  left: WorkflowTimelineEvent,
  right: WorkflowTimelineEvent
): number {
  return left.timestampMs - right.timestampMs || left.sequence - right.sequence;
}

function getTimelineKey(target: OutputExecutionTarget): string {
  return target.kind === FINAL_PROMPT_PHASES.QUEUE
    ? `queue:${target.stepIndex}`
    : `final:${target.loopIndex}`;
}
