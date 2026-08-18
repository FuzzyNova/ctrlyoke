/**
 * Tests for useNewWorkflowKeyHandler — the Ctrl+N / Ctrl+Shift+N global
 * webview shortcuts for "new blank workflow" / "new workflow from template".
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNewWorkflowKeyHandler } from "@hooks/useNewWorkflowKeyHandler";
import { MESSAGE_TYPES } from "@/types/messages";

// Dispatching on `window` directly (rather than a focused DOM element)
// would make `event.target` be `window` itself, which real browsers never
// do — focus/keydown targets are always DOM elements that then bubble to
// window. Default to document.body to match real focus behavior.
function dispatchKeyDown(init: KeyboardEventInit, target?: HTMLElement) {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  (target ?? document.body).dispatchEvent(event);
  return event;
}

describe("useNewWorkflowKeyHandler", () => {
  let postMessage: ReturnType<typeof vi.fn<(message: unknown) => void>>;

  beforeEach(() => {
    postMessage = vi.fn<(message: unknown) => void>();
    window.vscodeApi = {
      postMessage,
      getState: () => null,
      setState: () => undefined,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("posts CLEAR_WORKFLOW on Ctrl+N", () => {
    renderHook(() => useNewWorkflowKeyHandler());

    dispatchKeyDown({ key: "n", ctrlKey: true });

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW,
    });
  });

  it("posts NEW_WORKFLOW on Ctrl+Shift+N", () => {
    renderHook(() => useNewWorkflowKeyHandler());

    dispatchKeyDown({ key: "n", ctrlKey: true, shiftKey: true });

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.NEW_WORKFLOW,
    });
  });

  it("posts CLEAR_WORKFLOW on Cmd+N (metaKey)", () => {
    renderHook(() => useNewWorkflowKeyHandler());

    dispatchKeyDown({ key: "n", metaKey: true });

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW,
    });
  });

  it("ignores plain N without a modifier", () => {
    renderHook(() => useNewWorkflowKeyHandler());

    dispatchKeyDown({ key: "n" });

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("does not intercept Ctrl+N while a text input is focused", () => {
    renderHook(() => useNewWorkflowKeyHandler());

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    dispatchKeyDown({ key: "n", ctrlKey: true }, input);

    expect(postMessage).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it("does not intercept Ctrl+N while a CodeMirror editor is focused", () => {
    renderHook(() => useNewWorkflowKeyHandler());

    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const inner = document.createElement("div");
    editor.appendChild(inner);
    document.body.appendChild(editor);

    dispatchKeyDown({ key: "n", ctrlKey: true }, inner);

    expect(postMessage).not.toHaveBeenCalled();

    document.body.removeChild(editor);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useNewWorkflowKeyHandler());
    unmount();

    dispatchKeyDown({ key: "n", ctrlKey: true });

    expect(postMessage).not.toHaveBeenCalled();
  });
});
