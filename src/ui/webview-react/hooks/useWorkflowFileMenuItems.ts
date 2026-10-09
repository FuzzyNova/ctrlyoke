import { useCallback } from "react";
import { type StepContextMenuEntry } from "@components/shared/StepContextMenu";
import { sendMessage } from "@hooks/useMessageHandler";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES } from "@/types/messages";
import { postWorkflowDefinitionMutation } from "../utils/workflowMutation";
import { getCtrlYokeFileKind } from "@root/completions/CtrlYokeFileKind";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

/**
 * Builds the Run/Load/Queue workflow actions shared by the workspace editor
 * and explorer context menus. Returns no entries for a non-workflow file, so
 * callers can splice the result in unconditionally.
 */
export function useWorkflowFileMenuItems(): (
  filePath: string | null
) => StepContextMenuEntry[] {
  const vscode = useVsCodeApi();
  const isRunView = useUiStore(
    (state) =>
      state.displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
  );

  return useCallback(
    (filePath) => {
      if (!filePath || !getCtrlYokeFileKind(filePath)) return [];
      const loadWorkflow = () =>
        vscode.postMessage({ type: MESSAGE_TYPES.LOAD_WORKFLOW, filePath });
      return [
        { type: "divider" },
        {
          label: "Run Workflow",
          icon: "codicon-play",
          disabled: false,
          onClick: () => {
            loadWorkflow();
            sendMessage(MESSAGE_TYPES.RUN);
          },
        },
        {
          label: "Load Workflow",
          icon: "codicon-folder-opened",
          disabled: false,
          onClick: loadWorkflow,
        },
        {
          label: isRunView ? "Append and Continue Workflow" : "Queue Workflow",
          icon: "codicon-list-ordered",
          disabled: false,
          onClick: () =>
            postWorkflowDefinitionMutation(vscode, {
              type: MESSAGE_TYPES.APPEND_FILE,
              filePath,
            }),
        },
      ];
    },
    [vscode, isRunView]
  );
}
