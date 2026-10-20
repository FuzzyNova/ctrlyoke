import { useEffect, useRef } from "react";
import { useUiStore } from "@store/uiStore";
import { useIsMobile } from "@hooks/useMediaQuery";
import {
  PICKER_SHORTCUT_BINDINGS,
  PICKER_SHORTCUT_TARGETS,
  type PickerShortcutTarget,
} from "@root/types/DashboardConstants";
import { WebviewLog } from "@utils/logger";

type PickerShortcutKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "code"
>;

/** The picker an Alt/Alt+Shift keypress targets, if any. */
export function resolvePickerShortcutTarget(
  event: PickerShortcutKeyEvent
): PickerShortcutTarget | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  return (
    Object.values(PICKER_SHORTCUT_TARGETS).find((target) => {
      const binding = PICKER_SHORTCUT_BINDINGS[target];
      return binding.code === event.code && binding.shift === event.shiftKey;
    }) ?? null
  );
}

/**
 * Global picker shortcuts, scoped to the webview (see
 * dev/reference/KEYBOARD_SHORTCUTS.md for why package.json keybindings never
 * fire here):
 *
 *   - Alt+H / Alt+M / Alt+R: workflow harness / model / resume session.
 *   - Alt+Shift+H / M / R: the same for the step being edited.
 *
 * Unlike Ctrl+N these must fire while the prompt editor has focus — that is
 * where the user is when reaching for them — so the listener runs in the
 * capture phase, ahead of CodeMirror. The press only records a request in
 * uiStore; the targeted picker opens itself, and a repeat press moves its
 * highlight to the next option (usePickerListbox).
 */
export function usePickerShortcutKeyHandler() {
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = resolvePickerShortcutTarget(e);
      if (!target) return;

      // Leave the keys to an open modal, and to a terminal, where Alt+letter
      // is a readline/meta binding the shell expects to receive.
      const focused = e.target instanceof Element ? e.target : null;
      if (
        focused?.closest(".xterm") ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      WebviewLog.info(`[PickerShortcut] ${target}`);
      useUiStore
        .getState()
        .requestPickerShortcut(target, { mobile: isMobileRef.current });
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
