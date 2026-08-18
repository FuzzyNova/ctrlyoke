import { useEffect } from "react";
import { MESSAGE_TYPES } from "../types/messages";
import { getVsCodeApi } from "./useVsCodeApi";
import { WebviewLog } from "@utils/logger";

/**
 * Global "new workflow" shortcuts, scoped to the webview only (no VS Code
 * package.json keybinding involved — see dev/reference/KEYBOARD_SHORTCUTS.md
 * for why the package.json layer never fires while the webview has focus):
 *
 *   - Ctrl+N / Cmd+N: New blank workflow (same action as the "New" split
 *     button's main click — posts CLEAR_WORKFLOW).
 *   - Ctrl+Shift+N / Cmd+Shift+N: New workflow from template (same action as
 *     "New From Template..." in the split button dropdown — posts
 *     NEW_WORKFLOW, which opens the template modal).
 */
export function useNewWorkflowKeyHandler() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isNewWorkflowKey =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n";
      if (!isNewWorkflowKey) return;

      // Don't intercept while a text input or CodeMirror editor is focused —
      // browsers/editors have their own expectations for Ctrl/Cmd+N there.
      const target = e.target as HTMLElement;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.closest(".cm-editor") !== null;
      if (isTextInput) return;

      e.preventDefault();
      e.stopPropagation();

      const vscode = getVsCodeApi();
      if (e.shiftKey) {
        WebviewLog.debug(
          "[NewWorkflow] Ctrl+Shift+N — new workflow from template"
        );
        vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
      } else {
        WebviewLog.debug("[NewWorkflow] Ctrl+N — new blank workflow");
        vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
