import { MESSAGE_TYPES } from "../types/messages";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkflowStore } from "../store/workflowStore";
import {
  clearedWorkflowPropertyKeys,
  postWorkflowDefinitionMutation,
} from "./workflowMutation";

interface MessageTarget {
  postMessage: (message: unknown) => void;
}

/**
 * Push the state zundo has just restored back to the extension.
 *
 * Both entry points — the header's Undo/Redo buttons (`UndoRedoControl`) and
 * the Ctrl+Z / Ctrl+Y handler (`useUndoRedoKeyHandler`) — go through here.
 * They previously built this message independently and had already drifted:
 * only the button copy sent `workflowName`, so undoing a rename from the
 * keyboard reverted the title on screen and nothing on disk, and the next
 * resync put the un-reverted name back.
 *
 * Call it *after* the restored steps have been written back to the store, so
 * the message carries the same content the panel is showing.
 */
export function postUndoRedoSync(target: MessageTarget): void {
  const state = useWorkflowStore.getState();
  const workflowProperties = state.undoWorkflowProperties;

  // Mirror the restored properties into settingsStore so the drawer redraws
  // from the same snapshot the extension is about to persist.
  useSettingsStore.getState().setWorkflowProperties(workflowProperties);

  postWorkflowDefinitionMutation(target, {
    type: MESSAGE_TYPES.UNDO_REDO_SYNC,
    steps: state.steps,
    parallelGroups: state.parallelGroups,
    finalStep: state.finalStep,
    workflowProperties,
    // Without this an undo can only overwrite a property, never remove one —
    // JSON drops the `undefined` members that say "this property was not set".
    clearedWorkflowProperties: clearedWorkflowPropertyKeys(
      workflowProperties as Record<string, unknown>
    ),
    workflowName: state.workflowName,
  });
}
