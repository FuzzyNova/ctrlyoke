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
});
