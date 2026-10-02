import { describe, expect, it } from "vitest";
import { buildStepMetadataClipboardText } from "@utils/stepMetadataClipboard";
import type { WorkflowStep } from "@store/workflowStore";

describe("buildStepMetadataClipboardText prior context", () => {
  it("formats previous-count and run-address objects", () => {
    const previousCount = buildStepMetadataClipboardText({
      step: { prompt: "prompt", priorContext: { previous: 3 } } as WorkflowStep,
      slotNumber: 1,
    });
    const runAddress = buildStepMetadataClipboardText({
      step: {
        prompt: "prompt",
        priorContext: { workflowKey: "workflow-1", runRef: "run-1" },
      } as WorkflowStep,
      slotNumber: 1,
    });

    expect(previousCount).toContain("priorContext: Previous 3");
    expect(runAddress).toContain("priorContext: Completed run output");
  });
});
