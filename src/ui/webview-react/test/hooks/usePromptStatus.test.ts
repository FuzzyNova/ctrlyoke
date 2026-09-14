import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePromptStatus } from "@hooks/usePromptStatus";
import { useWorkflowStore } from "@store/workflowStore";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";

beforeEach(() => {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
});

describe("usePromptStatus", () => {
  it("uses recorded statuses for every member while a group is at currentStep", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "group.ctrlyoke.yaml",
      steps: [{ prompt: "first" }, { prompt: "second" }, { prompt: "third" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 0,
      activeStepIndices: [1],
      parallelGroups: [
        { id: "group-1", startIndex: 0, endIndex: 1, failFast: true },
      ],
    });
    useWorkflowStore.getState().setStepStatus(0, STEP_STATUS.COMPLETED);
    useWorkflowStore.getState().setStepStatus(1, STEP_STATUS.SENT);

    const { result } = renderHook(() => usePromptStatus());
    const getStatus = result.current;

    expect(getStatus(useWorkflowStore.getState().steps[0], 0)).toBe(
      STEP_STATUS.COMPLETED
    );
    expect(getStatus(useWorkflowStore.getState().steps[1], 1)).toBe(
      STEP_STATUS.RUNNING
    );
    expect(getStatus(useWorkflowStore.getState().steps[2], 2)).toBe(
      STEP_STATUS.PENDING
    );
  });

  // An in-flight failure advances currentStep past the step that failed, so
  // the error icon belongs on currentStep - 1. The recorded FAILED status is
  // the only thing that distinguishes this from a pre-flight failure at
  // currentStep itself — when it was missing, a workflow that died on step 4
  // of 5 put the error glyph on step 5 and left step 4 looking untouched.
  it("keeps the error icon on the failed step, not the one after it", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "failed.ctrlyoke.yaml",
      steps: [
        { prompt: "first" },
        { prompt: "second" },
        { prompt: "third" },
        { prompt: "fourth" },
        { prompt: "fifth" },
      ],
      executionState: EXECUTION_STATES.ERROR,
      currentStep: 4,
    });
    useWorkflowStore.getState().setStepStatus(0, STEP_STATUS.COMPLETED);
    useWorkflowStore.getState().setStepStatus(1, STEP_STATUS.COMPLETED);
    useWorkflowStore.getState().setStepStatus(2, STEP_STATUS.COMPLETED);
    useWorkflowStore.getState().setStepStatus(3, STEP_STATUS.FAILED);

    const { result } = renderHook(() => usePromptStatus());
    const getStatus = result.current;

    expect(getStatus(useWorkflowStore.getState().steps[3], 3)).toBe(
      STEP_STATUS.FAILED
    );
    expect(getStatus(useWorkflowStore.getState().steps[4], 4)).toBe(
      STEP_STATUS.PENDING
    );
  });

  // The complementary case the guard must not break: a failure before any step
  // ran has no per-step status of its own, so currentStep itself is the one to
  // mark.
  it("marks currentStep failed when no earlier step recorded a failure", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "preflight.ctrlyoke.yaml",
      steps: [{ prompt: "first" }, { prompt: "second" }],
      executionState: EXECUTION_STATES.ERROR,
      currentStep: 1,
    });
    useWorkflowStore.getState().setStepStatus(0, STEP_STATUS.COMPLETED);

    const { result } = renderHook(() => usePromptStatus());
    const getStatus = result.current;

    expect(getStatus(useWorkflowStore.getState().steps[1], 1)).toBe(
      STEP_STATUS.FAILED
    );
  });
});
