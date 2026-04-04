import { describe, expect, it } from "vitest";
import {
  mapOrderedHistoryEntriesToMessages,
} from "@utils/outputProjection";
import { FINAL_PROMPT_PHASES, OUTPUT_HISTORY_KINDS } from "@/types/messages";

describe("outputProjection", () => {
  it("maps canonical ordered entries with sequence-preserved chronology", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        target: { kind: FINAL_PROMPT_PHASES.FINAL_PROMPT, loopIndex: 0 },
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
        target: { kind: FINAL_PROMPT_PHASES.QUEUE, stepIndex: 0 },
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
    ).toEqual(["status:queue", "cli:finalPrompt"]);
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[1]?.sequence).toBe(2);
  });
});
