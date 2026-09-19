import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { getWorkflowNameFromPath } from "@utils/workflowDisplayName";

/**
 * Returns the workflow name currently shown in the workflow header.
 *
 * During a cross-lineage switch, the workflow store still contains the
 * previous workflow while the pending switch carries the target name.
 */
export function useWorkflowDisplayName(): string {
  const pendingRunViewSwitch = useUiStore((s) => s.pendingRunViewSwitch);
  const workflowName = useWorkflowStore((s) => s.workflowName);
  const fileName = useWorkflowStore((s) => s.fileName);

  return (
    pendingRunViewSwitch?.workflowName ??
    (fileName
      ? workflowName || getWorkflowNameFromPath(fileName)
      : DEFAULT_WORKFLOW_NAME)
  );
}
