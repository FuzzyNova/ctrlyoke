import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useRunDispatchTargets } from "@hooks/useRunDispatchTargets";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  EDITOR_TARGET_KINDS,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_TYPES,
} from "@root/types/DashboardConstants";

beforeEach(() => {
  useEditorStore.getState().resetEditor();
  useWorkflowStore.setState({
    executionState: EXECUTION_STATES.IDLE,
    currentStep: 0,
    activeStepIndices: [],
    finalStepPhase: null,
    parallelGroups: [],
  });
  useSettingsStore.setState((state) => ({
    globalSettings: {
      ...state.globalSettings,
      effectiveParallelGroupWidth: 6,
    },
  }));
  useUiStore.setState({ activeWorkflowId: "workflow-1", loadedWorkflows: [] });
  useEditorStore.setState({
    selectionTarget: { kind: EDITOR_TARGET_KINDS.NEW_PROMPT },
    promptText: "draft",
    stepType: STEP_TYPES.PROMPT,
  });
});

function setRunningState(
  activeStepIndices: readonly number[],
  overrides: Partial<{
    executionState: typeof EXECUTION_STATES.RUNNING;
    finalStepPhase: null | typeof FINAL_STEP_PHASES.FINAL_STEP;
    parallelGroups: Array<{
      id: string;
      startIndex: number;
      endIndex: number;
      failFast: boolean;
    }>;
  }> = {}
) {
  useWorkflowStore.setState({
    executionState: EXECUTION_STATES.RUNNING,
    activeStepIndices: [...activeStepIndices],
    ...overrides,
  });
}

describe("useRunDispatchTargets", () => {
  it("enables both destinations for a running queue step", () => {
    setRunningState([2]);

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel).toEqual({
      enabled: true,
      title: "Runs beside step 3; prior context resolves from before step 3",
    });
    expect(result.current.newWorkflow).toEqual({
      enabled: true,
      title: "Starts a separate workflow with default settings and this prompt",
    });
  });

  it.each([
    ["no step is running", [], {}, "No step is running"],
    [
      "the final step is running",
      [2],
      { finalStepPhase: FINAL_STEP_PHASES.FINAL_STEP },
      "The final step can't run in parallel",
    ],
    [
      "the width is one",
      [2],
      {},
      "Parallel width is 1 — raise `queue.maxParallelSteps`",
    ],
  ] as const)(
    "disables parallel when %s",
    (_label, indices, overrides, reason) => {
      if (reason.startsWith("Parallel width")) {
        useSettingsStore.setState((state) => ({
          globalSettings: {
            ...state.globalSettings,
            effectiveParallelGroupWidth: 1,
          },
        }));
      }
      setRunningState(indices, overrides);

      const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

      expect(result.current.parallel).toMatchObject({
        enabled: false,
        disabledReason: reason,
        title: reason,
      });
    }
  );

  it("reports pausing before other running-state reasons", () => {
    useWorkflowStore.setState({
      executionState: EXECUTION_STATES.PAUSING,
      activeStepIndices: [2],
    });

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel).toMatchObject({
      enabled: false,
      disabledReason: "Workflow is pausing",
    });
  });

  it("does not gate a join on a saturated parallel group", () => {
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        effectiveParallelGroupWidth: 2,
      },
    }));
    setRunningState([2, 3], {
      parallelGroups: [
        { id: "group-1", startIndex: 2, endIndex: 3, failFast: false },
      ],
    });

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel.enabled).toBe(true);
  });

  it("disables only parallel outside new-prompt mode", () => {
    useEditorStore.setState({
      selectionTarget: { kind: FINAL_STEP_PHASES.FINAL_STEP },
    });
    setRunningState([2]);

    const { result } = renderHook(() => useRunDispatchTargets("workflow-1"));

    expect(result.current.parallel.disabledReason).toBe(
      "Only available for a new prompt"
    );
    expect(result.current.newWorkflow.enabled).toBe(true);
  });
});
