import { describe, expect, it } from "vitest";
import { buildStepMetadataClipboardText } from "@utils/stepMetadataClipboard";
import type { WorkflowStep } from "@store/workflowStore";

describe("buildStepMetadataClipboardText prior context", () => {
  it("formats previous-count and run-source objects", () => {
    const previousCount = buildStepMetadataClipboardText({
      step: { prompt: "prompt", priorContext: { previous: 3 } } as WorkflowStep,
      slotNumber: 1,
    });
    const runSource = buildStepMetadataClipboardText({
      step: {
        prompt: "prompt",
        priorContext: { workflow: "workflow-1", run: 2 },
      } as WorkflowStep,
      slotNumber: 1,
    });

    expect(previousCount).toContain("priorContext: Previous 3");
    expect(runSource).toContain("priorContext: Completed run output");
  });

  it("uses live context telemetry while the step is rerunning", () => {
    const text = buildStepMetadataClipboardText({
      step: { prompt: "prompt" } as WorkflowStep,
      slotNumber: 1,
      isCurrent: true,
      latestOutput: {
        tokens: { contextWindowUsed: 20_000, contextWindowSize: 100_000 },
      } as never,
      liveContextWindow: { used: 40_000, size: 200_000 },
    });

    expect(text).toContain("Current context window: 40k/200k (20%)");
    expect(text).not.toContain("Current context window: 20k/100k (20%)");
  });
});
