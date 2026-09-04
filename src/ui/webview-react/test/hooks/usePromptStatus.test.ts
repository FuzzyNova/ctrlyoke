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
      STEP_STATUS.SENT
    );
    expect(getStatus(useWorkflowStore.getState().steps[2], 2)).toBe(
      STEP_STATUS.PENDING
    );
  });
});
