import { describe, expect, it } from "vitest";
import {
  parseWorkflowStepClipboardText,
  serializeWorkflowStepText,
} from "@utils/workflowStepSerialization";

describe("workflowStepSerialization", () => {
  it("strips runtime and status fields when parsing clipboard step JSON", () => {
    expect(
      parseWorkflowStepClipboardText(
        JSON.stringify({
          prompt: "Clipboard prompt",
          enabled: false,
          status: "completed",
          _runtime: { startedAt: 1, completedAt: 2 },
        })
      )
    ).toEqual({ prompt: "Clipboard prompt", enabled: false });
  });

  it("serializes workflow step clipboard content without runtime fields", () => {
    expect(
      JSON.parse(
        serializeWorkflowStepText({
          prompt: "Clipboard prompt",
          status: "completed",
          _runtime: { startedAt: 1, completedAt: 2 },
        } as never)
      )
    ).toEqual({ prompt: "Clipboard prompt" });
  });
});
