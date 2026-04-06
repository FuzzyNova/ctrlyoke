import { useEffect } from "react";
import { useWorkflowStore } from "../store/workflowStore";
import { useSettingsStore } from "../store/settingsStore";
import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "../types/messages";
import { getVsCodeApi } from "./useVsCodeApi";

export function useUndoRedoKeyHandler() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only log undo/redo-related keys to avoid spam
      const mightBeUndoRedo =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "z" || e.key === "y" || e.key === "Z");
      if (!mightBeUndoRedo) return;

      // Don't intercept if a text input or CodeMirror editor is focused —
      // let the focused element handle its own undo/redo.
      const target = e.target as HTMLElement;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.closest(".cm-editor") !== null;

      const isUndo = (e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey;
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" || (e.key === "z" && e.shiftKey));

      const temporal = useWorkflowStore.temporal.getState();
      WebviewLog.debug(
        `[UndoRedo] keydown: key=${e.key} ctrl=${e.ctrlKey} meta=${e.metaKey} shift=${e.shiftKey} ` +
          `isUndo=${isUndo} isRedo=${isRedo} isTextInput=${isTextInput} ` +
          `target=${target.tagName}.${target.className?.slice?.(0, 30)} ` +
          `pastStates=${temporal.pastStates.length} futureStates=${temporal.futureStates.length}`
      );

      if (isTextInput) return;

      if (!isUndo && !isRedo) return;

      // Don't undo/redo while a workflow is running or paused
      const isRunning = useWorkflowStore.getState().isWorkflowRunning();
      const isPaused = useWorkflowStore.getState().isWorkflowPaused();
      if (isRunning || isPaused) {
        WebviewLog.debug(
          `[UndoRedo] blocked — workflow isRunning=${isRunning} isPaused=${isPaused}`
        );
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      WebviewLog.debug(
        `[UndoRedo] ${isUndo ? "undo" : "redo"} — pastStates=${temporal.pastStates.length} futureStates=${temporal.futureStates.length}`
      );

      if (isUndo) temporal.undo();
      else temporal.redo();

      const after = useWorkflowStore.temporal.getState();
      WebviewLog.debug(
        `[UndoRedo] after ${isUndo ? "undo" : "redo"} — pastStates=${after.pastStates.length} futureStates=${after.futureStates.length}`
      );

      // Sync restored state to extension host so working file and queue stay consistent
      const ws = useWorkflowStore.getState();
      const workflowProperties = ws.undoWorkflowProperties;
      // Sync workflowProperties back to settingsStore so UI reflects the restored state
      useSettingsStore.getState().setWorkflowProperties(workflowProperties);
      getVsCodeApi().postMessage({
        type: MESSAGE_TYPES.UNDO_REDO_SYNC,
        steps: ws.steps,
        finalStep: ws.finalStep,
        workflowProperties,
      });
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
