import { useEffect } from "react";
import {
  SELECT_ALL_SCOPE_ATTRIBUTE,
  SELECT_ALL_SCOPES,
} from "@root/types/DashboardConstants";
import { isEditableClipboardTarget } from "@utils/stepClipboard";

/**
 * Confines Ctrl/Cmd+A to the dashboard region the user is working in.
 *
 * A keydown handler cannot do this. In the VS Code panel the webview host
 * forwards every keystroke to the workbench without checking
 * `defaultPrevented`, and the workbench runs its own Select All on the whole
 * webview document. Both that command and the browser's native select-all
 * dispatch a cancelable `selectstart` at the document root first, so that is
 * the one place that sees both hosts.
 *
 * The region is the nearest `[data-select-all-scope]` ancestor of the last
 * pointer press or focus change. Focus alone is not enough: clicking text
 * outside a focusable region focuses nothing and leaves
 * `document.activeElement` on `<body>`.
 *   - `contents`: select the text inside that element only.
 *   - `handled`: the region implements select-all itself (the steps list),
 *     so only the text selection is suppressed.
 *   - no scope: suppress it, since nothing outside a scope is content.
 * Editable targets keep the browser's own field-local select-all.
 */
export function useScopedSelectAll() {
  useEffect(() => {
    let lastInteractionTarget: EventTarget | null = null;
    const recordInteraction = (e: Event) => {
      lastInteractionTarget = e.target;
    };

    const handleSelectStart = (e: Event) => {
      // A drag or double-click starts at the node under the pointer; only a
      // select-all starts at the document root.
      if (e.target !== document.body && e.target !== document.documentElement) {
        return;
      }
      if (isEditableClipboardTarget(document.activeElement)) return;

      e.preventDefault();
      const origin =
        lastInteractionTarget instanceof Element
          ? lastInteractionTarget
          : document.activeElement;
      const scope = origin?.closest(`[${SELECT_ALL_SCOPE_ATTRIBUTE}]`);
      if (
        scope?.getAttribute(SELECT_ALL_SCOPE_ATTRIBUTE) ===
        SELECT_ALL_SCOPES.CONTENTS
      ) {
        window.getSelection()?.selectAllChildren(scope);
      }
    };

    document.addEventListener("pointerdown", recordInteraction, true);
    document.addEventListener("focusin", recordInteraction, true);
    document.addEventListener("selectstart", handleSelectStart, true);
    return () => {
      document.removeEventListener("pointerdown", recordInteraction, true);
      document.removeEventListener("focusin", recordInteraction, true);
      document.removeEventListener("selectstart", handleSelectStart, true);
    };
  }, []);
}
