import { useEffect } from "react";
import { useWorkflowStore } from "../store/workflowStore";

export function useUndoRedoKeyHandler() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept if a text input or CodeMirror editor is focused —
      // let the focused element handle its own undo/redo.
      const target = e.target as HTMLElement;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.closest(".cm-editor") !== null;

      if (isTextInput) return;

      const isUndo = (e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey;
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" || (e.key === "z" && e.shiftKey));

      if (!isUndo && !isRedo) return;

      // Don't undo/redo while a workflow is running or paused
      const isRunning = useWorkflowStore.getState().isWorkflowRunning();
      const isPaused = useWorkflowStore.getState().isWorkflowPaused();
      if (isRunning || isPaused) return;

      e.preventDefault();
      e.stopPropagation();

      const temporal = useWorkflowStore.temporal.getState();
      if (isUndo) temporal.undo();
      else temporal.redo();
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
