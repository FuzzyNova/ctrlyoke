import { useUiStore } from "../store/uiStore";
import { MESSAGE_TYPES } from "../types/messages";

interface MessageTarget {
  postMessage: (message: unknown) => void;
}

/**
 * Start a blank workflow from a user gesture (the New button, Ctrl+N, the
 * workflow dropdown's New row).
 *
 * The naming request is made before the message is posted and synchronously
 * within the gesture, so `WorkflowStatus` focuses its name input while the
 * tap is still being handled. Focusing only once the backend's new-workflow
 * snapshot arrives works on desktop but not on iOS, which raises the
 * on-screen keyboard only for a focus() made inside a user gesture.
 *
 * Non-gesture callers (startup's auto-created blank workflow) post
 * CLEAR_WORKFLOW directly; `WorkflowStatus` still enters naming when the
 * blank workflow arrives.
 */
export function startNewBlankWorkflow(target: MessageTarget): void {
  useUiStore.getState().requestNewWorkflowNaming();
  target.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
}
