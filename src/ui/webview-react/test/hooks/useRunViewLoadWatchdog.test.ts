import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunViewLoadWatchdog } from "@hooks/useRunViewLoadWatchdog";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";

// This assertion covers the standalone queue branch of notifyUser().
vi.hoisted(() => {
  window.__ctrlyokeStandalone = true;
});

const RETRY_INTERVAL_MS = 15000;
const MAX_RETRIES = 4;

function postMessageMock() {
  return getVsCodeApi().postMessage as ReturnType<typeof vi.fn>;
}

function loadRunViewSends() {
  return postMessageMock().mock.calls.filter(
    (call) => call[0]?.type === MESSAGE_TYPES.LOAD_RUN_VIEW
  );
}

describe("useRunViewLoadWatchdog", () => {
  const address = { workflowKey: "wf-lost" as never, kind: "draft" as const };

  beforeEach(() => {
    vi.useFakeTimers();
    postMessageMock().mockClear();
    useUiStore.getState().resetUi();
    useUiStore.setState({
      displayedViewAddress: null,
      appliedViewAddress: null,
      pendingRunViewRequestId: null,
      pendingRunViewAddress: null,
      pendingRunViewSwitch: null,
      runViewLoadRetrying: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing while no request is pending", () => {
    renderHook(() => useRunViewLoadWatchdog());

    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS * (MAX_RETRIES + 2));
    });

    expect(loadRunViewSends()).toHaveLength(0);
    expect(useUiStore.getState().pendingRunViewRequestId).toBeNull();
  });

  it("reissues the same request id so a late answer to either send still counts", () => {
    renderHook(() => useRunViewLoadWatchdog());

    let requestId = "";
    act(() => {
      requestId = useUiStore.getState().requestRunViewLoad(address, []);
    });

    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS);
    });

    expect(loadRunViewSends()).toHaveLength(1);
    expect(postMessageMock()).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_RUN_VIEW,
      address,
      requestId,
    });
    expect(useUiStore.getState().pendingRunViewRequestId).toBe(requestId);
    expect(useUiStore.getState().runViewLoadRetrying).toBe(true);
  });

  // The single-shot retry this replaced scheduled nothing after its one attempt,
  // so a reissue lost to the same outage left the request outstanding forever.
  // On the hosted server that is not an edge case: standalone-shim.js drops any
  // outbound message posted while the socket is down.
  it("keeps reissuing on an interval rather than giving up after one attempt", () => {
    renderHook(() => useRunViewLoadWatchdog());

    act(() => {
      useUiStore.getState().requestRunViewLoad(address, []);
    });

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      act(() => {
        vi.advanceTimersByTime(RETRY_INTERVAL_MS);
      });
      expect(loadRunViewSends()).toHaveLength(attempt);
    }
  });

  it("retires an unanswered request so server-initiated view pushes resume", () => {
    renderHook(() => useRunViewLoadWatchdog());

    act(() => {
      useUiStore.getState().requestRunViewLoad(address, []);
    });

    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS * (MAX_RETRIES + 1));
    });

    const ui = useUiStore.getState();
    // A pending id suppresses every requestless RUN_VIEW_LOADED, and for a
    // cross-lineage switch the interaction-blocking overlay sits on top of it.
    expect(ui.pendingRunViewRequestId).toBeNull();
    expect(ui.pendingRunViewSwitch).toBeNull();
    expect(loadRunViewSends()).toHaveLength(MAX_RETRIES);
    expect(
      ui.toastQueue.some(
        (toast) => toast.severity === USER_FEEDBACK_SEVERITY.ERROR
      )
    ).toBe(true);
  });

  // Giving up must not swap one broken state for another: the request moved the
  // address optimistically, so retiring it alone leaves the header naming the
  // workflow that failed to load while the panels still render the previous one.
  it("rolls the view back to the workflow still on screen when it gives up", () => {
    const previousAddress = {
      workflowKey: "wf-current" as never,
      kind: "run" as const,
      runRef: "run-2026-01-01T00-00-00-000Z" as never,
    };
    const previousSummaries = [
      { runRef: previousAddress.runRef, executionState: "completed" },
    ] as never;
    useUiStore.setState({
      displayedViewAddress: previousAddress,
      appliedViewAddress: previousAddress,
      runSummaries: previousSummaries,
      executionRunRef: "run-2026-01-01T00-00-00-000Z",
      displayedDefinitionRevision: 7,
      displayedDescriptorRevision: 3,
      isViewingHistory: true,
    });
    renderHook(() => useRunViewLoadWatchdog());

    act(() => {
      useUiStore.getState().requestRunViewLoad(address, []);
    });
    // Optimistic move applied — this is the state that must not survive.
    expect(useUiStore.getState().displayedViewAddress).toEqual(address);

    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS * (MAX_RETRIES + 1));
    });

    const ui = useUiStore.getState();
    expect(ui.displayedViewAddress).toEqual(previousAddress);
    expect(ui.runSummaries).toEqual(previousSummaries);
    expect(ui.executionRunRef).toBe("run-2026-01-01T00-00-00-000Z");
    expect(ui.displayedDefinitionRevision).toBe(7);
    expect(ui.displayedDescriptorRevision).toBe(3);
    expect(ui.isViewingHistory).toBe(true);
    // Dropped so a click on the workflow we just returned to is a real reload
    // rather than the no-op the displayed/applied short-circuit would make it.
    expect(ui.appliedViewAddress).toBeNull();
  });

  it("stops reissuing once the snapshot arrives", () => {
    renderHook(() => useRunViewLoadWatchdog());

    act(() => {
      useUiStore.getState().requestRunViewLoad(address, []);
    });
    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS);
    });
    expect(loadRunViewSends()).toHaveLength(1);

    act(() => {
      useUiStore.getState().clearPendingRunViewLoad();
    });
    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS * (MAX_RETRIES + 2));
    });

    expect(loadRunViewSends()).toHaveLength(1);
  });

  it("restarts its patience when the user navigates somewhere else", () => {
    renderHook(() => useRunViewLoadWatchdog());

    act(() => {
      useUiStore.getState().requestRunViewLoad(address, []);
    });
    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS * MAX_RETRIES);
    });
    expect(loadRunViewSends()).toHaveLength(MAX_RETRIES);

    let secondId = "";
    act(() => {
      secondId = useUiStore
        .getState()
        .requestRunViewLoad(
          {
            workflowKey: "wf-other" as never,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          },
          []
        );
    });
    // The new request gets a full retry budget, not the previous one's remainder.
    act(() => {
      vi.advanceTimersByTime(RETRY_INTERVAL_MS * MAX_RETRIES);
    });

    expect(useUiStore.getState().pendingRunViewRequestId).toBe(secondId);
    expect(loadRunViewSends()).toHaveLength(MAX_RETRIES * 2);
  });
});
