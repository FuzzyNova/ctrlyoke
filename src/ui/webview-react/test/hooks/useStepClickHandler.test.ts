import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStepClickHandler } from "@hooks/useStepClickHandler";
import { useEditorStore } from "@store/editorStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { FINAL_STEP_PHASES } from "@/types/messages";
import {
  setActiveOutputNavigationController,
  type OutputNavigationController,
} from "@utils/outputNavigation";

function resetStores() {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useEditorStore.getState().resetEditor();
  useUiStore.getState().resetUi();
}

describe("useStepClickHandler", () => {
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

  beforeEach(() => {
    resetStores();
    useWorkflowStore.getState().loadWorkflow({
      fileName: "test.prompt.md",
      steps: [{ prompt: "Step 1" }],
    });

    originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
  });

  afterEach(() => {
    setActiveOutputNavigationController(null);
    window.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it("navigates when the active output controller has a target even without a raw CLI entry", () => {
    const scrollToTarget = vi.fn();
    const controller: OutputNavigationController = {
      scrollToRowIndex: vi.fn(),
      scrollToTarget,
      getTargetScrollFraction: vi.fn(() => 0.25),
    };
    setActiveOutputNavigationController(controller);

    const { result } = renderHook(() => useStepClickHandler());

    act(() => {
      result.current(0);
    });

    expect(useEditorStore.getState().selectionTarget).toEqual({
      kind: FINAL_STEP_PHASES.QUEUE,
      index: 0,
    });
    expect(scrollToTarget).toHaveBeenCalledWith(
      { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      { behavior: "smooth", align: "start" }
    );
  });

  it("skips navigation when the output controller has no anchor for the step", () => {
    const scrollToTarget = vi.fn();
    const controller: OutputNavigationController = {
      scrollToRowIndex: vi.fn(),
      scrollToTarget,
      getTargetScrollFraction: vi.fn(() => null),
    };
    setActiveOutputNavigationController(controller);

    const { result } = renderHook(() => useStepClickHandler());

    act(() => {
      result.current(0);
    });

    expect(scrollToTarget).not.toHaveBeenCalled();
  });
});
