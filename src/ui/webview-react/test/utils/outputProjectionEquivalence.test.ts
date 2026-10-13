import { getStepOutputText } from "../../../../utils/StepOutputText";
import { StepOutputTextMode } from "../../../../types/DashboardConstants";
import { describe, expect, it } from "vitest";
import type { CliEvent } from "@root/types/CliOutputTypes";
import type {
  OrderedCliHistoryEntry,
  OutputActivityEntry,
  WorkflowOutputHistory,
} from "@root/types/OutputHistoryTypes";
import {
  OUTPUT_HISTORY_KINDS,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";
import type { WorkflowStep } from "@store/workflowStore";
import {
  mapOrderedHistoryEntriesToMessages,
  type OutputMessage,
} from "@utils/outputProjection";
import { buildOutputRows } from "@utils/outputRows";
import {
  CLI_EVENT_TYPES,
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
  OUTPUT_ACTIVITY_KINDS,
  OPERATION_STATUS,
} from "@/types/messages";
import { normalizeCliEventsWithSource } from "@root/utils/CliEventNormalizer";

interface ActivityOrder {
  timestampMs: number;
  sequence: number;
}

type OrderedCandidateEvent = CliEvent & { activityOrder?: ActivityOrder };

const queueTarget = (stepIndex: number) => ({
  kind: FINAL_STEP_PHASES.QUEUE,
  stepIndex,
});

function makeStructuredFixture(): WorkflowOutputHistory {
  const activityEntries: OutputActivityEntry[] = [];
  const orderedEntries: OrderedCliHistoryEntry[] = [];
  const targets = [queueTarget(0), queueTarget(1), queueTarget(2)];
  let sequence = 1;

  const appendAttempt = (
    stepIndex: number,
    attemptIndex: number,
    phase: OrderedCliHistoryEntry["phase"],
    sliceEvents: CliEvent[][]
  ) => {
    const target = targets[stepIndex];
    if (!target) throw new Error(`Missing target for step ${stepIndex}`);
    const raw: CliEvent[] = [];

    for (const events of sliceEvents) {
      const activity: OutputActivityEntry = {
        timestampMs: 1_000 + sequence,
        sequence,
        target,
        runIndex: 0,
        attemptIndex,
        phase,
        kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
        events,
      };
      sequence += 1;
      raw.push(...events);
      activityEntries.push(activity);
    }

    const normalized = normalizeCliEventsWithSource(raw);
    const normalizedEvents = normalized.map(({ event }) => event);
    orderedEntries.push({
      kind: OUTPUT_HISTORY_KINDS.CLI,
      target,
      runIndex: 0,
      attemptIndex,
      phase,
      cliOutput: {
        structured: { events: normalizedEvents, metadata: {} },
        elapsed: 1,
        isStreaming: false,
        timestampMs: 1_000 + sequence,
      },
      timestampMs: 1_000 + sequence,
      sequence,
    });
    sequence += 1;
  };

  const call = (id: string, command: string): CliEvent => ({
    type: CLI_EVENT_TYPES.TOOL_CALL,
    data: { id, name: "Bash", parameters: { command } },
  });
  const result = (id: string, output: string): CliEvent => ({
    type: CLI_EVENT_TYPES.TOOL_RESULT,
    data: { toolCallId: id, result: { success: true, output } },
  });
  const text = (value: string): CliEvent => ({
    type: CLI_EVENT_TYPES.TEXT,
    data: { text: value },
  });

  // Two attempts for step 0 exercise retry identity. Steps 1 and 2 run as a
  // parallel group and interleave with step 0 over 21 timeline slices.
  appendAttempt(0, 0, undefined, [
    [text("retry attempt: planning"), call("retry-tool", "npm test")],
    [text("retry attempt: waiting")],
    [result("retry-tool", "first attempt failed")],
  ]);
  appendAttempt(0, 1, undefined, [
    [text("retry succeeded")],
    [call("retry-tool-2", "npm test")],
    [result("retry-tool-2", "passed")],
  ]);
  appendAttempt(1, 0, undefined, [
    [text("parallel A: inspect")],
    [call("parallel-a-1", "git status")],
    [text("parallel A: continue")],
    [result("parallel-a-1", "clean")],
    [call("parallel-a-2", "git diff")],
    [result("parallel-a-2", "no changes")],
  ]);
  appendAttempt(2, 0, undefined, [
    [text("parallel B: inspect")],
    [call("parallel-b-1", "npm run lint")],
    [text("parallel B: continue")],
    [result("parallel-b-1", "passed")],
    [call("parallel-b-2", "npm run typecheck")],
    [result("parallel-b-2", "passed")],
  ]);

  // Final-step loop output shares the same projection path but a distinct target.
  const finalTarget = {
    kind: FINAL_STEP_PHASES.FINAL_STEP,
    loopIndex: 0,
  } as const;
  const finalEvents = [text("final loop"), call("final-tool", "git status")];
  const finalNormalized = normalizeCliEventsWithSource(finalEvents).map(
    ({ event }) => event
  );
  activityEntries.push({
    timestampMs: 2_000,
    sequence,
    target: finalTarget,
    runIndex: 0,
    attemptIndex: 0,
    kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
    events: finalEvents,
  });
  orderedEntries.push({
    kind: OUTPUT_HISTORY_KINDS.CLI,
    target: finalTarget,
    runIndex: 0,
    attemptIndex: 0,
    cliOutput: {
      structured: { events: finalNormalized, metadata: {} },
      elapsed: 1,
      isStreaming: false,
      timestampMs: 2_000,
    },
    timestampMs: 2_000,
    sequence: sequence + 1,
  });

  // Keep one phase-distinct attempt at the same step and retry index. Its
  // separate identity must not collapse into the prompt attempt.
  appendAttempt(0, 0, EXECUTION_PHASES.END_CONDITION, [
    [call("condition-tool", "npm test")],
    [result("condition-tool", "condition passed")],
  ]);

  // Interleave activity slices across attempts and parallel members. Timeline
  // order is global even though each attempt's event array is normalized alone.
  const activityGroups = new Map<string, OutputActivityEntry[]>();
  for (const activity of activityEntries) {
    const targetIndex =
      activity.target.kind === FINAL_STEP_PHASES.QUEUE
        ? activity.target.stepIndex
        : activity.target.loopIndex;
    const identity = `${activity.target.kind}:${targetIndex}:${activity.runIndex}:${activity.attemptIndex}:${activity.phase ?? "prompt"}`;
    const group = activityGroups.get(identity) ?? [];
    group.push(activity);
    activityGroups.set(identity, group);
  }
  const interleaved: OutputActivityEntry[] = [];
  const groupQueues = [...activityGroups.values()];
  while (groupQueues.some((group) => group.length > 0)) {
    for (const group of groupQueues) {
      const activity = group.shift();
      if (activity) interleaved.push(activity);
    }
  }
  interleaved.forEach((activity, index) => {
    activity.timestampMs = 1_000 + index;
    activity.sequence = index + 1;
  });
  activityEntries.splice(0, activityEntries.length, ...interleaved);

  return {
    workflowId: "equivalence-fixture",
    runId: 1,
    startedAt: 1_000,
    executionState: "COMPLETED" as WorkflowOutputHistory["executionState"],
    promptOutputs: {},
    orderedEntries,
    activityEntries,
  };
}

function sameCliIdentity(
  left: OutputActivityEntry,
  right: OrderedCliHistoryEntry
): boolean {
  return (
    left.target.kind === right.target.kind &&
    (left.target.kind === FINAL_STEP_PHASES.QUEUE
      ? left.target.stepIndex ===
        (right.target.kind === FINAL_STEP_PHASES.QUEUE
          ? right.target.stepIndex
          : -1)
      : left.target.loopIndex ===
        (right.target.kind === FINAL_STEP_PHASES.FINAL_STEP
          ? right.target.loopIndex
          : -1)) &&
    left.runIndex === (right.runIndex ?? right.cliOutput.runIndex ?? 0) &&
    left.attemptIndex === right.attemptIndex &&
    (left.phase ?? EXECUTION_PHASES.PROMPT) ===
      (right.phase ?? EXECUTION_PHASES.PROMPT)
  );
}

/**
 * Models the proposed persisted event metadata: every normalized aggregate
 * event receives the timestamp and sequence of the slice that opened it.
 * This function runs before activityEntries are discarded. The candidate
 * projector below consumes only orderedEntries after this assignment.
 */
function addCandidateOrderMetadata(
  history: WorkflowOutputHistory
): WorkflowOutputHistory {
  const activityEntries = history.activityEntries ?? [];
  const orderedEntries = history.orderedEntries.map((entry) => {
    if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) return entry;
    const slices = activityEntries
      .filter(
        (activity) =>
          activity.kind === OUTPUT_ACTIVITY_KINDS.STRUCTURED &&
          sameCliIdentity(activity, entry)
      )
      .sort(
        (left, right) =>
          left.timestampMs - right.timestampMs || left.sequence - right.sequence
      );
    const rawEvents: CliEvent[] = [];
    const sourceSlices: OutputActivityEntry[] = [];
    for (const slice of slices) {
      for (const event of slice.events ?? []) {
        rawEvents.push(event);
        sourceSlices.push(slice);
      }
    }
    const normalized = normalizeCliEventsWithSource(rawEvents);
    const sourceOrder = normalized.map(({ sourceIndex }) => {
      const sourceSlice = sourceSlices[sourceIndex];
      return sourceSlice
        ? {
            timestampMs: sourceSlice.timestampMs,
            sequence: sourceSlice.sequence,
          }
        : undefined;
    });
    const events = (entry.cliOutput.structured?.events ?? []).map(
      (event, index): OrderedCandidateEvent => ({
        ...event,
        ...(sourceOrder[index] ? { activityOrder: sourceOrder[index] } : {}),
      })
    );
    return {
      ...entry,
      cliOutput: {
        ...entry.cliOutput,
        structured: {
          ...entry.cliOutput.structured,
          events,
          metadata: entry.cliOutput.structured?.metadata ?? {},
        },
      },
    };
  });
  return { ...history, orderedEntries };
}

function removeCandidateOrderMetadata(
  history: WorkflowOutputHistory
): WorkflowOutputHistory {
  return {
    ...history,
    orderedEntries: history.orderedEntries.map((entry) => {
      if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) return entry;
      return {
        ...entry,
        cliOutput: {
          ...entry.cliOutput,
          structured: {
            ...entry.cliOutput.structured,
            events: (entry.cliOutput.structured?.events ?? []).map((event) => {
              const { activityOrder: _activityOrder, ...cleanEvent } =
                event as OrderedCandidateEvent;
              return cleanEvent;
            }),
            metadata: entry.cliOutput.structured?.metadata ?? {},
          },
        },
      };
    }),
  };
}

/** Candidate projection from ordered aggregates and event ordering metadata. */
function mapAggregateEventsToMessages(
  orderedEntries: WorkflowOutputHistory["orderedEntries"]
): OutputMessage[] {
  const messages: OutputMessage[] = [];
  for (const entry of orderedEntries) {
    if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) continue;
    const identity = `${entry.target.kind}:${entry.target.kind === FINAL_STEP_PHASES.QUEUE ? entry.target.stepIndex : entry.target.loopIndex}:${entry.runIndex ?? entry.cliOutput.runIndex ?? 0}:${entry.attemptIndex}:${entry.phase ?? EXECUTION_PHASES.PROMPT}`;
    const events = (entry.cliOutput.structured?.events ??
      []) as OrderedCandidateEvent[];
    const outputForRows = {
      ...entry.cliOutput,
      structured: {
        ...entry.cliOutput.structured,
        events: events.map((event) => {
          const { activityOrder: _activityOrder, ...cleanEvent } = event;
          return cleanEvent;
        }),
        metadata: entry.cliOutput.structured?.metadata ?? {},
      },
    };
    const groups = new Map<
      string,
      { order: ActivityOrder; events: CliEvent[] }
    >();
    events.forEach((event) => {
      if (!event.activityOrder) return;
      const groupKey = `${event.activityOrder.timestampMs}:${event.activityOrder.sequence}`;
      const group = groups.get(groupKey) ?? {
        order: event.activityOrder,
        events: [],
      };
      const { activityOrder: _activityOrder, ...renderEvent } = event;
      group.events.push(renderEvent);
      groups.set(groupKey, group);
    });
    for (const { order, events: activityEvents } of groups.values()) {
      const activityKey = `${identity}:${OUTPUT_ACTIVITY_KINDS.STRUCTURED}:${order.sequence}`;
      messages.push({
        type: "cli",
        target: {
          kind: entry.target.kind,
          index:
            entry.target.kind === FINAL_STEP_PHASES.QUEUE
              ? entry.target.stepIndex
              : entry.target.loopIndex,
        },
        timestamp: order.timestampMs,
        sequence: order.sequence,
        data: outputForRows,
        attemptIndex: entry.attemptIndex,
        runIndex: entry.runIndex ?? entry.cliOutput.runIndex ?? 0,
        phase: entry.phase,
        isActivity: true,
        activityKey,
        activityKind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
        activityEvents,
        aggregate: outputForRows,
      });
    }
    const hasResponse =
      getStepOutputText(
        { output: entry.cliOutput },
        StepOutputTextMode.TRANSCRIPT
      ).length > 0;
    if (hasResponse) {
      messages.push({
        type: "cli",
        target: {
          kind: entry.target.kind,
          index:
            entry.target.kind === FINAL_STEP_PHASES.QUEUE
              ? entry.target.stepIndex
              : entry.target.loopIndex,
        },
        timestamp: entry.timestampMs,
        sequence: entry.sequence,
        data: outputForRows,
        attemptIndex: entry.attemptIndex,
        runIndex: entry.runIndex ?? entry.cliOutput.runIndex ?? 0,
        phase: entry.phase,
        isActivity: true,
        activityKey: `${identity}:${OUTPUT_ACTIVITY_KINDS.TEXT}:${entry.sequence}`,
        activityKind: OUTPUT_ACTIVITY_KINDS.TEXT,
        activityText: getStepOutputText(
          { output: entry.cliOutput },
          StepOutputTextMode.TRANSCRIPT
        ),
        aggregate: outputForRows,
      });
    }
    if (groups.size === 0 && !hasResponse) {
      messages.push({
        type: "cli",
        target: {
          kind: entry.target.kind,
          index:
            entry.target.kind === FINAL_STEP_PHASES.QUEUE
              ? entry.target.stepIndex
              : entry.target.loopIndex,
        },
        timestamp: entry.timestampMs,
        sequence: entry.sequence,
        data: outputForRows,
        attemptIndex: entry.attemptIndex,
        runIndex: entry.runIndex ?? entry.cliOutput.runIndex ?? 0,
        phase: entry.phase,
      });
    }
  }
  return messages.sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      (left.sequence ?? 0) - (right.sequence ?? 0)
  );
}

function buildRows(
  history: WorkflowOutputHistory,
  allMessages: OutputMessage[],
  includeParallelGroup = true
) {
  const maxStepIndex = history.orderedEntries.reduce((maximum, entry) => {
    if (
      entry.kind !== OUTPUT_HISTORY_KINDS.CLI ||
      entry.target.kind !== FINAL_STEP_PHASES.QUEUE
    ) {
      return maximum;
    }
    return Math.max(maximum, entry.target.stepIndex);
  }, 0);
  const steps = Array.from({ length: maxStepIndex + 1 }, (_, index) => ({
    name: `step ${index}`,
  })) as WorkflowStep[];
  const hasFinalStep = history.orderedEntries.some(
    (entry) =>
      entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
      entry.target.kind === FINAL_STEP_PHASES.FINAL_STEP
  );
  return buildOutputRows({
    allMessages,
    steps,
    finalStep: hasFinalStep ? ({ name: "final" } as WorkflowStep) : null,
    parallelGroups: includeParallelGroup
      ? [{ id: "parallel", startIndex: 1, endIndex: 2, failFast: false }]
      : [],
    streamingChunks: {},
    finalStepStreamingChunks: {},
    isExecutionActive: false,
    allowUndoActions: false,
    isViewingHistory: true,
    historyOutputs: {
      orderedEntries: history.orderedEntries,
      promptOutputs: history.promptOutputs,
      runMetadata: {
        runId: history.runId,
        startedAt: history.startedAt,
        executionState: history.executionState,
      },
    },
    workspaceSnapshots: {},
    finalStepWorkspaceSnapshots: {},
    undoRecords: {},
    diffCollapseState: new Map(),
    diffExpansionState: new Map(),
    toolCallExpansionState: new Map(),
    defaultDiffCollapsed: false,
  });
}

describe("activity-free output projection equivalence", () => {
  it("preserves structured event order across slices, retries, phases, and a parallel group", () => {
    const history = makeStructuredFixture();
    const currentMessages = mapOrderedHistoryEntriesToMessages(
      history.orderedEntries,
      history.activityEntries
    );
    const candidateHistory = addCandidateOrderMetadata(history);
    const candidateMessages = mapAggregateEventsToMessages(
      candidateHistory.orderedEntries
    );

    const currentRows = buildRows(history, currentMessages).rows;
    const candidateRows = buildRows(
      removeCandidateOrderMetadata(candidateHistory),
      candidateMessages
    ).rows;
    const structuredEventTypes = (rows: typeof currentRows) =>
      rows
        .filter((row) => row.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT)
        .map((row) => row.event.type);
    expect(structuredEventTypes(candidateRows)).toEqual(
      structuredEventTypes(currentRows)
    );
    // Live text chunks retain their own sequence and row identity, while a
    // rebuilt aggregate exposes the same text through its structured events.
    expect(candidateRows).not.toEqual(currentRows);
  });

  it("cannot reproduce interleaved plain-text chunks from structured aggregate events", () => {
    const target = queueTarget(0);
    const history: WorkflowOutputHistory = {
      workflowId: "plain-text-counterexample",
      runId: 1,
      startedAt: 1_000,
      executionState: "COMPLETED" as WorkflowOutputHistory["executionState"],
      promptOutputs: {},
      orderedEntries: [
        {
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target,
          runIndex: 0,
          attemptIndex: 0,
          cliOutput: {
            structured: {
              events: [
                {
                  type: CLI_EVENT_TYPES.BASH_COMMAND,
                  data: {
                    command: "npm test",
                    status: OPERATION_STATUS.COMPLETED,
                    output: "passed",
                  },
                },
              ],
              metadata: {},
            },
            elapsed: 1,
            isStreaming: false,
            timestampMs: 1_000,
          },
          timestampMs: 1_000,
          sequence: 1,
        },
      ],
      activityEntries: [
        {
          timestampMs: 1_001,
          sequence: 2,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "before tool ",
        },
        {
          timestampMs: 1_002,
          sequence: 3,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
          events: [
            {
              type: CLI_EVENT_TYPES.BASH_COMMAND,
              data: {
                command: "npm test",
                status: OPERATION_STATUS.COMPLETED,
                output: "passed",
              },
            },
          ],
        },
        {
          timestampMs: 1_003,
          sequence: 4,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "after tool",
        },
      ],
    };
    const candidateHistory = addCandidateOrderMetadata(history);
    const currentRows = buildRows(
      history,
      mapOrderedHistoryEntriesToMessages(
        history.orderedEntries,
        history.activityEntries
      )
    ).rows;
    const currentMessages = mapOrderedHistoryEntriesToMessages(
      history.orderedEntries,
      history.activityEntries
    );
    const candidateMessages = mapAggregateEventsToMessages(
      candidateHistory.orderedEntries
    );
    const candidateRows = buildRows(
      removeCandidateOrderMetadata(candidateHistory),
      candidateMessages
    ).rows;

    expect(currentRows).not.toEqual(candidateRows);
    expect(
      currentMessages.map(
        (message) => message.activityText ?? message.activityKind
      )
    ).toEqual(["before tool ", OUTPUT_ACTIVITY_KINDS.STRUCTURED, "after tool"]);
    expect(
      candidateMessages.map(
        (message) => message.activityText ?? message.activityKind
      )
    ).toEqual([OUTPUT_ACTIVITY_KINDS.STRUCTURED]);
    expect(
      history.activityEntries?.map((activity) => activity.text).filter(Boolean)
    ).toEqual(["before tool ", "after tool"]);
    expect(
      history.orderedEntries
        .filter((entry) => entry.kind === OUTPUT_HISTORY_KINDS.CLI)
        .flatMap((entry) => entry.cliOutput.structured?.events ?? [])
        .map((event) => event.type)
    ).toEqual([CLI_EVENT_TYPES.BASH_COMMAND]);
  });
});
