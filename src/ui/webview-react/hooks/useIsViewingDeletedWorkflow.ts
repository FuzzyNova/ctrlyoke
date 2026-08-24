import { useUiStore } from "@store/uiStore";

/**
 * True once the workflow currently displayed has been deleted (from history)
 * within this session — see `uiStore.viewingDeletedWorkflow` for why this is
 * derived against `displayedViewAddress` rather than read as a flag: it
 * self-clears the moment the user navigates to any other address, without
 * every navigation path needing to remember to clear it explicitly.
 */
export function useIsViewingDeletedWorkflow(): boolean {
  const displayedViewAddress = useUiStore((s) => s.displayedViewAddress);
  const viewingDeletedWorkflow = useUiStore((s) => s.viewingDeletedWorkflow);

  return (
    viewingDeletedWorkflow !== null &&
    displayedViewAddress?.workflowKey === viewingDeletedWorkflow.workflowKey
  );
}
