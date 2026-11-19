import { MESSAGE_TYPES } from "@/types/messages";
import { PROMPT_HISTORY_KINDS } from "@root/types/DashboardConstants";
import { sendMessage } from "@messaging/sendMessage";
import { useEditorStore } from "@store/editorStore";
import { usePromptHistoryStore } from "@store/promptHistoryStore";
import { clearEditorAfterDispatch } from "@utils/editorDraftDispatch";

/**
 * Send text as a steer to one live session and keep it in Recent Prompts. On
 * failure the host answers with EXECUTE_PROMPT_ERROR carrying the text, which
 * StepEditor restores into the editor.
 */
export function sendSteerText(
  workflowId: string,
  sessionId: string,
  text: string
): void {
  sendMessage(MESSAGE_TYPES.SEND_STEER_MESSAGE, {
    workflowId,
    sessionId,
    text,
  });
  usePromptHistoryStore.getState().record(text, PROMPT_HISTORY_KINDS.STEER);
}

/**
 * Send the prompt editor's draft as a steer to one live session and clear the
 * editor. Shared by the Run menu and the step context menu's Send Steer to
 * Step.
 */
export function sendEditorDraftAsSteer(
  workflowId: string,
  sessionId: string
): boolean {
  const text = useEditorStore.getState().promptText.trim();
  if (!text) return false;
  sendSteerText(workflowId, sessionId, text);
  clearEditorAfterDispatch();
  return true;
}
