import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunViewLoadWatchdog } from "@hooks/useRunViewLoadWatchdog";
import { useMessageHandler } from "@hooks/useMessageHandler";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { useWorkflowStore } from "@store/workflowStore";

vi.hoisted(() => {
  window.__ctrlyokeStandalone = true;
});

const GIVE_UP_MS = 75000;
const address = { workflowKey: "wf-watchdog" as never, kind: "draft" as const };

function postMessageMock() {
  return getVsCodeApi().postMessage as ReturnType<typeof vi.fn>;
}

function dispatchRunViewLoaded(requestId: string) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: MESSAGE_TYPES.RUN_VIEW_LOADED,
        requestId,
        address,
        workflowName: "Late workflow",
        workingFile: { workflowName: "Late workflow", steps: [] },
        workflowProperties: {},
        runSummaries: [],
        history: null,
      },
    })
  );
}

describe("useRunViewLoadWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessageMock().mockClear();
    useWorkflowStore.getState().resetWorkflow();
    useUiStore.getState().resetUi();
    useUiStore.setState({
      displayedViewAddress: null,
      appliedViewAddress: null,
      pendingRunViewRequestId: null,
      pendingRunViewAddress: null,
      pendingRunViewSwitch: null,
      runViewLoadRetrying: false,
      retiredRunViewRequestId: null,
    });
    window.__ctrlyokeStandalone = true;
    window.__ctrlyokeTransportConnected = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never reissues or rolls back a slow request in panel mode", () => {
    window.__ctrlyokeStandalone = false;
    renderHook(() => useRunViewLoadWatchdog());
    let requestId = "";
    act(() => {
      requestId = useUiStore.getState().requestRunViewLoad(address, []);
      vi.advanceTimersByTime(GIVE_UP_MS * 2);
    });

    expect(postMessageMock()).not.toHaveBeenCalled();
    expect(useUiStore.getState().pendingRunViewRequestId).toBe(requestId);
    expect(useUiStore.getState().displayedViewAddress).toEqual(address);
    expect(useUiStore.getState().toastQueue).toHaveLength(0);
  });

  it("reissues after the hosted transport reconnects", () => {
    renderHook(() => useRunViewLoadWatchdog());
    renderHook(() => useMessageHandler());
    let requestId = "";
    act(() => {
      requestId = useUiStore.getState().requestRunViewLoad(address, []);
      window.__ctrlyokeTransportConnected = false;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.CLIENT_ID_ASSIGNED,
            clientId: "browser:1",
          },
        })
      );
    });

    expect(postMessageMock()).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.LOAD_RUN_VIEW,
      address,
      requestId,
    });
    expect(useUiStore.getState().pendingRunViewRequestId).toBe(requestId);
  });

  it("does not give up while hosted transport is connected, and applies a late answer after disconnected give-up", () => {
    renderHook(() => useRunViewLoadWatchdog());
    renderHook(() => useMessageHandler());
    let requestId = "";
    act(() => {
      requestId = useUiStore.getState().requestRunViewLoad(address, []);
      vi.advanceTimersByTime(GIVE_UP_MS * 2);
    });
    expect(useUiStore.getState().pendingRunViewRequestId).toBe(requestId);

    act(() => {
      window.__ctrlyokeTransportConnected = false;
      vi.advanceTimersByTime(GIVE_UP_MS + 1000);
    });
    expect(useUiStore.getState().pendingRunViewRequestId).toBeNull();
    expect(useUiStore.getState().retiredRunViewRequestId).toBe(requestId);

    act(() => dispatchRunViewLoaded(requestId));
    expect(useWorkflowStore.getState().workflowName).toBe("Late workflow");
    expect(useUiStore.getState().displayedViewAddress).toEqual(address);
    expect(useUiStore.getState().retiredRunViewRequestId).toBeNull();
  });

  it("does not apply a retired answer after a newer navigation starts", () => {
    renderHook(() => useRunViewLoadWatchdog());
    renderHook(() => useMessageHandler());
    let retiredRequestId = "";
    act(() => {
      retiredRequestId = useUiStore.getState().requestRunViewLoad(address, []);
      window.__ctrlyokeTransportConnected = false;
      vi.advanceTimersByTime(GIVE_UP_MS + 1000);
    });
    const nextAddress = {
      workflowKey: "wf-new" as never,
      kind: "draft" as const,
    };
    act(() => useUiStore.getState().requestRunViewLoad(nextAddress, []));

    act(() => dispatchRunViewLoaded(retiredRequestId));
    expect(useWorkflowStore.getState().workflowName).not.toBe("Late workflow");
    expect(useUiStore.getState().displayedViewAddress).toEqual(nextAddress);
  });
});
