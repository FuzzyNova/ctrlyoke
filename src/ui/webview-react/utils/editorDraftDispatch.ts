import { PROMPT_HISTORY_KINDS } from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useEditorStore } from "@store/editorStore";
import { usePromptHistoryStore } from "@store/promptHistoryStore";

/**
 * Clear the prompt editor after its draft was sent (Run, Queue, Run in
 * Parallel, Run in New Workflow, a steer), and drop the persisted draft so a
 * reload does not bring it back. Pass the prompt text to keep it in Recent
 * Prompts; a script command is not a prompt and is left out.
 */
export function clearEditorAfterDispatch(sentPromptText?: string): void {
  if (sentPromptText !== undefined) {
    usePromptHistoryStore
      .getState()
      .record(sentPromptText, PROMPT_HISTORY_KINDS.SENT);
  }
  const editor = useEditorStore.getState();
  editor.resetEditor();
  editor.markClean();
  editor.clearPersistedNewStepDraft(getVsCodeApi());
}
