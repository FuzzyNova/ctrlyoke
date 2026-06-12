import { describe, it, expect } from "vitest";
import { getAutoResumePreview } from "@utils/autoResumePreview";
import type { WorkflowStep } from "../../store/workflowStore";

function promptStep(
  overrides: Partial<WorkflowStep> & { prompt: string }
): WorkflowStep {
  return overrides as WorkflowStep;
}

describe("getAutoResumePreview", () => {
  it("returns not resumable when harness is undefined", () => {
    const steps = [
      promptStep({ prompt: "a", _runtime: { harness: "claude-cli", sessionId: "s1" } }),
    ];
    expect(getAutoResumePreview(steps, steps.length, undefined)).toEqual({
      resumable: false,
    });
  });

  it("returns not resumable when no prior step matches the harness", () => {
    const steps = [
      promptStep({ prompt: "a", _runtime: { harness: "codex-cli", sessionId: "s1" } }),
    ];
    expect(getAutoResumePreview(steps, steps.length, "claude-cli")).toEqual({
      resumable: false,
    });
  });

  it("returns not resumable when a matching step has no sessionId", () => {
    const steps = [
      promptStep({ prompt: "a", _runtime: { harness: "claude-cli" } }),
    ];
    expect(getAutoResumePreview(steps, steps.length, "claude-cli")).toEqual({
      resumable: false,
    });
  });

  it("finds the most recent matching step searching backward", () => {
    const steps = [
      promptStep({ prompt: "a", _runtime: { harness: "claude-cli", sessionId: "s1" } }),
      promptStep({ prompt: "b", _runtime: { harness: "codex-cli", sessionId: "s2" } }),
      promptStep({ prompt: "c", _runtime: { harness: "claude-cli", sessionId: "s3" } }),
    ];
    expect(getAutoResumePreview(steps, steps.length, "claude-cli")).toEqual({
      resumable: true,
      stepLabel: "Step 3",
    });
  });

  it("includes the step name in the label when present", () => {
    const steps = [
      promptStep({
        prompt: "a",
        name: "Refactor auth",
        _runtime: { harness: "claude-cli", sessionId: "s1" },
      }),
    ];
    expect(getAutoResumePreview(steps, steps.length, "claude-cli")).toEqual({
      resumable: true,
      stepLabel: 'Step 1 ("Refactor auth")',
    });
  });

  it("only searches steps before beforeIndex", () => {
    const steps = [
      promptStep({ prompt: "a", _runtime: { harness: "claude-cli", sessionId: "s1" } }),
      promptStep({ prompt: "b", _runtime: { harness: "claude-cli", sessionId: "s2" } }),
    ];
    // Editing step index 1 (0-based) — only step 1 ("a") is a candidate.
    expect(getAutoResumePreview(steps, 1, "claude-cli")).toEqual({
      resumable: true,
      stepLabel: "Step 1",
    });
  });

  it("skips script steps", () => {
    const steps = [
      promptStep({ prompt: "a", _runtime: { harness: "claude-cli", sessionId: "s1" } }),
      { type: "script", script: "echo hi" } as unknown as WorkflowStep,
    ];
    expect(getAutoResumePreview(steps, steps.length, "claude-cli")).toEqual({
      resumable: true,
      stepLabel: "Step 1",
    });
  });
});
