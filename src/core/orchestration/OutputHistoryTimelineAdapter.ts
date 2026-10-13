import {
  FINAL_STEP_PHASES,
  getExecutionPhaseKeySuffix,
  IN_FLIGHT_EXECUTION_STATES,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_HISTORY_KINDS,
  RUN_OUTPUT_RESOLVER_EVENT_KINDS,
  type ExecutionPhase,
} from "../../types/DashboardConstants";
import type {
  OrderedHistoryEntry,
  OutputActivityEntry,
  OutputExecutionTarget,
  StepOutput,
  WorkflowOutputHistory,
} from "../../types/OutputHistoryTypes";
import type { OrderedCliHistoryEntry } from "../../types/OutputHistoryTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import { StreamingCliOutputAccumulator } from "../../utils/StreamingCliOutputAccumulator";
import {
  TIMELINE_EVENT_TYPES,
  type CliOutputChunkAppendedEvent,
  type CliOutputEventsAppendedEvent,
  type WorkflowRunManifest,
  type WorkflowTimelineEvent,
} from "../../types/WorkflowTimelineTypes";
import { TimelineRecorder } from "./TimelineRecorder";
import { RunOutputResolver } from "./RunOutputResolver";

export class OutputHistoryTimelineAdapter {
  private readonly outputResolver: RunOutputResolver;

  constructor(
    private readonly recorder: TimelineRecorder = new TimelineRecorder()
  ) {
    this.outputResolver = new RunOutputResolver(recorder);
  }

  async loadHistory(manifestPath: string): Promise<WorkflowOutputHistory> {
    const [manifest, events] = await Promise.all([
      this.recorder.readManifest(manifestPath),
      this.recorder.readEvents(manifestPath),
    ]);

    const history = this.project(manifest, events);
    await this.hydrateCliOutputsFromResolver(manifest, events, history);
    return history;
  }

  /**
   * History retains its ordered snapshot/undo projection, while every CLI
   * response and preview is replaced with the resolver's append-order view.
   * This removes the adapter's separate response reconstruction path.
   *
   * Takes the manifest/events already read by `loadHistory` and hands them to
   * `streamFromEvents` rather than `RunOutputResolver.stream`, so the run's
   * `events.jsonl` is parsed once per load instead of twice.
   */
  private async hydrateCliOutputsFromResolver(
    manifest: WorkflowRunManifest,
    events: WorkflowTimelineEvent[],
    history: WorkflowOutputHistory
  ): Promise<void> {
    const outputs = new Map<string, CliOutput>();
    const scriptOutputs = new Map<string, NonNullable<CliOutput["scriptOutput"]>>();
    // Deltas are buffered rather than folded in per batch; see
    // `StreamingCliOutputAccumulator` for why that matters on a large run.
    const deltas = new StreamingCliOutputAccumulator();
    for await (const event of this.outputResolver.streamFromEvents(
      manifest,
      events
    )) {
      if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.OUTPUT) {
        const key = getCliEntryKey(
          event.attempt.target,
          event.attempt.runIndex,
          event.attempt.attemptIndex,
          event.attempt.phase
        );
        // A fresh aggregate replaces the attempt's output wholesale, so every
        // delta buffered before it is superseded.
        deltas.discard(key);
        outputs.set(key, event.attempt.output);
      } else if (event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.SCRIPT_EXECUTION) {
        scriptOutputs.set(
          getCliEntryKey(
            event.attempt.target,
            event.attempt.runIndex,
            event.attempt.attemptIndex,
            event.attempt.phase
          ),
          event.scriptOutput
        );
      } else if (
        event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_CHUNK
      ) {
        deltas.appendChunk(
          getCliEntryKey(
            event.attempt.target,
            event.attempt.runIndex,
            event.attempt.attemptIndex,
            event.attempt.phase
          ),
          event.chunk
        );
      } else if (
        event.kind === RUN_OUTPUT_RESOLVER_EVENT_KINDS.STREAMING_EVENTS
      ) {
        deltas.appendEvents(
          getCliEntryKey(
            event.attempt.target,
            event.attempt.runIndex,
            event.attempt.attemptIndex,
            event.attempt.phase
          ),
          event.events
        );
      }
    }
    for (const key of [...deltas.keys()]) {
      const output = outputs.get(key);
      if (output?.isStreaming) {
        outputs.set(key, deltas.flush(key, output));
      } else {
        deltas.discard(key);
      }
    }
    for (const entry of history.orderedEntries) {
      if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) continue;
      const output = outputs.get(
        getCliEntryKey(
          entry.target,
          entry.runIndex ?? 0,
          entry.attemptIndex,
          entry.phase
        )
      );
      if (output) entry.cliOutput = output;
      const scriptOutput = scriptOutputs.get(
        getCliEntryKey(
          entry.target,
          entry.runIndex ?? 0,
          entry.attemptIndex,
          entry.phase
        )
      );
      if (scriptOutput && output) {
        entry.cliOutput = { ...output, scriptOutput };
      }
      if (
        output &&
        !IN_FLIGHT_EXECUTION_STATES.has(history.executionState) &&
        output.isStreaming
      ) {
        entry.cliOutput = { ...output, isStreaming: false };
      }
    }
  }

  project(
    manifest: WorkflowRunManifest,
    events: WorkflowTimelineEvent[]
  ): WorkflowOutputHistory {
    const history: WorkflowOutputHistory = {
      workflowId: manifest.workflowId,
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      executionState: manifest.executionState,
      promptOutputs: {},
      orderedEntries: [],
      activityEntries: [],
    };
    const orderedEntries: OrderedHistoryEntry[] = [];
    const activityEntries: OutputActivityEntry[] = [];
    const cliEntriesByKey = new Map<string, OrderedCliHistoryEntry>();
    const scriptOutputs = new Map<string, NonNullable<CliOutput["scriptOutput"]>>();
    /**
     * Attempts whose completed aggregate has already been projected. The final
     * `cliOutputRecorded` carries the attempt's *start* timestamp, so it sorts
     * ahead of the streamed deltas it supersedes. Without this seal those
     * deltas would be appended a second time onto an already-complete response.
     */
    const sealedCliKeys = new Set<string>();

    /**
     * Deltas are buffered per attempt and folded into their entry once, after
     * the event walk; see `StreamingCliOutputAccumulator`.
     */
    const deltas = new StreamingCliOutputAccumulator();

    /** The key of the still-streaming entry a delta belongs to, or undefined once sealed. */
    const resolveStreamingKey = (
      event: CliOutputChunkAppendedEvent | CliOutputEventsAppendedEvent
    ): string | undefined => {
      const key = getCliEntryKey(
        event.target,
        event.runIndex ?? 0,
        event.attemptIndex,
        event.phase
      );
      return sealedCliKeys.has(key) || !cliEntriesByKey.has(key)
        ? undefined
        : key;
    };

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
          const key = getCliEntryKey(
            event.target,
            runIndex,
            attemptIndex,
            event.phase
          );
          cliEntriesByKey.set(key, {
            kind: OUTPUT_HISTORY_KINDS.CLI,
            target: event.target,
            runIndex,
            attemptIndex,
            phase: event.phase,
            cliOutput: event.payload.cliOutput,
            timestampMs: event.timestampMs,
            sequence: event.sequence,
          });
          // The replacement entry supersedes every delta buffered before it.
          deltas.discard(key);
          // A completed aggregate supersedes every streamed delta for this
          // attempt; a fresh streaming placeholder re-opens it (append/retry).
          if (event.payload.cliOutput.isStreaming) {
            sealedCliKeys.delete(key);
          } else {
            sealedCliKeys.add(key);
          }
          break;
        }
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED: {
          activityEntries.push({
            timestampMs: event.timestampMs,
            sequence: event.sequence,
            target: event.target,
            runIndex: event.runIndex ?? 0,
            attemptIndex: event.attemptIndex,
            phase: event.phase,
            kind: OUTPUT_ACTIVITY_KINDS.TEXT,
            text: event.payload.chunk,
          });
          const key = resolveStreamingKey(event);
          if (key) {
            deltas.appendChunk(key, event.payload.chunk);
          }
          break;
        }
        case TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED: {
          activityEntries.push({
            timestampMs: event.timestampMs,
            sequence: event.sequence,
            target: event.target,
            runIndex: event.runIndex ?? 0,
            attemptIndex: event.attemptIndex,
            phase: event.phase,
            kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
            events: event.payload.events,
          });
          const key = resolveStreamingKey(event);
          if (key) {
            deltas.appendEvents(key, event.payload.events);
          }
          break;
        }
        case TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED:
          activityEntries.push({
            timestampMs: event.timestampMs,
            sequence: event.sequence,
            target: event.target,
            runIndex: 0,
            attemptIndex: 0,
            kind: OUTPUT_ACTIVITY_KINDS.STATUS,
            text: event.payload.statusMessage.message,
            severity: event.payload.statusMessage.severity,
          });
          orderedEntries.push({
            kind: OUTPUT_HISTORY_KINDS.STATUS,
            target: event.target,
            statusMessage: event.payload.statusMessage,
            timestampMs: event.timestampMs,
            sequence: event.sequence,
          });
          break;
        case TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED:
          scriptOutputs.set(
            getCliEntryKey(
              event.target,
              event.runIndex,
              event.attemptIndex,
              event.phase
            ),
            event.payload
          );
          break;
        // SCRIPT_EXECUTION_RECORDED carries display output on read but is not
        // projected into activityEntries: the same text was already streamed
        // as chunk deltas, which would duplicate it on every history reload.
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

    for (const [key, entry] of cliEntriesByKey) {
      entry.cliOutput = deltas.flush(key, entry.cliOutput);
      const scriptOutput = scriptOutputs.get(key);
      if (scriptOutput) {
        entry.cliOutput = { ...entry.cliOutput, scriptOutput };
      }
    }

    history.orderedEntries = [
      ...orderedEntries,
      ...cliEntriesByKey.values(),
    ].sort(compareOrderedHistoryEntries);
    history.activityEntries = activityEntries.sort(compareActivityEntries);

    // PAUSING and CANCELLING still have a live step whose output keeps
    // streaming; sealing it here makes every later batch read as a follow-up.
    if (!IN_FLIGHT_EXECUTION_STATES.has(manifest.executionState)) {
      for (const entry of history.orderedEntries) {
        if (
          entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
          entry.cliOutput.isStreaming
        ) {
          entry.cliOutput = { ...entry.cliOutput, isStreaming: false };
        }
      }
    }

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

export function getCliEntryKey(
  target: OutputExecutionTarget,
  runIndex: number,
  attemptIndex: number,
  phase?: ExecutionPhase
): string {
  const base =
    target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  return `${base}:run:${runIndex}:attempt:${attemptIndex}${getExecutionPhaseKeySuffix(phase)}`;
}

function compareOrderedHistoryEntries(
  left: OrderedHistoryEntry,
  right: OrderedHistoryEntry
): number {
  return left.timestampMs - right.timestampMs || left.sequence - right.sequence;
}

function compareActivityEntries(
  left: OutputActivityEntry,
  right: OutputActivityEntry
): number {
  return left.timestampMs - right.timestampMs || left.sequence - right.sequence;
}
