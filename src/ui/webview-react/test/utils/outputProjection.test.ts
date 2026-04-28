import { describe, expect, it } from "vitest";
import { mapOrderedHistoryEntriesToMessages } from "@utils/outputProjection";
import { FINAL_STEP_PHASES, OUTPUT_HISTORY_KINDS } from "@/types/messages";

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
});
