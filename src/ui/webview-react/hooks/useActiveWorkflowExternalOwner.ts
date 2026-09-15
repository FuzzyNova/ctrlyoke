import { useUiStore } from "@store/uiStore";
import type { ExternalExecutionOwnerSummary } from "@root/types/CtrlYokeTypes";

export function useActiveWorkflowExternalOwner():
  ExternalExecutionOwnerSummary | undefined {
  const activeWorkflowId = useUiStore((s) => s.activeWorkflowId);
  const loadedWorkflows = useUiStore((s) => s.loadedWorkflows);
  return loadedWorkflows.find((w) => w.id === activeWorkflowId)?.externalOwner;
}
