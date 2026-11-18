import { MESSAGE_TYPES } from "@/types/messages";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { sendMessage } from "@messaging/sendMessage";
import { useEditorStore } from "@store/editorStore";

/**
 * Send the prompt editor's draft as a steer to one live session and clear the
 * editor. Shared by the Run menu and the step context menu's Send Steer to
 * Step. On failure the host answers with EXECUTE_PROMPT_ERROR carrying the
 * text, which StepEditor restores.
 */
export function sendEditorDraftAsSteer(
  workflowId: string,
  sessionId: string
): boolean {
  const editor = useEditorStore.getState();
  const text = editor.promptText.trim();
  if (!text) return false;
  sendMessage(MESSAGE_TYPES.SEND_STEER_MESSAGE, {
    workflowId,
    sessionId,
    text,
  });
  editor.resetEditor();
  editor.markClean();
  getVsCodeApi().setState(null);
  return true;
}
