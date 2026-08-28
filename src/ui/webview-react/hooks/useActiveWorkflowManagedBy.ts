import { useUiStore } from "@store/uiStore";
import type { RunnerId } from "@root/types/DashboardConstants";

export function useActiveWorkflowManagedBy(): RunnerId | undefined {
  const activeWorkflowId = useUiStore((s) => s.activeWorkflowId);
  const loadedWorkflows = useUiStore((s) => s.loadedWorkflows);
  return loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy;
}
