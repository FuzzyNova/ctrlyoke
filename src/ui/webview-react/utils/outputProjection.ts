import type {
  OrderedHistoryEntry,
  OutputExecutionTarget,
} from "@root/types/OutputHistoryTypes";
import type { CliOutput, OutputStatusMessage } from "../types/messages";
import { FINAL_STEP_PHASES, type FinalStepPhase } from "../types/messages";
import { formatTime } from "./outputUtils";

export interface OutputMessageTarget {
  kind: FinalStepPhase;
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

export function toOutputMessageTarget(
  target: OutputExecutionTarget
): OutputMessageTarget {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? { kind: FINAL_STEP_PHASES.QUEUE, index: target.stepIndex }
    : { kind: FINAL_STEP_PHASES.FINAL_STEP, index: target.loopIndex };
}

export function getTargetKey(target: OutputMessageTarget): string {
  return `${target.kind}:${target.index}`;
}
