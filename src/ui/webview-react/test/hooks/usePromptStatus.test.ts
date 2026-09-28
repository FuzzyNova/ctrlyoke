import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePromptStatus } from "@hooks/usePromptStatus";
import { useWorkflowStore } from "@store/workflowStore";
import { EXECUTION_STATES, STEP_STATUS } from "@/types/messages";
import { FINAL_STEP_PHASES } from "@root/types/DashboardConstants";
import { isStepExecuting } from "@utils/status";

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

  // A run-view snapshot clears activeStepIndices and reports the in-flight
  // step as SENT. Before this was normalized, promoting a running step into an
  // ad-hoc parallel group swapped its play glyph for the "sent" arrow, because
  // the group branch returned the recorded status untouched.
  it("shows a group's in-flight anchor as running when SENT is all that is recorded", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "promoted.ctrlyoke.yaml",
      steps: [{ prompt: "anchor" }, { prompt: "promoted" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 0,
      activeStepIndices: [],
      parallelGroups: [
        { id: "ad-hoc", startIndex: 0, endIndex: 1, failFast: false },
      ],
    });
    useWorkflowStore.getState().setStepStatus(0, STEP_STATUS.SENT);
    useWorkflowStore.getState().setStepStatus(1, STEP_STATUS.PENDING);

    const { result } = renderHook(() => usePromptStatus());
    const getStatus = result.current;

    expect(getStatus(useWorkflowStore.getState().steps[0], 0)).toBe(
      STEP_STATUS.RUNNING
    );
    expect(getStatus(useWorkflowStore.getState().steps[1], 1)).toBe(
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

  // While the final step runs, currentStep sits one past the last queue step,
  // so a step the final step appends (append_step) lands on exactly that
  // index. It used to show the running play icon and highlight before the
  // queue had picked it up.
  it("keeps a step appended by a running final step pending", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "appended.ctrlyoke.yaml",
      steps: [{ prompt: "first" }, { prompt: "appended" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      finalStep: { prompt: "final" },
      finalStepStatus: STEP_STATUS.RUNNING,
      finalStepPhase: FINAL_STEP_PHASES.FINAL_STEP,
    });
    useWorkflowStore.getState().setStepStatus(0, STEP_STATUS.COMPLETED);

    const { result } = renderHook(() => usePromptStatus());
    const getStatus = result.current;

    expect(getStatus(useWorkflowStore.getState().steps[0], 0)).toBe(
      STEP_STATUS.COMPLETED
    );
    expect(getStatus(useWorkflowStore.getState().steps[1], 1)).toBe(
      STEP_STATUS.PENDING
    );
    expect(
      isStepExecuting(
        EXECUTION_STATES.RUNNING,
        1,
        1,
        [],
        FINAL_STEP_PHASES.FINAL_STEP
      )
    ).toBe(false);
  });

  it("shows the appended step running once the queue picks it up", () => {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "appended.ctrlyoke.yaml",
      steps: [{ prompt: "first" }, { prompt: "appended" }],
      executionState: EXECUTION_STATES.RUNNING,
      currentStep: 1,
      finalStep: { prompt: "final" },
      finalStepStatus: STEP_STATUS.COMPLETED,
      finalStepPhase: FINAL_STEP_PHASES.QUEUE,
    });

    const { result } = renderHook(() => usePromptStatus());

    expect(result.current(useWorkflowStore.getState().steps[1], 1)).toBe(
      STEP_STATUS.RUNNING
    );
    expect(
      isStepExecuting(
        EXECUTION_STATES.RUNNING,
        1,
        1,
        [],
        FINAL_STEP_PHASES.QUEUE
      )
    ).toBe(true);
  });
});
