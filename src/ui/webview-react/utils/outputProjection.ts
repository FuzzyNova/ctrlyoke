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

function cliEntryIdentityKey(identity: CliEntryIdentity): string {
  const targetIndex =
    identity.target.kind === FINAL_STEP_PHASES.QUEUE
      ? identity.target.stepIndex
      : identity.target.loopIndex;
  return `${identity.target.kind}:${targetIndex}:${identity.runIndex}:${identity.attemptIndex}:${identity.phase ?? EXECUTION_PHASES.PROMPT}`;
}

function activityIdentityKey(entry: OutputActivityEntry): string {
  const targetIndex =
    entry.target.kind === FINAL_STEP_PHASES.QUEUE
      ? entry.target.stepIndex
      : entry.target.loopIndex;
  return `${entry.target.kind}:${targetIndex}:run:${entry.runIndex}:attempt:${entry.attemptIndex}:${entry.phase ?? EXECUTION_PHASES.PROMPT}`;
}

function getActivityEventKey(event: CliEvent, index: number): string {
  const data = event.data;
  const id =
    "toolCallId" in data && typeof data.toolCallId === "string"
      ? data.toolCallId
      : "id" in data && typeof data.id === "string"
        ? data.id
        : undefined;
  if (id) return `tool:${id}`;
  if ("path" in data && typeof data.path === "string") {
    return `path:${event.type}:${data.path}`;
  }
  if (
    "server" in data &&
    typeof data.server === "string" &&
    "tool" in data &&
    typeof data.tool === "string"
  ) {
    return `mcp:${data.server}:${data.tool}`;
  }
  return `${event.type}:${index}`;
}

function mergeActivityEvents(
  existing: CliEvent[],
  incoming: readonly CliEvent[]
): CliEvent[] {
  const merged = [...existing];
  const indexByKey = new Map(
    merged.map((event, index) => [getActivityEventKey(event, index), index])
  );
  incoming.forEach((event, index) => {
    const key = getActivityEventKey(event, index);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(event);
      return;
    }
    merged[existingIndex] = event;
  });
  return merged;
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
    aggregateByIdentity.set(
      cliEntryIdentityKey({
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
      }),
      message
    );
  }

  const projected: OutputMessage[] = [];
  const activityByKey = new Map<string, OutputMessage>();
  for (const activity of [...activityEntries].sort(
    (left, right) =>
      left.timestampMs - right.timestampMs || left.sequence - right.sequence
  )) {
    const identityKey = activityIdentityKey(activity);
    const aggregate = aggregateByIdentity.get(identityKey);
    const isStructured = activity.kind === OUTPUT_ACTIVITY_KINDS.STRUCTURED;
    const baseKey = `${identityKey}:${activity.kind}`;
    const eventEntries = isStructured ? (activity.events ?? []) : [];
    const events = isStructured ? eventEntries : undefined;
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
    const activityKey =
      isStructured && events && events.length > 0
        ? `${baseKey}:${getActivityEventKey(events[0], 0)}`
        : canCoalesceText
          ? (previous.activityKey ?? baseKey)
          : `${baseKey}:${activity.sequence}`;
    const existing = activityByKey.get(activityKey);
    if (existing) {
      if (
        activity.kind === OUTPUT_ACTIVITY_KINDS.TEXT ||
        activity.kind === OUTPUT_ACTIVITY_KINDS.SCRIPT
      ) {
        existing.activityText = `${existing.activityText ?? ""}${activity.text ?? ""}`;
      } else if (activity.kind === OUTPUT_ACTIVITY_KINDS.STRUCTURED) {
        existing.activityEvents = mergeActivityEvents(
          existing.activityEvents ?? [],
          activity.events ?? []
        );
      }
      existing.aggregate = aggregate?.data as CliOutput | undefined;
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
              severity: STATUS_MESSAGE_SEVERITY.INFO,
              timestamp: formatTime(activity.timestampMs),
              timestampMs: activity.timestampMs,
            }
          : (aggregate?.data ?? {
              prompt: "",
              response: "",
              structured: { events: [], metadata: {} },
              elapsed: 0,
              isStreaming: true,
              timestampMs: activity.timestampMs,
              runIndex: activity.runIndex,
              attemptIndex: activity.attemptIndex,
            }),
      attemptIndex: activity.attemptIndex,
      runIndex: activity.runIndex,
      phase: activity.phase,
      isActivity: true,
      activityKey,
      activityKind: activity.kind,
      activityText: activity.text,
      activityEvents: events ?? activity.events,
      aggregate: aggregate?.data as CliOutput | undefined,
    };
    activityByKey.set(activityKey, message);
    projected.push(message);
  }

  const activityKindsByTarget = new Map<
    string,
    Set<OutputActivityEntry["kind"]>
  >();
  for (const message of projected) {
    if (!message.isActivity || !message.activityKind) continue;
    const key = getTargetKey(message.target);
    const kinds = activityKindsByTarget.get(key) ?? new Set();
    kinds.add(message.activityKind);
    activityKindsByTarget.set(key, kinds);
  }
  for (const aggregate of aggregateMessages) {
    if (
      aggregate.type === OUTPUT_MESSAGE_TYPES.CLI &&
      [
        ...(activityKindsByTarget.get(getTargetKey(aggregate.target)) ?? []),
      ].some((kind) => kind !== OUTPUT_ACTIVITY_KINDS.STATUS)
    ) {
      continue;
    }
    if (
      aggregate.type === OUTPUT_MESSAGE_TYPES.STATUS &&
      activityKindsByTarget
        .get(getTargetKey(aggregate.target))
        ?.has(OUTPUT_ACTIVITY_KINDS.STATUS)
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
