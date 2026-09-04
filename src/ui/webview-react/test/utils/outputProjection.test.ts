import { describe, expect, it } from "vitest";
import { mapOrderedHistoryEntriesToMessages } from "@utils/outputProjection";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_HISTORY_KINDS,
} from "@/types/messages";

describe("outputProjection", () => {
  it("maps canonical ordered entries with sequence-preserved chronology", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 0 },
        attemptIndex: 0,
        cliOutput: {
          prompt: "",
          response: "final response",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 2,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.STATUS,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        statusMessage: {
          message: "queue first",
          severity: "info",
          timestamp: 1000,
        },
        timestampMs: 1000,
        sequence: 1,
      },
    ]);

    expect(
      messages.map((message) => `${message.type}:${message.target.kind}`)
    ).toEqual(["status:queue", "cli:finalStep"]);
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[1]?.sequence).toBe(2);
  });

  it("normalizes runIndex from ordered entries or cli output", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 2,
        attemptIndex: 0,
        cliOutput: {
          prompt: "",
          response: "explicit run",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 1,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        attemptIndex: 1,
        cliOutput: {
          prompt: "",
          response: "fallback run",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1001,
          runIndex: 3,
        },
        timestampMs: 1001,
        sequence: 2,
      },
    ]);

    expect(messages.map((message) => message.runIndex)).toEqual([2, 3]);
  });

  it("projects streaming and completed snapshots of one setup attempt as one message", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 0,
        attemptIndex: 0,
        phase: "worktreeSetup",
        cliOutput: {
          response: "",
          elapsed: 0,
          isStreaming: true,
          source: "worktreeSetup",
          timestampMs: 1000,
          cliCommand: "npm ci",
          workingDirectory: "C:\\repo.worktrees\\feature",
        },
        timestampMs: 1000,
        sequence: 1,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 0,
        attemptIndex: 0,
        phase: "worktreeSetup",
        cliOutput: {
          response: "installed packages",
          elapsed: 22,
          isStreaming: false,
          source: "worktreeSetup",
          timestampMs: 1000,
          cliCommand: "npm ci",
          workingDirectory: "C:\\repo.worktrees\\feature",
          exitCode: 0,
        },
        timestampMs: 1022,
        sequence: 2,
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      timestamp: 1000,
      sequence: 1,
      data: {
        response: "installed packages",
        isStreaming: false,
        cliCommand: "npm ci",
      },
    });
  });

  it("keeps interleaved target activity in timeline order", () => {
    const targetA = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const targetB = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [
        ...[targetA, targetB].map((target) => ({
          kind: OUTPUT_HISTORY_KINDS.CLI,
          target,
          runIndex: 0,
          attemptIndex: 0,
          cliOutput: {
            prompt: "",
            response: "",
            elapsed: 0,
            isStreaming: false,
            timestampMs: 1000,
          },
          timestampMs: 1000,
          sequence: 10,
        })),
      ],
      [
        {
          timestampMs: 1000,
          sequence: 1,
          target: targetA,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "A1",
        },
        {
          timestampMs: 1001,
          sequence: 2,
          target: targetB,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "B1",
        },
        {
          timestampMs: 1002,
          sequence: 3,
          target: targetA,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.TEXT,
          text: "A2",
        },
      ]
    );

    expect(messages.map((message) => message.activityText)).toEqual([
      "A1",
      "B1",
      "A2",
    ]);
  });

  it("updates a tool activity in place when its result arrives", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const messages = mapOrderedHistoryEntriesToMessages(
      [],
      [
        {
          timestampMs: 1000,
          sequence: 1,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
          events: [
            {
              type: CLI_EVENT_TYPES.TOOL_CALL,
              data: { id: "tool-1", name: "read", parameters: {} },
            },
          ],
        },
        {
          timestampMs: 1001,
          sequence: 2,
          target,
          runIndex: 0,
          attemptIndex: 0,
          kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
          events: [
            {
              type: CLI_EVENT_TYPES.TOOL_RESULT,
              data: {
                toolCallId: "tool-1",
                result: { success: true, output: "done" },
              },
            },
          ],
        },
      ]
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[0]?.activityEvents?.[0]).toMatchObject({
      type: CLI_EVENT_TYPES.TOOL_RESULT,
    });
  });

  it("keeps live and replay projections in the same interleaved order", () => {
    const targetA = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const targetB = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 } as const;
    const orderedEntries = [
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: targetA,
        runIndex: 0,
        attemptIndex: 0,
        cliOutput: {
          prompt: "",
          response: "complete A",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 5,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: targetB,
        runIndex: 0,
        attemptIndex: 0,
        cliOutput: {
          prompt: "",
          response: "complete B",
          elapsed: 0,
          isStreaming: false,
          timestampMs: 1000,
        },
        timestampMs: 1000,
        sequence: 6,
      },
    ] as const;
    const activityEntries = [
      {
        timestampMs: 1000,
        sequence: 1,
        target: targetA,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.TEXT,
        text: "A1",
      },
      {
        timestampMs: 1001,
        sequence: 2,
        target: targetB,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.TEXT,
        text: "B1",
      },
      {
        timestampMs: 1002,
        sequence: 3,
        target: targetA,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.TEXT,
        text: "A2",
      },
    ] as const;

    const project = () =>
      mapOrderedHistoryEntriesToMessages(orderedEntries, activityEntries);
    const liveProjection = project();
    const replayProjection = project();

    expect(
      liveProjection.map((message) => `${message.target.index}:${message.activityText}`)
    ).toEqual(["0:A1", "1:B1", "0:A2"]);
    expect(replayProjection).toEqual(liveProjection);
  });
});
