import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollFocusedFieldIntoView } from "@hooks/useScrollFocusedFieldIntoView";

// jsdom does not implement ResizeObserver — stand in with a controllable
// mock (matching useElementNarrow.test.ts's convention) so tests can fire a
// synthetic resize callback directly.
let observerCallback: ResizeObserverCallback;
let mockObserverInstance: {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

const MockResizeObserver = vi.fn(function (cb: ResizeObserverCallback) {
  observerCallback = cb;
  mockObserverInstance = {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
  return mockObserverInstance;
});

function triggerResize() {
  observerCallback([], mockObserverInstance as unknown as ResizeObserver);
}

describe("useScrollFocusedFieldIntoView", () => {
  let container: HTMLElement;
  let originalResizeObserver: typeof window.ResizeObserver;
  let originalRaf: typeof window.requestAnimationFrame;
  let originalCaf: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    originalResizeObserver = window.ResizeObserver;
    window.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver;
    MockResizeObserver.mockClear();

    // The hook batches ResizeObserver callbacks into an animation frame
    // (createAnimationFrameResizeObserver). Run rAF synchronously so a
    // resize trigger applies within the surrounding act().
    originalRaf = window.requestAnimationFrame;
    originalCaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame =
      (() => {}) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    cleanup();
    container.remove();
    window.ResizeObserver = originalResizeObserver;
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCaf;
  });

  function renderScrollHook(active: boolean) {
    const containerRef = { current: container };
    renderHook(() => useScrollFocusedFieldIntoView(containerRef, active));
    return containerRef;
  }

  it("scrolls the focused input inside the container into view when it resizes", () => {
    renderScrollHook(true);
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    const scrollIntoView = vi.fn();
    input.scrollIntoView = scrollIntoView;

    act(() => {
      triggerResize();
    });

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
  });

  it("scrolls a focused CodeMirror-style contenteditable field into view", () => {
    renderScrollHook(true);
    const editable = document.createElement("div");
    editable.tabIndex = 0;
    // jsdom doesn't compute isContentEditable from the contentEditable
    // attribute — define it directly, matching domFocus.test.ts's convention.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    container.appendChild(editable);
    editable.focus();
    const scrollIntoView = vi.fn();
    editable.scrollIntoView = scrollIntoView;

    act(() => {
      triggerResize();
    });

    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("does nothing when inactive (desktop docked panel)", () => {
    renderScrollHook(false);

    expect(MockResizeObserver).not.toHaveBeenCalled();
  });

  it("does nothing when the focused element is outside the container", () => {
    renderScrollHook(true);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    const scrollIntoView = vi.fn();
    outside.scrollIntoView = scrollIntoView;

    act(() => {
      triggerResize();
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
    outside.remove();
  });

  it("does nothing when no field is focused", () => {
    renderScrollHook(true);
    const input = document.createElement("input");
    container.appendChild(input);
    const scrollIntoView = vi.fn();
    input.scrollIntoView = scrollIntoView;

    act(() => {
      triggerResize();
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("observes the container", () => {
    renderScrollHook(true);

    expect(mockObserverInstance.observe).toHaveBeenCalledWith(container);
  });

  it("disconnects the observer on unmount", () => {
    const containerRef = { current: container };
    const { unmount } = renderHook(() =>
      useScrollFocusedFieldIntoView(containerRef, true)
    );

    unmount();

    expect(mockObserverInstance.disconnect).toHaveBeenCalled();
  });
});
