import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollFocusedFieldIntoView } from "@hooks/useScrollFocusedFieldIntoView";

// jsdom does not implement visualViewport — stand in with a minimal
// EventTarget so the hook's addEventListener/removeEventListener calls work
// and tests can fire a synthetic "resize".
class FakeVisualViewport extends EventTarget {}

function dispatchViewportResize(vv: FakeVisualViewport) {
  vv.dispatchEvent(new Event("resize"));
}

describe("useScrollFocusedFieldIntoView", () => {
  let container: HTMLElement;
  let fakeVisualViewport: FakeVisualViewport;
  let originalVisualViewport: VisualViewport | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    fakeVisualViewport = new FakeVisualViewport();
    originalVisualViewport = window.visualViewport ?? undefined;
    Object.defineProperty(window, "visualViewport", {
      value: fakeVisualViewport,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    container.remove();
    Object.defineProperty(window, "visualViewport", {
      value: originalVisualViewport,
      configurable: true,
    });
  });

  function renderScrollHook(active: boolean) {
    const containerRef = { current: container };
    renderHook(() => useScrollFocusedFieldIntoView(containerRef, active));
    return containerRef;
  }

  it("scrolls the focused input inside the container into view on viewport resize", () => {
    renderScrollHook(true);
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    const scrollIntoView = vi.fn();
    input.scrollIntoView = scrollIntoView;

    act(() => {
      dispatchViewportResize(fakeVisualViewport);
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
      dispatchViewportResize(fakeVisualViewport);
    });

    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("does nothing when inactive (desktop docked panel)", () => {
    renderScrollHook(false);
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    const scrollIntoView = vi.fn();
    input.scrollIntoView = scrollIntoView;

    act(() => {
      dispatchViewportResize(fakeVisualViewport);
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does nothing when the focused element is outside the container", () => {
    renderScrollHook(true);
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    const scrollIntoView = vi.fn();
    outside.scrollIntoView = scrollIntoView;

    act(() => {
      dispatchViewportResize(fakeVisualViewport);
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
      dispatchViewportResize(fakeVisualViewport);
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    const containerRef = { current: container };
    const { unmount } = renderHook(() =>
      useScrollFocusedFieldIntoView(containerRef, true)
    );
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    const scrollIntoView = vi.fn();
    input.scrollIntoView = scrollIntoView;

    unmount();
    act(() => {
      dispatchViewportResize(fakeVisualViewport);
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
