/**
 * Tests for useHistorySearchKeyHandler — the Ctrl+Shift+F / Cmd+Shift+F
 * global webview shortcut that toggles the history search drawer.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useHistorySearchKeyHandler } from "@hooks/useHistorySearchKeyHandler";
import { useUiStore } from "@store/uiStore";

function dispatchKeyDown(init: KeyboardEventInit, target?: HTMLElement) {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  (target ?? document.body).dispatchEvent(event);
  return event;
}

describe("useHistorySearchKeyHandler", () => {
  beforeEach(() => {
    useUiStore.setState({
      isHistorySearchOpen: false,
      globalSettingsOpen: false,
    });
  });

  it("opens the history search drawer on Ctrl+Shift+F", () => {
    renderHook(() => useHistorySearchKeyHandler());

    dispatchKeyDown({ key: "f", ctrlKey: true, shiftKey: true });

    expect(useUiStore.getState().isHistorySearchOpen).toBe(true);
  });

  it("closes the history search drawer on a second Ctrl+Shift+F", () => {
    renderHook(() => useHistorySearchKeyHandler());

    dispatchKeyDown({ key: "f", ctrlKey: true, shiftKey: true });
    dispatchKeyDown({ key: "f", ctrlKey: true, shiftKey: true });

    expect(useUiStore.getState().isHistorySearchOpen).toBe(false);
  });

  it("opens on Cmd+Shift+F (metaKey)", () => {
    renderHook(() => useHistorySearchKeyHandler());

    dispatchKeyDown({ key: "f", metaKey: true, shiftKey: true });

    expect(useUiStore.getState().isHistorySearchOpen).toBe(true);
  });

  it("ignores Ctrl+F without Shift", () => {
    renderHook(() => useHistorySearchKeyHandler());

    dispatchKeyDown({ key: "f", ctrlKey: true });

    expect(useUiStore.getState().isHistorySearchOpen).toBe(false);
  });

  it("fires even while a CodeMirror editor is focused", () => {
    renderHook(() => useHistorySearchKeyHandler());

    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const inner = document.createElement("div");
    editor.appendChild(inner);
    document.body.appendChild(editor);

    dispatchKeyDown({ key: "f", ctrlKey: true, shiftKey: true }, inner);

    expect(useUiStore.getState().isHistorySearchOpen).toBe(true);

    document.body.removeChild(editor);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useHistorySearchKeyHandler());
    unmount();

    dispatchKeyDown({ key: "f", ctrlKey: true, shiftKey: true });

    expect(useUiStore.getState().isHistorySearchOpen).toBe(false);
  });
});
