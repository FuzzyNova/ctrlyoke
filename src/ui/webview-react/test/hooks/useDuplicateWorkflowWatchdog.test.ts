import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDuplicateWorkflowWatchdog } from "@hooks/useDuplicateWorkflowWatchdog";
import {
  DUPLICATE_WORKFLOW_MAX_RETRIES,
  DUPLICATE_WORKFLOW_RETRY_INTERVAL_MS,
} from "@hooks/useDuplicateWorkflowWatchdog";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

const source = { workflowKey: "workflow-1" as never, kind: "draft" as const };

function postMessageMock() {
  return getVsCodeApi().postMessage as ReturnType<typeof vi.fn>;
}

function duplicateSends() {
  return postMessageMock().mock.calls.filter(
    (call) => call[0]?.type === MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT
  );
}

function beginRequest() {
  useUiStore.getState().beginDuplicateWorkflowRequest({
    requestId: "duplicate-1",
    source,
    workflowName: "Variant",
    overrides: { model: "model-1" },
  });
}

describe("useDuplicateWorkflowWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessageMock().mockClear();
    useUiStore.getState().resetUi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reissues the exact payload with the original request id", () => {
    renderHook(() => useDuplicateWorkflowWatchdog());
    act(beginRequest);

    act(() => {
      vi.advanceTimersByTime(DUPLICATE_WORKFLOW_RETRY_INTERVAL_MS);
    });

    expect(duplicateSends()).toHaveLength(1);
    expect(duplicateSends()[0][0]).toEqual({
      type: MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT,
      requestId: "duplicate-1",
      source,
      workflowName: "Variant",
      overrides: { model: "model-1" },
    });
  });

  it("retires after the bounded retry budget with a visible error", () => {
    renderHook(() => useDuplicateWorkflowWatchdog());
    act(beginRequest);

    act(() => {
      vi.advanceTimersByTime(
        DUPLICATE_WORKFLOW_RETRY_INTERVAL_MS *
          (DUPLICATE_WORKFLOW_MAX_RETRIES + 1)
      );
    });

    const ui = useUiStore.getState();
    expect(duplicateSends()).toHaveLength(DUPLICATE_WORKFLOW_MAX_RETRIES);
    expect(ui.duplicateWorkflowRequest).toBeNull();
    expect(ui.duplicateWorkflowError).toMatch(/connection/);
  });

  it("stops retrying after a matching success or failure retires the request", () => {
    renderHook(() => useDuplicateWorkflowWatchdog());
    act(beginRequest);

    act(() => {
      useUiStore.getState().retireDuplicateWorkflowRequest("failed");
    });
    act(() => {
      vi.advanceTimersByTime(DUPLICATE_WORKFLOW_RETRY_INTERVAL_MS * 2);
    });

    expect(duplicateSends()).toHaveLength(0);
    expect(useUiStore.getState().duplicateWorkflowError).toBe("failed");
  });

  it("leaves a new attempt usable after a terminal failure", () => {
    renderHook(() => useDuplicateWorkflowWatchdog());
    act(beginRequest);
    act(() => {
      useUiStore.getState().retireDuplicateWorkflowRequest("failed");
    });

    act(() => {
      useUiStore.getState().beginDuplicateWorkflowRequest({
        requestId: "duplicate-2",
        source,
        workflowName: "Variant Again",
      });
    });

    expect(useUiStore.getState().duplicateWorkflowRequest?.requestId).toBe(
      "duplicate-2"
    );
    expect(useUiStore.getState().duplicateWorkflowError).toBeNull();
  });
});
