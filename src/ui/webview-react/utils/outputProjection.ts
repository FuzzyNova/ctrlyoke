import type {
  OrderedCliHistoryEntry,
  OrderedHistoryEntry,
  OutputExecutionTarget,
} from "@root/types/OutputHistoryTypes";
import type { CliOutput, OutputStatusMessage } from "../types/messages";
import {
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  type FinalStepPhase,
} from "../types/messages";
import {
  EXECUTION_PHASES,
  OUTPUT_MESSAGE_TYPES,
  type OutputMessageType,
  type ExecutionPhase,
} from "@root/types/DashboardConstants";
import { formatTime } from "./outputUtils";

export interface OutputMessageTarget {
  kind: FinalStepPhase;
  index: number;
}

export interface OutputMessage {
  type: OutputMessageType;
  target: OutputMessageTarget;
  timestamp: number;
  sequence?: number;
  data: OutputStatusMessage | CliOutput;
  attemptIndex?: number;
  runIndex?: number;
  phase?: ExecutionPhase;
}

/** Logical identity shared by live overlays and persisted-history projection. */
export interface CliEntryIdentity {
  target: OutputExecutionTarget;
  runIndex: number;
  attemptIndex: number;
  phase?: ExecutionPhase;
}

export function getCliEntryIdentity(
  entry: OrderedCliHistoryEntry
): CliEntryIdentity {
  return {
    target: entry.target,
    runIndex: entry.runIndex ?? entry.cliOutput.runIndex ?? 0,
    attemptIndex: entry.attemptIndex,
    phase: entry.phase,
  };
}

function cliEntryIdentityKey(identity: CliEntryIdentity): string {
  const targetIndex =
    identity.target.kind === FINAL_STEP_PHASES.QUEUE
      ? identity.target.stepIndex
      : identity.target.loopIndex;
  return `${identity.target.kind}:${targetIndex}:${identity.runIndex}:${identity.attemptIndex}:${identity.phase ?? EXECUTION_PHASES.PROMPT}`;
}

export function matchesCliEntryIdentity(
  entry: OrderedHistoryEntry,
  identity: CliEntryIdentity
): entry is OrderedCliHistoryEntry {
  return (
    entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
    cliEntryIdentityKey(getCliEntryIdentity(entry)) ===
      cliEntryIdentityKey(identity)
  );
}

function sortOutputMessages(
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
  const cliMessageIndexByIdentity = new Map<string, number>();

  for (const entry of orderedEntries) {
    switch (entry.kind) {
      case OUTPUT_HISTORY_KINDS.STATUS: {
        const timestampMs = entry.statusMessage.timestamp ?? entry.timestampMs;
        messages.push({
          type: OUTPUT_MESSAGE_TYPES.STATUS,
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
      case OUTPUT_HISTORY_KINDS.CLI: {
        const target = toOutputMessageTarget(entry.target);
        const entryIdentity = getCliEntryIdentity(entry);
        const identity = cliEntryIdentityKey(entryIdentity);
        const existingIndex = cliMessageIndexByIdentity.get(identity);
        const message: OutputMessage = {
          type: OUTPUT_MESSAGE_TYPES.CLI,
          target,
          timestamp: entry.timestampMs,
          sequence: entry.sequence,
          data: entry.cliOutput,
          attemptIndex: entry.attemptIndex,
          runIndex: entryIdentity.runIndex,
          phase: entry.phase,
        };

        if (existingIndex === undefined) {
          cliMessageIndexByIdentity.set(identity, messages.length);
          messages.push(message);
        } else {
          const existing = messages[existingIndex];
          // Timeline storage records both the initial streaming shell and its
          // final result. They are snapshots of one logical attempt, just like
          // the live store's in-place overlays. Keep the first snapshot's
          // chronological position while projecting the newest payload.
          messages[existingIndex] = {
            ...message,
            timestamp: existing.timestamp,
            sequence: existing.sequence,
          };
        }
        break;
      }
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
