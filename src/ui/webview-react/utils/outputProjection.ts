import type {
  OrderedHistoryEntry,
  OutputExecutionTarget,
  OutputTimelineEntry,
  StepOutput,
} from "@root/types/OutputHistoryTypes";
import type {
  CliOutput,
  OutputStatusMessage,
  StatusMessage,
} from "../types/messages";
import { FINAL_PROMPT_PHASES } from "../types/messages";
import { formatTime } from "./outputUtils";

export interface OutputMessageTarget {
  kind: "queue" | "finalPrompt";
  index: number;
}

export interface OutputMessage {
  type: "status" | "cli";
  target: OutputMessageTarget;
  timestamp: number;
  sequence?: number;
  data: OutputStatusMessage | CliOutput;
  attemptIndex?: number;
}

export interface OutputProjectionStep {
  target: OutputMessageTarget;
  cliOutputs: CliOutput[];
  statusMessages: StatusMessage[];
  firstOutputAt?: number;
}

export interface HistoricalOutputProjection {
  stepCount: number;
  steps: Record<number, StepOutput>;
  finalPromptOutputs?: Record<number, StepOutput>;
  outputTimeline?: OutputTimelineEntry[];
}

export function sortOutputMessages(
  messages: readonly OutputMessage[]
): OutputMessage[] {
  return [...messages].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      (left.sequence ?? 0) - (right.sequence ?? 0)
  );
}

export function mapOrderedHistoryEntriesToMessages(
  orderedEntries: readonly OrderedHistoryEntry[]
): OutputMessage[] {
  const messages: OutputMessage[] = [];

  for (const entry of orderedEntries) {
    switch (entry.kind) {
      case "status": {
        const timestampMs = entry.statusMessage.timestamp ?? entry.timestampMs;
        messages.push({
          type: "status",
          target: toOutputMessageTarget(entry.target),
          timestamp: timestampMs,
          sequence: entry.sequence,
          data: {
            message: entry.statusMessage.message,
            severity: entry.statusMessage.severity,
            timestamp: formatTime(timestampMs),
            timestampMs,
          },
        });
        break;
      }
      case "cli":
        messages.push({
          type: "cli",
          target: toOutputMessageTarget(entry.target),
          timestamp: entry.timestampMs,
          sequence: entry.sequence,
          data: entry.cliOutput,
          attemptIndex: entry.attemptIndex,
        });
        break;
      case "runtime":
        break;
    }
  }

  return sortOutputMessages(messages);
}

export function buildProjectedOutputMessages(
  steps: readonly OutputProjectionStep[]
): OutputMessage[] {
  const messages: OutputMessage[] = [];
  let fallbackTimestampCursor = 0;
  let fallbackSequence = 0;

  for (const step of steps) {
    const stepAnchorTimestamp = getStepAnchorTimestamp(step);
    if (isFiniteTimestamp(stepAnchorTimestamp)) {
      fallbackTimestampCursor = Math.max(
        fallbackTimestampCursor,
        stepAnchorTimestamp
      );
    }

    for (const statusMessage of step.statusMessages ?? []) {
      const timestampMs =
        statusMessage.timestamp ??
        stepAnchorTimestamp ??
        ++fallbackTimestampCursor;

      fallbackTimestampCursor = Math.max(fallbackTimestampCursor, timestampMs);
      messages.push({
        type: "status",
        target: step.target,
        timestamp: timestampMs,
        sequence: fallbackSequence++,
        data: {
          message: statusMessage.message,
          severity: statusMessage.severity,
          timestamp: formatTime(timestampMs),
          timestampMs,
        },
      });
    }

    for (const output of step.cliOutputs ?? []) {
      const timestampMs =
        output.timestampMs ?? stepAnchorTimestamp ?? ++fallbackTimestampCursor;

      fallbackTimestampCursor = Math.max(fallbackTimestampCursor, timestampMs);
      messages.push({
        type: "cli",
        target: step.target,
        timestamp: timestampMs,
        sequence: fallbackSequence++,
        data: output,
        attemptIndex: output.attemptIndex ?? 0,
      });
    }
  }

  return sortOutputMessages(messages);
}

export function buildHistoricalProjectionSteps(
  history: HistoricalOutputProjection
): OutputProjectionStep[] {
  const queueSteps = Array.from({ length: history.stepCount }, (_, index) =>
    buildProjectionStep(
      { kind: "queue", index },
      history.steps[index],
      history.outputTimeline
    )
  );

  const finalSteps = Object.keys(history.finalPromptOutputs ?? {})
    .map((key) => Number(key))
    .filter((index) => Number.isFinite(index))
    .sort((left, right) => left - right)
    .map((index) =>
      buildProjectionStep(
        { kind: "finalPrompt", index },
        history.finalPromptOutputs?.[index],
        history.outputTimeline
      )
    );

  return orderStepsByTimeline(
    [...queueSteps, ...finalSteps],
    history.outputTimeline
  );
}

function buildProjectionStep(
  target: OutputMessageTarget,
  step: StepOutput | undefined,
  outputTimeline?: readonly OutputTimelineEntry[]
): OutputProjectionStep {
  return {
    target,
    cliOutputs: step?.cliOutputs ?? [],
    statusMessages: step?.statusMessages ?? [],
    firstOutputAt: findTimelineEntry(outputTimeline, target)?.firstOutputAt,
  };
}

function orderStepsByTimeline(
  steps: readonly OutputProjectionStep[],
  outputTimeline?: readonly OutputTimelineEntry[]
): OutputProjectionStep[] {
  if (!outputTimeline || outputTimeline.length === 0) {
    return [...steps];
  }

  const stepsByKey = new Map(
    steps.map((step) => [getTargetKey(step.target), step] as const)
  );
  const orderedSteps: OutputProjectionStep[] = [];
  const seenKeys = new Set<string>();

  for (const entry of outputTimeline) {
    const key = getTargetKey(toOutputMessageTarget(entry.target));
    const step = stepsByKey.get(key);
    if (!step || seenKeys.has(key)) {
      continue;
    }

    orderedSteps.push(step);
    seenKeys.add(key);
  }

  for (const step of steps) {
    const key = getTargetKey(step.target);
    if (seenKeys.has(key)) {
      continue;
    }

    orderedSteps.push(step);
  }

  return orderedSteps;
}

function findTimelineEntry(
  outputTimeline: readonly OutputTimelineEntry[] | undefined,
  target: OutputMessageTarget
): OutputTimelineEntry | undefined {
  return outputTimeline?.find(
    (entry) =>
      getTargetKey(toOutputMessageTarget(entry.target)) === getTargetKey(target)
  );
}

function getStepAnchorTimestamp(
  step: OutputProjectionStep
): number | undefined {
  const timestamps = [
    step.firstOutputAt,
    ...step.statusMessages.map((message) => message.timestamp),
    ...step.cliOutputs.map((output) => output.timestampMs),
  ].filter(isFiniteTimestamp);

  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function toOutputMessageTarget(
  target: OutputExecutionTarget
): OutputMessageTarget {
  return target.kind === FINAL_PROMPT_PHASES.QUEUE
    ? { kind: FINAL_PROMPT_PHASES.QUEUE, index: target.stepIndex }
    : { kind: FINAL_PROMPT_PHASES.FINAL_PROMPT, index: target.loopIndex };
}

function getTargetKey(target: OutputMessageTarget): string {
  return `${target.kind}:${target.index}`;
}

function isFiniteTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
