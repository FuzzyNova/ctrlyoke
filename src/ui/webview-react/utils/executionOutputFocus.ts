import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";

type ExecutionOutputTab = "output" | "terminal";

export function autoFocusOutputOnExecution(
  workflowId: string,
  tab: ExecutionOutputTab
): boolean {
  const settingsStore = useSettingsStore.getState();
  if (!settingsStore.globalSettings.autoFocusOutputOnExecution) {
    return false;
  }

  const uiStore = useUiStore.getState();
  const activeWorkflowId = uiStore.activeWorkflowId;
  if (activeWorkflowId && activeWorkflowId !== workflowId) {
    return false;
  }

  uiStore.setOutputCollapsed(false);
  uiStore.setActiveOutputTab(workflowId, tab);
  return true;
}
