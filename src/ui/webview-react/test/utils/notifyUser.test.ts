import { beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

describe("notifyUser", () => {
  beforeEach(() => {
    vi.resetModules();
    window.__ctrlyokeStandalone = false;
    window.vscodeApi = window.acquireVsCodeApi?.();
    vi.mocked(window.vscodeApi?.postMessage ?? vi.fn()).mockClear();
  });

  it("shows standalone feedback in the in-app toast queue", async () => {
    window.__ctrlyokeStandalone = true;
    const { notifyUser } = await import("@utils/notifyUser");
    const { useUiStore } = await import("@store/uiStore");
    useUiStore.getState().resetUi();

    notifyUser("Saved", "success", "The workflow was saved.");

    expect(useUiStore.getState().toastQueue).toHaveLength(1);
    expect(useUiStore.getState().toastQueue[0]).toMatchObject({
      message: "Saved",
      severity: "success",
      detail: "The workflow was saved.",
    });
    expect(window.vscodeApi?.postMessage).not.toHaveBeenCalled();
  });

  it("sends panel feedback to the native host without queueing a toast", async () => {
    const { notifyUser } = await import("@utils/notifyUser");
    const { useUiStore } = await import("@store/uiStore");
    useUiStore.getState().resetUi();

    notifyUser("Could not save", "error", "The file is read-only.");

    expect(window.vscodeApi?.postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
      severity: "error",
      message: "Could not save",
      detail: "The file is read-only.",
    });
    expect(useUiStore.getState().toastQueue).toEqual([]);
  });
});
