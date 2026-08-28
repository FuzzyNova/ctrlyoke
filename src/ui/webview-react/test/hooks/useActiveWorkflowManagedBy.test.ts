import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useActiveWorkflowManagedBy } from "@hooks/useActiveWorkflowManagedBy";
import { useUiStore } from "@store/uiStore";
import { RUNNER_IDS } from "@root/types/DashboardConstants";

describe("useActiveWorkflowManagedBy", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
  });

  it("returns the manager for the active workflow", () => {
    useUiStore.setState({
      activeWorkflowId: "active-workflow",
      loadedWorkflows: [
        { id: "active-workflow", managedBy: RUNNER_IDS.CLI } as never,
      ],
    });

    const { result } = renderHook(() => useActiveWorkflowManagedBy());

    expect(result.current).toBe(RUNNER_IDS.CLI);
  });

  it("returns undefined when the active workflow is not loaded", () => {
    useUiStore.setState({
      activeWorkflowId: "missing-workflow",
      loadedWorkflows: [{ id: "other-workflow" } as never],
    });

    const { result } = renderHook(() => useActiveWorkflowManagedBy());

    expect(result.current).toBeUndefined();
  });
});
