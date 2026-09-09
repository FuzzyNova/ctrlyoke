import { useEffect } from "react";
import { useUiStore } from "../store/uiStore";

/**
 * Global "Ctrl+Shift+F" / "Cmd+Shift+F" shortcut, scoped to the webview only
 * (same layer-2 pattern as `useNewWorkflowKeyHandler` — see
 * dev/reference/KEYBOARD_SHORTCUTS.md). Toggles the history search drawer,
 * same action as the search button in `Header.tsx`.
 *
 * Registered with `capture: true` and fires ahead of any focused element's
 * own handling — including CodeMirror's `createFindKeyHandlerExtension`,
 * whose Ctrl/Cmd+F check ignores `shiftKey` and would otherwise swallow this
 * combo as "open editor search" while a prompt editor is focused.
 */
export function useHistorySearchKeyHandler() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isHistorySearchKey =
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f";
      if (!isHistorySearchKey) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      useUiStore.getState().toggleHistorySearch();
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
