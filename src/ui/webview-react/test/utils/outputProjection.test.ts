import { describe, expect, it } from "vitest";
import type { WorkflowOutputHistory } from "@root/types/OutputHistoryTypes";
import {
  buildHistoricalProjectionSteps,
  buildProjectedOutputMessages,
  mapOrderedHistoryEntriesToMessages,
} from "@utils/outputProjection";

describe("outputProjection", () => {
  it("maps canonical ordered entries with sequence-preserved chronology", () => {
    const messages = mapOrderedHistoryEntriesToMessages([
      {
        kind: "cli",
        target: { kind: "finalPrompt", loopIndex: 0 },
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
        kind: "status",
        target: { kind: "queue", stepIndex: 0 },
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

  it("uses history outputTimeline to order legacy queue and final prompt steps", () => {
    const history: Pick<
      WorkflowOutputHistory,
      "runStepCount" | "promptOutputs" | "finalPromptOutputs" | "outputTimeline"
    > = {
      runStepCount: 2,
      promptOutputs: {
        0: {
          cliOutputs: [],
          statusMessages: [
            { message: "queue-0", severity: "info", timestamp: 100 },
          ],
        },
        1: {
          cliOutputs: [],
          statusMessages: [
            { message: "queue-1", severity: "info", timestamp: 300 },
          ],
        },
      },
      finalPromptOutputs: {
        0: {
          cliOutputs: [],
          statusMessages: [
            { message: "final-0", severity: "info", timestamp: 200 },
          ],
        },
      },
      outputTimeline: [
        {
          key: "queue:0",
          target: { kind: "queue", stepIndex: 0 },
          firstOutputAt: 100,
        },
        {
          key: "final:0",
          target: { kind: "finalPrompt", loopIndex: 0 },
          firstOutputAt: 200,
        },
        {
          key: "queue:1",
          target: { kind: "queue", stepIndex: 1 },
          firstOutputAt: 300,
        },
      ],
    };

    const steps = buildHistoricalProjectionSteps({
      stepCount: history.runStepCount,
      steps: history.promptOutputs,
      finalPromptOutputs: history.finalPromptOutputs,
      outputTimeline: history.outputTimeline,
    });

    expect(steps.map((step) => `${step.target.kind}:${step.target.index}`)).toEqual([
      "queue:0",
      "finalPrompt:0",
      "queue:1",
    ]);
  });

  it("falls back to real step timestamps instead of synthetic step-index math", () => {
    const messages = buildProjectedOutputMessages([
      {
        target: { kind: "queue", index: 1 },
        cliOutputs: [
          {
            prompt: "",
            response: "later queue",
            elapsed: 0,
            isStreaming: false,
            timestampMs: 300,
          },
        ],
        statusMessages: [],
      },
      {
        target: { kind: "finalPrompt", index: 0 },
        cliOutputs: [
          {
            prompt: "",
            response: "earlier final",
            elapsed: 0,
            isStreaming: false,
            timestampMs: 200,
          },
        ],
        statusMessages: [],
      },
    ]);

    expect(
      messages.map((message) => (message.data as { response?: string }).response)
    ).toEqual(["earlier final", "later queue"]);
  });
});
