import { useEffect } from "react";
import { announceLastResponse } from "./useOutputAnnouncer";

/** The "Read last response" shortcut, matched on `code` like the picker shortcuts. */
export const READ_LAST_RESPONSE_SHORTCUT = {
  code: "KeyL",
  label: "Alt+L",
} as const;

/**
 * Global Alt+L: tell a screen reader the last finished response (see
 * dev/reference/KEYBOARD_SHORTCUTS.md). Fires from the prompt editor, so it
 * listens in the capture phase ahead of CodeMirror, and matches `code`
 * because Option+L on macOS reports "¬" in `key`. Left to a terminal, where
 * Alt+letter is a readline binding, and to an open modal.
 */
export function useReadLastResponseKeyHandler() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        !e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        e.code !== READ_LAST_RESPONSE_SHORTCUT.code
      ) {
        return;
      }
      const focused = e.target instanceof Element ? e.target : null;
      if (
        focused?.closest(".xterm") ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      announceLastResponse();
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
