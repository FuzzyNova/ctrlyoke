import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useActiveWorkflowExternalOwner } from "@hooks/useActiveWorkflowExternalOwner";
import { useUiStore } from "@store/uiStore";
import { RUNNER_IDS } from "@root/types/DashboardConstants";

describe("useActiveWorkflowExternalOwner", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
  });

  it("returns the external owner for the active workflow", () => {
    useUiStore.setState({
      activeWorkflowId: "active-workflow",
      loadedWorkflows: [
        {
          id: "active-workflow",
          externalOwner: { locality: "external", runner: RUNNER_IDS.CLI },
        } as never,
      ],
    });

    const { result } = renderHook(() => useActiveWorkflowExternalOwner());

    expect(result.current).toEqual({
      locality: "external",
      runner: RUNNER_IDS.CLI,
    });
  });

  it("returns undefined when the active workflow is not loaded", () => {
    useUiStore.setState({
      activeWorkflowId: "missing-workflow",
      loadedWorkflows: [{ id: "other-workflow" } as never],
    });

    const { result } = renderHook(() => useActiveWorkflowExternalOwner());

    expect(result.current).toBeUndefined();
  });
});
