import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { resolveWorkflowDisplayName } from "@utils/workflowDisplayName";

/** Returns the workflow name currently shown in the workflow header. */
export function useWorkflowDisplayName(): string {
  const pendingSwitchName = useUiStore(
    (s) => s.pendingRunViewSwitch?.workflowName
  );
  const workflowName = useWorkflowStore((s) => s.workflowName);
  const fileName = useWorkflowStore((s) => s.fileName);
  return resolveWorkflowDisplayName(pendingSwitchName, workflowName, fileName);
}
