import { act, cleanup, renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewportEditorSync } from "@hooks/useVisualViewportEditorSync";

const { repositionTooltipsMock } = vi.hoisted(() => ({
  repositionTooltipsMock: vi.fn(),
}));

vi.mock("@codemirror/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  return { ...actual, repositionTooltips: repositionTooltipsMock };
});

describe("useVisualViewportEditorSync", () => {
  let viewport: EventTarget;
  let originalVisualViewportDescriptor: PropertyDescriptor | undefined;
  let editorContainer: HTMLDivElement;
  let view: EditorView;
  let viewRef: { current: EditorView | null };
  let focused: boolean;

  beforeEach(() => {
    focused = false;
    repositionTooltipsMock.mockClear();
    originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport"
    );
    viewport = new EventTarget();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });

    editorContainer = document.createElement("div");
    document.body.appendChild(editorContainer);
    view = new EditorView({
      state: EditorState.create({ doc: "text" }),
      parent: editorContainer,
    });
    vi.spyOn(view, "requestMeasure").mockImplementation(() => undefined);
    vi.spyOn(view, "dispatch").mockImplementation(() => undefined);
    vi.spyOn(view, "hasFocus", "get").mockImplementation(() => focused);
    viewRef = { current: view };
  });

  afterEach(() => {
    cleanup();
    view.destroy();
    editorContainer.remove();
    if (originalVisualViewportDescriptor) {
      Object.defineProperty(
        window,
        "visualViewport",
        originalVisualViewportDescriptor
      );
    } else {
      Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("remeasures and repositions tooltips on scroll without dispatching", () => {
    renderHook(() => useVisualViewportEditorSync(viewRef));

    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });

    expect(view.requestMeasure).toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(repositionTooltipsMock).toHaveBeenCalledWith(view);
  });

  it("dispatches caret scroll-into-view on resize only when focused", () => {
    renderHook(() => useVisualViewportEditorSync(viewRef));

    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(view.dispatch).not.toHaveBeenCalled();

    focused = true;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(view.requestMeasure).toHaveBeenCalled();
    expect(view.dispatch).toHaveBeenCalledOnce();
  });

  it("removes visual viewport listeners on unmount", () => {
    const addEventListener = vi.spyOn(viewport, "addEventListener");
    const removeEventListener = vi.spyOn(viewport, "removeEventListener");
    const { unmount } = renderHook(() => useVisualViewportEditorSync(viewRef));

    const addedListeners = addEventListener.mock.calls;
    unmount();

    expect(removeEventListener).toHaveBeenCalledTimes(2);
    for (const [type, listener] of addedListeners) {
      expect(removeEventListener).toHaveBeenCalledWith(type, listener);
    }
  });

  it("does nothing when visualViewport is unavailable", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });

    renderHook(() => useVisualViewportEditorSync(viewRef));

    expect(view.requestMeasure).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
  });
});
