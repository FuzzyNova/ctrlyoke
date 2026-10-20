/**
 * Tests for usePickerShortcutKeyHandler — the Alt (workflow) / Alt+Shift
 * (step) harness, model and resume-session picker shortcuts.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePickerShortcutTarget,
  usePickerShortcutKeyHandler,
} from "@hooks/usePickerShortcutKeyHandler";
import { useUiStore } from "@store/uiStore";
import { PICKER_SHORTCUT_TARGETS } from "@root/types/DashboardConstants";

function dispatchKeyDown(init: KeyboardEventInit, target?: HTMLElement) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (target ?? document.body).dispatchEvent(event);
  return event;
}

describe("resolvePickerShortcutTarget", () => {
  const base = { ctrlKey: false, metaKey: false };

  it.each([
    ["KeyH", false, PICKER_SHORTCUT_TARGETS.WORKFLOW_HARNESS],
    ["KeyM", false, PICKER_SHORTCUT_TARGETS.WORKFLOW_MODEL],
    ["KeyR", false, PICKER_SHORTCUT_TARGETS.WORKFLOW_RESUME],
    ["KeyH", true, PICKER_SHORTCUT_TARGETS.STEP_HARNESS],
    ["KeyM", true, PICKER_SHORTCUT_TARGETS.STEP_MODEL],
    ["KeyR", true, PICKER_SHORTCUT_TARGETS.STEP_RESUME],
  ])("maps Alt%s with shift=%s to %s", (code, shiftKey, expected) => {
    expect(
      resolvePickerShortcutTarget({ ...base, altKey: true, shiftKey, code })
    ).toBe(expected);
  });

  it("ignores the letters without Alt, or with Ctrl/Cmd as well", () => {
    expect(
      resolvePickerShortcutTarget({
        ...base,
        altKey: false,
        shiftKey: false,
        code: "KeyM",
      })
    ).toBeNull();
    expect(
      resolvePickerShortcutTarget({
        ...base,
        altKey: true,
        ctrlKey: true,
        shiftKey: false,
        code: "KeyM",
      })
    ).toBeNull();
    expect(
      resolvePickerShortcutTarget({
        ...base,
        altKey: true,
        metaKey: true,
        shiftKey: false,
        code: "KeyM",
      })
    ).toBeNull();
  });

  it("ignores Alt with an unbound key", () => {
    expect(
      resolvePickerShortcutTarget({
        ...base,
        altKey: true,
        shiftKey: false,
        code: "KeyQ",
      })
    ).toBeNull();
  });
});

describe("usePickerShortcutKeyHandler", () => {
  beforeEach(() => {
    useUiStore.setState({
      pickerShortcutRequest: null,
      settingsCollapsed: true,
      mobileWorkflowPropsOpen: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("records a workflow request and expands the properties panel", () => {
    renderHook(() => usePickerShortcutKeyHandler());

    // macOS Option+M reports key "µ"; only `code` identifies the key.
    const event = dispatchKeyDown({ altKey: true, code: "KeyM", key: "µ" });

    expect(event.defaultPrevented).toBe(true);
    const state = useUiStore.getState();
    expect(state.pickerShortcutRequest?.target).toBe(
      PICKER_SHORTCUT_TARGETS.WORKFLOW_MODEL
    );
    expect(state.settingsCollapsed).toBe(false);
  });

  it("records a step request without touching the properties panel", () => {
    renderHook(() => usePickerShortcutKeyHandler());

    dispatchKeyDown({ altKey: true, shiftKey: true, code: "KeyH", key: "H" });

    const state = useUiStore.getState();
    expect(state.pickerShortcutRequest?.target).toBe(
      PICKER_SHORTCUT_TARGETS.STEP_HARNESS
    );
    expect(state.settingsCollapsed).toBe(true);
  });

  it("fires while a CodeMirror editor has focus", () => {
    renderHook(() => usePickerShortcutKeyHandler());
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const content = document.createElement("div");
    editor.appendChild(content);
    document.body.appendChild(editor);

    dispatchKeyDown({ altKey: true, code: "KeyR", key: "r" }, content);

    expect(useUiStore.getState().pickerShortcutRequest?.target).toBe(
      PICKER_SHORTCUT_TARGETS.WORKFLOW_RESUME
    );
  });

  it("gives each press a new nonce so a repeat is observable", () => {
    renderHook(() => usePickerShortcutKeyHandler());

    dispatchKeyDown({ altKey: true, code: "KeyM", key: "m" });
    const first = useUiStore.getState().pickerShortcutRequest?.nonce ?? 0;
    dispatchKeyDown({ altKey: true, code: "KeyM", key: "m" });

    expect(useUiStore.getState().pickerShortcutRequest?.nonce).toBe(first + 1);
  });

  it("leaves Alt+letter to a focused terminal", () => {
    renderHook(() => usePickerShortcutKeyHandler());
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const textarea = document.createElement("textarea");
    terminal.appendChild(textarea);
    document.body.appendChild(terminal);

    const event = dispatchKeyDown(
      { altKey: true, code: "KeyR", key: "r" },
      textarea
    );

    expect(event.defaultPrevented).toBe(false);
    expect(useUiStore.getState().pickerShortcutRequest).toBeNull();
  });

  it("does nothing while a modal is open", () => {
    renderHook(() => usePickerShortcutKeyHandler());
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);

    dispatchKeyDown({ altKey: true, code: "KeyH", key: "h" });

    expect(useUiStore.getState().pickerShortcutRequest).toBeNull();
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => usePickerShortcutKeyHandler());
    unmount();

    dispatchKeyDown({ altKey: true, code: "KeyH", key: "h" });

    expect(useUiStore.getState().pickerShortcutRequest).toBeNull();
  });
});
