import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopLayout } from "@hooks/useDesktopLayout";
import { useUiStore } from "@store/uiStore";

describe("useDesktopLayout — vertical remount sync vs. mobile transitions", () => {
  beforeEach(() => {
    useUiStore.setState({ outputCollapsed: false, editorCollapsed: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderDesktopLayout(
    overrides: Partial<Parameters<typeof useDesktopLayout>[0]> = {}
  ) {
    return renderHook(
      (props: Partial<Parameters<typeof useDesktopLayout>[0]>) =>
        useDesktopLayout({
          isMobile: false,
          uiLayoutReady: true,
          settingsCollapsed: false,
          promptsCollapsed: false,
          outputCollapsed: false,
          editorCollapsed: true,
          ...props,
        }),
      { initialProps: overrides }
    );
  }

  it("cancels the in-flight remount-sync rAF loop when isMobile flips true mid-flight", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");

    // outputCollapsed !== editorCollapsed on mount forces a remount-sync loop,
    // which schedules its next tick via requestAnimationFrame.
    const { rerender } = renderDesktopLayout();
    expect(rafSpy).toHaveBeenCalledTimes(1);
    const scheduledFrameId = rafSpy.mock.results[0]!.value as number;

    // Viewport narrows to mobile before the next animation frame fires — the
    // vertical Group unmounts, but the previously scheduled tick is still
    // pending.
    act(() => {
      rerender({
        isMobile: true,
        uiLayoutReady: true,
        settingsCollapsed: false,
        promptsCollapsed: false,
        outputCollapsed: false,
        editorCollapsed: true,
      });
    });

    expect(cancelSpy).toHaveBeenCalledWith(scheduledFrameId);
  });

  it("does not log a null-ref error from a stale tick once cancelled by the mobile transition", async () => {
    const { WebviewLog } = await import("@utils/logger");
    const errorSpy = vi.spyOn(WebviewLog, "error");

    const { rerender } = renderDesktopLayout();
    errorSpy.mockClear();

    act(() => {
      rerender({
        isMobile: true,
        uiLayoutReady: true,
        settingsCollapsed: false,
        promptsCollapsed: false,
        outputCollapsed: false,
        editorCollapsed: true,
      });
    });

    // Let any not-yet-cancelled animation frame fire.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const nullRefCalls = errorSpy.mock.calls.filter(
      ([message]) => message === "[LAYOUT] verticalGroupRef.current is null"
    );
    expect(nullRefCalls).toEqual([]);
  });

  it("still starts a fresh remount-sync loop on a later mobile→desktop transition", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");

    const { rerender } = renderDesktopLayout({ isMobile: true });
    expect(rafSpy).not.toHaveBeenCalled();

    act(() => {
      rerender({
        isMobile: false,
        uiLayoutReady: true,
        settingsCollapsed: false,
        promptsCollapsed: false,
        outputCollapsed: false,
        editorCollapsed: true,
      });
    });

    expect(rafSpy).toHaveBeenCalled();
  });
});
