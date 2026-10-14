import type {
  OrderedCliHistoryEntry,
  OrderedHistoryEntry,
  OutputActivityEntry,
  OutputExecutionTarget,
} from "@root/types/OutputHistoryTypes";
import type { CliOutput, OutputStatusMessage } from "../types/messages";
import type { CliEvent } from "../types/cliEvents";
import {
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  type FinalStepPhase,
} from "../types/messages";
import {
  EXECUTION_PHASES,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_MESSAGE_TYPES,
  STATUS_MESSAGE_SEVERITY,
  type OutputMessageType,
  type ExecutionPhase,
} from "@root/types/DashboardConstants";
import { normalizeCliEventsWithSource } from "@root/utils/CliEventNormalizer";
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
  /** The attempt's prompt, carried from its CLI history entry. */
  prompt?: string;
  attemptIndex?: number;
  runIndex?: number;
  phase?: ExecutionPhase;
  /** True when this is a semantic activity projection rather than an attempt aggregate. */
  isActivity?: boolean;
  activityKey?: string;
  activityKind?: OutputActivityEntry["kind"];
  activityText?: string;
  activityEvents?: CliEvent[];
  /** Aggregate attempt metadata retained for undo/stats while activities render. */
  aggregate?: CliOutput;
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

export function cliEntryIdentityKey(identity: CliEntryIdentity): string {
  const targetIndex =
    identity.target.kind === FINAL_STEP_PHASES.QUEUE
      ? identity.target.stepIndex
      : identity.target.loopIndex;
  return `${identity.target.kind}:${targetIndex}:${identity.runIndex}:${identity.attemptIndex}:${identity.phase ?? EXECUTION_PHASES.PROMPT}`;
}

function activityIdentityKey(entry: OutputActivityEntry): string {
  // Must match `cliEntryIdentityKey`'s format exactly: `aggregateByIdentity` is
  // keyed by the latter and looked up by the former, so a diverging format
  // silently orphans every activity's aggregate lookup.
  return cliEntryIdentityKey(entry);
}

/**
 * Normalized structured events, grouped under the activity slice that *started*
 * each operation.
 *
 * A slice is one streamed batch, not one logical operation: the harness emits a
 * tool call's INITIATED event in one batch and its COMPLETED/toolResult
 * counterpart in a later one. Pairing them can therefore only happen across the
 * whole attempt — normalizing a slice in isolation leaves every block painted as
 * still running, with its output nowhere on screen. Anchoring the merged event
 * back to the opening slice is what keeps the block at the moment the operation
 * began, which is the entire point of the chronological interleaving.
 *
 * Slices whose events were all absorbed into an earlier slice get no entry, and
 * their message is dropped rather than rendered empty.
 */
function normalizeStructuredActivityEvents(
  activities: readonly OutputActivityEntry[]
): Map<OutputActivityEntry, CliEvent[]> {
  const slicesByIdentity = new Map<string, OutputActivityEntry[]>();
  for (const activity of activities) {
    if (activity.kind !== OUTPUT_ACTIVITY_KINDS.STRUCTURED) continue;
    const key = activityIdentityKey(activity);
    const slices = slicesByIdentity.get(key);
    if (slices) {
      slices.push(activity);
    } else {
      slicesByIdentity.set(key, [activity]);
    }
  }

  const eventsBySlice = new Map<OutputActivityEntry, CliEvent[]>();
  for (const slices of slicesByIdentity.values()) {
    const attemptEvents: CliEvent[] = [];
    const sliceByEventIndex: OutputActivityEntry[] = [];
    for (const slice of slices) {
      for (const event of slice.events ?? []) {
        attemptEvents.push(event);
        sliceByEventIndex.push(slice);
      }
    }

    for (const { event, sourceIndex } of normalizeCliEventsWithSource(
      attemptEvents
    )) {
      const slice = sliceByEventIndex[sourceIndex];
      const owned = eventsBySlice.get(slice);
      if (owned) {
        owned.push(event);
      } else {
        eventsBySlice.set(slice, [event]);
      }
    }
  }

  return eventsBySlice;
}

/**
 * The logical identity of an already-projected `OutputMessage`, in the same
 * key space as `cliEntryIdentityKey`.
 *
 * Aggregate/activity pairing and aggregate suppression both key on this, so it
 * must stay a single function: a target alone is *not* an identity — a step's
 * pre/end-condition scripts and its retries all share its target — and keying
 * either side by target silently discarded whole rows (see the suppression
 * loop in `mapOrderedHistoryEntriesToMessages`).
 */
export function outputMessageIdentityKey(message: OutputMessage): string {
  return cliEntryIdentityKey({
    target:
      message.target.kind === FINAL_STEP_PHASES.QUEUE
        ? { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: message.target.index }
        : {
            kind: FINAL_STEP_PHASES.FINAL_STEP,
            loopIndex: message.target.index,
          },
    runIndex: message.runIndex ?? 0,
    attemptIndex: message.attemptIndex ?? 0,
    phase: message.phase,
  });
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
  orderedEntries: readonly OrderedHistoryEntry[],
  activityEntries: readonly OutputActivityEntry[] = []
): OutputMessage[] {
  const aggregateMessages: OutputMessage[] = [];
  const cliMessageIndexByIdentity = new Map<string, number>();

  for (const entry of orderedEntries) {
    switch (entry.kind) {
      case OUTPUT_HISTORY_KINDS.STATUS: {
        const timestampMs = entry.statusMessage.timestamp ?? entry.timestampMs;
        aggregateMessages.push({
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
          prompt: entry.prompt,
          attemptIndex: entry.attemptIndex,
          runIndex: entryIdentity.runIndex,
          phase: entry.phase,
        };

        if (existingIndex === undefined) {
          cliMessageIndexByIdentity.set(identity, aggregateMessages.length);
          aggregateMessages.push(message);
        } else {
          const existing = aggregateMessages[existingIndex];
          // Timeline storage records both the initial streaming shell and its
          // final result. They are snapshots of one logical attempt, just like
          // the live store's in-place overlays. Keep the first snapshot's
          // chronological position while projecting the newest payload.
          aggregateMessages[existingIndex] = {
            ...message,
            prompt: message.prompt ?? existing.prompt,
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

  if (activityEntries.length === 0) {
    return sortOutputMessages(aggregateMessages);
  }

  const aggregateByIdentity = new Map<string, OutputMessage>();
  for (const message of aggregateMessages) {
    if (message.type !== OUTPUT_MESSAGE_TYPES.CLI) continue;
    aggregateByIdentity.set(outputMessageIdentityKey(message), message);
  }

  const sortedActivities = [...activityEntries].sort(
    (left, right) =>
      left.timestampMs - right.timestampMs || left.sequence - right.sequence
  );
  const structuredEventsBySlice =
    normalizeStructuredActivityEvents(sortedActivities);

  const projected: OutputMessage[] = [];
  const activityByKey = new Map<string, OutputMessage>();
  for (const activity of sortedActivities) {
    const identityKey = activityIdentityKey(activity);
    const aggregate = aggregateByIdentity.get(identityKey);
    const isStructured = activity.kind === OUTPUT_ACTIVITY_KINDS.STRUCTURED;
    const baseKey = `${identityKey}:${activity.kind}`;
    const events = isStructured
      ? (structuredEventsBySlice.get(activity) ?? [])
      : undefined;
    // Every event this slice carried was merged into a block an earlier slice
    // opened, so the slice has nothing of its own left to draw.
    if (events?.length === 0) continue;
    const previous = projected[projected.length - 1];
    const canCoalesceText =
      (activity.kind === OUTPUT_ACTIVITY_KINDS.TEXT ||
        activity.kind === OUTPUT_ACTIVITY_KINDS.SCRIPT) &&
      previous?.isActivity === true &&
      previous.activityKind === activity.kind &&
      getTargetKey(previous.target) ===
        getTargetKey(toOutputMessageTarget(activity.target)) &&
      (previous.runIndex ?? 0) === activity.runIndex &&
      (previous.attemptIndex ?? 0) === activity.attemptIndex &&
      (previous.phase ?? EXECUTION_PHASES.PROMPT) ===
        (activity.phase ?? EXECUTION_PHASES.PROMPT);
    // Structured slices are keyed by sequence and so are always distinct;
    // only coalescing text/script deltas re-enters an existing message.
    const activityKey = canCoalesceText
      ? (previous.activityKey ?? baseKey)
      : `${baseKey}:${activity.sequence}`;
    const existing = activityByKey.get(activityKey);
    if (existing) {
      existing.activityText = `${existing.activityText ?? ""}${activity.text ?? ""}`;
      existing.aggregate = aggregate?.data as CliOutput | undefined;
      existing.prompt = aggregate?.prompt;
      continue;
    }

    const message: OutputMessage = {
      type:
        activity.kind === OUTPUT_ACTIVITY_KINDS.STATUS
          ? OUTPUT_MESSAGE_TYPES.STATUS
          : OUTPUT_MESSAGE_TYPES.CLI,
      target: toOutputMessageTarget(activity.target),
      timestamp: activity.timestampMs,
      sequence: activity.sequence,
      data:
        activity.kind === OUTPUT_ACTIVITY_KINDS.STATUS
          ? {
              message: activity.text ?? "",
              // This message replaces the aggregate `OrderedStatusHistoryEntry`
              // for the same target below, so the activity's own severity is
              // the only one that reaches the row. Hardcoding info here painted
              // every warning and error — "Execution failed" included — blue.
              severity: activity.severity ?? STATUS_MESSAGE_SEVERITY.INFO,
              timestamp: formatTime(activity.timestampMs),
              timestampMs: activity.timestampMs,
            }
          : (aggregate?.data ?? {
              structured: { events: [], metadata: {} },
              elapsed: 0,
              isStreaming: true,
              timestampMs: activity.timestampMs,
              runIndex: activity.runIndex,
              attemptIndex: activity.attemptIndex,
            }),
      prompt: aggregate?.prompt,
      attemptIndex: activity.attemptIndex,
      runIndex: activity.runIndex,
      phase: activity.phase,
      isActivity: true,
      activityKey,
      activityKind: activity.kind,
      activityText: activity.text,
      activityEvents: events,
      aggregate: aggregate?.data as CliOutput | undefined,
    };
    activityByKey.set(activityKey, message);
    projected.push(message);
  }

  // A CLI aggregate is superseded only by the activities that actually stand in
  // for it, so this is keyed by full identity. Keying it by target dropped an
  // aggregate whose own identity produced no activity at all while a *sibling*
  // identity under the same target did: a pre/end-condition script that exits
  // silently streams no chunk, so its row — command, exit code, verdict — was
  // erased by the AI response's activities at the same step.
  //
  // Status activities stay target-keyed: an `OrderedStatusHistoryEntry` has no
  // run/attempt/phase of its own, so target is the whole of its identity.
  const cliActivityIdentities = new Set<string>();
  const statusActivityTargets = new Set<string>();
  for (const message of projected) {
    if (!message.isActivity || !message.activityKind) continue;
    if (message.activityKind === OUTPUT_ACTIVITY_KINDS.STATUS) {
      statusActivityTargets.add(getTargetKey(message.target));
    } else {
      cliActivityIdentities.add(outputMessageIdentityKey(message));
    }
  }
  for (const aggregate of aggregateMessages) {
    if (
      aggregate.type === OUTPUT_MESSAGE_TYPES.CLI &&
      cliActivityIdentities.has(outputMessageIdentityKey(aggregate))
    ) {
      continue;
    }
    if (
      aggregate.type === OUTPUT_MESSAGE_TYPES.STATUS &&
      statusActivityTargets.has(getTargetKey(aggregate.target))
    ) {
      continue;
    }
    projected.push(aggregate);
  }

  return sortOutputMessages(projected);
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
